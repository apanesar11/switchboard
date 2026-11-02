'use strict';

// npm run test:widgets:browser — whiteboard widgets in the production renderer: the real
// preload, index.html and built whiteboard bundle, with this file's own main process. Its
// IPC is stubbed except for the whiteboard store and the widgets (src/main/whiteboards.js
// and src/main/widgets.js, the REAL modules, rooted beside a temporary SWITCHBOARD_CONFIG),
// the sbwidget:// scheme (widgets.serve, registered as index.js registers it), the frame
// guard (widgets.frameNavigation, wrapped as index.js wraps it) and the permission handlers
// (videos.setupVideoEmbeds). Keys go through a stand-in safeStorage, so the Keychain is
// never asked. Every widget, board and key is fictional; the widgets' API is a local HTTP
// server; nothing reaches the network and nothing is opened in a browser.
//
// Covers: a board with a clock widget and a keyed one, each drawn inside its node in a
// sandboxed frame ("allow-scripts allow-same-origin", no referrer, no permissions); the
// origin Chromium reports for a widget's messages; the SDK's ready, theme and size; the
// keyed widget's "Needs a key" panel saving a key, after which its request reaches the
// local server through main with the Authorization header the manifest names — not the
// one the widget tried to set — and the frame never holds the key; a request outside the
// base URL refused; a direct fetch from the frame stopped by its CSP; Notification
// permission denied; the app's bridge absent from the frame; the key pasted with the Edit
// menu's ⌘V; the board's theme followed live; an edit to the widget's file reloading its
// frame live; a drag by its strip and a resize from its corner with native pointer input
// (the page told of its new size, the least size held); the frame in a process of its own,
// a scroll that starts over a scrollable widget scrolling it and one that began on the
// canvas panning on across it; WebAssembly compiling under the CSP; the Edit menu's
// commands run in a widget's field once a click gives its frame the keyboard
// (widgets.editInWidget); a widget's own navigation without the user opening nothing, and
// that frame kept in after, while a frame the user clicked into sends its link to the
// browser (widgets.linkGate); the frame kept on its widget; no popups; Reload; a page that
// never calls ready() following the board's theme; widget.json pointed at another API
// asking for the key again rather than sending it there; and no renderer errors along
// the way.
//
// SWITCHBOARD_WIDGET_CAPTURE=<dir> saves screenshots there (widgets-light.png,
// widgets-dark.png); SWITCHBOARD_WIDGET_DEBUG=1 prints each stage.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const repo = path.join(__dirname, '..');

if (!process.versions.electron) {
  const { execFileSync } = require('node:child_process');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-widgets-browser-'));
  require('./build-diagrams').build().then(() => {
    try {
      fs.writeFileSync(path.join(temp, 'config.json'), '{}\n');
      process.stdout.write(execFileSync(require('electron'), [__filename, temp], {
        encoding: 'utf8', timeout: 120_000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '', SWITCHBOARD_CONFIG: path.join(temp, 'config.json') },
      }));
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }).catch(error => {
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    console.error(error.message);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow, ipcMain, protocol, session } = require('electron');
  const temp = process.argv[2];
  app.setPath('userData', path.join(temp, 'profile'));
  app.commandLine.appendSwitch('disable-gpu');
  // As index.js registers it: before `ready`, in the one call Electron takes.
  protocol.registerSchemesAsPrivileged([
    { scheme: 'sbwidget', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
  const whiteboards = require('../src/main/whiteboards');
  const widgets = require('../src/main/widgets');
  const videos = require('../src/main/videos');
  const debug = process.env.SWITCHBOARD_WIDGET_DEBUG ? (...args) => console.log('[widgets-browser]', ...args) : () => {};

  const KEY = 'browser-fake-key-7788';
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: text => Buffer.from('enc:' + Buffer.from(text, 'utf8').toString('hex'), 'utf8'),
    decryptString: buffer => Buffer.from(buffer.toString('utf8').slice(4), 'hex').toString('utf8'),
  };
  const host = widgets.createWidgetHost({ safeStorage: fakeSafeStorage });

  let window;
  const send = (channel, payload) => {
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  };
  const handle = (name, callback) => ipcMain.handle('sb:' + name, (_event, ...args) => callback(...args));
  handle('ws:list', () => []);
  handle('pr:summary', () => ({}));
  handle('run:states', () => []);
  handle('publish:state', () => ({}));
  handle('ui:sidebar', () => ({ visible: true }));
  handle('ui:setSidebar', visible => ({ visible }));
  handle('term:appearance', () => ({ appearance: 'light', effective: 'light' }));
  handle('grid:list', () => ({ views: [] }));
  handle('usage:get', () => ({ ok: false, configured: false }));
  handle('answer:status', () => ({ ok: true, settings: {}, providers: [], keysSafe: {} }));
  handle('diagrams:dirty', () => ({ ok: true }));
  handle('diagrams:flushed', () => ({ ok: true }));
  handle('term:states', () => []);
  handle('wb:timers', () => ({ ok: true, data: [] }));
  for (const [name, method] of Object.entries({
    list: 'list', get: 'get', create: 'create', saveSpec: 'saveSpec', rename: 'rename', setWorkspace: 'setWorkspace',
    move: 'move', duplicate: 'duplicate', archive: 'setArchived', delete: 'remove', createFolder: 'createFolder',
    renameFolder: 'renameFolder', deleteFolder: 'removeFolder', dismissNotice: 'dismissNotice', noteWorkspace: 'noteWorkspace',
    workspaces: 'workspaceChoices', createDocument: 'createDocument', getDocument: 'getDocument', saveDocument: 'saveDocument', migrate: 'migrate',
  })) handle('wb:' + name, (...args) => whiteboards[method](...args));
  whiteboards.onChange(change => send('sb:evt:wbChanged', change));
  // The widgets' channels, as index.js wires them — Open folder recorded, never opened.
  const foldersOpened = [];
  handle('widgets:list', () => host.list());
  handle('widgets:state', id => host.state(id));
  handle('widgets:setSecret', (id, value) => host.setSecret(id, value));
  handle('widgets:clearSecret', id => host.clearSecret(id));
  handle('widgets:fetch', req => host.fetch(req));
  handle('widgets:openFolder', id => { const found = host.folder(id); if (found.ok) foldersOpened.push(found.data); return found.ok ? { ok: true } : found; });
  host.onChange(change => send('sb:evt:widgetsChanged', change));
  // What the window would have opened in the user's browser.
  const opened = [];

  // The widgets' API: what it was asked, with which headers.
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, method: req.method, headers: req.headers });
    if (req.url.startsWith('/v1/forecast')) {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'tracker=1', 'x-ratelimit-remaining': '41' });
      res.end(JSON.stringify({ summary: 'Sunny, 21°', city: new URL(req.url, 'http://x').searchParams.get('city') }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nothing here');
  });

  app.whenReady().then(async () => {
    // Never in the Dock, as a smoke run never is: nothing here is for anyone to look at.
    if (app.dock && typeof app.dock.hide === 'function') app.dock.hide();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    protocol.handle('sbwidget', widgets.serve);
    protocol.handle('https', () => new Response('No network in widget tests', { status: 404 }));
    videos.setupVideoEmbeds(session.defaultSession);

    // Two widgets: a clock with no API, and a weather card that needs a key.
    const CLOCK_PAGE = version => `<!doctype html>
<html><head><meta charset="utf-8"><title>Desk clock</title>
<script src="/__switchboard/widget.js"></script>
<style>
  :root { --bg: #ffffff; --fg: #111827; --muted: #6b7280; }
  [data-theme="dark"] { --bg: #111827; --fg: #f3f4f6; --muted: #9ca3af; }
  html, body { height: 100%; margin: 0; }
  body { display: grid; place-content: center; text-align: center; background: var(--bg); color: var(--fg); font: 600 34px -apple-system, sans-serif; container-type: size; }
  #time { font-size: clamp(20px, 22cqmin, 80px); font-variant-numeric: tabular-nums; }
  #marker { color: var(--muted); font-size: 13px; font-weight: 500; }
</style></head>
<body><div id="time">--:--</div><div id="marker">${version}</div><input id="note" aria-label="Note" value="Example note">
<script>
  WebAssembly.instantiate(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))
    .then(function () { window.__wasm = 'compiled'; }, function (e) { window.__wasm = 'refused: ' + e.message; });
  window.__hostOrigins = [];
  window.__themes = [];
  window.__sizes = [];
  addEventListener('message', function (e) { if (e.data && e.data.sb === 'host') window.__hostOrigins.push(e.origin); });
  function tick() { document.getElementById('time').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  tick(); setInterval(tick, 1000);
  Switchboard.onTheme(function (t) { window.__themes.push(t); });
  Switchboard.onResize(function (s) { window.__sizes.push(s); });
  Switchboard.ready().then(function (info) { window.__ready = info; });
  try { Notification.requestPermission().then(function (p) { window.__notify = p; }, function (e) { window.__notify = 'error'; }); } catch (e) { window.__notify = 'threw'; }
  fetch('http://127.0.0.1:${port}/v1/direct').then(function () { window.__direct = 'reached'; }, function () { window.__direct = 'blocked'; });
  try { localStorage.setItem('example', 'kept'); window.__storage = localStorage.getItem('example'); } catch (e) { window.__storage = 'error'; }
</script></body></html>`;
    const WEATHER_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Weather</title>
<script src="/__switchboard/widget.js"></script>
<style>
  html, body { height: 100%; margin: 0; }
  body { display: grid; place-content: center; text-align: center; font: 600 26px -apple-system, sans-serif; background: #eef2ff; color: #312e81; }
  [data-theme="dark"] body { background: #1e1b4b; color: #e0e7ff; }
  small { display: block; font-size: 12px; font-weight: 500; opacity: .7; }
</style></head>
<body><div id="out">Loading…</div><small id="city">Example City</small>
<script>
  Switchboard.ready()
    .then(function () { return Switchboard.fetch('forecast', { query: { city: 'Example City' }, headers: { Authorization: 'Bearer stolen-by-widget', 'X-Trace': 'abc' } }); })
    .then(function (res) {
      var data = res.json();
      window.__result = { ok: res.ok, status: res.status, headers: res.headers, data: data };
      document.getElementById('out').textContent = data.summary;
    })
    .catch(function (err) { window.__error = err.message + '|' + (err.code || ''); });
  Switchboard.fetch('../admin').then(function () { window.__escape = 'allowed'; }, function (err) { window.__escape = err.message; });
</script></body></html>`;
    fs.mkdirSync(path.join(widgets.widgetsDir(), 'desk-clock'), { recursive: true });
    fs.writeFileSync(path.join(widgets.widgetsDir(), 'desk-clock', 'widget.json'), JSON.stringify({ name: 'Desk clock', size: { width: 340, height: 220 } }));
    fs.writeFileSync(path.join(widgets.widgetsDir(), 'desk-clock', 'index.html'), CLOCK_PAGE('first version'));
    fs.mkdirSync(path.join(widgets.widgetsDir(), 'weather'), { recursive: true });
    fs.writeFileSync(path.join(widgets.widgetsDir(), 'weather', 'widget.json'), JSON.stringify({
      name: 'Weather', api: { baseUrl: `http://127.0.0.1:${port}/v1/`, secret: 'API_KEY' },
    }));
    fs.writeFileSync(path.join(widgets.widgetsDir(), 'weather', 'index.html'), WEATHER_PAGE);
    const stopWatching = host.watch();

    // A hidden window, as the SB_SMOKE harness's is — not an offscreen one: a widget's frame
    // runs in a process of its own, and an offscreen window routes no input to such a frame
    // (measured: a wheel never reached the page). Input that must reach a frame goes through
    // the DevTools protocol, which hit-tests as a real pointer does.
    window = new BrowserWindow({ show: false, width: 1280, height: 860,
      webPreferences: { preload: path.join(repo, 'src/preload.js'), backgroundThrottling: false } });
    window.webContents.debugger.attach('1.3');
    window.webContents.setWindowOpenHandler(details => { opened.push({ popup: details.url }); return { action: 'deny' }; });
    // index.js's guard, around the same verdict and the same gate. index.js also needs
    // the window focused; a hidden window never is, so here only the frame's keyboard
    // stands for the user.
    const links = widgets.linkGate();
    const keptIn = [];
    window.webContents.on('will-frame-navigate', event => {
      const verdict = widgets.frameNavigation(event, window.webContents);
      if (verdict === 'allow' || verdict === null) return;
      event.preventDefault();
      if (verdict !== 'external') return;
      if (links.allow(event.frame, widgets.frameHasKeyboard(window.webContents, event.frame))) opened.push({ link: event.url });
      else keptIn.push(event.url);
    });
    const errors = [];
    // While a node is resized by native pointer input, React Flow's own measuring logs
    // "ResizeObserver loop completed with undelivered notifications" — a plain box resized
    // from its corner in this same harness logs it too (measured 2026-11-01: 5 times for one
    // drag), so it is not a widget's; it is let pass during that stage alone.
    let nativeResize = false;
    window.webContents.on('console-message', (...args) => {
      const detail = args[0] && typeof args[0] === 'object' && 'message' in args[0] ? args[0] : { level: args[1], message: args[2] };
      if (detail.level !== 'error' && detail.level !== 3) return;
      const message = String(detail.message);
      // The clock tries a direct fetch and a popup on purpose; their being refused (the
      // CSP, the sandbox) is the point.
      if (message.includes('/v1/direct') || (message.includes('/popup') && message.includes('allow-popups'))) return;
      if (nativeResize && message.startsWith('ResizeObserver loop completed with undelivered notifications')) return;
      errors.push(message);
      debug('console error', message, detail.sourceId, (() => { try { return detail.frame && detail.frame.url; } catch (_) { return '?'; } })());
    });
    const q = JSON.stringify;
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const run = async code => {
      try { return await window.webContents.executeJavaScript(code, true); }
      catch (error) { throw new Error(error.message + '\nRenderer script: ' + code + '\n' + errors.join('\n')); }
    };
    const frames = () => run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const until = async (code, what = code) => {
      for (let attempt = 0; attempt < 320; attempt++) {
        if (await run(code)) return;
        await sleep(25);
      }
      throw new Error('Timed out: ' + what + '\n' + errors.join('\n'));
    };
    const frameOf = id => window.webContents.mainFrame.framesInSubtree.find(frame => {
      try { return frame.url.startsWith(`sbwidget://${id}/`); } catch (_) { return false; }
    });
    const inFrame = async (id, code) => {
      const frame = frameOf(id);
      if (!frame) throw new Error('no frame shows ' + id);
      return frame.executeJavaScript(code);
    };
    const untilFrame = async (id, code, what = code) => {
      for (let attempt = 0; attempt < 320; attempt++) {
        const frame = frameOf(id);
        if (frame) {
          try { if (await frame.executeJavaScript(code)) return; } catch (_) { /* mid-load */ }
        }
        await sleep(25);
      }
      throw new Error(`Timed out in ${id}'s frame: ${what}\n` + errors.join('\n'));
    };
    const capture = async name => {
      if (!process.env.SWITCHBOARD_WIDGET_CAPTURE) return;
      fs.mkdirSync(process.env.SWITCHBOARD_WIDGET_CAPTURE, { recursive: true });
      await frames();
      await sleep(250);
      const file = path.join(process.env.SWITCHBOARD_WIDGET_CAPTURE, name + '.png');
      fs.writeFileSync(file, (await window.webContents.capturePage()).toPNG());
      console.log('captured', file);
    };
    const face = id => `.flow-widget[data-widget="${id}"]`;

    let exitCode = 0;
    try {
      assert.equal((await whiteboards.migrate()).ok, true);
      const made = await whiteboards.create({ folderId: null, name: 'Example dashboard', workspace: null, spec: {
        kind: 'flow',
        nodes: [
          { id: 'clock', shape: 'widget', widget: 'desk-clock', label: 'Desk clock', position: { x: 60, y: 60 }, size: { width: 340, height: 220 } },
          { id: 'weather', shape: 'widget', widget: 'weather', label: 'Weather', position: { x: 460, y: 60 }, size: { width: 420, height: 260 } },
          { id: 'missing', shape: 'widget', widget: 'not-installed', position: { x: 60, y: 340 }, size: { width: 340, height: 180 } },
          { id: 'note', label: 'Morning dashboard', position: { x: 460, y: 380 } },
        ],
        edges: [],
      } });
      assert.equal(made.ok, true, made.error);
      const boardId = made.data.id;

      await window.loadFile(path.join(repo, 'src/renderer/index.html'));
      await until('SB.state.booted');
      // What Chromium reports as a widget's origin, heard from the page itself.
      await run(`window.__widgetOrigins = []; addEventListener('message', e => { if (e.data && e.data.sb === 'widget') window.__widgetOrigins.push(e.origin); }); true`);
      await run(`SB.go({ view: 'whiteboard', board: ${q(boardId)} })`);
      await until(`!!document.querySelector(${q('.dgslab[data-wb-board="' + boardId + '"] .react-flow__pane')})`);
      debug('board open');

      // The clock: drawn in its node, in a sandboxed frame.
      await until(`!!document.querySelector(${q(face('desk-clock') + ' iframe.flow-widget-frame')})`, 'the clock\'s frame');
      const attrs = await run(`(() => { const f = document.querySelector(${q(face('desk-clock') + ' iframe')}); return { sandbox: f.getAttribute('sandbox'), referrer: f.getAttribute('referrerpolicy'), allow: f.getAttribute('allow'), src: f.getAttribute('src') }; })()`);
      assert.deepEqual(attrs, { sandbox: 'allow-scripts allow-same-origin', referrer: 'no-referrer', allow: null, src: 'sbwidget://desk-clock/index.html?theme=light' });
      await untilFrame('desk-clock', `!!window.__ready && document.getElementById('time').textContent !== '--:--'`, 'the clock is ready and ticking');
      const ready = await inFrame('desk-clock', 'window.__ready');
      assert.deepEqual({ widget: ready.widget, theme: ready.theme }, { widget: { id: 'desk-clock', name: 'Desk clock' }, theme: 'light' });
      assert.ok(ready.size.width > 300 && ready.size.height > 150, JSON.stringify(ready.size));
      assert.equal(await inFrame('desk-clock', 'document.documentElement.dataset.theme'), 'light');
      assert.equal(await inFrame('desk-clock', 'window.__storage'), 'kept', 'each widget is an origin with its own storage');
      assert.equal(await inFrame('desk-clock', 'typeof window.sb'), 'undefined', 'the app\'s bridge is the page\'s alone, never a widget\'s');
      await untilFrame('desk-clock', `window.__direct !== undefined && window.__notify !== undefined`, 'the direct fetch and the permission settle');
      assert.equal(await inFrame('desk-clock', 'window.__direct'), 'blocked', 'connect-src \'self\' stops a direct fetch');
      assert.equal(requests.some(r => r.url.includes('/v1/direct')), false);
      assert.equal(await inFrame('desk-clock', 'window.__notify'), 'denied');
      await untilFrame('desk-clock', 'window.__wasm !== undefined', 'WebAssembly settles');
      assert.equal(await inFrame('desk-clock', 'window.__wasm'), 'compiled', 'the CSP lets a widget compile the wasm it is served');
      const origins = await run('Array.from(new Set(window.__widgetOrigins))');
      assert.deepEqual(origins, ['sbwidget://desk-clock'], 'Chromium reports a widget\'s origin as sbwidget://<id>');
      const hostOrigins = await inFrame('desk-clock', 'Array.from(new Set(window.__hostOrigins))');
      debug('origins', origins, hostOrigins);

      // A widget that isn't installed says so, with its id.
      await until(`/This widget isn't installed/.test(document.querySelector(${q(face('not-installed'))})?.textContent || '')`);
      assert.match(await run(`document.querySelector(${q(face('not-installed'))}).textContent`), /not-installed/);

      // The weather card needs a key: its panel stands in for the page.
      await until(`!!document.querySelector(${q(face('weather') + ' .flow-widget-key input[type="password"]')})`, 'the Needs a key panel');
      assert.equal(await run(`!!document.querySelector(${q(face('weather') + ' iframe')})`), false, 'no frame before the key');
      assert.match(await run(`document.querySelector(${q(face('weather') + ' .flow-widget-key')}).textContent`), /Needs a key.*127\.0\.0\.1:\d+.*API_KEY/s);
      await capture('widgets-needs-key');
      // ⌘V is an Edit-menu item: main sends the clipboard's text, the canvas declines it
      // for a focused field, and app.js pastes it into the field — as the user's paste goes.
      await run(`document.querySelector(${q(face('weather') + ' .flow-widget-key input')}).focus()`);
      send('sb:evt:edit', { action: 'paste', text: KEY });
      await until(`document.querySelector(${q(face('weather') + ' .flow-widget-key input')}).value.length === ${KEY.length}`, 'the pasted key');
      await run(`document.querySelector(${q(face('weather') + ' .flow-widget-key-save')}).click()`);
      await until(`!!document.querySelector(${q(face('weather') + ' iframe.flow-widget-frame')})`, 'the weather frame after the key');
      await untilFrame('weather', 'window.__result !== undefined || window.__error !== undefined', 'the forecast');
      assert.equal(await inFrame('weather', 'window.__error ?? null'), null);
      const result = await inFrame('weather', 'window.__result');
      assert.deepEqual(result, {
        ok: true, status: 200,
        headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '41' },
        data: { summary: 'Sunny, 21°', city: 'Example City' },
      });
      const asked = requests.filter(r => r.url.startsWith('/v1/forecast'));
      assert.equal(asked.length, 1);
      assert.equal(asked[0].url, '/v1/forecast?city=Example+City');
      assert.equal(asked[0].headers.authorization, `Bearer ${KEY}`, 'main attached the kept key');
      assert.equal(asked[0].headers['x-trace'], 'abc');
      assert.equal(asked[0].headers.cookie, undefined);
      assert.equal(await inFrame('weather', 'window.__escape'), `That path leads outside 127.0.0.1:${port}/v1/, the only place this widget may fetch from`);
      assert.equal(requests.some(r => r.url.includes('admin')), false);
      // The key went renderer → main once; it is nowhere in the frame, nor left in the page.
      const frameHolds = await inFrame('weather', `document.documentElement.outerHTML + JSON.stringify(window.__result) + JSON.stringify(Object.assign({}, localStorage)) + location.href`);
      assert.equal(frameHolds.includes(KEY), false, 'the frame never sees the key');
      assert.equal((await run('document.documentElement.outerHTML')).includes(KEY), false, 'the page holds no key once saved');
      assert.equal(fs.readFileSync(widgets.secretsFile(), 'utf8').includes(KEY), false, 'kept encrypted');
      assert.equal(await run(`document.querySelector(${q(face('weather') + ' button[aria-label="Key · API_KEY"]')})?.getAttribute('aria-pressed')`), 'false');
      await untilFrame('weather', `document.getElementById('out').textContent === 'Sunny, 21°'`);
      await capture('widgets-light');
      debug('key saved, forecast drawn');

      // Open folder: main is asked for this widget's folder, and nothing else.
      await run(`document.querySelector(${q(face('desk-clock') + ' button[aria-label="Open the widget\'s folder"]')}).click()`);
      for (let i = 0; i < 40 && !foldersOpened.length; i++) await sleep(25);
      assert.deepEqual(foldersOpened, [path.join(widgets.widgetsDir(), 'desk-clock')]);

      // The board's theme, followed live.
      await run(`SB.termTheme.set('dark')`);
      await untilFrame('desk-clock', `document.documentElement.dataset.theme === 'dark'`, 'the dark theme');
      assert.deepEqual(await inFrame('desk-clock', 'window.__themes'), ['dark']);
      await untilFrame('weather', `document.documentElement.dataset.theme === 'dark'`);
      await capture('widgets-dark');

      // An agent edits the widget: its frame loads the new page by itself.
      fs.writeFileSync(path.join(widgets.widgetsDir(), 'desk-clock', 'index.html'), CLOCK_PAGE('second version'));
      await untilFrame('desk-clock', `document.getElementById('marker')?.textContent === 'second version'`, 'the live reload');
      // Loaded again, it starts dark: the board's theme is in its address.
      assert.equal(await inFrame('desk-clock', 'document.documentElement.dataset.theme'), 'dark');
      debug('live reload');

      // Native pointer input: the strip drags the node, and a corner resizes it — the page
      // hears its new size — both kept in the board file.
      const stored = async () => (await whiteboards.get(boardId)).data.spec.nodes.find(node => node.id === 'clock');
      const flush = () => run(`SB.views.whiteboards.api(${q(boardId)}).flush()`);
      const box = async selector => run(`document.querySelector(${q(selector)}).getBoundingClientRect().toJSON()`);
      const drag = async (from, to, steps = 10) => {
        window.webContents.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y });
        window.webContents.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 });
        for (let i = 1; i <= steps; i++) {
          window.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(from.x + (to.x - from.x) * i / steps), y: Math.round(from.y + (to.y - from.y) * i / steps), button: 'left' });
          await sleep(16);
        }
        window.webContents.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 });
        await frames();
      };
      const before = await stored();
      const head = await box(face('desk-clock') + ' .flow-widget-head b');
      const grip = { x: Math.round(head.left + 20), y: Math.round(head.top + head.height / 2) };
      await drag(grip, { x: grip.x + 48, y: grip.y + 32 });
      await flush();
      const moved = await stored();
      assert.ok(moved.position.x > before.position.x + 30 && moved.position.y > before.position.y + 15, 'dragged by its strip: ' + JSON.stringify(moved.position));
      assert.deepEqual(moved.size, before.size);
      await until(`document.querySelector('.react-flow__node[data-id="clock"]')?.classList.contains('selected')`, 'the clock selected');
      nativeResize = true;
      const corner = await box('.react-flow__node[data-id="clock"] .react-flow__resize-control.handle.bottom.right');
      const at = { x: Math.round(corner.left + corner.width / 2), y: Math.round(corner.top + corner.height / 2) };
      const heardSizes = (await inFrame('desk-clock', 'window.__sizes.length'));
      await drag(at, { x: at.x + 80, y: at.y + 50 });
      await flush();
      const resized = await stored();
      assert.ok(resized.size.width >= before.size.width + 60 && resized.size.height >= before.size.height + 30, 'resized from its corner: ' + JSON.stringify(resized.size));
      await untilFrame('desk-clock', `window.__sizes.length > ${heardSizes} && window.__sizes.at(-1).width > ${before.size.width}`, 'the page told of its new size');
      // Never smaller than its least size, however far the corner goes.
      const corner2 = await box('.react-flow__node[data-id="clock"] .react-flow__resize-control.handle.bottom.right');
      const at2 = { x: Math.round(corner2.left + corner2.width / 2), y: Math.round(corner2.top + corner2.height / 2) };
      await drag(at2, { x: at2.x - 600, y: at2.y - 400 });
      await flush();
      assert.deepEqual((await stored()).size, { width: 200, height: 120 }, 'held to FLOW_WIDGET_MIN_SIZE');
      await frames();
      await sleep(100);
      nativeResize = false;
      debug('dragged and resized');

      // A scroll that begins over a widget with something to scroll scrolls it; one that
      // began on the canvas pans on across it. (A page with nothing to scroll passes a
      // scroll on to the canvas by itself — Chromium chains it out of the frame.)
      fs.writeFileSync(path.join(widgets.widgetsDir(), 'weather', 'index.html'), `<!doctype html>
<html><head><meta charset="utf-8"><script src="/__switchboard/widget.js"></script>
<style>html, body { height: 100%; margin: 0; } #list { height: 100%; overflow: auto; font: 14px/22px -apple-system, sans-serif; }</style></head>
<body><div id="list">${Array.from({ length: 80 }, (_, i) => `<div>Example day ${i + 1}</div>`).join('')}</div>
<script>Switchboard.ready().then(function () { window.__listReady = true; });</script></body></html>`);
      await untilFrame('weather', 'window.__listReady === true && document.getElementById("list").scrollHeight > document.getElementById("list").clientHeight', 'the scrollable page');
      const viewportSel = '.dgslab[data-wb-board="' + boardId + '"] .react-flow__viewport';
      const viewport = () => run(`document.querySelector(${q(viewportSel)}).style.transform`);
      const page = await box(face('weather') + ' iframe');
      const overWidget = { x: Math.round(page.left + page.width / 2), y: Math.round(page.top + page.height / 2) };
      const pane = await box('.dgslab[data-wb-board="' + boardId + '"] .react-flow__pane');
      const overCanvas = { x: Math.round(pane.right - 80), y: Math.round(pane.bottom - 120) };
      const wheel = at => window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: 60 });
      assert.notEqual(frameOf('weather').osProcessId, window.webContents.mainFrame.osProcessId, 'a widget\'s frame runs in a process of its own');
      await sleep(400);
      const still = await viewport();
      await wheel(overWidget);
      await untilFrame('weather', 'document.getElementById("list").scrollTop > 0', 'the page scrolls');
      await sleep(150);
      assert.equal(await viewport(), still, 'a scroll that starts over a widget is the widget\'s');
      await inFrame('weather', 'document.getElementById("list").scrollTop = 0; true');
      await sleep(400);
      await wheel(overCanvas);
      await until(`document.querySelector(${q(viewportSel)}).style.transform !== ${q(still)}`, 'the canvas pans');
      const panned = await viewport();
      await wheel(overWidget);
      await until(`document.querySelector(${q(viewportSel)}).style.transform !== ${q(panned)}`, 'the pan goes on across the widget');
      assert.equal(await inFrame('weather', 'document.getElementById("list").scrollTop'), 0, 'mid-pan, the widget does not scroll');
      await sleep(450);
      assert.equal(await run('!!document.querySelector("[data-flow-wheel]")'), false, 'the mark goes once the wheel is still');
      await wheel(overWidget);
      await untilFrame('weather', 'document.getElementById("list").scrollTop > 0', 'once still, the page scrolls again');
      debug('wheel');

      // A widget navigating itself with no click in it (a redirect, a timer) opens nothing,
      // and the frame stays on its widget.
      const click = at => ['mousePressed', 'mouseReleased'].reduce((done, type) => done.then(() =>
        window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 })), Promise.resolve());
      assert.equal(widgets.frameHasKeyboard(window.webContents, frameOf('desk-clock')), false);
      await inFrame('desk-clock', `location.href = 'http://127.0.0.1:${port}/elsewhere'; true`);
      for (let i = 0; i < 40 && !keptIn.length; i++) await sleep(25);
      assert.deepEqual({ opened, keptIn }, { opened: [], keptIn: [`http://127.0.0.1:${port}/elsewhere`] });
      await sleep(200);
      assert.equal(requests.some(r => r.url === '/elsewhere'), false);
      assert.ok(frameOf('desk-clock'), 'still showing the clock');

      // A click in the clock's field gives its frame the keyboard, and the Edit menu's
      // commands then run there (index.js guestEdit → widgets.editInWidget): Select All
      // selects the field's text, not the canvas behind it.
      const clockFrame = await box(face('desk-clock') + ' iframe');
      const scale = clockFrame.width / (await run(`document.querySelector(${q(face('desk-clock') + ' iframe')}).clientWidth`));
      const field = await inFrame('desk-clock', `document.getElementById('note').getBoundingClientRect().toJSON()`);
      await click({ x: Math.round(clockFrame.left + (field.left + 8) * scale), y: Math.round(clockFrame.top + (field.top + field.height / 2) * scale) });
      await untilFrame('desk-clock', `document.activeElement === document.getElementById('note')`, 'the field focused by the click');
      for (let i = 0; i < 40 && !widgets.frameHasKeyboard(window.webContents, frameOf('desk-clock')); i++) await sleep(25);
      assert.equal(widgets.frameHasKeyboard(window.webContents, frameOf('desk-clock')), true, 'the clicked frame has the keyboard');
      assert.equal(widgets.widgetShown(window.webContents.focusedFrame), 'desk-clock');
      assert.equal(widgets.editInWidget(window.webContents, 'selectAll'), true);
      await untilFrame('desk-clock', `(() => { const f = document.getElementById('note'); return f.selectionStart === 0 && f.selectionEnd === f.value.length && f.value.length > 0; })()`, 'Select All in the widget\'s field');
      // That frame tried to leave without the user, so it stays in even now it has them.
      await inFrame('desk-clock', `location.href = 'http://127.0.0.1:${port}/elsewhere-again'; true`);
      for (let i = 0; i < 40 && keptIn.length < 2; i++) await sleep(25);
      assert.deepEqual(opened, []);
      // A frame the user clicked into, that never tried alone, sends its link to the browser.
      await sleep(1100);
      const weatherFrame = await box(face('weather') + ' iframe');
      await click({ x: Math.round(weatherFrame.left + weatherFrame.width / 2), y: Math.round(weatherFrame.top + weatherFrame.height / 2) });
      for (let i = 0; i < 40 && !widgets.frameHasKeyboard(window.webContents, frameOf('weather')); i++) await sleep(25);
      assert.equal(widgets.frameHasKeyboard(window.webContents, frameOf('weather')), true);
      await inFrame('weather', `location.href = 'http://127.0.0.1:${port}/elsewhere'; true`);
      for (let i = 0; i < 40 && !opened.length; i++) await sleep(25);
      assert.deepEqual(opened, [{ link: `http://127.0.0.1:${port}/elsewhere` }]);
      assert.ok(frameOf('weather'), 'still showing the weather list');
      // Nor may it become another widget.
      await inFrame('desk-clock', `location.href = 'sbwidget://weather/index.html'; true`);
      await sleep(300);
      assert.ok(frameOf('desk-clock'), 'a widget\'s frame keeps to its own id');
      assert.equal(await inFrame('desk-clock', `document.getElementById('marker').textContent`), 'second version');
      // No popups: the sandbox allows none.
      await inFrame('desk-clock', `window.__popup = window.open('http://127.0.0.1:${port}/popup') === null; true`);
      await sleep(150);
      assert.equal(await inFrame('desk-clock', 'window.__popup'), true);
      assert.equal(opened.length, 1, 'a popup never reaches the window-open handler');

      // The node's Reload: a ready page is asked to refresh, which (with no onRefresh) loads it again.
      await inFrame('desk-clock', `window.__beforeReload = true; true`);
      await run(`document.querySelector(${q(face('desk-clock') + ' button[aria-label^="Reload"]')}).click()`);
      await untilFrame('desk-clock', `window.__beforeReload === undefined && !!window.__ready`, 'the reload');

      // A page that loads the SDK and never calls ready() — its CSS follows data-theme and
      // needs nothing else — still follows the board's theme as it changes.
      fs.writeFileSync(path.join(widgets.widgetsDir(), 'weather', 'index.html'), `<!doctype html>
<html><head><meta charset="utf-8"><script src="/__switchboard/widget.js"></script>
<style>html, body { height: 100%; margin: 0; } body { background: #ffffff; } [data-theme="dark"] body { background: #111827; }</style></head>
<body><p id="plain">CSS only</p></body></html>`);
      await untilFrame('weather', `!!document.getElementById('plain') && document.documentElement.dataset.theme === 'dark'`, 'the CSS-only page, dark');
      await sleep(150);
      await run(`SB.termTheme.set('light')`);
      await untilFrame('weather', `document.documentElement.dataset.theme === 'light'`, 'the CSS-only page follows the board to light');
      debug('theme without ready()');

      // widget.json pointed at another API (localhost is not 127.0.0.1): the key kept for
      // the first is not sent there, and the face asks for it again, saying why.
      const keyedBefore = requests.filter(r => r.headers.authorization).length;
      fs.writeFileSync(path.join(widgets.widgetsDir(), 'weather', 'widget.json'), JSON.stringify({
        name: 'Weather', api: { baseUrl: `http://localhost:${port}/v1/`, secret: 'API_KEY' },
      }));
      await until(`!!document.querySelector(${q(face('weather') + ' .flow-widget-key input[type="password"]')})`, 'the key asked for again');
      const asked2 = await run(`document.querySelector(${q(face('weather') + ' .flow-widget-key')}).textContent`);
      assert.match(asked2, new RegExp(`given for 127\\.0\\.0\\.1:${port}.*now reads localhost:${port}`, 's'));
      assert.equal(await run(`!!document.querySelector(${q(face('weather') + ' iframe')})`), false);
      await sleep(200);
      assert.equal(requests.filter(r => r.headers.authorization).length, keyedBefore, 'no request carried the key anywhere');
      await capture('widgets-key-elsewhere');

      stopWatching();
      assert.deepEqual(errors, [], 'the renderer logged no errors');
      console.log(`PASS — widgets: a clock and a keyed widget drawn in sandboxed frames (allow-scripts allow-same-origin, no referrer, no allow=), origin ${origins[0]} (the page's own messages reach the widget from ${hostOrigins.join(', ') || 'nowhere'}), ready/theme/size, own storage, a direct fetch stopped by the CSP, wasm compiled, Notification denied, a widget that isn't installed, the Needs a key panel saving a key, a request through main carrying the manifest's Authorization (not the widget's), the key never in the frame, a path outside the base refused, Open folder, the board's theme live, a file edit reloading the frame, a drag by its strip and a corner resize (the page told, the least size held), its own process, a scroll over it its own and a pan across it the canvas's, a widget's own navigation kept in, Select All run in a clicked widget's field, a clicked widget's link sent to the browser, the frame kept on its widget, no popups, Reload, a CSS-only page following the theme, the key not sent to a re-pointed API`);
    } catch (error) {
      exitCode = 1;
      await capture('failure').catch(() => {});
      console.error(error.stack || error);
    } finally {
      server.close();
      window.destroy();
      app.exit(exitCode);
    }
  }).catch(error => { console.error(error.stack || error); app.exit(1); });
}
