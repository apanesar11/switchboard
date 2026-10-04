'use strict';

// Condense's graph edits are local and atomic: provider text must never decide
// which existing boxes get deleted or disconnect the user's surviving branches.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const esbuild = require('esbuild');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-condense-'));
const outfile = path.join(temp, 'condense.js');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'diagrams', 'lib', 'diagrams', 'condense.ts')],
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'error',
});
const { inspectFlowCondenseSelection, replaceFlowSelection } = require(outfile);
const layoutFile = path.join(temp, 'layout.js');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'diagrams', 'lib', 'diagrams', 'layout.ts')],
  outfile: layoutFile, bundle: true, format: 'cjs', platform: 'node', logLevel: 'error',
});
const { layoutDiagram } = require(layoutFile);
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const node = (id, x, y, extra = {}) => ({ id, label: id, position: { x, y }, ...extra });
const edge = (from, to, extra = {}) => ({ from, to, fromSide: 'right', toSide: 'left', ...extra });
const flow = (nodes, edges, extra = {}) => ({ kind: 'flow', direction: 'right', nodes, edges, ...extra });
const summary = [{ label: 'Customer identity' }, { label: 'Plans and membership', detail: 'A plan belongs to the identified customer.' }];

function assertClear(spec) {
  const boxes = layoutDiagram(spec).nodes;
  for (let a = 0; a < boxes.length; a += 1) {
    for (let b = a + 1; b < boxes.length; b += 1) {
      const one = boxes[a];
      const two = boxes[b];
      const overlap = one.position.x < two.position.x + two.width && two.position.x < one.position.x + one.width &&
        one.position.y < two.position.y + two.height && two.position.y < one.position.y + one.height;
      assert.equal(overlap, false, `${one.id} overlaps ${two.id}`);
    }
  }
}

test('condensing a deep branch connects its parent to summaries and retains external continuations', () => {
  const incoming = edge('entity', 'question', { label: 'explains', dashed: true, collapsed: true });
  const outgoing = edge('clarification', 'continuation', { label: 'next', dashed: true, fromSide: 'bottom', toSide: 'top', collapsed: true });
  const unrelated = node('note', 1400, 900, { shape: 'note', bold: true });
  const spec = flow([
    node('entity', 0, 300), node('question', 280, 300), node('answer', 560, 300), node('clarification', 840, 300),
    node('continuation', 1120, 300), node('leaf', 1400, 300), unrelated,
  ], [incoming, edge('question', 'answer'), edge('answer', 'clarification'), outgoing, edge('continuation', 'leaf')], { title: 'Account concepts', summary: 'Working definitions' });
  const before = JSON.stringify(spec);
  const result = replaceFlowSelection(spec, ['answer', 'question', 'clarification'], summary);
  assert.equal(JSON.stringify(spec), before, 'replacement does not mutate the source undo snapshot');
  assert.equal(result.spec.title, spec.title);
  assert.equal(result.spec.summary, spec.summary);
  assert.deepEqual(result.spec.nodes.filter(n => !result.addedIds.includes(n.id)).map(n => n.id), ['entity', 'continuation', 'leaf', 'note']);
  assert.deepEqual(result.spec.nodes.find(n => n.id === 'note'), unrelated);
  for (const id of result.addedIds) {
    assert.deepEqual(result.spec.edges.find(e => e.from === 'entity' && e.to === id), { ...incoming, to: id });
    const added = result.spec.nodes.find(n => n.id === id);
    assert.equal(added.ai, true);
    assert.equal(added.shape, 'rounded');
  }
  assert.deepEqual(result.spec.edges.find(e => e.to === 'continuation'), { ...outgoing, from: result.addedIds.at(-1) });
  assert.deepEqual(result.spec.edges.find(e => e.from === 'continuation'), edge('continuation', 'leaf'));
  assert.ok(!result.spec.edges.some(e => ['question', 'answer', 'clarification'].includes(e.from) || ['question', 'answer', 'clarification'].includes(e.to)));
  assertClear(result.spec);
});

test('every boundary parent remains connected and identical duplicate reconnections are coalesced', () => {
  const spec = flow([
    node('parent', 0, 200), node('other-parent', 0, 600), node('a', 280, 200), node('b', 560, 200), node('c', 840, 200),
  ], [edge('parent', 'a'), edge('parent', 'b'), edge('other-parent', 'b', { label: 'also' }), edge('a', 'b'), edge('b', 'c')]);
  const { spec: next, addedIds } = replaceFlowSelection(spec, ['a', 'b', 'c'], summary);
  for (const parent of ['parent', 'other-parent']) {
    for (const id of addedIds) assert.equal(next.edges.filter(e => e.from === parent && e.to === id).length, 1);
  }
  assert.ok(next.edges.filter(e => e.from === 'other-parent').every(e => e.label === 'also'));
  assertClear(next);
});

test('a full-tree selection keeps its root location without retaining deleted ids', () => {
  const spec = flow([node('root', 90, 240), node('child', 370, 240), node('leaf', 650, 240)], [edge('root', 'child'), edge('child', 'leaf')]);
  const result = replaceFlowSelection(spec, ['leaf', 'root', 'child'], [{ label: 'root' }, { label: 'child' }]);
  assert.deepEqual(result.addedIds, ['root-2', 'child-2']);
  assert.equal(result.spec.nodes.length, 2);
  assert.equal(result.spec.edges.length, 0);
  assert.deepEqual(result.spec.nodes[0].position, spec.nodes[0].position);
  assertClear(result.spec);
});

test('graph order follows arrows regardless of selection and storage order, including branches and loops', () => {
  const spec = flow([node('tail', 840, 200), node('b', 560, 200), node('a', 280, 200), node('root', 0, 200)], [edge('root', 'a'), edge('a', 'b'), edge('b', 'tail')]);
  const inspected = inspectFlowCondenseSelection(spec, ['b', 'tail', 'a']);
  assert.deepEqual(inspected.nodes.map(n => n.id), ['a', 'b', 'tail']);
  assert.equal(inspected.anchor.id, 'a');
  const cyclic = flow([node('a', 0, 0), node('b', 280, 0), node('c', 560, 0)], [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]);
  assert.equal(inspectFlowCondenseSelection(cyclic, ['c', 'a', 'b']).nodes.length, 3);
  assert.equal(replaceFlowSelection(cyclic, ['a', 'b', 'c'], summary).spec.nodes.length, 2);
});

test('separate parent branches, missing boxes, images and blank selections cannot be condensed', () => {
  const spec = flow([node('parent', 0, 0), node('other-parent', 0, 150), node('a', 280, 0), node('b', 280, 150), node('picture', 560, 0, { shape: 'image', src: 'https://example.com/image.png' }), node('blank', 560, 150, { shape: 'note', label: '' })], [edge('parent', 'a'), edge('other-parent', 'b'), edge('a', 'picture'), edge('b', 'blank')]);
  assert.throws(() => inspectFlowCondenseSelection(spec, ['a']), /at least two/);
  assert.throws(() => inspectFlowCondenseSelection(spec, ['a', 'b']), /connected nodes or branches with the same parent/);
  assert.throws(() => inspectFlowCondenseSelection(spec, ['a', 'missing']), /no longer/);
  assert.throws(() => inspectFlowCondenseSelection(spec, ['a', 'picture']), /images/);
  assert.throws(() => inspectFlowCondenseSelection(spec, ['b', 'blank']), /needs text/);
});

test('sibling discussion branches under a shared parent condense and can be condensed again', () => {
  const spec = flow([
    node('parent', 0, 250), node('b', 280, 350), node('b-child', 560, 350),
    node('a', 280, 150), node('a-child', 560, 150),
  ], [edge('parent', 'a'), edge('parent', 'b'), edge('a', 'a-child'), edge('b', 'b-child')]);
  const selection = inspectFlowCondenseSelection(spec, ['a-child', 'b', 'a', 'b-child']);
  assert.equal(selection.anchor.id, 'a', 'the first incoming arrow supplies the replacement anchor');
  assert.deepEqual(selection.nodes.map(n => n.id), ['b', 'b-child', 'a', 'a-child']);
  const first = replaceFlowSelection(spec, selection.nodes.map(n => n.id), summary);
  assert.equal(first.spec.edges.length, 2, 'the parent has one arrow into each summary');
  assert.equal(inspectFlowCondenseSelection(first.spec, first.addedIds).nodes.length, 2);
  const second = replaceFlowSelection(first.spec, first.addedIds, [{ label: 'Customer concepts' }]);
  assert.equal(second.spec.nodes.length, 2);
  assert.deepEqual(second.spec.edges.map(e => [e.from, e.to]), [['parent', second.addedIds[0]]]);
  assertClear(second.spec);
});

test('fingerprints ignore dragging and selection order but track content, styling, parent context and boundary edges', () => {
  const spec = flow([node('parent', 0, 0), node('a', 280, 0), node('b', 560, 0), node('unrelated', 0, 900)], [edge('parent', 'a'), edge('a', 'b')]);
  const fingerprint = s => inspectFlowCondenseSelection(s, ['a', 'b']).fingerprint;
  const initial = fingerprint(spec);
  assert.equal(initial, inspectFlowCondenseSelection(spec, ['b', 'a']).fingerprint);
  assert.equal(initial, fingerprint({ ...spec, nodes: spec.nodes.map(n => ({ ...n, position: { x: n.position.x + 100, y: n.position.y - 75 } })) }));
  for (const change of [{ label: 'Edited text' }, { detail: 'Added explanation' }, { bold: true }, { detached: true }]) {
    assert.notEqual(initial, fingerprint({ ...spec, nodes: spec.nodes.map(n => n.id === 'a' ? { ...n, ...change } : n) }));
  }
  assert.notEqual(initial, fingerprint({ ...spec, nodes: spec.nodes.map(n => n.id === 'parent' ? { ...n, label: 'Changed parent' } : n) }));
  assert.notEqual(initial, fingerprint({ ...spec, edges: spec.edges.map((e, i) => i === 0 ? { ...e, dashed: true } : e) }));
  assert.equal(initial, fingerprint({ ...spec, nodes: spec.nodes.map(n => n.id === 'unrelated' ? { ...n, label: 'Unrelated change' } : n) }));
});

test('summary ids avoid deleted, existing and case-insensitive collisions', () => {
  const spec = flow([node('root', 0, 200), node('concept', 280, 200), node('answer', 560, 200), node('detail', 840, 200), node('clarification', 1120, 200), node('CONCEPT-2', 0, 900)], [edge('root', 'concept'), edge('concept', 'answer'), edge('answer', 'detail'), edge('detail', 'clarification')]);
  const result = replaceFlowSelection(spec, ['concept', 'answer', 'detail', 'clarification'], [{ label: 'Concept' }, { label: 'Concept' }, { label: 'Answer' }]);
  assert.deepEqual(result.addedIds, ['concept-3', 'concept-4', 'answer-2']);
  assert.equal(new Set(result.spec.nodes.map(n => n.id.toLowerCase())).size, result.spec.nodes.length);
});

test('editor-only reserved ids avoid exact and case-insensitive summary collisions', () => {
  const spec = flow([node('a', 0, 200), node('b', 280, 200), node('c', 560, 200)], [edge('a', 'b'), edge('b', 'c')]);
  const result = replaceFlowSelection(spec, ['a', 'b', 'c'], [{ label: 'Node' }, { label: 'Note' }], new Set(['node', 'NODE-2', 'NOTE']));
  assert.deepEqual(result.addedIds, ['node-3', 'note-2']);
  assert.equal(result.spec.nodes.length, 2, 'reservation prevents reuse without adding editor-only boxes to the spec');
});

test('a growing condensed branch has room around neighbouring trees and retained siblings', () => {
  const spec = flow([
    node('root', 0, 300), node('a', 280, 300), node('b', 560, 300), node('c', 840, 300), node('d', 1120, 300), node('e', 1400, 300),
    node('above', 280, 80), node('above-child', 560, 80), node('below', 280, 520), node('below-child', 560, 520),
  ], [edge('root', 'a'), edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('d', 'e'), edge('above', 'above-child'), edge('below', 'below-child')]);
  const result = replaceFlowSelection(spec, ['a', 'b', 'c', 'd', 'e'], Array.from({ length: 4 }, (_, i) => ({ label: `Important concept ${i + 1}`, detail: 'A longer explanation that takes several lines while remaining a readable summary.' })));
  assertClear(result.spec);
  assert.deepEqual(result.spec.nodes.find(n => n.id === 'root').position, spec.nodes[0].position);
  for (const id of ['above', 'above-child', 'below', 'below-child']) assert.ok(result.spec.nodes.some(n => n.id === id));
});

test('owned outgoing branches move beside the last summary while shared continuations keep their place', () => {
  const spec = flow([
    node('parent', 0, 300), node('a', 280, 300), node('b', 560, 300), node('c', 840, 300),
    node('owned', 1400, 300), node('owned-leaf', 1680, 300),
    node('other-parent', 1120, 650), node('shared', 1400, 650), node('far', 2200, 900),
  ], [edge('parent', 'a'), edge('a', 'b'), edge('b', 'c'), edge('c', 'owned'), edge('owned', 'owned-leaf'), edge('c', 'shared'), edge('other-parent', 'shared')]);
  const { spec: next, addedIds } = replaceFlowSelection(spec, ['a', 'b', 'c'], summary);
  const at = new Map(next.nodes.map(n => [n.id, n.position]));
  const last = at.get(addedIds.at(-1));
  assert.equal(at.get('owned').x, last.x + 280);
  assert.equal(at.get('owned-leaf').x - at.get('owned').x, 280, 'the continuation subtree retains its relative columns');
  assert.equal(at.get('owned-leaf').y, at.get('owned').y, 'the child stays level with its parent');
  for (const id of ['shared', 'other-parent', 'far']) assert.deepEqual(at.get(id), spec.nodes.find(n => n.id === id).position);
  assertClear(next);
});

test('vertical and hand-drawn side connections retain metadata and avoid occupied replacement positions', () => {
  const incoming = { from: 'parent', to: 'a', fromSide: 'bottom', toSide: 'top', label: 'details', dashed: true };
  const outgoing = { from: 'c', to: 'child', fromSide: 'left', toSide: 'right', label: 'continues' };
  const spec = flow([node('parent', 0, 0), node('a', 0, 200), node('b', 0, 400), node('c', 0, 500), node('child', 0, 700), node('occupied', 280, 200)], [incoming, { from: 'a', to: 'b' }, { from: 'b', to: 'c' }, outgoing], { direction: 'down' });
  const result = replaceFlowSelection(spec, ['a', 'b', 'c'], summary);
  for (const id of result.addedIds) assert.deepEqual(result.spec.edges.find(e => e.from === 'parent' && e.to === id), { ...incoming, to: id });
  assert.deepEqual(result.spec.edges.find(e => e.to === 'child'), { ...outgoing, from: result.addedIds.at(-1) });
  assert.deepEqual(result.spec.nodes.find(n => n.id === 'occupied'), spec.nodes.at(-1));
  assertClear(result.spec);
});

test('unrelated authored nodes keep their canvas positions when selected boxes disappear', () => {
  const spec = flow([
    { id: 'root', label: 'Root' }, { id: 'a', label: 'First question' },
    { id: 'b', label: 'Answer' }, { id: 'unrelated', label: 'Unrelated root' },
    { id: 'unrelated-child', label: 'Unrelated child' },
  ], [edge('root', 'a'), edge('a', 'b'), edge('unrelated', 'unrelated-child')]);
  const before = new Map(layoutDiagram(spec).nodes.map(n => [n.id, n.position]));
  const { spec: next } = replaceFlowSelection(spec, ['a', 'b'], [{ label: 'One concept' }]);
  const after = new Map(layoutDiagram(next).nodes.map(n => [n.id, n.position]));
  for (const id of ['unrelated', 'unrelated-child']) assert.deepEqual(after.get(id), before.get(id));
  assertClear(next);
});

test('a taller replacement root keeps its anchor and makes room for surviving boxes', () => {
  const spec = flow([
    node('root', 0, 0), node('a', 280, 0), node('unrelated', 0, 100),
  ], [edge('root', 'a')]);
  const { spec: next, addedIds } = replaceFlowSelection(spec, ['root', 'a'], [{
    label: 'The concept and its qualifications',
    detail: 'The identified customer can hold several plans. Plans do not establish a new identity. Recurring membership accounts and prepaid balances describe separate payment arrangements.',
  }]);
  assert.deepEqual(next.nodes.find(n => n.id === addedIds[0]).position, { x: 0, y: 0 });
  assert.ok(next.nodes.some(n => n.id === 'unrelated'));
  assertClear(next);
});

test('invalid summaries fail before replacing any selected content', () => {
  const spec = flow([node('a', 0, 0), node('b', 280, 0)], [edge('a', 'b')]);
  const before = JSON.stringify(spec);
  assert.throws(() => replaceFlowSelection(spec, ['a', 'b'], []), /no summary nodes/);
  assert.throws(() => replaceFlowSelection(spec, ['a', 'b'], [{ label: '   ' }]), /empty or overly long/);
  assert.throws(() => replaceFlowSelection(spec, ['a', 'b'], [{ label: 'x'.repeat(201) }]), /overly long/);
  assert.throws(() => replaceFlowSelection(spec, ['a', 'b'], summary), /fewer than the selection/);
  const large = flow(Array.from({ length: 8 }, (_, i) => node(`n${i}`, 280 * i, 0)), Array.from({ length: 7 }, (_, i) => edge(`n${i}`, `n${i + 1}`)));
  assert.throws(() => replaceFlowSelection(large, large.nodes.map(n => n.id), Array.from({ length: 7 }, (_, i) => ({ label: `Concept ${i}` }))), /one to six/);
  assert.equal(JSON.stringify(spec), before);
});
