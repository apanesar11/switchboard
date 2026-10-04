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
  FLOW_TAB_GAP_X,
  FLOW_TAB_GAP_Y,
  FLOW_ROOM_GAP,
} = require(outfile);

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
