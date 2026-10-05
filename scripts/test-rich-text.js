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

const { parseFlowRichText, richTextPlainText, richTextHtml, truncateRichText } = modules['rich-text'];
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
  assert.equal((richTextHtml(parsed).match(/<li>/g) || []).length, 1);
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
  assert.equal(html, '<ul><li><b>&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp;</b></li></ul>');
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
