'use strict';

// npm run test:widgets — whiteboard widgets under plain node: src/main/widgets.js (ids
// and manifests; the sbwidget:// handler's containment, types and headers; the fetch
// proxy's URL allowlist, header stripping and key, with a stand-in fetch; the pending-key
// import with a stand-in safeStorage; the watcher), the editor's own widget shape, and
// scripts/widget.js run as a child process. Everything is rooted in a temporary
// SWITCHBOARD_CONFIG; every widget, board, host and key here is fictional.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, after } = require('node:test');
const esbuild = require('esbuild');

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-widgets-')));
const configFile = path.join(temp, 'config.json');
fs.writeFileSync(configFile, '{}\n');
// config.js reads SWITCHBOARD_CONFIG as it is required, so it goes first.
process.env.SWITCHBOARD_CONFIG = configFile;
const widgets = require('../src/main/widgets');
const whiteboards = require('../src/main/whiteboards');
after(() => fs.rmSync(temp, { recursive: true, force: true }));

// The editor's own validator, layout and canvas reader, bundled as test-flow-layout.js does.
function load(name) {
  const outfile = path.join(temp, 'lib', name + '.js');
  esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src/diagrams/lib/diagrams', name + '.ts')], outfile,
    bundle: true, format: 'cjs', platform: 'node', logLevel: 'error' });
  return require(outfile);
}
const { parseDiagramSpec } = load('validate');
const { layoutDiagram, flowNodeSize } = load('layout');
const { flowSpecFromCanvas } = load('flow-editor');
const { inspectFlowCondenseSelection } = load('condense');
const types = load('types');

const FAKE_KEY = 'fake-key-0000-1111';

/** A stand-in for Electron's safeStorage: reversible, and never the plain text on disk. */
function fakeSafeStorage(available = true) {
  return {
    available,
    isEncryptionAvailable() { return this.available; },
    encryptString(text) { return Buffer.from('enc:' + Buffer.from(text, 'utf8').toString('hex'), 'utf8'); },
    decryptString(buffer) {
      const text = buffer.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('not ours');
      return Buffer.from(text.slice(4), 'hex').toString('utf8');
    },
  };
}

function makeWidget(id, manifest, files = {}) {
  const dir = path.join(temp, 'widgets', id);
  fs.mkdirSync(dir, { recursive: true });
  if (manifest !== null) fs.writeFileSync(path.join(dir, 'widget.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

const get = (url, method = 'GET') => widgets.serve({ url, method });

// Windows keeps no POSIX mode bits (every file reads as 0o666), so "only its owner can
// read it" is checked where there are bits to check.
const POSIX = process.platform !== 'win32';
function assertPrivate(file) {
  assert.ok(fs.existsSync(file), file);
  if (POSIX) assert.equal(fs.statSync(file).mode & 0o777, 0o600, file);
}

/** A symlink — or false where the system won't make one (Windows without Developer Mode or an administrator). */
function trySymlink(target, file) {
  try {
    fs.symlinkSync(target, file);
    return true;
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') return false;
    throw err;
  }
}

// ── ids and manifests ──────────────────────────────────────────────────────

test('a widget id is lowercase letters, digits and dashes, starting with a letter, at most 63 long', () => {
  for (const id of ['weather', 'a', 'desk-clock-2', 'x'.repeat(63)]) assert.equal(widgets.isWidgetId(id), true, id);
  for (const id of ['', 'Weather', '2fa', '-x', 'a_b', 'a.b', 'a b', 'x'.repeat(64), '../x', 'a/b', null, 7]) {
    assert.equal(widgets.isWidgetId(id), false, String(id));
  }
  assert.equal(widgets.isSecretName('API_KEY'), true);
  for (const name of ['api_key', '_KEY', 'KEY-1', '', 'K'.repeat(65)]) assert.equal(widgets.isSecretName(name), false, name);
});

test('a manifest needs a name; its entry, sizes and api are checked and defaulted; unknown fields are ignored', () => {
  const ok = widgets.parseManifest({ name: '  Weather \n now ', extra: { anything: true } });
  assert.deepEqual(ok, { ok: true, manifest: { name: 'Weather now', entry: 'index.html' } });
  const full = widgets.parseManifest({
    name: 'Weather', entry: 'app/main.html', size: { width: 480.4, height: 300 }, minSize: { width: 50, height: 20 },
    api: { baseUrl: 'https://api.example.com/v1', secret: 'API_KEY' },
  });
  assert.equal(full.ok, true);
  assert.equal(full.manifest.entry, 'app/main.html');
  assert.deepEqual(full.manifest.size, { width: 480, height: 300 });
  // A least size never leaves less than the strip and a little of the page under it.
  assert.deepEqual(full.manifest.minSize, { width: 120, height: 70 });
  assert.deepEqual(full.manifest.api, {
    baseUrl: 'https://api.example.com/v1/', origin: 'https://api.example.com', host: 'api.example.com',
    header: 'Authorization', prefix: 'Bearer ', secret: 'API_KEY',
  });
  const custom = widgets.parseManifest({ name: 'W', api: { baseUrl: 'https://api.example.com/', secret: 'TOKEN', header: 'X-Api-Key' } });
  assert.equal(custom.manifest.api.header, 'X-Api-Key');
  assert.equal(custom.manifest.api.prefix, '');
  assert.equal(widgets.parseManifest({ name: 'W', api: { baseUrl: 'https://api.example.com/', header: 'X-Api-Key', prefix: 'Token ' } }).manifest.api.prefix, 'Token ');
  // http only to this Mac itself.
  for (const base of ['http://localhost:8080/api', 'http://127.0.0.1/', 'http://[::1]:3000/']) {
    assert.equal(widgets.parseManifest({ name: 'W', api: { baseUrl: base } }).ok, true, base);
  }
  const refused = [
    [{}, /"name" is required/],
    [{ name: 'x'.repeat(61) }, /60 characters or fewer/],
    [{ name: 'W', entry: '../outside.html' }, /inside the widget's folder/],
    [{ name: 'W', entry: '/abs.html' }, /inside the widget's folder/],
    [{ name: 'W', entry: '.hidden.html' }, /inside the widget's folder/],
    [{ name: 'W', entry: 'app.js' }, /\.html file/],
    [{ name: 'W', size: { width: 4001, height: 300 } }, /"size.width" must be a number from 16 to 4000/],
    [{ name: 'W', size: [480, 300] }, /"size" must be an object/],
    [{ name: 'W', api: { baseUrl: 'http://api.example.com/' } }, /must start with https:\/\//],
    [{ name: 'W', api: { baseUrl: 'ftp://api.example.com/' } }, /must start with https:\/\//],
    [{ name: 'W', api: { baseUrl: 'https://user:pass@api.example.com/' } }, /user name or password/],
    [{ name: 'W', api: { baseUrl: 'https://api.example.com/?token=1' } }, /query or a #fragment/],
    [{ name: 'W', api: { baseUrl: 'not a url' } }, /full URL/],
    [{ name: 'W', api: { baseUrl: 'https://api.example.com/', secret: 'api-key' } }, /"api.secret" must be the NAME/],
    [{ name: 'W', api: { baseUrl: 'https://api.example.com/', header: 'Host' } }, /"api.header" can't be Host/],
    [{ name: 'W', api: { baseUrl: 'https://api.example.com/', header: 'Bad Header' } }, /must be a header name/],
    [{ name: 'W', api: { baseUrl: 'https://api.example.com/', prefix: 'a\nb' } }, /"api.prefix"/],
    ['nope', /must be a JSON object/],
  ];
  for (const [raw, message] of refused) {
    const result = widgets.parseManifest(raw);
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.match(result.error, /^widget\.json: /);
    assert.match(result.error, message, JSON.stringify(raw));
  }
});

test('readManifest tells a widget that is not installed from one whose widget.json is wrong', () => {
  assert.deepEqual(widgets.readManifest('not-here'), { ok: false, code: 'missing', error: "This widget isn't installed" });
  makeWidget('no-manifest', null, { 'index.html': '<p>hi</p>' });
  assert.equal(widgets.readManifest('no-manifest').code, 'manifest');
  assert.match(widgets.readManifest('no-manifest').error, /has no widget\.json/);
  makeWidget('bad-json', '{ nope');
  assert.match(widgets.readManifest('bad-json').error, /isn't valid JSON/);
  makeWidget('bad-api', { name: 'Bad', api: { baseUrl: 'http://api.example.com/' } });
  assert.match(widgets.readManifest('bad-api').error, /https:\/\//);
  assert.equal(widgets.readManifest('Bad').code, 'id');
});

// ── the scheme ─────────────────────────────────────────────────────────────

const PAGE = '<!doctype html><title>Demo</title><script src="/__switchboard/widget.js"></script><p>Demo</p>';

test('the scheme serves a widget\'s own files, typed, never sniffed or cached, each with the CSP', async () => {
  makeWidget('demo', { name: 'Demo' }, {
    'index.html': PAGE, 'app.js': 'console.log(1)', 'styles.css': 'p{}', 'data.json': '{"a":1}', 'icon.svg': '<svg/>',
    'sub/page.htm': '<p>sub</p>', 'pic.png': 'PNG', 'font.woff2': 'W',
  });
  const res = await get('sbwidget://demo/index.html');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), PAGE);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const csp = res.headers.get('content-security-policy');
  assert.equal(csp, widgets.CSP);
  for (const part of ["default-src 'self'", "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'", "connect-src 'self'", "frame-src 'none'",
    "object-src 'none'", "form-action 'none'", "base-uri 'none'", 'https://fonts.googleapis.com', 'https://fonts.gstatic.com']) {
    assert.ok(csp.includes(part), part);
  }
  // "/" alone is the manifest's entry page.
  assert.equal(await (await get('sbwidget://demo/')).text(), PAGE);
  const types = {
    'app.js': 'text/javascript; charset=utf-8', 'styles.css': 'text/css; charset=utf-8', 'data.json': 'application/json; charset=utf-8',
    'icon.svg': 'image/svg+xml', 'sub/page.htm': 'text/html; charset=utf-8', 'pic.png': 'image/png', 'font.woff2': 'font/woff2',
  };
  for (const [file, type] of Object.entries(types)) {
    const one = await get(`sbwidget://demo/${file}`);
    assert.equal(one.status, 200, file);
    assert.equal(one.headers.get('content-type'), type, file);
  }
  const head = await get('sbwidget://demo/index.html', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await get('sbwidget://demo/index.html', 'POST')).status, 405);
});

test('the scheme refuses what may not be served: dotfiles, unknown types, escapes, symlinks out, bad hosts', async () => {
  const dir = makeWidget('vault', { name: 'Vault' }, {
    'index.html': PAGE, 'notes.md': '# notes', '.env': 'TOKEN=fictional', '.git/config': 'x', 'server.py': 'print(1)',
  });
  // Files beside the widget's folder, which nothing may reach.
  fs.writeFileSync(path.join(temp, 'widgets', 'secret.json'), '{"outside":true}');
  fs.writeFileSync(path.join(temp, 'outside.html'), '<p>outside</p>');
  const linked = [
    trySymlink(path.join(temp, 'outside.html'), path.join(dir, 'escape.html')),
    trySymlink(path.join(temp, 'widgets'), path.join(dir, 'up')),
    trySymlink(path.join(dir, 'index.html'), path.join(dir, 'alias.html')),
  ].every(Boolean);
  for (const url of [
    'sbwidget://vault/notes.md',
    'sbwidget://vault/server.py',
    'sbwidget://vault/.env',
    'sbwidget://vault/.git/config',
    'sbwidget://vault/..%2fsecret.json',
    'sbwidget://vault/%2e%2e/secret.json',
    'sbwidget://vault/%252e%252e/secret.json',
    'sbwidget://vault/sub%5c..%5c..%5csecret.json',
    'sbwidget://vault/index.html%00.png',
    'sbwidget://vault/a//index.html',
    'sbwidget://vault/escape.html',
    'sbwidget://vault/up/secret.json',
    'sbwidget://vault/missing.html',
    'sbwidget://-vault/index.html',
    'sbwidget://vault:8080/index.html',
    'sbwidget://nobody/index.html',
    'sbwidget://vault/__switchboard/other.js',
    'sbwidget://vault/__switchboard/',
    'https://vault/index.html',
    'not a url',
  ]) {
    const res = await get(url);
    assert.equal(res.status, 404, url);
    const text = await res.text();
    assert.ok(!text.includes('outside') && !text.includes('fictional'), url);
  }
  // A symlink that stays inside the folder is the file it points at.
  if (linked) assert.equal(await (await get('sbwidget://vault/alias.html')).text(), PAGE);
});

test('__switchboard/widget.js is the app\'s SDK, never a file of the widget\'s own', async () => {
  makeWidget('sdk-test', { name: 'SDK' }, { 'index.html': PAGE, '__switchboard/widget.js': 'window.fake = true' });
  const res = await get('sbwidget://sdk-test/__switchboard/widget.js');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
  const text = await res.text();
  assert.equal(text, fs.readFileSync(widgets.SDK_FILE, 'utf8'));
  assert.match(text, /window\.Switchboard/);
});

test('a widget\'s frame loads its widget and keeps to it; a link out goes to the browser; other frames are not its business', () => {
  const main = { name: 'main' };
  const wc = { mainFrame: main };
  const frame = (url, parent = main) => ({ url, parent });
  const verdict = (from, to, opts = {}) => widgets.frameNavigation({ url: to, frame: frame(from, opts.parent), isMainFrame: false }, wc);
  // A new frame (nothing in it yet) may load a widget; not a malformed one.
  assert.equal(verdict('', 'sbwidget://weather/index.html?theme=dark'), 'allow');
  assert.equal(verdict('about:blank', 'sbwidget://weather/index.html'), 'allow');
  assert.equal(verdict('', 'sbwidget://Bad_Id/index.html'), 'refuse');
  // A widget's frame stays within its own id.
  assert.equal(verdict('sbwidget://weather/index.html', 'sbwidget://weather/other.html'), 'allow');
  assert.equal(verdict('sbwidget://weather/index.html', 'sbwidget://desk-clock/index.html'), 'refuse');
  assert.equal(verdict('sbwidget://weather/index.html', 'about:blank'), 'refuse');
  assert.equal(verdict('sbwidget://weather/index.html', 'file:///etc/hosts'), 'refuse');
  assert.equal(verdict('sbwidget://weather/index.html', 'https://www.example.com/'), 'external');
  assert.equal(verdict('sbwidget://weather/index.html', 'http://example.com/'), 'external');
  // Anything else is for the other guards: the page's own players and PDFs, deeper frames.
  assert.equal(verdict('', 'https://www.youtube-nocookie.com/embed/x'), null);
  assert.equal(verdict('sbwidget://weather/index.html', 'https://elsewhere.example/', { parent: { name: 'deeper' } }), null);
  assert.equal(widgets.frameNavigation({ url: 'sbwidget://weather/', isMainFrame: true, frame: main }, wc), null);
  // A frame torn down mid-question is let be.
  const gone = { get parent() { throw new Error('gone'); }, url: 'sbwidget://weather/' };
  assert.equal(widgets.frameNavigation({ url: 'https://x.example/', frame: gone, isMainFrame: false }, wc), null);
});

test('a widget\'s link goes out only with the user, one a second, and a frame that tried without them stays in', () => {
  let clock = 10_000;
  const gate = widgets.linkGate(() => clock);
  const frame = (processId, routingId) => ({ processId, routingId });
  const clicked = frame(4, 1);
  const looping = frame(4, 2);
  // A link the user followed goes; another within the second doesn't, from any frame.
  assert.equal(gate.allow(clicked, true), true);
  clock += 400;
  assert.equal(gate.allow(frame(5, 1), true), false);
  clock += 1000;
  assert.equal(gate.allow(clicked, true), true);
  // A page navigating itself (a redirect as it loads, a timer) opens nothing, and that
  // frame is never let out again — not even once it has the user.
  clock += 5000;
  assert.equal(gate.allow(looping, false), false);
  clock += 5000;
  assert.equal(gate.allow(looping, true), false);
  // Its neighbour, which never tried alone, still may.
  clock += 5000;
  assert.equal(gate.allow(clicked, true), true);
  // A frame that can't say who it is goes nowhere.
  clock += 5000;
  assert.equal(gate.allow(null, true), false);
  assert.equal(gate.allow({ get processId() { throw new Error('gone'); } }, true), false);

  // The keyboard: the frame Chromium says is focused, by process and routing id.
  const wc = { focusedFrame: frame(4, 1) };
  assert.equal(widgets.frameHasKeyboard(wc, frame(4, 1)), true);
  assert.equal(widgets.frameHasKeyboard(wc, frame(4, 2)), false);
  assert.equal(widgets.frameHasKeyboard({ focusedFrame: null }, frame(4, 1)), false);
  assert.equal(widgets.frameHasKeyboard({ get focusedFrame() { throw new Error('gone'); } }, frame(4, 1)), false);
});

test('the Edit menu runs natively in a widget\'s frame when it has the keyboard, and leaves everything else to the renderer', () => {
  const ran = [];
  const host = url => ({
    focusedFrame: url === null ? null : { url },
    isDestroyed: () => false,
    paste: () => ran.push('paste'),
    selectAll: () => ran.push('selectAll'),
    copy: () => { throw new Error('the frame went'); },
  });
  assert.equal(widgets.editInWidget(host('sbwidget://notes/index.html'), 'paste'), true);
  assert.equal(widgets.editInWidget(host('sbwidget://notes/index.html'), 'selectAll'), true);
  assert.deepEqual(ran, ['paste', 'selectAll']);
  // A command that fails in the frame is still the widget's: nothing falls back onto the canvas.
  assert.equal(widgets.editInWidget(host('sbwidget://notes/index.html'), 'copy'), true);
  for (const url of ['file:///app/index.html', 'https://www.youtube-nocookie.com/embed/x', null]) {
    assert.equal(widgets.editInWidget(host(url), 'paste'), false, String(url));
  }
  assert.equal(widgets.editInWidget(host('sbwidget://notes/index.html'), 'close'), false, 'only the editing commands');
  assert.equal(widgets.editInWidget({ isDestroyed: () => true }, 'paste'), false);
  assert.equal(ran.length, 2);
});

// ── the proxy's URL and headers ────────────────────────────────────────────

const API = widgets.parseManifest({ name: 'W', api: { baseUrl: 'https://api.example.com/v1/', secret: 'API_KEY' } }).manifest.api;

test('a request\'s URL is the path read against the base, and nothing outside the base\'s directory', () => {
  const url = (p, q) => {
    const r = widgets.requestUrl(API, p, q);
    return r.ok ? r.url.href : r;
  };
  assert.equal(url('forecast'), 'https://api.example.com/v1/forecast');
  assert.equal(url('/forecast'), 'https://api.example.com/v1/forecast');
  assert.equal(url(''), 'https://api.example.com/v1/');
  assert.equal(url('forecast?days=3#x'), 'https://api.example.com/v1/forecast?days=3');
  assert.equal(url('forecast', { city: 'Example City', days: 3, metric: true, skip: null, tag: ['a', 'b'] }),
    'https://api.example.com/v1/forecast?city=Example+City&days=3&metric=true&tag=a&tag=b');
  assert.equal(url('a/./b/../c'), 'https://api.example.com/v1/a/c');
  // A leading "//" is not another host: it is a path under the base.
  assert.equal(url('//evil.example/x'), 'https://api.example.com/v1/evil.example/x');
  for (const escape of ['../admin', '%2e%2e/admin', '.%2e/admin', 'a/../../admin', 'a/..%2fadmin', 'a/%2e%2e%2f..%2fadmin',
    '%252e%252e/admin', 'a/%25252e%25252e', 'https://evil.example/x', 'http://api.example.com/v1/x', 'https://api.example.com:444/v1/x',
    'https://user@api.example.com/v1/x', '../v10/x']) {
    const result = widgets.requestUrl(API, escape);
    assert.equal(result.ok, false, escape);
    assert.match(result.error, /outside api\.example\.com\/v1\//, escape);
  }
  // Path parameters: Tomcat, Jetty and Spring drop ";…", so "..;" is ".." to them; and a
  // run of dots, which a Windows server may trim to "..".
  for (const escape of ['..;/admin/users', '..%3b/admin', '..%3B/admin', 'a/..;x/b', '.;/x', '...', '..%20/admin', 'a/%252e%252e%253b/x']) {
    const result = widgets.requestUrl(API, escape);
    assert.equal(result.ok, false, escape);
    assert.match(result.error, /outside api\.example\.com\/v1\//, escape);
  }
  // An encoded "/" that leads nowhere up is a path's own (GitLab's URL-encoded project id),
  // and the base's own segments are the manifest's to choose.
  assert.equal(url('projects/group%2Fproject/issues'), 'https://api.example.com/v1/projects/group%2Fproject/issues');
  assert.equal(url('a;b/c.json'), 'https://api.example.com/v1/a;b/c.json');
  const gitlab = widgets.parseManifest({ name: 'W', api: { baseUrl: 'https://gitlab.example.com/api/v4/projects/group%2Fproject/' } }).manifest.api;
  assert.equal(widgets.requestUrl(gitlab, 'issues').url.href, 'https://gitlab.example.com/api/v4/projects/group%2Fproject/issues');
  assert.equal(widgets.requestUrl(gitlab, '../other').ok, false);
  assert.equal(widgets.requestUrl(gitlab, 'x%2F..%2F..%2Fother').ok, false);
  assert.match(widgets.requestUrl(API, 'a\\b').error, /backslashes/);
  assert.match(widgets.requestUrl(API, 'a\nb').error, /control characters/);
  assert.match(widgets.requestUrl(API, 'a%zzb').error, /broken %-escape/);
  assert.match(widgets.requestUrl(API, 'x', 'q=1').error, /"query" must be an object/);
  assert.match(widgets.requestUrl(API, 'x', { a: { b: 1 } }).error, /Query value "a"/);
  const local = widgets.parseManifest({ name: 'W', api: { baseUrl: 'http://localhost:8080/api' } }).manifest.api;
  assert.equal(widgets.requestUrl(local, 'items').url.href, 'http://localhost:8080/api/items');
});

test('a request\'s headers lose every credential the widget set; the key goes in the manifest\'s header', () => {
  const sent = widgets.requestHeaders({
    Authorization: 'Bearer stolen', cookie: 'session=1', Host: 'evil.example', 'Proxy-Authorization': 'x',
    Connection: 'close', 'Content-Length': '9', 'X-Trace': '42', Accept: 'application/json',
  }, API, FAKE_KEY);
  assert.deepEqual(sent, { ok: true, headers: { 'X-Trace': '42', Accept: 'application/json', Authorization: `Bearer ${FAKE_KEY}` } });
  const custom = widgets.parseManifest({ name: 'W', api: { baseUrl: 'https://api.example.com/', secret: 'TOKEN', header: 'X-Api-Key' } }).manifest.api;
  assert.deepEqual(widgets.requestHeaders({ 'x-api-key': 'mine', Authorization: 'Bearer x' }, custom, FAKE_KEY).headers, { 'X-Api-Key': FAKE_KEY });
  // No key named, none attached; and no key given, none attached.
  const keyless = widgets.parseManifest({ name: 'W', api: { baseUrl: 'https://api.example.com/' } }).manifest.api;
  assert.deepEqual(widgets.requestHeaders({ 'X-A': '1' }, keyless, FAKE_KEY).headers, { 'X-A': '1' });
  assert.match(widgets.requestHeaders({ 'Bad Name': '1' }, API).error, /isn't a header name/);
  assert.match(widgets.requestHeaders({ 'X-A': 'a\r\nInjected: 1' }, API).error, /no header can have/);
  assert.match(widgets.requestHeaders({ 'X-A': { no: 1 } }, API).error, /must be text/);
  assert.match(widgets.requestHeaders('x', API).error, /"headers" must be an object/);
});

// ── the proxy, end to end with a stand-in fetch ────────────────────────────

/** A fetch that records what it was asked, and answers with `answer(url, init)`. */
function recordingFetch(answer) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return answer ? answer(url, init) : new Response('{"temperature":21}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'set-cookie': 'a=b', 'x-ratelimit-remaining': '9', 'x-internal': 'no', etag: '"v1"' },
    });
  };
  fn.calls = calls;
  return fn;
}

test('the proxy asks for a key it has not got, then sends the kept one — and only the answer comes back', async () => {
  makeWidget('weather', { name: 'Weather', api: { baseUrl: 'https://api.example.com/v1/', secret: 'API_KEY' } }, { 'index.html': PAGE });
  const fetch = recordingFetch();
  const host = widgets.createWidgetHost({ safeStorage: fakeSafeStorage(), fetch });
  const before = await host.fetch({ id: 'weather', path: 'forecast' });
  assert.equal(before.ok, false);
  assert.equal(before.code, 'needs-secret');
  assert.match(before.error, /needs its API_KEY for api\.example\.com/);
  assert.equal(fetch.calls.length, 0);
  assert.equal(host.state('weather').data.hasSecret, false);

  assert.equal(host.setSecret('weather', '   ').ok, false);
  assert.match(host.setSecret('weather', 'two words').error, /no spaces/);
  assert.match(host.setSecret('weather', 'x'.repeat(4097)).error, /longer than 4096/);
  const saved = host.setSecret('weather', `  ${FAKE_KEY}\n`);
  assert.equal(saved.ok, true);
  assert.deepEqual(
    { has: saved.data.hasSecret, enc: saved.data.secretEncrypted, last4: saved.data.secretLast4, name: saved.data.secretName, host: saved.data.apiHost },
    { has: true, enc: true, last4: '1111', name: 'API_KEY', host: 'api.example.com' });
  assert.ok(!JSON.stringify(saved).includes(FAKE_KEY), 'the state never carries the key');
  const onDisk = fs.readFileSync(widgets.secretsFile(), 'utf8');
  assert.ok(!onDisk.includes(FAKE_KEY), 'the keys file holds no plain key');
  assertPrivate(widgets.secretsFile());
  assert.equal(fs.readdirSync(path.join(temp, 'widgets', 'weather')).some(name => /secret/i.test(name)), false, 'nothing lands in the widget folder');

  const answer = await host.fetch({
    id: 'weather', path: '/forecast', query: { city: 'Example City' },
    headers: { Authorization: 'Bearer stolen', Cookie: 'x=1', 'X-Trace': '7' },
  });
  assert.equal(fetch.calls.length, 1);
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'https://api.example.com/v1/forecast?city=Example+City');
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'manual');
  assert.deepEqual(init.headers, { 'X-Trace': '7', Authorization: `Bearer ${FAKE_KEY}` });
  assert.deepEqual(answer, {
    ok: true, status: 200, statusText: '',
    headers: { 'content-type': 'application/json', etag: '"v1"', 'x-ratelimit-remaining': '9' },
    body: '{"temperature":21}',
  });
  assert.ok(!JSON.stringify(answer).includes(FAKE_KEY));
});

test('the proxy refuses what its manifest does not allow, and reads the manifest afresh every time', async () => {
  const fetch = recordingFetch();
  const host = widgets.createWidgetHost({ safeStorage: fakeSafeStorage(), fetch });
  makeWidget('stocks', { name: 'Stocks', api: { baseUrl: 'https://api.example.com/v2/' } }, { 'index.html': PAGE });
  makeWidget('offline', { name: 'Offline' }, { 'index.html': PAGE });
  assert.match((await host.fetch({ id: 'offline', path: 'x' })).error, /has no "api"/);
  assert.match((await host.fetch({ id: 'stocks', path: '../v1/forecast' })).error, /outside/);
  assert.match((await host.fetch({ id: 'stocks', path: 'x', method: 'TRACE' })).error, /isn't a method/);
  assert.match((await host.fetch({ id: 'stocks', path: 'x', body: 'hi' })).error, /A GET request has no body/);
  assert.equal((await host.fetch({ id: 'ghost', path: 'x' })).code, 'missing');
  assert.equal((await host.fetch({ id: '../etc', path: 'x' })).code, 'id');
  assert.equal(fetch.calls.length, 0);

  const posted = await host.fetch({ id: 'stocks', path: 'orders', method: 'post', body: { symbol: 'EXMPL', qty: 1 } });
  assert.equal(posted.ok, true);
  assert.equal(fetch.calls[0].init.method, 'POST');
  assert.equal(fetch.calls[0].init.body, '{"symbol":"EXMPL","qty":1}');
  assert.equal(fetch.calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal('Authorization' in fetch.calls[0].init.headers, false, 'a widget with no key sends none');

  fs.writeFileSync(path.join(temp, 'widgets', 'stocks', 'widget.json'), JSON.stringify({ name: 'Stocks', api: { baseUrl: 'https://data.example.org/' } }));
  await host.fetch({ id: 'stocks', path: 'quotes' });
  assert.equal(fetch.calls[1].url, 'https://data.example.org/quotes');
});

test('the proxy hands back a redirect as it came, caps the answer, times out, and keeps 8 requests at a time', async () => {
  makeWidget('limits', { name: 'Limits', api: { baseUrl: 'https://api.example.com/' } }, { 'index.html': PAGE });
  const redirect = recordingFetch(() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/', 'retry-after': '5' } }));
  const moved = await widgets.createWidgetHost({ fetch: redirect }).fetch({ id: 'limits', path: 'x' });
  assert.deepEqual({ status: moved.status, headers: moved.headers }, { status: 302, headers: { 'retry-after': '5' } });
  assert.equal(redirect.calls.length, 1);

  const big = widgets.createWidgetHost({ fetch: recordingFetch(() => new Response('x'.repeat(64))), maxBytes: 16 });
  assert.match((await big.fetch({ id: 'limits', path: 'x' })).error, /answer is over/);

  const stalled = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const slow = widgets.createWidgetHost({ fetch: stalled, timeoutMs: 40 });
  assert.match((await slow.fetch({ id: 'limits', path: 'x' })).error, /took longer than/);

  const refused = widgets.createWidgetHost({ fetch: async () => { const err = new TypeError('fetch failed'); err.cause = { code: 'ECONNREFUSED' }; throw err; } });
  assert.equal((await refused.fetch({ id: 'limits', path: 'x' })).error, 'api.example.com refused the connection');

  const releases = [];
  const held = widgets.createWidgetHost({ fetch: () => new Promise(resolve => releases.push(() => resolve(new Response('ok')))) });
  const running = Array.from({ length: widgets.FETCH_MAX_INFLIGHT }, () => held.fetch({ id: 'limits', path: 'x' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.match((await held.fetch({ id: 'limits', path: 'x' })).error, /already has 8 requests/);
  releases.forEach(release => release());
  assert.ok((await Promise.all(running)).every(r => r.ok));
  const after = held.fetch({ id: 'limits', path: 'x' });
  await new Promise(resolve => setImmediate(resolve));
  releases.at(-1)();
  assert.equal((await after).ok, true, 'a finished request frees its place');
});

// ── keys: bound to their API ──────────────────────────────────────────────

test('a key goes only to the API it was given for: widget.json pointed elsewhere asks for it again', async () => {
  const dir = makeWidget('forecast', { name: 'Forecast', api: { baseUrl: 'https://api.weather-a.example/v1/', secret: 'API_KEY' } }, { 'index.html': PAGE });
  const fetch = recordingFetch();
  const host = widgets.createWidgetHost({ safeStorage: fakeSafeStorage(), fetch });
  assert.equal(host.setSecret('forecast', FAKE_KEY).ok, true);
  await host.fetch({ id: 'forecast', path: 'today' });
  assert.equal(fetch.calls[0].url, 'https://api.weather-a.example/v1/today');
  assert.equal(fetch.calls[0].init.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(JSON.parse(fs.readFileSync(widgets.secretsFile(), 'utf8')).widgets.forecast.API_KEY.origin, 'https://api.weather-a.example');

  // An agent edits the base URL — to a listener on this machine, or another provider:
  // the key stays home, and the face is told why it asks again.
  for (const baseUrl of ['http://127.0.0.1:4040/', 'https://api.weather-b.example/v1/', 'https://api.weather-a.example:8443/v1/']) {
    fs.writeFileSync(path.join(dir, 'widget.json'), JSON.stringify({ name: 'Forecast', api: { baseUrl, secret: 'API_KEY' } }));
    const refused = await host.fetch({ id: 'forecast', path: 'today' });
    assert.equal(refused.code, 'needs-secret', baseUrl);
    assert.match(refused.error, /was given for api\.weather-a\.example, and widget\.json now sends its requests to/, baseUrl);
    assert.ok(!refused.error.includes(FAKE_KEY));
    const state = host.state('forecast').data;
    assert.deepEqual({ has: state.hasSecret, last4: state.secretLast4, for: state.secretFor }, { has: false, last4: null, for: 'api.weather-a.example' }, baseUrl);
    assert.equal(widgets.secretWhere('forecast', 'API_KEY', new URL(baseUrl).origin), 'elsewhere');
  }
  assert.equal(fetch.calls.length, 1, 'the key never went anywhere else');
  // A different path on the same API is the same API.
  fs.writeFileSync(path.join(dir, 'widget.json'), JSON.stringify({ name: 'Forecast', api: { baseUrl: 'https://api.weather-a.example/v2/', secret: 'API_KEY' } }));
  assert.equal((await host.fetch({ id: 'forecast', path: 'today' })).ok, true);
  // Given again for the new API, it goes there.
  fs.writeFileSync(path.join(dir, 'widget.json'), JSON.stringify({ name: 'Forecast', api: { baseUrl: 'https://api.weather-b.example/v1/', secret: 'API_KEY' } }));
  assert.equal(host.setSecret('forecast', 'fake-key-for-b-2222').data.secretFor, null);
  await host.fetch({ id: 'forecast', path: 'today' });
  assert.equal(fetch.calls.at(-1).url, 'https://api.weather-b.example/v1/today');
  assert.equal(fetch.calls.at(-1).init.headers.Authorization, 'Bearer fake-key-for-b-2222');
  host.clearSecret('forecast');
});

test('a key the CLI left waiting keeps the API it was given for, encrypted or not; one written by hand is bound when first seen', async () => {
  const dir = makeWidget('tides', { name: 'Tides', api: { baseUrl: 'https://api.tides-a.example/', secret: 'TIDES_KEY' } }, { 'index.html': PAGE });
  const fetch = recordingFetch();
  // Given through the CLI for tides-a; widget.json then pointed at tides-b before the app looked.
  assert.match(widgets.setPendingSecret('tides', 'TIDES_KEY', 'x', 'not an origin').error, /isn't the origin of an API/);
  assert.equal(widgets.setPendingSecret('tides', 'TIDES_KEY', 'pending-tides-key-1', 'https://api.tides-a.example').ok, true);
  assert.equal(JSON.parse(fs.readFileSync(widgets.pendingFile(), 'utf8')).origins.tides.TIDES_KEY, 'https://api.tides-a.example');
  fs.writeFileSync(path.join(dir, 'widget.json'), JSON.stringify({ name: 'Tides', api: { baseUrl: 'https://api.tides-b.example/', secret: 'TIDES_KEY' } }));
  // With no keychain, the waiting value is still only for tides-a.
  const plain = widgets.createWidgetHost({ safeStorage: fakeSafeStorage(false), fetch });
  assert.equal((await plain.fetch({ id: 'tides', path: 'now' })).code, 'needs-secret');
  // Imported, it keeps tides-a.
  const host = widgets.createWidgetHost({ safeStorage: fakeSafeStorage(), fetch });
  assert.equal(host.importPending().imported, 1);
  assert.equal(JSON.parse(fs.readFileSync(widgets.secretsFile(), 'utf8')).widgets.tides.TIDES_KEY.origin, 'https://api.tides-a.example');
  assert.equal((await host.fetch({ id: 'tides', path: 'now' })).code, 'needs-secret');
  assert.equal(fetch.calls.length, 0);
  host.clearSecret('tides');

  // A pending key with no origin (written by hand) is bound to the API the widget names
  // when the app first sees it, and then never follows an edit.
  fs.writeFileSync(widgets.pendingFile(), JSON.stringify({ version: 1, widgets: { tides: { TIDES_KEY: 'hand-written-key-3' } } }));
  assert.equal(host.state('tides').data.hasSecret, true);
  assert.equal(JSON.parse(fs.readFileSync(widgets.secretsFile(), 'utf8')).widgets.tides.TIDES_KEY.origin, 'https://api.tides-b.example');
  await host.fetch({ id: 'tides', path: 'now' });
  assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer hand-written-key-3');
  fs.writeFileSync(path.join(dir, 'widget.json'), JSON.stringify({ name: 'Tides', api: { baseUrl: 'https://api.tides-a.example/', secret: 'TIDES_KEY' } }));
  assert.equal((await host.fetch({ id: 'tides', path: 'now' })).code, 'needs-secret');
  // And an entry with nothing saying where it was given for is never sent.
  const secrets = JSON.parse(fs.readFileSync(widgets.secretsFile(), 'utf8'));
  delete secrets.widgets.tides.TIDES_KEY.origin;
  fs.writeFileSync(widgets.secretsFile(), JSON.stringify(secrets));
  const unbound = await host.fetch({ id: 'tides', path: 'now' });
  assert.equal(unbound.code, 'needs-secret');
  assert.match(unbound.error, /was given for another address/);
  assert.equal(host.state('tides').data.secretFor, '');
  assert.equal(fetch.calls.length, 1);
  host.clearSecret('tides');
});

// ── keys: pending, imported, unencrypted ──────────────────────────────────

test('a key the CLI left waiting is encrypted on the next look and taken out of the pending file', async () => {
  makeWidget('news', { name: 'News', api: { baseUrl: 'https://api.example.com/', secret: 'NEWS_TOKEN', header: 'X-Api-Key' } }, { 'index.html': PAGE });
  assert.match(widgets.setPendingSecret('news', 'NEWS_TOKEN', 'two words').error, /no spaces/);
  assert.match(widgets.setPendingSecret('news', 'bad-name', 'x').error, /isn't a key name/);
  assert.equal(widgets.setPendingSecret('news', 'NEWS_TOKEN', 'pending-key-abcd-5678\n').ok, true);
  assertPrivate(widgets.pendingFile());
  assert.equal(widgets.secretWhere('news', 'NEWS_TOKEN'), 'pending');

  const fetch = recordingFetch();
  const host = widgets.createWidgetHost({ safeStorage: fakeSafeStorage(), fetch });
  const state = host.state('news').data;
  assert.equal(state.hasSecret, true);
  assert.equal(state.secretEncrypted, true, 'looking at the state imported it');
  assert.equal(fs.existsSync(widgets.pendingFile()), false, 'nothing left waiting');
  assert.equal(widgets.secretWhere('news', 'NEWS_TOKEN'), 'stored');
  assert.ok(!fs.readFileSync(widgets.secretsFile(), 'utf8').includes('pending-key-abcd-5678'));
  await host.fetch({ id: 'news', path: 'top' });
  assert.equal(fetch.calls[0].init.headers['X-Api-Key'], 'pending-key-abcd-5678');

  assert.equal(host.clearSecret('news').data.hasSecret, false);
  assert.equal(widgets.secretWhere('news', 'NEWS_TOKEN'), 'missing');
  assert.equal((await host.fetch({ id: 'news', path: 'top' })).code, 'needs-secret');
});

test('with no keychain the waiting key is used as it is, and the state says it is not encrypted', async () => {
  makeWidget('rates', { name: 'Rates', api: { baseUrl: 'https://api.example.com/', secret: 'RATES_KEY' } }, { 'index.html': PAGE });
  const fetch = recordingFetch();
  const host = widgets.createWidgetHost({ safeStorage: fakeSafeStorage(false), fetch });
  const saved = host.setSecret('rates', 'fallback-key-9999');
  assert.equal(saved.ok, true);
  assert.deepEqual({ has: saved.data.hasSecret, enc: saved.data.secretEncrypted, keychain: saved.data.keychain }, { has: true, enc: false, keychain: false });
  assertPrivate(widgets.pendingFile());
  assert.deepEqual(host.importPending(), { ok: true, imported: 0, waiting: 1 });
  await host.fetch({ id: 'rates', path: 'today' });
  assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer fallback-key-9999');
  // Once the keychain is back, the next look encrypts it.
  const later = widgets.createWidgetHost({ safeStorage: fakeSafeStorage(true), fetch });
  assert.equal(later.state('rates').data.secretEncrypted, true);
  assert.equal(widgets.forgetSecrets('rates').forgot, 1);
});

test('watch() tells of a widget whose files changed, and of a key that came in, once each', async () => {
  makeWidget('watched', { name: 'Watched', api: { baseUrl: 'https://api.example.com/', secret: 'API_KEY' } }, { 'index.html': PAGE });
  const host = widgets.createWidgetHost({ safeStorage: fakeSafeStorage() });
  const heard = [];
  host.onChange(change => heard.push(change));
  const stop = host.watch();
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.writeFileSync(path.join(temp, 'widgets', 'watched', 'index.html'), PAGE + '<p>edited</p>');
    fs.writeFileSync(path.join(temp, 'widgets', 'watched', 'app.js'), '1');
    const until = async (predicate, what) => {
      for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(predicate(), what);
    };
    await until(() => heard.some(c => c.id === 'watched' && c.reason === 'files'), 'a files change');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(heard.filter(c => c.reason === 'files').length, 1, 'two saves in a row are one change');
    widgets.setPendingSecret('watched', 'API_KEY', 'watched-key-1234');
    await until(() => heard.some(c => c.id === 'watched' && c.reason === 'secret'), 'a key change');
    await until(() => widgets.secretWhere('watched', 'API_KEY') === 'stored', 'the key was imported');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(heard.filter(c => c.reason === 'secret').length, 1, 'the import itself is not news');
  } finally {
    stop();
  }
});

// ── the editor's widget shape ─────────────────────────────────────────────

test('a "widget" node needs its id, is labelled with its id by default, and is 480×300 unless sized', () => {
  const spec = parseDiagramSpec({ kind: 'flow', nodes: [{ id: 'w', shape: 'widget', widget: ' Weather ' }], edges: [] });
  assert.equal(spec.ok, true, spec.error);
  assert.deepEqual({ widget: spec.value.nodes[0].widget, label: spec.value.nodes[0].label }, { widget: 'weather', label: 'weather' });
  assert.deepEqual(flowNodeSize(spec.value.nodes[0]), types.FLOW_WIDGET_DEFAULT_SIZE);
  assert.deepEqual(types.FLOW_WIDGET_DEFAULT_SIZE, { width: 480, height: 300 });
  assert.deepEqual(types.FLOW_WIDGET_MIN_SIZE, { width: 200, height: 120 });
  const sized = parseDiagramSpec({ kind: 'flow', nodes: [{ id: 'w', shape: 'widget', widget: 'clock', label: 'Desk clock', size: { width: 320, height: 200 } }], edges: [] });
  assert.deepEqual(flowNodeSize(sized.value.nodes[0]), { width: 320, height: 200 });
  assert.equal(layoutDiagram(sized.value).nodes[0].data.widget, 'clock');
  assert.match(parseDiagramSpec({ kind: 'flow', nodes: [{ id: 'w', shape: 'widget' }], edges: [] }).error, /Node 1: a "widget" node needs "widget"/);
  assert.match(parseDiagramSpec({ kind: 'flow', nodes: [{ id: 'w', shape: 'widget', widget: '../etc' }], edges: [] }).error, /"widget" must be a widget id/);
  // Kept only on a widget.
  assert.equal(parseDiagramSpec({ kind: 'flow', nodes: [{ id: 'b', label: 'Box', widget: 'clock' }], edges: [] }).value.nodes[0].widget, undefined);
  // Read back off the canvas as it went on, and refused by Condense.
  const canvas = layoutDiagram(sized.value);
  const back = flowSpecFromCanvas({}, canvas.nodes, canvas.edges);
  assert.deepEqual({ shape: back.nodes[0].shape, widget: back.nodes[0].widget, size: back.nodes[0].size, label: back.nodes[0].label },
    { shape: 'widget', widget: 'clock', size: { width: 320, height: 200 }, label: 'Desk clock' });
  const pair = parseDiagramSpec({ kind: 'flow', nodes: [{ id: 'w', shape: 'widget', widget: 'clock' }, { id: 'q', label: 'Explain this' }], edges: [] }).value;
  assert.throws(() => inspectFlowCondenseSelection(pair, ['w', 'q']), /Leave widgets out of the selection/);
});

// ── the CLI ────────────────────────────────────────────────────────────────

test('scripts/widget.js makes, checks, keys, places and removes a widget', async () => {
  const cliTemp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-widget-cli-')));
  after(() => fs.rmSync(cliTemp, { recursive: true, force: true }));
  const cliConfig = path.join(cliTemp, 'config.json');
  fs.writeFileSync(cliConfig, '{}\n');
  const run = (args, input) => {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'widget.js'), ...args], {
      cwd: cliTemp, input: input ?? '', encoding: 'utf8', env: { ...process.env, SWITCHBOARD_CONFIG: cliConfig },
    });
    return { code: result.status, out: result.stdout, err: result.stderr };
  };
  const board = (args, input) => spawnSync(process.execPath, [path.join(__dirname, 'whiteboard.js'), ...args], {
    cwd: cliTemp, input, encoding: 'utf8', env: { ...process.env, SWITCHBOARD_CONFIG: cliConfig },
  });

  const made = run(['create', 'weather', '--name', 'Weather', '--api', 'https://api.example.com/v1', '--secret', 'API_KEY', '--width', '420', '--height', '260']);
  assert.equal(made.code, 0, made.err);
  assert.match(made.out, /Created "Weather" \(weather\)/);
  const dir = path.join(cliTemp, 'widgets', 'weather');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'widget.json'), 'utf8')),
    { name: 'Weather', entry: 'index.html', size: { width: 420, height: 260 }, api: { baseUrl: 'https://api.example.com/v1/', secret: 'API_KEY' } });
  const page = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(page, /<script src="\/__switchboard\/widget\.js"><\/script>/);
  assert.match(page, /Switchboard\.fetch\(/);
  assert.match(page, /\[data-theme="dark"\]/);
  assert.equal(run(['create', 'weather', '--name', 'Again']).code, 1, 'an existing id is refused');
  assert.match(run(['create', 'Bad_Id', '--name', 'X']).err, /isn't a widget id/);
  assert.match(run(['create', 'nameless']).err, /needs --name/);
  assert.match(run(['create', 'keyed', '--name', 'K', '--secret', 'API_KEY']).err, /give --api/);
  assert.match(run(['create', 'plain', '--name', 'P', '--api', 'http://api.example.com/']).err, /https:\/\//);
  assert.equal(fs.existsSync(path.join(cliTemp, 'widgets', 'plain')), false, 'a refused widget leaves no folder');
  assert.equal(run(['create', 'clock', '--name', 'Desk clock']).code, 0);
  assert.match(fs.readFileSync(path.join(cliTemp, 'widgets', 'clock', 'index.html'), 'utf8'), /toLocaleTimeString/);

  const checked = run(['check', 'weather']);
  assert.equal(checked.code, 0, checked.err);
  assert.match(checked.out, /Valid: "Weather" \(weather\), 2 files/);
  assert.match(checked.out, /Key: API_KEY, sent as Authorization: "Bearer …" — no key yet/);
  assert.match(checked.out, /Address: sbwidget:\/\/weather\/index\.html/);
  fs.writeFileSync(path.join(dir, 'notes.md'), '# notes');
  assert.match(run(['check', 'weather']).out, /notes\.md {3}\(not served/);
  assert.match(run(['check', 'nowhere']).err, /no widget called "nowhere"/);

  // The key comes in on stdin and is never echoed — nor taken as an argument.
  const key = 'cli-fake-key-4242';
  const kept = run(['set-secret', 'weather'], key + '\n');
  assert.equal(kept.code, 0, kept.err);
  assert.ok(!kept.out.includes(key) && !kept.err.includes(key));
  const pendingFile = path.join(cliTemp, 'widget-secrets.pending.json');
  assertPrivate(pendingFile);
  const pendingData = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  assert.equal(pendingData.widgets.weather.API_KEY, key);
  assert.equal(pendingData.origins.weather.API_KEY, 'https://api.example.com', 'kept for the API the CLI named when it asked');
  assert.match(kept.out, /to be sent to api\.example\.com only/);
  assert.match(run(['check', 'weather']).out, /key waiting for Switchboard to encrypt it/);
  // widget.json pointed at another API: the key stays for the one it was given for.
  const manifestFile = path.join(dir, 'widget.json');
  const manifestText = fs.readFileSync(manifestFile, 'utf8');
  fs.writeFileSync(manifestFile, JSON.stringify({ name: 'Weather', api: { baseUrl: 'https://api.other.example/', secret: 'API_KEY' } }));
  const moved = run(['check', 'weather']).out;
  assert.match(moved, /key kept for another API, so not sent/);
  assert.match(moved, /It was given for api\.example\.com; widget\.json now names api\.other\.example/);
  fs.writeFileSync(manifestFile, manifestText);
  const asArgument = run(['set-secret', 'weather', 'sk-not-a-name']);
  assert.equal(asArgument.code, 1);
  assert.ok(!asArgument.err.includes('sk-not-a-name'), 'an argument that may be a key is never echoed');
  assert.match(run(['set-secret', 'weather', 'OTHER_KEY'], 'x').err, /names its key API_KEY, not OTHER_KEY/);
  assert.match(run(['set-secret', 'weather'], '').err, /No key came in on stdin/);
  assert.match(run(['set-secret', 'clock'], 'x').err, /names no key/);

  const drawn = board(['create', '-', '--name', 'Example board'], JSON.stringify({
    kind: 'flow', nodes: [{ id: 'start', label: 'Start' }, { id: 'next', label: 'Next' }], edges: [{ from: 'start', to: 'next' }],
  }));
  assert.equal(drawn.status, 0, drawn.stderr);
  const boardId = /id ([0-9a-f-]{36})/.exec(drawn.stdout)[1];
  const added = run(['add', 'weather', '--board', 'Example board']);
  assert.equal(added.code, 0, added.err);
  assert.match(added.out, /Added "Weather" to "Example board" as widget-weather, 420×260 at 320, 40\./);
  const again = run(['add', 'weather', '--board', boardId, '--x', '0', '--y', '400', '--width', '100', '--height', '50']);
  assert.equal(again.code, 0, again.err);
  const file = JSON.parse(fs.readFileSync(path.join(cliTemp, 'whiteboards', 'boards', boardId + '.json'), 'utf8'));
  const ids = file.spec.nodes.map(node => node.id);
  assert.deepEqual(ids, ['start', 'next', 'widget-weather', 'widget-weather-2'], 'every node kept, ids unique');
  assert.ok(file.spec.nodes.every(node => node.position), 'a board never opened takes the places it is drawn at');
  const second = file.spec.nodes[3];
  assert.deepEqual({ shape: second.shape, widget: second.widget, label: second.label, position: second.position, size: second.size },
    { shape: 'widget', widget: 'weather', label: 'Weather', position: { x: 0, y: 400 }, size: { width: 200, height: 120 } },
    'a size under the least is raised to it');
  assert.match(run(['add', 'weather']).err, /--board/);
  assert.match(run(['add', 'weather', '--board', 'No such board']).err, /No whiteboard is called/);
  assert.match(run(['add', 'nowhere', '--board', boardId]).err, /no widget called/);

  const listed = JSON.parse(run(['list', '--json']).out);
  assert.deepEqual(listed.map(w => [w.id, w.boards, w.key]), [['clock', 0, null], ['weather', 1, 'pending']]);

  const refused = run(['remove', 'weather']);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /on "Example board"/);
  const removed = run(['remove', 'weather', '--yes']);
  assert.equal(removed.code, 0, removed.err);
  assert.match(removed.out, /its key is forgotten/);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.readdirSync(path.join(cliTemp, 'widgets', '.removed')).length, 1, 'moved aside, not deleted');
  assert.equal(fs.existsSync(pendingFile), false);
  assert.match(run(['remove', 'weather']).err, /no widget called/);
});
