'use strict';

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
app.setPath('userData', path.join(__dirname, 'profile'));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const run = code => window.webContents.executeJavaScript(code, true);
  const tick = () => run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const edit = async id => {
    await run(`document.querySelector('[data-id="${id}"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
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
    if (process.env.SWITCHBOARD_RICH_TEXT_SCREENSHOT) {
      require('node:fs').writeFileSync(process.env.SWITCHBOARD_RICH_TEXT_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    }
    console.log('PASS — Chromium: partial bold/italic, bullets and soft breaks, undo/redo, save/reload, legacy formatting, and native Edit menu actions');
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(await run('document.querySelector("[data-flow-text]")?.outerHTML'));
    app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
