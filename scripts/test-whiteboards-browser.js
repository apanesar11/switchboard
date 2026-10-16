'use strict';

// Whiteboards in the production renderer: the real preload, index.html, the built
// whiteboard bundle, xterm and a real PTY (SWITCHBOARD_NO_TMUX=1), with this file's
// own main process. Its IPC is stubbed except for the whiteboard store, which is the
// REAL src/main/whiteboards.js rooted beside a temporary SWITCHBOARD_CONFIG. Every
// workspace, folder and board is fictional; no local config, Claude account, tmux
// session or ~/.switchboard is read or written. Every https request the page makes is
// answered here (a video's poster and player from fixtures, anything else a 404), so
// nothing reaches the network.
//
// Covers: the Whiteboards rail screen and its home list; a box resized from its corner
// (kept in the board file, opened again at its size, copied by Tab) and holding words
// well past 200 characters, pasted and typed; a board the whiteboard CLI writes to while
// it is open, drawn at once, not written back, and put back by Undo; a teleport placed
// from the rail and given its destination by a click, a click on one flying the view to
// its destination and Back, Escape while it waits, and its destination deleted and
// undone; a YouTube video — its poster with no player before Play, a link pasted (⌘V)
// as its video at the pointer and named for the title main gives, Undo of it, words
// that are not a link pasted to no effect, a video copied and pasted as the copy, a
// thumbnail dropped as its video and never fetched as a picture, a box typed as a link
// turned into the video by Enter and back by one Undo, a link inside a sentence left as
// words, a click on the poster playing youtube-nocookie's player from its start, a drag
// by its strip (the player letting go of the pointer), the Edit menu declined while the
// player has the keyboard, Open on YouTube and Stop, Enter playing and stopping it, a
// resize keeping 16:9, Tab adding a plain box, and the poster again after the board
// leaves the screen and after full screen, with nothing asked of the network but the
// poster and the player; opening a board, in a tab of the strip (the library pinned
// first, no breadcrumb or status line, a bar of full screen and Actions);
// Actions ▸
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
// back leaving nothing to continue, a CLI that answers on its own); ✦ Answer's Details
// (Low, Medium, High where Subtext and Read the boxes before it were, a pick sent to
// main, an answer at High asked with its level and the boxes before it and drawn 360
// wide, and Undo of it); the rail's Whiteboards row coming back from the Grid to the
// board left open; the Claude gauge at the strip's right end (a poll landing on another
// screen caught up in place when the board shows again, covered by full screen) and in
// the home's header with no board open, gone with the sign-in; the tabs — + and its
// search, ⌃Tab round the library, ⌘W, a middle click, the open set and the board on
// screen after a reload, and ⌘W on the library left to the window; and no renderer
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
  const { app, BrowserWindow, ipcMain, Menu, nativeImage, protocol } = require('electron');
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
  // What the ✦ Answer menu asked main to change, as answer.js would merge it.
  const settingsChanges = [];
  // What ✦ Answer asked whoever answers — main's side stubbed: two boxes, at once.
  const answersAsked = [];
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
  // File ▸ Close that no whiteboard tab took: the window's, recorded, never honoured.
  let windowCloses = 0;
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
  handle('answer:start', (_id, req) => {
    answersAsked.push(req);
    const n = answersAsked.length;
    const paragraph = 'An example paragraph that explains the answer in full sentences. '.repeat(8).trim();
    return { ok: true, files: 0, conversation: null, text: JSON.stringify({ parts: [
      { label: `Example answer ${n}a`, detail: paragraph },
      { label: `Example answer ${n}b`, detail: paragraph },
    ] }) };
  });
  handle('answer:setSettings', patch => {
    settingsChanges.push(patch);
    answerStatus = { ...answerStatus, settings: { ...answerStatus.settings, ...patch } };
    return answerStatus;
  });
  handle('answer:conversation', async boardId => {
    const res = await answer.conversation(boardId, { conversations: conversationStore, lookup: id => (dirs[id] ? workspace(id) : null) });
    // A CLI this Mac has too old to keep one: what answer.js says once a resume is refused.
    return alone && res.ok ? { ...res, data: { ...res.data, [alone]: null }, alone: [alone] } : res;
  });
  handle('answer:resetConversation', (boardId, provider) => {
    resets.push([boardId, provider]);
    return answer.resetConversation(boardId, provider, { conversations: conversationStore });
  });
  handle('ui:closeWindow', () => { windowCloses++; return { ok: true }; });
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
  // A video's title, as main asks YouTube for it: a fictional one, at once. And the
  // pictures and links the bundle hands main, recorded — a YouTube link or thumbnail
  // dropped on a board is its video, never a picture to fetch.
  const videoInfoAsked = [];
  const imagesFetched = [];
  const opened = [];
  handle('diagrams:videoInfo', id => { videoInfoAsked.push(id); return { ok: true, data: { title: 'Example title for ' + id, author: 'Example channel' } }; });
  handle('diagrams:fetchImage', url => { imagesFetched.push(url); return { ok: false, error: 'Example: no pictures here' }; });
  handle('open', url => { opened.push(url); return { ok: true }; });
  // Every https request the page makes, answered here and recorded: a video's poster
  // (YouTube's image server) and its player (youtube-nocookie.com) from fixtures, and
  // anything else a 404 — nothing reaches the network.
  const httpsAsked = [];
  const httpsStrays = [];
  const PLAYER_PAGE = '<!doctype html><meta charset="utf-8"><title>Example player</title><body style="margin:0;background:#111;color:#eee;font:14px sans-serif">Example player</body>';
  whiteboards.onChange(change => { if (window && !window.isDestroyed()) window.webContents.send('sb:evt:wbChanged', change); });
  shells.on('data', (id, chunk) => window?.webContents.send('sb:evt:term', id, chunk));
  shells.on('state', state => window?.webContents.send('sb:evt:termState', state));

  app.whenReady().then(async () => {
    // A poster as YouTube's hqdefault.jpg is one: 480×360, a 16:9 picture letterboxed in
    // black — wider than the 120px grey stand-in it sends for a picture it hasn't got.
    const pixels = Buffer.alloc(480 * 360 * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      const row = Math.floor(i / 4 / 480);
      pixels.set(row >= 45 && row < 315 ? [200, 120, 60, 255] : [0, 0, 0, 255], i);
    }
    const poster = nativeImage.createFromBitmap(pixels, { width: 480, height: 360 }).toJPEG(80);
    protocol.handle('https', request => {
      const url = new URL(request.url);
      httpsAsked.push(request.url);
      if (url.hostname === 'i.ytimg.com' && /^\/vi\/[\w-]{11}\/hqdefault\.jpg$/.test(url.pathname)) {
        return new Response(poster, { headers: { 'content-type': 'image/jpeg' } });
      }
      if (url.hostname === 'www.youtube-nocookie.com' && url.pathname.startsWith('/embed/')) {
        return new Response(PLAYER_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      httpsStrays.push(request.url);
      return new Response('Not in this test', { status: 404 });
    });
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
      // And watched, as index.js does next, so a board written from a terminal
      // (scripts/whiteboard.js) reaches the screen.
      whiteboards.watch();
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

      mark('a box resized from its corner, and words well past 200 characters');
      // A board of its own, made after the home's count, so nothing later sees it.
      const sized = await whiteboards.create({ folderId: null, name: 'Sized flow', workspace: wsId, spec: { kind: 'flow', nodes: [
        { id: 'grow', label: 'Grow this box', position: { x: 60, y: 130 } },
      ], edges: [] } });
      assert.equal(sized.ok, true, sized.error);
      const sizedSlab = `.dgslab[data-wb-board="${sized.data.id}"]`;
      const growNode = `${sizedSlab} .react-flow__node[data-id="grow"]`;
      const nodeSize = sel => run(`(() => { const el = document.querySelector(${q(sel)}); return el ? { width: el.offsetWidth, height: el.offsetHeight } : null; })()`);
      const openSized = async () => {
        await run(`SB.go({view:'whiteboard',board:${q(sized.data.id)}})`);
        await until(`!!document.querySelector(${q(growNode)})`);
        await settled(sizedSlab);
      };
      await openSized();
      const zoom = await run(`Number((document.querySelector(${q(sizedSlab + ' .react-flow__viewport')}).style.transform.match(/scale\\(([^)]+)\\)/) || [])[1])`);
      assert.ok(zoom > 0, String(zoom));
      const unsized = await nodeSize(growNode);
      assert.deepEqual(unsized, { width: 200, height: 52 });
      await pressOn(growNode);
      await check('a selected box shows resize handles on its corners and edges', async () => {
        await until(`document.querySelectorAll(${q(growNode + ' .react-flow__resize-control')}).length === 8`);
      });
      const corner = await rect(growNode + ' .react-flow__resize-control.handle.bottom.right');
      const cx = Math.round(corner.left + corner.width / 2), cy = Math.round(corner.top + corner.height / 2);
      window.webContents.sendInputEvent({ type: 'mouseMove', x: cx, y: cy });
      window.webContents.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 10; i++) window.webContents.sendInputEvent({ type: 'mouseMove', x: cx + 16 * i, y: cy + 8 * i, button: 'left' });
      await frames();
      window.webContents.sendInputEvent({ type: 'mouseUp', x: cx + 160, y: cy + 80, button: 'left', clickCount: 1 });
      await frames();
      await run(`${apiOf(sized.data.id)}.flush()`);
      const resized = await nodeSize(growNode);
      await check('dragging a box\'s corner resizes it, and the board file keeps the size', async () => {
        assert.ok(Math.abs(resized.width - (200 + 160 / zoom)) <= 2, JSON.stringify({ resized, zoom }));
        assert.ok(Math.abs(resized.height - (52 + 80 / zoom)) <= 2, JSON.stringify({ resized, zoom }));
        assert.deepEqual(boardFile(sized.data.id).spec.nodes[0].size, resized);
      });
      await run('SB.go({view:"whiteboards",folder:"all"})');
      await until(`SB.state.route.view === "whiteboards"`);
      await openSized();
      await check('a resized box opens again at its size', async () => {
        assert.deepEqual(await nodeSize(growNode), resized);
      });

      // Pasted then typed: well past the 200 characters a box used to stop at.
      const long = 'A fictional step that needs a paragraph to explain why it waits on the card. '.repeat(8).trim();
      assert.ok(long.length > 600);
      await run(`document.querySelector(${q(growNode)}).dispatchEvent(new MouseEvent("dblclick", {bubbles:true}))`);
      await until('document.activeElement.isContentEditable');
      await run(`(() => { const s = getSelection(); s.selectAllChildren(document.activeElement); s.collapseToEnd(); })()`);
      await run(`(() => { const data = new DataTransfer(); data.setData('text/plain', ${q(' ' + long)}); document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); })()`);
      for (const ch of ' end') window.webContents.sendInputEvent({ type: 'char', keyCode: ch });
      await until(`document.activeElement.textContent.endsWith(' end')`);
      // Enter finishes the edit. (Not blur(): this window never has focus, so Chromium
      // fires no blur event, and the box would go on being edited.)
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      await until(`!document.querySelector(${q(growNode + ' [contenteditable]')})`);
      // Let the box settle at its new height first, as a person would: a save landing in
      // the same frames as a box growing by its last lines can make Chromium log a
      // "ResizeObserver loop" warning (the code before box resizing did too).
      await frames(); await sleep(300);
      await run(`${apiOf(sized.data.id)}.flush()`);
      await check('a box keeps every word past 200 characters, pasted and typed', async () => {
        const saved = boardFile(sized.data.id).spec.nodes[0];
        assert.equal(saved.label, 'Grow this box ' + long + ' end');
        // Its width is still the one it was given; its words make it taller than that.
        const drawn = await nodeSize(growNode);
        assert.equal(drawn.width, resized.width);
        assert.ok(drawn.height > resized.height, JSON.stringify({ drawn, resized }));
        assert.deepEqual(saved.size, resized);
      });
      await check('the box, still selected once its edit ends, shows its handles again', async () => {
        await until(`document.querySelectorAll(${q(growNode + ' .react-flow__resize-control')}).length === 8`);
      });
      await capture('resized-box');

      // Tab adds a box like this one: the same size, as a note's does.
      assert.equal(await run(`document.querySelector(${q(growNode)}).classList.contains('selected')`), true);
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
      await until(`document.querySelectorAll(${q(sizedSlab + ' .react-flow__node')}).length === 2`);
      await check('Tab after a resized box adds one as wide', async () => {
        const child = await run(`(() => { const el = Array.from(document.querySelectorAll(${q(sizedSlab + ' .react-flow__node')})).find(n => n.dataset.id !== 'grow'); return { width: el.offsetWidth, height: el.offsetHeight }; })()`);
        assert.deepEqual(child, resized);
      });
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await frames(); await sleep(300);
      await run(`${apiOf(sized.data.id)}.flush()`);

      mark('a board written from a terminal while it is open');
      // What the whiteboard skill runs: the CLI, as a process of its own, on the same store.
      const whiteboardCli = (args, input) => require('node:child_process').spawnSync(process.execPath, [path.join(repo, 'scripts/whiteboard.js'), ...args], {
        input, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      const fromShow = JSON.parse(whiteboardCli(['show', sized.data.id]).stdout);
      fromShow.spec.nodes.push({ id: 'from-terminal', label: 'Added from a terminal' });
      fromShow.spec.edges.push({ from: 'grow', to: 'from-terminal' });
      const wrote = whiteboardCli(['update', sized.data.id, '-'], JSON.stringify(fromShow));
      assert.equal(wrote.status, 0, wrote.stderr);
      const sizedFile = path.join(temp, 'whiteboards', 'boards', sized.data.id + '.json');
      const written = fs.readFileSync(sizedFile, 'utf8');
      const fromTerminal = `${sizedSlab} .react-flow__node[data-id="from-terminal"]`;
      await check('an open board draws what a terminal wrote to it', async () => {
        await until(`!!document.querySelector(${q(fromTerminal)})`);
        assert.equal(await run(`document.querySelector(${q(fromTerminal)}).textContent`), 'Added from a terminal');
        // Its arrow is drawn once React Flow has measured the box: a frame or more after it.
        await until(`!!document.querySelector(${q(sizedSlab + ' .react-flow__edge[aria-label="Edge from grow to from-terminal"]')})`);
        // The resized box kept its size through the CLI's write.
        assert.equal((await nodeSize(growNode)).width, resized.width);
      });
      await check('the board does not write it straight back', async () => {
        await sleep(1200);
        assert.equal(fs.readFileSync(sizedFile, 'utf8'), written);
      });
      await capture('from-terminal');
      await check('Undo puts back what the board showed before the terminal wrote', async () => {
        await run(`document.querySelector(${q(sizedSlab + ' [aria-label="Undo · ⌘Z"]')}).click()`);
        await until(`!document.querySelector(${q(fromTerminal)})`);
        await run(`${apiOf(sized.data.id)}.flush()`);
        assert.equal(boardFile(sized.data.id).spec.nodes.some(n => n.id === 'from-terminal'), false);
      });
      await run('SB.go({view:"whiteboards",folder:"all"})');
      await until(`SB.state.route.view === "whiteboards" && !!document.querySelector(${q('#main .wbrow[data-wb-board="' + boardId + '"]')})`);

      mark('a teleport: placed, given a destination, clicked, and Back');
      // A board of its own: a box far from the others, a teleport that goes to it, and
      // the rail's Teleport placing another that is given its destination by a click.
      const tele = await whiteboards.create({ folderId: null, name: 'Teleport flow', workspace: wsId, spec: { kind: 'flow', nodes: [
        { id: 'start', label: 'Start here', position: { x: 60, y: 130 } },
        { id: 'jump', label: 'Teleport', shape: 'teleport', teleportTo: 'far', position: { x: 60, y: 260 } },
        { id: 'far', label: 'Far away step', position: { x: 3000, y: 2200 } },
      ], edges: [] } });
      assert.equal(tele.ok, true, tele.error);
      const teleSlab = `.dgslab[data-wb-board="${tele.data.id}"]`;
      const teleNode = id => `${teleSlab} .react-flow__node[data-id="${id}"]`;
      const teleView = () => run(`document.querySelector(${q(teleSlab + ' .react-flow__viewport')}).style.transform`);
      const teleBanner = () => run(`document.querySelector(${q(teleSlab + ' .react-flow__panel.top.center')})?.textContent || ''`);
      await run(`SB.go({view:'whiteboard',board:${q(tele.data.id)}})`);
      await until(`!!document.querySelector(${q(teleNode('far'))})`);
      await settled(teleSlab);
      await check('a teleport says where it goes', async () => {
        assert.equal(await run(`document.querySelector(${q(teleNode('jump'))}).textContent`), 'Teleportto Far away step');
      });
      await capture('teleport-board');

      // The rail's Teleport, then a click on an empty part of the canvas.
      await run(`document.querySelector(${q(teleSlab + ' [aria-label="Teleport (P)"]')}).click()`);
      const telePane = await rect(teleSlab + ' .react-flow__pane');
      await press(telePane.left + telePane.width * 0.72, telePane.top + telePane.height * 0.2);
      await check('a teleport placed from the rail asks where it goes', async () => {
        await until(`!!document.querySelector(${q(teleNode('teleport'))})`);
        assert.equal(await run(`document.querySelector(${q(teleNode('teleport'))}).textContent`), 'TeleportNo destination yet');
        assert.match(await teleBanner(), /Click the box this teleport goes to/);
      });
      await capture('teleport-picking');
      await pressOn(teleNode('start'));
      await run(`${apiOf(tele.data.id)}.flush()`);
      await check('the next node clicked is where it goes, and the board file keeps it', async () => {
        assert.equal(await teleBanner(), '');
        assert.equal(await run(`document.querySelector(${q(teleNode('teleport'))}).textContent`), 'Teleportto Start here');
        assert.equal(await run(`document.querySelector(${q(teleNode('teleport'))}).classList.contains('selected')`), true);
        const saved = boardFile(tele.data.id).spec.nodes.find(n => n.id === 'teleport');
        assert.deepEqual([saved.shape, saved.label, saved.teleportTo], ['teleport', 'Teleport', 'start']);
      });

      // A click on the first teleport flies the view to the far box.
      const teleFrom = await teleView();
      await pressOn(teleNode('jump'));
      await settled(teleSlab);
      await check('a click on a teleport flies to where it goes and selects it', async () => {
        const pane = await rect(teleSlab + ' .react-flow__pane');
        const far = await rect(teleNode('far'));
        assert.ok(Math.abs(far.left + far.width / 2 - (pane.left + pane.width / 2)) <= 2, JSON.stringify({ far, pane }));
        assert.ok(Math.abs(far.top + far.height / 2 - (pane.top + pane.height / 2)) <= 2, JSON.stringify({ far, pane }));
        // From a view zoomed out to fit the board, it lands at life size.
        assert.match(await teleView(), /scale\(1\)/);
        assert.equal(await run(`document.querySelector(${q(teleNode('far'))}).classList.contains('selected')`), true);
        assert.match(await teleBanner(), /Back/);
      });
      await capture('teleport-landed');
      await run(`Array.from(document.querySelectorAll(${q(teleSlab + ' .react-flow__panel.top.center button')})).find(b => b.textContent.trim() === 'Back').click()`);
      await settled(teleSlab);
      await check('Back puts the view where it was and selects the teleport again', async () => {
        assert.equal(await teleView(), teleFrom);
        assert.equal(await run(`document.querySelector(${q(teleNode('jump'))}).classList.contains('selected')`), true);
        assert.equal(await teleBanner(), '');
      });

      // Change destination, then Escape: it still goes where it went.
      await run(`document.querySelector(${q(teleNode('jump') + ' [aria-label="Change destination"]')}).click()`);
      await until(`(document.querySelector(${q(teleSlab + ' .react-flow__panel.top.center')})?.textContent || '').includes('Click the box')`);
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await check('Escape leaves a teleport going where it went', async () => {
        await until(`!(document.querySelector(${q(teleSlab + ' .react-flow__panel.top.center')})?.textContent || '').includes('Click the box')`);
        assert.equal(await run(`document.querySelector(${q(teleNode('jump'))}).textContent`), 'Teleportto Far away step');
      });

      // Enter on the selected teleport goes too; Delete there takes the destination away.
      assert.equal(await run(`document.querySelector(${q(teleNode('jump'))}).classList.contains('selected')`), true);
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      await check('Enter on a selected teleport goes there too', async () => {
        await until(`document.querySelector(${q(teleNode('far'))}).classList.contains('selected')`);
        await settled(teleSlab);
        assert.match(await teleView(), /scale\(1\)/);
      });
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
      await until(`!document.querySelector(${q(teleNode('far'))})`);
      await run(`${apiOf(tele.data.id)}.flush()`);
      await check('a teleport whose destination is deleted has none, in the file too', async () => {
        assert.equal(await run(`document.querySelector(${q(teleNode('jump'))}).textContent`), 'TeleportNo destination yet');
        assert.equal(boardFile(tele.data.id).spec.nodes.find(n => n.id === 'jump').teleportTo, undefined);
      });
      await run(`document.querySelector(${q(teleSlab + ' [aria-label="Undo · ⌘Z"]')}).click()`);
      await run(`${apiOf(tele.data.id)}.flush()`);
      await check('Undo brings the destination back, and the teleport goes there again', async () => {
        await until(`!!document.querySelector(${q(teleNode('far'))})`);
        assert.equal(await run(`document.querySelector(${q(teleNode('jump'))}).textContent`), 'Teleportto Far away step');
        assert.equal(boardFile(tele.data.id).spec.nodes.find(n => n.id === 'jump').teleportTo, 'far');
      });
      await run('SB.go({view:"whiteboards",folder:"all"})');
      await until(`SB.state.route.view === "whiteboards" && !!document.querySelector(${q('#main .wbrow[data-wb-board="' + boardId + '"]')})`);

      mark('a YouTube video: its poster, pasted, copied, dropped, typed; played, dragged, resized; Tab, Enter, off screen');
      // A board of its own: a video already on it (played from 42s), a box to type a link
      // into, one to write a link inside a sentence, and one far off, so the view fitted
      // to the board leaves its middle empty for what is pasted and dropped there.
      const errorsBeforeVideo = errors.length;
      const vid = await whiteboards.create({ folderId: null, name: 'Video flow', workspace: wsId, spec: { kind: 'flow', nodes: [
        { id: 'talk', label: 'Example talk', shape: 'video', videoId: 'exampleVid1', videoStart: 42, position: { x: 340, y: 60 } },
        { id: 'link', label: 'Paste the link here', position: { x: 60, y: 520 } },
        { id: 'prose', label: 'Some words', position: { x: 60, y: 860 } },
        { id: 'later', label: 'Later step', position: { x: 1500, y: 900 } },
      ], edges: [] } });
      assert.equal(vid.ok, true, vid.error);
      const vidSlab = `.dgslab[data-wb-board="${vid.data.id}"]`;
      const vidNode = id => `${vidSlab} .react-flow__node[data-id="${id}"]`;
      const videoCount = n => `document.querySelectorAll(${q(vidSlab + ' .flow-video')}).length === ${n}`;
      const otherVideo = () => run(`Array.from(document.querySelectorAll(${q(vidSlab + ' .react-flow__node')})).filter(n => n.dataset.id !== 'talk' && n.querySelector('.flow-video')).map(n => n.dataset.id)[0]`);
      const players = () => run(`Array.from(document.querySelectorAll(${q(vidSlab + ' iframe')})).map(f => f.getAttribute('src'))`);
      const vidSpec = async () => {
        await run(`${apiOf(vid.data.id)}.flush()`);
        await whiteboards.settle();
        return boardFile(vid.data.id).spec;
      };
      // A node where React Flow draws it, in canvas units; and a canvas point in the window.
      const placed = id => run(`(() => { const n = document.querySelector(${q(vidNode(id))}); if (!n) return null; const m = /translate\\(([-\\d.]+)px, *([-\\d.]+)px\\)/.exec(n.style.transform); return { x: +m[1], y: +m[2], width: n.offsetWidth, height: n.offsetHeight }; })()`);
      const vidView = () => run(`(() => { const box = document.querySelector(${q(vidSlab + ' .react-flow')}).getBoundingClientRect(); const m = /translate\\(([-\\d.]+)px, *([-\\d.]+)px\\) scale\\(([\\d.]+)\\)/.exec(document.querySelector(${q(vidSlab + ' .react-flow__viewport')}).style.transform); return { left: box.left + +m[1], top: box.top + +m[2], zoom: +m[3] }; })()`);
      const onScreen = async point => {
        const v = await vidView();
        return { x: Math.round(v.left + point.x * v.zoom), y: Math.round(v.top + point.y * v.zoom) };
      };
      // Centred on `at` but for the snap to the canvas's grid.
      const centredOn = (box, at) => Math.abs(box.x + box.width / 2 - at.x) <= 20 && Math.abs(box.y + box.height / 2 - at.y) <= 20;
      const keyIn = keyCode => {
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
      };
      const soon = async (ready, what) => {
        for (let i = 0; i < 100; i++) { if (await ready()) return; await sleep(20); }
        throw new Error('Timed out waiting for ' + what);
      };
      // A box's words replaced as ⌘V in its field replaces them; the edit goes on.
      const typeInto = async (id, text) => {
        await run(`document.querySelector(${q(vidNode(id))}).dispatchEvent(new MouseEvent("dblclick", {bubbles:true}))`);
        await until('document.activeElement.isContentEditable');
        await run('getSelection().selectAllChildren(document.activeElement)');
        await run(`(() => { const data = new DataTransfer(); data.setData('text/plain', ${q(text)}); document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); })()`);
        await until(`document.activeElement.textContent === ${q(text)}`);
      };
      const editingHere = `!!document.querySelector(${q(vidSlab + ' [data-flow-text][contenteditable]')})`;
      const askedBefore = httpsAsked.length;
      await run(`SB.go({view:'whiteboard',board:${q(vid.data.id)}})`);
      await until(`!!document.querySelector(${q(vidNode('talk') + ' .flow-video')})`);
      await settled(vidSlab);
      await check('a video shows its poster, and no player', async () => {
        const img = vidNode('talk') + ' .flow-video-poster img';
        await until(`document.querySelector(${q(img)})?.naturalWidth === 480`);
        assert.equal(await run(`document.querySelector(${q(img)}).getAttribute('src')`), 'https://i.ytimg.com/vi/exampleVid1/hqdefault.jpg');
        assert.equal(await run(`document.querySelector(${q(vidNode('talk') + ' .flow-video-poster')}).dataset.pictured`), 'true');
        assert.equal(await run(`document.querySelector(${q(vidNode('talk') + ' .flow-video-head b')}).textContent`), 'Example talk');
        assert.deepEqual(await players(), []);
        // Nothing of YouTube's but the poster's picture before Play.
        assert.deepEqual([...new Set(httpsAsked.slice(askedBefore))], ['https://i.ytimg.com/vi/exampleVid1/hqdefault.jpg']);
      });
      await capture('video-poster');

      // ⌘V of a youtu.be link with the pointer in the board's empty middle (a press there
      // first): the video there, from 1m5s, named for its title; Undo takes it away.
      const middle = { x: 1100, y: 600 };
      const pasteAt = await onScreen(middle);
      await press(pasteAt.x, pasteAt.y);
      edit('paste', 'https://youtu.be/exampleVid2?t=1m5s&si=x');
      await check('⌘V of a YouTube link adds its video at the pointer, named for its title', async () => {
        await until(videoCount(2));
        const id = await otherVideo();
        assert.equal(id, 'youtube-video');
        const box = await placed(id);
        assert.ok(centredOn(box, middle), JSON.stringify({ box, middle }));
        assert.deepEqual([box.width, box.height], [480, 300]);
        assert.equal(await run(`document.querySelector(${q(vidNode(id))}).classList.contains('selected')`), true);
        await until(`document.querySelector(${q(vidNode(id) + ' .flow-video-head b')})?.textContent === 'Example title for exampleVid2'`);
        const saved = (await vidSpec()).nodes.find(n => n.id === id);
        assert.deepEqual({ shape: saved.shape, videoId: saved.videoId, videoStart: saved.videoStart, label: saved.label },
          { shape: 'video', videoId: 'exampleVid2', videoStart: 65, label: 'Example title for exampleVid2' });
        assert.deepEqual(videoInfoAsked, ['exampleVid2']);
      });
      await capture('video-pasted');
      await check('Undo takes the pasted video away', async () => {
        edit('undo');
        await until(videoCount(1));
        assert.equal((await vidSpec()).nodes.some(n => n.videoId === 'exampleVid2'), false);
      });
      await check('⌘V of words that are not one YouTube link adds nothing', async () => {
        const nodes = await run(`document.querySelectorAll(${q(vidSlab + ' .react-flow__node')}).length`);
        edit('paste', 'not a link');
        edit('paste', 'watch https://youtu.be/exampleVid2 later');
        await frames(); await sleep(200);
        assert.equal(await run(`document.querySelectorAll(${q(vidSlab + ' .react-flow__node')}).length`), nodes);
        assert.deepEqual(videoInfoAsked, ['exampleVid2']);
      });

      // ⌘C of a video: its watch link on the clipboard. ⌘V of that back on the board is the
      // copy (its title and start), not a new video asked about again.
      await pressOn(vidNode('talk') + ' .flow-video-head b');
      clipboard = '';
      edit('copy');
      await check('⌘C of a video copies its link, and ⌘V pastes the copy', async () => {
        await soon(() => clipboard !== '', 'the copy');
        assert.equal(clipboard, 'https://www.youtube.com/watch?v=exampleVid1&t=42s');
        const at = await onScreen(middle);
        window.webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
        await frames();
        edit('paste', clipboard);
        await until(videoCount(2));
        const copies = (await vidSpec()).nodes.filter(n => n.shape === 'video');
        assert.deepEqual(copies.map(n => [n.videoId, n.videoStart, n.label]), [['exampleVid1', 42, 'Example talk'], ['exampleVid1', 42, 'Example talk']]);
        await frames(); await sleep(100);
        assert.deepEqual(videoInfoAsked, ['exampleVid2'], 'a copy is not asked about');
        edit('undo');
        await until(videoCount(1));
      });

      // What a thumbnail dragged off YouTube carries: its link (after a comment line), the
      // markup with its <img> on i.ytimg.com, and the link again as text.
      const dropAt = { x: 1100, y: 200 };
      await check('a YouTube thumbnail dropped on the board is its video, never a picture', async () => {
        const at = await onScreen(dropAt);
        await run(`(() => {
          const data = new DataTransfer();
          data.setData('text/uri-list', '# dragged from YouTube\\nhttps://www.youtube.com/watch?v=exampleVid2&list=exampleList&t=2m');
          data.setData('text/html', '<a href="https://www.youtube.com/watch?v=exampleVid2"><img src="https://i.ytimg.com/vi/exampleVid2/hqdefault.jpg"></a>');
          data.setData('text/plain', 'https://www.youtube.com/watch?v=exampleVid2&list=exampleList&t=2m');
          const pane = document.querySelector(${q(vidSlab + ' .react-flow__pane')});
          for (const type of ['dragenter', 'dragover', 'drop']) pane.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: ${at.x}, clientY: ${at.y}, dataTransfer: data }));
        })()`);
        await until(videoCount(2));
        const id = await otherVideo();
        const box = await placed(id);
        assert.ok(centredOn(box, dropAt), JSON.stringify({ box, dropAt }));
        const spec = await vidSpec();
        const saved = spec.nodes.find(n => n.id === id);
        assert.deepEqual([saved.shape, saved.videoId, saved.videoStart], ['video', 'exampleVid2', 120]);
        assert.equal(spec.nodes.some(n => n.shape === 'image'), false);
        assert.deepEqual(imagesFetched, [], 'main was never asked for a picture');
        // The drop ended the drag: the players have the pointer back.
        assert.equal(await run(`!!document.querySelector(${q(vidSlab + ' [data-flow-gesture]')})`), false);
        edit('undo');
        await until(videoCount(1));
      });

      // A box typed as only a watch link is the video once the edit ends — the same node,
      // in one undo step of its own; a link inside a sentence stays words.
      await typeInto('link', 'https://www.youtube.com/watch?v=exampleVid2');
      await check('a box typed as a YouTube link stays words while it is edited', async () => {
        assert.equal(await run(`!!document.querySelector(${q(vidNode('link') + ' .flow-video')})`), false);
      });
      keyIn('Enter');
      await check('Enter turns a box typed as a YouTube link into that video', async () => {
        await until(`!!document.querySelector(${q(vidNode('link') + ' .flow-video')})`);
        assert.equal(await run(editingHere), false);
        await until(`document.querySelector(${q(vidNode('link') + ' .flow-video-head b')})?.textContent === 'Example title for exampleVid2'`);
        const saved = (await vidSpec()).nodes.find(n => n.id === 'link');
        assert.deepEqual({ shape: saved.shape, videoId: saved.videoId, videoStart: saved.videoStart, label: saved.label, size: saved.size },
          { shape: 'video', videoId: 'exampleVid2', videoStart: undefined, label: 'Example title for exampleVid2', size: { width: 480, height: 300 } });
      });
      await settled(vidSlab);
      await capture('video-typed');
      await check('one Undo puts back the box with the link in it', async () => {
        edit('undo');
        await until(`!document.querySelector(${q(vidNode('link') + ' .flow-video')})`);
        assert.equal(await run(`document.querySelector(${q(vidNode('link'))}).textContent`), 'https://www.youtube.com/watch?v=exampleVid2');
        assert.equal(await run(editingHere), false);
        const saved = (await vidSpec()).nodes.find(n => n.id === 'link');
        assert.deepEqual([saved.shape, saved.label], [undefined, 'https://www.youtube.com/watch?v=exampleVid2']);
      });
      await settled(vidSlab);
      await typeInto('prose', 'Watch https://youtu.be/exampleVid1 before the review');
      keyIn('Enter');
      await check('a link inside a sentence stays words', async () => {
        await until(`!${editingHere}`);
        await frames(); await sleep(100);
        assert.equal(await run(`!!document.querySelector(${q(vidNode('prose') + ' .flow-video')})`), false);
        const saved = (await vidSpec()).nodes.find(n => n.id === 'prose');
        assert.deepEqual([saved.shape, saved.label], [undefined, 'Watch https://youtu.be/exampleVid1 before the review']);
      });

      // Played: a click on the poster puts youtube-nocookie's player in its place, from 42s.
      await pressOn(vidNode('talk') + ' .flow-video-poster');
      await check('a click on the poster plays the video in its box, from its start', async () => {
        await until(`document.querySelectorAll(${q(vidSlab + ' iframe')}).length === 1`);
        const [src] = await players();
        assert.ok(src.startsWith('https://www.youtube-nocookie.com/embed/exampleVid1?'), src);
        assert.equal(new URL(src).searchParams.get('start'), '42');
        await soon(() => httpsAsked.includes(src), 'the player to load');
        assert.equal(await run(`!!document.querySelector(${q(vidNode('talk') + ' [aria-label="Stop"]')})`), true);
      });
      await sleep(200);
      await capture('video-playing');
      await check('a playing video is dragged by its strip, the player letting go of the pointer meanwhile', async () => {
        const from = await placed('talk');
        const { zoom } = await vidView();
        const head = await rect(vidNode('talk') + ' .flow-video-head b');
        const hx = Math.round(head.left + 10), hy = Math.round(head.top + head.height / 2);
        window.webContents.sendInputEvent({ type: 'mouseMove', x: hx, y: hy });
        window.webContents.sendInputEvent({ type: 'mouseDown', x: hx, y: hy, button: 'left', clickCount: 1 });
        // A frame between moves, as a hand gives them: moves sent together arrive as one,
        // and React Flow's drag starts on its first move and follows only the next.
        for (let i = 1; i <= 10; i++) {
          window.webContents.sendInputEvent({ type: 'mouseMove', x: hx + 12 * i, y: hy + 6 * i, button: 'left' });
          await frames();
        }
        assert.equal(await run(`getComputedStyle(document.querySelector(${q(vidSlab + ' iframe')})).pointerEvents`), 'none');
        window.webContents.sendInputEvent({ type: 'mouseUp', x: hx + 120, y: hy + 60, button: 'left', clickCount: 1 });
        await frames();
        assert.equal(await run(`getComputedStyle(document.querySelector(${q(vidSlab + ' iframe')})).pointerEvents`), 'auto');
        const to = await placed('talk');
        assert.ok(Math.abs(to.x - from.x - 120 / zoom) <= 20 && Math.abs(to.y - from.y - 60 / zoom) <= 20, JSON.stringify({ from, to, zoom }));
        assert.deepEqual((await vidSpec()).nodes.find(n => n.id === 'talk').position, { x: to.x, y: to.y });
        assert.equal((await players()).length, 1, 'still playing');
      });
      // The player is an <iframe> main never edits in: focused, the Edit menu's ⌘C, ⌘V, ⌘Z
      // and ⌘A are not the canvas's (the video, selected by its drag, is not copied).
      await check('with the player focused, the Edit menu leaves the board alone', async () => {
        await run(`document.querySelector(${q(vidSlab + ' iframe')}).focus()`);
        await until(`document.activeElement?.tagName === 'IFRAME'`);
        const nodes = await run(`document.querySelectorAll(${q(vidSlab + ' .react-flow__node')}).length`);
        const before = JSON.stringify(await vidSpec());
        clipboard = '';
        // Nor does the menu fall back onto the window behind it (app.js's last resort,
        // document.execCommand: a Select All of the whole window). This window never has
        // focus, so the command would select nothing to see: its call is what tells.
        await run('window.__commands = []; document.execCommand = (own => function (command, ...rest) { window.__commands.push(command); return own.call(this, command, ...rest); })(document.execCommand); undefined');
        for (const action of ['copy', 'undo', 'selectAll']) edit(action);
        edit('paste', 'https://youtu.be/exampleVid2');
        await frames(); await sleep(300);
        assert.deepEqual(await run('window.__commands'), []);
        await run('delete document.execCommand; undefined');
        assert.equal(clipboard, '');
        assert.equal(await run(`document.querySelectorAll(${q(vidSlab + ' .react-flow__node')}).length`), nodes);
        assert.equal(JSON.stringify(await vidSpec()), before);
        assert.equal(await run(`${apiOf(vid.data.id)}.editAction('paste', false, 'https://youtu.be/exampleVid2')`), false);
        // ⌘A is not the board's Show or hide terminals either.
        assert.equal(await run('SB.views.whiteboards.toggleTerminalShortcut()'), false);
        assert.equal(await run('document.activeElement.tagName'), 'IFRAME');
        await run(`document.querySelector(${q(vidSlab + ' iframe')}).blur()`);
      });
      await check('Open on YouTube hands main its watch link, and Stop puts the poster back', async () => {
        await pressOn(vidNode('talk') + ' [aria-label="Open on YouTube"]');
        await soon(() => opened.length > 0, 'the link');
        assert.deepEqual(opened, ['https://www.youtube.com/watch?v=exampleVid1&t=42s']);
        assert.equal((await players()).length, 1);
        await pressOn(vidNode('talk') + ' [aria-label="Stop"]');
        await until(`document.querySelectorAll(${q(vidSlab + ' iframe')}).length === 0`);
        assert.equal(await run(`!!document.querySelector(${q(vidNode('talk') + ' .flow-video-poster')})`), true);
      });
      await pressOn(vidNode('talk') + ' .flow-video-head b');
      await check('Enter plays the selected video, and Enter again stops it', async () => {
        assert.deepEqual(await players(), []);
        keyIn('Enter');
        await until(`document.querySelectorAll(${q(vidSlab + ' iframe')}).length === 1`);
        keyIn('Enter');
        await until(`document.querySelectorAll(${q(vidSlab + ' iframe')}).length === 0`);
      });
      await check('a video resized from its corner keeps its player 16:9 under the strip', async () => {
        const grip = vidNode('talk') + ' .react-flow__resize-control.handle.bottom.right';
        await until(`!!document.querySelector(${q(grip)})`);
        const { zoom } = await vidView();
        const before = await placed('talk');
        const corner = await rect(grip);
        const cx = Math.round(corner.left + corner.width / 2), cy = Math.round(corner.top + corner.height / 2);
        window.webContents.sendInputEvent({ type: 'mouseMove', x: cx, y: cy });
        window.webContents.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 });
        for (let i = 1; i <= 10; i++) window.webContents.sendInputEvent({ type: 'mouseMove', x: cx + 12 * i, y: cy + 3 * i, button: 'left' });
        await frames();
        window.webContents.sendInputEvent({ type: 'mouseUp', x: cx + 120, y: cy + 30, button: 'left', clickCount: 1 });
        await frames();
        const { size } = (await vidSpec()).nodes.find(n => n.id === 'talk');
        // Within the canvas's 10px grid, which the corner snaps to.
        assert.ok(Math.abs(size.width - (before.width + 120 / zoom)) <= 10, JSON.stringify({ before, size, zoom }));
        assert.equal(size.height, Math.round(size.width * 9 / 16) + 30);
        const drawn = await placed('talk');
        assert.deepEqual({ width: drawn.width, height: drawn.height }, size);
      });
      await capture('video-resized');
      await check('Tab after a video adds a plain box beside it', async () => {
        const nodes = await run(`document.querySelectorAll(${q(vidSlab + ' .react-flow__node')}).length`);
        keyIn('Tab');
        await until(`document.querySelectorAll(${q(vidSlab + ' .react-flow__node')}).length === ${nodes + 1}`);
        await until('document.activeElement.isContentEditable');
        const child = await run(`Array.from(document.querySelectorAll(${q(vidSlab + ' .react-flow__node')})).find(n => n.contains(document.activeElement)).dataset.id`);
        assert.equal(await run(`!!document.querySelector(${q(vidNode(child) + ' .flow-video')})`), false);
        assert.equal((await placed(child)).width, 200);
        for (const ch of 'Next step') window.webContents.sendInputEvent({ type: 'char', keyCode: ch });
        await until(`document.activeElement.textContent === 'Next step'`);
        keyIn('Enter');
        await until(`!${editingHere}`);
        // Settled at its height first, as the box with 600+ characters above is: a save in
        // the frames it grows in can make Chromium log a "ResizeObserver loop" warning.
        await frames(); await sleep(300);
        const spec = await vidSpec();
        const saved = spec.nodes.find(n => n.id === child);
        assert.deepEqual([saved.shape, saved.label, saved.size], [undefined, 'Next step', undefined]);
        assert.ok(spec.edges.some(e => e.from === 'talk' && e.to === child), JSON.stringify(spec.edges));
      });
      await settled(vidSlab);

      // Off screen a video is its poster again: the page takes the player out with the
      // board, and put back it would load again and play out loud from the start.
      await pressOn(vidNode('talk') + ' .flow-video-poster');
      await until(`document.querySelectorAll(${q(vidSlab + ' iframe')}).length === 1`);
      await check('a video playing when its board leaves the screen is its poster when it comes back', async () => {
        const loads = httpsAsked.filter(url => url.startsWith('https://www.youtube-nocookie.com/')).length;
        await run('SB.go({view:"whiteboards",folder:"all"})');
        await until('SB.state.route.view === "whiteboards"');
        await run(`SB.go({view:'whiteboard',board:${q(vid.data.id)}})`);
        await until(`!!document.querySelector(${q('#main ' + vidNode('talk') + ' .flow-video-poster')})`);
        await frames(); await sleep(200);
        assert.deepEqual(await players(), []);
        assert.equal(httpsAsked.filter(url => url.startsWith('https://www.youtube-nocookie.com/')).length, loads, 'the player never loaded again');
      });
      await settled(vidSlab);
      await check('full screen, in and out, puts the poster back', async () => {
        await pressOn(vidNode('talk') + ' .flow-video-poster');
        await until(`document.querySelectorAll(${q(vidSlab + ' iframe')}).length === 1`);
        await run(`document.querySelector(${q(vidSlab + ' [aria-label="Full screen"]')}).click()`);
        await until(`!!document.querySelector(${q('body > .dgslab.full[data-wb-board="' + vid.data.id + '"]')})`);
        await frames();
        assert.deepEqual(await players(), []);
        await settled(vidSlab);
        await pressOn(vidNode('talk') + ' .flow-video-poster');
        await until(`document.querySelectorAll(${q(vidSlab + ' iframe')}).length === 1`);
        await run(`document.querySelector(${q(vidSlab + ' [aria-label="Exit full screen"]')}).click()`);
        await until('!document.querySelector("body > .dgslab.full")');
        await frames();
        assert.deepEqual(await players(), []);
      });
      await settled(vidSlab);
      await check('the video stage asked nothing of the network but posters and the player, and logged no errors', async () => {
        assert.deepEqual(httpsStrays, []);
        const asked = [...new Set(httpsAsked.slice(askedBefore))];
        assert.deepEqual(asked.filter(url => !/^https:\/\/i\.ytimg\.com\/vi\/exampleVid[12]\/hqdefault\.jpg$/.test(url) && !url.startsWith('https://www.youtube-nocookie.com/embed/exampleVid1?')), [], JSON.stringify(asked));
        assert.deepEqual(errors.slice(errorsBeforeVideo), []);
      });
      await run('SB.go({view:"whiteboards",folder:"all"})');
      await until(`SB.state.route.view === "whiteboards" && !!document.querySelector(${q('#main .wbrow[data-wb-board="' + boardId + '"]')})`);

      mark('opening a board');
      await run(`document.querySelector(${q('#main .wbrow[data-wb-board="' + boardId + '"]')}).click()`);
      await until(`SB.state.route.view === "whiteboard" && SB.state.route.board === ${q(boardId)} && !!document.querySelector(${q(canvas + ' [data-id=start]')})`);
      await until('!!document.querySelector("[data-whiteboard-actions]")');
      await check('tab strip and bar', async () => {
        // The board's tab is the one on screen, its folder under its name; the library
        // is the pinned first tab, and every board opened so far has a tab.
        await until('document.querySelector("#main .wbstrip .wbtab.on")?.textContent.includes("Example folder")');
        assert.equal(await run('document.querySelector("#main .wbstrip .wbtab.on .nm").textContent'), 'Example flow');
        const tabs = await run('Array.from(document.querySelectorAll("#main .wbstrip .wbtab .nm")).map(e => e.textContent)');
        assert.equal(tabs[0], 'Whiteboards', JSON.stringify(tabs));
        for (const name of ['Sized flow', 'Teleport flow', 'Example flow']) assert.ok(tabs.includes(name), JSON.stringify(tabs));
        // No breadcrumb, title or status line above the board.
        assert.equal(await run('!!document.querySelector("#main .wbbhd, #main .crumb, #main h1")'), false);
        assert.equal(await run('/Saved locally/.test(document.querySelector("#main").textContent)'), false);
        // The bar is full screen and Actions: no switcher, arrows or New whiteboard.
        assert.equal(await run(`!!document.querySelector(${q(canvas + ' [aria-label="Full screen"]')})`), true);
        assert.equal(await run(`!!document.querySelector(${q(canvas + ' [data-whiteboard-actions]')})`), true);
        assert.equal(await run('!!document.querySelector(\'[aria-label^="Switch whiteboard"], [aria-label^="Previous whiteboard"], [aria-label^="Next whiteboard"]\')'), false);
        assert.equal(await run(`Array.from(document.querySelectorAll(${q(canvas + ' button')})).some(b => /New whiteboard/.test(b.textContent))`), false);
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

      mark("the rail's Whiteboards row: back to the board left for the Terminal tab and the Grid");
      await check('back from the Grid to the board left open', async () => {
        await run('Array.from(document.querySelectorAll("#side .it.top")).find(b => b.textContent.trim() === "Whiteboards").click()');
        await until(`SB.state.route.view === "whiteboard" && SB.state.route.board === ${q(boardId)}`);
        await until(`!!document.querySelector(${q('#main ' + canvas + ' [data-id=start]')})`);
        assert.equal(await run('document.querySelector("#main .wbstrip .wbtab.on .nm").textContent'), 'Example flow');
      });

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
        settings: { provider, chosen: provider, split: 'auto', details: 'low', web: false,
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

      // Details: three levels under Answer as, Low unless changed; the two switches it
      // replaced — Subtext, Read the boxes before it — are gone, both always on now.
      const details = popover + ' [role=radiogroup][aria-label="Details"]';
      const detailsSays = () => run(`(() => { const group = document.querySelector(${q(details)}); return group ? { levels: Array.from(group.querySelectorAll('[role=radio]')).map(b => b.textContent.trim() + (b.getAttribute('aria-checked') === 'true' ? '*' : '')), hint: group.nextElementSibling?.textContent.trim() } : null; })()`);
      await check('Details offers Low, Medium and High, Low first, in place of the two switches', async () => {
        assert.deepEqual(await detailsSays(), { levels: ['Low*', 'Medium', 'High'], hint: 'A few words, and a short line when it helps' });
        const menuText = await run(`document.querySelector(${q(popover)}).textContent`);
        assert.doesNotMatch(menuText, /Subtext|Read the boxes before it/);
        assert.match(menuText, /Web access/);
      });
      await run(`Array.from(document.querySelectorAll(${q(details + ' [role=radio]')})).find(b => b.textContent.trim() === 'High').click()`);
      await check('picking High tells main, and the menu says what High gives', async () => {
        await waitFor(() => settingsChanges.length > 0, 'the change');
        assert.deepEqual(settingsChanges, [{ details: 'high' }]);
        await waitFor(async () => (await detailsSays())?.levels[2] === 'High*', 'High to be checked');
        assert.deepEqual(await detailsSays(), { levels: ['Low', 'Medium', 'High*'], hint: 'A full paragraph under each box' });
      });
      await capture('answer-details-high');
      await run(`Array.from(document.querySelectorAll(${q(details + ' [role=radio]')})).find(b => b.textContent.trim() === 'Low').click()`);
      await waitFor(() => settingsChanges.length === 2, 'the change back');
      await waitFor(async () => (await detailsSays())?.levels[0] === 'Low*', 'Low to be checked');

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

      // ✦ Answer at High, from the toolbar: the question goes with the level as its last
      // line and the boxes leading up to it, and the answer's boxes are drawn wide. Undo
      // takes each answer off again. Last in this section, as the answers move the view.
      answerStatus = { ...answerStatus, settings: { ...answerStatus.settings, details: 'high' } };
      window.webContents.send('sb:evt:answerStatus', answerStatus);
      const nodesBefore = await nodeCount();
      const selectBox = id => run(`(() => { const box = document.querySelector(${q(canvas + ' .react-flow__node[data-id="' + id + '"]')}); const r = box.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, view: window, clientX: r.x + 8, clientY: r.y + 8, button: 0, pointerId: 1, isPrimary: true }; for (const [E, type] of [[PointerEvent, 'pointerdown'], [MouseEvent, 'mousedown'], [PointerEvent, 'pointerup'], [MouseEvent, 'mouseup'], [MouseEvent, 'click']]) box.dispatchEvent(new E(type, o)); })()`);
      const answerButton = `Array.from(document.querySelectorAll(${q(canvas + ' button')})).find(b => b.textContent.trim() === 'Answer')`;
      const answerBoxes = () => run(`Array.from(document.querySelectorAll(${q(canvas + ' .react-flow__node')})).filter(n => n.textContent.includes('Example answer')).map(n => ({ id: n.dataset.id, width: n.offsetWidth }))`);
      await selectBox('start');
      await waitFor(async () => run(`!!${answerButton}`), 'the question\'s toolbar');
      await run(`${answerButton}.click()`);
      await check('✦ Answer at High asks with the level last, and draws its boxes 360 wide', async () => {
        await waitFor(() => answersAsked.length === 1, 'the question');
        const [req] = answersAsked;
        assert.equal(req.provider, 'codex');
        assert.match(req.system, /about 90 to 160 words/);
        assert.match(req.user, /^The question box: Review the design$/m);
        assert.match(req.user.split('\n').pop(), /^Details: High\./);
        await waitFor(async () => (await nodeCount()) === nodesBefore + 2, 'the two answers');
        const boxes = await answerBoxes();
        assert.deepEqual(boxes.map(b => b.width), [360, 360]);
        await run(`${apiOf(boardId)}.flush()`);
        const saved = boardFile(boardId).spec.nodes.filter(n => n.label.startsWith('Example answer'));
        assert.deepEqual(saved.map(n => n.size?.width), [360, 360]);
        assert.ok(saved.every(n => n.detail.length > 500), 'a paragraph is kept whole');
      });
      await capture('answer-details-boxes');
      // A question asked from an answer goes with the boxes leading up to it — always.
      // Both answers land selected (so the bar offers Condense): the question first, then
      // the one answer, so that is all that is selected.
      const [firstAnswer] = await answerBoxes();
      await selectBox('start');
      await frames();
      await selectBox(firstAnswer.id);
      await waitFor(async () => run(`!!${answerButton}`), 'the answer box\'s toolbar');
      await run(`${answerButton}.click()`);
      await check('a question further along sends the boxes before it', async () => {
        await waitFor(() => answersAsked.length === 2, 'the second question');
        assert.match(answersAsked[1].user, /^Boxes leading to the question, first to last:\n- Review the design\n/m);
        assert.match(answersAsked[1].user, /^The question box: Example answer 1a$/m);
        await waitFor(async () => (await nodeCount()) === nodesBefore + 4, 'the second answer');
      });
      for (const left of [nodesBefore + 2, nodesBefore]) {
        await run(`document.querySelector(${q(canvas + ' [aria-label="Undo · ⌘Z"]')}).click()`);
        await waitFor(async () => (await nodeCount()) === left, 'Undo to take an answer off');
      }
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

      mark("the Claude gauge on the strip: a poll off screen caught up in place, and under full screen");
      // views/usage.js's five-hour gauge, the Grid header's, sent the way main sends every
      // poll (sb:evt:usage). Fictional numbers; no reset time, so the gauge reads "N%".
      const usageAnswer = percent => ({ ok: true, configured: true, plan: 'Example plan', fetchedAt: Date.now(),
        session: { name: 'Session', percent, resetsAt: null, severity: percent >= 90 ? 'critical' : 'normal' },
        weekly: { name: 'This week', percent: 20, resetsAt: null, severity: 'normal' }, scoped: [] });
      const errorsBeforeGauge = errors.length;
      await check('the Claude gauge on a board', async () => {
        const gauge = '#main .wbstrip .gauge';
        window.webContents.send('sb:evt:usage', usageAnswer(72));
        await until(`document.querySelector(${q(gauge)})?.textContent === "72%"`);
        assert.equal(await run('document.querySelectorAll(".gauge").length'), 1);
        // A poll that lands while another screen shows finds the board's strip off the
        // page; back on the board the same strip — never swapped for new numbers — and
        // the same gauge say the new ones.
        await run(`window.__wbStrip = document.querySelector("#main .wbstrip"); window.__wbGauge = document.querySelector(${q(gauge)})`);
        await run(`SB.go({view:'usage'})`);
        await until('SB.state.route.view === "usage" && !window.__wbStrip.isConnected');
        window.webContents.send('sb:evt:usage', usageAnswer(93));
        await until('document.querySelector("#main .ulim .pct")?.textContent === "93%"');
        assert.equal(await run('window.__wbGauge.textContent'), '72%');
        await run(`SB.go({view:'whiteboard',board:${q(boardId)}})`);
        await until(`!!document.querySelector(${q('#main ' + canvas)})`);
        assert.equal(await run(`document.querySelector(${q(gauge)})?.textContent`), '93%');
        assert.equal(await run(`document.querySelector(${q(gauge)}).classList.contains("critical")`), true);
        assert.equal(await run('document.querySelector("#main .wbstrip") === window.__wbStrip'), true);
        assert.equal(await run(`document.querySelector(${q(gauge)}) === window.__wbGauge`), true);
        // A sign-out takes the gauge away in place; the next good answer brings it back
        // to the board.
        window.webContents.send('sb:evt:usage', { ok: false, configured: false, reason: 'no-login', error: 'Example: not signed in' });
        await until(`!document.querySelector(${q(gauge)})`);
        window.webContents.send('sb:evt:usage', usageAnswer(50));
        await until(`document.querySelector(${q(gauge)})?.textContent === "50%"`);
        // The tabs are measured again when the gauge changes width in place: "N open"
        // shows while it squeezes tabs out of sight, and goes once they are back.
        await frames();
        assert.equal(await run('document.querySelector("#main .wbstrip").classList.contains("ovf")'), false);
        await run(`document.querySelector(${q(gauge)}).style.width = "1200px"`);
        await until('document.querySelector("#main .wbstrip").classList.contains("ovf")');
        await run(`document.querySelector(${q(gauge)}).style.width = ""`);
        await until('!document.querySelector("#main .wbstrip").classList.contains("ovf")');
        // Full screen covers the strip, and the gauge with it.
        await click('Full screen');
        await until('!!document.querySelector(\'[aria-label="Exit full screen"]\')');
        await settled(canvas);
        assert.equal(await run(`(() => { const r = document.querySelector(${q(gauge)}).getBoundingClientRect(); return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("body > .dgslab.full"); })()`), true);
        await click('Exit full screen');
        await until('!document.querySelector(\'[aria-label="Exit full screen"]\')');
        await settled(canvas);
        assert.deepEqual(errors.slice(errorsBeforeGauge), []);
      });

      mark('tabs: + and its search, ⌃Tab, ⌘W, a middle click, a reload, and every tab closed');
      const errorsBeforeTabs = errors.length;
      const tabIds = () => run('Array.from(document.querySelectorAll("#main .wbtl .wbtab")).map(t => t.getAttribute("data-wb-tab"))');
      const keyPress = (keyCode, modifiers = []) => {
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      };
      await check('whiteboard tabs', async () => {
        // + : a search over every board; Enter opens the one picked in a new tab, at the end.
        await pressOn('#main .wbadd');
        await until('!!document.querySelector(".wbpop.wbfind .wbfq")');
        assert.equal(await run('document.activeElement === document.querySelector(".wbfind .wbfq")'), true);
        await run(`(() => { const i = document.querySelector('.wbfind .wbfq'); i.value = 'second'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await until('document.querySelector(".wbfind .wbfr.hi .nm")?.textContent === "Second flow"');
        keyPress('Enter');
        await until(`SB.state.route.view === "whiteboard" && SB.state.route.board === ${q(second.data.id)}`);
        await until('!document.querySelector(".wbpop")');
        const ids = await tabIds();
        assert.equal(ids[ids.length - 1], second.data.id, JSON.stringify(ids));
        // A board made somewhere else — a terminal, another window — is in an open + at
        // once: the board screen is redrawn for it, and the picker as the list comes in.
        await pressOn('#main .wbadd');
        await until('!!document.querySelector(".wbpop.wbfind")');
        const elsewhere = await whiteboards.create({ folderId: null, name: 'Made elsewhere', workspace: wsId, spec: { kind: 'flow', nodes: [], edges: [] } });
        assert.equal(elsewhere.ok, true, elsewhere.error);
        await until('Array.from(document.querySelectorAll(".wbfind .wbfr .nm")).some(e => e.textContent === "Made elsewhere")');
        keyPress('Escape');
        await until('!document.querySelector(".wbpop")');
        assert.equal(await run('SB.state.route.view'), 'whiteboard');
        // ⌃Tab goes round every tab, the library among them: from the last board, the
        // library; from the library, the first board.
        keyPress('Tab', ['control']);
        await until('SB.state.route.view === "whiteboards"');
        assert.equal(await run('document.querySelector("#main .wbstrip .wbtab.on").classList.contains("wblib")'), true);
        keyPress('Tab', ['control']);
        await until(`SB.state.route.board === ${q(ids[0])}`);
        // ⌘W: the tab on screen closes and the one to its right comes up; not the window.
        edit('close');
        await until(`SB.state.route.board === ${q(ids[1])}`);
        assert.equal((await tabIds()).includes(ids[0]), false);
        assert.equal(windowCloses, 0);
        // A middle click closes the tab under it, not the one on screen.
        const last = await rect(`#main .wbtl .wbtab[data-wb-tab="${second.data.id}"]`);
        const mx = Math.round(last.left + last.width / 2), my = Math.round(last.top + last.height / 2);
        window.webContents.sendInputEvent({ type: 'mouseMove', x: mx, y: my });
        window.webContents.sendInputEvent({ type: 'mouseDown', x: mx, y: my, button: 'middle', clickCount: 1 });
        window.webContents.sendInputEvent({ type: 'mouseUp', x: mx, y: my, button: 'middle', clickCount: 1 });
        await until(`!Array.from(document.querySelectorAll("#main .wbtl .wbtab")).some(t => t.getAttribute("data-wb-tab") === ${q(second.data.id)})`);
        assert.equal(await run('SB.state.route.board'), ids[1]);
        // A reload (the window opened again) brings the tabs back, in their order, and
        // the board that was on screen.
        const before = await tabIds();
        await window.loadFile(path.join(repo, 'src/renderer/index.html'));
        await until('SB.state.booted && SB.state.workspaces.length === 2');
        await until(`SB.state.route.view === "whiteboard" && SB.state.route.board === ${q(ids[1])}`);
        await until('document.querySelectorAll("#main .wbtl .wbtab").length > 0');
        assert.deepEqual(await tabIds(), before);
        // ⌃Tab from a full-screen board carries full screen to the next one, even one
        // whose canvas the reload has not made yet.
        await until(`!!document.querySelector(${q('#main .dgslab[data-wb-board="' + before[0] + '"] [aria-label="Full screen"]')})`);
        await click('Full screen');
        await until('!!document.querySelector(\'[aria-label="Exit full screen"]\')');
        keyPress('Tab', ['control']);
        await until(`SB.state.route.board === ${q(before[1])}`);
        await until(`!!document.querySelector(${q('body > .dgslab.full[data-wb-board="' + before[1] + '"]')})`);
        assert.equal(await run('document.querySelectorAll("body > .dgslab.full").length'), 1);
        await click('Exit full screen');
        await until('!document.querySelector(\'[aria-label="Exit full screen"]\')');
        // Every tab closed: the library, the strip gone with them — and ⌘W there is the window's.
        for (let i = 0; i < before.length; i++) {
          edit('close');
          await until(`document.querySelectorAll("#main .wbtl .wbtab").length === ${before.length - i - 1}`);
        }
        await until('SB.state.route.view === "whiteboards" && !document.querySelector("#main .wbstrip")');
        assert.equal(windowCloses, 0);
        edit('close');
        for (let i = 0; i < 50 && windowCloses === 0; i++) await sleep(20);
        assert.equal(windowCloses, 1);
        assert.deepEqual(errors.slice(errorsBeforeTabs), []);
      });

      mark('the Claude gauge on the home with no board open, and gone with the sign-in');
      await check('the Claude gauge in the home header', async () => {
        // The reload above asked main again, and main here has no sign-in: no gauge yet.
        assert.equal(await run('!!document.querySelector(".gauge")'), false);
        // Its coming never moves the focus off the button that had it (app.js puts the
        // focus back by position after the render it takes).
        await run('document.querySelector("#main .wbhd [data-wb-new-board]").focus()');
        window.webContents.send('sb:evt:usage', usageAnswer(40));
        await until('document.querySelector("#main .wbhd .top .gauge")?.textContent === "40%"');
        assert.equal(await run('document.querySelectorAll(".gauge").length'), 1);
        assert.equal(await run('!!document.activeElement?.hasAttribute("data-wb-new-board")'), true);
        window.webContents.send('sb:evt:usage', { ok: false, configured: false, reason: 'no-login', error: 'Example: not signed in' });
        await until('!document.querySelector(".gauge")');
        assert.deepEqual(errors.slice(errorsBeforeGauge), []);
      });
      await check('nothing along the way asked the network for more than a poster or a player', async () => {
        assert.deepEqual(httpsStrays, []);
      });

      console.log('PASS — Whiteboards: rail screen and home, a box resized from its corner and holding 600+ characters, a board the CLI writes to while open, a teleport (placed, given its destination, clicked, Back, Escape, Enter, its destination deleted and undone), a YouTube video (its poster, ⌘V of a link, its title, Undo, ⌘C/⌘V, a thumbnail dropped, a box typed as a link and Undo, a link in a sentence, Play, a drag by its strip, the Edit menu with the player focused, Open on YouTube, Stop, Enter, a resize at 16:9, Tab, off screen and full screen), open board, Actions ▸ Open terminal… on the Terminal tab\'s xterm, second panel (cascade, Tile, resize, drag), tray minimize/restore, close keeps the shell, ⌘A and Show or hide terminals, pin (same xterm and cols/rows, overlay tracks pan, pinch and the zoom floor, saved in the board file), float, undo/redo of the float, Markdown/label Select All, full screen, Grid squares without whiteboards (old ones open Terminal), exit and retry, ✦ Answer\'s Conversation row (New conversation from the keyboard, a workspace changed and back, a CLI on its own), ✦ Answer\'s Details (Low, Medium, High; High sent to main, asked with, and drawn wide), the rail back from the Grid to the open board, the Claude gauge (on the strip, caught up after a poll off screen, under full screen, in the home header, gone with the sign-in), tabs (+ and its search, ⌃Tab, ⌘W, a middle click, a reload, all closed)' +
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
