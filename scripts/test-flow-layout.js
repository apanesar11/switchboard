'use strict';

// npm run test:diagrams — how the Diagrams editor lays out a branch Tab builds
// (src/diagrams/lib/diagrams/flow-editor.ts): Tab, ✦ Answer's several boxes at once,
// and a delete, all to the one tidy shape, with whatever is in the way moved aside.
// The module is TypeScript with no dependencies, so it is bundled here with esbuild
// (already a dev dependency, for build-diagrams.js) and required as plain CommonJS.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const esbuild = require('esbuild');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-flow-layout-'));
const outfile = path.join(temp, 'flow-editor.js');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'diagrams', 'lib', 'diagrams', 'flow-editor.ts')],
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'error',
});
const {
  placeTabChild,
  placeTabChildren,
  tidyAfterDelete,
  tidyAfterMove,
  tidyFlowTree,
  flowBranches,
  flowSpecFromCanvas,
  foldFlow,
  flowNodeFoldEdges,
  flowNodeFoldGroups,
  toggleFlowNodeFold,
  carryFoldedPositions,
  FLOW_TAB_GAP_X,
  FLOW_TAB_GAP_Y,
  FLOW_ROOM_GAP,
} = require(outfile);

// Switchboard: ✦ Answer's question path, to check what it walks past.
const aiFile = path.join(temp, 'ai.js');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'diagrams', 'lib', 'diagrams', 'ai.ts')],
  outfile: aiFile, bundle: true, format: 'cjs', platform: 'node', logLevel: 'error',
});
const { flowQuestionPath } = require(aiFile);

after(() => fs.rmSync(temp, { recursive: true, force: true }));

const W = 200;
const H = 52;
const box = (id, x, y, height = H) => ({ id, x, y, width: W, height });
const tab = (source, target) => ({ source, target, sourceHandle: 'right', targetHandle: 'left' });
const centre = b => b.y + b.height / 2;

/** The canvas after a Tab-shaped change: every box where it ends up. */
function apply(boxes, moved, added = []) {
  const at = new Map(boxes.map(b => [b.id, { ...b }]));
  for (const [id, to] of moved) Object.assign(at.get(id), to);
  for (const b of added) at.set(b.id, b);
  return at;
}

/** Adds `count` boxes off `parentId` one Tab at a time, as the editor does. */
function tabTimes(boxes, edges, parentId, ids) {
  let canvas = boxes.map(b => ({ ...b }));
  const wired = [...edges];
  for (const id of ids) {
    const { position, moved } = placeTabChild(canvas, wired, parentId, { id, width: W, height: H });
    canvas = [...apply(canvas, moved).values(), { id, ...position, width: W, height: H }];
    wired.push(tab(parentId, id));
  }
  return { boxes: canvas, edges: wired };
}

function overlapping(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test('the first Tab lands level with its parent, FLOW_TAB_GAP_X to its right', () => {
  const { position, moved } = placeTabChild([box('q', 0, 100)], [], 'q', { id: 'a', width: W, height: H });
  assert.deepEqual(position, { x: W + FLOW_TAB_GAP_X, y: 100 });
  assert.equal(moved.size, 0);
});

test('more Tabs stack FLOW_TAB_GAP_Y apart, centred on the parent', () => {
  const { boxes } = tabTimes([box('q', 0, 400)], [], 'q', ['a', 'b', 'c']);
  const at = new Map(boxes.map(b => [b.id, b]));
  assert.equal(at.get('b').y - (at.get('a').y + H), FLOW_TAB_GAP_Y);
  assert.equal(at.get('c').y - (at.get('b').y + H), FLOW_TAB_GAP_Y);
  assert.equal((centre(at.get('a')) + centre(at.get('c'))) / 2, centre(at.get('q')));
  assert.equal(at.get('q').y, 400, 'the top of the tree stays put');
});

test('an answer in parts lands exactly where a Tab for each would put it', () => {
  const start = [box('root', 0, 300), box('q', W + FLOW_TAB_GAP_X, 300)];
  const edges = [tab('root', 'q')];
  const byTab = tabTimes(start, edges, 'q', ['a', 'b', 'c']);
  const { positions, moved } = placeTabChildren(start, edges, 'q', ['a', 'b', 'c'].map(id => ({ id, width: W, height: H })));
  const at = apply(start, moved, [...positions].map(([id, p]) => ({ id, ...p, width: W, height: H })));
  for (const b of byTab.boxes) assert.deepEqual({ x: at.get(b.id).x, y: at.get(b.id).y }, { x: b.x, y: b.y }, b.id);
});

test('a tree that grows into another one moves that one out of its way, whole, rather than giving up', () => {
  // Another tree sits just above where this one's answers will grow to.
  const column = n => n * (W + FLOW_TAB_GAP_X);
  const other = [box('o-root', 0, 0), box('o-q', column(1), 0), box('o-kid', column(2), 0)];
  const mine = [box('root', 0, 200), box('q', column(1), 200)];
  const edges = [tab('o-root', 'o-q'), tab('o-q', 'o-kid'), tab('root', 'q')];
  const kids = ['a', 'b', 'c', 'd'].map(id => ({ id, width: W, height: 90 }));
  const { positions, moved } = placeTabChildren([...other, ...mine], edges, 'q', kids);
  const at = apply([...other, ...mine], moved, kids.map(k => ({ ...k, ...positions.get(k.id) })));

  // The answers are centred on their question, which is still level with the root.
  const first = at.get('a');
  const last = at.get('d');
  assert.equal((centre(first) + centre(last)) / 2, centre(at.get('q')));
  assert.equal(at.get('root').y, 200);
  // The other tree moved up as one piece.
  const shift = at.get('o-root').y - 0;
  assert.ok(shift < 0, 'the other tree moved up');
  for (const id of ['o-q', 'o-kid']) assert.equal(at.get(id).y, shift, `${id} moved with it`);
  assert.equal(at.get('a').y - (at.get('o-kid').y + H), FLOW_ROOM_GAP, 'FLOW_ROOM_GAP clear in the column they share');
  const all = [...at.values()];
  for (const a of all) for (const b of all) if (a !== b) assert.ok(!overlapping(a, b), `${a.id} on ${b.id}`);
});

test('a tree between two others pushes the one above up and the one below down', () => {
  const above = box('above', W + FLOW_TAB_GAP_X, 0);
  const below = box('below', W + FLOW_TAB_GAP_X, 260);
  const mine = [box('root', 0, 130), box('q', W + FLOW_TAB_GAP_X, 130)];
  const edges = [tab('root', 'q')];
  const kids = ['a', 'b', 'c'].map(id => ({ id, width: W, height: H }));
  // q's children go in the next column; give the column neighbours there too.
  const aboveKid = box('above-kid', 2 * (W + FLOW_TAB_GAP_X), 0);
  const belowKid = box('below-kid', 2 * (W + FLOW_TAB_GAP_X), 260);
  const start = [above, below, aboveKid, belowKid, ...mine];
  const wired = [...edges, tab('above', 'above-kid'), tab('below', 'below-kid')];
  const { positions, moved } = placeTabChildren(start, wired, 'q', kids);
  const at = apply(start, moved, kids.map(k => ({ ...k, ...positions.get(k.id) })));
  assert.ok(at.get('above-kid').y < 0, 'the one above went up');
  assert.ok(at.get('below-kid').y > 260, 'the one below went down');
  assert.equal(at.get('root').y, 130);
  const all = [...at.values()];
  for (const a of all) for (const b of all) if (a !== b) assert.ok(!overlapping(a, b), `${a.id} on ${b.id}`);
});

test('boxes someone left overlapping by hand are not pushed apart by an unrelated Tab', () => {
  const note = box('note', 0, 20);
  const start = [box('q', 0, 0), note];
  const { moved } = placeTabChild(start, [], 'q', { id: 'a', width: W, height: H });
  assert.equal(moved.size, 0);
});

test('deleting the last of five closes up the four left around their parent', () => {
  const { boxes, edges } = tabTimes([box('q', 0, 600)], [], 'q', ['a', 'b', 'c', 'd', 'e']);
  const moved = tidyAfterDelete(boxes, edges, new Set(['e']));
  const at = apply(boxes.filter(b => b.id !== 'e'), moved);
  assert.ok(moved.size > 0, 'the four moved');
  assert.equal((centre(at.get('a')) + centre(at.get('d'))) / 2, centre(at.get('q')));
  for (const [x, y] of [['a', 'b'], ['b', 'c'], ['c', 'd']]) {
    assert.equal(at.get(y).y - (at.get(x).y + H), FLOW_TAB_GAP_Y);
  }
  // And it is the same shape four Tabs would have made.
  const fresh = tabTimes([box('q', 0, 600)], [], 'q', ['a', 'b', 'c', 'd']);
  for (const b of fresh.boxes) assert.equal(at.get(b.id).y, b.y, b.id);
});

test('deleting a branch tidies the tree from the nearest box that stays', () => {
  const start = tabTimes([box('root', 0, 600)], [], 'root', ['p', 's']);
  const deeper = tabTimes(start.boxes, start.edges, 'p', ['p1', 'p2', 'p3']);
  const moved = tidyAfterDelete(deeper.boxes, deeper.edges, new Set(['p', 'p1', 'p2', 'p3']));
  const at = apply(deeper.boxes.filter(b => !b.id.startsWith('p')), moved);
  assert.equal(centre(at.get('s')), centre(at.get('root')), 'the one child left is level with the root');
});

test('deleting the top of a tree, or a box in no tree, moves nothing', () => {
  const { boxes, edges } = tabTimes([box('q', 0, 0)], [], 'q', ['a', 'b']);
  assert.equal(tidyAfterDelete(boxes, edges, new Set(['q'])).size, 0);
  const loose = [...boxes, box('loose', 900, 900)];
  assert.equal(tidyAfterDelete(loose, edges, new Set(['loose'])).size, 0);
});

// ── folding a branch away behind its arrow ──

const arrow = (source, target, collapsed) => ({ source, target, collapsed });
const sorted = set => [...set].sort();

test('a collapsed arrow hides what it points at and everything beyond it', () => {
  const ids = ['root', 'a', 'b', 'a1', 'a2', 'a1x'];
  const edges = [arrow('root', 'a', true), arrow('root', 'b'), arrow('a', 'a1'), arrow('a', 'a2'), arrow('a1', 'a1x')];
  const { hidden, folded } = foldFlow(ids, edges);
  assert.deepEqual(sorted(hidden), ['a', 'a1', 'a1x', 'a2']);
  assert.deepEqual(sorted(folded.get(0)), ['a', 'a1', 'a1x', 'a2']);
  assert.equal(foldFlow(ids, edges.map(e => ({ ...e, collapsed: false }))).hidden.size, 0);
});

test('a box something still showing points at stays; one only collapsed arrows reach goes', () => {
  const ids = ['root', 'a', 'b', 'm'];
  const one = foldFlow(ids, [arrow('root', 'a'), arrow('root', 'b'), arrow('a', 'm', true), arrow('b', 'm')]);
  assert.equal(one.hidden.size, 0, 'b still points at m');
  const both = foldFlow(ids, [arrow('root', 'a'), arrow('root', 'b'), arrow('a', 'm', true), arrow('b', 'm', true)]);
  assert.deepEqual(sorted(both.hidden), ['m']);
});

test('an arrow looping back from the branch never folds away what leads to it', () => {
  // p → s → x → y, and y back to p: folding s → x hides x and y, never p or s.
  const { hidden } = foldFlow(['p', 's', 'x', 'y'], [arrow('p', 's'), arrow('s', 'x', true), arrow('x', 'y'), arrow('y', 'p')]);
  assert.deepEqual(sorted(hidden), ['x', 'y']);
});

test('folds nest: unfolding the outer one leaves the inner one folded', () => {
  const ids = ['r', 'a', 'b', 'c'];
  const edges = [arrow('r', 'a', true), arrow('a', 'b', true), arrow('b', 'c')];
  assert.deepEqual(sorted(foldFlow(ids, edges).hidden), ['a', 'b', 'c']);
  edges[0].collapsed = false;
  assert.deepEqual(sorted(foldFlow(ids, edges).hidden), ['b', 'c']);
});

test('one node click folds all ten direct children and the next reopens them', () => {
  const children = Array.from({ length: 10 }, (_, index) => `child-${index}`);
  const ids = ['root', ...children, 'grandchild', 'elsewhere'];
  const edges = [
    ...children.map(child => arrow('root', child)),
    arrow('child-0', 'grandchild'),
    arrow('elsewhere', 'elsewhere'),
  ];
  const closed = toggleFlowNodeFold(ids, edges, 'root');
  assert.equal(closed.changed, true);
  assert.equal(closed.collapsed, true);
  assert.deepEqual(closed.edgeIndexes, Array.from({ length: 10 }, (_, index) => index));
  assert.deepEqual(sorted(closed.newlyHidden), [...children, 'grandchild'].sort());
  assert.deepEqual(sorted(closed.hiddenAfter), [...children, 'grandchild'].sort());
  assert.equal(closed.edges.slice(0, 10).every(edge => edge.collapsed), true);
  assert.equal(closed.edges[10], edges[10], 'nested fold state is untouched');
  assert.equal(closed.edges[11], edges[11], 'unrelated arrows are untouched');
  assert.equal(edges[0].collapsed, undefined, 'the previous snapshot is not mutated');

  const opened = toggleFlowNodeFold(ids, closed.edges, 'root');
  assert.equal(opened.collapsed, false);
  assert.deepEqual(sorted(opened.newlyShown), [...children, 'grandchild'].sort());
  assert.equal(opened.hiddenAfter.size, 0);
  assert.equal(opened.edges.slice(0, 10).every(edge => edge.collapsed === undefined), true);
});

test('a partially folded older node closes all open siblings before it reopens them', () => {
  const ids = ['root', 'a', 'b', 'c', 'leaf'];
  const edges = [
    arrow('root', 'a', true),
    arrow('root', 'b'),
    arrow('root', 'c', true),
    arrow('b', 'leaf', true),
  ];
  assert.deepEqual(flowNodeFoldEdges(ids, edges, 'root'), [0, 1, 2]);
  const closed = toggleFlowNodeFold(ids, edges, 'root');
  assert.equal(closed.collapsed, true);
  assert.deepEqual(sorted(closed.hiddenBefore), ['a', 'c', 'leaf']);
  assert.deepEqual(sorted(closed.newlyHidden), ['b']);
  assert.equal(closed.edges[3].collapsed, true, 'a nested fold is preserved');

  const opened = toggleFlowNodeFold(ids, closed.edges, 'root');
  assert.equal(opened.collapsed, false);
  assert.deepEqual(sorted(opened.newlyShown), ['a', 'b', 'c']);
  assert.deepEqual(sorted(opened.hiddenAfter), ['leaf'], 'the nested fold stays closed');
});

test('a shared target stays visible through another parent when one node folds', () => {
  const ids = ['root', 'left', 'right', 'shared', 'left-only'];
  const edges = [
    arrow('root', 'left'), arrow('root', 'right'),
    arrow('left', 'shared'), arrow('left', 'left-only'),
    arrow('right', 'shared'),
  ];
  const left = toggleFlowNodeFold(ids, edges, 'left');
  assert.deepEqual(left.edgeIndexes, [2, 3]);
  assert.deepEqual(sorted(left.newlyHidden), ['left-only']);
  assert.equal(left.hiddenAfter.has('shared'), false);
  const right = toggleFlowNodeFold(ids, left.edges, 'right');
  assert.deepEqual(sorted(right.newlyHidden), ['shared']);
  assert.deepEqual(sorted(right.hiddenAfter), ['left-only', 'shared']);
});

test('expanding a partial fold reveals its hidden branches without closing open siblings', () => {
  const ids = ['root', 'a', 'b', 'leaf'];
  const edges = [arrow('root', 'a', true), arrow('root', 'b'), arrow('a', 'leaf', true)];
  const opened = toggleFlowNodeFold(ids, edges, 'root', { expand: true });
  assert.equal(opened.collapsed, false);
  assert.deepEqual(sorted(opened.newlyShown), ['a']);
  assert.deepEqual(sorted(opened.hiddenAfter), ['leaf']);
  assert.equal(opened.edges[0].collapsed, undefined);
  assert.equal(opened.edges[1].collapsed, undefined, 'the open sibling stays open');
  assert.equal(opened.edges[2].collapsed, true, 'the nested fold stays closed');
  assert.equal(edges[0].collapsed, true, 'the saved input is not mutated');
});

test('new node folds leave cycle-closing arrows open; old collapsed ones can reopen', () => {
  const ids = ['root', 'child', 'leaf'];
  const edges = [arrow('root', 'child'), arrow('child', 'leaf'), arrow('child', 'root')];
  assert.deepEqual([...flowNodeFoldGroups(ids, edges)], [['root', [0]], ['child', [1]]]);
  assert.deepEqual(flowNodeFoldEdges(ids, edges, 'child'), [1]);
  const closed = toggleFlowNodeFold(ids, edges, 'child');
  assert.deepEqual(sorted(closed.newlyHidden), ['leaf']);
  assert.equal(closed.edges[2].collapsed, undefined, 'the return arrow stays visible');

  const legacy = [edges[0], edges[1], { ...edges[2], collapsed: true }];
  assert.deepEqual(flowNodeFoldEdges(ids, legacy, 'child'), [1, 2]);
  const closedLegacy = toggleFlowNodeFold(ids, legacy, 'child');
  assert.equal(closedLegacy.edges[2].collapsed, true, 'the first click finishes closing the group');
  const openedLegacy = toggleFlowNodeFold(ids, closedLegacy.edges, 'child');
  assert.equal(openedLegacy.edges[2].collapsed, undefined, 'the next click reopens the old back arrow');
  assert.equal(openedLegacy.hiddenAfter.size, 0);

  const collapsedBackOnly = [edges[0], { ...edges[2], collapsed: true }];
  assert.deepEqual([...flowNodeFoldGroups(ids, collapsedBackOnly)], [['root', [0]], ['child', [1]]]);
  assert.deepEqual(flowNodeFoldEdges(ids, collapsedBackOnly, 'child'), [1]);
  const reopenedBackOnly = toggleFlowNodeFold(ids, collapsedBackOnly, 'child');
  assert.equal(reopenedBackOnly.changed, true);
  assert.equal(reopenedBackOnly.collapsed, false);
  assert.equal(reopenedBackOnly.edges[1].collapsed, undefined);
  assert.equal(reopenedBackOnly.newlyShown.size, 0, 'reopening a legacy back arrow changes no box visibility');

  const openBackOnly = [edges[0], edges[2]];
  assert.deepEqual([...flowNodeFoldGroups(ids, openBackOnly)], [['root', [0]]],
    'a new fold affordance is absent when only an open loop arrow leaves the node');
  assert.equal(toggleFlowNodeFold(ids, openBackOnly, 'child').changed, false);

  const onlyBack = toggleFlowNodeFold(ids, [edges[0], edges[1], { ...edges[2], collapsed: true }], 'missing');
  assert.equal(onlyBack.changed, false, 'a node without outgoing arrows has no fold action');
});

test('folding a branch closes the tree up as if it had no children there; unfolding opens it again', () => {
  const start = tabTimes([box('q', 0, 600)], [], 'q', ['a', 'b', 'c']);
  const deeper = tabTimes(start.boxes, start.edges, 'b', ['b1', 'b2', 'b3']);
  // Fold q → b: lay out what is left showing.
  const hidden = new Set(['b', 'b1', 'b2', 'b3']);
  const showing = deeper.boxes.filter(x => !hidden.has(x.id));
  const showingEdges = deeper.edges.filter(e => !hidden.has(e.target));
  const moved = tidyFlowTree(showing, showingEdges, ['q']);
  const at = apply(showing, moved);
  assert.equal(at.get('c').y - (at.get('a').y + H), FLOW_TAB_GAP_Y, 'a and c close up');
  assert.equal((centre(at.get('a')) + centre(at.get('c'))) / 2, centre(at.get('q')));
  // Unfold: everything back, b's branch laid out again around b.
  const back = [...at.values(), ...deeper.boxes.filter(x => hidden.has(x.id))];
  const reopened = apply(back, tidyFlowTree(back, deeper.edges, ['q'], hidden));
  const fresh = tabTimes(tabTimes([box('q', 0, 600)], [], 'q', ['a', 'b', 'c']).boxes, start.edges, 'b', ['b1', 'b2', 'b3']);
  for (const b of fresh.boxes) assert.equal(reopened.get(b.id).y, b.y, b.id);
});

test('folding and unfolding a branch does not reposition a separately placed image', () => {
  const start = tabTimes([box('q', 0, 600)], [], 'q', ['a', 'b', 'c']);
  const b = start.boxes.find(item => item.id === 'b');
  // The image happens to sit beside the branch being folded. Its placement is
  // deliberate, even though the remaining boxes move into that space.
  const image = { id: 'image', x: b.x, y: b.y, width: 320, height: 100, shape: 'image' };
  const canvas = [...start.boxes, image];
  const showing = canvas.filter(item => item.id !== 'b');
  const showingEdges = start.edges.filter(edge => edge.target !== 'b');

  const folded = apply(showing, tidyFlowTree(showing, showingEdges, ['q'], [], { pinImages: true }));
  assert.equal(folded.get('image').y, image.y, 'collapse preserves the image position');
  assert.equal(folded.get('c').y - (folded.get('a').y + H), FLOW_TAB_GAP_Y);

  const restored = [...folded.values(), b];
  const unfolded = apply(restored, tidyFlowTree(restored, start.edges, ['q'], ['b'], { pinImages: true }));
  assert.equal(unfolded.get('image').y, image.y, 'expand preserves the image position');
});

test('a visible image with an incoming side arrow stays where it was placed during a fold', () => {
  const start = tabTimes([box('q', 0, 600)], [], 'q', ['a', 'b', 'c']);
  const image = { id: 'image', x: W + FLOW_TAB_GAP_X, y: 600, width: 320, height: 100, shape: 'image' };
  const sideArrow = { source: 'q', target: 'image', sourceHandle: 'bottom', targetHandle: 'top' };
  const showing = [...start.boxes.filter(item => item.id !== 'b'), image];
  const edges = [...start.edges.filter(edge => edge.target !== 'b'), sideArrow];

  const folded = apply(showing, tidyFlowTree(showing, edges, ['q'], [], { pinImages: true }));
  assert.deepEqual({ x: folded.get('image').x, y: folded.get('image').y },
    { x: image.x, y: image.y });
});

test('a loose box pushed by a fold does not land on a pinned image', () => {
  const image = { ...box('image', 280, 352), shape: 'image' };
  const boxes = [box('q', 0, 200), box('a', 280, 100), box('c', 280, 300), box('d', 280, 160), image];
  const moved = tidyFlowTree(boxes, [tab('q', 'a'), tab('q', 'c')], ['q'], [], { pinImages: true });
  const at = apply(boxes, moved);

  assert.equal(at.get('image').y, image.y, 'the image keeps its placed position');
  assert.notEqual(at.get('d').y, 160, 'the loose box moves out of the branch’s way');
  assert.ok(!overlapping(at.get('d'), at.get('image')),
    'the loose box does not get pushed onto the image');
});

test('a visible image in a Tab branch anchors the boxes hanging off it during a fold', () => {
  const siblings = tabTimes([box('q', 0, 600)], [], 'q', ['a', 'b', 'c']);
  const withImage = tabTimes(siblings.boxes, siblings.edges, 'a', ['image']);
  const expanded = tabTimes(withImage.boxes, withImage.edges, 'image', ['caption']);
  const before = expanded.boxes.map(item => item.id === 'image' ? { ...item, shape: 'image' } : item);
  const showing = before.filter(item => item.id !== 'b');
  const edges = expanded.edges.filter(edge => edge.target !== 'b');

  const folded = apply(showing, tidyFlowTree(showing, edges, ['q'], [], { pinImages: true }));
  assert.notEqual(folded.get('a').y, before.find(item => item.id === 'a').y,
    'visible siblings close around the folded branch');
  for (const id of ['image', 'caption']) {
    const original = before.find(item => item.id === id);
    assert.deepEqual({ x: folded.get(id).x, y: folded.get(id).y },
      { x: original.x, y: original.y }, `${id} stays anchored to the placed image`);
  }
});

test('adding a Tab child still carries an attached image with its parent', () => {
  const siblings = tabTimes([box('q', 0, 600)], [], 'q', ['a', 'c']);
  const withImage = tabTimes(siblings.boxes, siblings.edges, 'a', ['image']);
  const canvas = withImage.boxes.map(item => item.id === 'image' ? { ...item, shape: 'image' } : item);
  const { moved } = placeTabChild(canvas, withImage.edges, 'q', { id: 'b', width: W, height: H });

  assert.ok(moved.has('a'), 'new sibling re-centres its parent');
  assert.equal(moved.get('image').y - canvas.find(item => item.id === 'image').y,
    moved.get('a').y - canvas.find(item => item.id === 'a').y);
});

test('a previously folded image follows its parent when a different branch folds', () => {
  const siblings = tabTimes([box('q', 0, 600)], [], 'q', ['a', 'b', 'c']);
  const withImage = tabTimes(siblings.boxes, siblings.edges, 'a', ['image']);
  const before = withImage.boxes.map(item => ({
    id: item.id,
    position: { x: item.x, y: item.y },
    data: { shape: item.id === 'image' ? 'image' : 'box' },
  }));
  const edges = withImage.edges.map(edge => ({
    ...edge,
    collapsed: edge.target === 'image' || edge.target === 'b',
  }));
  const hidden = foldFlow(before.map(node => node.id), edges).hidden;
  assert.deepEqual(sorted(hidden), ['b', 'image']);

  const showing = withImage.boxes.filter(item => !hidden.has(item.id));
  const showingEdges = edges.filter(edge => !edge.collapsed && !hidden.has(edge.source));
  const moved = tidyFlowTree(showing, showingEdges, ['q'], [], { pinImages: true });
  const parentDelta = moved.get('a').y - before.find(node => node.id === 'a').position.y;
  assert.notEqual(parentDelta, 0, 'folding the sibling moves the image parent');
  const after = before.map(node => ({
    ...node,
    position: moved.get(node.id) ?? node.position,
  }));
  const carried = carryFoldedPositions(before, after, edges);
  const position = (nodes, id) => nodes.find(node => node.id === id).position;
  assert.equal(position(carried, 'image').y - position(before, 'image').y, parentDelta,
    'the hidden image keeps the same offset from a');
  assert.deepEqual(position(carried, 'b'), position(before, 'b'),
    'the separately folded branch does not move');
});

// ── dragging a box within its branch ──

/** `boxes` with `id` dragged to `to`: the canvas at the drop, and where it began. */
function drag(boxes, id, to) {
  const was = boxes.find(b => b.id === id);
  return {
    dropped: boxes.map(b => (b.id === id ? { ...b, ...to } : b)),
    from: new Map([[id, { x: was.x, y: was.y }]]),
  };
}

/** The ids hanging off `parent` in `at`, top to bottom. */
function order(at, ids) {
  return [...ids].sort((a, b) => at.get(a).y - at.get(b).y);
}

test('a box dropped between two of its siblings goes between them, and the branch closes up around it', () => {
  const { boxes, edges } = tabTimes([box('q', 0, 600)], [], 'q', ['a', 'b', 'c', 'd']);
  const at0 = new Map(boxes.map(b => [b.id, b]));
  // d, dragged up between a and b, a little off the column.
  const { dropped, from } = drag(boxes, 'd', { x: at0.get('d').x + 37, y: (at0.get('a').y + at0.get('b').y) / 2 + 10 });
  const at = apply(dropped, tidyAfterMove(dropped, edges, from));
  assert.deepEqual(order(at, ['a', 'b', 'c', 'd']), ['a', 'd', 'b', 'c']);
  for (const id of ['b', 'c', 'd']) assert.equal(at.get(id).x, at.get('a').x, `${id} in the column`);
  for (const [x, y] of [['a', 'd'], ['d', 'b'], ['b', 'c']]) {
    assert.equal(at.get(y).y - (at.get(x).y + H), FLOW_TAB_GAP_Y, `${x} to ${y}`);
  }
  assert.equal((centre(at.get('a')) + centre(at.get('c'))) / 2, centre(at.get('q')));
  assert.equal(at.get('q').y, 600, 'the box they hang off stays put');
});

test('a box dropped below the last goes last; one let go where it was goes back exactly', () => {
  const { boxes, edges } = tabTimes([box('q', 0, 600)], [], 'q', ['a', 'b', 'c']);
  const at0 = new Map(boxes.map(b => [b.id, b]));
  const below = drag(boxes, 'a', { x: at0.get('a').x, y: at0.get('c').y + 200 });
  const at = apply(below.dropped, tidyAfterMove(below.dropped, edges, below.from));
  assert.deepEqual(order(at, ['a', 'b', 'c']), ['b', 'c', 'a']);
  // Nudged a few pixels and dropped, still between the same two: back to where Tab had it.
  const nudge = drag(boxes, 'b', { x: at0.get('b').x - 12, y: at0.get('b').y + 9 });
  const back = apply(nudge.dropped, tidyAfterMove(nudge.dropped, edges, nudge.from));
  for (const b of boxes) assert.deepEqual({ x: back.get(b.id).x, y: back.get(b.id).y }, { x: b.x, y: b.y }, b.id);
});

test('a box dropped half over a sibling goes before or after it by their middles', () => {
  const { boxes, edges } = tabTimes([box('q', 0, 600)], [], 'q', ['a', 'b', 'c']);
  const at0 = new Map(boxes.map(b => [b.id, b]));
  // c's middle a little above b's: before b.
  const { dropped, from } = drag(boxes, 'c', { x: at0.get('c').x, y: at0.get('b').y - 5 });
  const at = apply(dropped, tidyAfterMove(dropped, edges, from));
  assert.deepEqual(order(at, ['a', 'b', 'c']), ['a', 'c', 'b']);
});

test('what hangs off a dragged box comes along, laid out around it again', () => {
  const start = tabTimes([box('q', 0, 600)], [], 'q', ['a', 'b']);
  const deeper = tabTimes(start.boxes, start.edges, 'a', ['a1', 'a2']);
  const at0 = new Map(deeper.boxes.map(b => [b.id, b]));
  // a, with its two, dragged below b and off to the right.
  const { dropped, from } = drag(deeper.boxes, 'a', { x: at0.get('a').x + 120, y: at0.get('b').y + 150 });
  const at = apply(dropped, tidyAfterMove(dropped, deeper.edges, from));
  assert.deepEqual(order(at, ['a', 'b']), ['b', 'a']);
  assert.equal(at.get('a').x, at.get('b').x, 'back in its column');
  for (const id of ['a1', 'a2']) assert.equal(at.get(id).x, at.get('a').x + W + FLOW_TAB_GAP_X, `${id} still a column right of a`);
  assert.equal((centre(at.get('a1')) + centre(at.get('a2'))) / 2, centre(at.get('a')), 'a1 and a2 centred on a');
  const all = [...at.values()];
  for (const x of all) for (const y of all) if (x !== y) assert.ok(!overlapping(x, y), `${x.id} on ${y.id}`);
});

test('a box dragged left of what it hangs off leaves the branch, which closes up behind it', () => {
  const { boxes, edges } = tabTimes([box('q', 0, 600)], [], 'q', ['a', 'b', 'c']);
  const { dropped, from } = drag(boxes, 'b', { x: -400, y: 100 });
  const at = apply(dropped, tidyAfterMove(dropped, edges, from));
  assert.deepEqual({ x: at.get('b').x, y: at.get('b').y }, { x: -400, y: 100 }, 'left where it was dropped');
  assert.equal(at.get('c').y - (at.get('a').y + H), FLOW_TAB_GAP_Y, 'a and c close up');
  assert.equal((centre(at.get('a')) + centre(at.get('c'))) / 2, centre(at.get('q')));
});

test('a box in no branch is left where it was dropped, and moves nothing', () => {
  const { boxes, edges } = tabTimes([box('q', 0, 600)], [], 'q', ['a', 'b']);
  const loose = [...boxes, box('loose', 900, 900)];
  const { dropped, from } = drag(loose, 'loose', { x: 280, y: 620 });
  assert.equal(tidyAfterMove(dropped, edges, from).size, 0);
});

// ── a box drags its branch along; a detached one moves on its own ──

test('a box carries everything that hangs off it, all the way down — a detached box carries nothing', () => {
  const start = tabTimes([box('root', 0, 600)], [], 'root', ['p', 's']);
  const deeper = tabTimes(start.boxes, start.edges, 'p', ['p1', 'p2']);
  assert.deepEqual(flowBranches(deeper.boxes, deeper.edges, ['root']).get('root').sort(), ['p', 'p1', 'p2', 's']);
  // Grabbing root and p together: p moves with root, not on its own account.
  const both = flowBranches(deeper.boxes, deeper.edges, ['root', 'p']);
  assert.deepEqual([...both.keys()], ['root']);
  assert.ok(!both.get('root').includes('p'));
  // p detached: root no longer carries p, nor what hung off it; p carries nothing.
  const cut = deeper.boxes.map(b => (b.id === 'p' ? { ...b, detached: true } : b));
  assert.deepEqual(flowBranches(cut, deeper.edges, ['root']).get('root'), ['s']);
  assert.equal(flowBranches(cut, deeper.edges, ['p']).size, 0);
});

test('a tree dragged whole by its top box lands as it was dropped', () => {
  const start = tabTimes([box('root', 0, 600)], [], 'root', ['a', 'b']);
  const deeper = tabTimes(start.boxes, start.edges, 'a', ['a1', 'a2']);
  // The editor moves the whole branch with root, step for step; the drop has all of them.
  const from = new Map(deeper.boxes.map(b => [b.id, { x: b.x, y: b.y }]));
  const dropped = deeper.boxes.map(b => ({ ...b, x: b.x + 140, y: b.y + 260 }));
  assert.equal(tidyAfterMove(dropped, deeper.edges, from).size, 0, 'nothing moves after the drop');
});

test('a detached box is left where it is dropped, and laying out its old branch leaves it alone', () => {
  const { boxes, edges } = tabTimes([box('q', 0, 600)], [], 'q', ['a', 'b', 'c']);
  const cut = boxes.map(b => (b.id === 'b' ? { ...b, detached: true } : b));
  const { dropped, from } = drag(cut, 'b', { x: 700, y: 100 });
  assert.equal(tidyAfterMove(dropped, edges, from).size, 0);
  // Tidying q's branch now lays out a and c around q, and leaves b where it was put.
  const at = apply(dropped, tidyFlowTree(dropped, edges, ['q']));
  assert.deepEqual({ x: at.get('b').x, y: at.get('b').y }, { x: 700, y: 100 });
  assert.equal((centre(at.get('a')) + centre(at.get('c'))) / 2, centre(at.get('q')));
});

test('a detached box is saved as one', () => {
  const node = (id, detached) => ({
    id, type: 'box', position: { x: 0, y: 0 },
    data: { label: id, shape: 'rounded', tone: 'default', dashed: false, textSize: 'md', align: 'center', bold: false, italic: false, detached },
  });
  const spec = flowSpecFromCanvas({}, [node('a', true), node('b', undefined)], []);
  assert.deepEqual(spec.nodes.map(n => n.detached), [true, undefined]);
});

// ── Switchboard: a pinned terminal stays where it was put ──

const terminalBox = (id, x, y) => ({ id, x, y, width: 560, height: 340, shape: 'terminal' });

test('a Tab that crowds a pinned terminal moves what is loose around it, never the terminal', () => {
  const { boxes, edges } = tabTimes([box('q', 0, 600)], [], 'q', ['a', 'b']);
  // Below the branch, in the column it grows down into, with a loose box between.
  const terminal = terminalBox('terminal-demo', W + FLOW_TAB_GAP_X, 760);
  const loose = box('loose', W + FLOW_TAB_GAP_X, 690);
  const canvas = [...boxes, loose, terminal];
  const { moved } = placeTabChild(canvas, edges, 'q', { id: 'c', width: W, height: H });
  assert.equal(moved.has('terminal-demo'), false, 'the terminal stays where it was put');
  // Without the pin, the same Tab pushes a box there out of the way.
  const unpinned = placeTabChild([...boxes, loose, { ...terminal, shape: 'note' }], edges, 'q', { id: 'c', width: W, height: H });
  assert.equal(unpinned.moved.has('terminal-demo'), true);
  const at = apply(canvas, moved);
  assert.ok(!overlapping(at.get('loose'), terminal), 'the loose box is not pushed onto the terminal');
});

test('Tab and an answer in parts never land on a pinned terminal: they go down past it', () => {
  // The terminal sits just right of the box asked from, where the branch would grow.
  const q = box('q', 0, 0);
  const terminal = terminalBox('terminal-demo', 260, -100);
  const one = placeTabChild([q, terminal], [], 'q', { id: 'c', width: W, height: H });
  assert.equal(one.moved.size, 0, 'neither the terminal nor the box asked from moves');
  assert.deepEqual(one.position, { x: W + FLOW_TAB_GAP_X, y: terminal.y + terminal.height + FLOW_TAB_GAP_Y });

  const kids = ['a', 'b', 'c'].map(id => ({ id, width: W, height: H }));
  const parts = placeTabChildren([q, terminal], [], 'q', kids);
  assert.equal(parts.moved.size, 0);
  const placed = kids.map(k => ({ ...k, ...parts.positions.get(k.id) }));
  for (const p of placed) assert.ok(!overlapping(p, terminal), `${p.id} is not under the terminal`);
  // Still one tidy column, in order, FLOW_TAB_GAP_Y apart.
  assert.equal(placed[0].y, terminal.y + terminal.height + FLOW_TAB_GAP_Y);
  assert.equal(placed[1].y - (placed[0].y + H), FLOW_TAB_GAP_Y);
  assert.equal(placed[2].y - (placed[1].y + H), FLOW_TAB_GAP_Y);

  // A Tab after that keeps the whole branch clear of it too.
  const wired = kids.map(k => tab('q', k.id));
  const next = placeTabChild([q, terminal, ...placed], wired, 'q', { id: 'd', width: W, height: H });
  const at = apply([q, terminal, ...placed], next.moved, [{ id: 'd', ...next.position, width: W, height: H }]);
  assert.equal(next.moved.has('terminal-demo'), false);
  for (const id of ['a', 'b', 'c', 'd']) assert.ok(!overlapping(at.get(id), terminal), `${id} is not under the terminal`);
});

test('a box wired to a pinned terminal is still pushed out of a growing branch’s way', () => {
  const { boxes, edges } = tabTimes([box('q', 0, 600)], [], 'q', ['a', 'b']);
  // Just under the branch, in its column, with an arrow on to a terminal well clear of it.
  const wiredBox = box('wired', W + FLOW_TAB_GAP_X, 720);
  const terminal = terminalBox('terminal-demo', 1200, 720);
  const arrows = [...edges, tab('wired', 'terminal-demo')];
  const canvas = [...boxes, wiredBox, terminal];
  const { position, moved } = placeTabChild(canvas, arrows, 'q', { id: 'c', width: W, height: H });
  assert.equal(moved.has('terminal-demo'), false, 'the terminal stays where it was put');
  assert.ok(moved.has('wired'), 'the box wired to it makes room');
  const at = apply(canvas, moved, [{ id: 'c', ...position, width: W, height: H }]);
  const all = [...at.values()];
  for (const a of all) for (const b of all) if (a !== b) assert.ok(!overlapping(a, b), `${a.id} on ${b.id}`);
});

test('a pinned terminal joined like a branch is never laid out as one, nor carried by a drag', () => {
  const { boxes, edges } = tabTimes([box('q', 0, 600)], [], 'q', ['a', 'b']);
  const terminal = terminalBox('terminal-demo', W + FLOW_TAB_GAP_X, 1400);
  const wired = [...edges, tab('q', 'terminal-demo')];
  const canvas = [...boxes, terminal];
  // Tidying the tree it seems to hang off leaves it alone…
  assert.equal(tidyFlowTree(canvas, wired, ['q']).has('terminal-demo'), false);
  // …so does deleting a sibling, or dragging the box it is wired to.
  assert.equal(tidyAfterDelete(canvas, wired, new Set(['a'])).has('terminal-demo'), false);
  assert.deepEqual(flowBranches(canvas, wired, ['q']).get('q')?.includes('terminal-demo') ?? false, false);
  const dropped = canvas.map(b => (b.id === 'q' ? { ...b, y: 650 } : b));
  assert.equal(tidyAfterMove(dropped, wired, new Map([['q', { x: 0, y: 600 }]])).has('terminal-demo'), false);
});

test('a pinned terminal leads nothing into a question, but the walk goes on past it', () => {
  const node = (id, x, data = {}) => ({ id, position: { x, y: 0 }, data: { label: id, shape: 'rounded', ...data } });
  const nodes = [
    node('Where is the session issued', 0),
    node('demo', 300, { shape: 'terminal', workspace: 'demo' }),
    node('Which module', 600),
  ];
  const edges = [
    { source: nodes[0].id, target: 'demo', targetHandle: 'left' },
    { source: 'demo', target: nodes[2].id, targetHandle: 'left', data: { label: 'then' } },
  ];
  const path = flowQuestionPath(nodes, edges, nodes[2].id);
  assert.deepEqual(path.map(step => step.label), ['Where is the session issued']);
  assert.equal(path[0].arrow, 'then');
});
