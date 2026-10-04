'use strict';

// npm run test:diagrams — src/main/diagrams.js (M10) against a scratch folder, and the
// scoping that keeps the Diagrams bundle's stylesheet inside its own element
// (scripts/build-diagrams.js). Plain node, no Electron: neither file requires it.
//
// SWITCHBOARD_CONFIG is set BEFORE the module is required, as test-notes.js does, so
// every file this writes lands in a temp directory and never in ~/.switchboard.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-diagrams-test-')));
const previousConfig = process.env.SWITCHBOARD_CONFIG;
process.env.SWITCHBOARD_CONFIG = path.join(temp, 'config.json');

const diagrams = require('../src/main/diagrams');
const { scopeSelector } = require('./build-diagrams');

after(() => {
  if (previousConfig === undefined) delete process.env.SWITCHBOARD_CONFIG;
  else process.env.SWITCHBOARD_CONFIG = previousConfig;
  fs.rmSync(temp, { recursive: true, force: true });
});

const BLANK = { kind: 'flow', nodes: [], edges: [] };
const ONE_BOX = { kind: 'flow', nodes: [{ id: 'start', label: 'Start' }], edges: [] };

// ---------------------------------------------------------------------------
// where diagrams live
// ---------------------------------------------------------------------------

test('the diagrams folder follows SWITCHBOARD_CONFIG, one folder per workspace', () => {
  assert.equal(diagrams.rootDir(), path.join(temp, 'diagrams'));
  assert.match(diagrams.keyFor('sample-2'), /^sample-2-[0-9a-f]{10}$/);
  assert.notEqual(diagrams.keyFor('/a/odds'), diagrams.keyFor('/b/odds'));
  assert.ok(diagrams.dirFor('sample-2').startsWith(diagrams.rootDir() + path.sep));
  assert.equal(diagrams.dirFor(''), null);
});

// ---------------------------------------------------------------------------
// the admin's actions, as files
// ---------------------------------------------------------------------------

test('a new workspace has no diagrams, and that is not an error', async () => {
  assert.deepEqual(await diagrams.list('fresh-1'), { ok: true, data: [] });
});

test('create, list and get round-trip the spec', async () => {
  const made = await diagrams.create('sample-1', '  Checkout   flow ', ONE_BOX);
  assert.equal(made.ok, true);
  assert.equal(made.data.name, 'Checkout flow');          // collapsed, as the admin does
  assert.equal(made.data.archivedAt, null);
  assert.deepEqual(made.data.spec, ONE_BOX);

  const listed = await diagrams.list('sample-1');
  assert.equal(listed.ok, true);
  assert.equal(listed.data.length, 1);
  assert.equal(listed.data[0].spec, undefined, 'a list row carries no spec');

  const got = await diagrams.get('sample-1', made.data.id);
  assert.equal(got.ok, true);
  assert.deepEqual(got.data.spec, ONE_BOX);

  // Another workspace's folder does not have it.
  assert.equal((await diagrams.get('sample-2', made.data.id)).ok, false);
});

test('a name is unique within its workspace, not across them', async () => {
  assert.equal((await diagrams.create('names-1', 'Plan', BLANK)).ok, true);
  const again = await diagrams.create('names-1', 'Plan', BLANK);
  assert.equal(again.ok, false);
  assert.match(again.error, /already exists/);
  assert.equal((await diagrams.create('names-2', 'Plan', BLANK)).ok, true);
});

test('two creates under one name at once: only one wins', async () => {
  const [a, b] = await Promise.all([
    diagrams.create('race-1', 'Same', BLANK),
    diagrams.create('race-1', 'Same', BLANK),
  ]);
  assert.equal([a, b].filter(r => r.ok).length, 1);
});

test('update keeps createdAt and archivedAt and moves updatedAt', async () => {
  const made = await diagrams.create('upd-1', 'First', BLANK);
  await new Promise(r => setTimeout(r, 5));
  const saved = await diagrams.update('upd-1', made.data.id, 'Renamed', ONE_BOX);
  assert.equal(saved.ok, true);
  assert.equal(saved.data.name, 'Renamed');
  assert.equal(saved.data.createdAt, made.data.createdAt);
  assert.ok(saved.data.updatedAt > made.data.updatedAt);
  assert.deepEqual((await diagrams.get('upd-1', made.data.id)).data.spec, ONE_BOX);
});

test('renaming onto another diagram\'s name is refused', async () => {
  await diagrams.create('upd-2', 'Taken', BLANK);
  const other = await diagrams.create('upd-2', 'Free', BLANK);
  const r = await diagrams.update('upd-2', other.data.id, 'Taken', BLANK);
  assert.equal(r.ok, false);
  assert.match(r.error, /already exists/);
});

test('archiving leaves updatedAt alone and can be undone, once each way', async () => {
  const made = await diagrams.create('arch-1', 'Old idea', BLANK);
  const archived = await diagrams.setArchived('arch-1', made.data.id, true);
  assert.equal(archived.ok, true);
  assert.ok(archived.data.archivedAt);
  assert.equal(archived.data.updatedAt, made.data.updatedAt);
  assert.equal((await diagrams.setArchived('arch-1', made.data.id, true)).ok, false);
  const back = await diagrams.setArchived('arch-1', made.data.id, false);
  assert.equal(back.ok, true);
  assert.equal(back.data.archivedAt, null);
  assert.equal((await diagrams.setArchived('arch-1', made.data.id, false)).ok, false);
});

test('delete removes the one file, and a second delete says it is gone', async () => {
  const made = await diagrams.create('del-1', 'Doomed', BLANK);
  const keep = await diagrams.create('del-1', 'Kept', BLANK);
  assert.deepEqual(await diagrams.remove('del-1', made.data.id), { ok: true, data: { id: made.data.id } });
  assert.equal((await diagrams.remove('del-1', made.data.id)).ok, false);
  const left = await diagrams.list('del-1');
  assert.deepEqual(left.data.map(d => d.id), [keep.data.id]);
});

test('newest-touched first', async () => {
  const a = await diagrams.create('order-1', 'A', BLANK);
  await new Promise(r => setTimeout(r, 5));
  await diagrams.create('order-1', 'B', BLANK);
  await new Promise(r => setTimeout(r, 5));
  await diagrams.update('order-1', a.data.id, 'A', ONE_BOX);
  const names = (await diagrams.list('order-1')).data.map(d => d.name);
  assert.deepEqual(names, ['A', 'B']);
});

test('what is refused before anything is written', async () => {
  assert.equal((await diagrams.create('bad-1', '   ', BLANK)).ok, false);
  assert.equal((await diagrams.create('bad-1', 'x'.repeat(121), BLANK)).ok, false);
  assert.equal((await diagrams.create('bad-1', 'Seq', { kind: 'sequence' })).ok, false);
  assert.equal((await diagrams.create('bad-1', 'Nothing', null)).ok, false);
  // Ids are UUIDs, so no id can name a path.
  assert.equal((await diagrams.get('bad-1', '../../config')).ok, false);
  assert.equal((await diagrams.update('bad-1', '../x', 'n', BLANK)).ok, false);
  assert.deepEqual((await diagrams.list('bad-1')).data, []);
});

test('a diagram has no size limit: thousands of boxes save and read back', async () => {
  const nodes = Array.from({ length: 5000 }, (_, i) => ({ id: `n${i}`, label: 'Box '.repeat(20) + i }));
  const edges = nodes.slice(1).map((node, i) => ({ from: `n${i}`, to: node.id }));
  const big = { kind: 'flow', nodes, edges };
  assert.ok(Buffer.byteLength(JSON.stringify(big)) > 512000, 'past the admin\'s 512 KB');
  const made = await diagrams.create('big-1', 'Big', big);
  assert.equal(made.ok, true);
  const got = await diagrams.get('big-1', made.data.id);
  assert.equal(got.data.spec.nodes.length, 5000);
  assert.equal(got.data.spec.edges.length, 4999);
});

test('a file that is not a diagram is skipped by the list, and reported by get', async () => {
  const made = await diagrams.create('broken-1', 'Fine', BLANK);
  const dir = diagrams.dirFor('broken-1');
  const brokenId = '00000000-0000-4000-8000-000000000000';
  fs.writeFileSync(path.join(dir, brokenId + '.json'), '{ not json');
  const listed = await diagrams.list('broken-1');
  assert.deepEqual(listed.data.map(d => d.id), [made.data.id]);
  const got = await diagrams.get('broken-1', brokenId);
  assert.equal(got.ok, false);
});

// ---------------------------------------------------------------------------
// pictures
// ---------------------------------------------------------------------------

test('a picture is kept once, by content, and served only by its own name', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const a = await diagrams.saveImage(new Uint8Array(png), 'image/png');
  const b = await diagrams.saveImage(new Uint8Array(png), 'image/png');
  assert.equal(a.ok, true);
  assert.equal(a.src, b.src);
  assert.match(a.src, /^sbimg:\/\/image\/[0-9a-f]{32}\.png$/);
  const name = a.src.slice('sbimg://image/'.length);
  const file = diagrams.imagePath(name);
  assert.ok(fs.existsSync(file));
  assert.deepEqual(fs.readFileSync(file), png);

  assert.equal(diagrams.imagePath('../config.json'), null);
  assert.equal(diagrams.imagePath('x.png'), null);
  assert.equal(diagrams.imagePath(name.replace('.png', '.svg')), null);
  assert.equal((await diagrams.saveImage(new Uint8Array(png), 'image/svg+xml')).ok, false);
  assert.equal((await diagrams.saveImage(new Uint8Array(0), 'image/png')).ok, false);
});

// ---------------------------------------------------------------------------
// the bundle's stylesheet stays inside .sbdg
// ---------------------------------------------------------------------------

test('every selector is scoped to the editor, without adding specificity', () => {
  assert.equal(scopeSelector('.grid'), ':where(.sbdg) .grid');
  assert.equal(scopeSelector('.react-flow__node.selected'), ':where(.sbdg) .react-flow__node.selected');
  assert.equal(scopeSelector('*'), ':where(.sbdg) *');
  // The document's own roots become the editor's root.
  assert.equal(scopeSelector('html'), ':where(.sbdg)');
  assert.equal(scopeSelector('body'), ':where(.sbdg)');
  assert.equal(scopeSelector(':host'), ':where(.sbdg)');
  // Tailwind's theme variables stay global, for portalled content to inherit.
  assert.equal(scopeSelector(':root'), ':root');
  // A word that only starts like a root is an ordinary element.
  assert.equal(scopeSelector('header'), ':where(.sbdg) header');
});
