'use strict';

// Whiteboards in the production renderer: the real preload, index.html, the built
// whiteboard bundle, xterm and a real PTY (SWITCHBOARD_NO_TMUX=1), with this file's
// own main process. Its IPC is stubbed except for the whiteboard store, which is the
// REAL src/main/whiteboards.js rooted beside a temporary SWITCHBOARD_CONFIG. Every
// workspace, folder and board is fictional; no local config, Claude account, tmux
// session or ~/.switchboard is read or written.
//
// Covers: the Whiteboards rail screen and its home list; opening a board; Actions ▸
// Open terminal… floating the workspace's own shell (the Terminal tab's xterm, its
// scrollback, one shell); a second workspace's panel from the tray's + (a toggle: a
// second press puts its picker away), cascaded and in front; Tile; an edge resize
// (held, fitted once) and a header drag; minimize to the tray and restore; Close
// keeping the shell; ⌘A (the native Select All), the renderer's key path and Actions ▸
// Show or hide terminals; Esc, Paste, Copy and the bell inside a panel; Pin to board
// keeping the same xterm and cols/rows (no pty resize) while the overlay follows the
// node through a pan, a pinch (also over the terminal) and the "Zoom in to use" floor;
// a pinned terminal minimized in place; Smaller text and Larger text refitting its grid
// in the same node (and Undo of each); the pinned node in the board file; Float back
// to the same spot; Undo of the Float putting the node back with a grid that fits it,
// and Redo floating it where its text was; Markdown and box labels keeping ⌘A as
// Select All; full screen; a Grid square offering Terminal and Changes only, a square
// saved as a whiteboard opening Terminal on the same shell, and the old whiteboard
// squares cleared from localStorage; the exit footer and retry inside a panel; ✦ Answer's
// Conversation row (its count from the REAL store through answer.js, New conversation
// from the keyboard keeping Tab and Enter in the menu, a workspace changed and changed
// back leaving nothing to continue, a CLI that answers on its own); and no renderer
// errors along the way.
//
// SWITCHBOARD_WHITEBOARD_CAPTURE=<dir> saves screenshots of each stage there;
// SWITCHBOARD_WHITEBOARD_DEBUG=1 prints each stage and the renderer's errors as they come.
//
// A failure that is a product bug, not a test bug, is listed in KNOWN_BUGS by its
// check name: the run reports it and carries on, and passes only while it still fails
// (so a fix makes the run say to take it off the list).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const repo = path.join(__dirname, '..');

const KNOWN_BUGS = new Map([
  // ['check name', 'one line: what is wrong and where'],
]);

if (!process.versions.electron) {
  const { execFileSync } = require('node:child_process');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-whiteboards-browser-'));
  require('./build-diagrams').build().then(() => {
    try {
      fs.writeFileSync(path.join(temp, '.zshrc'), "PROMPT='example % '\n");
      // Two fictional workspaces declared by absolute folder, so the real store's
      // workspaceChoices() (workspaces.discover()) lists exactly the rail's two.
      for (const dir of ['project-a', 'project-b']) fs.mkdirSync(path.join(temp, dir));
      fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({ workspaces: {
        'example-workspace': { dir: path.join(temp, 'project-a') },
        'second-workspace': { dir: path.join(temp, 'project-b') },
      } }, null, 2));
      process.stdout.write(execFileSync(require('electron'), [__filename, temp], {
        encoding: 'utf8', timeout: 120_000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '', SWITCHBOARD_CONFIG: path.join(temp, 'config.json'), SWITCHBOARD_NO_TMUX: '1', SHELL: '/bin/zsh', ZDOTDIR: temp },
      }));
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }).catch(error => {
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    console.error(error.message);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow, ipcMain, Menu } = require('electron');
  const temp = process.argv[2];
  app.setPath('userData', path.join(temp, 'profile'));
  const whiteboards = require('../src/main/whiteboards');
  const shells = require('../src/main/shell');
  const wsId = 'example-workspace';
  const otherId = 'second-workspace';
  const dirs = { [wsId]: path.join(temp, 'project-a'), [otherId]: path.join(temp, 'project-b') };
  let window, clipboard = '', refuse = false;
  // ✦ Answer: who can answer (none, until the Conversation row's turn), and the board's
  // conversations through the REAL answer.js and whiteboard store, as index.js wires them.
  const answer = require('../src/main/answer');
  let answerStatus = { ok: true, settings: {}, providers: [], keysSafe: {} };
  let alone = null;
  const resets = [];
  const conversationStore = {
    async get(boardId, provider) {
      const res = await whiteboards.conversation(boardId, provider);
      if (!res.ok) throw new Error(res.error);
      return res.data;
    },
    set: (boardId, provider, entry) => whiteboards.setConversation(boardId, provider, entry),
  };
  const opens = [];
  const closes = [];
  const resizes = [];
  const workspace = id => ({ id, dir: dirs[id], project: 'example', section: 'example', repos: [], processes: [] });
  const handle = (channel, callback) => ipcMain.handle('sb:' + channel, (_event, ...args) => callback(...args));
  handle('ws:list', () => [workspace(wsId), workspace(otherId)]);
  handle('ws:scan', id => ({ ...workspace(id), ok: true }));
  handle('pr:summary', () => ({}));
  handle('run:states', () => []);
  handle('publish:state', () => ({}));
  handle('ui:sidebar', () => ({ visible: true }));
  handle('ui:setSidebar', visible => ({ visible }));
  handle('term:appearance', () => ({ appearance: 'light', effective: 'light' }));
  handle('grid:list', () => ({ views: [{ id: 'example-grid', name: 'Example grid', cells: [wsId, otherId, null, null] }] }));
  handle('grid:save', views => ({ views }));
  handle('usage:get', () => ({ ok: false, configured: false }));
  handle('answer:status', () => answerStatus);
  handle('answer:conversation', async boardId => {
    const res = await answer.conversation(boardId, { conversations: conversationStore, lookup: id => (dirs[id] ? workspace(id) : null) });
    // A CLI this Mac has too old to keep one: what answer.js says once a resume is refused.
    return alone && res.ok ? { ...res, data: { ...res.data, [alone]: null }, alone: [alone] } : res;
  });
  handle('answer:resetConversation', (boardId, provider) => {
    resets.push([boardId, provider]);
    return answer.resetConversation(boardId, provider, { conversations: conversationStore });
  });
  handle('diagrams:dirty', () => ({}));
  handle('diagrams:flushed', () => ({}));
  handle('clipboard:write', text => { clipboard = text; return { ok: true }; });
  handle('term:open', async (id, cols, rows) => {
    opens.push(id);
    return refuse ? { ok: false, error: 'Example connection failed' } : shells.open(workspace(id), { cols, rows });
  });
  handle('term:input', (id, data) => shells.write(id, data));
  handle('term:resize', (id, cols, rows) => { resizes.push({ id, cols, rows }); return shells.resize(id, cols, rows); });
  handle('term:buffer', id => shells.buffer(id));
  handle('term:states', () => shells.states());
  // Closing a whiteboard terminal must never end its shell: recorded, never honoured.
  handle('term:close', id => { closes.push(id); return { ok: true }; });
  // Every sb:wb:* channel, as src/main/index.js wires them, to the real store.
  for (const [name, method] of Object.entries({
    list: 'list', get: 'get', create: 'create', saveSpec: 'saveSpec', rename: 'rename', setWorkspace: 'setWorkspace',
    move: 'move', duplicate: 'duplicate', archive: 'setArchived', delete: 'remove', createFolder: 'createFolder',
    renameFolder: 'renameFolder', deleteFolder: 'removeFolder', dismissNotice: 'dismissNotice', noteWorkspace: 'noteWorkspace',
    workspaces: 'workspaceChoices', createDocument: 'createDocument', getDocument: 'getDocument', saveDocument: 'saveDocument',
    migrate: 'migrate',
  })) handle('wb:' + name, (...args) => whiteboards[method](...args));
  handle('diagrams:getImagePath', src => whiteboards.getImagePath(src));
  whiteboards.onChange(change => { if (window && !window.isDestroyed()) window.webContents.send('sb:evt:wbChanged', change); });
  shells.on('data', (id, chunk) => window?.webContents.send('sb:evt:term', id, chunk));
  shells.on('state', state => window?.webContents.send('sb:evt:termState', state));

  app.whenReady().then(async () => {
    window = new BrowserWindow({ show: false, width: 1440, height: 960,
      webPreferences: { preload: path.join(repo, 'src/preload.js'), offscreen: true, backgroundThrottling: false } });
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Edit', submenu: [
      { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => window.webContents.send('sb:evt:edit', { action: 'selectAll' }) },
    ] }]));
    const errors = [];
    window.webContents.on('console-message', (...args) => {
      // Electron 33+ passes one details object; older ones (event, level, message).
      const details = args[0] && typeof args[0] === 'object' && 'message' in args[0] ? args[0] : { level: args[1], message: args[2] };
      if (details.level === 'error' || details.level === 3) {
        errors.push(String(details.message));
        if (process.env.SWITCHBOARD_WHITEBOARD_DEBUG) console.log('  renderer error: ' + details.message);
      }
    });
    // SWITCHBOARD_WHITEBOARD_DEBUG=1 prints each section as it starts, between the
    // renderer's errors, to tell which step logged them.
    const mark = name => { if (process.env.SWITCHBOARD_WHITEBOARD_DEBUG) console.log('· ' + name); };
    const run = async code => {
      try { return await window.webContents.executeJavaScript(code, true); }
      catch (error) { throw new Error(error.message + '\nRenderer script: ' + code); }
    };
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (code, tries = 200) => {
      for (let i = 0; i < tries; i++) {
        if (await run(code)) return;
        await sleep(20);
      }
      throw new Error('Timed out: ' + code);
    };
    const frames = () => run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    // A canvas whose viewport has stopped moving: the same transform 250ms apart.
    const settled = async slab => {
      let last = null;
      for (let i = 0; i < 40; i++) {
        await sleep(250);
        const now = await run(`document.querySelector(${JSON.stringify(slab + ' .react-flow__viewport')})?.style.transform || ''`);
        if (now && now === last) return;
        last = now;
      }
      throw new Error('The viewport never settled: ' + slab);
    };
    const menuA = () => Menu.getApplicationMenu().items[0].submenu.items[0].click();
    const edit = (action, text) => window.webContents.send('sb:evt:edit', { action, text });
    const q = selector => JSON.stringify(selector);
    const click = label => run(`document.querySelector(${q('[aria-label="' + label + '"]')}).click()`);
    const rect = selector => run(`(() => { const el = document.querySelector(${q(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; })()`);
    // A real press (pointerdown, mousedown, mouseup, click), which Radix menus need.
    const press = async (x, y) => {
      x = Math.round(x); y = Math.round(y);
      window.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      await frames();
    };
    const pressOn = async selector => {
      const r = await rect(selector);
      if (!r) throw new Error('Nothing to press: ' + selector);
      await press(r.left + r.width / 2, r.top + r.height / 2);
    };
    // The rect of the first element matching `selector` whose text includes `text`.
    const rectWithText = (selector, text) => run(`(() => { const el = Array.from(document.querySelectorAll(${q(selector)})).find(e => e.textContent.includes(${q(text)})); if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
    const lines = id => `(() => { const t = SB.views.terminal.xterm(${q(id)}); if (!t) return []; const b = t.buffer.active; return Array.from({ length: b.length }, (_, i) => b.getLine(i).translateToString().trim()); })()`;
    const typeLine = async (id, text) => {
      await run(`SB.views.terminal.xterm(${q(id)}).paste(${q(text)})`);
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    };
    const panel = id => `section.wbterm[data-wb-terminal="${id}"]`;
    const pin = id => `.wbpin[data-wb-terminal="${id}"]`;
    const capture = async name => {
      const dir = process.env.SWITCHBOARD_WHITEBOARD_CAPTURE;
      if (!dir) return;
      await frames();
      await sleep(100);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name + '.png'), (await window.webContents.capturePage()).toPNG());
    };
    const known = [];
    // One named assertion. A name in KNOWN_BUGS is a product bug the integrator is
    // tracking: its failure is reported and the run goes on; its pass fails the run,
    // so the list never outlives the bug.
    const check = async (name, fn) => {
      let failure = null;
      try { await fn(); } catch (error) { failure = error; }
      if (!KNOWN_BUGS.has(name)) { if (failure) throw failure; return; }
      if (!failure) throw new Error(`"${name}" passes now: take it off KNOWN_BUGS`);
      known.push(name);
      console.log(`KNOWN BUG (${name}): ${KNOWN_BUGS.get(name)}\n  ${String(failure.message).split('\n')[0]}`);
    };
    const boardFile = id => JSON.parse(fs.readFileSync(path.join(temp, 'whiteboards', 'boards', id + '.json'), 'utf8'));
    const apiOf = id => `SB.views.whiteboards.api(${q(id)})`;

    try {
      // The store as index.js leaves it: migrated (nothing to move here) before the window.
      assert.equal((await whiteboards.migrate()).ok, true);
      const folder = await whiteboards.createFolder('Example folder');
      assert.equal(folder.ok, true, folder.error);
      const doc = await whiteboards.createDocument('# Example brief\n\nSupporting context.');
      const first = await whiteboards.create({ folderId: folder.data.id, name: 'Example flow', workspace: wsId, spec: { kind: 'flow', nodes: [
        { id: 'start', label: 'Review the design', position: { x: 60, y: 130 } },
        { id: 'brief', label: 'Example brief', shape: 'document', documentId: doc.data.id, position: { x: 340, y: 130 } },
      ], edges: [{ from: 'start', to: 'brief' }] } });
      assert.equal(first.ok, true, first.error);
      // A second board that reads the OTHER workspace: the home lists both.
      const second = await whiteboards.create({ folderId: folder.data.id, name: 'Second flow', workspace: otherId, spec: { kind: 'flow', nodes: [
        { id: 'other', label: 'Another step', position: { x: 60, y: 130 } },
      ], edges: [] } });
      assert.equal(second.ok, true, second.error);
      const boardId = first.data.id;
      const canvas = `.dgslab[data-wb-board="${boardId}"]`;

      await window.loadFile(path.join(repo, 'src/renderer/index.html'));
      await until('SB.state.booted && SB.state.workspaces.length === 2');

      mark('Grid squares saved before the Grid lost its whiteboards');
      // What a square showing a whiteboard saved ('whiteboard', and 'diagrams' from
      // before Whiteboards), the board it showed, and a Changes square beside them.
      // grid.js reads them as it loads, so they go in first and the page loads again —
      // before any terminal is open, so no shell is asked for twice.
      const oldModes = { [wsId]: 'whiteboard', [otherId]: 'diagrams', 'example-elsewhere': 'changes' };
      await run(`localStorage.setItem('switchboard.grid.cellMode', ${q(JSON.stringify(oldModes))}); localStorage.setItem('switchboard.grid.cellBoard', ${q(JSON.stringify({ [wsId]: boardId }))});`);
      await window.loadFile(path.join(repo, 'src/renderer/index.html'));
      await until('SB.state.booted && SB.state.workspaces.length === 2');
      await check('old whiteboard squares are cleared from storage', async () => {
        assert.deepEqual(JSON.parse(await run(`localStorage.getItem('switchboard.grid.cellMode')`)), { 'example-elsewhere': 'changes' });
        assert.equal(await run(`localStorage.getItem('switchboard.grid.cellBoard')`), null);
      });
      assert.deepEqual(opens, [], 'loading the page twice opened no shell');

      mark("the Terminal tab first: its shell is the one a board's panel must show");
      await run(`SB.go({view:'workspace',wsId:${q(wsId)},tab:'terminal'})`);
      await until('!!document.querySelector("#main .xterm-helper-textarea")');
      await run(`window.originalTerm = SB.views.terminal.xterm(${q(wsId)}); window.originalHost = originalTerm.element.parentElement; originalTerm.focus();`);
      await typeLine(wsId, "printf 'from-terminal-tab\\n'");
      await until(`${lines(wsId)}.includes("from-terminal-tab")`);
      assert.deepEqual(opens, [wsId]);
      const startedAt = shells.state(wsId).startedAt;
      assert.ok(startedAt);
      // The workspace header has no Diagrams tab any more.
      await check('workspace tabs without Diagrams', async () => {
        const tabs = await run('Array.from(document.querySelectorAll("#main .seg button")).map(b => b.textContent.trim())');
        assert.ok(tabs.includes('Terminal'), JSON.stringify(tabs));
        assert.equal(tabs.some(t => /diagram|whiteboard/i.test(t)), false, JSON.stringify(tabs));
      });

      mark("the rail's Whiteboards screen and its home list");
      await run('Array.from(document.querySelectorAll("#side .it.top")).find(b => b.textContent.trim() === "Whiteboards").click()');
      await until(`SB.state.route.view === "whiteboards" && !!document.querySelector(${q('#main .wbrow[data-wb-board="' + boardId + '"]')})`);
      await check('home lists the boards and folders', async () => {
        assert.equal(await run('document.querySelector("#main .wbhd h1").textContent'), 'Whiteboards');
        assert.equal(await run('document.querySelector("#main .wbhd .sub").textContent'), '2 whiteboards · 1 folder · 0 archived');
        assert.equal(await run(`!!document.querySelector(${q('#main .wbrow[data-wb-board="' + second.data.id + '"]')})`), true);
        const folderRow = await run(`document.querySelector(${q('#main .frow[data-wb-folder="' + folder.data.id + '"]')})?.textContent`);
        assert.ok(folderRow && folderRow.includes('Example folder') && folderRow.includes('2'), folderRow);
        assert.equal(await run('Array.from(document.querySelectorAll("#side .it.top")).find(b => b.textContent.trim() === "Whiteboards").getAttribute("aria-current")'), 'true');
      });
      await capture('home');

      mark('opening a board');
      await run(`document.querySelector(${q('#main .wbrow[data-wb-board="' + boardId + '"]')}).click()`);
      await until(`SB.state.route.view === "whiteboard" && SB.state.route.board === ${q(boardId)} && !!document.querySelector(${q(canvas + ' [data-id=start]')})`);
      await until('!!document.querySelector("[data-whiteboard-actions]")');
      await check('board header and bar', async () => {
        await until('document.querySelector("#main .wbbhd")?.textContent.includes("Example folder")');
        const crumb = await run('document.querySelector("#main .wbbhd").textContent');
        assert.ok(crumb.includes('Whiteboards') && crumb.includes('Example folder') && crumb.includes('Example flow'), crumb);
        // The old "AI terminal" button is gone from the bar.
        assert.equal(await run('!!document.querySelector("[data-diagram-terminal-toggle], [aria-label=\\"Toggle AI terminal\\"]")'), false);
      });

      mark("Actions ▸ Open terminal… floats this workspace's own shell");
      await pressOn('[data-whiteboard-actions]');
      await until('Array.from(document.querySelectorAll("[role=menuitem]")).some(e => e.textContent.includes("Open terminal"))');
      const menu = await run('Array.from(document.querySelectorAll("[role=menuitem]")).map(e => e.textContent.replace(/⌘A/, "").trim())');
      assert.deepEqual(menu.slice(0, 2), ['Open terminal…', 'Show or hide terminals']);
      const openItem = await rectWithText('[role=menuitem]', 'Open terminal');
      await press(openItem.left + openItem.width / 2, openItem.top + openItem.height / 2);
      await until('!!document.querySelector("[data-workspace-picker] [role=option]")');
      await check('picker lists this board\'s workspace first', async () => {
        assert.equal(await run('document.querySelector("[data-workspace-picker]").getAttribute("aria-label")'), 'Open a terminal in');
        const options = await run('Array.from(document.querySelectorAll("[data-workspace-picker] [role=option] .font-mono")).map(e => e.textContent)');
        assert.deepEqual(options, [wsId, otherId]);
        assert.equal(await run('document.querySelector("[data-workspace-picker] [role=group]").getAttribute("aria-label")'), 'This board\'s workspace');
      });
      await capture('open-terminal-picker');
      const option = await rectWithText('[data-workspace-picker] [role=option]', wsId);
      await press(option.left + option.width / 2, option.top + option.height / 2);
      await until(`!!document.querySelector(${q(panel(wsId) + ' .xterm-helper-textarea')})`);
      await until('!document.querySelector("[data-workspace-picker]")');
      assert.equal(await run(`SB.views.terminal.xterm(${q(wsId)}) === originalTerm`), true, 'the panel shows the Terminal tab\'s xterm');
      assert.equal(await run(`originalHost.closest(${q(panel(wsId))}) !== null && !originalHost.closest(".sbdg")`), true, 'xterm sits outside the React tree');
      assert.equal(await run(`${lines(wsId)}.includes("from-terminal-tab")`), true, 'the panel has the tab\'s scrollback');
      assert.deepEqual(opens, [wsId], 'no second shell was opened');
      assert.equal(shells.state(wsId).startedAt, startedAt);
      await until(`!!document.activeElement.closest(${q(panel(wsId))})`);
      await typeLine(wsId, "printf 'from-the-whiteboard\\n'");
      await until(`${lines(wsId)}.includes("from-the-whiteboard")`);
      await check('panel header names the workspace', async () => {
        const head = await run(`document.querySelector(${q(panel(wsId) + ' .wbterm-hd')}).textContent`);
        assert.ok(head.includes(wsId) && head.includes('project-a'), head);
        assert.equal(await run(`document.querySelector(${q(panel(wsId))}).getAttribute("aria-label")`), wsId + ' terminal');
      });
      await capture('floating-terminal');

      mark("a second workspace's panel, from the tray's +");
      await until('!!document.querySelector(".wbtray:not([hidden]) .wbtray-add")');
      await pressOn('.wbtray-add');
      await until('!!document.querySelector("[data-workspace-picker] [role=option]")');
      // The + is a toggle: pressed again it puts its picker away, rather than closing it
      // on the press and opening a fresh one on the click.
      await check('a second press on the tray\'s + puts its picker away', async () => {
        await pressOn('.wbtray-add');
        await until('!document.querySelector("[data-workspace-picker]")');
        await frames(); await sleep(150);
        assert.equal(await run('!!document.querySelector("[data-workspace-picker]")'), false, 'the picker opened again');
      });
      if (await run('!document.querySelector("[data-workspace-picker]")')) await pressOn('.wbtray-add');
      await until('!!document.querySelector("[data-workspace-picker] [role=option]")');
      const secondOption = await rectWithText('[data-workspace-picker] [role=option]', otherId);
      await press(secondOption.left + secondOption.width / 2, secondOption.top + secondOption.height / 2);
      await until(`!!document.querySelector(${q(panel(otherId) + ' .xterm-helper-textarea')})`);
      await until(`SB.state.shell[${q(otherId)}]?.status === "running"`);
      assert.equal(shells.state(otherId).status, 'running');
      assert.equal(await run(`SB.views.terminal.xterm(${q(otherId)}) !== originalTerm`), true);
      await check('second panel cascades and comes to the front', async () => {
        const [a, b, slab] = [await rect(panel(wsId)), await rect(panel(otherId)), await rect(canvas)];
        // +28/+28 from the last one, clamped inside the slab (the first sits against
        // its right edge, so the step right is what is left of the 16px gap).
        assert.equal(Math.round(b.top - a.top), 28, JSON.stringify([a, b]));
        // The first panel is against the right edge, so the next one steps down and LEFT.
        assert.equal(Math.round(b.left), Math.round(a.left - 28), JSON.stringify([a, b, slab]));
        assert.equal(await run(`document.querySelector(${q(panel(otherId))}).classList.contains("front")`), true);
        assert.equal(await run(`document.querySelector(${q(panel(wsId))}).classList.contains("front")`), false);
      });
      assert.deepEqual(await run('Array.from(document.querySelectorAll(".wbtray .wbchip")).map(c => c.getAttribute("aria-label"))'), [wsId, otherId]);
      await until('document.querySelector("#main .wbbhd .sub").textContent.endsWith("· 2 terminals")');
      const otherStarted = shells.state(otherId).startedAt;
      // Tile: side by side along the right edge, under the bar, above the tray.
      await check('Tile lays the open panels side by side', async () => {
        await click('Tile the open terminals');
        const [a, b, slab] = [await rect(panel(wsId)), await rect(panel(otherId)), await rect(canvas)];
        assert.equal(a.top, b.top, JSON.stringify([a, b]));
        assert.equal(a.width, b.width, JSON.stringify([a, b]));
        assert.equal(Math.round(a.top - slab.top), 64, JSON.stringify([a, slab]));
        // Tile keeps the order they were opened in: the second sits left of the first.
        assert.equal(Math.round(a.left - b.right), 8, JSON.stringify([a, b]));
        assert.equal(Math.round(slab.right - a.right), 16, JSON.stringify([a, slab]));
        const tray = await rect('.wbtray');
        assert.ok(a.bottom <= tray.top && b.bottom <= tray.top, JSON.stringify([a, b, tray]));
      });
      // Pressing the first panel brings it back to the front.
      const firstHead = await rect(panel(wsId) + ' .wbterm-ws');
      await press(firstHead.left + 4, firstHead.top + firstHead.height / 2);
      await until(`document.querySelector(${q(panel(wsId))}).classList.contains("front")`);
      await capture('two-terminals');

      // Resized from an edge: the pty is held for the drag and fitted once on release.
      const cols = await run('originalTerm.cols');
      const before = await rect(panel(wsId));
      const grip = await rect(panel(wsId) + ' .wbterm-rz[data-edge="w"]');
      const gx = Math.round(grip.left + grip.width / 2), gy = Math.round(grip.top + grip.height / 2);
      window.webContents.sendInputEvent({ type: 'mouseDown', x: gx, y: gy, button: 'left', clickCount: 1 });
      window.webContents.sendInputEvent({ type: 'mouseMove', x: gx - 80, y: gy, button: 'left' });
      await until(`document.querySelector(${q(panel(wsId))}).getBoundingClientRect().width === ${before.width + 80}`);
      await frames(); await sleep(120);
      assert.equal(await run('originalTerm.cols'), cols, 'no fit while the edge is held');
      window.webContents.sendInputEvent({ type: 'mouseUp', x: gx - 80, y: gy, button: 'left', clickCount: 1 });
      await until('originalTerm.cols > ' + cols);
      assert.equal((await rect(panel(wsId))).left, before.left - 80);
      // Dragged by its header (not its buttons): it moves, its size stays.
      const head = await rect(panel(wsId) + ' .wbterm-path');
      const hx = Math.round(head.left + 4), hy = Math.round(head.top + head.height / 2);
      const moved = await rect(panel(wsId));
      window.webContents.sendInputEvent({ type: 'mouseDown', x: hx, y: hy, button: 'left', clickCount: 1 });
      window.webContents.sendInputEvent({ type: 'mouseMove', x: hx - 120, y: hy + 30, button: 'left' });
      window.webContents.sendInputEvent({ type: 'mouseUp', x: hx - 120, y: hy + 30, button: 'left', clickCount: 1 });
      await until(`Math.round(document.querySelector(${q(panel(wsId))}).getBoundingClientRect().left) === ${Math.round(moved.left - 120)}`);
      const dragged = await rect(panel(wsId));
      assert.equal(Math.round(dragged.top - moved.top), 30);
      assert.equal(dragged.width, moved.width);
      assert.equal(dragged.height, moved.height);

      mark('minimize to the tray, and back');
      await click('Minimize ' + wsId);
      await until(`!document.querySelector(${q(panel(wsId))}) && !!document.querySelector(${q('.wbchip.min[data-ws="' + wsId + '"]')})`);
      assert.equal(await run(`document.querySelector(${q('.wbchip[data-ws="' + wsId + '"]')}).getAttribute("aria-label")`), wsId + ', minimized');
      assert.equal(shells.state(wsId).startedAt, startedAt, 'minimizing keeps the shell');
      await run(`document.querySelector(${q('.wbchip[data-ws="' + wsId + '"]')}).click()`);
      await until(`!!document.querySelector(${q(panel(wsId) + ' .xterm')}) && !!document.querySelector(${q('.wbchip.on[data-ws="' + wsId + '"]')})`);
      assert.equal(await run(`SB.views.terminal.xterm(${q(wsId)}) === originalTerm && originalTerm.element.parentElement === originalHost`), true);
      assert.deepEqual(opens.filter(id => id === wsId), [wsId]);

      mark('Close leaves the board and the tray; the shell lives on');
      await click('Close ' + otherId);
      await until(`!document.querySelector(${q(panel(otherId))}) && !document.querySelector(${q('.wbchip[data-ws="' + otherId + '"]')})`);
      assert.equal(shells.state(otherId).status, 'running');
      assert.equal(shells.state(otherId).startedAt, otherStarted, 'closing keeps the shell');
      assert.deepEqual(closes, [], 'no whiteboard control closes a shell');

      mark('⌘A: the native Select All shows and hides the terminals, even from an xterm');
      await run('originalTerm.focus()');
      await until(`!!document.activeElement.closest(${q(panel(wsId))})`);
      menuA();
      await until(`!document.querySelector(${q(panel(wsId))}) && document.querySelector(".wbtray").hidden`);
      assert.equal(shells.state(wsId).startedAt, startedAt);
      menuA();
      await until(`!!document.querySelector(${q(panel(wsId) + ' .xterm')})`);
      assert.equal(await run(`SB.views.terminal.xterm(${q(wsId)}) === originalTerm`), true);
      // The renderer key path has the same shortcut.
      await run('document.activeElement.blur()');
      assert.equal(await run('SB.views.whiteboards.onKey({key:"a",metaKey:true,target:document.body})'), true);
      await until(`!document.querySelector(${q(panel(wsId))})`);
      assert.equal(await run('SB.views.whiteboards.onKey({key:"a",metaKey:true,target:document.body})'), true);
      await until(`!!document.querySelector(${q(panel(wsId) + ' .xterm')})`);
      assert.deepEqual(opens.filter(id => id === wsId), [wsId]);
      // And Actions ▸ Show or hide terminals does the same.
      const toggleFromMenu = async () => {
        await pressOn('[data-whiteboard-actions]');
        await until('Array.from(document.querySelectorAll("[role=menuitem]")).some(e => e.textContent.includes("Show or hide terminals"))');
        const item = await rectWithText('[role=menuitem]', 'Show or hide terminals');
        await press(item.left + item.width / 2, item.top + item.height / 2);
        await until('!document.querySelector("[role=menu]")');
      };
      await toggleFromMenu();
      await until(`!document.querySelector(${q(panel(wsId))})`);
      await toggleFromMenu();
      await until(`!!document.querySelector(${q(panel(wsId) + ' .xterm')})`);
      assert.equal(shells.state(wsId).startedAt, startedAt);

      mark('keys, the Edit menu and the bell inside a panel');
      await run('originalTerm.focus(); document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true, cancelable:true}));');
      assert.equal(await run('SB.state.route.view'), 'whiteboard', 'Esc in a terminal never leaves the board');
      edit('paste', 'echo copied-text');
      await until('originalTerm.buffer.active.getLine(originalTerm.buffer.active.cursorY + originalTerm.buffer.active.baseY)?.translateToString().includes("echo copied-text")');
      await run('originalTerm.selectAll()');
      edit('copy');
      for (let i = 0; i < 50 && !clipboard.includes('from-the-whiteboard'); i++) await sleep(20);
      assert.ok(clipboard.includes('from-the-whiteboard'), 'Copy in a panel copies the terminal selection');
      await run('originalTerm.clearSelection()');
      await shells.write(wsId, '\u0003');
      await run(`originalTerm.focus(); SB.bell(${q(wsId)}, true)`);
      assert.equal(await run(`!!SB.state.bell[${q(wsId)}]`), false, 'a ring in the focused panel is read');

      mark('Pin to board: the same xterm, the same grid, laid over the node');
      await run(`window.pinned = { cols: originalTerm.cols, rows: originalTerm.rows }`);
      const pinned = await run('window.pinned');
      const resizesBefore = resizes.length;
      const panelBody = await rect(panel(wsId) + ' .wbterm-body');
      await click('Pin ' + wsId + ' to the whiteboard');
      await until(`!!document.querySelector(${q(pin(wsId) + ' .xterm')}) && !document.querySelector(${q(panel(wsId))})`);
      await until(`!!document.querySelector(${q('[data-terminal-node="' + wsId + '"]')})`);
      await frames();
      assert.equal(await run(`SB.views.terminal.xterm(${q(wsId)}) === originalTerm && originalTerm.element.parentElement === originalHost`), true, 'pinning moves the same xterm');
      assert.deepEqual(await run('({ cols: originalTerm.cols, rows: originalTerm.rows })'), pinned, 'pinning keeps cols/rows');
      assert.deepEqual(opens.filter(id => id === wsId), [wsId], 'pinning never reconnects');
      assert.equal(shells.state(wsId).startedAt, startedAt);
      await check('pinning never resizes the pty', async () => {
        const changed = resizes.slice(resizesBefore).filter(r => r.id === wsId && (r.cols !== pinned.cols || r.rows !== pinned.rows));
        assert.deepEqual(changed, []);
      });
      assert.equal(await run(`${lines(wsId)}.includes("from-the-whiteboard")`), true, 'pinning keeps the scrollback');
      assert.equal(await run(`!!document.querySelector(${q('.wbchip.pin[data-ws="' + wsId + '"]')})`), true);
      // The text did not move: the node is placed so its body (where the live terminal
      // goes) is exactly the panel's body. Its outer rect is that body plus the node's own
      // header and insets, which is why it is not the panel's outer rect.
      await check('pinned terminal lands where the panel\'s text was', async () => {
        const slot = await run(`${apiOf(boardId)}.terminalSlots().find(s => s.wsId === ${q(wsId)})`);
        for (const key of ['left', 'top', 'width', 'height']) assert.ok(Math.abs(slot.body[key] - panelBody[key]) <= 1, `${key}: slot body ${JSON.stringify(slot.body)} panel body ${JSON.stringify(panelBody)}`);
      });
      // The overlay sits on the node's body (the slot), with no transform above xterm.
      const tracks = async label => {
        const slot = await run(`${apiOf(boardId)}.terminalSlots().find(s => s.wsId === ${q(wsId)})`);
        assert.ok(slot && slot.live, label + ': a live slot ' + JSON.stringify(slot));
        const overlay = await rect(pin(wsId));
        for (const key of ['left', 'top', 'width', 'height']) {
          assert.ok(Math.abs(overlay[key] - slot.body[key]) <= 1, `${label}: overlay ${key} ${overlay[key]} vs slot ${slot.body[key]}`);
        }
        const node = await rect(`.react-flow__node:has([data-terminal-node="${wsId}"])`);
        assert.ok(overlay.left >= node.left - 1 && overlay.right <= node.right + 1 && overlay.top >= node.top && overlay.bottom <= node.bottom + 1, `${label}: overlay inside the node ${JSON.stringify({ overlay, node })}`);
        assert.equal(await run(`(() => { for (let el = originalTerm.element; el; el = el.parentElement) { const t = getComputedStyle(el).transform; if (t && t !== 'none') return el.className; } return ''; })()`), '', label + ': no transform above the xterm');
        return { slot, overlay, node };
      };
      const atPin = await tracks('after pinning');
      await capture('pinned-terminal');

      // A pan moves node and overlay together.
      // Somewhere on the bare canvas: a wheel over the terminal scrolls the terminal.
      const spot = await run(`(() => {
        const pane = document.querySelector(${q(canvas + ' .react-flow__pane')}).getBoundingClientRect();
        for (let y = pane.bottom - 60; y > pane.top + 60; y -= 30) {
          for (let x = pane.left + 120; x < pane.right - 60; x += 30) {
            if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x: Math.round(x), y: Math.round(y) };
          }
        }
        return null;
      })()`);
      assert.ok(spot, 'a bare spot on the canvas');
      window.webContents.sendInputEvent({ type: 'mouseWheel', x: spot.x, y: spot.y, deltaX: 0, deltaY: -200, canScroll: true });
      await until(`(() => { const r = document.querySelector(${q(pin(wsId))}).getBoundingClientRect(); return Math.abs(r.top - ${atPin.overlay.top}) > 20; })()`);
      await sleep(120);
      const afterPan = await tracks('after a pan');
      assert.ok(Math.abs((afterPan.overlay.top - atPin.overlay.top) - (afterPan.node.top - atPin.node.top)) <= 1, 'the overlay moves with the node');
      assert.deepEqual(await run('({ cols: originalTerm.cols, rows: originalTerm.rows })'), pinned, 'a pan keeps cols/rows');

      // The canvas's own zoom buttons stay reachable while the tray is up.
      await check('tray leaves the zoom controls clickable', async () => {
        for (const button of ['zoomin', 'zoomout', 'fitview']) {
          const r = await rect(canvas + ' .react-flow__controls-' + button);
          assert.ok(r, button);
          assert.equal(await run(`!!document.elementFromPoint(${r.left + r.width / 2}, ${r.top + r.height / 2})?.closest(".react-flow__controls")`), true,
            `the ${button} button is under ${await run(`document.elementFromPoint(${r.left + r.width / 2}, ${r.top + r.height / 2})?.className`)}`);
        }
      });

      // A pinch (ctrl+wheel) zooms: the font follows, cols/rows (and the pty) stay.
      const fontBefore = await run('originalTerm.options.fontSize');
      const resizesBeforeZoom = resizes.length;
      const pinch = (x, y, deltaY) => window.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY, canScroll: true, modifiers: ['control'] });
      pinch(spot.x, spot.y, -10);
      await until(`Math.abs(originalTerm.options.fontSize - ${fontBefore}) >= 0.75`);
      await sleep(150);
      const fontZoomed = await run('originalTerm.options.fontSize');
      const zoomed = await tracks('after a zoom');
      assert.ok(Math.abs(fontZoomed - Math.round(zoomed.slot.font * 4) / 4) <= 0.75, `font ${fontZoomed} follows the slot's ${zoomed.slot.font}`);
      assert.deepEqual(await run('({ cols: originalTerm.cols, rows: originalTerm.rows })'), pinned, 'a zoom keeps cols/rows');
      // The same pinch the other way, made over the terminal itself: the overlay hands
      // it to the canvas instead of scrolling the scrollback.
      await check('a pinch over the pinned terminal zooms the canvas', async () => {
        const over = await rect(pin(wsId));
        pinch(over.left + over.width / 2, over.top + over.height / 2, 10);
        await until(`Math.abs(originalTerm.options.fontSize - ${fontBefore}) < 0.3`, 50);
      });
      if (Math.abs(await run('originalTerm.options.fontSize') - fontBefore) >= 0.3) {
        pinch(spot.x, spot.y, 10);
        await until(`Math.abs(originalTerm.options.fontSize - ${fontBefore}) < 0.3`);
      }
      await check('zooming never resizes the pty', async () => {
        assert.deepEqual(resizes.slice(resizesBeforeZoom).filter(r => r.id === wsId && (r.cols !== pinned.cols || r.rows !== pinned.rows)), []);
      });
      // Too far out to read: the node shows "Zoom in to use" and lets go of the xterm;
      // its button zooms back to the terminal's own size.
      pinch(spot.x, spot.y, fontZoomed < fontBefore ? -60 : 60);
      await until(`!!document.querySelector(${q('[data-terminal-node="' + wsId + '"] .flow-terminal-zoom')}) && !document.querySelector(${q(pin(wsId))})?.isConnected`);
      await capture('pinned-zoom-floor');
      await run(`document.querySelector(${q('[data-terminal-node="' + wsId + '"] .flow-terminal-zoom')}).click()`);
      await until(`!!document.querySelector(${q(pin(wsId) + ' .xterm')}) && Math.abs(originalTerm.options.fontSize - ${fontBefore}) < 0.3`);
      await sleep(150);
      await tracks('after Zoom in to use');
      assert.equal(await run(`SB.views.terminal.xterm(${q(wsId)}) === originalTerm`), true);
      assert.deepEqual(await run('({ cols: originalTerm.cols, rows: originalTerm.rows })'), pinned, 'the zoom floor keeps cols/rows');
      assert.deepEqual(opens.filter(id => id === wsId), [wsId]);

      // Minimized in place: the node folds to its header and lets go of the xterm.
      await click('Minimize ' + wsId);
      await until(`!document.querySelector(${q(pin(wsId))})?.isConnected && !!document.querySelector(${q('[aria-label="Restore ' + wsId + '"]')})`);
      assert.equal(shells.state(wsId).startedAt, startedAt);
      await click('Restore ' + wsId);
      await until(`!!document.querySelector(${q(pin(wsId) + ' .xterm')})`);
      assert.equal(await run(`SB.views.terminal.xterm(${q(wsId)}) === originalTerm`), true);
      assert.deepEqual(await run('({ cols: originalTerm.cols, rows: originalTerm.rows })'), pinned, 'restoring keeps cols/rows');

      mark('Smaller text and Larger text: the type changes in the same box, and the grid with it');
      const grid = () => run('({ cols: originalTerm.cols, rows: originalTerm.rows })');
      const screenFits = `(() => { const s = originalTerm.element.querySelector('.xterm-screen').getBoundingClientRect(), p = document.querySelector(${q(pin(wsId))}).getBoundingClientRect(); return s.width > 0 && s.right <= p.right + 1 && s.bottom <= p.bottom + 1; })()`;
      const nodeSel = `.react-flow__node:has([data-terminal-node="${wsId}"])`;
      await check('Smaller text fits more rows and columns into the same node', async () => {
        const nodeBefore = await rect(nodeSel);
        const resizesBeforeText = resizes.length;
        await click('Smaller text in ' + wsId);
        await until(`originalTerm.cols > ${pinned.cols} && originalTerm.rows > ${pinned.rows}`);
        await sleep(150);
        const font = await run('originalTerm.options.fontSize');
        assert.ok(font < fontBefore - 0.5, `font ${font} after Smaller text, ${fontBefore} before`);
        const nodeAfter = await rect(nodeSel);
        for (const key of ['width', 'height']) assert.ok(Math.abs(nodeAfter[key] - nodeBefore[key]) <= 1, `the node keeps its ${key}`);
        const now = await grid();
        const told = resizes.slice(resizesBeforeText).filter(r => r.id === wsId);
        assert.ok(told.length >= 1, 'the pty is told the new grid');
        assert.deepEqual({ cols: told[told.length - 1].cols, rows: told[told.length - 1].rows }, now);
        await until(screenFits, 100);
        await tracks('after Smaller text');
        assert.equal(await run(`SB.views.terminal.xterm(${q(wsId)}) === originalTerm`), true, 'the same xterm');
        assert.deepEqual(opens.filter(id => id === wsId), [wsId], 'Smaller text never reconnects');
      });
      await check('a zoom after Smaller text keeps its grid', async () => {
        const kept = await grid();
        const resizesBeforeZoom2 = resizes.length;
        const small = await run('originalTerm.options.fontSize');
        pinch(spot.x, spot.y, -10);
        await until(`Math.abs(originalTerm.options.fontSize - ${small}) >= 0.75`);
        await sleep(150);
        assert.deepEqual(await grid(), kept);
        pinch(spot.x, spot.y, 10);
        await until(`Math.abs(originalTerm.options.fontSize - ${small}) < 0.3`);
        await sleep(150);
        assert.deepEqual(await grid(), kept);
        assert.deepEqual(resizes.slice(resizesBeforeZoom2).filter(r => r.id === wsId && (r.cols !== kept.cols || r.rows !== kept.rows)), []);
      });
      await check('Smaller text is in the board file, and Undo puts the type and the grid back', async () => {
        await run(`${apiOf(boardId)}.flush()`);
        await whiteboards.settle();
        const saved = boardFile(boardId).spec.nodes.find(n => n.shape === 'terminal');
        // Pinned at 12.5px on screen, then a tenth smaller.
        assert.ok(saved && Math.abs(saved.font - 12.5 / atPin.slot.zoom / 1.1) < 0.01, JSON.stringify(saved));
        await click('Undo · ⌘Z');
        await until(`originalTerm.cols === ${pinned.cols} && originalTerm.rows === ${pinned.rows}`);
        await until(`Math.abs(originalTerm.options.fontSize - ${fontBefore}) < 0.3`);
        await until(screenFits, 100);
      });
      await check('Larger text fits fewer, larger rows into the same node', async () => {
        await click('Larger text in ' + wsId);
        await until(`originalTerm.cols < ${pinned.cols} && originalTerm.rows < ${pinned.rows}`);
        await sleep(150);
        assert.ok(await run('originalTerm.options.fontSize') > fontBefore + 0.5);
        await until(screenFits, 100);
        await click('Undo · ⌘Z');
        await until(`originalTerm.cols === ${pinned.cols} && originalTerm.rows === ${pinned.rows}`);
      });
      await capture('pinned-text-size');

      mark('the pinned node is board content: it is in the board file');
      await run(`${apiOf(boardId)}.flush()`);
      await whiteboards.settle();
      await check('pinned node saved in the board file', async () => {
        const stored = boardFile(boardId);
        const node = stored.spec.nodes.find(n => n.shape === 'terminal');
        assert.ok(node, JSON.stringify(stored.spec.nodes));
        assert.equal(node.workspace, wsId);
        assert.equal(node.label, wsId);
        assert.ok(node.size && node.size.width > 0 && node.size.height > 0, JSON.stringify(node));
        assert.ok(typeof node.font === 'number' && node.font > 0, JSON.stringify(node));
        assert.ok(node.position && typeof node.position.x === 'number', JSON.stringify(node));
        assert.notEqual(node.minimized, true);
        // A terminal is not a box in the home's count.
        assert.equal((await whiteboards.get(boardId)).data.boxes, 2);
      });

      mark('Float lifts it out at the same spot, still the same terminal');
      const beforeFloat = (await run(`${apiOf(boardId)}.terminalSlots().find(s => s.wsId === ${q(wsId)})`)).body;
      await click('Float ' + wsId + ' over the whiteboard');
      await until(`!!document.querySelector(${q(panel(wsId) + ' .xterm')}) && !document.querySelector(${q('[data-terminal-node="' + wsId + '"]')})`);
      assert.equal(await run(`!document.querySelector(${q(pin(wsId))})?.isConnected`), true);
      assert.equal(await run(`SB.views.terminal.xterm(${q(wsId)}) === originalTerm && originalTerm.element.parentElement === originalHost`), true);
      assert.deepEqual(opens.filter(id => id === wsId), [wsId], 'floating never reconnects');
      assert.equal(shells.state(wsId).startedAt, startedAt);
      assert.equal(await run(`${lines(wsId)}.includes("from-the-whiteboard")`), true);
      // The inverse of pin: the panel's body covers the rect the text had on the board,
      // so a Pin → Float round trip never drifts or grows the grid.
      await check('floating panel lands where the node\'s text was', async () => {
        const back = await rect(panel(wsId) + ' .wbterm-body');
        for (const key of ['left', 'top', 'width', 'height']) assert.ok(Math.abs(back[key] - beforeFloat[key]) <= 1, `${key}: panel body ${JSON.stringify(back)} slot body ${JSON.stringify(beforeFloat)}`);
      });
      await run(`${apiOf(boardId)}.flush()`);
      await whiteboards.settle();
      assert.equal(boardFile(boardId).spec.nodes.some(n => n.shape === 'terminal'), false, 'floating takes the node off the board');

      mark('Undo and Redo of the Float: the node takes a grid that fits it, the panel lands where the text was');
      // Widened first, so the panel's grid is not the one the node was pinned with.
      const floatCols = await run('originalTerm.cols');
      const wGrip = await rect(panel(wsId) + ' .wbterm-rz[data-edge="w"]');
      const wx = Math.round(wGrip.left + wGrip.width / 2), wy = Math.round(wGrip.top + wGrip.height / 2);
      window.webContents.sendInputEvent({ type: 'mouseDown', x: wx, y: wy, button: 'left', clickCount: 1 });
      window.webContents.sendInputEvent({ type: 'mouseMove', x: wx - 120, y: wy, button: 'left' });
      window.webContents.sendInputEvent({ type: 'mouseUp', x: wx - 120, y: wy, button: 'left', clickCount: 1 });
      await until('originalTerm.cols > ' + floatCols);
      await click('Undo · ⌘Z');
      await until(`!!document.querySelector(${q(pin(wsId) + ' .xterm')}) && !document.querySelector(${q(panel(wsId))})`);
      assert.equal(await run(`SB.views.terminal.xterm(${q(wsId)}) === originalTerm`), true);
      await check('a node put back by Undo shows its whole grid', async () => {
        await until(`(() => { const s = originalTerm.element.querySelector('.xterm-screen').getBoundingClientRect(), p = document.querySelector(${q(pin(wsId))}).getBoundingClientRect(); return s.width > 0 && s.right <= p.right + 1 && s.bottom <= p.bottom + 1; })()`, 100);
      });
      const undoneBody = await rect(pin(wsId) + ' .wbterm-body');
      await click('Redo · ⇧⌘Z');
      await until(`!!document.querySelector(${q(panel(wsId) + ' .xterm')}) && !document.querySelector(${q('[data-terminal-node="' + wsId + '"]')})`);
      await check('a panel put back by Redo lands where the node\'s text was', async () => {
        const back = await rect(panel(wsId) + ' .wbterm-body');
        for (const key of ['left', 'top', 'width', 'height']) assert.ok(Math.abs(back[key] - undoneBody[key]) <= 1, `${key}: panel body ${JSON.stringify(back)} pinned body ${JSON.stringify(undoneBody)}`);
      });
      assert.deepEqual(opens.filter(id => id === wsId), [wsId], 'undo and redo never reconnect');

      mark('Markdown and box labels keep ⌘A as Select All');
      await run('document.querySelector("[data-id=brief]").dispatchEvent(new MouseEvent("dblclick", {bubbles:true}))');
      await until('!!document.querySelector(".flow-document-panel")');
      await run('Array.from(document.querySelectorAll("[role=tab]")).find(b => b.textContent === "Write").click()');
      await until('document.activeElement.classList.contains("flow-document-source")');
      await run('document.activeElement.setSelectionRange(0, 0)');
      menuA();
      await until('document.activeElement.selectionStart === 0 && document.activeElement.selectionEnd === document.activeElement.value.length');
      assert.equal(await run(`!!document.querySelector(${q(panel(wsId) + ' .xterm')})`), true, 'Select All in Markdown leaves the terminals alone');
      await click('Close document');
      await run('document.querySelector("[data-id=start]").dispatchEvent(new MouseEvent("dblclick", {bubbles:true}))');
      await until('document.activeElement.isContentEditable');
      await run('getSelection().collapse(document.activeElement, 0)');
      menuA();
      await check('Select All in a box label selects its text', async () => {
        await until('String(getSelection()).includes("Review the design")', 50);
      });
      assert.equal(await run(`!!document.querySelector(${q(panel(wsId) + ' .xterm')})`), true, 'Select All in a label leaves the terminals alone');
      await run('document.activeElement.blur()');

      mark('full screen keeps the floating terminal on top');
      await click('Full screen');
      await until('!!document.querySelector(\'[aria-label="Exit full screen"]\')');
      await frames();
      await check('panel stays on top in full screen', async () => {
        const r = await rect(panel(wsId));
        assert.ok(r && r.top >= 56, JSON.stringify(r));
        assert.equal(await run(`(() => { const p = document.querySelector(${q(panel(wsId))}), r = p.getBoundingClientRect(); return p.contains(document.elementFromPoint(r.x + 100, r.y + 60)); })()`), true);
      });
      await capture('fullscreen-terminal');
      await click('Exit full screen');
      await until('!document.querySelector(\'[aria-label="Exit full screen"]\')');
      // Leaving full screen re-fits the drawing with a 200ms animation; let it land
      // before the board leaves the screen (see the last check for why).
      await settled(canvas);

      mark('back on the Terminal tab: the same xterm, with what was typed on the board');
      await run(`SB.go({view:'workspace',wsId:${q(wsId)},tab:'terminal'})`);
      await until('document.querySelector("#main .term") === originalHost');
      assert.equal(await run(`${lines(wsId)}.includes("from-the-whiteboard")`), true);
      edit('selectAll');
      await until('originalTerm.hasSelection()');
      await run('originalTerm.clearSelection()');
      assert.deepEqual(opens.filter(id => id === wsId), [wsId]);

      mark('a Grid square: Terminal and Changes, and no whiteboard');
      await run('SB.go({view:"grid"})');
      await until('!!document.querySelector(".gridbd")');
      const square = id => `[data-grid-ws="${id}"]`;
      await check('a Grid square offers Terminal and Changes only', async () => {
        for (const id of [wsId, otherId]) {
          const modes = await run(`Array.from(document.querySelectorAll(${q(square(id) + ' .cellhd .gridmodes button')})).map(b => b.getAttribute('data-grid-mode'))`);
          assert.deepEqual(modes, ['terminal', 'changes'], id);
          const titles = await run(`Array.from(document.querySelectorAll(${q(square(id) + ' .cellhd button')})).map(b => b.title).join(' | ')`);
          assert.doesNotMatch(titles, /whiteboard/i, id);
        }
        assert.equal(await run('!!document.querySelector(".gridbd .dgslab, .gridbd .wbpick, .gridbd [data-wb-terminal]")'), false);
      });
      // Both squares were saved as whiteboards (see the start): they open Terminal, and
      // the first holds the Terminal tab's own xterm — the shell is not asked for again.
      await until(`originalHost.closest(${q(square(wsId))}) && !originalHost.closest(".wbterm")`);
      await check('a square saved as a whiteboard opens Terminal', async () => {
        for (const id of [wsId, otherId]) {
          assert.equal(await run(`document.querySelector(${q(square(id))}).classList.contains('mode-terminal')`), true, id);
          assert.equal(await run(`document.querySelector(${q(square(id) + ' [data-grid-mode=terminal]')}).getAttribute('aria-pressed')`), 'true', id);
        }
      });
      await capture('grid');
      assert.deepEqual(opens.filter(id => id === wsId), [wsId], 'Grid and board share one shell');
      assert.equal(shells.state(wsId).startedAt, startedAt);

      mark('exit and retry inside a panel');
      await run(`SB.go({view:'whiteboard',board:${q(boardId)}})`);
      await until(`!!document.querySelector(${q('#main ' + canvas + ' [data-id=start]')})`);
      // The panel stayed open while the Grid had the shell, and takes it back.
      await until(`!!document.querySelector(${q(panel(wsId) + ' .xterm')})`);
      await shells.close(wsId);
      await until(`!!document.querySelector(${q(panel(wsId) + ' .exit')})`);
      assert.equal(await run(`SB.views.terminal.xterm(${q(wsId)}) === originalTerm`), true);
      refuse = true;
      await run(`document.querySelector(${q(panel(wsId) + ' .exit button')}).click()`);
      await until(`document.querySelector(${q(panel(wsId) + ' .blank')})?.textContent.includes("Example connection failed")`);
      refuse = false;
      await run(`document.querySelector(${q(panel(wsId) + ' .blank button')}).click()`);
      await until(`!!document.querySelector(${q(panel(wsId) + ' .xterm-helper-textarea')})`);
      await until(`SB.state.shell[${q(wsId)}].status === "running"`);
      await run('SB.termTheme.set("dark")');
      await capture('dark-terminal');
      assert.deepEqual(closes, [], 'no whiteboard control closes a shell');

      mark("✦ Answer's Conversation row");
      // Claude Code ready to answer, as main announces it; a conversation of twelve
      // questions kept in the board's own file.
      const cliStatus = provider => ({ ok: true, keysSafe: true,
        settings: { provider, chosen: provider, split: 'auto', context: true, web: false, subtext: true,
          claudeCodeEffort: 'own', claudeApiModel: 'claude-sonnet-5-5', openaiModel: 'gpt-6-luna', openaiEffort: 'medium' },
        providers: [
          { id: 'claude-code', name: 'Claude Code', kind: 'cli', ready: true, state: 'ready', line: 'Installed · signed in', installed: true, signedIn: true,
            efforts: [{ id: 'own', name: 'Its own' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], effort: 'own' },
          { id: 'codex', name: 'Codex', kind: 'cli', ready: true, state: 'ready', line: 'Installed · signed in', installed: true, signedIn: true },
        ] });
      answerStatus = cliStatus('claude-code');
      window.webContents.send('sb:evt:answerStatus', answerStatus);
      const talk = turns => ({ id: '3f9c2a10-5b7d-4e8f-9a1b-2c3d4e5f6a70', workspace: wsId, dir: dirs[wsId],
        startedAt: '2026-10-01T09:00:00.000Z', lastAt: '2026-10-01T09:30:00.000Z', turns });
      assert.equal(boardFile(boardId).workspace, wsId);
      assert.equal((await whiteboards.setConversation(boardId, 'claude-code', talk(12))).ok, true);
      const popover = canvas + ' [data-flow-popover]';
      const rowText = () => run(`(Array.from(document.querySelectorAll(${q(popover + ' div[tabindex="-1"]')})).find(e => e.textContent.startsWith('Conversation'))?.innerText || '').replace(/\\n+/g, ' | ')`);
      const nodeCount = () => run(`document.querySelectorAll(${q(canvas + ' .react-flow__node')}).length`);
      // Main's side, or the page's text, as it settles: `ready` is asked for 2s.
      const waitFor = async (ready, what) => {
        for (let i = 0; i < 100; i++) { if (await ready()) return; await sleep(20); }
        throw new Error('Timed out waiting for ' + what);
      };
      const rowSays = text => waitFor(async () => (await rowText()) === text, 'the row to say ' + text).catch(async () => {
        assert.equal(await rowText(), text);
      });
      const key = keyCode => {
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
        if (keyCode === 'Space') window.webContents.sendInputEvent({ type: 'char', keyCode: ' ' });
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
      };
      // The box selected (as a click does it), then the chevron beside ✦ Answer. Its label
      // was being edited (Select All, above): Done first, so its bar is the box's own.
      const openAnswerMenu = async () => {
        await run(`document.querySelector(${q(canvas + ' [aria-label="Done · Enter"]')})?.click()`);
        await until(`!document.querySelector(${q(canvas + ' [aria-label="Done · Enter"]')})`);
        await run(`(() => { const box = document.querySelector(${q(canvas + ' .react-flow__node[data-id="start"]')}); const r = box.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, view: window, clientX: r.x + 8, clientY: r.y + 8, button: 0, pointerId: 1, isPrimary: true }; for (const [E, type] of [[PointerEvent, 'pointerdown'], [MouseEvent, 'mousedown'], [PointerEvent, 'pointerup'], [MouseEvent, 'mouseup'], [MouseEvent, 'click']]) box.dispatchEvent(new E(type, o)); })()`);
        await until(`!!document.querySelector(${q(canvas + ' [aria-label="Who answers"]')})`);
        await run(`document.querySelector(${q(canvas + ' [aria-label="Who answers"]')}).click()`);
        await until(`!!document.querySelector(${q(popover)})`);
      };
      const closeAnswerMenu = async () => {
        await run(`document.querySelector(${q(canvas + ' [aria-label="Who answers"]')}).click()`);
        await until(`!document.querySelector(${q(popover)})`);
      };
      const pickWorkspace = async id => {
        await run(`Array.from(document.querySelectorAll(${q(popover + ' button')})).find(b => b.textContent.trim() === 'Change…').click()`);
        await until(`!!document.querySelector(${q(popover + ' [data-workspace-picker] [role=option]')})`);
        await run(`Array.from(document.querySelectorAll(${q(popover + ' [data-workspace-picker] [role=option]')})).find(o => o.textContent.includes(${q(id)})).click()`);
        await until(`!document.querySelector(${q(popover + ' [data-workspace-picker]')})`);
        await waitFor(() => boardFile(boardId).workspace === id, 'the board to read ' + id);
      };
      await openAnswerMenu();
      await check('the row counts the questions the board keeps', async () => {
        await rowSays('Conversation | New conversation | 12 questions so far · the next continues it');
      });
      await capture('answer-conversation');

      // Change… to the other workspace and back, in the open menu: main forgot the
      // conversation at the first change, so there is none to continue after the second.
      await pickWorkspace(otherId);
      await pickWorkspace(wsId);
      await check('a workspace changed and changed back leaves nothing to continue', async () => {
        assert.equal(boardFile(boardId).conversations, undefined);
        await rowSays('Conversation | The next answer starts it');
      });
      await closeAnswerMenu();

      // New conversation from the keyboard: the button goes, the row keeps the focus, and
      // the keys that follow are the menu's — Tab no longer adds a box, Enter no longer
      // edits the selected one.
      assert.equal((await whiteboards.setConversation(boardId, 'claude-code', talk(3))).ok, true);
      await openAnswerMenu();
      await rowSays('Conversation | New conversation | 3 questions so far · the next continues it');
      const boxesBefore = await nodeCount();
      await run(`Array.from(document.querySelectorAll(${q(popover + ' button')})).find(b => b.textContent.trim() === 'New conversation').focus()`);
      key('Space');
      await check('New conversation from the keyboard forgets it and keeps the focus in the menu', async () => {
        await waitFor(() => resets.length > 0, 'the reset');
        assert.deepEqual(resets, [[boardId, 'claude-code']]);
        await rowSays('Conversation | The next answer starts it');
        await waitFor(() => boardFile(boardId).conversations === undefined, 'the board file to forget it');
        assert.equal(await run(`!!document.activeElement.closest(${q(popover)})`), true);
      });
      key('Enter');
      await frames();
      key('Tab');
      await frames();
      await sleep(300);
      await check('Enter and Tab after it stay in the menu', async () => {
        assert.equal(await nodeCount(), boxesBefore, 'Tab added no box');
        assert.equal(await run(`!!document.querySelector(${q(popover)})`), true, 'the menu is still open');
        assert.equal(await run('document.activeElement.isContentEditable'), false, 'Enter started no edit');
        assert.equal(await run(`!!document.activeElement.closest(${q(popover)}) && document.activeElement.matches('button, [role=radio]')`), true,
          await run('document.activeElement.outerHTML.slice(0, 120)'));
      });
      await closeAnswerMenu();

      // A CLI too old to keep a conversation here (main says it is alone): its answers
      // each stand alone, and there is nothing to start anew.
      alone = 'codex';
      answerStatus = cliStatus('codex');
      window.webContents.send('sb:evt:answerStatus', answerStatus);
      assert.equal((await whiteboards.setConversation(boardId, 'codex', talk(2))).ok, true);
      await openAnswerMenu();
      await check('a CLI that answers on its own says so', async () => {
        await rowSays('Conversation | Each answer stands alone');
      });
      await closeAnswerMenu();
      alone = null;
      await whiteboards.setConversation(boardId, 'codex', null);
      answerStatus = { ok: true, settings: {}, providers: [], keysSafe: {} };
      window.webContents.send('sb:evt:answerStatus', answerStatus);
      assert.equal(boardFile(boardId).workspace, wsId);

      await check('the renderer logged no errors', async () => {
        assert.deepEqual(errors, []);
      });

      mark('leaving a board while its viewport animates');
      // Exit full screen re-fits with a 200ms animation (FlowEditor's fitKey effect).
      // Leaving the board inside those 200ms detaches the slab, and d3-zoom then
      // interpolates over a zero-sized pane: NaN transforms, and React Flow's
      // Background logs `<circle> attribute r: Expected length, "NaN"` per frame.
      const errorsBefore = errors.length;
      await click('Full screen');
      await until('!!document.querySelector(\'[aria-label="Exit full screen"]\')');
      await settled(canvas);
      await click('Exit full screen');
      await run(`SB.go({view:'workspace',wsId:${q(otherId)},tab:'terminal'})`);
      await sleep(400);
      await run(`SB.go({view:'whiteboard',board:${q(boardId)}})`);
      await until(`!!document.querySelector(${q('#main ' + canvas + ' [data-id=start]')})`);
      await settled(canvas);
      await check('leaving right after full screen keeps the viewport finite', async () => {
        const nan = errors.slice(errorsBefore).filter(line => /NaN/.test(line));
        assert.deepEqual(nan.slice(0, 3), [], `${nan.length} NaN attribute errors`);
        assert.doesNotMatch(await run(`document.querySelector(${q(canvas + ' .react-flow__background circle')})?.getAttribute('r') || ''`), /NaN/);
      });

      console.log('PASS — Whiteboards: rail screen and home, open board, Actions ▸ Open terminal… on the Terminal tab\'s xterm, second panel (cascade, Tile, resize, drag), tray minimize/restore, close keeps the shell, ⌘A and Show or hide terminals, pin (same xterm and cols/rows, overlay tracks pan, pinch and the zoom floor, saved in the board file), float, undo/redo of the float, Markdown/label Select All, full screen, Grid squares without whiteboards (old ones open Terminal), exit and retry, ✦ Answer\'s Conversation row (New conversation from the keyboard, a workspace changed and back, a CLI on its own)' +
        (known.length ? ` (${known.length} known bug${known.length === 1 ? '' : 's'}: ${known.join('; ')})` : ''));
    } catch (error) {
      await capture('failure').catch(() => {});
      console.error(error.stack);
      if (errors.length) console.error('Renderer console errors:\n  ' + errors.join('\n  '));
      process.exitCode = 1;
    } finally {
      await shells.closeAll();
      await whiteboards.settle();
      window.destroy();
      app.exit(process.exitCode || 0);
    }
  });
}
