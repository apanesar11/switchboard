'use strict';

// widgets.js — whiteboard widgets, main's half. ARCHITECTURE §4.17 (Widgets).
//
// A widget is a folder of plain HTML, CSS and JavaScript that a whiteboard draws in a
// sandboxed <iframe> inside a node of its own (shape "widget"). The whiteboard only
// renders it; the widget holds all of its own logic. An agent makes one with
// scripts/widget.js and the switchboard-create-widget skill — nothing in the app writes
// a widget's files.
//
//   <config dir>/widgets/<id>/                 one widget: widget.json and its own files
//   <config dir>/widget-secrets.json           its API keys, encrypted, mode 0600
//   <config dir>/widget-secrets.pending.json   keys the CLI was handed, waiting for the
//                                              app to encrypt them, mode 0600
//
// Beside the config, as the whiteboards are, so SWITCHBOARD_CONFIG moves all of it for
// a test or a smoke and nothing here ever sits in a repo.
//
// A widget never holds an API key. Its folder is served over sbwidget://<id>/ (serve(),
// registered by index.js), and anything served can be read by the widget itself and
// copied with the folder — so a key is never kept there. The widget asks the host for
// data instead (Switchboard.fetch in src/renderer/widget-sdk.js, relayed by the
// whiteboard's face), and this module makes the request: it re-reads the manifest each
// time, talks to the manifest's api.baseUrl and nothing else, and attaches the key itself
// (createWidgetHost().fetch). The decrypted key never crosses IPC to the renderer and
// never reaches the iframe. A key is kept for the API it was given for — the origin of
// the manifest's api.baseUrl at the time — and sent to no other: widget.json is the
// agent's to edit, and a widget pointed elsewhere asks the user for its key again.
//
// Keys are encrypted with Electron's safeStorage (the macOS Keychain), as answer.js keeps
// keys.json. The CLI is plain node and cannot use safeStorage, so `widget.js set-secret`
// writes the value into the pending file instead (setPendingSecret, here, so the CLI and
// the app agree on its shape). The app moves pending keys into the encrypted file — and
// out of the pending one — at startup, whenever the pending file changes (watch()), and
// lazily before anything needs a key. On a Mac whose keychain can't be reached the proxy
// reads the pending value as it is (a 0600 file in the user's home, like ~/.npmrc) and
// the widget's state says the key isn't encrypted.
//
// Rules that hold for the whole file:
//   * Nothing throws. Every export resolves to a value; a failure is
//     `{ ok: false, error: '<human sentence>', code? }`.
//   * Electron is never required here: the pure helpers, the store and the pending file
//     run under plain node (scripts/widget.js, scripts/test-widgets.js), and the parts
//     that need safeStorage are handed it (createWidgetHost).
//   * Every path is computed from config.CONFIG_FILE when it is needed, never at require
//     time, and requiring this module does nothing on disk.
//   * No key, and no URL that could carry one, is ever logged.

const fs = require('fs');
const path = require('path');

const config = require('./config.js');

// The id is the sbwidget:// host, and a URL host is lowercase — so is the id.
const WIDGET_ID_RE = /^[a-z][a-z0-9-]{0,62}$/;
// A key's NAME, as widget.json's api.secret gives it: an environment variable's shape.
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SECRET_MAX = 4096;
const NAME_MAX = 60;
const ENTRY_MAX = 200;
const PREFIX_MAX = 64;
const MANIFEST_FILE = 'widget.json';
const MANIFEST_MAX_BYTES = 64 * 1024;
const SECRETS_NAME = 'widget-secrets.json';
const PENDING_NAME = 'widget-secrets.pending.json';
// The editor's limits on a node's size (lib/diagrams/types.ts FLOW_SIZE_MIN/MAX), which
// a manifest's default size and least size are held to.
const SIZE_MIN = 16;
const SIZE_MAX = 4000;
// The strip across a widget node's top (types.ts WIDGET_BAR): a least size must leave
// room for it and a little of the widget under it.
const WIDGET_BAR = 30;
const LEAST = { width: 120, height: WIDGET_BAR + 40 };

// The path under every widget's origin that is the app's, not the widget's: the SDK.
const RESERVED = '__switchboard';
const SDK_FILE = path.join(__dirname, '..', 'renderer', 'widget-sdk.js');
// The most one served file may be; a widget is a page, not a disk.
const SERVE_MAX_BYTES = 50 * 1024 * 1024;

// What may be served, by extension, and as what. Anything else is refused: a widget's
// folder may hold its sources and notes too, and nothing is guessed at (nosniff).
const MIME = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  txt: 'text/plain; charset=utf-8',
  map: 'application/json; charset=utf-8',
  wasm: 'application/wasm',
};

// What a widget's page may do. Its scripts and styles are its own (inline allowed — a
// one-file widget is the common case); fonts may come from Google Fonts, pictures from
// anywhere on https; and it may connect to nothing but its own origin: data comes
// through the host's fetch proxy, which holds the key and keeps to the manifest's base
// URL. No frames, no plugins, no forms posting anywhere, no <base>. Sent with every file
// served (a document is what it binds; on anything else it is inert), so an SVG opened
// as a page is held to it too. 'wasm-unsafe-eval' because MIME serves .wasm: without it
// Chromium refuses to compile any WebAssembly under this script-src, and it lets the page
// compile wasm and nothing else (no eval, no new Function).
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self'",
  "media-src 'self' blob: data:",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

// The fetch proxy's limits.
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const FETCH_TIMEOUT_MS = 20 * 1000;
const FETCH_MAX_BYTES = 5 * 1024 * 1024;
const FETCH_BODY_MAX_BYTES = 1024 * 1024;
const FETCH_MAX_INFLIGHT = 8;
const FETCH_PATH_MAX = 4096;
const FETCH_MAX_HEADERS = 40;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
const HEADER_VALUE_MAX = 8192;
// Headers a widget may not set: the key's own header (stripped below), credentials of
// any other kind, and the ones that are the connection's rather than the request's —
// several of which Node's fetch refuses outright.
const STRIPPED_HEADERS = new Set([
  'authorization', 'cookie', 'cookie2', 'host', 'connection', 'content-length',
  'transfer-encoding', 'keep-alive', 'upgrade', 'te', 'trailer', 'expect',
]);
// What of an answer's headers the widget is told: what it needs to read the body and to
// be polite about rate limits, and nothing that could carry a session.
const ANSWER_HEADERS = new Set(['content-type', 'cache-control', 'etag', 'last-modified', 'retry-after']);
const ANSWER_HEADER_PREFIXES = ['x-ratelimit-'];

// How long a folder has to be quiet before watch() says it changed: a save is often a
// write and a rename, and an agent writes several files in a row.
const WATCH_SETTLE_MS = 150;

// linkGate(): one link out of the widgets a second, and how many frames it remembers
// barring.
const LINK_QUIET_MS = 1000;
const LINK_BARRED_MAX = 256;
// What the Edit menu may run natively in a widget's frame (editInWidget).
const EDIT_ACTIONS = new Set(['copy', 'cut', 'paste', 'selectAll', 'undo', 'redo']);

let seq = 0;

// ── where things live ───────────────────────────────────────────────────────

function configDir() {
  // Beside the config: SWITCHBOARD_CONFIG has to move these too, or a test would write
  // into the user's real ~/.switchboard.
  return path.dirname(config.CONFIG_FILE);
}

function widgetsDir() {
  return path.join(configDir(), 'widgets');
}

function widgetDir(id) {
  return isWidgetId(id) ? path.join(widgetsDir(), id) : null;
}

function secretsFile() {
  return path.join(configDir(), SECRETS_NAME);
}

function pendingFile() {
  return path.join(configDir(), PENDING_NAME);
}

// ── small helpers ───────────────────────────────────────────────────────────

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isWidgetId(value) {
  return typeof value === 'string' && WIDGET_ID_RE.test(value);
}

function isSecretName(value) {
  return typeof value === 'string' && SECRET_NAME_RE.test(value);
}

/** An API origin as a manifest's api.origin gives one: http(s), scheme://host[:port], nothing else. */
function isOrigin(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
  } catch (_) {
    return false;
  }
}

/** The host an origin names, for a sentence — or null. */
function hostOf(origin) {
  try { return new URL(origin).host || null; } catch (_) { return null; }
}

function why(err) {
  const code = err && err.code;
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  if (code === 'EROFS') return 'the disk is read-only';
  if (code === 'ENOSPC') return 'the disk is full';
  return String((err && err.message) || err);
}

/** One line of text: whitespace runs collapsed, control characters gone. */
function oneLine(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A file only its owner can read, written whole through a temp file and a rename. */
function writePrivate(file, text) {
  const tmp = `${file}.${process.pid}.${++seq}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* never written */ }
    throw err;
  }
  // A file that existed with looser bits keeps them across a rename on some systems.
  try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort */ }
}

// ── the manifest ────────────────────────────────────────────────────────────

/** A size in whole pixels between the editor's limits, or a sentence saying what's wrong. */
function manifestSize(raw, field) {
  if (!isObject(raw)) return { error: `"${field}" must be an object like { "width": 480, "height": 300 }` };
  const out = {};
  for (const side of ['width', 'height']) {
    const value = raw[side];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < SIZE_MIN || value > SIZE_MAX) {
      return { error: `"${field}.${side}" must be a number from ${SIZE_MIN} to ${SIZE_MAX}` };
    }
    out[side] = Math.round(value);
  }
  return { value: out };
}

/**
 * A path inside the widget's folder, as a manifest or a URL names one: segments joined by
 * "/", none of them empty, "." or "..", none starting with "." (a dotfile is never part
 * of a widget's page), and no NUL or backslash anywhere. Null when it isn't one.
 */
function cleanSegments(segments) {
  if (!segments.length) return null;
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.startsWith('.')) return null;
    if (/[\u0000\\/]/.test(segment)) return null;
  }
  return segments;
}

/** The entry page: a relative path to an .html file inside the folder. */
function manifestEntry(raw) {
  if (raw === undefined || raw === null) return { value: 'index.html' };
  if (typeof raw !== 'string' || !raw.trim()) return { error: '"entry" must be the path of an .html file in the widget\'s folder' };
  const value = raw.trim();
  if (value.length > ENTRY_MAX) return { error: `"entry" must be ${ENTRY_MAX} characters or fewer` };
  const segments = cleanSegments(value.split('/'));
  if (!segments) return { error: '"entry" must be a path inside the widget\'s folder — no "..", no leading "/" or ".", no backslashes' };
  if (!/\.html?$/i.test(value)) return { error: '"entry" must name an .html file' };
  return { value: segments.join('/') };
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * The manifest's api: the one base URL the proxy talks to, and how the key goes with
 * each request. https only; http only to this Mac itself, for a widget's own dev server.
 * The base's path always ends in "/", so every request is matched against a directory.
 */
function manifestApi(raw) {
  if (!isObject(raw)) return { error: '"api" must be an object like { "baseUrl": "https://api.example.com/v1/" }' };
  if (typeof raw.baseUrl !== 'string' || !raw.baseUrl.trim()) return { error: '"api.baseUrl" is required: the https:// address every request starts with' };
  let base;
  try { base = new URL(raw.baseUrl.trim()); } catch (_) { return { error: '"api.baseUrl" must be a full URL, like https://api.example.com/v1/' }; }
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && isLoopback(base.hostname))) {
    return { error: '"api.baseUrl" must start with https:// (http:// only for localhost, while developing)' };
  }
  if (base.username || base.password) return { error: '"api.baseUrl" must not carry a user name or password — keys go in api.secret' };
  if (base.search || base.hash) return { error: '"api.baseUrl" must not have a query or a #fragment — pass those with each request' };
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const api = { baseUrl: base.href, origin: base.origin, host: base.host, header: 'Authorization', prefix: 'Bearer ' };
  if (raw.secret !== undefined && raw.secret !== null) {
    if (!isSecretName(raw.secret)) return { error: '"api.secret" must be the NAME of a key, like API_KEY: capitals, digits and _' };
    api.secret = raw.secret;
  }
  if (raw.header !== undefined && raw.header !== null) {
    if (typeof raw.header !== 'string' || !HEADER_NAME_RE.test(raw.header)) return { error: '"api.header" must be a header name, like Authorization or X-Api-Key' };
    const lower = raw.header.toLowerCase();
    if (lower === 'host' || lower === 'cookie' || lower.startsWith('proxy-') || (STRIPPED_HEADERS.has(lower) && lower !== 'authorization')) {
      return { error: `"api.header" can't be ${raw.header}` };
    }
    api.header = raw.header;
    api.prefix = lower === 'authorization' ? 'Bearer ' : '';
  }
  if (raw.prefix !== undefined && raw.prefix !== null) {
    if (typeof raw.prefix !== 'string' || raw.prefix.length > PREFIX_MAX || /[\u0000-\u001f\u007f]/.test(raw.prefix)) {
      return { error: `"api.prefix" must be text of at most ${PREFIX_MAX} characters, like "Bearer "` };
    }
    api.prefix = raw.prefix;
  }
  return { value: api };
}

/**
 * widget.json, read: `{ ok, manifest: { name, entry, size?, minSize?, api? } }` or `{ ok:
 * false, error }` naming the problem. Unknown fields are ignored.
 */
function parseManifest(raw) {
  const fail = error => ({ ok: false, error: `widget.json: ${error}` });
  if (!isObject(raw)) return fail('must be a JSON object, like { "name": "Weather" }');
  if (typeof raw.name !== 'string' || !oneLine(raw.name)) return fail('"name" is required: what the widget is called, 1–60 characters');
  const name = oneLine(raw.name);
  if (name.length > NAME_MAX) return fail(`"name" must be ${NAME_MAX} characters or fewer`);
  const manifest = { name };
  const entry = manifestEntry(raw.entry);
  if (entry.error) return fail(entry.error);
  manifest.entry = entry.value;
  if (raw.size !== undefined && raw.size !== null) {
    const size = manifestSize(raw.size, 'size');
    if (size.error) return fail(size.error);
    manifest.size = size.value;
  }
  if (raw.minSize !== undefined && raw.minSize !== null) {
    const least = manifestSize(raw.minSize, 'minSize');
    if (least.error) return fail(least.error);
    manifest.minSize = { width: Math.max(LEAST.width, least.value.width), height: Math.max(LEAST.height, least.value.height) };
  }
  if (raw.api !== undefined && raw.api !== null) {
    const api = manifestApi(raw.api);
    if (api.error) return fail(api.error);
    manifest.api = api.value;
  }
  return { ok: true, manifest };
}

/**
 * The widget `id`'s manifest, read from disk now: `{ ok, manifest, dir }`, or `{ ok:
 * false, error, code }` — code 'missing' (no such folder), 'manifest' (none, or one that
 * doesn't parse or validate) or 'id' (not a widget id).
 */
function readManifest(id) {
  if (!isWidgetId(id)) return { ok: false, code: 'id', error: 'A widget id is lowercase letters, digits and dashes, starting with a letter' };
  const dir = widgetDir(id);
  let st = null;
  try { st = fs.statSync(dir); } catch (_) { st = null; }
  if (!st || !st.isDirectory()) return { ok: false, code: 'missing', error: "This widget isn't installed" };
  const file = path.join(dir, MANIFEST_FILE);
  let text;
  try {
    const size = fs.statSync(file).size;
    if (size > MANIFEST_MAX_BYTES) return { ok: false, code: 'manifest', error: 'widget.json is too big to be a manifest' };
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, code: 'manifest', error: 'The widget has no widget.json' };
    return { ok: false, code: 'manifest', error: `Couldn't read widget.json: ${why(err)}` };
  }
  let raw;
  try { raw = JSON.parse(text); } catch (err) { return { ok: false, code: 'manifest', error: `widget.json isn't valid JSON: ${err.message}` }; }
  const parsed = parseManifest(raw);
  if (!parsed.ok) return { ok: false, code: 'manifest', error: parsed.error };
  return { ok: true, manifest: parsed.manifest, dir };
}

/** Every folder in widgets/ named like a widget, by id. A folder that isn't one is left out. */
function listIds() {
  let entries = [];
  try { entries = fs.readdirSync(widgetsDir(), { withFileTypes: true }); } catch (_) { return []; }
  return entries
    .filter(entry => isWidgetId(entry.name) && (entry.isDirectory() || entry.isSymbolicLink()))
    .map(entry => entry.name)
    .sort();
}

// ── the scheme ──────────────────────────────────────────────────────────────

function refusal(status, text) {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
  });
}

/**
 * What an sbwidget:// URL names, before anything is read: `{ id, sdk: true }` for the
 * app's SDK, `{ id, segments, ext }` for a file of the widget's, or null for anything that
 * may not be served — a host that isn't a widget id, a segment that is empty, "." or
 * "..", a dotfile, a NUL or a backslash or an encoded "/" in any segment, or an extension
 * MIME doesn't list. "/" alone is the manifest's entry page (`entry: true`).
 */
function parseWidgetUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch (_) { return null; }
  if (url.protocol !== 'sbwidget:' || !isWidgetId(url.hostname) || url.port || url.username || url.password) return null;
  const id = url.hostname;
  if (url.pathname === '/' || url.pathname === '') return { id, entry: true };
  const raw = url.pathname.replace(/^\//, '').split('/');
  let segments;
  try { segments = raw.map(segment => decodeURIComponent(segment)); } catch (_) { return null; }
  if (!cleanSegments(segments)) return null;
  if (segments[0] === RESERVED) return segments.length === 2 && segments[1] === 'widget.js' ? { id, sdk: true } : null;
  const ext = path.extname(segments[segments.length - 1]).slice(1).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(MIME, ext)) return null;
  return { id, segments, ext };
}

/**
 * The file a parsed URL names, on disk now: its real path, which must be inside the
 * widget's folder's real path — a symlink that leads out of it is refused — or null.
 */
async function servedFile(id, segments) {
  let root;
  try { root = await fs.promises.realpath(widgetDir(id)); } catch (_) { return null; }
  let real;
  try { real = await fs.promises.realpath(path.join(root, ...segments)); } catch (_) { return null; }
  if (!real.startsWith(root + path.sep)) return null;
  try {
    const st = await fs.promises.stat(real);
    if (!st.isFile() || st.size > SERVE_MAX_BYTES) return null;
  } catch (_) { return null; }
  return real;
}

function servedHeaders(ext) {
  return {
    'Content-Type': MIME[ext],
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': CSP,
  };
}

/**
 * protocol.handle('sbwidget', serve): a widget's own files, read-only, and the app's SDK
 * at __switchboard/widget.js. GET and HEAD only; anything that may not be served is a 404
 * that says no more than that. Never cached (an agent edits these files while the widget
 * is on screen) and never sniffed.
 */
async function serve(request) {
  const method = String((request && request.method) || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return refusal(405, 'not allowed');
  let parsed = parseWidgetUrl(request && request.url);
  if (parsed && parsed.entry) {
    const read = readManifest(parsed.id);
    parsed = read.ok ? parseWidgetUrl(`sbwidget://${parsed.id}/${read.manifest.entry}`) : null;
  }
  if (!parsed) return refusal(404, 'not found');
  let file;
  let ext;
  if (parsed.sdk) {
    file = SDK_FILE;
    ext = 'js';
  } else {
    file = await servedFile(parsed.id, parsed.segments);
    ext = parsed.ext;
  }
  if (!file) return refusal(404, 'not found');
  let bytes;
  try { bytes = await fs.promises.readFile(file); } catch (_) { return refusal(404, 'not found'); }
  return new Response(method === 'HEAD' ? null : bytes, { status: 200, headers: servedHeaders(ext) });
}

/** The widget a frame is showing now — its id, from sbwidget://<id>/… — or null. */
function widgetShown(frame) {
  try {
    const url = frame ? new URL(frame.url) : null;
    return url && url.protocol === 'sbwidget:' && isWidgetId(url.hostname) ? url.hostname : null;
  } catch (_) {
    return null;
  }
}

/**
 * What a navigation of one of the page's own iframes (`will-frame-navigate`, from the
 * webContents `wc`) means for widgets: 'allow' — a frame not showing a widget going to
 * one, or a widget's frame staying within its own id — 'external' — a link clicked in a
 * widget, which index.js sends to the user's browser — 'refuse' for anything else a
 * widget's frame tries (another widget, about:blank, a file), or null when no widget is
 * involved and the other guards decide. Only a direct child of the page: a widget may
 * frame nothing (frame-src 'none'). A frame torn down mid-question navigates nowhere.
 */
function frameNavigation(event, wc) {
  if (!event || event.isMainFrame) return null;
  let frame = null;
  try {
    frame = event.frame;
    if (!frame || !frame.parent || frame.parent !== wc.mainFrame) return null;
  } catch (_) {
    return null;
  }
  let target = null;
  try {
    const url = new URL(String(event.url));
    if (url.protocol === 'sbwidget:') target = isWidgetId(url.hostname) && !url.port && !url.username ? url.hostname : '';
  } catch (_) {
    target = null;
  }
  const showing = widgetShown(frame);
  if (showing) {
    if (target && target === showing) return 'allow';
    return /^https?:\/\//i.test(String(event.url)) ? 'external' : 'refuse';
  }
  if (target) return 'allow';
  if (target === '') return 'refuse';
  return null;
}

/**
 * Whether `frame` is the frame of `wc` that has the keyboard now — where a click or a key
 * press in it left it. Compared by process and routing id, which a frame keeps for its
 * life; a frame torn down mid-question has nothing.
 */
function frameHasKeyboard(wc, frame) {
  try {
    const focused = wc ? wc.focusedFrame : null;
    return !!focused && !!frame && focused.processId === frame.processId && focused.routingId === frame.routingId;
  } catch (_) {
    return false;
  }
}

function frameKey(frame) {
  try {
    return frame ? `${frame.processId}:${frame.routingId}` : '';
  } catch (_) {
    return '';
  }
}

/**
 * Which of the widgets' links out index.js sends to the user's browser: allow(frame,
 * withUser), for a navigation frameNavigation called 'external'. The sandbox doesn't stop a
 * page navigating itself, so that may be a link the user clicked or the page's own script
 * — a redirect as it loads, a timer — and Electron's navigation event says nothing of a
 * user gesture. `withUser` stands in for one: index.js passes whether the window has focus
 * and the widget's frame has the keyboard (frameHasKeyboard), which a page can't arrange
 * without the user's click or key press in it. One link a second at most, whoever asks
 * (every try counts, as the PDF's gate). A frame that tries without the user is never let
 * out again — until it is made anew (its files change, ⌥-Reload, the board opened again) —
 * so a loop can't wait for the user to come back and send them off to the browser again.
 * `now` is the clock.
 */
function linkGate(now = Date.now) {
  let last = -Infinity;
  const barred = new Set();
  return {
    allow(frame, withUser) {
      const at = now();
      const quiet = at - last >= LINK_QUIET_MS;
      last = at;
      const key = frameKey(frame);
      if (!key || barred.has(key)) return false;
      if (!withUser) {
        barred.add(key);
        if (barred.size > LINK_BARRED_MAX) barred.delete(barred.values().next().value);
        return false;
      }
      return quiet;
    },
  };
}

/**
 * The Edit menu's command (copy, cut, paste, selectAll, undo, redo), run natively on the
 * page `host` when the frame with the keyboard is a widget's: Chromium runs it in the
 * focused frame — the widget's own field or selection — so ⌘V pastes there as it would
 * in a browser. True when it ran; false when no widget has the keyboard, and the item is
 * the renderer's. (The menu's items are clicks, not roles, so without this the keystroke
 * never reached the widget at all, and the renderer can't reach into its frame.)
 */
function editInWidget(host, action) {
  if (!EDIT_ACTIONS.has(action)) return false;
  let frame = null;
  try {
    frame = host && !host.isDestroyed() ? host.focusedFrame : null;
  } catch (_) {
    frame = null;
  }
  if (!widgetShown(frame)) return false;
  try {
    host[action]();
  } catch (err) {
    console.error(`[switchboard] widgets: ${action} in a widget failed:`, why(err));
  }
  return true;
}

// ── keys on disk ────────────────────────────────────────────────────────────
//
// A key is kept for one API: the origin of the manifest's api.baseUrl when it was given
// (`origin` in its encrypted entry; the pending file's `origins`, beside `widgets` so the
// values keep the shape the CLI and the docs give them). The proxy sends it to that
// origin and no other — widget.json is the agent's to edit, and a key given for one API
// must not follow an edit of its base URL to another host, or to a listener on this
// machine. A widget pointed elsewhere asks for its key again.

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** `{ <id>: { <NAME>: entry } }` from a keys file's `field`, or {} — never a throw. */
function widgetsField(data, field) {
  if (!isObject(data) || !isObject(data[field])) return {};
  const out = {};
  for (const [id, names] of Object.entries(data[field])) {
    if (isWidgetId(id) && isObject(names)) out[id] = Object.assign({}, names);
  }
  return out;
}

/** Only the widgets that still have a name in them. */
function keptOnly(widgets) {
  const kept = {};
  for (const [id, names] of Object.entries(widgets)) {
    if (isObject(names) && Object.keys(names).length) kept[id] = names;
  }
  return kept;
}

function writeWidgetsFile(file, widgets, extra = {}) {
  writePrivate(file, JSON.stringify(Object.assign({ version: 1, widgets: keptOnly(widgets) }, extra), null, 2) + '\n');
}

function readSecrets() {
  return widgetsField(readJson(secretsFile()), 'widgets');
}

/** The pending file in one read: `{ widgets, origins }` — the keys waiting, and the API origin each was given for. */
function readPendingFile() {
  const data = readJson(pendingFile());
  return { widgets: widgetsField(data, 'widgets'), origins: widgetsField(data, 'origins') };
}

function readPending() {
  return readPendingFile().widgets;
}

/**
 * The pending file, written — each origin kept only while its key is — or removed once
 * nothing is waiting in it.
 */
function writePending(widgets, origins = {}) {
  const kept = keptOnly(widgets);
  if (!Object.keys(kept).length) {
    try { fs.unlinkSync(pendingFile()); } catch (err) { if (!err || err.code !== 'ENOENT') throw err; }
    return;
  }
  const bound = {};
  for (const [id, names] of Object.entries(kept)) {
    for (const name of Object.keys(names)) {
      const origin = origins[id] && origins[id][name];
      if (isOrigin(origin)) bound[id] = Object.assign(bound[id] || {}, { [name]: origin });
    }
  }
  writeWidgetsFile(pendingFile(), kept, { origins: bound });
}

/**
 * A key as the user gave it, checked: `{ ok, value }` — trimmed, since a paste often
 * brings a line break with it — or `{ ok:false, error }`. Never the value in a sentence.
 */
function cleanSecretValue(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'Paste the key first' };
  const value = raw.trim();
  if (!value) return { ok: false, error: 'Paste the key first' };
  if (value.length > SECRET_MAX) return { ok: false, error: `That key is longer than ${SECRET_MAX} characters` };
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return { ok: false, error: 'A key has no spaces or line breaks in it' };
  return { ok: true, value };
}

/**
 * The CLI's half: `value` kept for the widget `id` under `name` in the pending file, for
 * the app to encrypt, given for the API at `origin` (the manifest's api.origin the CLI
 * showed when it asked; without one, the app binds it to the widget's API when it first
 * sees it). Plain node, no safeStorage. `{ ok }` or `{ ok:false, error }`.
 */
function setPendingSecret(id, name, raw, origin) {
  if (!isWidgetId(id)) return { ok: false, error: `"${id}" isn't a widget id` };
  if (!isSecretName(name)) return { ok: false, error: `"${name}" isn't a key name: capitals, digits and _, like API_KEY` };
  if (origin !== undefined && origin !== null && !isOrigin(origin)) return { ok: false, error: 'That isn\'t the origin of an API, like https://api.example.com' };
  const clean = cleanSecretValue(raw);
  if (!clean.ok) return clean;
  try {
    const pending = readPendingFile();
    pending.widgets[id] = Object.assign({}, pending.widgets[id], { [name]: clean.value });
    pending.origins[id] = Object.assign({}, pending.origins[id]);
    if (origin) pending.origins[id][name] = origin;
    else delete pending.origins[id][name];
    writePending(pending.widgets, pending.origins);
  } catch (err) {
    return { ok: false, error: `Couldn't keep the key: ${why(err)}` };
  }
  return { ok: true };
}

/**
 * Forgets every key of widget `id`, kept or waiting, without decrypting anything — for
 * the CLI's remove, under plain node. `{ ok, forgot }` (how many) or `{ ok:false, error }`.
 */
function forgetSecrets(id) {
  if (!isWidgetId(id)) return { ok: false, error: `"${id}" isn't a widget id` };
  let forgot = 0;
  try {
    const secrets = readSecrets();
    if (secrets[id]) {
      forgot += Object.keys(secrets[id]).length;
      delete secrets[id];
      writeWidgetsFile(secretsFile(), secrets);
    }
    const pending = readPendingFile();
    if (pending.widgets[id]) {
      forgot += Object.keys(pending.widgets[id]).length;
      delete pending.widgets[id];
      writePending(pending.widgets, pending.origins);
    }
  } catch (err) {
    return { ok: false, error: `Couldn't forget the keys: ${why(err)}` };
  }
  return { ok: true, forgot };
}

/**
 * The key `name` of widget `id` as kept, without decrypting anything: `{ where, origin }`
 * — `where` 'pending' (waiting in the pending file — newer, if both) or 'stored' (in the
 * encrypted file), `origin` the API origin it was given for (null when nothing says) — or
 * null when there is none.
 */
function secretRecord(id, name) {
  const pending = readPendingFile();
  if (pending.widgets[id] && typeof pending.widgets[id][name] === 'string') {
    const origin = pending.origins[id] && pending.origins[id][name];
    return { where: 'pending', origin: isOrigin(origin) ? origin : null };
  }
  const stored = readSecrets()[id];
  const entry = stored && stored[name];
  if (isObject(entry) && typeof entry.enc === 'string') return { where: 'stored', origin: isOrigin(entry.origin) ? entry.origin : null };
  return null;
}

/**
 * Where the key `name` of widget `id` is, without decrypting anything: 'stored',
 * 'pending' or 'missing' — and, given `origin` (the manifest's API origin now),
 * 'elsewhere' for a key given for another API, which isn't sent. For the CLI, which
 * cannot decrypt, and for the state below.
 */
function secretWhere(id, name, origin) {
  const found = secretRecord(id, name);
  if (!found) return 'missing';
  if (origin !== undefined && found.origin !== origin) return 'elsewhere';
  return found.where;
}

// ── the proxy's pure parts ──────────────────────────────────────────────────

/**
 * Whether one piece of a decoded path segment is a way up for some server: "." or ".."
 * — or any run of dots, with spaces after (Windows servers trim trailing dots and spaces)
 * — once a ";parameter" is cut off it (Tomcat, Jetty and Spring drop those, so "..;" is
 * ".." to them).
 */
function isDotPiece(piece) {
  return /^\.+[.\s]*$/.test(piece.split(';')[0]);
}

/**
 * A request's URL: `path` read against the manifest's base URL, with `query` added —
 * `{ ok, url }` — or `{ ok:false, error }`. A leading "/" is dropped, so "/forecast" and
 * "forecast" both mean the base's forecast. Refused: anything that lands on another
 * origin, or outside the base's directory once resolved — and, since a server may decode
 * a path again, any segment past the base that holds a NUL or a way up (isDotPiece)
 * between the "/"s and backslashes it decodes to, however many times it was encoded. An
 * encoded "/" that leads nowhere up is let be (GitLab's "group%2Fproject"), and so are the
 * base's own segments: the manifest chose those.
 */
function requestUrl(api, rawPath, query) {
  if (!api || typeof api.baseUrl !== 'string') return { ok: false, error: 'This widget has no api.baseUrl to fetch from' };
  if (rawPath === undefined || rawPath === null) rawPath = '';
  if (typeof rawPath !== 'string') return { ok: false, error: 'A request\'s path must be text' };
  if (rawPath.length > FETCH_PATH_MAX) return { ok: false, error: `A request's path must be ${FETCH_PATH_MAX} characters or fewer` };
  if (/[\u0000-\u001f\u007f\\]/.test(rawPath)) return { ok: false, error: 'A request\'s path has no backslashes or control characters in it' };
  const base = new URL(api.baseUrl);
  let url;
  try { url = new URL(rawPath.replace(/^\/+/, ''), base); } catch (_) { return { ok: false, error: 'That path isn\'t one a URL can have' }; }
  const outside = { ok: false, error: `That path leads outside ${base.host}${base.pathname}, the only place this widget may fetch from` };
  if (url.origin !== base.origin || url.username || url.password) return outside;
  if (!url.pathname.startsWith(base.pathname)) return outside;
  for (const segment of url.pathname.slice(base.pathname.length).split('/')) {
    let form = segment;
    for (let round = 0; round <= 3; round++) {
      if (form.includes('\u0000') || form.split(/[\/\\]/).some(isDotPiece)) return outside;
      if (round === 3) break;
      let next;
      try { next = decodeURIComponent(form); } catch (_) { return { ok: false, error: 'That path has a broken %-escape in it' }; }
      if (next === form) break;
      form = next;
    }
  }
  url.hash = '';
  if (query !== undefined && query !== null) {
    if (!isObject(query)) return { ok: false, error: '"query" must be an object of names and values' };
    for (const [key, value] of Object.entries(query)) {
      const values = Array.isArray(value) ? value : [value];
      for (const one of values) {
        if (one === undefined || one === null) continue;
        if (typeof one !== 'string' && typeof one !== 'number' && typeof one !== 'boolean') {
          return { ok: false, error: `Query value "${key}" must be text, a number or true/false` };
        }
        url.searchParams.append(key, String(one));
      }
    }
  }
  return { ok: true, url };
}

/**
 * The headers a request goes out with: the widget's own, checked, less every credential
 * and connection header and less the key's own header (whatever the widget put there),
 * and then the key, when the manifest names one and `secret` is it. `{ ok, headers }` or
 * `{ ok:false, error }`.
 */
function requestHeaders(raw, api, secret) {
  const headers = {};
  if (raw !== undefined && raw !== null) {
    if (!isObject(raw)) return { ok: false, error: '"headers" must be an object of names and values' };
    const entries = Object.entries(raw);
    if (entries.length > FETCH_MAX_HEADERS) return { ok: false, error: `A request may have at most ${FETCH_MAX_HEADERS} headers` };
    const keyHeader = api && api.header ? api.header.toLowerCase() : 'authorization';
    for (const [name, value] of entries) {
      if (!HEADER_NAME_RE.test(name)) return { ok: false, error: `"${String(name).slice(0, 40)}" isn't a header name` };
      if (typeof value !== 'string' && typeof value !== 'number') return { ok: false, error: `Header "${name}" must be text` };
      const text = String(value);
      if (text.length > HEADER_VALUE_MAX || /[\r\n\u0000]/.test(text)) return { ok: false, error: `Header "${name}" has a value no header can have` };
      const lower = name.toLowerCase();
      if (STRIPPED_HEADERS.has(lower) || lower.startsWith('proxy-') || lower === keyHeader) continue;
      headers[name] = text;
    }
  }
  if (api && api.secret && typeof secret === 'string' && secret) headers[api.header] = (api.prefix || '') + secret;
  return { ok: true, headers };
}

/** The answer's headers a widget is told, lowercased: ANSWER_HEADERS and x-ratelimit-*. */
function answerHeaders(headers) {
  const out = {};
  if (!headers || typeof headers.forEach !== 'function') return out;
  headers.forEach((value, name) => {
    const lower = String(name).toLowerCase();
    if (ANSWER_HEADERS.has(lower) || ANSWER_HEADER_PREFIXES.some(prefix => lower.startsWith(prefix))) out[lower] = String(value);
  });
  return out;
}

/** A request's body: text, or anything else sent as JSON. `{ ok, body, json }` or a refusal. */
function requestBody(method, raw) {
  if (raw === undefined || raw === null) return { ok: true, body: undefined, json: false };
  if (method === 'GET' || method === 'HEAD') return { ok: false, error: `A ${method} request has no body` };
  let body;
  let json = false;
  if (typeof raw === 'string') body = raw;
  else {
    try { body = JSON.stringify(raw); } catch (_) { return { ok: false, error: 'That body can\'t be sent as JSON' }; }
    if (body === undefined) return { ok: false, error: 'That body can\'t be sent as JSON' };
    json = true;
  }
  if (Buffer.byteLength(body, 'utf8') > FETCH_BODY_MAX_BYTES) return { ok: false, error: 'A request\'s body must be 1 MB or less' };
  return { ok: true, body, json };
}

/** A failed request, as a sentence that names the host and never the URL. */
function reachError(err, host) {
  const code = (err && err.cause && err.cause.code) || (err && err.code) || '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Couldn't find ${host} — check the address, or the connection`;
  if (code === 'ECONNREFUSED') return `${host} refused the connection`;
  if (/CERT|SSL|TLS/i.test(String(code))) return `${host}'s certificate couldn't be trusted`;
  return `Couldn't reach ${host}`;
}

// ── the host: what needs safeStorage ────────────────────────────────────────

/**
 * Main's widgets, with what plain node hasn't got handed in: `safeStorage` (Electron's),
 * and for a test `fetch` (Node's global fetch by default — never Electron's net.fetch,
 * which would carry the app session's cookies), `timeoutMs` and `maxBytes`.
 *
 * Answers: list(), state(id), setSecret(id, value), clearSecret(id), importPending(),
 * fetch(req), watch(), onChange(fn), folder(id). Each resolves to a value; none throws.
 */
function createWidgetHost(opts = {}) {
  const safeStorage = opts.safeStorage || null;
  const fetchFn = opts.fetch || ((...args) => globalThis.fetch(...args));
  const timeoutMs = opts.timeoutMs || FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes || FETCH_MAX_BYTES;
  const inflight = new Map();
  const listeners = new Set();
  // What each widget's keys looked like when last told of (prints), so watch() says
  // nothing of a write this process made and has already told of.
  const prints = new Map();
  let watching = null;

  function encrypting() {
    try { return !!safeStorage && safeStorage.isEncryptionAvailable(); } catch (_) { return false; }
  }

  function emit(change) {
    for (const fn of listeners) {
      try { fn(change); } catch (err) { console.error('[switchboard] widgets: a change listener failed:', err); }
    }
  }

  function onChange(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /** What `id`'s keys are now, as a string that changes whenever any of them does. */
  function printOf(id, secrets, pending) {
    const stored = secrets[id] || {};
    const waiting = pending[id] || {};
    return JSON.stringify([
      Object.keys(stored).sort().map(name => [name, isObject(stored[name]) ? stored[name].savedAt || '' : '']),
      Object.keys(waiting).sort(),
    ]);
  }

  /** Tells of every widget whose keys changed since last told (or just `only`). */
  function noteSecrets(only) {
    const secrets = readSecrets();
    const pending = readPending();
    const ids = only ? [only] : Array.from(new Set([...Object.keys(secrets), ...Object.keys(pending), ...prints.keys()]));
    for (const id of ids) {
      const print = printOf(id, secrets, pending);
      if (prints.get(id) === print) continue;
      prints.set(id, print);
      emit({ id, reason: 'secret' });
    }
  }

  /** A key's encrypted entry, kept for the API at `origin` (null: none, so it is never sent). */
  function keptEntry(value, origin) {
    const entry = {
      enc: safeStorage.encryptString(value).toString('base64'),
      last4: value.length >= 8 ? value.slice(-4) : '',
      savedAt: new Date().toISOString(),
    };
    if (isOrigin(origin)) entry.origin = origin;
    return entry;
  }

  /**
   * A waiting key that says nothing of the API it was given for — the CLI always says,
   * so one written by hand — is bound to the API its widget's manifest names now, once,
   * so it never follows a later edit of widget.json elsewhere. One whose widget has no
   * readable API stays unbound, and is never sent.
   */
  function bindPending() {
    const pending = readPendingFile();
    let bound = 0;
    for (const [id, names] of Object.entries(pending.widgets)) {
      for (const name of Object.keys(names)) {
        if (isOrigin(pending.origins[id] && pending.origins[id][name])) continue;
        const read = readManifest(id);
        if (!read.ok || !read.manifest.api) continue;
        pending.origins[id] = Object.assign({}, pending.origins[id], { [name]: read.manifest.api.origin });
        bound++;
      }
    }
    if (bound) writePending(pending.widgets, pending.origins);
  }

  /**
   * Moves every key waiting in the pending file into the encrypted one, with the origin
   * it was given for, and out of the pending one — `{ ok, imported }` — or leaves them
   * where they are when this computer's keychain can't be reached (`waiting` says how
   * many). A key the pending file holds that isn't one (a bad name, an empty value) is
   * dropped from it.
   */
  function importPending() {
    try {
      if (!Object.keys(readPending()).length) return { ok: true, imported: 0 };
      bindPending();
      const pending = readPendingFile();
      const entries = [];
      for (const [id, names] of Object.entries(pending.widgets)) {
        for (const [name, value] of Object.entries(names)) entries.push([id, name, value]);
      }
      if (!entries.length) return { ok: true, imported: 0 };
      if (!encrypting()) return { ok: true, imported: 0, waiting: entries.length };
      const secrets = readSecrets();
      let imported = 0;
      for (const [id, name, value] of entries) {
        const clean = cleanSecretValue(value);
        if (!isSecretName(name) || !clean.ok) continue;
        const origin = pending.origins[id] && pending.origins[id][name];
        secrets[id] = Object.assign({}, secrets[id], { [name]: keptEntry(clean.value, origin) });
        imported++;
      }
      writeWidgetsFile(secretsFile(), secrets);
      // Read again before taking them out: the CLI may have written a newer key while
      // these were being encrypted, and that one stays for the next look.
      const now = readPendingFile();
      for (const [id, name, value] of entries) {
        if (now.widgets[id] && now.widgets[id][name] === value) delete now.widgets[id][name];
        if (now.widgets[id] && !Object.keys(now.widgets[id]).length) delete now.widgets[id];
      }
      writePending(now.widgets, now.origins);
      return { ok: true, imported };
    } catch (err) {
      console.error('[switchboard] widgets: could not import pending keys:', why(err));
      return { ok: false, error: `Couldn't keep the waiting keys: ${why(err)}` };
    }
  }

  /**
   * The key `name` of widget `id`, decrypted — for a request to `origin`, here, and
   * nothing else: `{ value }`, or `{ value: null, elsewhere }` — `elsewhere` the origin a
   * kept key was given for when that isn't `origin` ('' when nothing says), null when no
   * key is kept at all. A key is never decrypted for another origin. A waiting one is
   * imported first; with no keychain the waiting value is read as it is.
   */
  function secretValue(id, name, origin) {
    importPending();
    let elsewhere = null;
    const stored = readSecrets()[id];
    const entry = stored && stored[name];
    if (isObject(entry) && typeof entry.enc === 'string' && encrypting()) {
      if (entry.origin !== origin) {
        elsewhere = isOrigin(entry.origin) ? entry.origin : '';
      } else {
        try {
          const value = safeStorage.decryptString(Buffer.from(entry.enc, 'base64'));
          if (value) return { value };
        } catch (err) {
          console.error(`[switchboard] widgets: could not decrypt ${id}'s ${name}:`, why(err));
        }
      }
    }
    const pending = readPendingFile();
    const raw = pending.widgets[id] && pending.widgets[id][name];
    if (typeof raw === 'string') {
      const bound = pending.origins[id] && pending.origins[id][name];
      if (bound === origin) {
        const clean = cleanSecretValue(raw);
        if (clean.ok) return { value: clean.value };
      } else if (elsewhere === null) {
        elsewhere = isOrigin(bound) ? bound : '';
      }
    }
    return { value: null, elsewhere };
  }

  /**
   * What the renderer may know of a widget's key for the API at `origin`: whether there is
   * one it will send, how it is kept, its last four — and `secretFor`, the host a kept key
   * was given for when it isn't this API ('' when nothing says), so the panel can say why
   * it asks again.
   */
  function secretInfo(id, name, origin) {
    const found = secretRecord(id, name);
    const here = !!found && found.origin === origin;
    const stored = readSecrets()[id];
    const entry = stored && stored[name];
    return {
      hasSecret: here,
      secretEncrypted: here && found.where === 'stored',
      secretLast4: here && found.where === 'stored' && isObject(entry) && typeof entry.last4 === 'string' && entry.last4 ? entry.last4 : null,
      secretFor: found && !here ? hostOf(found.origin) || '' : null,
    };
  }

  function stateOf(id) {
    const out = {
      id, name: id, entry: null, size: null, minSize: null, apiHost: null,
      secretName: null, hasSecret: false, secretEncrypted: false, secretLast4: null, secretFor: null,
      keychain: encrypting(), error: null, code: null,
    };
    const read = readManifest(id);
    if (!read.ok) return Object.assign(out, { error: read.error, code: read.code });
    const m = read.manifest;
    Object.assign(out, { name: m.name, entry: m.entry, size: m.size || null, minSize: m.minSize || null });
    if (m.api) {
      out.apiHost = m.api.host;
      if (m.api.secret) Object.assign(out, { secretName: m.api.secret }, secretInfo(id, m.api.secret, m.api.origin));
    }
    return out;
  }

  /**
   * One widget as a node's face needs it: `{ ok, data: { id, name, entry, size, minSize,
   * apiHost, secretName, hasSecret, secretEncrypted, secretLast4, secretFor, keychain,
   * error, code } }` — `error`/`code` set (and the rest blank) for a widget that isn't
   * installed ('missing') or whose widget.json is wrong ('manifest'). Never a key.
   */
  function state(id) {
    if (!isWidgetId(id)) return { ok: false, error: 'A widget id is lowercase letters, digits and dashes, starting with a letter' };
    importPending();
    return { ok: true, data: stateOf(id) };
  }

  /** Every installed widget's state, by name. */
  function list() {
    importPending();
    const data = listIds().map(stateOf);
    data.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id));
    return { ok: true, data };
  }

  /**
   * The key the widget's manifest names, set from the face's "Needs a key" panel: checked,
   * then encrypted into the keys file (or, with no keychain, kept in the pending file —
   * the state then says it isn't encrypted), for the API the manifest names now and no
   * other. The value crosses IPC this once, renderer to main, and never back. Answers the
   * widget's state.
   */
  function setSecret(id, raw) {
    const read = readManifest(id);
    if (!read.ok) return { ok: false, error: read.error };
    const api = read.manifest.api;
    const name = api && api.secret;
    if (!name) return { ok: false, error: 'This widget\'s widget.json names no key (api.secret), so there is none to keep' };
    const clean = cleanSecretValue(raw);
    if (!clean.ok) return clean;
    try {
      const pending = readPendingFile();
      if (encrypting()) {
        const secrets = readSecrets();
        secrets[id] = Object.assign({}, secrets[id], { [name]: keptEntry(clean.value, api.origin) });
        writeWidgetsFile(secretsFile(), secrets);
        // An older key waiting for the same name would otherwise replace this one.
        if (pending.widgets[id] && name in pending.widgets[id]) {
          delete pending.widgets[id][name];
          writePending(pending.widgets, pending.origins);
        }
      } else {
        pending.widgets[id] = Object.assign({}, pending.widgets[id], { [name]: clean.value });
        pending.origins[id] = Object.assign({}, pending.origins[id], { [name]: api.origin });
        writePending(pending.widgets, pending.origins);
      }
    } catch (err) {
      return { ok: false, error: `Couldn't keep the key: ${why(err)}` };
    }
    noteSecrets(id);
    return state(id);
  }

  /** Forgets every key the widget has, kept or waiting. Answers its state. */
  function clearSecret(id) {
    if (!isWidgetId(id)) return { ok: false, error: 'A widget id is lowercase letters, digits and dashes, starting with a letter' };
    try {
      const secrets = readSecrets();
      if (secrets[id]) { delete secrets[id]; writeWidgetsFile(secretsFile(), secrets); }
      const pending = readPendingFile();
      if (pending.widgets[id]) { delete pending.widgets[id]; writePending(pending.widgets, pending.origins); }
    } catch (err) {
      return { ok: false, error: `Couldn't forget the key: ${why(err)}` };
    }
    noteSecrets(id);
    return state(id);
  }

  /** The widget's folder, for Open folder: `{ ok, data: path }`. */
  function folder(id) {
    const dir = widgetDir(id);
    if (!dir) return { ok: false, error: 'That isn\'t a widget id' };
    try {
      if (!fs.statSync(dir).isDirectory()) throw new Error('not a folder');
    } catch (_) {
      return { ok: false, error: "This widget isn't installed" };
    }
    return { ok: true, data: dir };
  }

  /**
   * A widget's request, made here: `req = { id, path, method?, headers?, query?, body? }`
   * → `{ ok, status, statusText, headers, body }` — any status, a 3xx as it came (no
   * redirect is followed) — or `{ ok:false, error, code? }`, code 'needs-secret' when the
   * manifest names a key and none is kept for the API it names now (one given for another
   * is never sent). The manifest is read again for every request, so an edit takes effect
   * at once. At most FETCH_MAX_INFLIGHT at a time per widget, 20 s each, 5 MB of answer.
   */
  async function proxyFetch(req) {
    const r = isObject(req) ? req : {};
    const id = r.id;
    const read = readManifest(id);
    if (!read.ok) return { ok: false, error: read.error, code: read.code };
    const api = read.manifest.api;
    if (!api) return { ok: false, error: 'This widget\'s widget.json has no "api" with a "baseUrl", so it can\'t fetch anything' };
    const method = String(r.method || 'GET').toUpperCase();
    if (!METHODS.has(method)) return { ok: false, error: `${String(r.method).slice(0, 20)} isn't a method a widget may use` };
    const built = requestUrl(api, r.path, r.query);
    if (!built.ok) return built;
    const body = requestBody(method, r.body);
    if (!body.ok) return body;
    let secret = null;
    if (api.secret) {
      const found = secretValue(id, api.secret, api.origin);
      secret = found.value;
      if (!secret) {
        const given = found.elsewhere === null ? null : hostOf(found.elsewhere) || 'another address';
        return {
          ok: false,
          code: 'needs-secret',
          error: given
            ? `This widget's ${api.secret} was given for ${given}, and widget.json now sends its requests to ${api.host} — give the key again to send it there: paste it into the widget, or run node scripts/widget.js set-secret ${id}`
            : `This widget needs its ${api.secret} for ${api.host} — paste it into the widget, or run node scripts/widget.js set-secret ${id}`,
        };
      }
    }
    const heads = requestHeaders(r.headers, api, secret);
    if (!heads.ok) return heads;
    if (body.json && !Object.keys(heads.headers).some(name => name.toLowerCase() === 'content-type')) {
      heads.headers['Content-Type'] = 'application/json';
    }
    const busy = inflight.get(id) || 0;
    if (busy >= FETCH_MAX_INFLIGHT) {
      return { ok: false, error: `This widget already has ${FETCH_MAX_INFLIGHT} requests on their way — wait for one to finish` };
    }
    inflight.set(id, busy + 1);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    // A read that never settles after an abort would hold this call forever, so every
    // read races the abort itself.
    const aborted = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    aborted.catch(() => {});
    try {
      const res = await Promise.race([fetchFn(built.url.href, {
        method,
        headers: heads.headers,
        body: body.body,
        redirect: 'manual',
        signal: controller.signal,
      }), aborted]);
      const declared = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
      if (Number.isFinite(declared) && declared > maxBytes) {
        controller.abort();
        return { ok: false, error: `${api.host}'s answer is over ${Math.round(maxBytes / 1024 / 1024)} MB` };
      }
      const chunks = [];
      let total = 0;
      if (res.body && method !== 'HEAD') {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await Promise.race([reader.read(), aborted]);
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            controller.abort();
            reader.cancel().catch(() => {});
            return { ok: false, error: `${api.host}'s answer is over ${Math.round(maxBytes / 1024 / 1024)} MB` };
          }
          chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        }
      }
      return {
        ok: true,
        status: res.status,
        statusText: String(res.statusText || ''),
        headers: answerHeaders(res.headers),
        body: Buffer.concat(chunks, total).toString('utf8'),
      };
    } catch (err) {
      if (timedOut) return { ok: false, error: `${api.host} took longer than ${Math.round(timeoutMs / 1000)} seconds to answer` };
      return { ok: false, error: reachError(err, api.host) };
    } finally {
      clearTimeout(timer);
      const left = (inflight.get(id) || 1) - 1;
      if (left > 0) inflight.set(id, left);
      else inflight.delete(id);
    }
  }

  /**
   * Watches widgets/ (recursively) and the keys files beside the config: a widget whose
   * files changed is told of as `{ id, reason: 'files' }` once its folder has been quiet
   * for WATCH_SETTLE_MS — what makes an agent's edit show on an open board at once — and
   * a key that came or went as `{ id, reason: 'secret' }`, after the pending file has been
   * imported. widgets/ is made if it isn't there yet. Watching only, apart from that and
   * the import; a second call hands back the first one's stop.
   */
  function watch() {
    if (watching) return watching.stop;
    const timers = new Map();
    const handles = [];
    let stopped = false;
    const soon = (key, job) => {
      clearTimeout(timers.get(key));
      timers.set(key, setTimeout(() => {
        timers.delete(key);
        if (!stopped) job();
      }, WATCH_SETTLE_MS));
    };
    const start = (dir, options, pick) => {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const handle = fs.watch(dir, options, (_event, name) => pick(name ? String(name) : ''));
        handle.on('error', err => console.error('[switchboard] widgets: stopped watching', dir + ':', why(err)));
        handles.push(handle);
      } catch (err) {
        console.error('[switchboard] widgets: cannot watch', dir + ':', why(err));
      }
    };
    start(widgetsDir(), { recursive: true }, name => {
      const id = name.split(/[\\/]/)[0];
      if (isWidgetId(id)) soon('files:' + id, () => emit({ id, reason: 'files' }));
    });
    start(configDir(), {}, name => {
      if (name === PENDING_NAME || name === SECRETS_NAME || !name) {
        soon('secrets', () => {
          importPending();
          noteSecrets();
        });
      }
    });
    // What the keys look like now is the baseline: only a change from here is news.
    importPending();
    const secrets = readSecrets();
    const pending = readPending();
    for (const id of new Set([...Object.keys(secrets), ...Object.keys(pending)])) prints.set(id, printOf(id, secrets, pending));
    const stop = () => {
      stopped = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const handle of handles) handle.close();
      if (watching && watching.stop === stop) watching = null;
    };
    watching = { stop };
    return stop;
  }

  return { list, state, setSecret, clearSecret, importPending, fetch: proxyFetch, watch, onChange, folder };
}

module.exports = {
  // pure
  isWidgetId,
  isSecretName,
  parseManifest,
  parseWidgetUrl,
  frameNavigation,
  frameHasKeyboard,
  linkGate,
  editInWidget,
  widgetShown,
  requestUrl,
  requestHeaders,
  answerHeaders,
  cleanSecretValue,
  // the store, under plain node
  readManifest,
  listIds,
  serve,
  setPendingSecret,
  forgetSecrets,
  secretWhere,
  secretRecord,
  readSecrets,
  readPending,
  // Electron's half
  createWidgetHost,
  // where things live, for the CLI, the tests and a sentence that names a folder
  widgetsDir,
  widgetDir,
  secretsFile,
  pendingFile,
  WIDGET_ID_RE,
  SECRET_NAME_RE,
  MIME,
  CSP,
  MANIFEST_FILE,
  RESERVED,
  SDK_FILE,
  FETCH_MAX_INFLIGHT,
};
