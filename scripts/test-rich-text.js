'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const esbuild = require('esbuild');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-rich-text-'));
const modules = {};
for (const name of ['rich-text', 'layout', 'validate', 'flow-editor', 'types']) {
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
const { DIAGRAM_TEXT_MAX_LENGTH, FLOW_BOX_TEXT_MAX_LENGTH } = modules.types;
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

test('document references validate and round-trip through canvas layout without Markdown in the spec', () => {
  const documentId = 'A0000000-0000-0000-0000-000000000001';
  const parsed = parseDiagramSpec(spec({ label: 'Integration brief', shape: 'document', documentId }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.nodes[0].documentId, documentId.toLowerCase());
  const canvas = layoutDiagram(parsed.value);
  assert.deepEqual({ width: canvas.nodes[0].width, height: canvas.nodes[0].height }, { width: 240, height: 76 });
  const saved = flowSpecFromCanvas({}, canvas.nodes, canvas.edges);
  assert.equal(saved.nodes[0].documentId, documentId.toLowerCase());
  assert.equal(parseDiagramSpec(saved).ok, true);
  for (const invalid of [undefined, '../file.md', 'invalid']) {
    assert.equal(parseDiagramSpec(spec({ label: 'Brief', shape: 'document', documentId: invalid })).ok, false);
  }
  const ordinary = parseDiagramSpec(spec({ label: 'Step', documentId }));
  assert.equal(ordinary.ok, true);
  assert.equal(ordinary.value.nodes[0].documentId, undefined);
});

// ── Switchboard: the workspace an answer read, and pinned terminals ──

test('the workspace an answer read round-trips while the box is still the AI’s, and is dropped once it is not', () => {
  const parsed = parseDiagramSpec(spec({ label: 'Issued in the session module', ai: true, answeredIn: ' sample-2 ' }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.nodes[0].answeredIn, 'sample-2');
  const canvas = layoutDiagram(parsed.value);
  assert.equal(canvas.nodes[0].data.answeredIn, 'sample-2');
  const saved = flowSpecFromCanvas({}, canvas.nodes, canvas.edges);
  assert.equal(saved.nodes[0].answeredIn, 'sample-2');
  const reloaded = parseDiagramSpec(JSON.parse(JSON.stringify(saved)));
  assert.equal(reloaded.ok, true);
  assert.equal(reloaded.value.nodes[0].answeredIn, 'sample-2');
  assert.equal(reloaded.value.nodes[0].ai, true);

  // Without the AI's mark the tag means nothing: not read, not laid out, not saved.
  for (const ai of [undefined, false]) {
    const plain = parseDiagramSpec(spec({ label: 'Edited by hand', ai, answeredIn: 'sample-2' }));
    assert.equal(plain.ok, true);
    assert.equal(plain.value.nodes[0].answeredIn, undefined);
    assert.equal(layoutDiagram(plain.value).nodes[0].data.answeredIn, undefined);
  }
  const edited = { ...canvas.nodes[0], data: { ...canvas.nodes[0].data, ai: undefined } };
  assert.equal(flowSpecFromCanvas({}, [edited], []).nodes[0].answeredIn, undefined);
});

test('an answeredIn that is not a workspace id is dropped without failing the whiteboard', () => {
  for (const invalid of ['../sample-2', '/Users/example/sample-2', 'example\\sample-2', '.hidden', 'x'.repeat(201), 'two\nlines', '', '   ', 42, {}]) {
    const parsed = parseDiagramSpec(spec({ label: 'An answer', ai: true, answeredIn: invalid }));
    assert.equal(parsed.ok, true, JSON.stringify(invalid));
    assert.equal(parsed.value.nodes[0].answeredIn, undefined, JSON.stringify(invalid));
    assert.equal(parsed.value.nodes[0].ai, true);
  }
});

test('republishing carries the workspace an answer read only while its words are unchanged', () => {
  const previous = { kind: 'flow', nodes: [{ id: 'a', label: 'Answer', ai: true, answeredIn: 'example-1' }], edges: [] };
  const same = carryOverFlowLayout(previous, { kind: 'flow', nodes: [{ id: 'a', label: 'Answer' }], edges: [] }).spec;
  assert.equal(same.nodes[0].ai, true);
  assert.equal(same.nodes[0].answeredIn, 'example-1');
  const rewritten = carryOverFlowLayout(previous, { kind: 'flow', nodes: [{ id: 'a', label: 'Rewritten' }], edges: [] }).spec;
  assert.equal(rewritten.nodes[0].ai, undefined);
  assert.equal(rewritten.nodes[0].answeredIn, undefined);
  const cleared = carryOverFlowLayout(previous, { kind: 'flow', nodes: [{ id: 'a', label: 'Answer', ai: false }], edges: [] }).spec;
  assert.equal(cleared.nodes[0].answeredIn, undefined);
});

test('a pinned terminal round-trips with its workspace, size, type size and folded state', () => {
  const terminal = { id: 'terminal-sample-2', label: 'anything', shape: 'terminal', workspace: 'sample-2', size: { width: 600, height: 360 }, font: 15.625, minimized: false, position: { x: 40, y: 80 } };
  const parsed = parseDiagramSpec(spec(terminal));
  assert.equal(parsed.ok, true);
  const node = parsed.value.nodes[0];
  assert.equal(node.label, 'sample-2', 'labelled with its workspace');
  assert.equal(node.workspace, 'sample-2');
  assert.deepEqual(node.size, { width: 600, height: 360 });
  assert.equal(node.font, 15.625);
  assert.equal(node.minimized, undefined);

  const canvas = layoutDiagram(parsed.value);
  assert.deepEqual({ width: canvas.nodes[0].width, height: canvas.nodes[0].height }, { width: 600, height: 360 });
  const saved = flowSpecFromCanvas({}, canvas.nodes, canvas.edges);
  assert.deepEqual(
    { label: saved.nodes[0].label, shape: saved.nodes[0].shape, workspace: saved.nodes[0].workspace, size: saved.nodes[0].size, font: saved.nodes[0].font, minimized: saved.nodes[0].minimized },
    { label: 'sample-2', shape: 'terminal', workspace: 'sample-2', size: { width: 600, height: 360 }, font: 15.625, minimized: undefined },
  );
  const reloaded = parseDiagramSpec(JSON.parse(JSON.stringify(saved)));
  assert.equal(reloaded.ok, true);
  assert.deepEqual(reloaded.value.nodes[0], { ...saved.nodes[0], labelRichText: undefined, detailRichText: undefined, detail: undefined });

  // Folded to its title bar: only the header's height, its size kept for unfolding.
  const folded = parseDiagramSpec(spec({ ...terminal, minimized: true }));
  assert.equal(folded.value.nodes[0].minimized, true);
  const foldedCanvas = layoutDiagram(folded.value);
  assert.deepEqual({ width: foldedCanvas.nodes[0].width, height: foldedCanvas.nodes[0].height }, { width: 600, height: 30 });
  const foldedSaved = flowSpecFromCanvas({}, foldedCanvas.nodes, foldedCanvas.edges);
  assert.equal(foldedSaved.nodes[0].minimized, true);
  assert.deepEqual(foldedSaved.nodes[0].size, { width: 600, height: 360 });

  // No size of its own: the default.
  assert.deepEqual(flowNodeSize({ label: 'demo', shape: 'terminal' }), { width: 560, height: 340 });
  // Pinned at a high zoom, a panel's size on screen is fewer canvas units than the
  // resize handles allow: it opens again at that size, not grown to their minimum.
  assert.deepEqual(flowNodeSize({ label: 'demo', shape: 'terminal', size: { width: 224, height: 136 } }), { width: 224, height: 136 });
  saved.nodes[0].size = { width: 224, height: 136 };
  const small = layoutDiagram(parseDiagramSpec(JSON.parse(JSON.stringify(saved))).value);
  assert.deepEqual({ width: small.nodes[0].width, height: small.nodes[0].height }, { width: 224, height: 136 });
  // Never under its header's buttons and a sliver of body, though.
  assert.deepEqual(flowNodeSize({ label: 'demo', shape: 'terminal', size: { width: 20, height: 20 } }), { width: 96, height: 46 });
});

test('a pinned terminal with no workspace id fails; its type size is clamped; its fields stay off other shapes', () => {
  for (const invalid of [undefined, '', '/Users/example/demo', '../demo', 'demo/sub', '.demo', 'x'.repeat(201)]) {
    const parsed = parseDiagramSpec(spec({ label: 'demo', shape: 'terminal', workspace: invalid }));
    assert.equal(parsed.ok, false, JSON.stringify(invalid));
    assert.match(parsed.error, /workspace/);
  }
  const big = parseDiagramSpec(spec({ label: 'demo', shape: 'terminal', workspace: 'demo', font: 1000 }));
  assert.equal(big.value.nodes[0].font, 80);
  const small = parseDiagramSpec(spec({ label: 'demo', shape: 'terminal', workspace: 'demo', font: 0.5 }));
  assert.equal(small.value.nodes[0].font, 4);
  const word = parseDiagramSpec(spec({ label: 'demo', shape: 'terminal', workspace: 'demo', font: 'large' }));
  assert.equal(word.value.nodes[0].font, undefined);

  const box = parseDiagramSpec(spec({ label: 'A step', workspace: 'demo', font: 12, minimized: true }));
  assert.equal(box.ok, true);
  assert.deepEqual([box.value.nodes[0].workspace, box.value.nodes[0].font, box.value.nodes[0].minimized], [undefined, undefined, undefined]);
});

// ── Switchboard: long words in a box, and boxes resized by hand ──

test('a box holds far more than an arrow label’s 200 characters, marks and all, through save and reload', () => {
  const long = 'A long thought about the fictional checkout flow and why it waits on the card. '.repeat(40).trim();
  assert.ok(long.length > 3000);
  const marked = [{ runs: [{ text: long.slice(0, 6), bold: true }, { text: long.slice(6) }] }];
  for (const shape of ['rounded', 'box', 'pill', 'diamond', 'note', 'text']) {
    const parsed = parseDiagramSpec(spec({ label: long, labelRichText: marked, detail: long, shape }));
    assert.equal(parsed.ok, true, shape);
    const canvas = layoutDiagram(parsed.value);
    const saved = flowSpecFromCanvas({}, canvas.nodes, canvas.edges);
    const reloaded = parseDiagramSpec(JSON.parse(JSON.stringify(saved)));
    assert.equal(reloaded.ok, true, shape);
    assert.equal(reloaded.value.nodes[0].label, long, shape);
    assert.equal(reloaded.value.nodes[0].detail, long, shape);
    assert.deepEqual(reloaded.value.nodes[0].labelRichText, marked, shape);
  }
  // Still bounded, so a hand-edited file can't hand the layout a novel.
  assert.equal(FLOW_BOX_TEXT_MAX_LENGTH, 10_000);
  assert.equal(parseDiagramSpec(spec({ label: 'x'.repeat(FLOW_BOX_TEXT_MAX_LENGTH) })).ok, true);
  const over = parseDiagramSpec(spec({ label: 'x'.repeat(FLOW_BOX_TEXT_MAX_LENGTH + 1) }));
  assert.equal(over.ok, false);
  assert.match(over.error, /"label" must be 10000 characters or fewer/);
  const detail = parseDiagramSpec(spec({ label: 'Step', detail: 'x'.repeat(FLOW_BOX_TEXT_MAX_LENGTH + 1) }));
  assert.match(detail.error, /"detail" must be 10000 characters or fewer/);
  // An arrow's label is still one short line.
  const arrow = parseDiagramSpec({ kind: 'flow', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    edges: [{ from: 'a', to: 'b', label: 'x'.repeat(DIAGRAM_TEXT_MAX_LENGTH + 1) }] });
  assert.equal(arrow.ok, false);
  assert.match(arrow.error, /200 characters or fewer/);
});

test('a box resized by hand keeps its size through save and reload, on every outline', () => {
  for (const shape of ['rounded', 'box', 'pill', 'diamond']) {
    const parsed = parseDiagramSpec(spec({ label: 'Charge the card', shape, size: { width: 360.4, height: 139.6 } }));
    assert.equal(parsed.ok, true, shape);
    assert.deepEqual(parsed.value.nodes[0].size, { width: 360, height: 140 }, shape);
    const canvas = layoutDiagram(parsed.value);
    assert.deepEqual({ width: canvas.nodes[0].width, height: canvas.nodes[0].height }, { width: 360, height: 140 }, shape);
    const saved = flowSpecFromCanvas({}, canvas.nodes, canvas.edges);
    assert.deepEqual(saved.nodes[0].size, { width: 360, height: 140 }, shape);
    const reloaded = parseDiagramSpec(JSON.parse(JSON.stringify(saved)));
    assert.deepEqual(reloaded.value.nodes[0].size, { width: 360, height: 140 }, shape);
  }
  // Never resized: as wide as every other box and as tall as its text, as ever.
  assert.deepEqual(flowNodeSize({ label: 'Charge the card' }), { width: 200, height: 52 });
  assert.deepEqual(flowNodeSize({ label: 'Charge the card', shape: 'diamond' }), { width: 200, height: 92 });
  // A document's size is still its own.
  const documentId = 'a0000000-0000-0000-0000-000000000001';
  const file = parseDiagramSpec(spec({ label: 'Brief', shape: 'document', documentId, size: { width: 400, height: 300 } }));
  assert.equal(file.value.nodes[0].size, undefined);
});

test('a resized box wraps its words to its own width, and grows past its height only when they need it', () => {
  setFlowTextMeasure(text => text.length * 10);
  try {
    // Thirty four-letter words. 128 wide leaves 100 for the label: two words a line.
    // 528 leaves 500: ten a line. Each line is 18 high, plus 22 of padding.
    const words = 'aaaa '.repeat(30).trim();
    assert.deepEqual(flowNodeSize({ label: words, size: { width: 128, height: 40 } }), { width: 128, height: 15 * 18 + 22 });
    assert.deepEqual(flowNodeSize({ label: words, size: { width: 528, height: 40 } }), { width: 528, height: 3 * 18 + 22 });
    // Taller than the words need: as tall as it was made.
    assert.deepEqual(flowNodeSize({ label: words, size: { width: 528, height: 300 } }), { width: 528, height: 300 });
    // A diamond pads its label further in: 164 wide leaves the same 100.
    assert.deepEqual(flowNodeSize({ label: words, shape: 'diamond', size: { width: 164, height: 40 } }), { width: 164, height: 15 * 18 + 22 });
  } finally { setFlowTextMeasure(null); }
});

test('a box’s size carries over a republish onto any outline, but never onto a note', () => {
  const before = { kind: 'flow', nodes: [{ id: 'pay', label: 'Pay', size: { width: 320, height: 120 }, position: { x: 0, y: 0 } }], edges: [] };
  const next = node => ({ kind: 'flow', nodes: [{ id: 'pay', label: 'Pay', ...node }], edges: [] });
  assert.deepEqual(carryOverFlowLayout(before, next({})).spec.nodes[0].size, { width: 320, height: 120 });
  assert.deepEqual(carryOverFlowLayout(before, next({ shape: 'diamond' })).spec.nodes[0].size, { width: 320, height: 120 });
  assert.equal(carryOverFlowLayout(before, next({ shape: 'note' })).spec.nodes[0].size, undefined);
  // What the republish states itself wins.
  assert.deepEqual(carryOverFlowLayout(before, next({ size: { width: 240, height: 80 } })).spec.nodes[0].size, { width: 240, height: 80 });
});

// ── Switchboard: code blocks in a box's text ──
//
// A paragraph with `code: true` is a code block (types.ts FlowTextParagraph.code): the
// user asked for code "directly within the text" with "a copy button that appears
// within the code block itself" (2026-11-01). Its spaces are kept — the plain label is
// still tidied as every label is, so the rich text is read as the label is kept.

const code = (text) => ({ code: true, runs: [{ text }] });
const { toggleCode, leaveCode, insertCodeText, normalizeFlowText } = modules["rich-text"];
const { FLOW_CODE_LINE_HEIGHT, FLOW_CODE_PAD_Y, FLOW_CODE_GAP, FLOW_CODE_PAD_X, FLOW_TEXT_METRICS } = modules.layout;

test('a code block keeps its indentation through validation, canvas snapshots and reload, while the label is tidied', () => {
  const rich = [{ runs: [{ text: 'Install, then test:' }] }, code('  npm install\n    npm test'), { runs: [{ text: 'Done' }] }];
  const label = normalizeFlowText(richTextPlainText(rich));
  assert.equal(label, 'Install, then test:\nnpm install\nnpm test\nDone', 'the plain label collapses the indentation');
  for (const shape of ['rounded', 'box', 'pill', 'diamond', 'text', 'note']) {
    const parsed = parseDiagramSpec(spec({ label, labelRichText: rich, shape, detail: label, detailRichText: rich }));
    assert.equal(parsed.ok, true, shape);
    assert.deepEqual(parsed.value.nodes[0].labelRichText, rich, 'the rich text keeps the spaces');
    assert.equal(parsed.value.nodes[0].label, label);
    const canvas = layoutDiagram(parsed.value);
    const saved = flowSpecFromCanvas({}, canvas.nodes, canvas.edges);
    const reloaded = parseDiagramSpec(JSON.parse(JSON.stringify(saved)));
    assert.equal(reloaded.ok, true, shape);
    assert.deepEqual(reloaded.value.nodes[0].labelRichText, rich, shape);
    assert.deepEqual(reloaded.value.nodes[0].detailRichText, rich, shape);
    assert.equal(reloaded.value.nodes[0].label, label, shape);
  }
  // Still never onto changed words.
  assert.equal(parseFlowRichText(rich, 'Other words\nnpm install\nnpm test\nDone'), undefined);
  // And a code flag that isn't a flag is refused, as a checklist state that isn't one is.
  assert.equal(parseDiagramSpec(spec({ label: 'x', labelRichText: [{ code: 'yes', runs: [{ text: 'x' }] }] })).ok, false);
});

test('tidying a code block keeps its spaces and lines, drops marks and list marks, trims what trails, and joins adjacent blocks', () => {
  const messy = [
    { code: true, bullet: true, level: 1, runs: [{ text: '  if (a) {   \n', bold: true }, { text: '    go()  ', italic: true }] },
    { code: true, runs: [{ text: '}' }] },
    { runs: [{ text: '  after  ' }] },
  ];
  const tidy = parseFlowRichText(messy, normalizeFlowText(richTextPlainText(messy)));
  assert.deepEqual(tidy, [code('  if (a) {\n    go()\n}'), { runs: [{ text: 'after' }] }]);
  // Blank lines inside a block collapse to one, as they do in any text; a tab stays.
  assert.deepEqual(parseFlowRichText([code('a\n\n\n\tb')], 'a\n\nb'), [code('a\n\n\tb')]);
  // A block that is only spaces is an empty block, and trailing empty lines go.
  assert.deepEqual(parseFlowRichText([{ runs: [{ text: 'x' }] }, code('   '), code('y\n\n')], 'x\n\ny'), [{ runs: [{ text: 'x' }] }, code('\ny')]);
});

test('a code block is drawn as a <pre> with its copy button, its text escaped and unmarked', () => {
  const html = richTextHtml([{ runs: [{ text: 'Run' }] }, code('<b>x</b> && y'), { bullet: true, runs: [{ text: 'then' }] }]);
  assert.match(html, /^<div data-flow-paragraph="0">Run<\/div><pre data-flow-paragraph="1" class="flow-code"><button type="button" contenteditable="false" class="flow-code-copy nodrag nopan" data-flow-copy="1" aria-label="Copy code" title="Copy code"><svg[^]*?<\/svg><svg[^]*?<\/svg><\/button>&lt;b&gt;x&lt;\/b&gt; &amp;&amp; y<\/pre><ul><li data-flow-paragraph="2">then<\/li><\/ul>$/);
  assert.doesNotMatch(html, /<b>/);
  // The button is never disabled: it copies on the read-only canvas too.
  assert.doesNotMatch(richTextHtml([code('x')], false), /disabled/);
  assert.match(richTextHtml([code('')]), /<pre data-flow-paragraph="0" class="flow-code"><button[^]*?<\/button><br><\/pre>/);
});

test('Code block makes the selected paragraphs one block and back, with the plain text unchanged', () => {
  const paragraphs = [{ runs: [{ text: 'Intro' }] }, { bullet: true, runs: [{ text: 'first', bold: true }] }, { checked: true, runs: [{ text: 'second' }] }, { runs: [{ text: 'Outro' }] }];
  const plain = richTextPlainText(paragraphs);
  const block = toggleCode(paragraphs, { start: 6, end: 14 });
  assert.deepEqual(block, [{ runs: [{ text: 'Intro' }] }, code('first\nsecond'), { runs: [{ text: 'Outro' }] }]);
  assert.equal(richTextPlainText(block), plain);
  // A block made beside another is one block with it.
  assert.deepEqual(toggleCode(block, { start: 0, end: 2 }), [code('Intro\nfirst\nsecond'), { runs: [{ text: 'Outro' }] }]);
  // Off again: the block's lines are one paragraph's soft breaks.
  assert.deepEqual(toggleCode(block, { start: 8, end: 8 }), [{ runs: [{ text: 'Intro' }] }, { runs: [{ text: 'first\nsecond' }] }, { runs: [{ text: 'Outro' }] }]);
  assert.equal(toggleCode([], { start: 0, end: 0 }).length, 0);
});

test('Enter on an empty last line leaves the code block for a paragraph after it; elsewhere it is a new line of code', () => {
  const value = [{ runs: [{ text: 'Run' }] }, code('npm test\n'), { runs: [{ text: 'Done' }] }];
  // The caret at the very end of the block, on its empty line (offset 4 + 9).
  const left = leaveCode(value, { start: 13, end: 13 });
  assert.deepEqual(left.richText, [{ runs: [{ text: 'Run' }] }, code('npm test'), { runs: [] }, { runs: [{ text: 'Done' }] }]);
  assert.deepEqual(left.selection, { start: 13, end: 13 }, 'the caret is in the new paragraph, at the same offset');
  assert.equal(richTextPlainText(left.richText), richTextPlainText(value));
  // Mid-block, or with a selection, or on a line with code on it: a new line instead.
  assert.equal(leaveCode(value, { start: 8, end: 8 }), null);
  assert.equal(leaveCode(value, { start: 12, end: 13 }), null);
  assert.equal(leaveCode([code('npm test')], { start: 8, end: 8 }), null);
  // A block that is only an empty line becomes the paragraph.
  assert.deepEqual(leaveCode([{ runs: [{ text: 'Run' }] }, code('')], { start: 4, end: 4 }), { richText: [{ runs: [{ text: 'Run' }] }, { runs: [] }], selection: { start: 4, end: 4 } });
  // Not in a code block: nothing to leave.
  assert.equal(leaveCode(value, { start: 2, end: 2 }), null);
});

test('a code block is measured in monospace with its slab, so the box grows to hold it', () => {
  const edge = FLOW_CODE_PAD_Y + FLOW_CODE_GAP;
  // One line of code: its line, the slab's padding and the gap round it, over a plain paragraph's 18.
  assert.equal(flowNodeSize({ label: 'x', labelRichText: [code('x')] }).height, FLOW_CODE_LINE_HEIGHT + 2 * edge + 22);
  assert.equal(flowNodeSize({ label: 'Run\nx', labelRichText: [{ runs: [{ text: 'Run' }] }, code('x')] }).height, FLOW_TEXT_METRICS.medium.lineHeight + FLOW_CODE_LINE_HEIGHT + 2 * edge + 22);
  // Three lines of code are one slab: three lines, one padding.
  assert.equal(flowNodeSize({ label: 'a\nb\nc', labelRichText: [code('a\nb\nc')] }).height, 3 * FLOW_CODE_LINE_HEIGHT + 2 * edge + 22);
  // A note and a text grow the same way; a text runs as wide as its code, slab and all.
  assert.ok(flowNodeSize({ label: 'a\nb\nc', shape: 'note', labelRichText: [code('a\nb\nc')] }).height >= 3 * FLOW_CODE_LINE_HEIGHT + 2 * edge + 28);
  setFlowTextMeasure((text, _size, _weight, mono) => text.length * (mono ? 7 : 10));
  try {
    const plain = flowNodeSize({ label: 'aaaa aaaa', shape: 'text' });
    const asCode = flowNodeSize({ label: 'aaaa aaaa', shape: 'text', labelRichText: [code('aaaa aaaa')] });
    assert.equal(plain.width, 9 * 10 + 4 * 2 + 2);
    assert.equal(asCode.width, 9 * 7 + FLOW_CODE_PAD_X * 2 + 4 * 2 + 2, 'measured in monospace, inside the slab');
    assert.equal(asCode.height, FLOW_CODE_LINE_HEIGHT + 2 * edge + 3 * 2);
    // Code wraps inside the slab: 100 wide leaves 100 - 16 - 8 = 76 for the code's words, 10 characters a line.
    const wrapped = flowNodeSize({ label: 'aaaa aaaa aaaa aaaa', shape: 'text', size: { width: 100, height: 16 }, labelRichText: [code('aaaa aaaa aaaa aaaa')] });
    assert.equal(wrapped.height, 2 * FLOW_CODE_LINE_HEIGHT + 2 * edge + 3 * 2);
    // Indentation counts: eight spaces and a word do not fit where the word alone did.
    const indented = flowNodeSize({ label: 'aaaa', shape: 'text', size: { width: 100, height: 16 }, labelRichText: [code('        aaaa aaaa')] });
    assert.equal(indented.height, 2 * FLOW_CODE_LINE_HEIGHT + 2 * edge + 3 * 2);
  } finally { setFlowTextMeasure(null); }
});

test('a code block carries over a republish while its words match, and a republish may state one', () => {
  const rich = [{ runs: [{ text: 'Run' }] }, code('  npm test')];
  const before = spec({ label: 'Run\nnpm test', labelRichText: rich });
  assert.deepEqual(carryOverFlowLayout(before, spec({ label: 'Run\nnpm test' })).spec.nodes[0].labelRichText, rich);
  assert.equal(carryOverFlowLayout(before, spec({ label: 'Run\nnpm build' })).spec.nodes[0].labelRichText, undefined);
  const stated = parseDiagramSpec(spec({ label: 'Run\n  npm test', labelRichText: rich }));
  assert.equal(stated.ok, true);
  assert.equal(stated.value.nodes[0].label, 'Run\nnpm test', 'a label handed in with the indentation is tidied');
  assert.deepEqual(stated.value.nodes[0].labelRichText, rich);
});

test('typing into a code block through the words: Enter\'s new line and a paste of several lines, in place of the selection', () => {
  const value = [{ runs: [{ text: 'Run' }] }, code('npm test'), { runs: [{ text: 'Done' }] }];
  // Enter at the end of the block: an empty line to type on, drawn as such.
  const broken = insertCodeText(value, { start: 12, end: 12 }, '\n');
  assert.deepEqual(broken, { richText: [{ runs: [{ text: 'Run' }] }, code('npm test\n'), { runs: [{ text: 'Done' }] }], selection: { start: 13, end: 13 } });
  assert.match(richTextHtml(broken.richText), /npm test\n<br><\/pre>/);
  assert.doesNotMatch(richTextHtml(value), /<br>/);
  // In the middle, in place of a selection.
  assert.deepEqual(insertCodeText(value, { start: 7, end: 8 }, '\n').richText[1], code('npm\ntest'));
  // Several lines pasted, indentation and all.
  const pasted = insertCodeText(value, { start: 12, end: 12 }, '\n  if (a) {\n    b()\n  }');
  assert.equal(richTextPlainText([pasted.richText[1]]), 'npm test\n  if (a) {\n    b()\n  }');
  assert.deepEqual(pasted.selection, { start: 12 + '\n  if (a) {\n    b()\n  }'.length, end: 12 + '\n  if (a) {\n    b()\n  }'.length });
  // Not within one block: nothing — the browser's own insertion will do.
  assert.equal(insertCodeText(value, { start: 1, end: 1 }, '\n'), null);
  assert.equal(insertCodeText(value, { start: 2, end: 6 }, '\n'), null, 'a selection across the block\'s edge');
  // The empty line typed on, then left: the block as it was, and the paragraph after it.
  const left = leaveCode(broken.richText, broken.selection);
  assert.deepEqual(left.richText, [{ runs: [{ text: 'Run' }] }, code('npm test'), { runs: [] }, { runs: [{ text: 'Done' }] }]);
});
