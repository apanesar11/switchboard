'use strict';

// The real renderer, preload, permission handlers and local recording writer with
// real MediaRecorder fed by canvas/Web Audio streams. Everything lives in a scratch directory;
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
  const { app, BrowserWindow, ipcMain, net, protocol, session } = require('electron');
  const temp = process.argv[2];
  const directory = path.join(temp, 'recordings');
  const rendererFile = path.join(repo, 'src/renderer/index.html');
  app.setPath('userData', path.join(temp, 'profile'));
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  const whiteboards = require('../src/main/whiteboards');
  const { createRecordingSession } = require('../src/main/recording-session');
  const { setupVideoEmbeds } = require('../src/main/videos');
  const { createRecordingVideoHandler } = require('../src/main/recordings');
  protocol.registerSchemesAsPrivileged([{ scheme: 'sbvideo', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
  let window;
  const revealed = [];
  const recording = createRecordingSession({
    ipcMain, getWindow: () => window, directory, rendererUrl: pathToFileURL(rendererFile).href,
    platform: 'test', systemPreferences: {}, shell: { showItemInFolder: file => revealed.push(file) },
  });
  const handle = (name, callback) => ipcMain.handle('sb:' + name, (_event, ...args) => callback(...args));
  handle('wb:timers', () => ({ ok: true, data: [] }));
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
    protocol.handle('sbvideo', createRecordingVideoHandler({ directory, net }));
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
      const panel = await run(`JSON.stringify({panel:document.querySelector('[data-recording-panel]')?.textContent, card:document.querySelector('[data-local-video]')?.innerHTML, media:Array.from(document.querySelectorAll('[data-local-video] video')).map(v=>({src:v.currentSrc,readyState:v.readyState,networkState:v.networkState,error:v.error?.message}))})`);
      throw new Error('Timed out: ' + code + '\n' + panel + '\n' + errors.join('\n'));
    };
    const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
    // Generate actual encoded media without OS camera permissions or hardware.
    // The recorder, IPC writer, container finalizer and player are the real ones.
    const simulateDevices = () => run(`navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const context = canvas.getContext('2d'); let frame = 0;
      const paint = () => { context.fillStyle = 'hsl(' + (frame++ % 360) + ',70%,50%)'; context.fillRect(0,0,640,360); };
      paint(); const timer = setInterval(paint, 50);
      const video = canvas.captureStream(20);
      const audio = new AudioContext(), destination = audio.createMediaStreamDestination();
      const tone = audio.createOscillator(); tone.connect(destination); tone.start(); await audio.resume();
      const track = video.getVideoTracks()[0], stop = track.stop.bind(track);
      track.stop = () => { clearInterval(timer); void audio.close(); stop(); };
      return new MediaStream([...video.getTracks(), ...destination.stream.getAudioTracks()]);
    }; undefined`);
    const phase = name => `document.querySelector('[data-recording-panel][data-phase="${name}"]')`;
    const files = () => fs.existsSync(directory) ? fs.readdirSync(directory) : [];
    const completed = () => files().filter(file => !file.includes('.partial.'));
    const checkWebM = filename => {
      const bytes = fs.readFileSync(path.join(directory, filename));
      assert.ok(bytes.length > 1000, 'The saved recording has video data');
      assert.deepEqual([...bytes.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3], 'A real WebM container was saved');
      const firstCluster = bytes.indexOf(Buffer.from('1f43b675', 'hex'));
      const cues = bytes.indexOf(Buffer.from('1c53bb6b', 'hex'));
      assert.ok(cues >= 0 && cues < firstCluster, 'The seek index is available before the video data');
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
      await simulateDevices();
      assert.equal(await run(`(() => {
        const image = document.querySelector('[aria-label="Image (I)"]');
        const record = document.querySelector('[data-recording-start]');
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.indexOf(record) === buttons.indexOf(image) + 1;
      })()`), true, 'Record sits immediately after Image in the side toolbar');
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

      // The preview grows without leaving its board, then follows that board only.
      const bounds = () => run(`(() => {
        const panel = document.querySelector('[data-recording-panel]');
        const rect = panel.getBoundingClientRect(), host = panel.parentElement.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width,
          inside: rect.left >= host.left && rect.top >= host.top && rect.right <= host.right + 1 && rect.bottom <= host.bottom + 1 };
      })()`);
      const beforePreview = await bounds();
      await run(`document.querySelector('[data-recording-resize]').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight', bubbles:true}))`);
      await until(`document.querySelector('[data-recording-panel]').getBoundingClientRect().width > ${beforePreview.width + 10}`);
      assert.equal((await bounds()).inside, true, 'Enlarged preview remains inside its board');
      const header = await run(`document.querySelector('[data-recording-panel] header').getBoundingClientRect().toJSON()`);
      const x = Math.round(header.left + header.width / 2), y = Math.round(header.top + header.height / 2);
      window.webContents.sendInputEvent({ type:'mouseMove', x, y });
      window.webContents.sendInputEvent({ type:'mouseDown', x, y, button:'left', clickCount:1 });
      window.webContents.sendInputEvent({ type:'mouseMove', x:1, y:1, button:'left' });
      window.webContents.sendInputEvent({ type:'mouseUp', x:1, y:1, button:'left', clickCount:1 });
      await sleep(50);
      assert.equal((await bounds()).inside, true, 'Dragging beyond the board clamps the preview');
      await run('SB.go({ view: "whiteboards", folder: "all" })');
      await until('!document.querySelector("[data-recording-panel]")');
      await run(`SB.go({ view: 'whiteboard', board: ${JSON.stringify(board.data.id)} })`);
      await until(phase('recording'));
      await click('[aria-label="Full screen"]');
      assert.equal((await bounds()).inside, true, 'Preview stays inside the board in fullscreen');
      // Span multiple keyframes/clusters so a near-end seek exercises the index.
      await sleep(6500);
      if (process.env.SWITCHBOARD_RECORDING_CAPTURE) {
        fs.mkdirSync(process.env.SWITCHBOARD_RECORDING_CAPTURE, { recursive: true });
        const screenshot = await window.webContents.capturePage();
        fs.writeFileSync(path.join(process.env.SWITCHBOARD_RECORDING_CAPTURE, 'recording.png'), screenshot.toPNG());
      }
      await click('[data-recording-stop]');
      await until('!document.querySelector("[data-recording-panel]") && document.querySelector("[data-local-video]")');
      assert.deepEqual(await run('window.recordingTestTracks.map(track => track.readyState)'), ['ended', 'ended']);
      assert.equal(completed().length, 1);
      checkWebM(completed()[0]);
      const immediateSeek = await run(`new Promise((resolve, reject) => {
        const video = document.createElement('video'); video.preload = 'metadata';
        const timeout = setTimeout(() => { video.removeAttribute('src'); video.load(); reject(new Error('Immediate near-end seek timed out')); }, 5000);
        video.addEventListener('error', () => { clearTimeout(timeout); reject(new Error(video.error?.message || 'Probe failed')); }, {once:true});
        video.addEventListener('loadedmetadata', () => {
          const duration = video.duration;
          if (!Number.isFinite(duration) || duration <= 5) {
            clearTimeout(timeout); reject(new Error('Full duration was unavailable at loadedmetadata: ' + duration)); return;
          }
          const target = duration - .15;
          video.addEventListener('seeked', () => {
            clearTimeout(timeout);
            const result = { duration, target, time: video.currentTime, paused: video.paused, width: video.videoWidth };
            video.removeAttribute('src'); video.load(); resolve(result);
          }, {once:true});
          video.currentTime = target;
        }, {once:true});
        video.src = document.querySelector('[data-local-video] video').src.split('#')[0];
      })`);
      assert.ok(Math.abs(immediateSeek.time - immediateSeek.target) < .05 && immediateSeek.paused && immediateSeek.width > 0,
        'A fresh player can seek directly near the end from loadedmetadata, without playing through the recording');
      await until('document.querySelector("[data-local-video] video")?.readyState >= 2');
      assert.equal(await run(`(() => {
        const video = document.querySelector('[data-local-video] video');
        return video.controls && video.videoWidth > 0 && video.paused;
      })()`), true, 'Local card starts paused on its first frame with native playback controls');
      assert.equal(await run(`(() => { const video = document.querySelector('[data-local-video] video'); return Number.isFinite(video.duration) && video.duration > 0 && video.seekable.length > 0; })()`), true, 'Native player knows the duration and seekable range');
      await run(`(() => { const video = document.querySelector('[data-local-video] video'); video.currentTime = video.duration / 2; })()`);
      await until(`(() => { const video = document.querySelector('[data-local-video] video'); return !video.seeking && Math.abs(video.currentTime - video.duration / 2) < .05; })()`);
      assert.equal(await run(`(async () => {
        const video = document.querySelector('[data-local-video] video');
        video.muted = true; await video.play(); const played = !video.paused; video.pause();
        return played && video.paused;
      })()`), true, 'Local card can play and pause');
      assert.equal(files().filter(file => file.includes('.partial.')).length, 0);
      const node = '.react-flow__node:has([data-local-video])';
      const originalRecordingSrc = (await whiteboards.get(board.data.id)).data.spec.nodes.find(node => node.videoSrc).videoSrc;
      const title = node + ' .flow-video-head b';
      const setName = value => run(`(() => {
        const input = document.querySelector('[aria-label="Video name"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      const nameKey = key => run(`document.querySelector('[aria-label="Video name"]').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))`);
      await click(node + ' [aria-label="Rename video"]');
      await until(`document.querySelector('[aria-label="Video name"]')`);
      await setName('  Example   introduction  ');
      await nameKey('Enter');
      await until(`document.querySelector(${JSON.stringify(title)})?.textContent === 'Example introduction'`);
      await click(node + ' [aria-label="Rename video"]');
      await setName('Discarded title');
      await nameKey('Escape');
      assert.equal(await run(`document.querySelector(${JSON.stringify(title)}).textContent`), 'Example introduction', 'Escape cancels renaming');
      await click(node + ' [aria-label="Rename video"]');
      await setName('   ');
      await nameKey('Enter');
      assert.equal(await run(`document.querySelector(${JSON.stringify(title)}).textContent`), 'Example introduction', 'Blank titles keep the current name');
      await click('[aria-label="Undo · ⌘Z"]');
      await until(`document.querySelector(${JSON.stringify(title)})?.textContent === 'Camera recording'`);
      await click('[aria-label="Redo · ⇧⌘Z"]');
      await until(`document.querySelector(${JSON.stringify(title)})?.textContent === 'Example introduction'`);
      await run('window.SBDiagrams.flush()');
      const renamed = (await whiteboards.get(board.data.id)).data.spec.nodes.find(node => node.videoSrc);
      assert.equal(renamed.label, 'Example introduction', 'The custom video name is saved on the board');
      assert.equal(renamed.videoSrc, originalRecordingSrc, 'Renaming preserves the recording source');
      await run(`document.querySelector(${JSON.stringify(node + ' .flow-video-head')}).click()`);
      const grip = node + ' .react-flow__resize-control.handle.bottom.right';
      await until(`document.querySelector(${JSON.stringify(grip)})`);
      // Paint the recreated nodes before native hit testing in this hidden window.
      await window.webContents.capturePage();
      const beforeCard = await run(`document.querySelector(${JSON.stringify(node)}).getBoundingClientRect().toJSON()`);
      const corner = await run(`document.querySelector(${JSON.stringify(grip)}).getBoundingClientRect().toJSON()`);
      const gx = Math.round(corner.left + corner.width / 2), gy = Math.round(corner.top + corner.height / 2);
      window.webContents.sendInputEvent({ type:'mouseMove', x:gx, y:gy });
      window.webContents.sendInputEvent({ type:'mouseDown', x:gx, y:gy, button:'left', clickCount:1 });
      for (let step = 1; step <= 5; step++) window.webContents.sendInputEvent({ type:'mouseMove', x:gx + step * 12, y:gy + step * 7, button:'left' });
      window.webContents.sendInputEvent({ type:'mouseUp', x:gx + 60, y:gy + 35, button:'left', clickCount:1 });
      await until(`document.querySelector(${JSON.stringify(node)}).getBoundingClientRect().width > ${beforeCard.width + 20}`);
      await run('window.SBDiagrams.flush()');
      if (process.env.SWITCHBOARD_RECORDING_CAPTURE) fs.writeFileSync(path.join(process.env.SWITCHBOARD_RECORDING_CAPTURE, 'recording-card.png'), (await window.webContents.capturePage()).toPNG());
      const savedNode = (await whiteboards.get(board.data.id)).data.spec.nodes.find(node => node.videoSrc);
      assert.ok(savedNode && savedNode.shape === 'video' && savedNode.size.width > 320, 'Recording and resized card are persisted in the board');
      assert.match(savedNode.videoSrc, /^sbvideo:\/\/recording\/Recording-/);
      await new Promise(resolve => { window.webContents.once('did-finish-load', resolve); window.reload(); });
      await until('SB.state.booted && document.querySelector("[data-local-video] video")?.readyState >= 2');
      assert.equal((await whiteboards.get(board.data.id)).data.spec.nodes.find(node => node.videoSrc).size.width, savedNode.size.width);
      assert.equal(await run(`document.querySelector(${JSON.stringify(title)}).textContent`), 'Example introduction', 'The video name survives reopening');

      if (await run(`!!document.querySelector('[aria-label="Exit full screen"]')`)) await click('[aria-label="Exit full screen"]');
      await simulateDevices();
      await click('[data-recording-start]');
      await until(phase('recording'));
      await sleep(1300);
      assert.equal((await recording.flush()).ok, true, 'Close flush waits for final recorder bytes and disk writes');
      await until('!document.querySelector("[data-recording-panel]") && document.querySelectorAll("[data-local-video]").length === 2');
      assert.equal(completed().length, 2);
      for (const file of completed()) checkWebM(file);
      assert.equal(files().filter(file => file.includes('.partial.')).length, 0);
      recording.resume();
      assert.deepEqual(errors, [], 'No renderer errors');
      console.log('PASS — recording, indexed WebM, immediate near-end seeking, local video cards, rename/undo/reopen, resize persistence and close flush');
    } catch (error) {
      code = 1;
      if (process.env.SWITCHBOARD_RECORDING_CAPTURE) {
        fs.mkdirSync(process.env.SWITCHBOARD_RECORDING_CAPTURE, { recursive: true });
        for (const file of files()) fs.copyFileSync(path.join(directory, file), path.join(process.env.SWITCHBOARD_RECORDING_CAPTURE, file));
      }
      console.error(error.stack || error);
    } finally {
      await recording.interrupt();
      window.destroy();
      app.exit(code);
    }
  }).catch(error => { console.error(error.stack || error); app.exit(1); });
}
