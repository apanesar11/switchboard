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
  carryOverFlowLayout,
  FLOW_TAB_GAP_X,
  FLOW_TAB_GAP_Y,
  FLOW_TAB_GAP_DOWN,
  FLOW_TAB_GAP_ACROSS,
  FLOW_ROOM_GAP,
  branchDirection,
  branchHandles,
  flowTabDirection,
  nextChildPosition,
  stepTerminalFont,
  TERMINAL_FONT_STEP,
} = require(outfile);

// Switchboard: ✦ Answer's question path, to check what it walks past.
const aiFile = path.join(temp, 'ai.js');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'diagrams', 'lib', 'diagrams', 'ai.ts')],
  outfile: aiFile, bundle: true, format: 'cjs', platform: 'node', logLevel: 'error',
});
const { flowQuestionPath } = require(aiFile);

// Switchboard: the validator, for a teleport's destination as a spec states it.
const validateFile = path.join(temp, 'validate.js');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'diagrams', 'lib', 'diagrams', 'validate.ts')],
  outfile: validateFile, bundle: true, format: 'cjs', platform: 'node', logLevel: 'error',
});
const { parseDiagramSpec } = require(validateFile);

// Switchboard: the layout and the shared limits, for a video's size.
const layoutFile = path.join(temp, 'layout.js');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'diagrams', 'lib', 'diagrams', 'layout.ts')],
  outfile: layoutFile, bundle: true, format: 'cjs', platform: 'node', logLevel: 'error',
});
const { layoutDiagram, flowNodeSize } = require(layoutFile);
const typesFile = path.join(temp, 'types.js');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'diagrams', 'lib', 'diagrams', 'types.ts')],
  outfile: typesFile, bundle: true, format: 'cjs', platform: 'node', logLevel: 'error',
});
const {
  VIDEO_LABEL,
  VIDEO_BAR,
  FLOW_SIZE_MAX,
  FLOW_VIDEO_DEFAULT_SIZE,
  FLOW_VIDEO_PORTRAIT_SIZE,
  flowVideoDefaultSize,
  isFlowVideoPortrait,
  flowVideoMinWidth,
  flowVideoSizeForWidth,
  PDF_LABEL,
  SHEET_LABEL,
  PDF_BAR,
  FLOW_PDF_DEFAULT_SIZE,
  FLOW_SHEET_SIZE,
  FLOW_FILE_SRC_MAX_LENGTH,
} = require(typesFile);

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

test('a question’s path carries each box’s words whole, however long', () => {
  const long = 'Why the fictional checkout waits on the card before it books the slot. '.repeat(10).trim();
  assert.ok(long.length > 200);
  const node = (id, x, data = {}) => ({ id, position: { x, y: 0 }, data: { label: id, shape: 'rounded', ...data } });
  const nodes = [node('context', 0, { label: long, detail: long }), node('question', 300)];
  const edges = [{ source: 'context', target: 'question', targetHandle: 'left' }];
  const path = flowQuestionPath(nodes, edges, 'question');
  assert.equal(path[0].label, long);
  assert.equal(path[0].detail, long);
});

// ── Switchboard: Smaller text and Larger text on a pinned terminal ──

test('Smaller text and Larger text step the type a tenth either way, in the same box', () => {
  const size = { width: 560, height: 340 };
  assert.equal(stepTerminalFont(12.5, 1, -1, size), Math.round(12.5 / TERMINAL_FONT_STEP * 1000) / 1000);
  assert.equal(stepTerminalFont(12.5, 1, 1, size), Math.round(12.5 * TERMINAL_FONT_STEP * 1000) / 1000);
  // No font of its own is the base 12.5; the step is the same at any zoom.
  assert.equal(stepTerminalFont(undefined, 1, -1, size), stepTerminalFont(12.5, 1, -1, size));
  assert.equal(stepTerminalFont(5, 2, -1, size), Math.round(5 / TERMINAL_FONT_STEP * 1000) / 1000);
  // Smaller then Larger lands back within rounding.
  const down = stepTerminalFont(9.124, 1.37, -1, size);
  assert.ok(Math.abs(stepTerminalFont(down, 1.37, 1, size) - 9.124) < 0.002);
});

test('Smaller text never takes the type under the size a terminal can be read at', () => {
  const size = { width: 560, height: 340 };
  // 7.4px on screen: one step would be 6.7, so it stops at exactly 7.
  const font = stepTerminalFont(7.4, 1, -1, size);
  assert.equal(font, 7);
  assert.equal(stepTerminalFont(font, 1, -1, size), null, 'at the floor it can go no smaller');
  // At zoom 0.5 the floor is 14 canvas units, drawn at 7px.
  assert.equal(stepTerminalFont(14.5, 0.5, -1, size), 14);
  assert.ok(stepTerminalFont(14.5, 0.5, -1, size) * 0.5 >= 7);
  // Already under it (the node says "Zoom in to use"): no smaller, but larger is fine.
  assert.equal(stepTerminalFont(5, 1, -1, size), null);
  assert.ok(stepTerminalFont(5, 1, 1, size) > 5);
  assert.equal(stepTerminalFont(12.5, 0, -1, size), null, 'no zoom, no step');
});

test('Larger text stops while the box still holds a usable grid', () => {
  const small = { width: 280, height: 140 };
  let font = 12.5;
  for (let i = 0; i < 40; i++) {
    const next = stepTerminalFont(font, 1, 1, small);
    if (next === null) break;
    assert.ok(next > font);
    font = next;
  }
  assert.equal(stepTerminalFont(font, 1, 1, small), null, 'it stops');
  // 20 columns of 0.6em across the width, 4 rows of 1.4em under the header.
  assert.ok(small.width / (font * 0.6) >= 20 - 1e-9, `cols at ${font}`);
  assert.ok((small.height - 30) / (font * 1.4) >= 4 - 1e-9, `rows at ${font}`);
  // A big box is capped by the spec's own limit instead.
  assert.ok(stepTerminalFont(79, 1, 1, { width: 4000, height: 4000 }) <= 80);
  assert.equal(stepTerminalFont(80, 1, 1, { width: 4000, height: 4000 }), null);
});

// ── Switchboard: a teleport and where it goes ──

test('a teleport says "Teleport" and goes to a node named in any case, never itself or one that is gone', () => {
  const parsed = parseDiagramSpec({ kind: 'flow', nodes: [
    { id: 'Checkout', label: 'Checkout' },
    { id: 'to-checkout', label: 'Go to checkout', shape: 'teleport', teleportTo: 'checkout' },
    { id: 'nowhere', shape: 'teleport', teleportTo: 'deleted-box' },
    { id: 'loop', shape: 'teleport', teleportTo: 'LOOP' },
    { id: 'plain', label: 'A box', teleportTo: 'Checkout' },
  ], edges: [] });
  assert.equal(parsed.ok, true, parsed.error);
  const [checkout, to, nowhere, loop, plain] = parsed.value.nodes;
  assert.equal(checkout.teleportTo, undefined);
  // Its label is always "Teleport", and its destination is spelt as that node spells it.
  assert.deepEqual([to.label, to.teleportTo], ['Teleport', 'Checkout']);
  assert.deepEqual([nowhere.label, nowhere.teleportTo], ['Teleport', undefined]);
  assert.equal(loop.teleportTo, undefined, 'never to itself');
  assert.equal(plain.teleportTo, undefined, 'only a teleport goes anywhere');
});

test('a teleport is saved with where it goes only while that node is on the board', () => {
  const data = (extra) => ({ label: '', shape: 'rounded', tone: 'default', dashed: false, textSize: 'medium', align: 'center', bold: false, italic: false, ...extra });
  const node = (id, extra) => ({ id, position: { x: 0, y: 0 }, data: data(extra) });
  const spec = flowSpecFromCanvas({}, [
    node('target', { label: 'Target' }),
    node('teleport', { label: 'anything', shape: 'teleport', teleportTo: 'target' }),
    node('teleport-2', { shape: 'teleport', teleportTo: 'gone' }),
    // A free text never typed into is not part of the drawing, so nothing goes to it.
    node('teleport-3', { shape: 'teleport', teleportTo: 'blank' }),
    node('blank', { shape: 'text' }),
    node('teleport-4', { shape: 'teleport', teleportTo: 'teleport-4' }),
  ], []);
  const by = new Map(spec.nodes.map(n => [n.id, n]));
  assert.deepEqual([by.get('teleport').label, by.get('teleport').teleportTo, by.get('teleport').shape], ['Teleport', 'target', 'teleport']);
  assert.equal(by.get('teleport-2').teleportTo, undefined);
  assert.equal(by.get('teleport-3').teleportTo, undefined);
  assert.equal(by.get('teleport-4').teleportTo, undefined);
  assert.equal(by.has('blank'), false);
  // What is saved is what the validator accepts, unchanged.
  const again = parseDiagramSpec(JSON.parse(JSON.stringify(spec)));
  assert.equal(again.ok, true, again.error);
  assert.equal(again.value.nodes.find(n => n.id === 'teleport').teleportTo, 'target');
});

test('a board rewritten from a terminal keeps where a teleport goes, while that node is still there', () => {
  const before = { kind: 'flow', nodes: [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
    { id: 'jump', label: 'Teleport', shape: 'teleport', teleportTo: 'b' },
    { id: 'jump-2', label: 'Teleport', shape: 'teleport', teleportTo: 'a' },
  ], edges: [] };
  // The rewrite states neither destination, and has dropped a.
  const next = { kind: 'flow', nodes: [
    { id: 'b', label: 'B' },
    { id: 'jump', label: 'Teleport', shape: 'teleport' },
    { id: 'jump-2', label: 'Teleport', shape: 'teleport' },
  ], edges: [] };
  const { spec } = carryOverFlowLayout(before, next);
  assert.equal(spec.nodes.find(n => n.id === 'jump').teleportTo, 'b');
  assert.equal(spec.nodes.find(n => n.id === 'jump-2').teleportTo, undefined);
});

test('a question\'s path walks past a teleport, whose only word is "Teleport"', () => {
  const node = (id, x, data = {}) => ({ id, position: { x, y: 0 }, data: { label: id, shape: 'rounded', ...data } });
  const nodes = [node('Start here', 0), node('teleport', 300, { label: 'Teleport', shape: 'teleport' }), node('Ask', 600)];
  const edges = [
    { source: 'Start here', target: 'teleport', targetHandle: 'left' },
    { source: 'teleport', target: 'Ask', targetHandle: 'left' },
  ];
  assert.deepEqual(flowQuestionPath(nodes, edges, 'Ask').map(step => step.label), ['Start here']);
});

// ── Switchboard: a YouTube video ──

// Made-up ids, 11 characters as a real one is (AGENTS.md).
const VID = 'exampleVid1';
const VID_2 = 'exampleVid2';
const SHORT = 'exampleShrt';

test('a video keeps its id as YouTube spells it, or reads it out of a link with the link\'s time', () => {
  const parsed = parseDiagramSpec({ kind: 'flow', nodes: [
    { id: 'talk', label: 'An example talk', shape: 'video', videoId: VID, videoStart: 42 },
    { id: 'linked', shape: 'video', videoId: `https://youtu.be/${VID_2}?t=1m5s&si=example` },
    { id: 'stated', shape: 'video', videoId: `https://youtu.be/${VID_2}?t=65`, videoStart: 7 },
    { id: 'short', shape: 'video', videoId: `https://www.youtube.com/shorts/${SHORT}` },
    { id: 'sized-short', shape: 'video', videoId: `https://www.youtube.com/shorts/${SHORT}`, size: { width: 400, height: 260 } },
    { id: 'upper', label: '   ', shape: 'video', videoId: ' EXAMPLEVID1 ', src: 'https://example.com/fictional.png' },
    { id: 'plain', label: 'A box', videoId: VID, videoStart: 42 },
  ], edges: [] });
  assert.equal(parsed.ok, true, parsed.error);
  const by = new Map(parsed.value.nodes.map(n => [n.id, n]));
  assert.deepEqual([by.get('talk').label, by.get('talk').videoId, by.get('talk').videoStart], ['An example talk', VID, 42]);
  // A link is read down to its id and its time; it is never the label.
  assert.deepEqual([by.get('linked').label, by.get('linked').videoId, by.get('linked').videoStart], [VIDEO_LABEL, VID_2, 65]);
  assert.equal(by.get('stated').videoStart, 7, 'a start the spec states wins over the link\'s');
  // A Short's link stands the video up, unless the spec sized it.
  assert.deepEqual(by.get('short').size, FLOW_VIDEO_PORTRAIT_SIZE);
  assert.deepEqual(by.get('sized-short').size, { width: 400, height: 260 });
  // Case is kept, never lowered as a document's id is; a video has no picture address.
  assert.deepEqual([by.get('upper').videoId, by.get('upper').label, by.get('upper').src], ['EXAMPLEVID1', VIDEO_LABEL, undefined]);
  assert.deepEqual([by.get('plain').videoId, by.get('plain').videoStart], [undefined, undefined], 'only a video plays anything');
});

test('a video with no id, or one that is not a YouTube video\'s, fails the board, naming the node', () => {
  const board = extra => parseDiagramSpec({ kind: 'flow', nodes: [{ id: 'a', label: 'A' }, { id: 'clip', shape: 'video', ...extra }], edges: [] });
  assert.deepEqual(board({}), { ok: false, error: 'Node 2: a "video" node needs "videoId", the 11-character id of a YouTube video (or its link)' });
  assert.deepEqual(board({ videoId: '' }), board({}));
  assert.deepEqual(board({ videoId: 42 }), { ok: false, error: 'Node 2: "videoId" must be text' });
  for (const videoId of ['exampleVid', 'exampleVid12', 'videoseries', `https://video.example.com/${VID}`, 'https://www.youtube.com/@ExampleChannel', `Watch https://youtu.be/${VID}`]) {
    assert.deepEqual(board({ videoId }), { ok: false, error: 'Node 2: "videoId" must be the 11-character id of a YouTube video, or a link to one' }, videoId);
  }
});

test('a video starts at whole seconds past 0, and anything else plays from the beginning', () => {
  const start = videoStart => {
    const parsed = parseDiagramSpec({ kind: 'flow', nodes: [{ id: 'v', shape: 'video', videoId: VID, videoStart }], edges: [] });
    assert.equal(parsed.ok, true, parsed.error);
    return parsed.value.nodes[0].videoStart;
  };
  assert.equal(start(90.9), 90);
  assert.equal(start(864000), 864000);
  for (const dropped of [0, 0.5, -5, 864001, Infinity, NaN, '90', null, true]) assert.equal(start(dropped), undefined, String(dropped));
});

test('a video is saved with its id, its start and its size, as the validator reads it back', () => {
  const data = (extra) => ({ label: '', shape: 'rounded', tone: 'default', dashed: false, textSize: 'medium', align: 'center', bold: false, italic: false, ...extra });
  const node = (id, extra) => ({ id, position: { x: 0, y: 0 }, data: data(extra) });
  const spec = flowSpecFromCanvas({}, [
    node('titled', { label: 'An example talk', shape: 'video', videoId: VID, videoStart: 42, size: { width: 640, height: 390 } }),
    node('untitled', { shape: 'video', videoId: VID_2, videoStart: 0 }),
    node('box', { label: 'A box', videoId: VID, videoStart: 42 }),
  ], []);
  const by = new Map(spec.nodes.map(n => [n.id, n]));
  const titled = by.get('titled');
  assert.deepEqual([titled.label, titled.shape, titled.videoId, titled.videoStart, titled.size], ['An example talk', 'video', VID, 42, { width: 640, height: 390 }]);
  // An untitled video is saved as "YouTube video", not "Untitled".
  assert.deepEqual([by.get('untitled').label, by.get('untitled').videoStart], [VIDEO_LABEL, undefined]);
  assert.deepEqual([by.get('box').videoId, by.get('box').videoStart], [undefined, undefined]);
  // What is saved is what the validator accepts, unchanged.
  const again = parseDiagramSpec(JSON.parse(JSON.stringify(spec)));
  assert.equal(again.ok, true, again.error);
  assert.deepEqual(JSON.parse(JSON.stringify(again.value)), JSON.parse(JSON.stringify(spec)));
});

test('a video laid out on the canvas and read back off it is the same video — what undo restores', () => {
  const parsed = parseDiagramSpec({ kind: 'flow', nodes: [
    { id: 'talk', label: 'An example talk', shape: 'video', videoId: VID, videoStart: 42, position: { x: 0, y: 0 }, size: { width: 640, height: 390 } },
    { id: 'unsized', shape: 'video', videoId: VID_2, position: { x: 0, y: 500 } },
    { id: 'next', label: 'Then this', position: { x: 800, y: 0 } },
  ], edges: [{ from: 'talk', to: 'next' }] });
  assert.equal(parsed.ok, true, parsed.error);
  const canvas = layoutDiagram(parsed.value);
  const at = new Map(canvas.nodes.map(n => [n.id, n]));
  assert.deepEqual([at.get('talk').width, at.get('talk').height], [640, 390]);
  assert.deepEqual([at.get('unsized').width, at.get('unsized').height], [480, 300]);
  const back = flowSpecFromCanvas({}, canvas.nodes, canvas.edges);
  assert.deepEqual(JSON.parse(JSON.stringify(back.nodes)), JSON.parse(JSON.stringify(parsed.value.nodes)));
});

test('a video is drawn the size it was given, else 480×270 under its bar; its height follows its width', () => {
  assert.deepEqual(FLOW_VIDEO_DEFAULT_SIZE, { width: 480, height: 270 + VIDEO_BAR });
  assert.deepEqual(flowNodeSize({ shape: 'video' }), FLOW_VIDEO_DEFAULT_SIZE);
  assert.deepEqual(flowNodeSize({ shape: 'video', size: { width: 200, height: 100 } }), { width: 200, height: 100 }, 'a size a CLI wrote is drawn as stated');
  // A Short stands up; a video is standing up when its player is taller than wide.
  assert.deepEqual(flowVideoDefaultSize(false), FLOW_VIDEO_DEFAULT_SIZE);
  assert.deepEqual(flowVideoDefaultSize(true), { width: 270, height: 480 + VIDEO_BAR });
  assert.equal(isFlowVideoPortrait(FLOW_VIDEO_DEFAULT_SIZE), false);
  assert.equal(isFlowVideoPortrait(FLOW_VIDEO_PORTRAIT_SIZE), true);
  assert.equal(isFlowVideoPortrait({ width: 300, height: 300 }), false, 'a 300×270 player lies down');
  // Resized, the player stays 16:9 (or 9:16), and a run of resizes back to the start
  // lands exactly where it began.
  assert.deepEqual(flowVideoSizeForWidth(640, false), { width: 640, height: 360 + VIDEO_BAR });
  assert.deepEqual(flowVideoSizeForWidth(360.4, true), { width: 360, height: 640 + VIDEO_BAR });
  let size = FLOW_VIDEO_DEFAULT_SIZE;
  for (const width of [481.3, 517, 733.6, 500.5, 480]) size = flowVideoSizeForWidth(width, isFlowVideoPortrait(size));
  assert.deepEqual(size, FLOW_VIDEO_DEFAULT_SIZE);
  // Never under YouTube's 200×200 player …
  assert.equal(flowVideoMinWidth(false), 356);
  assert.equal(flowVideoMinWidth(true), 200);
  assert.deepEqual(flowVideoSizeForWidth(100, false), { width: 356, height: 200 + VIDEO_BAR });
  assert.deepEqual(flowVideoSizeForWidth(100, true), { width: 200, height: 356 + VIDEO_BAR });
  // … and never past what a size may be, so the board still saves.
  const tall = flowVideoSizeForWidth(5000, true);
  const wide = flowVideoSizeForWidth(5000, false);
  assert.ok(tall.height <= FLOW_SIZE_MAX && tall.width === 2233, JSON.stringify(tall));
  assert.deepEqual(wide, { width: FLOW_SIZE_MAX, height: 2250 + VIDEO_BAR });
  const saved = parseDiagramSpec({ kind: 'flow', nodes: [
    { id: 'tall', shape: 'video', videoId: VID, size: tall },
    { id: 'wide', shape: 'video', videoId: VID, size: wide },
  ], edges: [] });
  assert.equal(saved.ok, true, saved.error);
});

test('a board rewritten from a terminal keeps a video\'s place and size, only onto a video, and never its start', () => {
  const sized = { width: 640, height: 390 };
  const before = { kind: 'flow', nodes: [
    { id: 'talk', label: 'An example talk', shape: 'video', videoId: VID, videoStart: 42, position: { x: 10, y: 20 }, size: sized },
    { id: 'was-video', label: 'An example talk', shape: 'video', videoId: VID_2, size: sized },
    { id: 'was-image', label: 'A picture', shape: 'image', src: 'https://example.com/fictional.png', size: sized },
  ], edges: [] };
  const next = { kind: 'flow', nodes: [
    { id: 'talk', label: 'An example talk', shape: 'video', videoId: VID },
    { id: 'was-video', label: 'Now a box' },
    { id: 'was-image', label: VIDEO_LABEL, shape: 'video', videoId: VID_2 },
  ], edges: [] };
  const { spec } = carryOverFlowLayout(before, next);
  const by = new Map(spec.nodes.map(n => [n.id, n]));
  assert.deepEqual([by.get('talk').position, by.get('talk').size, by.get('talk').videoStart], [{ x: 10, y: 20 }, sized, undefined]);
  assert.equal(by.get('was-video').size, undefined, 'a box is not given a video\'s size');
  assert.equal(by.get('was-image').size, undefined, 'nor a video a picture\'s');
});

test('a question\'s path walks past a video, whose title is not the question\'s, keeping the arrow\'s words', () => {
  const node = (id, x, data = {}) => ({ id, position: { x, y: 0 }, data: { label: id, shape: 'rounded', ...data } });
  const nodes = [node('Start here', 0), node('talk', 300, { label: 'An example talk', shape: 'video', videoId: VID }), node('Ask', 600)];
  const edges = [
    { source: 'Start here', target: 'talk', targetHandle: 'left' },
    { source: 'talk', target: 'Ask', targetHandle: 'left', data: { label: 'after watching' } },
  ];
  const steps = flowQuestionPath(nodes, edges, 'Ask');
  assert.deepEqual(steps.map(step => [step.label, step.arrow]), [['Start here', 'after watching']]);
});

test('folding a branch leaves a video placed beside it where it is, as it leaves a picture', () => {
  const start = tabTimes([box('q', 0, 600)], [], 'q', ['a', 'b', 'c']);
  const b = start.boxes.find(item => item.id === 'b');
  const video = { id: 'talk', x: b.x, y: b.y, width: 480, height: 300, shape: 'video' };
  const showing = [...start.boxes.filter(item => item.id !== 'b'), video];
  const edges = start.edges.filter(edge => edge.target !== 'b');
  const folded = apply(showing, tidyFlowTree(showing, edges, ['q'], [], { pinImages: true }));
  assert.deepEqual({ x: folded.get('talk').x, y: folded.get('talk').y }, { x: video.x, y: video.y });
  assert.equal(folded.get('c').y - (folded.get('a').y + H), FLOW_TAB_GAP_Y, 'the branch still closes up');
  // Unpinned, the same video would have been moved out of the branch's way.
  const loose = apply(showing, tidyFlowTree(showing, edges, ['q']));
  assert.notDeepEqual({ x: loose.get('talk').x, y: loose.get('talk').y }, { x: video.x, y: video.y });
});

// ── Switchboard: PDFs and spreadsheets ──

// Made-up file names, 32 hex characters as main's are (AGENTS.md).
const HASH_1 = '0123456789abcdef0123456789abcdef';
const HASH_2 = 'fedcba9876543210fedcba9876543210';
const PDF_FILE = `sbfile://file/${HASH_1}.pdf`;
const SHEET_FILE = `sbfile://file/${HASH_2}.xlsx`;
const COVER = `sbimg://image/${HASH_1}.png`;

test('a PDF and a spreadsheet keep their file, a PDF its cover and its size, each labelled by its name or else its kind', () => {
  const parsed = parseDiagramSpec({ kind: 'flow', nodes: [
    { id: 'report', label: 'Example quarterly report', shape: 'pdf', file: PDF_FILE, src: COVER, size: { width: 240, height: 340.6 } },
    { id: 'scan', label: '   ', shape: 'pdf', file: ` ${PDF_FILE} ` },
    { id: 'figures', label: 'Example figures', shape: 'sheet', file: SHEET_FILE, src: COVER, size: { width: 400, height: 300 } },
    { id: 'export', shape: 'sheet', file: `sbfile://file/${HASH_2}.csv` },
    { id: 'plain', label: 'A box', file: PDF_FILE, src: COVER },
    { id: 'picture', label: 'A picture', shape: 'image', src: COVER, file: PDF_FILE },
  ], edges: [] });
  assert.equal(parsed.ok, true, parsed.error);
  const by = new Map(parsed.value.nodes.map(n => [n.id, n]));
  const report = by.get('report');
  assert.deepEqual([report.label, report.file, report.src, report.size], ['Example quarterly report', PDF_FILE, COVER, { width: 240, height: 341 }]);
  // A PDF with no name says "PDF"; one with no cover has none, and its file is trimmed.
  assert.deepEqual([by.get('scan').label, by.get('scan').file, by.get('scan').src, by.get('scan').size], [PDF_LABEL, PDF_FILE, undefined, undefined]);
  // A spreadsheet has neither a picture nor a size of its own: its card is the one size.
  const figures = by.get('figures');
  assert.deepEqual([figures.label, figures.file, figures.src, figures.size], ['Example figures', SHEET_FILE, undefined, undefined]);
  assert.deepEqual([by.get('export').label, by.get('export').file], [SHEET_LABEL, `sbfile://file/${HASH_2}.csv`]);
  // Only a PDF or a spreadsheet shows a file.
  assert.deepEqual([by.get('plain').file, by.get('plain').src], [undefined, undefined]);
  assert.deepEqual([by.get('picture').file, by.get('picture').src], [undefined, COVER]);
  // Every kind of spreadsheet main keeps is one.
  for (const ext of ['xlsx', 'xlsm', 'xlsb', 'xls', 'ods', 'numbers', 'csv', 'tsv']) {
    const sheet = parseDiagramSpec({ kind: 'flow', nodes: [{ id: 's', shape: 'sheet', file: `sbfile://file/${HASH_2}.${ext}` }], edges: [] });
    assert.equal(sheet.ok, true, `${ext}: ${sheet.error}`);
  }
});

test('a PDF or a spreadsheet with no file, a file of the other kind, or an address not ours, fails the board, naming the node', () => {
  const board = (shape, extra) => parseDiagramSpec({ kind: 'flow', nodes: [{ id: 'a', label: 'A' }, { id: 'f', shape, ...extra }], edges: [] });
  assert.deepEqual(board('pdf', {}), { ok: false, error: 'Node 2: a "pdf" node needs "file", the sbfile:// address of a PDF kept on this Mac' });
  assert.deepEqual(board('sheet', {}), { ok: false, error: 'Node 2: a "sheet" node needs "file", the sbfile:// address of a spreadsheet kept on this Mac' });
  assert.deepEqual(board('pdf', { file: '' }), board('pdf', {}));
  assert.deepEqual(board('pdf', { file: null }), board('pdf', {}));
  assert.deepEqual(board('sheet', { file: 42 }), { ok: false, error: 'Node 2: "file" must be text' });
  // Each names a file of its own kind.
  assert.deepEqual(board('pdf', { file: SHEET_FILE }), { ok: false, error: 'Node 2: "file" must name a PDF' });
  assert.deepEqual(board('sheet', { file: PDF_FILE }), { ok: false, error: 'Node 2: "file" must name a spreadsheet' });
  // Only an address main gave a file it keeps: never a URL, a path, or a name of another kind.
  for (const file of [
    'https://example.com/fictional.pdf',
    '/Users/example/Documents/fictional.pdf',
    `sbfile://file/${HASH_1}.docx`,
    `sbfile://file/${HASH_1.toUpperCase()}.pdf`,
    `sbfile://file/${HASH_1.slice(1)}.pdf`,
    `sbfile://other/${HASH_1}.pdf`,
    `sbfile://file/../${HASH_1}.pdf`,
    `sbfile://file/${HASH_1}.pdf?page=2`,
    `sbfile://file/${HASH_1}.PDF`,
  ]) {
    assert.deepEqual(board('pdf', { file }), { ok: false, error: 'Node 2: "file" must be the sbfile://file/<name> address the app gave a PDF it keeps' }, file);
  }
  assert.deepEqual(board('sheet', { file: 'https://example.com/fictional.xlsx' }), { ok: false, error: 'Node 2: "file" must be the sbfile://file/<name> address the app gave a spreadsheet it keeps' });
  const long = `sbfile://file/${'a'.repeat(FLOW_FILE_SRC_MAX_LENGTH)}.pdf`;
  assert.deepEqual(board('pdf', { file: long }), { ok: false, error: `Node 2: "file" must be ${FLOW_FILE_SRC_MAX_LENGTH} characters or fewer` });
  // A cover, when there is one, is a picture's address as an image's is.
  assert.deepEqual(board('pdf', { file: PDF_FILE, src: 'http://example.com/fictional.png' }), { ok: false, error: 'Node 2: "src" must start with https://' });
  assert.deepEqual(board('pdf', { file: PDF_FILE, src: 'a cover' }), { ok: false, error: 'Node 2: "src" must be a full URL starting with https://' });
  assert.equal(board('pdf', { file: PDF_FILE, src: 'https://example.com/fictional.png' }).ok, true);
});

test('a PDF and a spreadsheet are saved with their file, a PDF with its cover and size, as the validator reads them back', () => {
  const data = (extra) => ({ label: '', shape: 'rounded', tone: 'default', dashed: false, textSize: 'medium', align: 'center', bold: false, italic: false, ...extra });
  const node = (id, extra) => ({ id, position: { x: 0, y: 0 }, data: data(extra) });
  const spec = flowSpecFromCanvas({}, [
    node('report', { label: 'Example quarterly report', shape: 'pdf', file: PDF_FILE, src: COVER, size: { width: 240, height: 340.6 } }),
    node('scan', { shape: 'pdf', file: PDF_FILE, src: '' }),
    node('figures', { label: 'Example figures', shape: 'sheet', file: SHEET_FILE, src: COVER, size: FLOW_SHEET_SIZE }),
    node('unnamed', { shape: 'sheet', file: SHEET_FILE }),
    node('box', { label: 'A box', file: PDF_FILE, src: COVER }),
  ], []);
  const by = new Map(spec.nodes.map(n => [n.id, n]));
  const report = by.get('report');
  assert.deepEqual([report.label, report.shape, report.file, report.src, report.size], ['Example quarterly report', 'pdf', PDF_FILE, COVER, { width: 240, height: 341 }]);
  // Unnamed, a PDF is saved as "PDF" and a spreadsheet as "Spreadsheet", never "Untitled".
  assert.deepEqual([by.get('scan').label, by.get('scan').src], [PDF_LABEL, undefined]);
  assert.deepEqual([by.get('figures').src, by.get('figures').size], [undefined, undefined]);
  assert.deepEqual([by.get('unnamed').label, by.get('unnamed').file], [SHEET_LABEL, SHEET_FILE]);
  assert.deepEqual([by.get('box').file, by.get('box').src], [undefined, undefined]);
  // What is saved is what the validator accepts, unchanged.
  const again = parseDiagramSpec(JSON.parse(JSON.stringify(spec)));
  assert.equal(again.ok, true, again.error);
  assert.deepEqual(JSON.parse(JSON.stringify(again.value)), JSON.parse(JSON.stringify(spec)));
});

test('a PDF is drawn the size it was given, else a portrait page over its bar; a spreadsheet as a document\'s card', () => {
  assert.deepEqual(FLOW_PDF_DEFAULT_SIZE, { width: 240, height: 311 + PDF_BAR });
  assert.deepEqual(FLOW_PDF_DEFAULT_SIZE, { width: 240, height: 341 });
  assert.deepEqual(FLOW_SHEET_SIZE, { width: 240, height: 76 });
  assert.deepEqual(flowNodeSize({ shape: 'pdf' }), FLOW_PDF_DEFAULT_SIZE);
  assert.deepEqual(flowNodeSize({ shape: 'pdf', label: 'A name far too long for any one line of a box '.repeat(4) }), FLOW_PDF_DEFAULT_SIZE, 'its name never sizes it');
  assert.deepEqual(flowNodeSize({ shape: 'pdf', size: { width: 400, height: 180 } }), { width: 400, height: 180 });
  assert.deepEqual(flowNodeSize({ shape: 'sheet' }), FLOW_SHEET_SIZE);
  assert.deepEqual(flowNodeSize({ shape: 'sheet', size: { width: 600, height: 400 } }), FLOW_SHEET_SIZE, 'a spreadsheet is never resized');
  assert.deepEqual(flowNodeSize({ shape: 'sheet' }), flowNodeSize({ shape: 'document' }));
});

test('a PDF and a spreadsheet laid out on the canvas and read back off it are the same — what undo restores', () => {
  const parsed = parseDiagramSpec({ kind: 'flow', nodes: [
    { id: 'report', label: 'Example quarterly report', shape: 'pdf', file: PDF_FILE, src: COVER, position: { x: 0, y: 0 }, size: { width: 240, height: 400 } },
    { id: 'scan', shape: 'pdf', file: PDF_FILE, position: { x: 400, y: 0 } },
    { id: 'figures', label: 'Example figures', shape: 'sheet', file: SHEET_FILE, position: { x: 800, y: 0 } },
  ], edges: [{ from: 'report', to: 'figures' }] });
  assert.equal(parsed.ok, true, parsed.error);
  const canvas = layoutDiagram(parsed.value);
  const at = new Map(canvas.nodes.map(n => [n.id, n]));
  assert.deepEqual([at.get('report').width, at.get('report').height, at.get('report').data.file, at.get('report').data.src], [240, 400, PDF_FILE, COVER]);
  assert.deepEqual([at.get('scan').width, at.get('scan').height], [FLOW_PDF_DEFAULT_SIZE.width, FLOW_PDF_DEFAULT_SIZE.height]);
  assert.deepEqual([at.get('figures').width, at.get('figures').height, at.get('figures').data.file], [240, 76, SHEET_FILE]);
  const back = flowSpecFromCanvas({}, canvas.nodes, canvas.edges);
  assert.deepEqual(JSON.parse(JSON.stringify(back.nodes)), JSON.parse(JSON.stringify(parsed.value.nodes)));
});

test('a board rewritten from a terminal keeps a PDF\'s place, size and cover while it shows the same file', () => {
  const sized = { width: 240, height: 400 };
  const before = { kind: 'flow', nodes: [
    { id: 'report', label: 'Example quarterly report', shape: 'pdf', file: PDF_FILE, src: COVER, position: { x: 10, y: 20 }, size: sized },
    { id: 'swapped', label: 'Example report', shape: 'pdf', file: PDF_FILE, src: COVER, size: sized },
    { id: 'was-pdf', label: 'Example report', shape: 'pdf', file: PDF_FILE, src: COVER, size: sized },
    { id: 'figures', label: 'Example figures', shape: 'sheet', file: SHEET_FILE, position: { x: 400, y: 20 } },
  ], edges: [] };
  const next = { kind: 'flow', nodes: [
    { id: 'report', label: 'Example quarterly report', shape: 'pdf', file: PDF_FILE },
    { id: 'swapped', label: 'Another example report', shape: 'pdf', file: `sbfile://file/${HASH_2}.pdf` },
    { id: 'was-pdf', label: 'Now a box' },
    { id: 'figures', label: 'Example figures', shape: 'sheet', file: SHEET_FILE },
  ], edges: [] };
  const { spec } = carryOverFlowLayout(before, next);
  const by = new Map(spec.nodes.map(n => [n.id, n]));
  assert.deepEqual([by.get('report').position, by.get('report').size, by.get('report').src], [{ x: 10, y: 20 }, sized, COVER]);
  // Another file's PDF is another PDF: the old cover would show the wrong pages.
  assert.equal(by.get('swapped').src, undefined, 'a cover goes only with its own file');
  assert.deepEqual([by.get('was-pdf').size, by.get('was-pdf').src], [undefined, undefined], 'a box is given neither a PDF\'s size nor its cover');
  assert.deepEqual(by.get('figures').position, { x: 400, y: 20 });
  // What is carried over is still a board the validator takes.
  assert.equal(parseDiagramSpec(spec).ok, true);
});

test('a question\'s path walks past a PDF and a spreadsheet, whose labels are only file names', () => {
  const node = (id, x, data = {}) => ({ id, position: { x, y: 0 }, data: { label: id, shape: 'rounded', ...data } });
  const nodes = [
    node('Start here', 0),
    node('report', 300, { label: 'Example quarterly report', shape: 'pdf', file: PDF_FILE }),
    node('figures', 600, { label: 'Example figures', shape: 'sheet', file: SHEET_FILE }),
    node('Ask', 900),
  ];
  const edges = [
    { source: 'Start here', target: 'report', targetHandle: 'left' },
    { source: 'report', target: 'figures', targetHandle: 'left', data: { label: 'read with' } },
    { source: 'figures', target: 'Ask', targetHandle: 'left', data: { label: 'then' } },
  ];
  const steps = flowQuestionPath(nodes, edges, 'Ask');
  assert.deepEqual(steps.map(step => [step.label, step.arrow]), [['Start here', 'read with → then']]);
});

test('folding a branch leaves a PDF placed beside it where it is, as it leaves a picture', () => {
  const start = tabTimes([box('q', 0, 600)], [], 'q', ['a', 'b', 'c']);
  const b = start.boxes.find(item => item.id === 'b');
  const pdf = { id: 'report', x: b.x, y: b.y, ...FLOW_PDF_DEFAULT_SIZE, shape: 'pdf' };
  const showing = [...start.boxes.filter(item => item.id !== 'b'), pdf];
  const edges = start.edges.filter(edge => edge.target !== 'b');
  const folded = apply(showing, tidyFlowTree(showing, edges, ['q'], [], { pinImages: true }));
  assert.deepEqual({ x: folded.get('report').x, y: folded.get('report').y }, { x: pdf.x, y: pdf.y });
  assert.equal(folded.get('c').y - (folded.get('a').y + H), FLOW_TAB_GAP_Y, 'the branch still closes up');
});

// ── Switchboard: a branch going down — out of a box's bottom into the top of one below ──
//
// The user asked that a box joined from its parent's bottom be laid out as one joined
// from the parent's right is (2026-11-01): "we need auto-formatting there as well".
// Such a branch is Tab's turned on its side: the boxes spread side by side under the
// one they hang off, centred on it, and what the tree crowds is pushed left or right.

const down = (source, target) => ({ source, target, sourceHandle: 'bottom', targetHandle: 'top' });
const middle = b => b.x + b.width / 2;

/** Adds `count` boxes under `parentId` one at a time, as Tab does on a branch going down. */
function downTimes(boxes, edges, parentId, ids) {
  let canvas = boxes.map(b => ({ ...b }));
  const wired = [...edges];
  for (const id of ids) {
    const { position, moved } = placeTabChild(canvas, wired, parentId, { id, width: W, height: H }, 'down');
    canvas = [...apply(canvas, moved).values(), { id, ...position, width: W, height: H }];
    wired.push(down(parentId, id));
  }
  return { boxes: canvas, edges: wired };
}

/** The ids hanging under `parent` in `at`, left to right. */
function row(at, ids) {
  return [...ids].sort((a, b) => at.get(a).x - at.get(b).x);
}

test('an arrow joins a box into a branch out of a right side into a left, or out of a bottom into a top', () => {
  const parent = box('p', 0, 0);
  assert.equal(branchDirection(branchHandles('right'), parent, box('c', 300, 0)), 'right');
  assert.equal(branchDirection(branchHandles('down'), parent, box('c', 0, 200)), 'down');
  // Onto a box the wrong way from its parent, or by any other pair of sides, it is just an arrow.
  assert.equal(branchDirection(branchHandles('right'), parent, box('c', -300, 0)), null);
  assert.equal(branchDirection(branchHandles('down'), parent, box('c', 0, -200)), null);
  assert.equal(branchDirection({ sourceHandle: 'left', targetHandle: 'right' }, parent, box('c', 300, 0)), null);
  assert.equal(branchDirection({ sourceHandle: 'top', targetHandle: 'bottom' }, parent, box('c', 0, 200)), null);
  assert.deepEqual(branchHandles('down'), { sourceHandle: 'bottom', targetHandle: 'top' });
});

test('the first box below lands centred under its parent, FLOW_TAB_GAP_DOWN beneath it', () => {
  const { position, moved } = placeTabChild([box('q', 100, 0)], [], 'q', { id: 'a', width: W, height: H }, 'down');
  assert.deepEqual(position, { x: 100, y: H + FLOW_TAB_GAP_DOWN });
  assert.equal(moved.size, 0);
  // A narrower box is centred on the parent too.
  const narrow = placeTabChild([box('q', 100, 0)], [], 'q', { id: 'a', width: 100, height: H }, 'down');
  assert.deepEqual(narrow.position, { x: 150, y: H + FLOW_TAB_GAP_DOWN });
});

test('more boxes below spread FLOW_TAB_GAP_ACROSS apart in one row, centred under the parent', () => {
  const { boxes } = downTimes([box('q', 600, 0)], [], 'q', ['a', 'b', 'c']);
  const at = new Map(boxes.map(b => [b.id, b]));
  assert.deepEqual(row(at, ['a', 'b', 'c']), ['a', 'b', 'c'], 'in the order they were added');
  assert.equal(at.get('b').x - (at.get('a').x + W), FLOW_TAB_GAP_ACROSS);
  assert.equal(at.get('c').x - (at.get('b').x + W), FLOW_TAB_GAP_ACROSS);
  for (const id of ['a', 'b', 'c']) assert.equal(at.get(id).y, H + FLOW_TAB_GAP_DOWN, `${id} in the row`);
  assert.equal((middle(at.get('a')) + middle(at.get('c'))) / 2, middle(at.get('q')), 'the row is centred on q');
  assert.deepEqual({ x: at.get('q').x, y: at.get('q').y }, { x: 600, y: 0 }, 'the box they hang off stays put');
});

test('an answer in parts below the question lands exactly where adding each would put it', () => {
  const start = [box('root', 0, 0), box('q', 0, H + FLOW_TAB_GAP_DOWN)];
  const edges = [down('root', 'q')];
  const oneByOne = downTimes(start, edges, 'q', ['a', 'b', 'c']);
  const { positions, moved } = placeTabChildren(start, edges, 'q', ['a', 'b', 'c'].map(id => ({ id, width: W, height: H })), 'down');
  const at = apply(start, moved, ['a', 'b', 'c'].map(id => ({ id, ...positions.get(id), width: W, height: H })));
  for (const b of oneByOne.boxes) assert.deepEqual({ x: at.get(b.id).x, y: at.get(b.id).y }, { x: b.x, y: b.y }, b.id);
});

test('a box dropped between two of its siblings below goes between them, back in their row', () => {
  const { boxes, edges } = downTimes([box('q', 600, 0)], [], 'q', ['a', 'b', 'c', 'd']);
  const at0 = new Map(boxes.map(b => [b.id, b]));
  // d, dragged left between a and b, a little off the row.
  const { dropped, from } = drag(boxes, 'd', { x: (at0.get('a').x + at0.get('b').x) / 2 + 10, y: at0.get('d').y + 37 });
  const at = apply(dropped, tidyAfterMove(dropped, edges, from));
  assert.deepEqual(row(at, ['a', 'b', 'c', 'd']), ['a', 'd', 'b', 'c']);
  for (const id of ['b', 'c', 'd']) assert.equal(at.get(id).y, at.get('a').y, `${id} in the row`);
  for (const [x, y] of [['a', 'd'], ['d', 'b'], ['b', 'c']]) {
    assert.equal(at.get(y).x - (at.get(x).x + W), FLOW_TAB_GAP_ACROSS, `${x} to ${y}`);
  }
  assert.equal((middle(at.get('a')) + middle(at.get('c'))) / 2, middle(at.get('q')));
  assert.deepEqual({ x: at.get('q').x, y: at.get('q').y }, { x: 600, y: 0 }, 'the box they hang off stays put');
});

test('a box dragged above what it hangs off leaves the branch below, which closes up behind it', () => {
  const { boxes, edges } = downTimes([box('q', 600, 400)], [], 'q', ['a', 'b', 'c']);
  const { dropped, from } = drag(boxes, 'b', { x: 1400, y: 0 });
  const at = apply(dropped, tidyAfterMove(dropped, edges, from));
  assert.deepEqual({ x: at.get('b').x, y: at.get('b').y }, { x: 1400, y: 0 }, 'left where it was dropped');
  assert.equal(at.get('c').x - (at.get('a').x + W), FLOW_TAB_GAP_ACROSS, 'a and c close up');
  assert.equal((middle(at.get('a')) + middle(at.get('c'))) / 2, middle(at.get('q')));
});

test('deleting a box below closes up the row around the parent', () => {
  const { boxes, edges } = downTimes([box('q', 600, 0)], [], 'q', ['a', 'b', 'c']);
  const at = apply(boxes.filter(b => b.id !== 'b'), tidyAfterDelete(boxes, edges, new Set(['b'])));
  assert.equal(at.get('c').x - (at.get('a').x + W), FLOW_TAB_GAP_ACROSS);
  assert.equal((middle(at.get('a')) + middle(at.get('c'))) / 2, middle(at.get('q')));
});

test('a box carries what hangs below it, all the way down', () => {
  const start = downTimes([box('root', 600, 0)], [], 'root', ['p', 's']);
  const deeper = downTimes(start.boxes, start.edges, 'p', ['p1', 'p2']);
  assert.deepEqual(flowBranches(deeper.boxes, deeper.edges, ['root']).get('root').sort(), ['p', 'p1', 'p2', 's']);
  assert.deepEqual(flowBranches(deeper.boxes, deeper.edges, ['p']).get('p').sort(), ['p1', 'p2']);
});

test('a row growing into another tree pushes that tree left or right out of its way, whole', () => {
  // Another tree, hanging down, stands to the right of where q's row will grow.
  const other = downTimes([box('o', 700, 0)], [], 'o', ['o1']);
  const mine = [box('q', 300, 0), ...other.boxes];
  const edges = [...other.edges];
  const { positions, moved } = placeTabChildren(mine, edges, 'q', ['a', 'b', 'c'].map(id => ({ id, width: W, height: H })), 'down');
  const at = apply(mine, moved, ['a', 'b', 'c'].map(id => ({ id, ...positions.get(id), width: W, height: H })));
  // o and o1 moved together, rightwards, and are now FLOW_ROOM_GAP clear of c.
  assert.equal(at.get('o').x - 700, at.get('o1').x - other.boxes.find(b => b.id === 'o1').x, 'o and o1 move together');
  assert.ok(at.get('o1').x > 700, 'pushed right');
  assert.equal(at.get('o1').x - (at.get('c').x + W), FLOW_ROOM_GAP);
  const all = [...at.values()];
  for (const x of all) for (const y of all) if (x !== y) assert.ok(!overlapping(x, y), `${x.id} on ${y.id}`);
});

test('a branch going right off a box below is one block with it: the next box along the row keeps clear', () => {
  // a hangs under q; a1 and a2 hang off a's right side, so a's block is wide.
  const start = downTimes([box('q', 600, 0)], [], 'q', ['a']);
  const wide = tabTimes(start.boxes, start.edges, 'a', ['a1', 'a2']);
  // Now b is added under q: it goes to the right of a's whole block, not onto a1.
  const { position, moved } = placeTabChild(wide.boxes, wide.edges, 'q', { id: 'b', width: W, height: H }, 'down');
  const at = apply(wide.boxes, moved, [{ id: 'b', ...position, width: W, height: H }]);
  assert.equal(at.get('b').x - (at.get('a1').x + W), FLOW_TAB_GAP_ACROSS, 'b clears a1 and a2');
  assert.equal(at.get('b').y, at.get('a').y, 'in a\'s row');
  assert.equal((centre(at.get('a1')) + centre(at.get('a2'))) / 2, centre(at.get('a')), 'a1 and a2 still centred on a');
  const all = [...at.values()];
  for (const x of all) for (const y of all) if (x !== y) assert.ok(!overlapping(x, y), `${x.id} on ${y.id}`);
});

test('boxes hanging below a box in a column stack the column under their whole block', () => {
  // a and b hang off q's right; a has two boxes hanging below it.
  const start = tabTimes([box('q', 0, 600)], [], 'q', ['a', 'b']);
  const tall = downTimes(start.boxes, start.edges, 'a', ['a1', 'a2']);
  const at = new Map(tall.boxes.map(b => [b.id, b]));
  const bottomOfA = Math.max(at.get('a1').y, at.get('a2').y) + H;
  assert.equal(at.get('b').y - bottomOfA, FLOW_TAB_GAP_Y, 'b stacks under a1 and a2, not under a alone');
  assert.equal(at.get('b').x, at.get('a').x, 'still in the column');
  // Centred under a, the row would reach back under q, level with it: it is let along
  // just far enough to clear q instead.
  assert.equal(at.get('a2').x - (at.get('a1').x + W), FLOW_TAB_GAP_ACROSS, 'a1 and a2 still a row');
  assert.ok(at.get('a1').x > at.get('q').x + W, 'the row keeps clear of q');
  assert.ok(middle(at.get('a1')) < middle(at.get('a')) && middle(at.get('a2')) > middle(at.get('a')), 'and still hangs either side of a');
  const all = [...at.values()];
  for (const x of all) for (const y of all) if (x !== y) assert.ok(!overlapping(x, y), `${x.id} on ${y.id}`);
});

test('Tab goes on downwards from a box whose every box hangs below it, and rightwards otherwise', () => {
  const below = downTimes([box('q', 600, 0)], [], 'q', ['a']);
  assert.equal(flowTabDirection(below.boxes, below.edges, 'q'), 'down');
  assert.equal(flowTabDirection(below.boxes, below.edges, 'a'), 'right', 'a box with nothing hanging off it');
  const right = tabTimes([box('q', 0, 600)], [], 'q', ['a']);
  assert.equal(flowTabDirection(right.boxes, right.edges, 'q'), 'right');
  const both = downTimes(right.boxes, right.edges, 'q', ['b']);
  assert.equal(flowTabDirection(both.boxes, both.edges, 'q'), 'right', 'both ways: Tab keeps to the right');
});

test('where the next box below would land, for the answer\'s placeholder', () => {
  const parent = box('q', 600, 0);
  assert.deepEqual(nextChildPosition(parent, [], [parent], { width: W, height: H }, 'down'), { x: 600, y: H + FLOW_TAB_GAP_DOWN });
  const first = box('a', 600, H + FLOW_TAB_GAP_DOWN);
  assert.deepEqual(nextChildPosition(parent, [first], [parent, first], { width: W, height: H }, 'down'), { x: 600 + W + FLOW_TAB_GAP_ACROSS, y: first.y });
});

test('arrows that go right, then down, then back to the first box never hang the layout', () => {
  // a → b to the right, b → c down, c → a to the right (a is right of c): a loop no
  // one-way walk could close. The box closing it tops a tree of its own, and the
  // layout ends.
  const boxes = [box('a', 300, 0), box('b', 600, 0), box('c', 0, 300)];
  const edges = [tab('a', 'b'), down('b', 'c'), tab('c', 'a')];
  const { position, moved } = placeTabChild(boxes, edges, 'b', { id: 'd', width: W, height: H });
  assert.ok(Number.isFinite(position.x) && Number.isFinite(position.y));
  assert.ok(moved instanceof Map);
  assert.ok(tidyFlowTree(boxes, edges, ['a']) instanceof Map);
  assert.ok(tidyAfterDelete(boxes, edges, new Set(['c'])) instanceof Map);
  const from = new Map([['b', { x: 600, y: 0 }]]);
  assert.ok(tidyAfterMove(boxes.map(b => (b.id === 'b' ? { ...b, y: 40 } : b)), edges, from) instanceof Map);
});
