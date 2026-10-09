'use strict';

const { app, BrowserWindow, ipcMain, nativeImage, protocol, net } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
// The real store, rooted beside the temporary SWITCHBOARD_CONFIG the runner set.
const whiteboards = require(path.join(process.env.SWITCHBOARD_DOCUMENT_TEST_REPO, 'src/main/whiteboards'));
app.setPath('userData', path.join(__dirname, 'profile'));
const methods = { List: 'list', Get: 'get', Create: 'create', SaveSpec: 'saveSpec', Rename: 'rename', SetWorkspace: 'setWorkspace', Move: 'move', Duplicate: 'duplicate', Archive: 'setArchived', Delete: 'remove', CreateFolder: 'createFolder', RenameFolder: 'renameFolder', DeleteFolder: 'removeFolder', DismissNotice: 'dismissNotice', NoteWorkspace: 'noteWorkspace', Workspaces: 'workspaceChoices', CreateDocument: 'createDocument', GetDocument: 'getDocument', SaveDocument: 'saveDocument', Migrate: 'migrate', GetImagePath: 'getImagePath' };
for (const [name, method] of Object.entries(methods)) ipcMain.handle('wb:' + name, (_, ...args) => whiteboards[method](...args));
// A board spec on its own, as a whiteboard of that name in No folder.
const board = (name, spec) => whiteboards.create({ folderId: null, name, spec, workspace: null });
let clipboard = '';
let clipboardFails = false;
ipcMain.handle('clipboard:write', (_, text) => { if (clipboardFails) return { ok: false, error: 'Clipboard unavailable' }; clipboard = text; return { ok: true }; });
protocol.registerSchemesAsPrivileged([{ scheme: 'sbimg', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

app.whenReady().then(async () => {
  protocol.handle('sbimg', async request => {
    const result = await whiteboards.getImagePath(request.url);
    return result.ok ? net.fetch(pathToFileURL(result.data).toString()) : new Response('not found', { status: 404 });
  });
  const window = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), offscreen: true, backgroundThrottling: false } });
  whiteboards.onChange(change => { if (!window.isDestroyed()) window.webContents.send('wb:changed', change); });
  const run = async code => {
    try { return await window.webContents.executeJavaScript(code, true); }
    catch (error) { throw new Error(`${error.message}\nRenderer script: ${code}`, { cause: error }); }
  };
  const tick = () => run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const until = async (code) => {
    for (let index = 0; index < 100; index++) {
      if (await run(code)) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Timed out: ' + code);
  };
  // Waits for an element to stop moving — React Flow's first fitView lands a frame or
  // two after the nodes appear — so a pointer aimed at it still hits it.
  const steady = async selector => {
    let last = '', same = 0;
    for (let index = 0; index < 100; index++) {
      await tick();
      const now = await run(`JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect() ?? null)`);
      same = now !== 'null' && now === last ? same + 1 : 0;
      if (same >= 3) return;
      last = now;
    }
    throw new Error('Never settled: ' + selector);
  };
  const click = async label => { await run(`document.querySelector(${JSON.stringify('button[aria-label="' + label + '"]')}).click()`); await tick(); };
  const mode = async value => { await run(`Array.from(document.querySelectorAll('[role=tab]')).find(button => button.textContent === ${JSON.stringify(value)}).click()`); await tick(); };
  const selectNode = async id => {
    const point = await run(`(() => { const rect = document.querySelector(${JSON.stringify('[data-id="' + id + '"]')}).getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }; })()`);
    window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    await tick();
  };
  const edit = async id => { await run(`document.querySelector(${JSON.stringify('[data-id="' + id + '"]')}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`); await until('!!document.querySelector(".flow-document-source:not(:disabled)")'); await tick(); };
  const text = async value => { await run(`(() => { const source = document.querySelector('.flow-document-source'); source.focus(); source.select(); document.execCommand('insertText', false, ${JSON.stringify(value)}); })()`); await tick(); };
  const sourceText = () => run('document.querySelector(".flow-document-source").value');
  const key = async (value, shift = false) => {
    const result = await run(`(() => { const event = new KeyboardEvent('keydown', { key: ${JSON.stringify(value)}, shiftKey: ${shift}, bubbles: true, cancelable: true }); document.activeElement.dispatchEvent(event); return event.defaultPrevented; })()`);
    await tick(); return result;
  };
  const capture = async name => {
    if (!process.env.SWITCHBOARD_DOCUMENT_CAPTURE) return;
    fs.mkdirSync(process.env.SWITCHBOARD_DOCUMENT_CAPTURE, { recursive: true });
    fs.writeFileSync(path.join(process.env.SWITCHBOARD_DOCUMENT_CAPTURE, name + '.png'), (await window.webContents.capturePage()).toPNG());
  };
  try {
    const originalText = '# Integration brief\n\nA **clear** explanation with *details*.\n\n## Supported connections\n\n- Point of sale\n  - Orders\n  - Refunds\n- Advertising\n\n## Checklist\n\n- [ ] Confirm scope\n- [x] Draft design\n\n> Keep the canvas readable.\n\n| System | Purpose |\n| --- | --- |\n| Orders | Sales events |\n\n```js\nconst ready = true;\n```\n\n' + Array.from({ length: 24 }, (_, i) => `### Detail ${i + 1}\n\nAdditional context for the flowchart, written as a Markdown file.\n`).join('\n');
    const made = await whiteboards.createDocument(originalText);
    const picture = await whiteboards.saveImage(nativeImage.createFromBitmap(Buffer.from(Array.from({ length: 240 * 160 }, () => [210, 230, 250, 255]).flat()), { width: 240, height: 160 }).toPNG(), 'image/png');
    const picturePath = (await whiteboards.getImagePath(picture.src)).data;
    const chart = await board('Example flow', { kind: 'flow', nodes: [
      { id: 'start', label: 'Connect the systems', position: { x: 30, y: 130 } },
      { id: 'brief', label: 'Integration brief', shape: 'document', documentId: made.data.id, position: { x: 330, y: 130 } },
      { id: 'picture', label: 'Reference image', shape: 'image', src: picture.src, width: 240, height: 160, position: { x: 330, y: 280 } },
    ], edges: [{ from: 'start', to: 'brief' }] });
    assert.equal(chart.ok, true);
    const stored = async () => (await whiteboards.get(chart.data.id)).data.spec;
    await window.loadFile(path.join(__dirname, 'fixture.html'), { query: { board: chart.data.id } });
    await until('!!document.querySelector("[data-id=brief]")');
    const imageButton = '[data-id=picture] .flow-file-copy';
    const documentButton = '[data-id=brief] .flow-file-copy';
    await until('document.querySelector("[data-id=picture] img")?.naturalWidth === 240');
    assert.equal(await run(`getComputedStyle(document.querySelector(${JSON.stringify(imageButton)})).opacity`), '0');
    await steady('[data-id=picture]');
    const imagePoint = await run(`(() => { const rect = document.querySelector('[data-id=picture]').getBoundingClientRect(); return { x: Math.round(rect.right - 20), y: Math.round(rect.bottom - 20) }; })()`);
    window.webContents.sendInputEvent({ type: 'mouseMove', ...imagePoint });
    await until(`getComputedStyle(document.querySelector(${JSON.stringify(imageButton)})).opacity === '1'`);
    assert.equal(await run(`(() => { const button = document.querySelector(${JSON.stringify(imageButton)}).getBoundingClientRect(), node = document.querySelector('[data-id=picture]').getBoundingClientRect(); return button.right <= node.right && button.bottom <= node.bottom && node.right - button.right < 15 && node.bottom - button.bottom < 15; })()`), true, 'copy button sits inside the bottom-right corner');
    await capture('file-copy-hover');
    const beforeCopy = await stored();
    window.webContents.sendInputEvent({ type: 'mouseDown', ...imagePoint, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', ...imagePoint, button: 'left', clickCount: 1 });
    await until(`document.querySelector(${JSON.stringify(imageButton)}).dataset.copied === 'true'`);
    assert.equal(clipboard, picturePath);
    assert.equal(fs.existsSync(clipboard), true);
    await run('window.diagram.flush()');
    assert.deepEqual(await stored(), beforeCopy, 'copy does not move or change a node');
    await run(`document.querySelector(${JSON.stringify(documentButton)}).focus()`);
    await until(`getComputedStyle(document.querySelector(${JSON.stringify(documentButton)})).opacity === '1'`);
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await until(`document.querySelector(${JSON.stringify(documentButton)}).dataset.copied === 'true'`);
    assert.equal(clipboard, made.data.path);
    assert.equal(await run('!!document.querySelector(".flow-document-panel")'), false, 'copy does not open the document');
    clipboardFails = true;
    clipboard = 'Keep the previous clipboard';
    await run(`document.querySelector(${JSON.stringify(imageButton)}).click()`);
    await until(`document.querySelector(${JSON.stringify(imageButton)}).getAttribute('aria-busy') === 'false'`);
    assert.equal(clipboard, 'Keep the previous clipboard');
    assert.equal(await run(`document.querySelector(${JSON.stringify(imageButton)}).dataset.copied`), 'false', 'clipboard failures do not report success');
    clipboardFails = false;
    assert.equal((await whiteboards.saveSpec(chart.data.id, { ...beforeCopy, nodes: beforeCopy.nodes.filter(node => node.id !== 'picture') })).ok, true);
    await window.reload();
    await until('!!document.querySelector("[data-id=brief]") && !document.querySelector("[data-id=picture]")');
    await edit('brief');
    assert.equal(await run('document.querySelector(".flow-document-host").classList.contains("flow-document-floating")'), true);
    assert.equal(await run('getComputedStyle(document.querySelector(".flow-document-panel")).borderRadius'), '14px');
    assert.equal(await run('document.querySelector(".flow-document-markdown strong").textContent'), 'clear');
    assert.equal(await run('document.querySelectorAll(".flow-document-markdown ul ul li").length'), 2);
    assert.equal(await run('document.querySelectorAll(".flow-document-markdown input[type=checkbox]").length'), 2);
    assert.equal(await run('!!document.querySelector(".flow-document-markdown table") && !!document.querySelector(".flow-document-markdown pre code")'), true);
    assert.equal(await run('(() => { const body = document.querySelector(".flow-document-preview"); return body.scrollHeight > body.clientHeight; })()'), true);
    await until('document.querySelector("[data-id=brief]").getBoundingClientRect().right < document.querySelector(".flow-document-floating").getBoundingClientRect().left - 46');
    await capture('floating');
    const canvasWidth = await run('document.querySelector(".react-flow").getBoundingClientRect().width');
    await click('Dock to the right');
    assert.equal(await run('document.querySelector(".react-flow").getBoundingClientRect().width < ' + canvasWidth), true);
    await capture('docked');
    await click('Focus view');
    assert.equal(await run('document.querySelector("[role=dialog]").getAttribute("aria-modal")'), 'true');
    await capture('focus');
    assert.equal(await key('Escape'), true);
    assert.equal(await run('!!document.querySelector(".flow-document-docked")'), true);
    await click('Floating panel');
    await mode('Write');
    await text('- Parent\n- Child');
    await run('document.querySelector(".flow-document-source").setSelectionRange(9, 9)');
    assert.equal(await key('Tab'), true);
    assert.equal(await sourceText(), '- Parent\n  - Child');
    assert.equal(await run('window.diagram.editAction("undo", false)'), false, 'native menu editing belongs to the source');
    await run('document.execCommand("undo")'); await tick();
    assert.equal(await sourceText(), '- Parent\n- Child');
    await run('document.execCommand("redo")'); await tick();
    assert.equal(await sourceText(), '- Parent\n  - Child');
    assert.equal(await key('Tab', true), true);
    assert.equal(await sourceText(), '- Parent\n- Child');
    await run('window.diagram.flush()');
    assert.equal((await stored()).nodes.length, 2, 'source Tab never creates a canvas node');
    await text('First item\nSecond item');
    await run('document.querySelector(".flow-document-source").select()');
    await run('Array.from(document.querySelectorAll(".flow-document-format button")).find(button => button.textContent === "Bullet list").click()'); await tick();
    assert.equal(await sourceText(), '- First item\n- Second item');
    await run('document.querySelector(".flow-document-source").select()');
    await run('Array.from(document.querySelectorAll(".flow-document-format button")).find(button => button.textContent === "Checklist").click()'); await tick();
    assert.equal(await sourceText(), '- [ ] First item\n- [ ] Second item');
    await text('A couple of words');
    await run('document.querySelector(".flow-document-source").setSelectionRange(2, 8)');
    assert.equal(await run('String(window.getSelection())'), "couple", "native Copy can read the source selection");
    await run('document.querySelector("button[title=\\"Bold selected words\\"]").click()'); await tick();
    assert.equal(await sourceText(), 'A **couple** of words');
    await mode('Split');
    assert.equal(await run('document.querySelector(".flow-document-markdown strong").textContent'), 'couple');
    const finalText = '# Updated brief\n\nA **couple** of words.\n\n- Parent\n  - Child\n- [ ] Open task\n- [x] Done task\n';
    await text(finalText);
    await run('(() => { const name = document.querySelector("input[aria-label=\\"Document name\\"]"); name.focus(); name.select(); document.execCommand("insertText", false, "Renamed brief"); name.blur(); })()'); await tick();
    await click('Close document');
    await run('window.diagram.flush()');
    assert.equal(fs.readFileSync(made.data.path, 'utf8'), finalText);
    let spec = await stored();
    assert.equal(spec.nodes.find(node => node.id === 'brief').label, 'Renamed brief');
    assert.equal(spec.nodes.find(node => node.id === 'brief').documentId, made.data.id);
    await edit('brief');
    assert.equal(await run('!!document.querySelector(".flow-document-floating")'), true);
    assert.equal(await sourceText(), finalText);
    await run('document.querySelector(".flow-document-footer button[aria-label=\\"Copy Markdown file path\\"]").click()');
    await until('document.querySelector(".flow-document-footer button").dataset.copied === "true"');
    assert.equal(clipboard, made.data.path);

    await mode('Write');
    const pendingCopyText = '# Copied before autosave\n';
    await text(pendingCopyText);
    await run(`document.querySelector(${JSON.stringify(documentButton)}).click()`);
    await until(`document.querySelector(${JSON.stringify(documentButton)}).dataset.copied === 'true'`);
    assert.equal(clipboard, made.data.path);
    assert.equal(fs.readFileSync(clipboard, 'utf8'), pendingCopyText, 'node copy saves pending Markdown before copying');
    await text(finalText);
    await run('document.querySelector(".flow-document-footer button").click()');
    await until('document.querySelector(".flow-document-footer button").dataset.copied === "true"');
    assert.equal(fs.readFileSync(clipboard, 'utf8'), finalText, 'panel copy also saves pending Markdown');

    // A clean document picks up external edits on focus. A dirty one retains the
    // local buffer and asks which version to use before overwriting anything.
    fs.writeFileSync(made.data.path, '# External version\n');
    await run('window.dispatchEvent(new Event("focus"))');
    await until('document.querySelector(".flow-document-source").value === "# External version\\n"');
    await mode('Write');
    await text('# Local version\n');
    fs.writeFileSync(made.data.path, '# Other editor\n');
    await run('window.diagram.flush()');
    await until('!!document.querySelector(".flow-document-error")');
    assert.equal(fs.readFileSync(made.data.path, 'utf8'), '# Other editor\n');
    assert.equal(await sourceText(), '# Local version\n');
    clipboard = 'Keep the previous clipboard';
    await run(`document.querySelector(${JSON.stringify(documentButton)}).click()`);
    await until(`document.querySelector(${JSON.stringify(documentButton)}).getAttribute('aria-busy') === 'false'`);
    assert.equal(clipboard, 'Keep the previous clipboard', 'conflicts leave the clipboard untouched');
    assert.equal(fs.readFileSync(made.data.path, 'utf8'), '# Other editor\n', 'copy never overwrites an external edit');
    const recovery = await board('Another flow', { kind: 'flow', nodes: [{ id: 'example', label: 'Another step' }], edges: [] });
    await run(`window.diagram.update({ boardId: ${JSON.stringify(recovery.data.id)} })`);
    await until('!!document.querySelector("[data-id=example]") && !document.querySelector(".flow-document-panel")');
    await run(`window.diagram.update({ boardId: ${JSON.stringify(chart.data.id)} })`);
    await until('!!document.querySelector("[data-id=brief]")');
    await edit('brief');
    assert.equal(await sourceText(), '# Local version\n', 'failed edits survive a diagram unmount');
    assert.equal(await run('!!document.querySelector(".flow-document-error")'), true);
    await run('Array.from(document.querySelectorAll(".flow-document-error button")).find(button => button.textContent === "Save my version").click()');
    await until('!document.querySelector(".flow-document-error")');
    assert.equal(fs.readFileSync(made.data.path, 'utf8'), '# Local version\n');
    await mode('Write');
    await text('# Pending local edit\n');
    fs.writeFileSync(made.data.path, '# Reload this\n');
    await run('window.diagram.flush()');
    await run('Array.from(document.querySelectorAll(".flow-document-error button")).find(button => button.textContent === "Reload file").click()');
    await until('document.querySelector(".flow-document-source").value === "# Reload this\\n"');
    await text(finalText);
    await click('Close document');
    await run('window.diagram.flush()');

    // A new document starts in Write, creates a real file, and has its own undo
    // step on the canvas. Existing text stays available after undo and redo.
    await click('Document');
    await run('(() => { const pane = document.querySelector(".react-flow__pane"), rect = pane.getBoundingClientRect(); pane.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: rect.left + 650, clientY: rect.top + 450 })); })()');
    await until('!!document.querySelector(".flow-document-source:not(:disabled)")');
    assert.equal(await run('document.querySelector("[role=tab][aria-selected=true]").textContent'), 'Write');
    await text('# New document\n');
    await click('Close document');
    await run('window.diagram.flush()');
    spec = await stored();
    const fresh = spec.nodes.find(node => node.shape === 'document' && node.id !== 'brief');
    assert.ok(fresh);
    assert.equal((await whiteboards.getDocument(fresh.documentId)).data.text, '# New document\n');
    await run('window.diagram.editAction("undo", false)'); await tick(); await run('window.diagram.flush()');
    assert.equal((await stored()).nodes.some(node => node.id === fresh.id), false);
    await run('window.diagram.editAction("redo", false)'); await tick(); await run('window.diagram.flush()');
    assert.equal((await stored()).nodes.find(node => node.id === fresh.id).documentId, fresh.documentId);
    await edit(fresh.id);
    assert.equal(await sourceText(), '# New document\n');
    await click('Close document');

    // Duplicating a document copies the Markdown into an independent file.
    await selectNode('brief');
    await click('Duplicate · ⌘D');
    await until('document.querySelectorAll(".react-flow__node").length === 4');
    await run('window.diagram.flush()');
    const duplicate = (await stored()).nodes.find(node => node.shape === 'document' && node.id !== fresh.id && node.id !== 'brief');
    assert.ok(duplicate);
    assert.notEqual(duplicate.documentId, made.data.id);
    assert.equal((await whiteboards.getDocument(duplicate.documentId)).data.text, finalText);
    await edit(duplicate.id); await mode('Write'); await text('# Independent copy\n');
    await click('Close document'); await run('window.diagram.flush()');
    assert.equal(fs.readFileSync(made.data.path, 'utf8'), finalText);

    // Copy/Paste carries the Markdown to another whiteboard as a NEW document file:
    // one global store, but never a file shared between two boards' nodes.
    await selectNode('brief');
    assert.equal(await run('window.diagram.editAction("copy", false)'), true);
    await tick();
    const copiedWords = clipboard;
    const target = await board('Copied flow', { kind: 'flow', nodes: [], edges: [] });
    await run(`window.diagram.update({ boardId: ${JSON.stringify(target.data.id)} })`);
    await until('!document.querySelector("[data-id=brief]") && !!document.querySelector(".react-flow")');
    // Wait for the new diagram's editor, rather than the previous loading frame.
    await until('document.querySelector(".sbdg-app").textContent.includes("Copied flow")');
    assert.equal(await run(`window.diagram.editAction("paste", false, ${JSON.stringify(copiedWords)})`), true);
    await until('document.querySelectorAll(".react-flow__node").length === 1');
    await run('window.diagram.flush()');
    const pasted = (await whiteboards.get(target.data.id)).data.spec.nodes[0];
    assert.notEqual(pasted.documentId, made.data.id);
    const pastedDocument = (await whiteboards.getDocument(pasted.documentId)).data;
    assert.equal(pastedDocument.text, finalText);
    assert.notEqual(pastedDocument.path, made.data.path, 'a pasted document is its own file');
    await edit(pasted.id); await mode('Write'); await text('# On another whiteboard\n');
    await click('Close document'); await run('window.diagram.flush()');
    assert.equal(fs.readFileSync(pastedDocument.path, 'utf8'), '# On another whiteboard\n');
    assert.equal(fs.readFileSync(made.data.path, 'utf8'), finalText, 'editing the pasted copy leaves the original alone');
    await run(`window.diagram.update({ boardId: ${JSON.stringify(chart.data.id)} })`);
    await until('!!document.querySelector("[data-id=brief]")');

    // Reloading the whole renderer loads the Markdown from disk.
    await window.reload();
    await until('!!document.querySelector("[data-id=brief]")');
    await edit('brief');
    assert.equal(await sourceText(), finalText);
    await capture('final-floating');
    await run('document.documentElement.setAttribute("data-term-theme", "dark")'); await tick();
    assert.equal(await run('getComputedStyle(document.querySelector(".flow-document-panel")).backgroundColor'), 'rgb(17, 24, 39)');
    await capture('dark-floating');
    await click('Close document');
    assert.equal((await whiteboards.setArchived(chart.data.id, true)).ok, true);
    await window.reload();
    await until('!!document.querySelector("[data-id=brief]")');
    await steady(documentButton);
    const archivedCopyPoint = await run(`(() => { const rect = document.querySelector(${JSON.stringify(documentButton)}).getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }; })()`);
    window.webContents.sendInputEvent({ type: 'mouseMove', ...archivedCopyPoint });
    await until(`getComputedStyle(document.querySelector(${JSON.stringify(documentButton)})).opacity === '1'`);
    window.webContents.sendInputEvent({ type: 'mouseDown', ...archivedCopyPoint, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', ...archivedCopyPoint, button: 'left', clickCount: 1 });
    await until(`document.querySelector(${JSON.stringify(documentButton)}).dataset.copied === 'true'`);
    assert.equal(clipboard, made.data.path, 'archived documents can copy paths');
    await run('document.querySelector("[data-id=brief]").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))');
    await until('!!document.querySelector(".flow-document-markdown h1")');
    assert.equal(await run('document.querySelectorAll(".flow-document-tabs [role=tab]").length'), 1);
    assert.equal(await run('document.querySelector("input[aria-label=\\"Document name\\"]").readOnly'), true);

    console.log('Documents browser checks passed: image/document hover copy, focus accessibility, clipboard failures, save-before-copy and conflicts, default floating, docked/focus, scrollable Markdown, native source undo, Tab precedence, file autosave/reopen, conflict recovery, creation/undo/redo, independent duplicates, pasted copies as new files, reload, archived read-only documents and dark theme.');
    await whiteboards.settle();
    window.destroy(); app.exit(0);
  } catch (error) {
    console.error(error.stack || error);
    await capture('failure');
    await whiteboards.settle();
    window.destroy(); app.exit(1);
  }
});
