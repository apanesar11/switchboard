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
  richTextSelectedParagraphs, toggleChecklist, checklistToBullets, continueChecklist } = modules['rich-text'];
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
  const next = continueChecklist(paragraphs, { start: 6, end: 6 });
  assert.deepEqual(next.richText, [{ checked: true, runs: [{ text: 'First ', bold: true }] },
    { checked: false, runs: [{ text: 'second', bold: true }] }]);
  assert.deepEqual(next.selection, { start: 7, end: 7 });
  const empty = continueChecklist([{ checked: false, runs: [] }], { start: 0, end: 0 });
  assert.deepEqual(empty.richText, [{ runs: [] }]);
  const across = continueChecklist([{ checked: true, runs: [{ text: 'First' }] },
    { checked: true, runs: [{ text: 'Second' }] }], { start: 2, end: 6 });
  assert.equal(richTextPlainText(across.richText), 'Fi\nSecond');
  assert.equal(across.richText[1].checked, false);
});
