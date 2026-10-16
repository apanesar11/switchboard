'use strict';

// videos.js — YouTube videos on a whiteboard, main's half. ARCHITECTURE §4.17.
//
// A "video" node draws YouTube's poster picture, and a click on it mounts YouTube's own
// player in an <iframe> in the app's page — not a <webview>, so the player lives inside
// the main window's webContents and session, beside the app itself. That page is
// someone else's code, so main sets what the player needs and nothing more:
//   * The player's page goes out with a Referer naming the app (embedRequestHeaders). A
//     file:// page sends none, and without one every embed is "Video player
//     configuration error · Error 153" — measured.
//   * A popup from the player opens in the user's browser only when it leads to YouTube
//     or to Google's help pages, and one per quiet second (playerPopups). Measured: a
//     window.open from the player with no click at all reaches the window-open handler,
//     and nothing in Electron stops a loop of them.
//   * A frame may not navigate the app's window (startedByAFrame) — after any click in
//     it, the player may set top.location whenever it likes — and the player's own frame
//     stays on the player (leavesThePlayer).
//   * A page from the web in the app's window is granted one permission: fullscreen, to
//     the player (permissionAllowed). The app's own page is answered as Electron answers
//     a session with no handler at all: yes.
//   * A video's title is asked of YouTube's oEmbed endpoint once, when the video is made
//     (videoInfo).
//
// The pure helpers come first and load no Electron, so scripts/test-videos.js can run
// them under plain node. Everything that needs Electron requires it inside the function.

// The player's host: the privacy-enhanced one, which sets no cookie just by loading
// (youtube.com's embed wrote five into the app's session; measured). The bundle builds
// every player address on it (lib/diagrams/youtube.ts youTubeEmbedUrl), and no other.
const PLAYER_ORIGIN = 'https://www.youtube-nocookie.com';
const PLAYER_HOST = 'www.youtube-nocookie.com';
const EMBED_URLS = [PLAYER_ORIGIN + '/embed/*'];
// YouTube's terms ask a desktop app to name itself in the Referer as https://<its app
// id>: the bundle id desktop-install.js (BUNDLE_ID) checks and scripts/package.js
// (appBundleId) builds with, neither of which exports it. Today only the header's
// presence is checked — "x" played; measured.
const APP_REFERER = 'https://local.switchboard.app/';
// lib/diagrams/youtube.ts isYouTubeVideoId, which main cannot import: 11 characters of
// base64url, minus the two 11-letter words /embed/ takes that are not videos.
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const NOT_VIDEO_IDS = new Set(['videoseries', 'live_stream']);
// Where a popup from the player may lead: YouTube itself — Watch on YouTube, the title,
// the channel — and the help and privacy pages its menus link to.
const POPUP_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be',
  'support.google.com', 'policies.google.com',
]);
const POPUP_QUIET_MS = 1000;
// The referrer policy a popup from the app's own page comes with: the page sets none.
const APP_REFERRER_POLICIES = new Set(['default', 'strict-origin-when-cross-origin']);
// The permissions a player is given. Its fullscreen button asks for this one, and in
// load and playback it asks for nothing else (it CHECKs background-sync, which it is
// refused); measured.
const PLAYER_PERMISSIONS = new Set(['fullscreen']);
const INFO_TIMEOUT_MS = 10 * 1000;
// An oEmbed answer is under a kilobyte; anything near this is not one.
const INFO_MAX_BYTES = 64 * 1024;
// YouTube stops a title at 100 characters; twice that is still one line of a label.
const INFO_TEXT_MAX = 200;

// ── pure helpers ────────────────────────────────────────────────────────────

function parseUrl(value) {
  try { return new URL(String(value)); } catch (_) { return null; }
}

function isVideoId(value) {
  return typeof value === 'string' && VIDEO_ID_RE.test(value) && !NOT_VIDEO_IDS.has(value);
}

/**
 * True for a player's address: https on exactly www.youtube-nocookie.com, under /embed/,
 * with no credentials and no odd port. Parsed, never pattern-matched.
 */
function isPlayerUrl(value) {
  const u = parseUrl(value);
  return !!u && u.protocol === 'https:' && u.hostname === PLAYER_HOST && u.port === '' &&
    !u.username && !u.password && u.pathname.startsWith('/embed/');
}

/**
 * The headers a request matching EMBED_URLS goes out with. The player's own page — the
 * iframe's document, a 'subFrame' request — gets the Referer; anything else matching is
 * handed back exactly as it came. Only that one request needs it: the player's own
 * scripts and video requests carry the frame's origin as theirs.
 */
function embedRequestHeaders(details) {
  const d = details || {};
  if (d.resourceType !== 'subFrame' || !isPlayerUrl(d.url)) return d.requestHeaders;
  const headers = {};
  for (const [name, value] of Object.entries(d.requestHeaders || {})) {
    if (name.toLowerCase() !== 'referer') headers[name] = value;
  }
  headers.Referer = APP_REFERER;
  return headers;
}

/**
 * Who a popup came from, by the referrer Electron hands the window-open handler — its
 * details name no frame: 'player', 'web' for any other http(s) page, or 'app'. The app's
 * file:// page sends no referrer, under the default policy (measured: { url: '', policy:
 * 'strict-origin-when-cross-origin' }, from window.open and from a middle click on a
 * link). A popup with no referrer under any other policy — the player's window.open
 * with "noreferrer" comes as 'no-referrer' — is a page that hid where it was, and the
 * app's page never asks to. One way of hiding still looks like the app: a page from the
 * web opening an http:// address under the default policy, which drops the referrer on
 * the way down from https.
 */
function popupSource(referrer) {
  const r = referrer && typeof referrer === 'object' ? referrer : { url: referrer };
  const u = parseUrl(r.url);
  if (u && (u.protocol === 'https:' || u.protocol === 'http:')) return u.origin === PLAYER_ORIGIN ? 'player' : 'web';
  return !r.policy || APP_REFERRER_POLICIES.has(r.policy) ? 'app' : 'web';
}

/** https on one of POPUP_HOSTS, any path, with no credentials and no odd port. */
function isPlayerPopupUrl(value) {
  const u = parseUrl(value);
  return !!u && u.protocol === 'https:' && POPUP_HOSTS.has(u.hostname) && u.port === '' && !u.username && !u.password;
}

/**
 * The main window's popups, which its window-open handler sends to the user's browser
 * when allow(details) says so. The app's own go as they always have. One from the player
 * goes only to POPUP_HOSTS, and only after a second with no other popup from it — every
 * one counts, refused or not — so a click on Watch on YouTube opens one tab, and a loop
 * of window.open opens one and then nothing for as long as it keeps going. Any other page
 * from the web opens nothing: the player is the only one the app puts in its window, so
 * another is something the player brought along. `now` is the clock.
 */
function playerPopups(now = Date.now) {
  let last = -Infinity;
  return {
    allow(details) {
      const d = details || {};
      const source = popupSource(d.referrer);
      if (source === 'app') return true;
      if (source === 'web') return false;
      const at = now();
      const quiet = at - last >= POPUP_QUIET_MS;
      last = at;
      return quiet && isPlayerPopupUrl(d.url);
    },
  };
}

/**
 * Whether a top navigation of the main window (`will-navigate`) was started by a frame
 * inside the page — the player, which may set top.location at any time once it has had a
 * click — rather than by the page itself or by the browser (a link dropped on the window
 * has no initiator). Electron hands the starting frame as `event.initiator`, the same
 * object as `mainFrame` when the page started it (measured). Compared by identity, which
 * asks the frame nothing: a frame whose process has gone throws on every question. When
 * the window cannot say what its main frame is, a frame started it.
 */
function startedByAFrame(event, wc) {
  const initiator = event && event.initiator;
  if (!initiator) return false;
  try {
    return initiator !== wc.mainFrame;
  } catch (_) {
    return true;
  }
}

/**
 * Whether a frame navigation (`will-frame-navigate`) takes one of the page's own iframes
 * — a frame whose parent is the main frame, which only a player is — anywhere but a
 * player's address. The player's own frames, deeper down, go where they go. A frame torn
 * down mid-question navigates nowhere, so it is let be.
 */
function leavesThePlayer(event, wc) {
  if (!event || event.isMainFrame) return false;
  if (isPlayerUrl(event.url)) return false;
  try {
    const frame = event.frame;
    return !!frame && !!frame.parent && frame.parent === wc.mainFrame;
  } catch (_) {
    return false;
  }
}

/**
 * The default session's answer to a permission request or check from `requestingUrl`.
 * A page from the web in the app's window — the player, or a frame it brought — gets
 * PLAYER_PERMISSIONS, from the player's host, and nothing else: not a notification, not
 * a camera, not 'openExternal' (an address in another app's scheme, which Electron
 * otherwise opens in that app). Everything else — the app's own file:// page, DevTools —
 * is answered yes, as Electron answers a session with no handler: the app's
 * navigator.clipboard fallbacks ask for clipboard-sanitized-write.
 */
function permissionAllowed(permission, requestingUrl) {
  const u = parseUrl(requestingUrl);
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return true;
  return u.origin === PLAYER_ORIGIN && PLAYER_PERMISSIONS.has(permission);
}

/** Where a video's title is asked: YouTube's oEmbed answer for the video's watch page. */
function oEmbedUrl(videoId) {
  return 'https://www.youtube.com/oembed?format=json&url=' +
    encodeURIComponent('https://www.youtube.com/watch?v=' + videoId);
}

/** Plain text on one line, cut to INFO_TEXT_MAX characters — never half a character. */
function oneLine(value) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > INFO_TEXT_MAX ? chars.slice(0, INFO_TEXT_MAX).join('').trimEnd() : text;
}

/**
 * What an oEmbed answer that is not 200 means to the user. A made-up id is 400 (measured,
 * 2026-10-16). By oEmbed's own rules 404 is a video it has nothing on and 401 a private
 * one; 403 is read the same way, as a video its owner keeps off other sites' players.
 */
function statusError(status) {
  if (status === 400 || status === 404) return "That video isn't on YouTube";
  if (status === 401 || status === 403) return "That video can't be embedded";
  return `YouTube didn't answer (HTTP ${status})`;
}

// ── Electron ────────────────────────────────────────────────────────────────

/**
 * The default session's part in a video, set up after `ready` and before the window: the
 * Referer on the player's page, and the permission handlers. A session takes ONE onBeforeSendHeaders
 * listener — another replaces this one, and every embed is Error 153 again — so a new
 * header for the default session goes in embedRequestHeaders, not in a listener of its
 * own. The Google Images panel's session (images.js) is another session, untouched.
 */
function setupVideoEmbeds(ses) {
  ses.webRequest.onBeforeSendHeaders({ urls: EMBED_URLS }, (details, callback) => {
    callback({ requestHeaders: embedRequestHeaders(details) });
  });
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(permissionAllowed(permission, details && details.requestingUrl));
  });
  // A check from a cross-origin frame comes with no requestingUrl; its origin is enough.
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) =>
    permissionAllowed(permission, requestingOrigin || (details && details.requestingUrl)));
}

/**
 * A video's title and channel, by its id: { ok, data: { title, author } } or { ok:false,
 * error }, answered by YouTube's oEmbed endpoint through the default session. The bundle
 * asks once, when a video is made, and labels the node with the title. Plain text — the
 * JSON is not HTML-escaped — on one line. 10 s for the whole answer and 64 KB counted as
 * it streams; every way out before the body is read whole aborts the request.
 * `opts.fetch` and `opts.timeoutMs` stand in for net.fetch and the 10 s in a test.
 */
async function videoInfo(videoId, opts = {}) {
  if (!isVideoId(videoId)) return { ok: false, error: "That isn't the id of a YouTube video" };
  const fetchFn = opts.fetch || require('electron').net.fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, opts.timeoutMs || INFO_TIMEOUT_MS);
  // A read that never settles after an abort would hold this call forever, so every read
  // races the abort itself.
  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  aborted.catch(() => {});
  let text;
  try {
    const res = await Promise.race([fetchFn(oEmbedUrl(videoId), {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      credentials: 'omit',
    }), aborted]);
    if (!res.ok) {
      controller.abort();
      return { ok: false, error: statusError(res.status) };
    }
    if (Number(res.headers.get('content-length')) > INFO_MAX_BYTES) {
      controller.abort();
      return { ok: false, error: "YouTube's answer was too long" };
    }
    const chunks = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        total += value.byteLength;
        if (total > INFO_MAX_BYTES) {
          controller.abort();
          reader.cancel().catch(() => {});
          return { ok: false, error: "YouTube's answer was too long" };
        }
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
    }
    text = Buffer.concat(chunks, total).toString('utf8');
  } catch (_) {
    if (timedOut) return { ok: false, error: 'YouTube took too long to answer' };
    return { ok: false, error: "Couldn't reach YouTube" };
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try { body = JSON.parse(text); } catch (_) { body = null; }
  const title = oneLine(body && body.title);
  if (!title) return { ok: false, error: "YouTube didn't say what that video is called" };
  return { ok: true, data: { title, author: oneLine(body.author_name) } };
}

module.exports = {
  PLAYER_ORIGIN,
  APP_REFERER,
  EMBED_URLS,
  INFO_MAX_BYTES,
  isVideoId,
  isPlayerUrl,
  embedRequestHeaders,
  popupSource,
  isPlayerPopupUrl,
  playerPopups,
  startedByAFrame,
  leavesThePlayer,
  permissionAllowed,
  oEmbedUrl,
  setupVideoEmbeds,
  videoInfo,
};
