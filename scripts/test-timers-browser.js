'use strict';

// Production renderer/preload, real board storage and timer scheduler in an
// isolated Electron profile. All boards and settings are fictional, and every
// network request is answered locally. No personal configuration is read.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const repo = path.join(__dirname, '..');

if (!process.versions.electron) {
  const { execFileSync } = require('node:child_process');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-timers-browser-'));
  require('./build-diagrams').build().then(() => {
    try {
      fs.writeFileSync(path.join(temp, 'config.json'), '{}\n');
      process.stdout.write(execFileSync(require('electron'), [__filename, temp], {
        encoding: 'utf8', timeout: 90_000,
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
  const { app, BrowserWindow, ipcMain, protocol } = require('electron');
  const temp = process.argv[2];
  app.setPath('userData', path.join(temp, 'profile'));
  app.commandLine.appendSwitch('disable-gpu');
  const whiteboards = require('../src/main/whiteboards');
  const { createTimerService } = require('../src/main/timers');
  let window;
  const elapsed = [];
  const send = (channel, payload) => {
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  };
  const timers = createTimerService({
    store: whiteboards,
    directory: whiteboards.rootDir(),
    onChanged: items => send('sb:evt:wbTimers', items),
    onElapsed: item => { elapsed.push(item); send('sb:evt:wbTimerElapsed', item); },
  });
  const handle = (name, callback) => ipcMain.handle('sb:' + name, (_event, ...args) => callback(...args));
  let workspaceBootGate = null;
  handle('ws:list', () => workspaceBootGate || []);
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
  handle('wb:timers', async () => ({ ok: true, data: await timers.refresh() }));
  for (const [name, method] of Object.entries({
    list: 'list', get: 'get', create: 'create', saveSpec: 'saveSpec', rename: 'rename', setWorkspace: 'setWorkspace',
    move: 'move', duplicate: 'duplicate', archive: 'setArchived', delete: 'remove', createFolder: 'createFolder',
    renameFolder: 'renameFolder', deleteFolder: 'removeFolder', dismissNotice: 'dismissNotice', noteWorkspace: 'noteWorkspace',
    workspaces: 'workspaceChoices', createDocument: 'createDocument', getDocument: 'getDocument', saveDocument: 'saveDocument', migrate: 'migrate',
  })) handle('wb:' + name, (...args) => whiteboards[method](...args));
  whiteboards.onChange(change => send('sb:evt:wbChanged', change));

  app.whenReady().then(async () => {
    protocol.handle('https', () => new Response('No network in timer tests', { status: 404 }));
    protocol.handle('http', () => new Response('No network in timer tests', { status: 404 }));
    window = new BrowserWindow({ show: false, width: 1280, height: 900,
      webPreferences: { preload: path.join(repo, 'src/preload.js'), offscreen: true, backgroundThrottling: false } });
    const errors = [];
    window.webContents.on('console-message', (...args) => {
      const detail = args[0] && typeof args[0] === 'object' && 'message' in args[0]
        ? args[0] : { level: args[1], message: args[2] };
      if (detail.level === 'error' || detail.level === 3) errors.push(String(detail.message));
    });
    const q = JSON.stringify;
    const run = async code => {
      try { return await window.webContents.executeJavaScript(code, true); }
      catch (error) { throw new Error(error.message + '\nRenderer script: ' + code + '\n' + errors.join('\n')); }
    };
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const frames = () => run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const until = async code => {
      for (let attempt = 0; attempt < 240; attempt++) {
        if (await run(code)) return;
        await sleep(25);
      }
      throw new Error('Timed out: ' + code + '\n' + await run('document.querySelector("#main")?.textContent') + '\n' + errors.join('\n'));
    };
    const untilStored = async (boardId, predicate, message) => {
      for (let attempt = 0; attempt < 160; attempt++) {
        if (predicate(await stored(boardId))) return;
        await sleep(25);
      }
      throw new Error('Timed out waiting for persisted state: ' + message);
    };
    const click = async selector => { await run(`document.querySelector(${q(selector)}).click()`); await frames(); };
    const fill = async (selector, value) => {
      await run(`(() => { const input = document.querySelector(${q(selector)}); input.focus(); input.select(); })()`);
      await window.webContents.insertText(value);
      await frames();
      assert.equal(await run(`document.querySelector(${q(selector)}).value`), value, 'The input received its text');
      await run(`document.querySelector(${q(selector)}).blur()`);
      // Hidden offscreen Chromium changes activeElement on blur without reliably
      // emitting focusout. Deliver the DOM event React uses for onBlur as well.
      await run(`document.querySelector(${q(selector)}).dispatchEvent(new FocusEvent('focusout', { bubbles: true }))`);
      await frames();
      await sleep(50);
    };
    const capture = async name => {
      if (!process.env.SWITCHBOARD_TIMER_CAPTURE) return;
      fs.mkdirSync(process.env.SWITCHBOARD_TIMER_CAPTURE, { recursive: true });
      await frames();
      fs.writeFileSync(path.join(process.env.SWITCHBOARD_TIMER_CAPTURE, name + '.png'), (await window.webContents.capturePage()).toPNG());
    };
    const stored = async boardId => (await whiteboards.get(boardId)).data.spec;
    const flush = boardId => run(`SB.views.whiteboards.api(${q(boardId)}).flush()`);
    const open = async boardId => {
      await run(`SB.go({ view:'whiteboard', board:${q(boardId)} })`);
      await until(`!!SB.views.whiteboards.api(${q(boardId)}) && !!document.querySelector(${q('.dgslab[data-wb-board="' + boardId + '"] .react-flow__pane')})`);
      await frames();
    };
    let exitCode = 0;
    try {
      assert.equal((await whiteboards.migrate()).ok, true);
      const made = await whiteboards.create({ folderId: null, name: 'Example focus board', workspace: null,
        spec: { kind: 'flow', nodes: [], edges: [] } });
      const other = await whiteboards.create({ folderId: null, name: 'Another example board', workspace: null,
        spec: { kind: 'flow', nodes: [{ id: 'example', label: 'Review notes', position: { x: 70, y: 90 } }], edges: [] } });
      assert.equal(made.ok, true);
      assert.equal(other.ok, true);
      const boardId = made.data.id;
      await timers.start();
      await window.loadFile(path.join(repo, 'src/renderer/index.html'));
      await until('SB.state.booted');
      await open(boardId);
      await until('!!document.querySelector("button[aria-label=\\"Timer (O)\\"]")');
      await click('button[aria-label="Timer (O)"]');
      await run(`(() => { const pane = document.querySelector('.dgslab[data-wb-board="${boardId}"] .react-flow__pane'), rect = pane.getBoundingClientRect(); pane.dispatchEvent(new MouseEvent('click', { bubbles:true, clientX:rect.left + 410, clientY:rect.top + 260 })); })()`);
      await until('document.querySelectorAll(".flow-timer").length === 1');
      await flush(boardId);
      let spec = await stored(boardId);
      const id = spec.nodes.find(node => node.shape === 'timer').id;
      const card = `.flow-timer[data-flow-timer="${id}"]`;
      const button = name => card + ` button[aria-label="${name}"]`;
      assert.equal(spec.nodes.find(node => node.id === id).timer.durationMs, 25 * 60_000);
      await capture('idle');

      const action = async name => {
        await run(`Array.from(document.querySelectorAll(${q(card + ' button')})).find(button => button.textContent.trim() === ${q(name)}).click()`);
        await frames();
      };
      const node = async () => (await stored(boardId)).nodes.find(item => item.id === id);
      const state = value => `document.querySelector(${q(card)})?.dataset.status === ${q(value)}`;
      const duration = async value => {
        await click(button('Edit timer duration'));
        await fill(card + ' input[aria-label="Timer duration"]', value);
        await action('Set duration');
        await flush(boardId);
      };
      await fill(card + ' input[aria-label="Timer name"]', 'Design review');
      await flush(boardId);
      assert.equal((await node()).label, 'Design review', 'Name commits on blur');
      await run(`(() => { const input = document.querySelector(${q(card + ' input[aria-label="Timer name"]')}); input.focus(); input.select(); })()`);
      await window.webContents.insertText('Discard this name');
      await frames();
      await run(`document.querySelector(${q(card + ' input[aria-label="Timer name"]')}).dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true }))`);
      await frames();
      await run(`document.querySelector(${q(card + ' input[aria-label="Timer name"]')}).dispatchEvent(new FocusEvent('focusout', { bubbles:true }))`);
      await flush(boardId);
      assert.equal((await node()).label, 'Design review', 'Escape cancels a name edit');
      await action('5m');
      await flush(boardId);
      assert.equal((await node()).label, 'Design review');
      assert.equal((await node()).timer.durationMs, 300_000, 'Preset saves the duration');
      await click(button('Mute timer'));
      await flush(boardId);
      assert.equal((await node()).timer.sound, false);
      await click(button('Unmute timer'));
      await flush(boardId);
      assert.equal((await node()).timer.sound, true);

      await duration('0:00');
      assert.equal(await run(`document.querySelector(${q(card + ' input[aria-label="Timer duration"]')})?.getAttribute('aria-invalid')`), 'true');
      assert.equal((await node()).timer.durationMs, 300_000, 'Invalid duration preserves the timer');
      await fill(card + ' input[aria-label="Timer duration"]', '0:10');
      await action('Set duration');
      await flush(boardId);
      assert.equal((await node()).timer.durationMs, 10_000);
      const initialPosition = (await node()).position;

      // Native pointer input verifies the controls are excluded from node dragging.
      const nameRect = await run(`document.querySelector(${q(card + ' input[aria-label="Timer name"]')}).getBoundingClientRect().toJSON()`);
      const namePoint = { x: Math.round(nameRect.left + 35), y: Math.round(nameRect.top + nameRect.height / 2) };
      window.webContents.sendInputEvent({ type: 'mouseMove', ...namePoint });
      window.webContents.sendInputEvent({ type: 'mouseDown', ...namePoint, button: 'left', clickCount: 1 });
      window.webContents.sendInputEvent({ type: 'mouseMove', x: namePoint.x + 35, y: namePoint.y + 12, button: 'left' });
      window.webContents.sendInputEvent({ type: 'mouseUp', x: namePoint.x + 35, y: namePoint.y + 12, button: 'left', clickCount: 1 });
      await frames();
      await action('Start');
      await until(state('running'));
      await flush(boardId);
      const started = (await node()).timer;
      assert.equal(started.status, 'running');
      assert.ok(started.endsAt > Date.now() + 8500 && started.endsAt <= Date.now() + 10_000);
      assert.deepEqual((await node()).position, initialPosition, 'Using an inline control does not move the card');
      assert.equal(await run(`document.querySelector(${q(button('Time remaining'))}).disabled`), true, 'Duration cannot be edited while running');
      await sleep(450);
      await action('Pause');
      await until(state('paused'));
      await flush(boardId);
      const paused = (await node()).timer;
      assert.equal(paused.endsAt, undefined);
      assert.ok(paused.remainingMs < 9900 && paused.remainingMs > 7500);
      const pausedDisplay = await run(`document.querySelector(${q(card + ' [role="timer"]')}).textContent`);
      await sleep(1100);
      assert.equal(await run(`document.querySelector(${q(card + ' [role="timer"]')}).textContent`), pausedDisplay, 'Paused time stays fixed');
      await action('Resume');
      await flush(boardId);
      assert.ok((await node()).timer.endsAt > started.endsAt + 800, 'Resume accounts for the paused interval');
      await click(button('Reset timer'));
      await until(state('idle'));
      await flush(boardId);
      assert.equal((await node()).timer.remainingMs, 10_000);
      assert.equal((await node()).timer.endsAt, undefined);
      await capture('edited');

      await action('Start');
      await sleep(100);
      await action('Pause');
      await duration('0:03');
      assert.equal((await node()).timer.status, 'idle', 'Changing a paused duration resets the session');
      await action('Start');
      await flush(boardId);
      const deadline = (await node()).timer.endsAt;
      await timers.refresh();
      await open(other.data.id);
      await until(`SB.state.route.board === ${q(other.data.id)}`);
      await until('!!document.querySelector("button[aria-label=\\"Whiteboard timers\\"]")');
      await click('button[aria-label="Whiteboard timers"]');
      await until('!!document.querySelector(".wbtimer-menu [role=menuitem]")');
      await click('.wbtimer-menu [role=menuitem]');
      await until(`SB.state.route.board === ${q(boardId)} && !!document.querySelector(${q(card)})`);
      await sleep(250);
      assert.equal(await run('Array.from(document.querySelectorAll(".react-flow__viewport")).every(viewport => !viewport.style.transform.includes("NaN"))'), true, 'Timer navigation preserves a finite viewport');
      await open(other.data.id);
      await sleep(Math.max(0, deadline - Date.now() + 200));
      await timers.check();
      assert.equal(elapsed.filter(item => item.nodeId === id).length, 1, 'A background board finishes exactly once');
      assert.equal(elapsed.find(item => item.nodeId === id).sound, true, 'Enabled sound reaches the alarm delivery');
      await open(boardId);
      await until(state('finished'));
      await capture('finished');
      assert.equal(await run(`document.querySelector(${q(card + ' [role="timer"]')}).textContent`), '00:00');
      await action('Restart');
      await until(state('running'));
      await flush(boardId);
      assert.ok((await node()).timer.endsAt > Date.now() + 2000);
      await click(button('Reset timer'));
      await duration('0:02');
      await click(button('Mute timer'));
      await action('Start');
      await flush(boardId);
      const beforeReload = (await node()).timer;
      await new Promise(resolve => { window.webContents.once('did-finish-load', resolve); window.reload(); });
      await until('SB.state.booted');
      await open(boardId);
      assert.equal((await node()).timer.endsAt, beforeReload.endsAt, 'Reload preserves the deadline');
      await until(state('finished'));
      await timers.check();
      assert.equal(elapsed.filter(item => item.nodeId === id).length, 2, 'A restarted session gets one new alarm');
      assert.equal(elapsed.filter(item => item.nodeId === id).at(-1).sound, false, 'Muted timers preserve silent delivery');
      await click(button('Dismiss timer'));
      await until(state('idle'));
      await flush(boardId);
      await timers.refresh();
      assert.equal(timers.list().filter(item => item.nodeId === id).length, 0, 'Dismiss removes the completed timer from global alerts');
      assert.equal((await node()).label, 'Design review', 'Name survives reload');
      assert.equal((await node()).timer.durationMs, 2000);

      // Separate cards count down independently and keep their own sound setting.
      await click('button[aria-label="Timer (O)"]');
      await run(`(() => { const pane = document.querySelector('.dgslab[data-wb-board="${boardId}"] .react-flow__pane'), rect = pane.getBoundingClientRect(); pane.dispatchEvent(new MouseEvent('click', { bubbles:true, clientX:rect.left + 820, clientY:rect.top + 270 })); })()`);
      await until(`document.querySelectorAll(${q('.dgslab[data-wb-board="' + boardId + '"] .flow-timer')}).length === 2`);
      await flush(boardId);
      spec = await stored(boardId);
      const secondTimer = spec.nodes.find(item => item.shape === 'timer' && item.id !== id);
      assert.equal(secondTimer.timer.durationMs, 25 * 60_000);
      assert.equal(secondTimer.timer.status, 'idle');
      assert.equal(secondTimer.timer.sound, true);
      assert.equal((await node()).timer.durationMs, 2000);
      await capture('multiple');

      await duration('10');
      await action('Start');
      await untilStored(boardId, spec => spec.nodes.find(item => item.id === id).timer.status === 'running', 'Start saves immediately');
      await run(`document.querySelector(${q('[data-id="' + id + '"]')}).dispatchEvent(new MouseEvent('click', { bubbles:true }))`);
      await until('!!document.querySelector("button[aria-label=\\"Duplicate · ⌘D\\"]")');
      await click('button[aria-label="Duplicate · ⌘D"]');
      await untilStored(boardId, spec => spec.nodes.filter(item => item.shape === 'timer').length === 3, 'Duplicate saves immediately');
      const copied = (await stored(boardId)).nodes.find(item => item.shape === 'timer' && item.id !== id && item.id !== secondTimer.id);
      assert.equal(copied.timer.status, 'idle', 'A duplicate has its own idle session');
      assert.equal(copied.timer.endsAt, undefined);
      assert.equal(copied.timer.durationMs, 600_000);
      await click('button[aria-label="Delete · ⌫"]');
      await untilStored(boardId, spec => !spec.nodes.some(item => item.id === copied.id), 'Delete saves immediately');
      await run(`document.activeElement.blur(); SB.views.whiteboards.api(${q(boardId)}).editAction('undo', false)`);
      await untilStored(boardId, spec => spec.nodes.some(item => item.id === copied.id), 'Undo saves immediately');
      await run(`SB.views.whiteboards.api(${q(boardId)}).editAction('undo', false)`);
      await untilStored(boardId, spec => !spec.nodes.some(item => item.id === copied.id), 'Undo duplicate saves immediately');
      await click(button('Reset timer'));
      await untilStored(boardId, spec => spec.nodes.find(item => item.id === id).timer.status === 'idle', 'Reset saves immediately');

      await action('Start');
      await untilStored(boardId, spec => spec.nodes.find(item => item.id === id).timer.status === 'running', 'Timer starts before closing tabs');
      for (let count = 0; count < 10 && await run('!!document.querySelector(".wbtx")'); count++) {
        await click('.wbtx');
      }
      await until('SB.state.route.view === "whiteboards" && !document.querySelector(".wbtx")');
      await until('!!document.querySelector(".wbtimer")');
      await click('button[aria-label="Whiteboard timers"]');
      await click('.wbtimer-menu [role=menuitem]');
      await until(`SB.state.route.board === ${q(boardId)} && !!document.querySelector(${q(card)})`);
      await until(state('running'));
      await click(button('Reset timer'));
      await untilStored(boardId, spec => spec.nodes.find(item => item.id === id).timer.status === 'idle', 'Timer is discoverable after all tabs close');

      // Notification clicks can arrive after document load but before discovery
      // restores the saved screen. Deliberately hold that boot step and prove the
      // notification destination wins after a different board was saved as active.
      await open(other.data.id);
      let releaseWorkspaceBoot;
      workspaceBootGate = new Promise(resolve => { releaseWorkspaceBoot = resolve; });
      await new Promise(resolve => { window.webContents.once('did-finish-load', resolve); window.reload(); });
      await until('!!SB.state && !SB.state.booted');
      send('sb:evt:wbTimerNavigate', { boardId, nodeId: id });
      await sleep(150);
      assert.equal(await run('SB.state.booted'), false, 'Workspace discovery is deliberately pending');
      workspaceBootGate = null;
      releaseWorkspaceBoot([]);
      await until(`SB.state.booted && SB.state.route.board === ${q(boardId)} && !!document.querySelector(${q(card)})`);
      await until(`document.querySelector(${q(card)})?.closest('.react-flow__node')?.classList.contains('selected')`);
      assert.equal(await run('Array.from(document.querySelectorAll(".react-flow__viewport")).every(viewport => !viewport.style.transform.includes("NaN"))'), true, 'Cold notification navigation preserves the viewport');

      assert.deepEqual(errors, [], 'No renderer errors');
      console.log('PASS — timer placement, editing, presets, controls, pause/resume/reset, mute, background expiry/navigation, reload, restart/dismiss, independent cards, duplication, immediate undo/delete persistence and cold notification navigation');
    } catch (error) {
      exitCode = 1;
      await capture('failure').catch(() => {});
      console.error(error.stack || error);
    } finally {
      timers.stop();
      window.destroy();
      app.exit(exitCode);
    }
  }).catch(error => { console.error(error.stack || error); app.exit(1); });
}
