'use strict';

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
app.setPath('userData', path.join(__dirname, 'profile'));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const run = async code => {
    try { return await window.webContents.executeJavaScript(code, true); }
    catch (error) { throw new Error(`${error.message}\nRenderer script: ${code}`, { cause: error }); }
  };
  const tick = () => run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const edit = async id => {
    await run(`document.querySelector('[data-id="${id}"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await tick();
  };
  const selectNode = async id => {
    const point = await run(`(() => { const rect = document.querySelector('[data-id="${id}"]').getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }; })()`);
    window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    await tick();
  };
  const node = async id => run(`window.editor.current.currentSpec().nodes.find(node => node.id === '${id}')`);
  const select = async (start, end) => run(`(() => {
    const field = document.querySelector('[data-flow-text="label"]'); field.focus();
    const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT); const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const point = position => { for (const node of nodes) { if (position <= node.length) return [node, position]; position -= node.length; } return [field, field.childNodes.length]; };
    const range = document.createRange(); range.setStart(...point(${start})); range.setEnd(...point(${end}));
    getSelection().removeAllRanges(); getSelection().addRange(range);
  })()`);
  const click = async label => { await run(`document.querySelector('button[aria-label="${label}"]').click()`); await tick(); };
  const enter = async (shift = false) => {
    await run(`(() => {
      const key = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: ${shift}, bubbles: true, cancelable: true });
      document.activeElement.dispatchEvent(key);
      if (!key.defaultPrevented) document.execCommand('${shift ? 'insertLineBreak' : 'insertParagraph'}');
    })()`);
    await tick();
  };
  const tab = async (shift = false) => {
    const result = await run(`(() => {
      const key = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: ${shift}, bubbles: true, cancelable: true });
      let bubbled = false;
      const observe = event => { if (event === key) bubbled = true; };
      window.addEventListener('keydown', observe);
      try { document.activeElement.dispatchEvent(key); return { prevented: key.defaultPrevented, bubbled }; }
      finally { window.removeEventListener('keydown', observe); }
    })()`);
    await tick();
    return result;
  };
  try {
    await window.loadFile(path.join(__dirname, 'fixture.html'));
    await tick();
    await edit('box');
    await select(8, 16);
    await click('Bold · ⌘B');
    let box = await node('box');
    assert.deepEqual(box.labelRichText, [{ runs: [{ text: 'Connect ' }, { text: 'multiple', bold: true }, { text: ' systems' }] }]);
    assert.equal(await run('document.querySelector(\'button[aria-label="Bold · ⌘B"]\').getAttribute("aria-pressed")'), 'true');
    await run('document.execCommand("undo")'); await tick();
    assert.equal((await node('box')).labelRichText, undefined);
    await run('document.execCommand("redo")'); await tick();
    assert.equal((await node('box')).labelRichText[0].runs[1].bold, true);
    await select(17, 24);
    await click('Italic');
    box = await node('box');
    assert.equal(box.labelRichText[0].runs.find(run => run.text === 'systems').italic, true);
    await click('Done · Enter');
    await run('window.editor.current.undo()'); await tick();
    assert.equal((await node('box')).labelRichText[0].runs.some(run => run.italic), false);
    await run('window.editor.current.redo()'); await tick();
    assert.equal((await node('box')).labelRichText[0].runs.some(run => run.italic), true);

    await edit('text'); await select(8, 12); await click('Bold · ⌘B');
    assert.deepEqual((await node('text')).labelRichText[0].runs, [{ text: 'Regular ' }, { text: 'text', bold: true }, { text: ' words' }]);
    await select(0, 18); await click('Bullet list · ⌘⇧8');
    assert.equal((await node('text')).labelRichText[0].bullet, true);
    await select(18, 18);
    await enter();
    await run('document.execCommand("insertText", false, "Next item")'); await tick();
    let text = await node('text');
    assert.equal(text.label, 'Regular text words\nNext item');
    assert.equal(text.labelRichText.length, 2);
    assert.equal(text.labelRichText[1].bullet, true);
    await enter(true);
    await run('document.execCommand("insertText", false, "Continuation")'); await tick();
    text = await node('text');
    assert.equal(text.label, 'Regular text words\nNext item\nContinuation');
    assert.equal(text.labelRichText.length, 2, 'a soft break stays within the same bullet');
    await click('Done · Enter');
    await run('window.editor.current.flush()');
    await run('window.snapshot = JSON.parse(JSON.stringify(window.editor.current.currentSpec())); window.mount(window.snapshot)'); await tick();
    assert.deepEqual((await node('text')).labelRichText, text.labelRichText);
    assert.equal(await run('document.querySelector("[data-id=text] ul").children.length'), 2);

    await edit('legacy'); await select(11, 15); await click('Bold · ⌘B');
    const legacy = await node('legacy');
    assert.equal(legacy.labelRichText[0].runs[0].bold, true);
    assert.equal(legacy.labelRichText[0].runs[1].bold, undefined);
    assert.equal(legacy.labelRichText[0].runs[1].italic, true);
    await run('document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))'); await tick();
    const reverted = await node('legacy');
    assert.equal(reverted.bold, true); assert.equal(reverted.italic, true); assert.equal(reverted.labelRichText, undefined);

    await edit('box'); await select(24, 24);
    await enter(true);
    assert.equal((await node('box')).label, 'Connect multiple systems', 'saved snapshots trim the empty final line');
    await run('document.execCommand("insertText", false, "Second paragraph")'); await tick();
    assert.equal((await node('box')).label, 'Connect multiple systems\nSecond paragraph');
    await click('Bullet list · ⌘⇧8');
    assert.equal((await node('box')).labelRichText[0].bullet, undefined);
    assert.equal((await node('box')).labelRichText[1].bullet, true, 'an introduction can be followed by bullets');
    await click('Bullet list · ⌘⇧8');
    assert.equal((await node('box')).labelRichText.some(paragraph => paragraph.bullet), false);
    await click('Second line');
    await run('document.execCommand("insertText", false, "Detail words")'); await tick();
    await run(`(() => { const field = document.querySelector('[data-flow-text=detail]');
      const range = document.createRange(); range.setStart(field.firstChild.firstChild, 0); range.setEnd(field.firstChild.firstChild, 6);
      getSelection().removeAllRanges(); getSelection().addRange(range); })()`);
    await click('Bold · ⌘B');
    assert.deepEqual((await node('box')).detailRichText[0].runs, [{ text: 'Detail', bold: true }, { text: ' words' }]);
    await click('Done · Enter');
    await edit('text'); await select(0, 7);
    assert.equal(await run('window.editText("copy")'), true);
    assert.equal(await run('window.copied.at(-1)'), 'Regular');
    await run('window.editText("cut")'); await tick();
    assert.equal((await node('text')).label.startsWith('Regular'), false);
    await run('window.editText("undo")'); await tick();
    assert.equal((await node('text')).label.startsWith('Regular'), true);
    await select(0, 7); await run('window.editText("paste", "Ordinary")'); await tick();
    assert.equal((await node('text')).label.startsWith('Ordinary'), true);
    await run('window.editText("selectAll"); window.editText("paste", "x".repeat(250))'); await tick();
    assert.equal((await node('text')).label.length, 200);
    await run('window.editText("selectAll"); window.editText("paste", "<img src=x onerror=alert(1)>")'); await tick();
    assert.equal((await node('text')).label, '<img src=x onerror=alert(1)>');
    assert.equal(await run('document.querySelector("[data-flow-text] img")'), null);
    await run('document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))'); await tick();
    await run(`window.mount({ kind: 'flow', nodes: [
      { id: 'check-box', label: 'Prepare release\\nWrite notes\\nVerify build', align: 'left', position: { x: 20, y: 100 } },
      { id: 'check-text', label: 'Testing\\nTesting', shape: 'text', textSize: 'large', align: 'left', position: { x: 300, y: 100 } }
    ], edges: [] })`); await tick();
    await edit('check-box');
    assert.equal(await run('String(getSelection())'), 'Prepare release\nWrite notes\nVerify build');
    await click('Checkbox list');
    let tasks = await node('check-box');
    assert.deepEqual(tasks.labelRichText.map(paragraph => paragraph.checked), [false, false, false]);
    assert.equal(await run('document.querySelector(\'button[aria-label="Checkbox list"]\').getAttribute("aria-pressed")'), 'true');
    await run('window.selectFlowText(0, 7)'); await click('Bold · ⌘B');
    assert.equal((await node('check-box')).labelRichText[0].runs[0].bold, true);
    await run('document.querySelector(\'[data-flow-checkbox="0"]\').click()'); await tick();
    assert.equal((await node('check-box')).labelRichText[0].checked, true);
    await run('window.editText("undo")'); await tick();
    assert.equal((await node('check-box')).labelRichText[0].checked, false);
    await run('window.editText("redo")'); await tick();
    assert.equal((await node('check-box')).labelRichText[0].checked, true);
    await run('document.querySelector(\'[data-flow-checkbox="2"]\').click(); window.selectFlowText(40, 40)'); await tick();
    await enter();
    assert.equal(await run('window.readRichText(document.querySelector("[data-flow-text]")).at(-1).checked'), false);
    await run('document.execCommand("insertText", false, "Next task")'); await tick();
    tasks = await node('check-box');
    assert.equal(tasks.label, 'Prepare release\nWrite notes\nVerify build\nNext task');
    assert.deepEqual(tasks.labelRichText.map(paragraph => paragraph.checked), [true, false, true, false]);
    await enter(true); await run('document.execCommand("insertText", false, "Continuation")'); await tick();
    assert.equal((await node('check-box')).labelRichText.length, 4);
    await enter(); await enter();
    await run('document.execCommand("insertText", false, "After checklist")'); await tick();
    tasks = await node('check-box');
    assert.equal(tasks.labelRichText.at(-1).checked, undefined, 'Enter on an empty item exits the checklist');
    await run('window.selectFlowText(16, 27)'); await click('Bullet list · ⌘⇧8');
    assert.equal((await node('check-box')).labelRichText[1].bullet, true);
    await click('Checkbox list');
    assert.equal((await node('check-box')).labelRichText[1].checked, false);
    await click('Done · Enter');
    await run('document.querySelector(\'[data-id=check-box] [data-flow-checkbox="1"]\').click()'); await tick();
    assert.equal((await node('check-box')).labelRichText[1].checked, true, 'checkboxes can toggle without entering text editing');
    assert.equal(await run('document.querySelector("[data-flow-text]")'), null);
    await run('window.editor.current.undo()'); await tick();
    assert.equal((await node('check-box')).labelRichText[1].checked, false);
    await run('window.editor.current.redo()'); await tick();
    assert.equal((await node('check-box')).labelRichText[1].checked, true);
    await run('window.editor.current.flush(); window.snapshot = JSON.parse(JSON.stringify(window.editor.current.currentSpec())); window.mount(window.snapshot)'); await tick();
    assert.deepEqual((await node('check-box')).labelRichText, (await run('window.snapshot.nodes[0].labelRichText')));
    await edit('check-text'); await click('Checkbox list');
    assert.deepEqual((await node('check-text')).labelRichText.map(paragraph => paragraph.checked), [false, false]);
    await run('document.querySelector(\'[data-flow-text] [data-flow-checkbox="1"]\').focus(); document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }))'); await tick();
    assert.equal((await node('check-text')).labelRichText[1].checked, true, 'keyboard Space toggles a checkbox');
    assert.equal(await run('document.activeElement.getAttribute("role")'), 'checkbox', 'keyboard focus stays on the toggled checkbox');
    await run('document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }))'); await tick();
    assert.equal((await node('check-text')).labelRichText[1].checked, false);
    await click('Done · Enter');
    await run('document.querySelector(\'[data-id=check-text] [data-flow-checkbox="1"]\').focus(); document.activeElement.click()'); await tick();
    assert.equal((await node('check-text')).labelRichText[1].checked, true);
    assert.equal(await run('document.activeElement.getAttribute("role")'), 'checkbox', 'canvas checkbox retains keyboard focus after re-render');
    await run(`window.mount({ kind: 'flow', nodes: [
      { id: 'nested-box', label: 'Parent\\nChild\\nGrandchild\\nSibling\\nLast', align: 'left', position: { x: 20, y: 100 } },
      { id: 'nested-text', label: 'Group\\nFirst\\nSecond', shape: 'text', textSize: 'large', align: 'left', position: { x: 300, y: 100 } }
    ], edges: [] })`); await tick();
    await edit('nested-box'); await click('Bullet list · ⌘⇧8');
    await run('window.selectFlowText(7, 7)'); await tab();
    assert.deepEqual((await node('nested-box')).labelRichText.map(p => p.level || 0), [0, 1, 0, 0, 0]);
    assert.equal(await run('window.editor.current.currentSpec().nodes.length'), 2, 'Tab inside bullets never creates a canvas box');
    await run('window.selectFlowText(13, 13)'); await tab(); await tab();
    assert.deepEqual((await node('nested-box')).labelRichText.map(p => p.level || 0), [0, 1, 2, 0, 0]);
    await run('window.editText("undo")'); await tick();
    assert.equal((await node('nested-box')).labelRichText[2].level, 1);
    await run('window.editText("redo")'); await tick();
    assert.equal((await node('nested-box')).labelRichText[2].level, 2);
    await run('window.selectFlowText(13, 13)'); await tab(true);
    assert.equal((await node('nested-box')).labelRichText[2].level, 1);
    await click('Indent list · Tab');
    assert.equal((await node('nested-box')).labelRichText[2].level, 2);
    await click('Outdent list · ⇧Tab'); await click('Indent list · Tab');
    assert.deepEqual(await run('window.flowTextSelection(document.querySelector("[data-flow-text]"))'), { start: 13, end: 13 });
    await run('window.selectFlowText(24, 24)'); await tab();
    assert.deepEqual((await node('nested-box')).labelRichText.map(p => p.level || 0), [0, 1, 2, 1, 0]);
    await run('window.selectFlowText(7, 18)'); await tab(true);
    assert.deepEqual((await node('nested-box')).labelRichText.map(p => p.level || 0), [0, 0, 1, 1, 0], 'selected parents move with their descendants');
    await run('window.editText("undo")'); await tick();
    await run('window.selectFlowText(13, 18)'); await click('Bold · ⌘B');
    assert.deepEqual((await node('nested-box')).labelRichText[2].runs, [{ text: 'Grand', bold: true }, { text: 'child' }]);
    assert.equal(await run('document.querySelectorAll("[data-flow-text] ul > li > ul > li > ul > li").length'), 1);
    await click('Checkbox list');
    let nestedBox = await node('nested-box');
    assert.equal(nestedBox.labelRichText[2].checked, false);
    assert.equal(nestedBox.labelRichText[2].level, 2);
    await run('document.querySelector(\'[data-flow-checkbox="2"]\').click()'); await tick();
    nestedBox = await node('nested-box');
    assert.equal(nestedBox.labelRichText[2].checked, true);
    assert.equal(nestedBox.labelRichText[2].level, 2);
    await click('Done · Enter');
    await run('window.editor.current.flush(); window.snapshot = JSON.parse(JSON.stringify(window.editor.current.currentSpec())); window.mount(window.snapshot)'); await tick();
    assert.deepEqual((await node('nested-box')).labelRichText, nestedBox.labelRichText);
    await edit('nested-box');
    assert.deepEqual(await run('window.readRichText(document.querySelector("[data-flow-text]"))'), nestedBox.labelRichText, 'rendered nested lists read back without phantom parent paragraphs');
    await click('Done · Enter');
    await edit('nested-text'); await click('Bullet list · ⌘⇧8');
    await run('window.selectFlowText(6, 6)'); await tab();
    await run('window.selectFlowText(12, 12)'); await tab(); await tab();
    assert.deepEqual((await node('nested-text')).labelRichText.map(p => p.level || 0), [0, 1, 2]);
    await run('window.selectFlowText(18, 18)'); await enter();
    assert.equal(await run('window.readRichText(document.querySelector("[data-flow-text]")).at(-1).level'), 2);
    await run('document.execCommand("insertText", false, "Next")'); await tick();
    assert.deepEqual((await node('nested-text')).labelRichText.map(p => p.level || 0), [0, 1, 2, 2]);
    await enter(true); await run('document.execCommand("insertText", false, "Continuation")'); await tick();
    assert.equal((await node('nested-text')).labelRichText.length, 4, 'soft breaks keep the same nested bullet');
    await enter(); await enter();
    assert.equal(await run('window.readRichText(document.querySelector("[data-flow-text]")).at(-1).level'), 1);
    await run('window.editText("undo")'); await tick();
    assert.equal(await run('window.readRichText(document.querySelector("[data-flow-text]")).at(-1).level'), 2);
    await run('window.editText("undo")'); await tick();
    assert.equal(await run('window.readRichText(document.querySelector("[data-flow-text]")).length'), 4, 'undo removes the new empty item');
    await run('window.editText("redo"); window.editText("redo")'); await tick();
    assert.equal(await run('window.readRichText(document.querySelector("[data-flow-text]")).at(-1).level'), 1);
    await enter();
    assert.equal(await run('window.readRichText(document.querySelector("[data-flow-text]")).at(-1).level'), undefined);
    await enter();
    await run('document.execCommand("insertText", false, "After list")'); await tick();
    assert.equal((await node('nested-text')).labelRichText.at(-1).bullet, undefined);
    await run('window.editText("undo"); window.editText("undo"); window.editText("undo")'); await tick();
    assert.equal(await run('window.readRichText(document.querySelector("[data-flow-text]")).at(-1).level'), 1, 'undo crosses typing and empty-item outdents');
    await run('window.editText("redo"); window.editText("redo"); window.editText("redo")'); await tick();
    assert.equal((await node('nested-text')).label.endsWith('After list'), true);
    await click('Done · Enter');
    await run('window.snapshot = JSON.parse(JSON.stringify(window.editor.current.currentSpec()))');
    await run(`window.mount({ kind: 'flow', nodes: [{ id: 'empty-parent', label: 'Parent\\n\\nChild', labelRichText: [
      { bullet: true, runs: [{ text: 'Parent' }] }, { bullet: true, level: 1, runs: [] },
      { bullet: true, level: 2, runs: [{ text: 'Child' }] }
    ] }], edges: [] })`); await tick();
    await edit('empty-parent');
    assert.deepEqual(await run('window.readRichText(document.querySelector("[data-flow-text]"))'), (await node('empty-parent')).labelRichText);
    await run('window.selectFlowText(7, 7)');
    assert.deepEqual(await run('window.flowTextSelection(document.querySelector("[data-flow-text]"))'), { start: 7, end: 7 }, 'an empty parent caret stays before its children');
    await run('window.mount(window.snapshot)'); await tick();
    await run(`window.foldSpec = { kind: 'flow', nodes: [
      { id: 'fold-root', label: 'Fold root', position: { x: 20, y: 100 } },
      { id: 'fold-a', label: 'Branch A', position: { x: 300, y: 50 } },
      { id: 'fold-b', label: 'Branch B', position: { x: 300, y: 200 } },
      { id: 'fold-shared', label: 'Shared child', position: { x: 580, y: 100 } },
      { id: 'fold-leaf', label: 'Nested leaf', position: { x: 580, y: 250 } }
    ], edges: [
      { from: 'fold-root', to: 'fold-a' }, { from: 'fold-root', to: 'fold-b' },
      { from: 'fold-a', to: 'fold-shared' }, { from: 'fold-b', to: 'fold-shared' },
      { from: 'fold-a', to: 'fold-leaf', collapsed: true }
    ] }; window.mount(window.foldSpec)`); await tick();
    assert.equal(await run('document.querySelector("[data-id=fold-root] [data-flow-fold-badge]")'), null);
    assert.equal(await run('document.querySelector("[data-id=fold-a] [data-flow-fold-badge]").textContent'), '+1');
    await selectNode('fold-root');
    await click('Collapse all 2 outgoing branches from Fold root');
    assert.equal(await run('document.querySelector("[data-id=fold-root] [data-flow-fold-badge]").textContent'), '+4', 'hidden descendants include nested folds and count shared nodes once');
    assert.equal(await run('document.querySelectorAll(".react-flow__node").length'), 1);
    await run('document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))'); await tick();
    assert.equal(await run('document.querySelector(".react-flow__node.selected")'), null);
    assert.equal(await run('getComputedStyle(document.querySelector("[data-flow-fold-badge]")).opacity'), '1', 'the collapsed indicator stays visible without selection or hover');
    await run('window.editor.current.flush(); window.foldSnapshot = JSON.parse(JSON.stringify(window.editor.current.currentSpec())); window.mount(window.foldSnapshot)'); await tick();
    assert.equal(await run('document.querySelector("[data-id=fold-root] [data-flow-fold-badge]").textContent'), '+4', 'collapsed counts survive reload');
    await click('Show 4 hidden nodes from Fold root');
    assert.equal(await run('document.querySelector("[data-id=fold-root] [data-flow-fold-badge]")'), null);
    assert.equal(await run('document.querySelectorAll(".react-flow__node").length'), 4);
    assert.equal(await run('document.querySelector("[data-id=fold-a] [data-flow-fold-badge]").textContent'), '+1', 'expanding a parent preserves its nested folds');
    await run('window.editor.current.undo()'); await tick();
    assert.equal(await run('document.querySelector("[data-id=fold-root] [data-flow-fold-badge]").textContent'), '+4');
    await run('window.editor.current.redo()'); await tick();
    assert.equal(await run('document.querySelectorAll(".react-flow__node").length'), 4);
    await click('Show 1 hidden node from Branch A');
    assert.equal(await run('document.querySelectorAll(".react-flow__node").length'), 5);
    assert.equal(await run('document.querySelector("[data-flow-fold-badge]")'), null);
    await run('window.mount({ ...window.foldSpec, edges: window.foldSpec.edges.map((edge, index) => index === 0 ? { ...edge, collapsed: true } : edge) })'); await tick();
    assert.equal(await run('document.querySelector("[data-id=fold-root] [data-flow-fold-badge]").textContent'), '+2', 'partial folds report only descendants actually hidden');
    await click('Show 2 hidden nodes from Fold root');
    assert.equal(await run('document.querySelectorAll(".react-flow__node").length'), 4, 'expanding a partial fold keeps open siblings visible');
    assert.equal(await run('document.querySelector("[data-id=fold-root] [data-flow-fold-badge]")'), null);
    await run(`window.mount({ kind: 'flow', nodes: [
      { id: 'shared-left', label: 'Left parent' }, { id: 'shared-right', label: 'Right parent' }, { id: 'shared-only', label: 'Shared' }
    ], edges: [{ from: 'shared-left', to: 'shared-only', collapsed: true }, { from: 'shared-right', to: 'shared-only' }] })`); await tick();
    assert.equal(await run('document.querySelector("[data-id=shared-left] [data-flow-fold-badge]").textContent'), '+0', 'a collapsed connection remains clear when a shared node stays visible');
    await click('Show 0 hidden nodes from Left parent');
    assert.equal(await run('document.querySelector("[data-flow-fold-badge]")'), null);
    await run('window.mount(window.foldSnapshot)'); await tick();
    await run(`window.mount({ kind: 'flow', nodes: [
      { id: 'priority-parent', label: 'Original parent', position: { x: 20, y: 100 } },
      { id: 'priority-child', label: 'One\\nTwo', align: 'left', position: { x: 300, y: 100 },
        labelRichText: [{ bullet: true, runs: [{ text: 'One' }] }, { bullet: true, runs: [{ text: 'Two' }] }] }
    ], edges: [{ from: 'priority-parent', to: 'priority-child' }] })`); await tick();
    await edit('priority-child'); await run('window.selectFlowText(0, 0)');
    assert.deepEqual(await tab(), { prevented: true, bubbled: false }, 'a first bullet consumes Tab even when it cannot indent');
    assert.deepEqual(await tab(true), { prevented: true, bubbled: false }, 'a top-level bullet consumes Shift+Tab instead of editing its canvas parent');
    assert.equal(await run('document.activeElement.closest("[data-id]").dataset.id'), 'priority-child');
    await run('window.selectFlowText(4, 4)');
    assert.deepEqual(await tab(), { prevented: true, bubbled: false });
    assert.equal((await node('priority-child')).labelRichText[1].level, 1);
    assert.deepEqual(await tab(true), { prevented: true, bubbled: false });
    assert.equal((await node('priority-child')).labelRichText[1].level, undefined);
    await run('window.editText("selectAll")'); await click('Checkbox list');
    await run('window.selectFlowText(0, 0)');
    assert.deepEqual(await tab(), { prevented: true, bubbled: false }, 'checkbox lists also consume Tab at the first item');
    assert.deepEqual(await tab(true), { prevented: true, bubbled: false });
    await run('window.selectFlowText(4, 4)'); await tab();
    assert.equal((await node('priority-child')).labelRichText[1].level, 1);
    await tab(true);
    assert.equal(await run('document.activeElement.closest("[data-id]").dataset.id'), 'priority-child');
    assert.equal(await run('window.editor.current.currentSpec().nodes.length'), 2, 'list keys never add a canvas node');
    assert.equal(await run('window.editor.current.currentSpec().edges.length'), 1, 'list keys never add a canvas connection');
    assert.equal((await node('priority-parent')).label, 'Original parent');
    await run('window.editText("selectAll")'); await click('Checkbox list');
    assert.equal((await node('priority-child')).labelRichText, undefined);
    const canvasTab = await tab();
    assert.deepEqual(canvasTab, { prevented: true, bubbled: true }, 'ordinary text still hands Tab to the canvas');
    assert.equal(await run('window.editor.current.currentSpec().nodes.length'), 3);
    assert.equal(await run('window.editor.current.currentSpec().edges.length'), 2);
    await tab(true);
    assert.equal(await run('document.querySelector(".react-flow__node.selected").dataset.id'), 'priority-child', 'ordinary Shift+Tab still selects the canvas parent');
    assert.equal(await run('document.querySelector("[data-flow-text]")'), null, 'canvas Shift+Tab finishes text editing');
    await run('window.mount(window.foldSnapshot)'); await tick();
    if (process.env.SWITCHBOARD_RICH_TEXT_SCREENSHOT) {
      require('node:fs').writeFileSync(process.env.SWITCHBOARD_RICH_TEXT_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    }
    console.log('PASS — Chromium: rich text, nested lists, Tab precedence, collapsed-node counts, expand/undo/redo, save/reload, and native Edit menu actions');
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(await run('document.querySelector("[data-flow-text]")?.outerHTML'));
    app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
