'use strict';

// images.js — Google Images beside a whiteboard, main's half. ARCHITECTURE §4.17.
//
// The whiteboard bundle docks a panel on the right of the canvas holding Google's own image
// results in a <webview>, so a picture can be found and dragged onto a whiteboard without
// leaving the app. That page is the open web inside the app's window, so main keeps it
// on a short lead:
//   * The only <webview> the main window may attach is one in the 'persist:sb-images'
//     partition that starts on https://www.google.com or https://images.google.com, and
//     whatever preferences the page asked for, it gets no preload, no Node, a sandbox
//     and no JavaScript dialogs (hardenWebview).
//   * That partition's session looks like Chrome to Google, grants no permission and
//     downloads nothing (setupImagesSession).
//   * A guest page's popups and its links "in a new window" open in the user's browser —
//     only on the heels of the user's own click or key in it — and its right-click menu
//     is a browser's, plus "Add Image to Whiteboard" (attachGuest).
//   * A picture dragged out of the panel or added from that menu reaches the bundle as an
//     ADDRESS, never as a File (Chromium does not hand a drag out of a <webview> over as
//     one), so main fetches it through the same session and answers bytes that
//     whiteboards.saveImage() takes as they are: PNG, JPEG or WebP (fetchImage). Any other
//     format it can read is decoded by sips in a sandbox of its own (convertToPng).
//
// The pure helpers come first and load no Electron, so scripts/test-images.js can run
// them under plain node — where require('electron') is only the path of the binary.
// Everything that needs Electron requires it inside the function.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PARTITION = 'persist:sb-images';
// whiteboards.saveImage's own cap, so nothing is fetched that it would then refuse.
const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20 * 1000;
const CONVERT_TIMEOUT_MS = 15 * 1000;
// Where the panel may START. Once there it is a browser and goes where its links go.
const PANEL_HOSTS = new Set(['www.google.com', 'images.google.com']);
// What saveImage() keeps as it is; anything else this recognises is converted to PNG.
const KEPT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const CONVERTIBLE = { 'image/gif': 'gif', 'image/avif': 'avif', 'image/heic': 'heic', 'image/bmp': 'bmp', 'image/tiff': 'tiff' };
// The user pressing a mouse button or a key in a guest page, as 'input-event' names it —
// once per press: a Mac sends a key as rawKeyDown then char, and only the first counts —
// and how long that lets the page open a tab in the user's browser.
const ACTIVATING_INPUT = new Set(['mouseDown', 'rawKeyDown', 'keyDown']);
const ACTIVATION_MS = 1000;

// What sips may do while it decodes a picture off the web (convertToPng): read, and write
// in the two folders it is given — WORK, the picture's own temp folder, and TEMP, the
// user's temp folder, which sips writes its answer through whatever TMPDIR says — and
// nothing else: no network, no other program, no service but the video decoder a HEIC or
// AVIF is decoded by, and the IOSurface it hands the frame back in. Measured on macOS
// 26: GIF, BMP and TIFF need none of the last two, HEIC and AVIF both, and curl run
// under the same rules reaches nothing.
const SIPS_PROFILE = [
  '(version 1)',
  '(deny default)',
  '(allow process-exec (literal "/usr/bin/sips"))',
  '(allow file-read*)',
  '(allow file-write* (subpath (param "WORK")) (subpath (param "TEMP")))',
  '(allow sysctl-read)',
  '(allow mach-lookup (global-name "com.apple.coremedia.videodecoder"))',
  '(allow iokit-open (iokit-user-client-class "IOSurfaceRootUserClient"))',
].join('');

const FORMAT_ERROR = "That picture's format can't be used here";
const TOO_LARGE = `That image is over ${Math.round(IMAGE_MAX_BYTES / 1024 / 1024)} MB`;

// ── pure helpers ────────────────────────────────────────────────────────────

function parseUrl(value) {
  try { return new URL(String(value)); } catch (_) { return null; }
}

function isWebUrl(value) {
  const u = parseUrl(value);
  return !!u && (u.protocol === 'http:' || u.protocol === 'https:');
}

/**
 * True for the one kind of address a panel may be created on: https, on exactly
 * www.google.com or images.google.com, with no credentials and no odd port. Parsed, never
 * pattern-matched, so www.google.com.evil.test, www.google.com@evil.test and
 * evil.test/#www.google.com are all just other hosts.
 */
function isGoogleImagesSrc(value) {
  const u = parseUrl(value);
  return !!u && u.protocol === 'https:' && PANEL_HOSTS.has(u.hostname) && !u.username && !u.password && u.port === '';
}

/**
 * Electron's default user agent minus the two tokens it adds to Chrome's — the app's own
 * name/version and Electron/x — so Google serves the page it serves Chrome rather than
 * its basic-HTML fallback. The app's token is whatever sits between "(KHTML, like
 * Gecko)" and "Chrome/", which is where Electron puts it whatever the app is called.
 */
function cleanUserAgent(ua) {
  return String(ua || '')
    .replace(/\s+Electron\/\S+/g, '')
    .replace(/(\(KHTML, like Gecko\))(?:\s+(?!Chrome\/)[^\s/]+\/\S+)+(?=\s+Chrome\/)/, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// google.com and its country domains — google.co.uk, google.com.au, google.de.
function isGoogleHost(hostname) {
  return /^(?:www\.|images\.)?google\.(?:com|com?\.[a-z]{2}|[a-z]{2,3})$/.test(String(hostname || ''));
}

/** data:image/<anything>;base64,… — the inline thumbnails Google's results are made of. */
function isImageDataUrl(value) {
  return /^data:image\/[a-z0-9.+-]+(?:;[^,;]*)*;base64,/i.test(String(value || ''));
}

function isFetchableImageUrl(value) {
  return isWebUrl(value) || isImageDataUrl(value);
}

/**
 * The picture behind one of Google's redirect wrappers, or the address unchanged. A
 * result's link is /imgres?imgurl=<the picture>, and an outbound link /url?url=… or
 * /url?q=…; a drag can carry either. Only on a Google host, and only when what is inside
 * is itself something fetchImage could fetch — a wrapper around javascript: stays the
 * wrapper. Three levels at most, which is two more than Google has ever been seen to use.
 */
function unwrapImageUrl(value) {
  let current = String(value || '').trim();
  for (let i = 0; i < 3; i++) {
    const u = parseUrl(current);
    if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:') || !isGoogleHost(u.hostname)) return current;
    let inner = null;
    if (u.pathname === '/imgres') inner = u.searchParams.get('imgurl');
    else if (u.pathname === '/url') inner = u.searchParams.get('url') || u.searchParams.get('q');
    if (!inner || !isFetchableImageUrl(inner)) return current;
    current = inner.trim();
  }
  return current;
}

/**
 * The link round one of Google's results — /imgres?imgurl=<the picture>&imgrefurl=<its
 * page> — when it leads to the full picture: the link itself, or '' for anything else.
 * A drag out of the results, or a right-click on one, carries the result's thumbnail
 * (a gstatic picture a couple of hundred pixels across) as its picture and this link as
 * its link; measured on Google's page in this Electron. Fetched, the link is unwrapped to
 * the original (unwrapImageUrl), so a picture from the panel lands at its own size.
 */
function googleOriginal(value) {
  const u = parseUrl(String(value || '').trim());
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:') || !isGoogleHost(u.hostname)) return '';
  if (u.pathname !== '/imgres') return '';
  return isWebUrl(u.searchParams.get('imgurl')) ? u.href : '';
}

/**
 * The page a Google /imgres link says its picture is on (imgrefurl), or ''. It is the
 * Referer the picture would have gone out with from there — the one a host that guards
 * its pictures from other sites expects — where the results page would only be google's.
 */
function sourcePageOf(value) {
  const u = parseUrl(String(value || '').trim());
  if (!u || !isGoogleHost(u.hostname) || u.pathname !== '/imgres') return '';
  const page = u.searchParams.get('imgrefurl');
  return isWebUrl(page) ? page : '';
}

/**
 * A base64 image data: URL as { bytes, type }, `type` being what the URL CLAIMS — the
 * bytes are sniffed afterwards like any download's. null for anything else: another
 * MIME type, a percent-encoded body (an SVG, typically), base64 that does not decode.
 * { tooLarge: true } past `max`, worked out from the length before anything is decoded.
 */
function parseDataUrl(value, max = IMAGE_MAX_BYTES) {
  const text = String(value || '');
  const m = /^data:(image\/[a-z0-9.+-]+)((?:;[^,;]*)*);base64,/i.exec(text);
  if (!m) return null;
  let body = text.slice(m[0].length);
  if (/%[0-9a-f]{2}/i.test(body)) {
    try { body = decodeURIComponent(body); } catch (_) { return null; }
  }
  body = body.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(body)) return null;
  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
  if (Math.floor(body.length * 3 / 4) - padding > max) return { tooLarge: true };
  const bytes = Buffer.from(body, 'base64');
  if (!bytes.length) return null;
  return { bytes, type: m[1].toLowerCase() };
}

function ascii(buf, start, end) {
  return buf.length >= end ? buf.toString('latin1', start, end) : '';
}

/**
 * The picture's real type, from its first bytes, or null. Never the Content-Type: a
 * server that calls everything image/jpeg, or a hotlink guard answering an HTML page
 * with 200, is common enough that the header cannot decide what saveImage() is told.
 */
function sniffImageType(input) {
  if (!Buffer.isBuffer(input) && !ArrayBuffer.isView(input)) return null;
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return 'image/webp';
  if (ascii(buf, 0, 6) === 'GIF87a' || ascii(buf, 0, 6) === 'GIF89a') return 'image/gif';
  // ISO base media (HEIF): a `ftyp` box naming the major brand and the compatible ones.
  // AVIF is HEIF with an AV1 brand among them, so it is looked for first.
  if (ascii(buf, 4, 8) === 'ftyp' && buf.length >= 12) {
    const size = Math.min(Math.max(buf.readUInt32BE(0), 16), buf.length);
    const brands = [ascii(buf, 8, 12)];
    for (let at = 16; at + 4 <= size; at += 4) brands.push(ascii(buf, at, at + 4));
    if (brands.some(b => b === 'avif' || b === 'avis')) return 'image/avif';
    if (brands.some(b => ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(b))) return 'image/heic';
    return null;
  }
  // "BM" alone starts plenty of text; a real bitmap's DIB header has one of these sizes.
  if (ascii(buf, 0, 2) === 'BM' && buf.length >= 18 && [12, 16, 40, 52, 56, 64, 108, 124].includes(buf.readUInt32LE(14))) return 'image/bmp';
  if (buf.length >= 4) {
    const head = buf.readUInt32BE(0);
    if (head === 0x49492a00 || head === 0x4d4d002a || head === 0x49492b00 || head === 0x4d4d002b) return 'image/tiff';
  }
  return null;
}

/**
 * A short, file-name-ish label for a picture: the last part of its address's path —
 * "golden-retriever.jpg" — or "Image" when that says nothing (a data: URL, a bare host,
 * a path of punctuation, one of Google's own thumbnails). The query is never part of it.
 */
function imageName(value) {
  const u = parseUrl(value);
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return 'Image';
  // Every thumbnail in Google's grid that isn't a data: URL is
  // https://encrypted-tbnN.gstatic.com/images?q=tbn:…, whose path says only "images".
  if (/^encrypted-tbn\d*\.gstatic\.com$/.test(u.hostname)) return 'Image';
  const segment = u.pathname.split('/').filter(Boolean).pop() || '';
  let name = segment;
  try { name = decodeURIComponent(segment); } catch (_) { name = segment; }
  name = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(name)) return 'Image';
  if (name.length > 60) {
    const ext = /\.[A-Za-z0-9]{1,5}$/.exec(name);
    const tail = ext ? ext[0] : '';
    name = name.slice(0, 60 - tail.length).trim() + tail;
  }
  return name;
}

/**
 * The Referer a browser would have sent for this picture from the page it was on — the
 * default policy, strict-origin-when-cross-origin: the whole address on the same origin,
 * the origin alone across origins, nothing from https down to http. Some hosts refuse a
 * picture without one; none should refuse the one a browser sends.
 */
function refererFor(target, referrer) {
  const to = parseUrl(target);
  const from = parseUrl(referrer);
  if (!to || !from || (from.protocol !== 'http:' && from.protocol !== 'https:')) return '';
  if (from.protocol === 'https:' && to.protocol === 'http:') return '';
  if (from.origin === to.origin) {
    from.hash = '';
    from.username = '';
    from.password = '';
    return from.href;
  }
  return from.origin + '/';
}

/**
 * Vet a <webview> the main window is about to attach — the `will-attach-webview`
 * handler's whole decision. false refuses it (the caller prevents the attach). true
 * when it may go ahead, after forcing what the page cannot be allowed to choose: the
 * partition (a `webpreferences` attribute can name another one, and wins over the
 * attribute), no preload, no Node, isolation, the sandbox, web security, and no
 * JavaScript dialogs. A guest's alert() and confirm() are sheets on the window it is
 * in — Switchboard's own — saying whatever the page likes, one after another, with no
 * "prevent additional dialogs" (safeDialogs is off); a search page needs none of them,
 * and with them off confirm() answers false at once.
 *
 * Popups are let THROUGH to the guest's setWindowOpenHandler rather than disabled:
 * measured in this Electron, a guest without `allowpopups` has window.open answer null
 * before that handler is ever asked, so a result opening "in a new tab" would do
 * nothing at all instead of opening in the user's browser. The handler always denies,
 * and sends a popup to the browser only on the heels of a click or key in the page
 * (attachGuest): once popups are allowed, Electron's CanCreateWindow ignores the user
 * gesture, and there is no popup blocker — measured, a page's window.open in a loop at
 * load reached the handler every time.
 */
function hardenWebview(webPreferences, params) {
  const p = params || {};
  if (p.partition !== PARTITION || !isGoogleImagesSrc(p.src)) return false;
  const prefs = webPreferences || {};
  delete prefs.preload;
  delete prefs.preloadURL;
  delete prefs.enableBlinkFeatures;
  delete p.preload;
  Object.assign(prefs, {
    partition: PARTITION,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    disablePopups: false,
    disableDialogs: true,
  });
  return true;
}

/**
 * One guest page's user activation, as Chrome keeps it: a press of a mouse button or a
 * key in the page gives it one, a popup spends it, and it is gone a second later anyway
 * — a second from letting go of the mouse, for a click held down. So one click opens at
 * most one tab in the user's browser, and a page nobody clicks in opens none. `now` is
 * the clock.
 */
function userActivation(now = Date.now) {
  let at = -Infinity;
  let spent = true;
  return {
    input(type) {
      if (ACTIVATING_INPUT.has(type)) {
        at = now();
        spent = false;
      } else if (type === 'mouseUp' && !spent) {
        at = now();
      }
    },
    consume() {
      if (spent || now() - at >= ACTIVATION_MS) return false;
      spent = true;
      return true;
    },
  };
}

/**
 * The right-click menu for a point on the panel's page, as data: [{ id, label, enabled }]
 * with { type: 'separator' } between groups. What a browser offers — the picture, the
 * link, the field or the selection — then Back / Forward / Reload, always. attachGuest
 * turns each id into the action; this half is here so the wording can be tested.
 */
function contextMenuItems(params, nav) {
  const p = params || {};
  const flags = p.editFlags || {};
  const groups = [];
  if (p.mediaType === 'image' && p.srcURL) {
    groups.push([
      { id: 'addImage', label: 'Add Image to Whiteboard', enabled: isFetchableImageUrl(p.srcURL) || !!googleOriginal(p.linkURL) },
      { id: 'copyImage', label: 'Copy Image', enabled: p.hasImageContents !== false },
      { id: 'copyImageAddress', label: 'Copy Image Address', enabled: true },
      // A thumbnail is often a data: URL, which no browser can be handed.
      { id: 'openImage', label: 'Open Image in Browser', enabled: isWebUrl(p.srcURL) },
    ]);
  }
  if (p.linkURL && isWebUrl(p.linkURL)) {
    groups.push([
      { id: 'openLink', label: 'Open Link in Browser', enabled: true },
      { id: 'copyLink', label: 'Copy Link Address', enabled: true },
    ]);
  }
  if (p.isEditable) {
    groups.push([
      { id: 'cut', label: 'Cut', enabled: !!flags.canCut },
      { id: 'copy', label: 'Copy', enabled: !!flags.canCopy },
      { id: 'paste', label: 'Paste', enabled: !!flags.canPaste },
      { id: 'selectAll', label: 'Select All', enabled: !!flags.canSelectAll },
    ]);
  } else if (String(p.selectionText || '').trim()) {
    groups.push([{ id: 'copy', label: 'Copy', enabled: true }]);
  }
  const n = nav || {};
  groups.push([
    { id: 'back', label: 'Back', enabled: !!n.canGoBack },
    { id: 'forward', label: 'Forward', enabled: !!n.canGoForward },
    { id: 'reload', label: 'Reload', enabled: true },
  ]);
  const items = [];
  groups.forEach((group, i) => {
    if (i) items.push({ type: 'separator' });
    items.push(...group);
  });
  return items;
}

// ── Electron ────────────────────────────────────────────────────────────────

let sessionReady = false;

/**
 * The panel's session, once, after `ready`: Chrome's user agent (above), every permission
 * refused — a search page needs none, and an "allow notifications?" from some site the
 * panel wandered to has nobody to ask — and every download cancelled, since a click on a
 * file link would otherwise drop it into ~/Downloads unasked. Refusing permissions also
 * refuses 'openExternal', so a link to some app's own scheme launches nothing.
 */
function setupImagesSession() {
  const { app, session } = require('electron');
  const ses = session.fromPartition(PARTITION);
  if (sessionReady) return ses;
  sessionReady = true;
  ses.setUserAgent(cleanUserAgent(app.userAgentFallback));
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', event => event.preventDefault());
  return ses;
}

/**
 * What Add Image to Whiteboard sends the page (sb:evt:diagramsImageOffer) for a right-click
 * at `params`: the full picture behind a Google result when there is one, else the
 * picture clicked — and that one as the fallback, should the full picture not come.
 */
function imageOffer(guestId, params) {
  const p = params || {};
  const original = googleOriginal(p.linkURL);
  return {
    guestId,
    url: original || p.srcURL || '',
    fallback: original && isFetchableImageUrl(p.srcURL) ? p.srcURL : '',
    referrer: p.frameURL || p.pageURL || '',
  };
}

/**
 * A guest page the main window has just attached. `deps`: { openExternal(url), offerImage
 * ({ guestId, url, fallback, referrer }), window() } — main's openExternal, the send of
 * sb:evt:diagramsImageOffer, and the window the menu belongs to.
 */
function attachGuest(wc, deps) {
  const { Menu, clipboard } = require('electron');
  // A new window is never made: http(s) goes to the user's browser, anything else nowhere
  // — and the browser only when the user has just clicked or typed in the page, once per
  // click (userActivation). Without that a page could open tabs there by itself, as
  // many as it liked, with no popup blocker anywhere to stop it.
  const activation = userActivation();
  wc.on('input-event', (_event, input) => activation.input(input && input.type));
  wc.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url) && activation.consume()) deps.openExternal(url);
    return { action: 'deny' };
  });
  // Plain web navigation is the point of a browser; anything else is not.
  wc.on('will-navigate', (event, legacyUrl) => {
    const url = event && typeof event.url === 'string' ? event.url : legacyUrl;
    if (!isWebUrl(url)) event.preventDefault();
  });
  const copyText = text => {
    Promise.resolve()
      .then(() => clipboard.writeText(String(text || '')))
      .catch(err => console.error('[switchboard] could not copy from the images panel:', err.message));
  };
  wc.on('context-menu', (_event, params) => {
    const live = fn => () => { if (!wc.isDestroyed()) fn(); };
    const history = wc.navigationHistory;
    const actions = {
      addImage: () => deps.offerImage(imageOffer(wc.id, params)),
      // At the point clicked, in the guest's own coordinates — which are the event's.
      copyImage: live(() => wc.copyImageAt(params.x, params.y)),
      copyImageAddress: () => copyText(params.srcURL),
      openImage: () => deps.openExternal(params.srcURL),
      openLink: () => deps.openExternal(params.linkURL),
      copyLink: () => copyText(params.linkURL),
      cut: live(() => wc.cut()),
      copy: live(() => wc.copy()),
      paste: live(() => wc.paste()),
      selectAll: live(() => wc.selectAll()),
      back: live(() => history.goBack()),
      forward: live(() => history.goForward()),
      reload: live(() => wc.reload()),
    };
    const items = contextMenuItems(params, { canGoBack: history.canGoBack(), canGoForward: history.canGoForward() });
    const template = items.map(item => (item.type === 'separator' ? item
      : { label: item.label, enabled: item.enabled, click: actions[item.id] }));
    const win = deps.window();
    Menu.buildFromTemplate(template).popup(Object.assign(
      win && !win.isDestroyed() ? { window: win } : {},
      params.frame ? { frame: params.frame } : {}
    ));
  });
}

/**
 * The guest of `host` that has the keyboard, or null — how the Edit menu knows ⌘C belongs
 * to the panel's page rather than the canvas.
 *
 * host.focusedFrame, the frame focus is in, mapped back to its WebContents. Not
 * webContents.getFocusedWebContents() and not guest.isFocused(): measured in this
 * Electron with the window key, both name the guest whenever one is attached at all —
 * while the page's own input has focus too — so either would send every ⌘C on the canvas
 * into the panel. The focused frame moves to the guest when it is clicked and back when
 * anything in the page is, which is the question.
 */
function focusedGuest(host) {
  if (!host || host.isDestroyed()) return null;
  try {
    const { webContents } = require('electron');
    const frame = host.focusedFrame;
    const wc = frame ? webContents.fromFrame(frame) : null;
    if (!wc || wc === host || wc.isDestroyed() || wc.getType() !== 'webview' || wc.hostWebContents !== host) return null;
    return wc;
  } catch (_) {
    return null;                       // a frame torn down mid-question has no keyboard
  }
}

let userTempDir = null;

/** The user's temp folder as the sandbox sees it — its real path — asked for once. */
function sipsTempDir() {
  if (!userTempDir) {
    userTempDir = new Promise((resolve, reject) => {
      execFile('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { timeout: CONVERT_TIMEOUT_MS }, (err, out) => (err ? reject(err) : resolve(String(out).trim())));
    }).then(dir => fs.promises.realpath(dir));
    userTempDir.catch(() => { userTempDir = null; });
  }
  return userTempDir;
}

/**
 * Turn a GIF, AVIF, HEIC, BMP or TIFF into a PNG, or null. nativeImage would be the
 * obvious decoder, but measured in this Electron its createFromBuffer and createFromPath
 * decode PNG and JPEG alone — every other format, WebP included, comes back empty — so
 * this is macOS's own: sips, the command line onto ImageIO, the decoder Safari and
 * Preview use. A GIF gives its first frame. Through a private temp folder, removed after.
 *
 * The bytes are a stranger's, and sips is no browser: it decodes them in its own process,
 * as the user, unsandboxed. So it runs inside sandbox-exec with SIPS_PROFILE, and a
 * picture made to break ImageIO breaks into a process that can reach nothing.
 */
async function convertToPng(buf, type) {
  const ext = CONVERTIBLE[type];
  if (!ext || process.platform !== 'darwin') return null;
  let dir = null;
  try {
    // Real paths, which are what the sandbox matches: the temp folder is under /var,
    // which is /private/var.
    dir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-image-')));
    const temp = await sipsTempDir();
    const src = path.join(dir, 'picture.' + ext);
    const out = path.join(dir, 'picture.png');
    await fs.promises.writeFile(src, buf);
    const args = ['-p', SIPS_PROFILE, '-D', 'WORK=' + dir, '-D', 'TEMP=' + temp, '/usr/bin/sips', '-s', 'format', 'png', src, '--out', out];
    await new Promise((resolve, reject) => {
      execFile('/usr/bin/sandbox-exec', args, { timeout: CONVERT_TIMEOUT_MS }, err => (err ? reject(err) : resolve()));
    });
    const png = await fs.promises.readFile(out);
    return sniffImageType(png) === 'image/png' ? png : null;
  } catch (_) {
    return null;
  } finally {
    if (dir) fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Bytes in, the answer sb:diagrams:fetchImage promises out. */
async function finish(buf, name) {
  if (!buf || !buf.length) return { ok: false, error: 'That picture is empty' };
  const type = sniffImageType(buf);
  if (KEPT_TYPES.has(type)) return { ok: true, bytes: new Uint8Array(buf), type, name };
  if (!CONVERTIBLE[type]) return { ok: false, error: FORMAT_ERROR };
  const png = await convertToPng(buf, type);
  if (!png) return { ok: false, error: FORMAT_ERROR };
  if (png.length > IMAGE_MAX_BYTES) return { ok: false, error: TOO_LARGE };
  return { ok: true, bytes: new Uint8Array(png), type: 'image/png', name: name.replace(/\.(gif|avif|heic|heif|bmp|tiff?)$/i, '.png') };
}

/**
 * A picture from the panel, by address: { ok, bytes, type, name } or { ok:false, error }.
 * Through the panel's own session, so it goes out with that session's cookies and cache —
 * often the very bytes the panel just showed. `referrer` is the page the picture was on,
 * when the caller knows it — Add Image to Whiteboard does; a drop does not, and goes with
 * none — and then it carries the Referer a browser would send from there (refererFor).
 * A Google /imgres link is fetched as the original picture inside it, with that
 * picture's own page as the Referer (sourcePageOf) whoever asks.
 * 20 s for the whole download, and 25 MB counted as it streams, so a server that lies
 * about its length or never stops is cut off rather than held in memory. Every way out
 * before the body is read whole aborts the request, so nothing is left streaming in.
 */
async function fetchImage(url, referrer) {
  const target = unwrapImageUrl(url);
  if (/^data:/i.test(target)) {
    const parsed = parseDataUrl(target);
    if (!parsed) return { ok: false, error: FORMAT_ERROR };
    if (parsed.tooLarge) return { ok: false, error: TOO_LARGE };
    return finish(parsed.bytes, 'Image');
  }
  if (!isWebUrl(target)) return { ok: false, error: "That isn't the address of a picture" };

  const { session } = require('electron');
  const ses = session.fromPartition(PARTITION);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, FETCH_TIMEOUT_MS);
  // A read that never settles after an abort would hold this call forever, so every read
  // races the abort itself.
  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  aborted.catch(() => {});
  let buf;
  // Where the picture was in the end, for its name: past any redirect when the session
  // says so. Electron 44's fetch never does (measured: res.url is ''), so for now that is
  // the address asked for.
  let landed = target;
  try {
    const headers = { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' };
    // A Google result's own page beats the results page the caller knows.
    const referer = refererFor(target, sourcePageOf(url) || referrer);
    if (referer) headers.Referer = referer;
    const res = await Promise.race([ses.fetch(target, { signal: controller.signal, headers, redirect: 'follow' }), aborted]);
    if (!res.ok) {
      // Measured: left open, an error page that never ends keeps streaming into the
      // session, and six of them hold every connection to that host.
      controller.abort();
      return { ok: false, error: `That picture couldn't be downloaded (HTTP ${res.status})` };
    }
    if (res.url && isWebUrl(res.url)) landed = res.url;
    if (Number(res.headers.get('content-length')) > IMAGE_MAX_BYTES) {
      controller.abort();
      return { ok: false, error: TOO_LARGE };
    }
    const chunks = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        total += value.byteLength;
        if (total > IMAGE_MAX_BYTES) {
          controller.abort();
          reader.cancel().catch(() => {});
          return { ok: false, error: TOO_LARGE };
        }
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
    }
    buf = Buffer.concat(chunks, total);
  } catch (err) {
    if (timedOut) return { ok: false, error: 'That picture took too long to download' };
    return { ok: false, error: `That picture couldn't be downloaded: ${(err && err.message) || err}` };
  } finally {
    clearTimeout(timer);
  }
  // The 20 s are the download's; a conversion has its own limit.
  return finish(buf, imageName(landed));
}

module.exports = {
  PARTITION,
  IMAGE_MAX_BYTES,
  isGoogleImagesSrc,
  cleanUserAgent,
  unwrapImageUrl,
  googleOriginal,
  sourcePageOf,
  parseDataUrl,
  sniffImageType,
  imageName,
  refererFor,
  isFetchableImageUrl,
  hardenWebview,
  userActivation,
  contextMenuItems,
  imageOffer,
  SIPS_PROFILE,
  setupImagesSession,
  attachGuest,
  focusedGuest,
  fetchImage,
};
