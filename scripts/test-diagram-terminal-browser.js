'use strict';

// The production renderer + xterm + a real PTY, in a fictional temporary
// workspace. No local config, Claude account, or persistent tmux session is used.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const repo = path.join(__dirname, '..');

if (!process.versions.electron) {
  const { execFileSync } = require('node:child_process');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-diagram-terminal-'));
  require('./build-diagrams').build().then(() => {
    try {
      fs.writeFileSync(path.join(temp, '.zshrc'), "PROMPT='example % '\n");
      process.stdout.write(execFileSync(require('electron'), [__filename, temp], {
        encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '', SWITCHBOARD_CONFIG: path.join(temp, 'config.json'), SWITCHBOARD_NO_TMUX: '1', SHELL: '/bin/zsh', ZDOTDIR: temp },
      }));
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
} else {
  const { app, BrowserWindow, ipcMain, Menu } = require('electron');
  const temp = process.argv[2];
  app.setPath('userData', path.join(temp, 'profile'));
  const diagrams = require('../src/main/diagrams');
  const shells = require('../src/main/shell');
  const wsId = 'example-workspace';
  const otherId = 'second-workspace';
  const dir = path.join(temp, 'project');
  fs.mkdirSync(dir);
  let window, clipboard = '', refuse = false;
  const opens = [];
  const workspace = id => ({ id, dir, project: 'Examples', section: 'Examples', repos: [], processes: [] });
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
  handle('answer:status', () => ({ ok: true, settings: {}, providers: [], keysSafe: {} }));
  handle('diagrams:dirty', () => ({}));
  handle('clipboard:write', text => { clipboard = text; return { ok: true }; });
  handle('term:open', async (id, cols, rows) => {
    opens.push(id);
    return refuse ? { ok: false, error: 'Example connection failed' } : shells.open(workspace(id), { cols, rows });
  });
  handle('term:input', (id, data) => shells.write(id, data));
  handle('term:resize', (id, cols, rows) => shells.resize(id, cols, rows));
  handle('term:buffer', id => shells.buffer(id));
  handle('term:states', () => shells.states());
  for (const [name, method] of Object.entries({ list: 'list', get: 'get', create: 'create', update: 'update', archive: 'setArchived', delete: 'remove', createDocument: 'createDocument', getDocument: 'getDocument', saveDocument: 'saveDocument' })) {
    handle('diagrams:' + name, (...args) => diagrams[method](...args));
  }
  shells.on('data', (id, chunk) => window?.webContents.send('sb:evt:term', id, chunk));
  shells.on('state', state => window?.webContents.send('sb:evt:termState', state));

  app.whenReady().then(async () => {
    window = new BrowserWindow({ show: false, width: 1440, height: 960,
      webPreferences: { preload: path.join(repo, 'src/preload.js'), offscreen: true, backgroundThrottling: false } });
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Edit', submenu: [
      { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => window.webContents.send('sb:evt:edit', { action: 'selectAll' }) },
    ] }]));
    const run = async code => {
      try { return await window.webContents.executeJavaScript(code, true); }
      catch (error) { throw new Error(error.message + '\nRenderer script: ' + code); }
    };
    const until = async code => {
      for (let i = 0; i < 150; i++) {
        if (await run(code)) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Timed out: ' + code);
    };
    const menuA = () => Menu.getApplicationMenu().items[0].submenu.items[0].click();
    const edit = (action, text) => window.webContents.send('sb:evt:edit', { action, text });
    const go = async (id, tab = 'diagrams') => {
      await run(`SB.go({view:'workspace',wsId:${JSON.stringify(id)},tab:${JSON.stringify(tab)}})`);
      await until(tab === 'diagrams' ? '!!document.querySelector("[data-diagram-terminal-toggle]")' : '!!document.querySelector("#main .xterm")');
    };
    const click = label => run(`document.querySelector(${JSON.stringify('[aria-label="' + label + '"]')}).click()`);
    const capture = async name => {
      if (!process.env.SWITCHBOARD_TERMINAL_CAPTURE) return;
      await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await new Promise(resolve => setTimeout(resolve, 100));
      fs.mkdirSync(process.env.SWITCHBOARD_TERMINAL_CAPTURE, { recursive: true });
      fs.writeFileSync(path.join(process.env.SWITCHBOARD_TERMINAL_CAPTURE, name + '.png'), (await window.webContents.capturePage()).toPNG());
    };
    try {
      const doc = await diagrams.createDocument(wsId, '# Example brief\n\nSupporting context.');
      for (const id of [wsId, otherId]) await diagrams.create(id, 'Example flow', { kind: 'flow', nodes: [
        { id: 'start', label: 'Review the design', position: { x: 60, y: 130 } },
        { id: 'brief', label: 'Example brief', shape: 'document', documentId: doc.data.id, position: { x: 340, y: 130 } },
      ], edges: [{ from: 'start', to: 'brief' }] });
      await window.loadFile(path.join(repo, 'src/renderer/index.html'));
      await until('SB.state.booted && SB.state.workspaces.length === 2');
      await go(wsId);
      await until('!!document.querySelector("[data-id=start]")');
      await run('Array.from(document.querySelectorAll("#main .seg button")).find(b => b.textContent === "Diagrams").focus()');
      menuA();
      await until('!!document.querySelector(".dgterminal .xterm-helper-textarea") && document.activeElement.closest(".dgterminal")');
      assert.equal(opens.length, 1);
      assert.equal(shells.state(wsId).status, 'running');
      await run(`window.originalTerm = SB.views.terminal.xterm(${JSON.stringify(wsId)}); window.originalHost = originalTerm.element.parentElement; originalTerm.paste(${JSON.stringify("printf 'diagram-terminal-ready\\n'")});`);
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      await until('Array.from({length:originalTerm.buffer.active.length}, (_,i) => originalTerm.buffer.active.getLine(i).translateToString().trim()).includes("diagram-terminal-ready")');
      assert.equal(await run('!!originalHost.closest(".sbdg")'), false);
      assert.equal(await run('document.querySelector(".dgterminal").getBoundingClientRect().width'), 600);
      await capture('floating-terminal');
      const cols = await run('originalTerm.cols');
      const handlePoint = await run('(() => { const r = document.querySelector(".dgterminal-resize").getBoundingClientRect(); return {x:Math.round(r.x+2),y:Math.round(r.y+100)}; })()');
      window.webContents.sendInputEvent({ type: 'mouseDown', ...handlePoint, button: 'left', clickCount: 1 });
      window.webContents.sendInputEvent({ type: 'mouseMove', x: handlePoint.x - 80, y: handlePoint.y, button: 'left' });
      window.webContents.sendInputEvent({ type: 'mouseUp', x: handlePoint.x - 80, y: handlePoint.y, button: 'left', clickCount: 1 });
      await until('originalTerm.cols > ' + cols);
      assert.equal(await run('document.querySelector(".dgterminal").getBoundingClientRect().width'), 680);
      const startedAt = shells.state(wsId).startedAt;
      // Native menu toggles even while xterm has the keyboard. Closing never
      // kills/recreates the terminal or its backend session.
      menuA();
      await until('!document.querySelector(".dgterminal")');
      assert.equal(shells.state(wsId).startedAt, startedAt);
      await click('Toggle AI terminal');
      await until('!!document.querySelector(".dgterminal .xterm")');
      assert.equal(await run('originalTerm === SB.views.terminal.xterm("example-workspace")'), true);
      assert.equal(opens.length, 1);
      // Terminal wheel/keys never reach canvas shortcuts or navigate back.
      await run('originalTerm.focus(); document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true, cancelable:true}));');
      assert.equal(await run('SB.state.route.tab'), 'diagrams');
      edit('paste', 'echo copied-text');
      await until('originalTerm.buffer.active.getLine(originalTerm.buffer.active.cursorY + originalTerm.buffer.active.baseY)?.translateToString().includes("echo copied-text")');
      await run('originalTerm.selectAll()');
      edit('copy');
      for (let i = 0; i < 50 && !clipboard.includes('diagram-terminal-ready'); i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(clipboard.includes('diagram-terminal-ready'));
      await run('originalTerm.clearSelection()');
      await shells.write(wsId, '\u0003');
      await run('SB.bell("example-workspace", true)');
      assert.equal(await run('!!SB.state.bell["example-workspace"]'), false);
      await go(wsId, 'terminal');
      assert.equal(await run('document.querySelector("#main .term") === originalHost'), true);
      edit('selectAll');
      await until('originalTerm.hasSelection()');
      await go(wsId);
      await until('originalHost.closest(".dgterminal")');
      assert.equal(shells.state(wsId).startedAt, startedAt);
      await click('Close AI terminal');
      // Markdown and rich-label editors retain Select All.
      await run('document.querySelector("[data-id=brief]").dispatchEvent(new MouseEvent("dblclick", {bubbles:true}))');
      await until('!!document.querySelector(".flow-document-panel")');
      await run('Array.from(document.querySelectorAll("[role=tab]")).find(b => b.textContent === "Write").click()');
      await until('document.activeElement.classList.contains("flow-document-source")');
      menuA();
      await until('document.activeElement.selectionEnd === document.activeElement.value.length');
      assert.equal(await run('!!document.querySelector(".dgterminal")'), false);
      await click('Close document');
      await run('document.querySelector("[data-id=start]").dispatchEvent(new MouseEvent("dblclick", {bubbles:true}))');
      await until('document.activeElement.isContentEditable');
      menuA();
      assert.equal(await run('!!document.querySelector(".dgterminal")'), false);
      await run('document.activeElement.blur()');
      // The renderer key path also handles the requested shortcut.
      assert.equal(await run('SB.views.diagrams.onKey({key:"a",metaKey:true,target:document.body})'), true);
      await until('!!document.querySelector(".dgterminal .xterm")');
      // Canvas fullscreen keeps the same floating terminal on top.
      await click('Full screen');
      await until(`!!document.querySelector('[aria-label="Exit full screen"]')`);
      assert.equal(await run('(() => { const panel = document.querySelector(".dgterminal"), r = panel.getBoundingClientRect(); return panel.contains(document.elementFromPoint(r.x + 100,r.y + 20)); })()'), true);
      await capture('fullscreen-terminal');
      await click('Exit full screen');
      await go(otherId);
      assert.equal(await run('!!document.querySelector("#main .dgterminal")'), false);
      await click('Toggle AI terminal');
      await until('!!document.querySelector(".dgterminal .xterm")');
      assert.equal(shells.state(otherId).status, 'running');
      assert.equal(await run('SB.views.terminal.xterm("second-workspace") === originalTerm'), false);
      // Grid uses the same diagram + terminal host. Changing the cell to
      // Terminal and back cannot create another shell or lose the scrollback.
      await run('SB.go({view:"grid"})');
      await until('!!document.querySelector(".gridbd")');
      await run('document.querySelector("[data-grid-ws=example-workspace] [data-grid-mode=diagrams]").click()');
      await until('!!document.querySelector("[data-grid-ws=example-workspace] .dgterminal .xterm")');
      await capture('grid-terminal');
      await run('originalTerm.focus()');
      await until('!!document.activeElement.closest(".dgterminal")');
      menuA();
      await until('!document.querySelector("[data-grid-ws=example-workspace] .dgterminal")');
      await run('document.querySelector("[data-grid-ws=example-workspace] [data-grid-mode=terminal]").click()');
      await until('originalHost.closest("[data-grid-ws=example-workspace]") && !originalHost.closest(".dgterminal")');
      assert.equal(opens.filter(id => id === wsId).length, 1);
      await go(wsId);
      await click('Toggle AI terminal');
      await until('!!document.querySelector(".dgterminal .xterm")');
      // Exited shells keep the existing footer, and retry starts in the same
      // terminal. A failed spawn keeps the existing error/retry experience.
      await shells.close(wsId);
      await until('!!document.querySelector(".dgterminal .exit")');
      assert.equal(await run('originalTerm === SB.views.terminal.xterm("example-workspace")'), true);
      refuse = true;
      await run('document.querySelector(".dgterminal .exit button").click()');
      await until('document.querySelector(".dgterminal .blank")?.textContent.includes("Example connection failed")');
      refuse = false;
      await run('document.querySelector(".dgterminal .blank button").click()');
      await until('!!document.querySelector(".dgterminal .xterm-helper-textarea")');
      await until('SB.state.shell["example-workspace"].status === "running"');
      await run('SB.termTheme.set("dark")');
      await capture('dark-terminal');
      console.log('PASS — floating diagram terminal reuses live PTY, native ⌘A, text editing, workspace/Grid/fullscreen, exit and retry');
    } catch (error) {
      await capture('failure');
      console.error(error.stack);
      process.exitCode = 1;
    } finally {
      await shells.closeAll();
      await diagrams.settle();
      window.destroy();
      app.exit(process.exitCode || 0);
    }
  });
}
