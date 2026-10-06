'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const esbuild = require('esbuild');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-rich-text-'));
const modules = {};
for (const name of ['rich-text', 'layout', 'validate', 'flow-editor']) {
  const outfile = path.join(temp, name + '.js');
  esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src', 'diagrams', 'lib', 'diagrams', name + '.ts')],
    outfile, bundle: true, format: 'cjs', platform: 'node', logLevel: 'error' });
  modules[name] = require(outfile);
}
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const { parseFlowRichText, richTextPlainText, richTextHtml, truncateRichText, richTextVisualLines,
  richTextSelectedParagraphs, toggleChecklist, checklistToBullets, toggleBullets, continueList, shiftListIndent, FLOW_LIST_MAX_LEVEL } = modules['rich-text'];
const { layoutDiagram, flowNodeSize, setFlowTextMeasure } = modules.layout;
const { parseDiagramSpec } = modules.validate;
const { flowSpecFromCanvas, carryOverFlowLayout } = modules['flow-editor'];
const rich = [
  { runs: [{ text: 'Connect ' }, { text: 'multiple systems', bold: true }] },
  { bullet: true, runs: [{ text: 'Point of sale' }] },
  { bullet: true, runs: [{ text: 'Advertising', italic: true }] },
];
const label = richTextPlainText(rich);
const spec = (node) => ({ kind: 'flow', nodes: [{ id: 'example', ...node }], edges: [] });

test('selected word marks and bullets survive validation, canvas snapshots and reload', () => {
  for (const shape of ['rounded', 'box', 'pill', 'diamond', 'text', 'note']) {
    const parsed = parseDiagramSpec(spec({ label, labelRichText: rich, shape,
      detail: 'Supporting words', detailRichText: [{ runs: [{ text: 'Supporting', bold: true }, { text: ' words' }] }] }));
    assert.equal(parsed.ok, true);
    const canvas = layoutDiagram(parsed.value);
    const saved = flowSpecFromCanvas({}, canvas.nodes, canvas.edges);
    const reloaded = parseDiagramSpec(JSON.parse(JSON.stringify(saved)));
    assert.equal(reloaded.ok, true);
    assert.deepEqual(reloaded.value.nodes[0].labelRichText, rich);
    assert.deepEqual(reloaded.value.nodes[0].detailRichText, parsed.value.nodes[0].detailRichText);
    assert.equal(reloaded.value.nodes[0].label, label);
  }
});

test('whitespace cleanup preserves inline marks and bullet paragraph boundaries', () => {
  const input = [{ runs: [] }, { runs: [{ text: '  Connect  ' }, { text: ' systems  ', bold: true }] },
    { bullet: true, runs: [{ text: '  Advertising  ', italic: true }] }, { runs: [] }];
  assert.deepEqual(parseFlowRichText(input, 'Connect systems\nAdvertising'), [
    { runs: [{ text: 'Connect ' }, { text: 'systems', bold: true }] },
    { bullet: true, runs: [{ text: 'Advertising', italic: true }] },
  ]);
});

test('soft breaks stay within one bullet through normalization and rendering', () => {
  const rich = [{ bullet: true, runs: [{ text: ' First line  \n Second ', bold: true }, { text: 'line  ' }] }];
  const parsed = parseFlowRichText(rich, 'First line\nSecond line');
  assert.equal(parsed.length, 1);
  assert.equal(richTextPlainText(parsed), 'First line\nSecond line');
  assert.equal((richTextHtml(parsed).match(/<li\b/g) || []).length, 1);
  assert.ok(flowNodeSize({ label: 'First line\nSecond line', labelRichText: parsed }).height > flowNodeSize({ label: 'First line' }).height);
});

test('malformed rich text is rejected and stale formatting cannot mark changed words', () => {
  assert.equal(parseDiagramSpec(spec({ label, labelRichText: '<b>unsafe</b>' })).ok, false);
  assert.equal(parseDiagramSpec(spec({ label, labelRichText: [{ runs: [{ text: 'a\rb' }] }] })).ok, false);
  const changed = parseDiagramSpec(spec({ label: 'Replaced words', labelRichText: rich }));
  assert.equal(changed.ok, true);
  assert.equal(changed.value.nodes[0].labelRichText, undefined);
  assert.equal(parseFlowRichText([{ runs: [{ text: 'Plain text', bold: false }] }], 'Plain text'), undefined);
});

test('rendering escapes arbitrary label text and never includes incoming HTML properties', () => {
  const html = richTextHtml([{ bullet: true, runs: [{ text: '<img src=x onerror="alert(1)"> &', bold: true, style: 'color:red' }] }]);
  assert.equal(html, '<ul><li data-flow-paragraph="0"><b>&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp;</b></li></ul>');
  assert.equal(richTextPlainText(truncateRichText(rich, 35)).length, 35);
});

test('list indentation and mixed bold weights contribute to wrapping and automatic text width', () => {
  setFlowTextMeasure((text, _size, weight) => text.length * (weight >= 700 ? 12 : 10));
  try {
    const plain = { label: 'aaaa aaaa aaaa', shape: 'text', size: { width: 100, height: 16 } };
    const bullet = { ...plain, labelRichText: [{ bullet: true, runs: [{ text: plain.label }] }] };
    assert.ok(flowNodeSize(bullet).height > flowNodeSize(plain).height);
    const mixed = flowNodeSize({ label: 'aaaa bbbb', shape: 'text', labelRichText: [{ runs: [{ text: 'aaaa ' }, { text: 'bbbb', bold: true }] }] });
    const normal = flowNodeSize({ label: 'aaaa bbbb', shape: 'text' });
    const allBold = flowNodeSize({ label: 'aaaa bbbb', shape: 'text', bold: true });
    assert.ok(mixed.width > normal.width && mixed.width < allBold.width);
  } finally { setFlowTextMeasure(null); }
});

test('republishing carries formatting only while the corresponding words match', () => {
  const before = spec({ label, labelRichText: rich, detail: 'Supporting words', detailRichText: [{ runs: [{ text: 'Supporting words', italic: true }] }] });
  const matching = carryOverFlowLayout(before, spec({ label, detail: 'Supporting words' }));
  assert.deepEqual(matching.spec.nodes[0].labelRichText, rich);
  const changed = carryOverFlowLayout(before, spec({ label: 'Changed', detail: 'Changed detail' }));
  assert.equal(changed.spec.nodes[0].labelRichText, undefined);
  assert.equal(changed.spec.nodes[0].detailRichText, undefined);
});

test('checked and unchecked items retain state and inline marks across save and reload for every text shape', () => {
  const tasks = [{ checked: false, runs: [{ text: 'Write notes', bold: true }] },
    { checked: true, runs: [{ text: 'Verify build', italic: true }] }];
  for (const shape of ['rounded', 'box', 'pill', 'diamond', 'text', 'note']) {
    const input = spec({ label: richTextPlainText(tasks), labelRichText: tasks, shape,
      detail: richTextPlainText(tasks), detailRichText: tasks });
    const parsed = parseDiagramSpec(input);
    assert.equal(parsed.ok, true);
    const canvas = layoutDiagram(parsed.value);
    const saved = flowSpecFromCanvas({}, canvas.nodes, canvas.edges);
    const reloaded = parseDiagramSpec(JSON.parse(JSON.stringify(saved)));
    assert.deepEqual(reloaded.value.nodes[0].labelRichText, tasks);
    assert.deepEqual(reloaded.value.nodes[0].detailRichText, tasks);
    assert.equal(reloaded.value.nodes[0].label, 'Write notes\nVerify build');
  }
  assert.equal(parseDiagramSpec(spec({ label: 'Task', labelRichText: [{ checked: 'false', runs: [{ text: 'Task' }] }] })).ok, false);
  assert.deepEqual(parseFlowRichText([{ bullet: true, checked: false, runs: [{ text: 'Task' }] }], 'Task'), [{ checked: false, runs: [{ text: 'Task' }] }]);
});

test('normalizing, truncating and measuring soft lines keep their checkbox state', () => {
  const tasks = [{ checked: false, runs: [{ text: '  Write notes  \n  and examples  ', bold: true }] },
    { checked: true, runs: [{ text: ' Verify build ' }] }];
  const normalized = parseFlowRichText(tasks, 'Write notes\nand examples\nVerify build');
  assert.deepEqual(normalized.map(paragraph => paragraph.checked), [false, true]);
  assert.deepEqual(richTextVisualLines(normalized).map(paragraph => paragraph.checked), [false, false, true]);
  assert.equal(truncateRichText(normalized, 8)[0].checked, false);
  const html = richTextHtml(normalized);
  assert.equal((html.match(/role="checkbox"/g) || []).length, 2);
  assert.equal((html.match(/aria-checked="false"/g) || []).length, 1);
  assert.equal((html.match(/aria-checked="true"/g) || []).length, 1);
  assert.match(richTextHtml(normalized, false), /disabled tabindex="-1"/);
  assert.ok(flowNodeSize({ label: 'Task', shape: 'text', labelRichText: [{ checked: false, runs: [{ text: 'Task' }] }] }).width > flowNodeSize({ label: 'Task', shape: 'text' }).width);
});

test('checkbox formatting applies only to selected paragraphs and converts between list types', () => {
  const paragraphs = [{ runs: [{ text: 'Intro' }] }, { bullet: true, runs: [{ text: 'First', bold: true }] },
    { checked: true, runs: [{ text: 'Second' }] }];
  assert.deepEqual(richTextSelectedParagraphs(paragraphs, { start: 6, end: 12 }), [1]);
  const marked = toggleChecklist(paragraphs, { start: 6, end: 18 });
  assert.equal(marked[0].checked, undefined);
  assert.equal(marked[1].checked, false);
  assert.equal(marked[1].bullet, undefined);
  assert.equal(marked[1].runs[0].bold, true);
  assert.equal(marked[2].checked, true);
  const removed = toggleChecklist(marked, { start: 6, end: 18 });
  assert.equal(removed[1].checked, undefined);
  const bullets = checklistToBullets(marked, { start: 6, end: 11 });
  assert.equal(bullets[1].bullet, true);
  assert.equal(bullets[1].checked, undefined);
  assert.equal(bullets[2].checked, true);
});

test('Enter splits checked tasks into an unchecked next task and exits an empty task', () => {
  const paragraphs = [{ checked: true, runs: [{ text: 'First second', bold: true }] }];
  const next = continueList(paragraphs, { start: 6, end: 6 });
  assert.deepEqual(next.richText, [{ checked: true, runs: [{ text: 'First ', bold: true }] },
    { checked: false, runs: [{ text: 'second', bold: true }] }]);
  assert.deepEqual(next.selection, { start: 7, end: 7 });
  const empty = continueList([{ checked: false, runs: [] }], { start: 0, end: 0 });
  assert.deepEqual(empty.richText, [{ runs: [] }]);
  const across = continueList([{ checked: true, runs: [{ text: 'First' }] },
    { checked: true, runs: [{ text: 'Second' }] }], { start: 2, end: 6 });
  assert.equal(richTextPlainText(across.richText), 'Fi\nSecond');
  assert.equal(across.richText[1].checked, false);
});

test('nested bullets and checklists survive diagram save and reload with inline marks', () => {
  const nested = [{ bullet: true, runs: [{ text: 'Plan' }] },
    { bullet: true, level: 1, runs: [{ text: 'Write notes', bold: true }] },
    { checked: true, level: 2, runs: [{ text: 'Check details', italic: true }] },
    { checked: false, level: 1, runs: [{ text: 'Verify build' }] },
    { bullet: true, runs: [{ text: 'Release' }] }];
  const label = richTextPlainText(nested);
  for (const shape of ['rounded', 'box', 'pill', 'diamond', 'text', 'note']) {
    const parsed = parseDiagramSpec(spec({ label, labelRichText: nested, detail: label, detailRichText: nested, shape }));
    assert.equal(parsed.ok, true);
    const canvas = layoutDiagram(parsed.value);
    const saved = flowSpecFromCanvas({}, canvas.nodes, canvas.edges);
    const reloaded = parseDiagramSpec(JSON.parse(JSON.stringify(saved)));
    assert.deepEqual(reloaded.value.nodes[0].labelRichText, nested);
    assert.deepEqual(reloaded.value.nodes[0].detailRichText, nested);
  }
  const html = richTextHtml(nested);
  assert.match(html, /<li data-flow-paragraph="0">Plan<ul><li data-flow-paragraph="1"><b>Write notes<\/b><ul data-flow-checklist="true">/);
  assert.match(html, /Check details<\/i><\/li><\/ul><\/li><\/ul><ul data-flow-checklist="true">/);
  assert.match(html, /Verify build<\/li><\/ul><\/li><li data-flow-paragraph="4">Release<\/li><\/ul>$/);
  for (const level of [-1, 1.5, '1', null, FLOW_LIST_MAX_LEVEL + 1]) {
    assert.equal(parseDiagramSpec(spec({ label: 'Bad', labelRichText: [{ bullet: true, level, runs: [{ text: 'Bad' }] }] })).ok, false);
  }
  assert.deepEqual(parseFlowRichText([{ bullet: true, level: 2, runs: [{ text: 'First' }] },
    { bullet: true, level: 3, runs: [{ text: 'Child' }] }], 'First\nChild').map(p => p.level ?? 0), [0, 1]);
});

test('indent and outdent preserve selected subtrees, marks, and list kinds without orphan levels', () => {
  const list = [{ bullet: true, runs: [{ text: 'One' }] },
    { bullet: true, runs: [{ text: 'Two', bold: true }] },
    { checked: true, level: 1, runs: [{ text: 'Child' }] },
    { bullet: true, level: 1, runs: [{ text: 'Sibling' }] },
    { bullet: true, runs: [{ text: 'Three' }] }];
  const selection = { start: 4, end: 10 };
  const nested = shiftListIndent(list, selection, 1);
  assert.deepEqual(nested.map(p => p.level ?? 0), [0, 1, 2, 2, 0]);
  assert.equal(nested[1].runs[0].bold, true);
  assert.equal(nested[2].checked, true);
  assert.deepEqual(shiftListIndent(nested, selection, -1), list);
  assert.equal(shiftListIndent(list, { start: 0, end: 3 }, 1), list, 'the first item cannot indent without a preceding sibling');
  assert.equal(shiftListIndent(list, { start: 0, end: 3 }, -1), list, 'top-level items cannot outdent below zero');
  assert.equal(shiftListIndent(list, { start: 8, end: 8 }, 1), list, 'a first child cannot indent under its parent again');
  const checks = toggleChecklist(nested, { start: 4, end: 7 });
  assert.equal(checks[1].level, 1);
  assert.equal(checks[1].checked, false);
  assert.deepEqual(toggleBullets(checks, { start: 4, end: 7 }), nested);
  const removed = toggleBullets(nested, { start: 4, end: 7 });
  assert.equal(removed[1].bullet, undefined);
  assert.equal(removed[1].level, undefined);
  assert.deepEqual(removed.slice(2).map(p => p.level ?? 0), [0, 0, 0]);
  const deep = Array.from({ length: FLOW_LIST_MAX_LEVEL + 2 }, (_, index) => ({ bullet: true,
    ...(index ? { level: Math.min(index, FLOW_LIST_MAX_LEVEL) } : {}), runs: [{ text: 'x' }] }));
  const end = richTextPlainText(deep).length;
  assert.equal(shiftListIndent(deep, { start: end, end }, 1), deep, 'depth is bounded');
});

test('Enter and soft lines retain nesting; empty nested items outdent before leaving the list', () => {
  const list = [{ bullet: true, runs: [{ text: 'Parent' }] },
    { bullet: true, level: 1, runs: [{ text: 'Child', bold: true }] }];
  const split = continueList(list, { start: 9, end: 9 });
  assert.deepEqual(split.richText.map(p => p.level ?? 0), [0, 1, 1]);
  assert.equal(split.richText[2].bullet, true);
  assert.equal(split.richText[2].runs[0].bold, true);
  const empty = [...list, { checked: false, level: 1, runs: [] }];
  const caret = { start: 13, end: 13 };
  const outdent = continueList(empty, caret);
  assert.equal(outdent.richText.at(-1).level, undefined);
  assert.equal(outdent.richText.at(-1).checked, false);
  assert.equal(continueList(outdent.richText, caret).richText.at(-1).checked, undefined);
  const soft = [{ bullet: true, runs: [{ text: 'Parent' }] },
    { checked: false, level: 1, runs: [{ text: ' Child \n continuation ' }] }];
  const normalized = parseFlowRichText(soft, 'Parent\nChild\ncontinuation');
  assert.deepEqual(richTextVisualLines(normalized).map(p => p.level ?? 0), [0, 1, 1]);
  assert.equal(truncateRichText(normalized, 10)[1].level, 1);
  const nested = { label: 'Parent\naaaa aaaa aaaa', shape: 'text', labelRichText: [list[0], { bullet: true, level: 1, runs: [{ text: 'aaaa aaaa aaaa' }] }] };
  const flat = { ...nested, labelRichText: [list[0], { ...nested.labelRichText[1], level: undefined }] };
  assert.ok(flowNodeSize(nested).width > flowNodeSize(flat).width);
  assert.ok(flowNodeSize({ ...nested, size: { width: 100, height: 16 } }).height > flowNodeSize({ ...flat, size: { width: 100, height: 16 } }).height);
});
