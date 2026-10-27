'use strict';

// The real renderer, preload, permission handlers and local recording writer with
// Chromium's simulated camera/microphone. Everything lives in a scratch directory;
// this never opens a physical device, reads the user's config or reaches the web.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const repo = path.join(__dirname, '..');

if (!process.versions.electron) {
  const { execFileSync } = require('node:child_process');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-recording-browser-'));
  require('./build-diagrams').build().then(() => {
    try {
      fs.writeFileSync(path.join(temp, 'config.json'), '{}\n');
      process.stdout.write(execFileSync(require('electron'), [__filename, temp], {
        encoding: 'utf8', timeout: 60_000,
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
  const directory = path.join(temp, 'recordings');
  const rendererFile = path.join(repo, 'src/renderer/index.html');
  app.setPath('userData', path.join(temp, 'profile'));
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  const whiteboards = require('../src/main/whiteboards');
  const { createRecordingSession } = require('../src/main/recording-session');
  const { setupVideoEmbeds } = require('../src/main/videos');
  let window;
  const revealed = [];
  const recording = createRecordingSession({
    ipcMain, getWindow: () => window, directory, rendererUrl: pathToFileURL(rendererFile).href,
    platform: 'test', systemPreferences: {}, shell: { showItemInFolder: file => revealed.push(file) },
  });
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
  for (const [name, method] of Object.entries({
    list: 'list', get: 'get', create: 'create', saveSpec: 'saveSpec', rename: 'rename', setWorkspace: 'setWorkspace',
    move: 'move', duplicate: 'duplicate', archive: 'setArchived', delete: 'remove', createFolder: 'createFolder',
    renameFolder: 'renameFolder', deleteFolder: 'removeFolder', dismissNotice: 'dismissNotice', noteWorkspace: 'noteWorkspace',
    workspaces: 'workspaceChoices', createDocument: 'createDocument', getDocument: 'getDocument', saveDocument: 'saveDocument', migrate: 'migrate',
  })) handle('wb:' + name, (...args) => whiteboards[method](...args));

  app.whenReady().then(async () => {
    setupVideoEmbeds(session.defaultSession);
    protocol.handle('https', () => new Response('No network in recording tests', { status: 404 }));
    protocol.handle('http', () => new Response('No network in recording tests', { status: 404 }));
    window = new BrowserWindow({
      show: false, width: 1200, height: 820,
      webPreferences: { preload: path.join(repo, 'src/preload.js'), offscreen: true, backgroundThrottling: false },
    });
    const errors = [];
    window.webContents.on('console-message', (...args) => {
      const details = args[0] && typeof args[0] === 'object' && 'message' in args[0]
        ? args[0] : { level: args[1], message: args[2] };
      if (details.level === 'error' || details.level === 3) errors.push(String(details.message));
    });
    const run = async code => {
      try { return await window.webContents.executeJavaScript(code, true); }
      catch (error) { throw new Error(error.message + '\nRenderer script: ' + code + '\n' + errors.join('\n')); }
    };
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async code => {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (await run(code)) return;
        await sleep(25);
      }
      const panel = await run('document.querySelector("[data-recording-panel]")?.textContent || "No recording panel"');
      throw new Error('Timed out: ' + code + '\n' + panel + '\n' + errors.join('\n'));
    };
    const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const phase = name => `document.querySelector('[data-recording-panel][data-phase="${name}"]')`;
    const files = () => fs.existsSync(directory) ? fs.readdirSync(directory) : [];
    const completed = () => files().filter(file => !file.includes('.partial.'));
    const checkWebM = filename => {
      const bytes = fs.readFileSync(path.join(directory, filename));
      assert.ok(bytes.length > 1000, 'The saved recording has video data');
      assert.deepEqual([...bytes.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3], 'A real WebM container was saved');
    };
    let code = 0;
    try {
      assert.equal((await whiteboards.migrate()).ok, true);
      const board = await whiteboards.create({
        folderId: null, name: 'Example camera recording', workspace: null,
        spec: { kind: 'flow', nodes: [{ id: 'example', label: 'Explain this idea', position: { x: 80, y: 80 } }], edges: [] },
      });
      assert.equal(board.ok, true, board.error);
      await window.loadFile(rendererFile);
      await until('SB.state.booted');
      await run(`SB.go({ view: 'whiteboard', board: ${JSON.stringify(board.data.id)} })`);
      await until('document.querySelector("[data-recording-start]")');
      await click('[data-recording-start]');
      await until(phase('recording'));
      await until('document.querySelector("[data-recording-panel] video")?.videoWidth > 0');
      assert.deepEqual(await run(`(() => {
        const video = document.querySelector('[data-recording-panel] video');
        window.recordingTestTracks = video.srcObject.getTracks();
        return { muted: video.muted, tracks: video.srcObject.getTracks().map(track => track.kind).sort() };
      })()`), { muted: true, tracks: ['audio', 'video'] });
      await click('[data-recording-mute]');
      assert.equal(await run(`document.querySelector('[data-recording-panel] video').srcObject.getAudioTracks()[0].enabled`), false);
      await click('[data-recording-mute]');
      assert.equal(await run(`document.querySelector('[data-recording-panel] video').srcObject.getAudioTracks()[0].enabled`), true);

      // A recording belongs to the window: its preview and Stop survive navigation.
      await run('SB.go({ view: "whiteboards", folder: "all" })');
      assert.equal(await run(`!!${phase('recording')}`), true);
      await run(`SB.go({ view: 'whiteboard', board: ${JSON.stringify(board.data.id)} })`);
      await until(`document.querySelector('[aria-label="Full screen"]')`);
      await click('[aria-label="Full screen"]');
      assert.equal(await run(`!!${phase('recording')}`), true);
      const visible = await run(`(() => {
        const panel = document.querySelector('[data-recording-panel]');
        const rect = panel.getBoundingClientRect();
        const style = getComputedStyle(panel);
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { visible: !!hit?.closest('[data-recording-panel]'), rect: rect.toJSON(), position: style.position, zIndex: style.zIndex,
          parents: [panel.parentElement, panel.parentElement.parentElement].map(el => {
            const cs = getComputedStyle(el); return { tag: el.tagName, id: el.id, className: el.className,
              position: cs.position, zIndex: cs.zIndex, isolation: cs.isolation, opacity: cs.opacity, transform: cs.transform,
              display: cs.display, overflow: cs.overflow, pointerEvents: cs.pointerEvents, order: cs.order, width: cs.width, height: cs.height };
          }), hit: hit?.outerHTML.slice(0, 300) };
      })()`);
      assert.equal(visible.visible, true, 'Camera preview is visible above fullscreen: ' + JSON.stringify(visible));
      await sleep(1300);
      if (process.env.SWITCHBOARD_RECORDING_CAPTURE) {
        fs.mkdirSync(process.env.SWITCHBOARD_RECORDING_CAPTURE, { recursive: true });
        const screenshot = await window.webContents.capturePage();
        fs.writeFileSync(path.join(process.env.SWITCHBOARD_RECORDING_CAPTURE, 'recording.png'), screenshot.toPNG());
      }
      await click('[data-recording-stop]');
      await until(phase('saved'));
      assert.deepEqual(await run('window.recordingTestTracks.map(track => track.readyState)'), ['ended', 'ended']);
      assert.equal(completed().length, 1);
      checkWebM(completed()[0]);
      const media = await run(`new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.muted = true;
        video.onloadeddata = () => {
          const result = { width: video.videoWidth, height: video.videoHeight, duration: video.duration, readyState: video.readyState };
          video.removeAttribute('src'); video.load(); resolve(result);
        };
        video.onerror = () => reject(new Error('The saved recording did not decode: ' + video.error?.message));
        video.src = ${JSON.stringify(pathToFileURL(path.join(directory, completed()[0])).href)};
        video.load();
      })`);
      assert.ok(media.width > 0 && media.height > 0 && media.readyState >= 2, 'The saved file decodes as a video');
      assert.equal(files().filter(file => file.includes('.partial.')).length, 0);
      await click('[data-recording-reveal]');
      for (let attempt = 0; attempt < 100 && revealed.length === 0; attempt++) await sleep(20);
      assert.equal(revealed.length, 1);
      assert.equal(revealed[0], path.join(directory, completed()[0]));
      await click('[data-recording-dismiss]');
      await until('!document.querySelector("[data-recording-panel]")');

      await click('[aria-label="Exit full screen"]');
      await click('[data-recording-start]');
      await until(phase('recording'));
      await sleep(1300);
      assert.equal((await recording.flush()).ok, true, 'Close flush waits for final recorder bytes and disk writes');
      await until(phase('saved'));
      assert.equal(completed().length, 2);
      for (const file of completed()) checkWebM(file);
      assert.equal(files().filter(file => file.includes('.partial.')).length, 0);
      recording.resume();
      assert.deepEqual(errors, [], 'No renderer errors');
      console.log('PASS — camera preview, microphone toggle, navigation, full screen, local WebM, Finder and close flush');
    } catch (error) {
      code = 1;
      console.error(error.stack || error);
    } finally {
      await recording.interrupt();
      window.destroy();
      app.exit(code);
    }
  }).catch(error => { console.error(error.stack || error); app.exit(1); });
}
