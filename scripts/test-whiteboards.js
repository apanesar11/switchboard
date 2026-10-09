'use strict';

// npm run test:diagrams — src/main/whiteboards.js (M10) against scratch folders: the store
// (folders, boards, documents, pictures), the summaries the Whiteboards screen lists, the
// change events index.js forwards, and the one-time migration from the per-workspace
// diagrams folders. Also the scoping that keeps the bundle's stylesheet inside its own
// element (scripts/build-diagrams.js). Plain node, no Electron: neither file requires it.
//
// SWITCHBOARD_CONFIG is set BEFORE the module is required, so every file this writes
// lands in a temp directory and never in ~/.switchboard. The migration tests each take a
// fresh copy of the module (fresh()) with a config folder of their own, since a migration
// runs once per store. Every id here is fictional (AGENTS.md).

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const temps = [];
function tempDir(label) {
  // realpath: os.tmpdir() is under /var, which is a symlink to /private/var.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `switchboard-${label}-test-`)));
  temps.push(dir);
  return dir;
}

const previousConfig = process.env.SWITCHBOARD_CONFIG;
const temp = tempDir('whiteboards');
process.env.SWITCHBOARD_CONFIG = path.join(temp, 'config.json');

const wb = require('../src/main/whiteboards');
const { scopeSelector } = require('./build-diagrams');
// Before any test writes: requiring the module must not have touched the disk.
const leftByRequire = fs.readdirSync(temp);

after(() => {
  if (previousConfig === undefined) delete process.env.SWITCHBOARD_CONFIG;
  else process.env.SWITCHBOARD_CONFIG = previousConfig;
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

const MAIN = path.join(__dirname, '..', 'src', 'main');
const FRESH = ['config.js', 'workspaces.js', 'whiteboards.js'].map(f => path.join(MAIN, f));

/**
 * A copy of whiteboards.js (and the config and workspaces modules under it) that reads a
 * config folder of its own. `cfg`, when given, is written as that folder's config.json
 * first. The shared `wb` above keeps its own modules: nothing here re-points it.
 */
function fresh(cfg) {
  const dir = tempDir('whiteboards-fresh');
  if (cfg) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg(dir), null, 2));
  return { mod: relaunch(dir), dir };
}

/** Another copy of the modules on the config folder `dir` — the app, launched again. */
function relaunch(dir) {
  const saved = process.env.SWITCHBOARD_CONFIG;
  process.env.SWITCHBOARD_CONFIG = path.join(dir, 'config.json');
  const cached = FRESH.map(file => [file, require.cache[file]]);
  for (const file of FRESH) delete require.cache[file];
  try {
    return require('../src/main/whiteboards');
  } finally {
    // The next require of these gets the shared copies back.
    for (const [file, entry] of cached) {
      if (entry) require.cache[file] = entry;
      else delete require.cache[file];
    }
    process.env.SWITCHBOARD_CONFIG = saved;
  }
}

const BLANK = { kind: 'flow', nodes: [], edges: [] };
const ONE_BOX = { kind: 'flow', nodes: [{ id: 'start', label: 'Start' }], edges: [] };
const pause = () => new Promise(r => setTimeout(r, 5));

/** Events the store reported while `run` ran. */
async function changesDuring(mod, run) {
  const seen = [];
  const off = mod.onChange(e => seen.push(e));
  try {
    await run();
  } finally {
    off();
  }
  return seen;
}

/** Edit store.json behind the module's back — how a migrated ("moved") folder is faked. */
function editStore(mod, fn) {
  const file = path.join(mod.rootDir(), 'store.json');
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  fn(store);
  fs.writeFileSync(file, JSON.stringify(store, null, 2));
}

async function folderNamed(mod, name) {
  const created = await mod.createFolder(name);
  assert.equal(created.ok, true, created.error);
  return created.data;
}

// ---------------------------------------------------------------------------
// where whiteboards live
// ---------------------------------------------------------------------------

test('requiring the module touches nothing on disk', () => {
  assert.deepEqual(leftByRequire, []);
});

test('the store follows SWITCHBOARD_CONFIG, and the old folder key is byte-identical', () => {
  assert.equal(wb.rootDir(), path.join(temp, 'whiteboards'));
  const sha = id => crypto.createHash('sha1').update(id).digest('hex').slice(0, 10);
  assert.equal(wb.legacyKeyFor('sample-2'), 'sample-2-' + sha('sample-2'));
  assert.equal(wb.legacyKeyFor('  sample-2  '), 'sample-2-' + sha('sample-2'));
  assert.equal(wb.legacyKeyFor('example space'), 'example-space-' + sha('example space'));
  assert.equal(wb.legacyKeyFor('/fictional/odds/'), 'odds-' + sha('/fictional/odds/'));
  assert.equal(wb.legacyKeyFor('...'), 'workspace-' + sha('...'));
  assert.notEqual(wb.legacyKeyFor('/a/odds'), wb.legacyKeyFor('/b/odds'));
  assert.equal(wb.legacyKeyFor(''), null);
  assert.equal(wb.legacyKeyFor(null), null);
});

test('an empty store lists nothing, and that is not an error', async () => {
  const { mod } = fresh();
  assert.deepEqual(await mod.list(), {
    ok: true,
    data: { folders: [], boards: [], notice: null, lastWorkspace: null, recentWorkspaces: [], migration: null },
  });
});

// ---------------------------------------------------------------------------
// boards
// ---------------------------------------------------------------------------

test('create, list and get round-trip the spec; a list row carries a summary, no spec', async () => {
  const made = await wb.create({ folderId: null, name: '  Checkout   flow ', spec: ONE_BOX });
  assert.equal(made.ok, true, made.error);
  assert.equal(made.data.name, 'Checkout flow');          // collapsed, as the admin does
  assert.equal(made.data.kind, 'flow');
  assert.equal(made.data.folderId, null);
  assert.equal(made.data.archivedAt, null);
  assert.equal(made.data.boxes, 1);
  assert.deepEqual(made.data.reads, []);
  assert.deepEqual(made.data.thumb, []);
  assert.deepEqual(made.data.spec, ONE_BOX);
  assert.ok(fs.existsSync(path.join(wb.rootDir(), 'boards', made.data.id + '.json')));

  const listed = await wb.list();
  assert.equal(listed.ok, true);
  const row = listed.data.boards.find(b => b.id === made.data.id);
  assert.equal(row.spec, undefined, 'a list row carries no spec');
  assert.deepEqual(Object.keys(row).sort(),
    ['archivedAt', 'boxes', 'createdAt', 'folderId', 'id', 'kind', 'name', 'reads', 'thumb', 'updatedAt', 'workspace']);

  const got = await wb.get(made.data.id);
  assert.equal(got.ok, true);
  assert.deepEqual(got.data.spec, ONE_BOX);
  assert.equal(got.data.name, 'Checkout flow');
  assert.equal((await wb.get(made.data.id.toUpperCase())).ok, true, 'ids are case-insensitive');
});

test('a name is unique within its folder, not across folders', async () => {
  const a = await folderNamed(wb, 'Names A');
  const b = await folderNamed(wb, 'Names B');
  assert.equal((await wb.create({ folderId: a.id, name: 'Plan', spec: BLANK })).ok, true);
  const again = await wb.create({ folderId: a.id, name: 'Plan', spec: BLANK });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'A whiteboard named “Plan” is already in “Names A” — pick another name');
  assert.equal((await wb.create({ folderId: b.id, name: 'Plan', spec: BLANK })).ok, true);
  // No folder is one namespace of its own.
  assert.equal((await wb.create({ folderId: null, name: 'Plan', spec: BLANK })).ok, true);
  const loose = await wb.create({ folderId: null, name: 'Plan', spec: BLANK });
  assert.equal(loose.error, 'A whiteboard named “Plan” is already in “No folder” — pick another name');
});

test('two creates under one name at once: only one wins', async () => {
  const f = await folderNamed(wb, 'Race');
  const [a, b] = await Promise.all([
    wb.create({ folderId: f.id, name: 'Same', spec: BLANK }),
    wb.create({ folderId: f.id, name: 'Same', spec: BLANK }),
  ]);
  assert.equal([a, b].filter(r => r.ok).length, 1);
});

test('saveSpec writes the spec only and moves updatedAt; rename writes the name only', async () => {
  const f = await folderNamed(wb, 'Saves');
  const made = await wb.create({ folderId: f.id, name: 'First', spec: BLANK });
  await pause();
  const saved = await wb.saveSpec(made.data.id, ONE_BOX);
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.data.name, 'First');
  assert.equal(saved.data.spec, undefined, 'a save answers a summary');
  assert.equal(saved.data.createdAt, made.data.createdAt);
  assert.ok(saved.data.updatedAt > made.data.updatedAt);
  assert.deepEqual((await wb.get(made.data.id)).data.spec, ONE_BOX);

  await pause();
  const renamed = await wb.rename(made.data.id, '  Second  name ');
  assert.equal(renamed.ok, true, renamed.error);
  assert.equal(renamed.data.name, 'Second name');
  assert.ok(renamed.data.updatedAt > saved.data.updatedAt);
  assert.deepEqual((await wb.get(made.data.id)).data.spec, ONE_BOX, 'a rename keeps the spec');

  await wb.create({ folderId: f.id, name: 'Taken', spec: BLANK });
  const clash = await wb.rename(made.data.id, 'Taken');
  assert.equal(clash.ok, false);
  assert.match(clash.error, /already in “Saves”/);
  assert.equal((await wb.saveSpec(made.data.id, { kind: 'sequence' })).ok, false);
});

test('unknown row fields survive every write', async () => {
  const made = await wb.create({ folderId: null, name: 'Extra fields', spec: BLANK });
  const file = path.join(wb.rootDir(), 'boards', made.data.id + '.json');
  const row = JSON.parse(fs.readFileSync(file, 'utf8'));
  row.fictionalExtra = { kept: true };
  fs.writeFileSync(file, JSON.stringify(row));
  await wb.saveSpec(made.data.id, ONE_BOX);
  await wb.rename(made.data.id, 'Extra fields 2');
  await wb.setWorkspace(made.data.id, 'sample-1');
  await wb.setArchived(made.data.id, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).fictionalExtra, { kept: true });
});

test('archiving leaves updatedAt alone and can be undone, once each way', async () => {
  const made = await wb.create({ folderId: null, name: 'Old idea', spec: BLANK });
  const archived = await wb.setArchived(made.data.id, true);
  assert.equal(archived.ok, true);
  assert.ok(archived.data.archivedAt);
  assert.equal(archived.data.updatedAt, made.data.updatedAt);
  assert.equal((await wb.setArchived(made.data.id, true)).error, 'Whiteboard not found (or already archived)');
  const back = await wb.setArchived(made.data.id, false);
  assert.equal(back.ok, true);
  assert.equal(back.data.archivedAt, null);
  assert.equal((await wb.setArchived(made.data.id, false)).error, 'Whiteboard not found (or already active)');
});

test('delete removes the one file, and a second delete says it is gone', async () => {
  const f = await folderNamed(wb, 'Deletes');
  const made = await wb.create({ folderId: f.id, name: 'Doomed', spec: BLANK });
  const keep = await wb.create({ folderId: f.id, name: 'Kept', spec: BLANK });
  assert.deepEqual(await wb.remove(made.data.id), { ok: true, data: { id: made.data.id } });
  assert.equal((await wb.remove(made.data.id)).ok, false);
  const left = (await wb.list()).data.boards.filter(b => b.folderId === f.id);
  assert.deepEqual(left.map(b => b.id), [keep.data.id]);
});

test('newest edit first', async () => {
  const { mod } = fresh();
  const a = await mod.create({ folderId: null, name: 'A', spec: BLANK });
  await pause();
  await mod.create({ folderId: null, name: 'B', spec: BLANK });
  await pause();
  await mod.saveSpec(a.data.id, ONE_BOX);
  assert.deepEqual((await mod.list()).data.boards.map(b => b.name), ['A', 'B']);
});

test('what is refused before anything is written', async () => {
  const { mod } = fresh();
  assert.equal((await mod.create({ folderId: null, name: '   ', spec: BLANK })).error, 'Name is required');
  assert.equal((await mod.create({ folderId: null, name: 'x'.repeat(121), spec: BLANK })).ok, false);
  assert.equal((await mod.create({ folderId: null, name: 'Seq', spec: { kind: 'sequence' } })).ok, false);
  assert.equal((await mod.create({ folderId: null, name: 'Nothing', spec: null })).ok, false);
  assert.equal((await mod.create(null)).ok, false);
  assert.equal((await mod.create({ folderId: 'not-a-folder', name: 'Lost', spec: BLANK })).error, 'That folder no longer exists');
  assert.equal((await mod.create({ folderId: crypto.randomUUID(), name: 'Lost', spec: BLANK })).error, 'That folder no longer exists');
  assert.equal((await mod.create({ folderId: null, name: 'Path', spec: BLANK, workspace: '/fictional/path' })).ok, false);
  // Ids are UUIDs, so no id can name a path.
  for (const id of ['../../config', '../x', '', null, 42]) {
    assert.equal((await mod.get(id)).ok, false);
    assert.equal((await mod.saveSpec(id, BLANK)).ok, false);
    assert.equal((await mod.rename(id, 'n')).ok, false);
    assert.equal((await mod.move(id, null)).ok, false);
    assert.equal((await mod.duplicate(id)).ok, false);
    assert.equal((await mod.setArchived(id, true)).ok, false);
    assert.equal((await mod.remove(id)).ok, false);
    assert.equal((await mod.setWorkspace(id, null)).ok, false);
  }
  assert.equal((await mod.get(crypto.randomUUID())).error, 'Whiteboard not found');
  assert.equal(fs.existsSync(mod.rootDir()), false, 'nothing was written');
});

test('a whiteboard has no size limit: thousands of boxes save and read back', async () => {
  const nodes = Array.from({ length: 5000 }, (_, i) => ({ id: `n${i}`, label: 'Box '.repeat(20) + i }));
  const edges = nodes.slice(1).map((node, i) => ({ from: `n${i}`, to: node.id }));
  const big = { kind: 'flow', nodes, edges };
  assert.ok(Buffer.byteLength(JSON.stringify(big)) > 512000, 'past the admin\'s 512 KB');
  const made = await wb.create({ folderId: null, name: 'Big', spec: big });
  assert.equal(made.ok, true);
  assert.equal(made.data.boxes, 5000);
  const got = await wb.get(made.data.id);
  assert.equal(got.data.spec.nodes.length, 5000);
  assert.equal(got.data.spec.edges.length, 4999);
});

test('a file that is not a whiteboard is skipped by the list, and reported by get', async () => {
  const { mod } = fresh();
  const made = await mod.create({ folderId: null, name: 'Fine', spec: BLANK });
  const brokenId = '00000000-0000-4000-8000-000000000000';
  const misnamed = '00000000-0000-4000-8000-000000000001';
  fs.writeFileSync(path.join(mod.rootDir(), 'boards', brokenId + '.json'), '{ not json');
  fs.writeFileSync(path.join(mod.rootDir(), 'boards', misnamed + '.json'), JSON.stringify({ id: brokenId, name: 'Wrong file' }));
  fs.writeFileSync(path.join(mod.rootDir(), 'boards', 'notes.txt'), 'not a board');
  const listed = await mod.list();
  assert.deepEqual(listed.data.boards.map(d => d.id), [made.data.id]);
  assert.equal((await mod.get(brokenId)).error, 'That whiteboard file is not valid JSON');
  assert.equal((await mod.saveSpec(brokenId, BLANK)).ok, false);
});

test('list re-reads a board changed on disk, and reuses the ones that are not', async () => {
  const { mod } = fresh();
  const made = await mod.create({ folderId: null, name: 'Cached', spec: BLANK });
  assert.equal((await mod.list()).data.boards[0].boxes, 0);
  const file = path.join(mod.rootDir(), 'boards', made.data.id + '.json');
  const row = JSON.parse(fs.readFileSync(file, 'utf8'));
  row.spec = { kind: 'flow', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [] };
  row.name = 'Changed outside';
  fs.writeFileSync(file, JSON.stringify(row));
  const after = (await mod.list()).data.boards[0];
  assert.equal(after.boxes, 2);
  assert.equal(after.name, 'Changed outside');
});

// ---------------------------------------------------------------------------
// what a summary says about its spec
// ---------------------------------------------------------------------------

test('boxes leave out pinned terminals; reads come only from AI boxes, sorted, once each', async () => {
  const spec = {
    kind: 'flow',
    nodes: [
      { id: 'q', label: 'Question' },
      { id: 'a1', label: 'Answer 1', ai: true, answeredIn: 'sample-2' },
      { id: 'a2', label: 'Answer 2', ai: true, answeredIn: 'example-1' },
      { id: 'a3', label: 'Answer 3', ai: true, answeredIn: 'sample-2' },
      { id: 'edited', label: 'Edited by hand', answeredIn: 'demo' },
      { id: 'bad', label: 'Bad tag', ai: true, answeredIn: '/fictional/path' },
      { id: 'hidden', label: 'Hidden tag', ai: true, answeredIn: '.hidden' },
      { id: 't', label: 'sample-2', shape: 'terminal', workspace: 'sample-2', size: { width: 560, height: 340 } },
    ],
    edges: [],
  };
  const made = await wb.create({ folderId: null, name: 'Reads', spec });
  assert.equal(made.data.boxes, 7);
  assert.deepEqual(made.data.reads, ['example-1', 'sample-2']);
});

test('the thumbnail fits up to 14 positioned boxes inside a 4px margin of 40×30, at the editor\'s sizes', async () => {
  const two = {
    kind: 'flow',
    nodes: [
      { id: 'a', label: 'A', position: { x: 0, y: 0 } },
      { id: 'b', label: 'B', position: { x: 400, y: 148 } },
      { id: 'floating', label: 'Not placed yet' },
    ],
    edges: [],
  };
  const made = await wb.create({ folderId: null, name: 'Thumb', spec: two });
  // Two 200×52 boxes span 600×200 flow units. Across, 32px of room is a scale of 1/18.75;
  // down, 22px would be 0.11, held to twice the across scale (0.1067) — so the boxes keep
  // a visible gap between their ranks — and the whole is centred in the 40×30 frame.
  assert.deepEqual(made.data.thumb, [[4, 4.4, 10.7, 5.5], [25.3, 20.1, 10.7, 5.5]]);

  // A note and a picture keep their own size (a picture with none is 240×180), a document
  // is 240×76, and a box is 200 wide whatever `size` it carries.
  const sized = {
    kind: 'flow',
    nodes: [
      { id: 'n', label: 'Note', shape: 'note', size: { width: 300, height: 200 }, position: { x: 0, y: 0 } },
      { id: 'i', label: 'Picture', shape: 'image', src: 'https://example.com/fictional.png', position: { x: 400, y: 0 } },
      { id: 'b', label: 'Box', size: { width: 60, height: 24 }, position: { x: 0, y: 260 } },
      { id: 'd', label: 'Doc', shape: 'document', position: { x: 400, y: 260 } },
    ],
    edges: [],
  };
  assert.deepEqual((await wb.create({ folderId: null, name: 'Thumb sized', spec: sized })).data.thumb,
    [[4, 4, 15, 13.1], [24, 4, 12, 11.8], [4, 20.7, 10, 4], [24, 21, 12, 5]]);

  // Boxes far apart are each far under a pixel: they are still drawn 6×4, about their
  // centres, and stay inside the frame.
  const far = {
    kind: 'flow',
    nodes: [
      { id: 'a', label: 'A', position: { x: 0, y: 0 } },
      { id: 'b', label: 'B', position: { x: 5000, y: 0 } },
    ],
    edges: [],
  };
  assert.deepEqual((await wb.create({ folderId: null, name: 'Thumb far', spec: far })).data.thumb,
    [[1.6, 13, 6, 4], [32.4, 13, 6, 4]]);

  const many = { kind: 'flow', nodes: [], edges: [] };
  for (let i = 0; i < 20; i++) {
    many.nodes.push({ id: `n${i}`, label: `${i}`, shape: 'text', position: { x: i * 97.3, y: (i % 5) * 41.7 }, size: { width: 120 + i, height: 40 } });
  }
  const lots = await wb.create({ folderId: null, name: 'Thumb many', spec: many });
  assert.equal(lots.data.thumb.length, 14);
  for (const [x, y, w, h] of lots.data.thumb) {
    for (const n of [x, y, w, h]) assert.equal(Math.round(n * 10) / 10, n, 'one decimal');
    assert.ok(x >= 0 && y >= 0 && w >= 6 && h >= 4, `${[x, y, w, h]} at least 6×4`);
    assert.ok(x + w <= 40.05 && y + h <= 30.05, `${[x, y, w, h]} inside 40×30`);
  }
  // A hand-edited file's odd fields still give a preview, never a failed list.
  const odd = {
    kind: 'flow',
    nodes: [
      { id: 'a', label: 7, detail: {}, textSize: 'constructor', position: { x: 0, y: 0 } },
      { id: 'b', label: 'B', shape: 'note', size: { width: -1, height: 'tall' }, textSize: '__proto__', position: { x: 400, y: 0 } },
    ],
    edges: [],
  };
  const oddMade = await wb.create({ folderId: null, name: 'Thumb odd', spec: odd });
  assert.equal(oddMade.ok, true, oddMade.error);
  assert.equal(oddMade.data.thumb.length, 2);
  assert.equal((await wb.list()).ok, true);

  const terminalOnly = { kind: 'flow', nodes: [{ id: 't', label: 'demo', shape: 'terminal', workspace: 'demo', position: { x: 0, y: 0 }, size: { width: 560, height: 340 } }], edges: [] };
  assert.deepEqual((await wb.create({ folderId: null, name: 'Thumb terminal', spec: terminalOnly })).data.thumb, []);
});

// ---------------------------------------------------------------------------
// folders
// ---------------------------------------------------------------------------

test('folders: one line, 1–60 characters, unique whatever the case, listed by name', async () => {
  const { mod } = fresh();
  assert.equal((await mod.createFolder('   ')).error, 'Folder name is required');
  assert.equal((await mod.createFolder('x'.repeat(61))).error, 'Folder names must be 60 characters or fewer');
  assert.equal((await mod.createFolder(null)).ok, false);
  const ten = await folderNamed(mod, 'sample 10');
  const two = await folderNamed(mod, '  sample \n 2 ');
  assert.equal(two.name, 'sample 2');
  assert.deepEqual(Object.keys(two).sort(), ['createdAt', 'id', 'moved', 'name']);
  assert.equal(two.moved, false);
  await folderNamed(mod, 'Example');
  assert.equal((await mod.createFolder('SAMPLE 2')).error, 'A folder named “SAMPLE 2” already exists');
  const listed = await mod.list();
  assert.deepEqual(listed.data.folders.map(f => f.name), ['Example', 'sample 2', 'sample 10']);
  assert.deepEqual(listed.data.folders.find(f => f.id === ten.id), Object.assign({}, ten, { count: 0, archived: 0 }));

  const renamed = await mod.renameFolder(two.id, 'Sample 2');
  assert.equal(renamed.ok, true, 'a folder may change only the case of its name');
  assert.equal((await mod.renameFolder(two.id, 'example')).error, 'A folder named “example” already exists');
  assert.equal((await mod.renameFolder(crypto.randomUUID(), 'Gone')).error, 'That folder no longer exists');
  assert.equal((await mod.renameFolder('../x', 'Gone')).ok, false);
});

test('a folder counts its active and archived boards, and is deleted only when empty', async () => {
  const { mod } = fresh();
  const f = await folderNamed(mod, 'Counted');
  const a = await mod.create({ folderId: f.id, name: 'A', spec: BLANK });
  const b = await mod.create({ folderId: f.id, name: 'B', spec: BLANK });
  await mod.setArchived(b.data.id, true);
  assert.deepEqual((await mod.list()).data.folders.map(x => [x.count, x.archived]), [[1, 1]]);
  assert.equal((await mod.removeFolder(f.id)).error, 'Move its whiteboards out first');
  await mod.move(a.data.id, null);
  assert.equal((await mod.removeFolder(f.id)).error, 'Move its whiteboards out first', 'an archived board still counts');
  await mod.move(b.data.id, null);
  assert.deepEqual(await mod.removeFolder(f.id), { ok: true, data: { id: f.id } });
  assert.deepEqual((await mod.list()).data.folders, []);
  assert.equal((await mod.removeFolder(f.id)).error, 'That folder no longer exists');
});

test('move: into a folder and out again; refused onto a name the folder has', async () => {
  const { mod } = fresh();
  const f = await folderNamed(mod, 'Target');
  const made = await mod.create({ folderId: null, name: 'Mover', spec: BLANK });
  await pause();
  const moved = await mod.move(made.data.id, f.id);
  assert.equal(moved.ok, true, moved.error);
  assert.equal(moved.data.folderId, f.id);
  assert.equal(moved.data.updatedAt, made.data.updatedAt, 'a move is not an edit');
  assert.equal((await mod.move(made.data.id, f.id)).ok, true, 'into the folder it is in: nothing to do');
  const back = await mod.move(made.data.id, null);
  assert.equal(back.data.folderId, null);

  await mod.create({ folderId: f.id, name: 'Mover', spec: BLANK });
  const clash = await mod.move(made.data.id, f.id);
  assert.equal(clash.ok, false);
  assert.equal(clash.error, 'A whiteboard named “Mover” is already in “Target” — rename it first');
  assert.equal((await mod.move(made.data.id, crypto.randomUUID())).error, 'That folder no longer exists');
  assert.equal((await mod.get(made.data.id)).data.folderId, null);
});

test('a board naming a folder that no longer exists reads as No folder', async () => {
  const { mod } = fresh();
  const made = await mod.create({ folderId: null, name: 'Orphan', spec: BLANK });
  const file = path.join(mod.rootDir(), 'boards', made.data.id + '.json');
  const row = JSON.parse(fs.readFileSync(file, 'utf8'));
  row.folderId = crypto.randomUUID();
  fs.writeFileSync(file, JSON.stringify(row));
  assert.equal((await mod.list()).data.boards[0].folderId, null);
  assert.equal((await mod.get(made.data.id)).data.folderId, null);
  // …and it shares No folder's names.
  assert.equal((await mod.create({ folderId: null, name: 'Orphan', spec: BLANK })).ok, false);
});

test('a migrated folder stays "moved" until something happens in it', async () => {
  const { mod } = fresh();
  const touches = {
    'renaming the folder': async f => mod.renameFolder(f.id, f.name + ' renamed'),
    'creating a board in it': async f => mod.create({ folderId: f.id, name: 'New', spec: BLANK }),
    'moving a board into it': async f => {
      const loose = await mod.create({ folderId: null, name: 'Loose ' + f.name, spec: BLANK });
      return mod.move(loose.data.id, f.id);
    },
    'renaming a board in it': async (f, board) => mod.rename(board, 'Renamed'),
    'saving a board in it': async (f, board) => mod.saveSpec(board, ONE_BOX),
    'duplicating a board in it': async (f, board) => mod.duplicate(board),
  };
  let n = 0;
  for (const [what, touch] of Object.entries(touches)) {
    const f = await folderNamed(mod, `Moved ${++n}`);
    const board = (await mod.create({ folderId: f.id, name: 'Inside', spec: BLANK })).data.id;
    editStore(mod, store => { store.folders.find(x => x.id === f.id).moved = true; });
    assert.equal((await mod.list()).data.folders.find(x => x.id === f.id).moved, true);
    // Archiving, a workspace change and reading it are not "something happening".
    await mod.setArchived(board, true);
    await mod.setArchived(board, false);
    await mod.setWorkspace(board, 'sample-1');
    await mod.get(board);
    assert.equal((await mod.list()).data.folders.find(x => x.id === f.id).moved, true, `still moved before ${what}`);
    const done = await touch(f, board);
    assert.equal(done.ok, true, `${what}: ${done.error}`);
    assert.equal((await mod.list()).data.folders.find(x => x.id === f.id).moved, false, `${what} touches it`);
  }
});

// ---------------------------------------------------------------------------
// duplicate
// ---------------------------------------------------------------------------

test('duplicate: same folder and workspace, active, "X copy", with documents of its own', async () => {
  const { mod } = fresh();
  const f = await folderNamed(mod, 'Copies');
  const doc = (await mod.createDocument('# Brief\n')).data;
  const missing = crypto.randomUUID();
  const spec = {
    kind: 'flow',
    nodes: [
      { id: 'd1', label: 'Brief', shape: 'document', documentId: doc.id },
      { id: 'd2', label: 'Brief again', shape: 'document', documentId: doc.id },
      { id: 'gone', label: 'Gone', shape: 'document', documentId: missing },
      { id: 'box', label: 'Box' },
    ],
    edges: [],
  };
  const made = await mod.create({ folderId: f.id, name: 'Original', spec, workspace: 'sample-2' });
  await mod.setArchived(made.data.id, true);

  const copy = await mod.duplicate(made.data.id);
  assert.equal(copy.ok, true, copy.error);
  assert.notEqual(copy.data.id, made.data.id);
  assert.equal(copy.data.name, 'Original copy');
  assert.equal(copy.data.folderId, f.id);
  assert.equal(copy.data.workspace, 'sample-2');
  assert.equal(copy.data.archivedAt, null);
  const [c1, c2, c3] = copy.data.spec.nodes;
  assert.notEqual(c1.documentId, doc.id, 'the copy has a document of its own');
  assert.equal(c1.documentId, c2.documentId, 'one document named twice stays one document');
  assert.equal(c3.documentId, missing, 'a document already gone stays as it was');
  assert.equal((await mod.getDocument(c1.documentId)).data.text, '# Brief\n');

  const copied = (await mod.getDocument(c1.documentId)).data;
  await mod.saveDocument(copied.id, 'Only the copy', copied.revision);
  assert.equal((await mod.getDocument(doc.id)).data.text, '# Brief\n', 'editing the copy leaves the original');
  assert.deepEqual((await mod.get(made.data.id)).data.spec, spec, 'the original spec is untouched');

  assert.equal((await mod.duplicate(made.data.id)).data.name, 'Original copy 2');
  assert.equal((await mod.duplicate(made.data.id)).data.name, 'Original copy 3');
  const long = await mod.create({ folderId: null, name: 'L'.repeat(120), spec: BLANK });
  const longCopy = await mod.duplicate(long.data.id);
  assert.equal(longCopy.data.name.length, 120);
  assert.match(longCopy.data.name, / copy$/);
});

// ---------------------------------------------------------------------------
// the workspace ✦ Answer reads, and the ones used last
// ---------------------------------------------------------------------------

test('setWorkspace does not move updatedAt, and makes the workspace the one used last', async () => {
  // sample-2 is on the rail, so a new board can start with it.
  const { mod, dir } = fresh(base => ({ workspaces: { 'sample-2': { dir: path.join(base, 'sample-2') } } }));
  fs.mkdirSync(path.join(dir, 'sample-2'));
  const made = await mod.create({ folderId: null, name: 'Reader', spec: BLANK });
  assert.equal(made.data.workspace, null, 'nothing used yet: no workspace');
  await pause();
  const set = await mod.setWorkspace(made.data.id, '  sample-2 ');
  assert.equal(set.ok, true, set.error);
  assert.equal(set.data.workspace, 'sample-2');
  assert.equal(set.data.updatedAt, made.data.updatedAt);
  let listed = (await mod.list()).data;
  assert.equal(listed.lastWorkspace, 'sample-2');
  assert.deepEqual(listed.recentWorkspaces, ['sample-2']);

  await mod.setWorkspace(made.data.id, 'example-1');
  await mod.setWorkspace(made.data.id, 'sample-2');
  listed = (await mod.list()).data;
  assert.deepEqual(listed.recentWorkspaces, ['sample-2', 'example-1']);

  const cleared = await mod.setWorkspace(made.data.id, null);
  assert.equal(cleared.data.workspace, null);
  assert.equal((await mod.list()).data.lastWorkspace, 'sample-2', 'clearing one board forgets nothing');

  for (const bad of ['/fictional/path', '.hidden', 'a/b', 'a\\b', '', '   ', 'x'.repeat(201), 'two\nlines', 7]) {
    assert.equal((await mod.setWorkspace(made.data.id, bad)).ok, false, JSON.stringify(bad));
  }

  // A new board starts with the workspace used last, unless it says otherwise.
  assert.equal((await mod.create({ folderId: null, name: 'Next', spec: BLANK })).data.workspace, 'sample-2');
  assert.equal((await mod.create({ folderId: null, name: 'None', spec: BLANK, workspace: null })).data.workspace, null);
  assert.equal((await mod.create({ folderId: null, name: 'Own', spec: BLANK, workspace: 'demo' })).data.workspace, 'demo');
});

test('noteWorkspace keeps the 8 most recent, newest first; { last } also sets the one used last', async () => {
  const { mod } = fresh();
  for (let i = 1; i <= 10; i++) assert.equal((await mod.noteWorkspace(`sample-${i}`)).ok, true);
  const again = await mod.noteWorkspace('sample-5');
  assert.deepEqual(again.data.recentWorkspaces,
    ['sample-5', 'sample-10', 'sample-9', 'sample-8', 'sample-7', 'sample-6', 'sample-4', 'sample-3']);
  assert.equal((await mod.list()).data.lastWorkspace, null, 'opening a terminal is not choosing a workspace');
  await mod.noteWorkspace('example-1', { last: true });
  assert.equal((await mod.list()).data.lastWorkspace, 'example-1');
  assert.equal((await mod.noteWorkspace('/fictional/path')).ok, false);
});

test('workspaceChoices: the rail in discovery order, home as ~, recent ones that still exist', async () => {
  const { mod, dir } = fresh(base => ({
    root: path.join(base, 'apps'),
    workspaces: {
      demo: { dir: path.join(base, 'apps', 'demo') },
      'example-1': { dir: path.join(base, 'elsewhere', 'example-1') },
      'fictional-gone': { dir: path.join(base, 'not-there') },
    },
  }));
  for (const d of ['apps/demo', 'elsewhere/example-1']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  await mod.noteWorkspace('fictional-gone');
  await mod.noteWorkspace('demo', { last: true });
  const home = os.homedir;
  os.homedir = () => dir;
  let choices;
  try {
    choices = await mod.workspaceChoices();
  } finally {
    os.homedir = home;
  }
  assert.equal(choices.ok, true, choices.error);
  assert.deepEqual(choices.data, {
    workspaces: [
      { id: 'demo', project: 'demo', dirLabel: '~/apps/demo' },
      { id: 'example-1', project: 'example', dirLabel: '~/elsewhere/example-1' },
    ],
    recent: ['demo'],
    last: 'demo',
  });
});

// ---------------------------------------------------------------------------
// ✦ Answer's conversations, kept beside the spec
// ---------------------------------------------------------------------------

/** A conversation as answer.js keeps one — every value fictional. */
function talk(extra) {
  return Object.assign({
    id: crypto.randomUUID(),
    workspace: 'sample-2',
    dir: '/fictional/apps/sample-2',
    startedAt: '2026-10-09T10:00:00.000Z',
    lastAt: '2026-10-09T10:05:00.000Z',
    turns: 2,
  }, extra);
}

function boardRow(mod, id) {
  return JSON.parse(fs.readFileSync(path.join(mod.rootDir(), 'boards', id + '.json'), 'utf8'));
}

test('a conversation is kept per CLI beside the spec, and is not an edit of the board', async () => {
  const { mod } = fresh();
  const made = (await mod.create({ folderId: null, name: 'Talks', spec: ONE_BOX, workspace: 'sample-2' })).data;
  assert.deepEqual(await mod.conversations(made.id), { ok: true, data: { 'claude-code': null, codex: null } });
  assert.deepEqual(await mod.conversation(made.id, 'codex'), { ok: true, data: null });
  const claude = talk();
  await pause();
  let set;
  const seen = await changesDuring(mod, async () => { set = await mod.setConversation(made.id, 'claude-code', claude); });
  assert.deepEqual(set, { ok: true, data: claude });
  assert.deepEqual(seen, [], 'no screen hears of it, so an open editor never reloads');
  const row = boardRow(mod, made.id);
  assert.equal(row.updatedAt, made.updatedAt, 'updatedAt stays');
  assert.deepEqual(row.conversations, { 'claude-code': claude });
  assert.deepEqual(row.spec, ONE_BOX, 'the spec is not where it goes');
  assert.deepEqual(await mod.conversation(made.id, 'claude-code'), { ok: true, data: claude });

  const codex = talk({ turns: 1 });
  await mod.setConversation(made.id, 'codex', codex);
  assert.deepEqual((await mod.conversations(made.id)).data, { 'claude-code': claude, codex });

  // Forgetting one keeps the other; forgetting both leaves no trace in the file.
  assert.deepEqual(await mod.setConversation(made.id, 'codex', null), { ok: true, data: null });
  assert.deepEqual(boardRow(mod, made.id).conversations, { 'claude-code': claude });
  await mod.setConversation(made.id, 'claude-code', null);
  assert.equal('conversations' in boardRow(mod, made.id), false);
  // Forgetting one there is none of writes nothing at all.
  const before = fs.statSync(path.join(mod.rootDir(), 'boards', made.id + '.json')).mtimeMs;
  await pause();
  assert.deepEqual(await mod.setConversation(made.id, 'codex', null), { ok: true, data: null });
  assert.equal(fs.statSync(path.join(mod.rootDir(), 'boards', made.id + '.json')).mtimeMs, before);
});

test('saveSpec, rename, move and archive keep the conversations; none of them shows one', async () => {
  const { mod } = fresh();
  const f = await folderNamed(mod, 'Kept talks');
  const made = (await mod.create({ folderId: null, name: 'Keeps', spec: BLANK, workspace: 'sample-2' })).data;
  const both = { 'claude-code': talk(), codex: talk({ turns: 4 }) };
  await mod.setConversation(made.id, 'claude-code', both['claude-code']);
  await mod.setConversation(made.id, 'codex', both.codex);
  const answers = [];
  answers.push(await mod.saveSpec(made.id, ONE_BOX));
  answers.push(await mod.rename(made.id, 'Keeps 2'));
  answers.push(await mod.move(made.id, f.id));
  answers.push(await mod.setArchived(made.id, true));
  answers.push(await mod.setArchived(made.id, false));
  answers.push(await mod.setWorkspace(made.id, 'sample-2'));      // the same workspace: no change
  answers.push(await mod.get(made.id));
  answers.push(await mod.list());
  for (const res of answers) assert.equal(res.ok, true, res.error);
  assert.deepEqual((await mod.conversations(made.id)).data, both);
  // A session id or a folder never leaves main in a summary or a get.
  const said = JSON.stringify(answers);
  for (const entry of Object.values(both)) {
    assert.equal(said.includes(entry.id), false);
    assert.equal(said.includes(entry.dir), false);
  }
  assert.equal(said.includes('conversations'), false);
});

test('an autosave and a conversation written at once both land', async () => {
  const { mod } = fresh();
  const made = (await mod.create({ folderId: null, name: 'Racing', spec: BLANK })).data;
  const entry = talk();
  const specs = Array.from({ length: 6 }, (_, i) => ({ kind: 'flow', nodes: [{ id: `n${i}`, label: `Box ${i}` }], edges: [] }));
  await Promise.all([
    ...specs.slice(0, 3).map(spec => mod.saveSpec(made.id, spec)),
    mod.setConversation(made.id, 'claude-code', entry),
    ...specs.slice(3).map(spec => mod.saveSpec(made.id, spec)),
  ]);
  const row = boardRow(mod, made.id);
  assert.deepEqual(row.spec, specs[5]);
  assert.deepEqual(row.conversations, { 'claude-code': entry });
});

test('a copy starts no conversation of its own, and a new workspace forgets the old ones', async () => {
  const { mod } = fresh();
  const made = (await mod.create({ folderId: null, name: 'Original talk', spec: BLANK, workspace: 'sample-2' })).data;
  const entry = talk();
  await mod.setConversation(made.id, 'claude-code', entry);
  const copy = (await mod.duplicate(made.id)).data;
  assert.equal('conversations' in boardRow(mod, copy.id), false);
  assert.deepEqual((await mod.conversations(copy.id)).data, { 'claude-code': null, codex: null });
  assert.deepEqual((await mod.conversation(made.id, 'claude-code')).data, entry, 'the original keeps its own');

  await mod.setConversation(made.id, 'codex', talk());
  await mod.setWorkspace(made.id, 'example-1');
  assert.equal('conversations' in boardRow(mod, made.id), false);
  assert.deepEqual((await mod.conversations(made.id)).data, { 'claude-code': null, codex: null });
  await mod.setConversation(made.id, 'codex', talk({ workspace: 'example-1' }));
  await mod.setWorkspace(made.id, null);
  assert.deepEqual((await mod.conversations(made.id)).data, { 'claude-code': null, codex: null }, 'no workspace is a change too');
});

test('a conversation is read back only when it is one answer.js could have written', async () => {
  const { mod } = fresh();
  const made = (await mod.create({ folderId: null, name: 'Edited by hand', spec: BLANK })).data;
  const file = path.join(mod.rootDir(), 'boards', made.id + '.json');
  const good = talk();
  const bad = [
    talk({ id: '--dangerously-bypass-approvals-and-sandbox' }),
    talk({ id: 'not-a-uuid' }),
    talk({ id: good.id + ' --resume' }),
    talk({ workspace: '/fictional/apps/sample-2' }),
    talk({ workspace: '' }),
    talk({ dir: 'relative/sample-2' }),
    talk({ dir: '/fictional/two\nlines' }),
    talk({ dir: 7 }),
    talk({ turns: 0 }),
    talk({ turns: 1.5 }),
    talk({ turns: '3' }),
    talk({ startedAt: 'yesterday' }),
    talk({ lastAt: undefined }),
    'a string',
    null,
  ];
  for (const entry of bad) {
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    row.conversations = { 'claude-code': entry, codex: good };
    fs.writeFileSync(file, JSON.stringify(row));
    assert.deepEqual((await mod.conversations(made.id)).data, { 'claude-code': null, codex: good }, JSON.stringify(entry));
  }
  // Writing one drops what could not be read, and any key that is not one of the two CLIs.
  const row = JSON.parse(fs.readFileSync(file, 'utf8'));
  row.conversations = { 'claude-code': bad[0], codex: good, 'claude-api': good, fictionalExtra: true };
  row.fictionalExtra = { kept: true };
  fs.writeFileSync(file, JSON.stringify(row));
  const fresher = talk({ turns: 3 });
  assert.equal((await mod.setConversation(made.id, 'codex', fresher)).ok, true);
  const after = boardRow(mod, made.id);
  assert.deepEqual(after.conversations, { codex: fresher });
  assert.deepEqual(after.fictionalExtra, { kept: true }, 'the rest of the row survives');
  // A conversations field that is not an object reads as none.
  for (const odd of ['text', [good], 7]) {
    const r = boardRow(mod, made.id);
    r.conversations = odd;
    fs.writeFileSync(file, JSON.stringify(r));
    assert.deepEqual((await mod.conversations(made.id)).data, { 'claude-code': null, codex: null });
  }
});

test('what setConversation refuses, and where there is no board', async () => {
  const { mod } = fresh();
  const made = (await mod.create({ folderId: null, name: 'Refusals', spec: BLANK })).data;
  const before = fs.readFileSync(path.join(mod.rootDir(), 'boards', made.id + '.json'), 'utf8');
  for (const entry of [talk({ id: '--dangerously-bypass-approvals-and-sandbox' }), talk({ dir: 'relative' }), talk({ turns: 0 }), 'text', 7]) {
    assert.equal((await mod.setConversation(made.id, 'claude-code', entry)).ok, false, JSON.stringify(entry));
  }
  for (const provider of ['claude-api', 'openai-api', '', undefined, '__proto__']) {
    assert.equal((await mod.setConversation(made.id, provider, talk())).ok, false, String(provider));
    assert.equal((await mod.conversation(made.id, provider)).ok, false, String(provider));
  }
  assert.equal(fs.readFileSync(path.join(mod.rootDir(), 'boards', made.id + '.json'), 'utf8'), before, 'nothing was written');
  const missing = crypto.randomUUID();
  assert.deepEqual(await mod.setConversation(missing, 'codex', talk()), { ok: false, error: 'Whiteboard not found' });
  assert.deepEqual(await mod.conversations(missing), { ok: false, error: 'Whiteboard not found' });
  assert.deepEqual(await mod.conversations('../store'), { ok: false, error: 'Invalid whiteboard id' });
  assert.deepEqual(await mod.setConversation('../store', 'codex', null), { ok: false, error: 'Invalid whiteboard id' });
  await mod.remove(made.id);
  assert.deepEqual(await mod.setConversation(made.id, 'codex', null), { ok: false, error: 'Whiteboard not found' });
  assert.equal(fs.existsSync(path.join(mod.rootDir(), 'boards', made.id + '.json')), false, 'a deleted board is not made again');
});

// ---------------------------------------------------------------------------
// change events
// ---------------------------------------------------------------------------

test('every write says what changed; a refused one and the recent list say nothing', async () => {
  const { mod } = fresh();
  let f;
  let made;
  let copy;
  const seen = await changesDuring(mod, async () => {
    f = await folderNamed(mod, 'Events');
    made = (await mod.create({ folderId: f.id, name: 'Board', spec: BLANK })).data;
    await mod.saveSpec(made.id, ONE_BOX);
    await mod.rename(made.id, 'Board 2');
    await mod.setWorkspace(made.id, 'sample-1');
    await mod.setWorkspace(made.id, 'sample-1');       // no change: nothing to say
    await mod.move(made.id, null);
    copy = (await mod.duplicate(made.id)).data;
    await mod.setArchived(copy.id, true);
    await mod.remove(copy.id);
    await mod.renameFolder(f.id, 'Events 2');
    await mod.removeFolder(f.id);
    await mod.noteWorkspace('demo');
    await mod.create({ folderId: null, name: '', spec: BLANK });
    await mod.rename(made.id, '');
  });
  assert.deepEqual(seen, [
    { reason: 'folder', folderId: f.id },
    { reason: 'create', boardId: made.id, folderId: f.id },
    { reason: 'save', boardId: made.id, folderId: f.id },
    { reason: 'rename', boardId: made.id, folderId: f.id },
    { reason: 'workspace', boardId: made.id, folderId: f.id },
    { reason: 'move', boardId: made.id, folderId: null },
    { reason: 'duplicate', boardId: copy.id, folderId: null },
    { reason: 'archive', boardId: copy.id, folderId: null },
    { reason: 'delete', boardId: copy.id, folderId: null },
    { reason: 'folder', folderId: f.id },
    { reason: 'folder', folderId: f.id },
  ]);
  // A listener that throws does not stop the write, nor the listeners after it.
  const off = mod.onChange(() => { throw new Error('fictional listener failure'); });
  const error = console.error;
  console.error = () => {};
  try {
    const later = await changesDuring(mod, () => mod.saveSpec(made.id, BLANK));
    assert.deepEqual(later.map(e => e.reason), ['save']);
  } finally {
    console.error = error;
    off();
  }
});

test('dismissNotice: the notice stays dismissed, and with none there is nothing to do', async () => {
  const { mod } = fresh();
  assert.deepEqual(await mod.dismissNotice(), { ok: true, data: {} });
  assert.equal(fs.existsSync(mod.rootDir()), false);
  await mod.createFolder('Anything');
  editStore(mod, store => { store.notice = { boards: 3, folders: 1, dismissed: false }; });
  const seen = await changesDuring(mod, () => mod.dismissNotice());
  assert.deepEqual(seen, [{ reason: 'notice' }]);
  assert.deepEqual((await mod.list()).data.notice, { boards: 3, folders: 1, dismissed: true });
});

test('an unreadable store.json is kept beside the new one, never overwritten unseen', async () => {
  const { mod } = fresh();
  fs.mkdirSync(mod.rootDir(), { recursive: true });
  fs.writeFileSync(path.join(mod.rootDir(), 'store.json'), '{ not json');
  const error = console.error;
  console.error = () => {};
  try {
    assert.equal((await mod.list()).ok, true);
    assert.equal((await mod.createFolder('After')).ok, true);
  } finally {
    console.error = error;
  }
  const kept = fs.readdirSync(mod.rootDir()).filter(n => /^store\.unreadable-\d+\.json$/.test(n));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(mod.rootDir(), kept[0]), 'utf8'), '{ not json');
  assert.deepEqual((await mod.list()).data.folders.map(f => f.name), ['After']);
});

// ---------------------------------------------------------------------------
// pictures
// ---------------------------------------------------------------------------

test('a picture is kept once, by content, and served only by its own name', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const a = await wb.saveImage(new Uint8Array(png), 'image/png');
  const b = await wb.saveImage(new Uint8Array(png), 'image/png');
  assert.equal(a.ok, true);
  assert.equal(a.src, b.src);
  assert.match(a.src, /^sbimg:\/\/image\/[0-9a-f]{32}\.png$/);
  const name = a.src.slice('sbimg://image/'.length);
  const file = wb.imagePath(name);
  assert.equal(file, path.join(wb.rootDir(), 'images', name));
  assert.deepEqual(fs.readFileSync(file), png);

  assert.equal(wb.imagePath('../config.json'), null);
  assert.equal(wb.imagePath('x.png'), null);
  assert.equal(wb.imagePath(name.replace('.png', '.svg')), null);
  assert.equal((await wb.saveImage(new Uint8Array(png), 'image/svg+xml')).ok, false);
  assert.equal((await wb.saveImage(new Uint8Array(0), 'image/png')).ok, false);
  assert.deepEqual(Object.keys(wb.IMAGE_TYPES).sort(), ['image/jpeg', 'image/png', 'image/webp']);
});

test('image paths resolve only existing stored pictures, never arbitrary files or traversal', async () => {
  const saved = await wb.saveImage(Buffer.from('example picture'), 'image/png');
  const expected = wb.imagePath(saved.src.slice('sbimg://image/'.length));
  assert.deepEqual(await wb.getImagePath(saved.src), { ok: true, data: expected });
  for (const src of [null, {}, expected, 'file://' + expected, 'https://example.com/picture.png',
    'sbimg://image/../config.json', 'sbimg://image/%2e%2e%2fconfig.json',
    saved.src + '?extra=1', saved.src + '#extra', saved.src.replace('sbimg://image/', 'sbimg://other/')]) {
    assert.equal((await wb.getImagePath(src)).ok, false);
  }
  await fs.promises.unlink(expected);
  assert.deepEqual(await wb.getImagePath(saved.src), { ok: false, error: 'Image file not found' });
});

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------

// Markdown document nodes keep their text in ordinary files, with independent revisions
// so a canvas autosave cannot overwrite an external editor's changes. One store serves
// every board: moving a board moves no file.
test('documents store exact Markdown in one place for every board, apart from board JSON', async () => {
  const { mod } = fresh();
  const text = '# Brief\n\n**Selected words**\n\n- parent\n  - child\n- [ ] Open\n- [x] Done\n\n```js\nconst count = 2;\n```\n';
  const made = await mod.createDocument(text);
  assert.equal(made.ok, true);
  assert.equal(made.data.path, path.join(mod.rootDir(), 'documents', made.data.id + '.md'));
  assert.equal(fs.readFileSync(made.data.path, 'utf8'), text);
  assert.deepEqual(await mod.getDocument(made.data.id), made);
  const a = await folderNamed(mod, 'Docs A');
  const b = await folderNamed(mod, 'Docs B');
  const spec = { kind: 'flow', nodes: [{ id: 'brief', label: 'Brief', shape: 'document', documentId: made.data.id }], edges: [] };
  const chart = await mod.create({ folderId: a.id, name: 'Reference flow', spec });
  assert.equal(chart.ok, true);
  await mod.move(chart.data.id, b.id);
  assert.equal((await mod.getDocument(made.data.id)).data.path, made.data.path, 'a move moves no document');
  assert.equal((await mod.list()).data.boards.length, 1, 'Markdown files are not board rows');
  await mod.remove(chart.data.id);
  assert.equal((await mod.getDocument(made.data.id)).ok, true, 'files survive deletion for recovery and undo');
  assert.equal((await mod.createDocument()).data.text, '', 'a new document can start empty');
});

test('document saves require the current revision and never clobber another editor', async () => {
  const { data } = await wb.createDocument('Original');
  const saved = await wb.saveDocument(data.id, 'First edit', data.revision);
  assert.equal(saved.ok, true);
  const stale = await wb.saveDocument(data.id, 'Stale edit', data.revision);
  assert.equal(stale.code, 'conflict');
  fs.writeFileSync(data.path, 'External edit\n');
  const external = await wb.saveDocument(data.id, 'Panel edit', saved.data.revision);
  assert.equal(external.code, 'conflict');
  assert.equal(fs.readFileSync(data.path, 'utf8'), 'External edit\n');
  const reloaded = await wb.getDocument(data.id);
  const resolved = await wb.saveDocument(data.id, 'Chosen version', reloaded.data.revision);
  assert.equal(resolved.ok, true);
  assert.equal(fs.readFileSync(data.path, 'utf8'), 'Chosen version');
});

test('concurrent document writes serialize and a copy has independent contents', async () => {
  const { mod } = fresh();
  const { data } = await mod.createDocument('Before');
  const results = await Promise.all([
    mod.saveDocument(data.id, 'A', data.revision),
    mod.saveDocument(data.id, 'B', data.revision),
  ]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.filter(result => result.code === 'conflict').length, 1);
  const original = (await mod.getDocument(data.id)).data;
  const copy = (await mod.createDocument(original.text)).data;
  assert.notEqual(copy.id, original.id);
  await mod.saveDocument(copy.id, 'Independent edit', copy.revision);
  assert.equal((await mod.getDocument(data.id)).data.text, original.text);
  await mod.settle();
  assert.deepEqual(fs.readdirSync(path.dirname(data.path)).sort(), [data.id + '.md', copy.id + '.md'].sort());
});

test('document storage rejects traversal, missing files and oversized text without creating a file', async () => {
  const { mod } = fresh();
  for (const id of ['../escape', '', 'not-a-uuid', null]) {
    assert.equal((await mod.getDocument(id)).ok, false);
    assert.equal((await mod.saveDocument(id, 'text', 'version')).ok, false);
  }
  assert.equal((await mod.getDocument('00000000-0000-0000-0000-000000000000')).error, 'Document file not found');
  assert.equal((await mod.createDocument(null)).ok, false);
  assert.equal((await mod.createDocument('a'.repeat(10 * 1024 * 1024 + 1))).ok, false);
  assert.equal(fs.existsSync(mod.rootDir()), false);
});

test('settle waits for every write that has started', async () => {
  const { mod } = fresh();
  const pending = [
    mod.create({ folderId: null, name: 'One', spec: BLANK }),
    mod.createFolder('Two'),
    mod.createDocument('three'),
  ];
  const settled = await mod.settle();
  assert.deepEqual(settled, { ok: true });
  for (const p of pending) assert.equal((await p).ok, true);
  assert.equal((await mod.list()).data.boards.length, 1);
});

// ---------------------------------------------------------------------------
// the migration from per-workspace diagrams
// ---------------------------------------------------------------------------

const AT = (n) => `2026-0${n}-01T10:00:00.000Z`;

/** One old diagram file, in the folder the old layout gave `wsKey` (an id or a dir name). */
function legacyBoard(mod, base, wsKey, row) {
  const dirName = /-[0-9a-f]{10}$/.test(wsKey) ? wsKey : mod.legacyKeyFor(wsKey);
  const dir = path.join(base, 'diagrams', dirName);
  fs.mkdirSync(dir, { recursive: true });
  const full = Object.assign({ id: crypto.randomUUID(), kind: 'flow', createdAt: AT(1), updatedAt: AT(1), archivedAt: null, spec: BLANK }, row);
  fs.writeFileSync(path.join(dir, full.id + '.json'), JSON.stringify(full, null, 2));
  return full;
}

function legacyFile(base, rel, contents) {
  const file = path.join(base, 'diagrams', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

/** Every file under `dir`, relative, sorted — to see that nothing was lost. */
function tree(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), path.join(rel, e.name));
      else out.push(path.join(rel, e.name));
    }
  };
  walk(dir, '');
  return out.sort();
}

function quietly(fn) {
  const error = console.error;
  console.error = () => {};
  return Promise.resolve().then(fn).finally(() => { console.error = error; });
}

const rail = base => ({
  root: path.join(base, 'apps'),
  workspaces: {
    'sample-1': { dir: path.join(base, 'apps', 'sample-1') },
    'sample-2': { dir: path.join(base, 'apps', 'sample-2') },
  },
});

// The same rail, plus a workspace the config declares whose folder is gone: it is not on
// the rail, but the config still names it, so its old diagrams still find their workspace.
const railAndDeclared = base => {
  const cfg = rail(base);
  cfg.workspaces['example space'] = { dir: path.join(base, 'apps', 'not-there') };
  return cfg;
};

function railDirs(base) {
  for (const d of ['sample-1', 'sample-2']) fs.mkdirSync(path.join(base, 'apps', d), { recursive: true });
}

test('migration with no old diagrams records that it ran, and makes nothing else', async () => {
  const { mod, dir } = fresh();
  const r = await mod.migrate();
  assert.deepEqual(r, { ok: true, data: { boards: 0, folders: 0, skipped: 0, legacyRoot: null } });
  const listed = (await mod.list()).data;
  assert.equal(listed.notice, null);
  assert.deepEqual(listed.migration, { error: null, skipped: 0, legacyRoot: null, legacyLabel: null });
  assert.deepEqual(fs.readdirSync(dir), ['whiteboards']);
  assert.deepEqual(fs.readdirSync(mod.rootDir()), ['store.json']);
  assert.equal((await mod.migrate()).data.already, true);
});

test('migration: one folder per project, a suffix on a clash, answers tagged with their workspace', async () => {
  const { mod, dir } = fresh(railAndDeclared);
  railDirs(dir);
  const overview1 = legacyBoard(mod, dir, 'sample-1', {
    name: 'Overview',
    createdAt: AT(1),
    updatedAt: AT(3),
    fictionalExtra: 'kept',
    spec: {
      kind: 'flow',
      nodes: [
        { id: 'q', label: 'Which repos?' },
        { id: 'a', label: 'sample-api', ai: true },
        { id: 'b', label: 'sample-web', ai: true, answeredIn: 'example-1' },
      ],
      edges: [{ from: 'q', to: 'a' }],
    },
  });
  const plan1 = legacyBoard(mod, dir, 'sample-1', { name: 'Plan', updatedAt: AT(2), archivedAt: AT(2) });
  const overview2 = legacyBoard(mod, dir, 'sample-2', { name: 'Overview', updatedAt: AT(5) });
  const spaced = legacyBoard(mod, dir, 'example space', {
    name: 'Spaced',
    updatedAt: AT(4),
    spec: { kind: 'flow', nodes: [{ id: 'a', label: 'Answer', ai: true }], edges: [] },
  });
  const before = tree(path.join(dir, 'diagrams'));

  // quietly: discovery says once that the declared folder is missing.
  const r = await quietly(() => mod.migrate());
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data, { boards: 4, folders: 2, skipped: 0, legacyRoot: 'diagrams-before-whiteboards' });

  const listed = (await mod.list()).data;
  assert.deepEqual(listed.folders.map(f => [f.name, f.moved, f.count, f.archived]),
    [['example space', true, 1, 0], ['sample', true, 2, 1]]);
  const sample = listed.folders.find(f => f.name === 'sample');
  const byId = new Map(listed.boards.map(b => [b.id, b]));
  assert.equal(byId.get(overview1.id).name, 'Overview');
  assert.equal(byId.get(overview2.id).name, 'Overview (sample-2)');
  for (const [b, ws] of [[overview1, 'sample-1'], [plan1, 'sample-1'], [overview2, 'sample-2']]) {
    assert.equal(byId.get(b.id).folderId, sample.id);
    assert.equal(byId.get(b.id).workspace, ws);
  }
  assert.equal(byId.get(spaced.id).workspace, 'example space', 'matched through the config\'s declared ids');
  assert.equal(byId.get(plan1.id).archivedAt, AT(2));
  assert.deepEqual(byId.get(overview1.id).reads, ['example-1', 'sample-1']);

  const moved = (await mod.get(overview1.id)).data;
  assert.equal(moved.createdAt, AT(1));
  assert.equal(moved.updatedAt, AT(3));
  const [q, a, b] = moved.spec.nodes;
  assert.equal(q.answeredIn, undefined, 'only AI boxes are tagged');
  assert.equal(a.answeredIn, 'sample-1', 'an AI box read the workspace it was asked in');
  assert.equal(b.answeredIn, 'example-1', 'an existing tag is kept');
  const row = JSON.parse(fs.readFileSync(path.join(mod.rootDir(), 'boards', overview1.id + '.json'), 'utf8'));
  assert.deepEqual(row.migratedFrom, { legacyKey: mod.legacyKeyFor('sample-1'), workspace: 'sample-1' });
  assert.equal(row.fictionalExtra, 'kept');

  // The old tree is renamed, every file still in it, untouched.
  assert.equal(fs.existsSync(path.join(dir, 'diagrams')), false);
  const renamed = path.join(dir, 'diagrams-before-whiteboards');
  assert.deepEqual(tree(renamed), before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(renamed, mod.legacyKeyFor('sample-1'), overview1.id + '.json'), 'utf8')).spec.nodes[1].answeredIn, undefined);

  // The notice, and the workspaces it brought: the newest-edited board's first — of those
  // still on the rail ('example space' is declared, but its folder is gone).
  assert.deepEqual(listed.notice, { boards: 4, folders: 2, dismissed: false });
  assert.deepEqual(listed.migration, {
    error: null,
    skipped: 0,
    legacyRoot: 'diagrams-before-whiteboards',
    legacyLabel: path.join(dir, 'diagrams-before-whiteboards'),
  });
  assert.equal(listed.lastWorkspace, 'sample-2');
  assert.deepEqual(listed.recentWorkspaces, ['sample-2', 'sample-1']);
  assert.equal((await mod.create({ folderId: null, name: 'New', spec: BLANK })).data.workspace, 'sample-2');
});

test('a new board never starts with a workspace that has left the rail', async () => {
  const { mod, dir } = fresh(railAndDeclared);
  railDirs(dir);
  // The most recently edited old board read 'example space', whose folder is gone.
  const gone = legacyBoard(mod, dir, 'example space', { name: 'Gone', updatedAt: AT(9) });
  legacyBoard(mod, dir, 'sample-1', { name: 'One', updatedAt: AT(2) });
  legacyBoard(mod, dir, 'sample-2', { name: 'Two', updatedAt: AT(3) });
  assert.equal((await quietly(() => mod.migrate())).ok, true);
  let listed = (await mod.list()).data;
  assert.equal(listed.lastWorkspace, 'sample-2', 'the newest board on the rail, not the newest board');
  assert.deepEqual(listed.recentWorkspaces, ['sample-2', 'sample-1']);
  assert.equal((await mod.get(gone.id)).data.workspace, 'example space', 'the old board keeps what it read');
  assert.equal((await mod.create({ folderId: null, name: 'First', spec: BLANK })).data.workspace, 'sample-2');

  // Chosen on a board after all: still the one used last, but no start for a new board,
  // which takes the most recent workspace that is still on the rail.
  await mod.setWorkspace(gone.id, 'example space');
  listed = (await mod.list()).data;
  assert.equal(listed.lastWorkspace, 'example space');
  assert.deepEqual(listed.recentWorkspaces, ['example space', 'sample-2', 'sample-1']);
  assert.equal((await mod.create({ folderId: null, name: 'Second', spec: BLANK })).data.workspace, 'sample-2');
  let choices = (await quietly(() => mod.workspaceChoices())).data;
  assert.deepEqual(choices.recent, ['sample-2', 'sample-1']);
  assert.equal(choices.last, 'sample-2', 'what a new board would start with');

  // Workspaces leave the rail later too: the next one down, then none.
  fs.rmSync(path.join(dir, 'apps', 'sample-2'), { recursive: true });
  assert.equal((await quietly(() => mod.create({ folderId: null, name: 'Third', spec: BLANK }))).data.workspace, 'sample-1');
  fs.rmSync(path.join(dir, 'apps', 'sample-1'), { recursive: true });
  assert.equal((await quietly(() => mod.create({ folderId: null, name: 'Fourth', spec: BLANK }))).data.workspace, null);
  choices = (await quietly(() => mod.workspaceChoices())).data;
  assert.deepEqual(choices, { workspaces: [], recent: [], last: null });
  // Asked for by name, a workspace is taken as given: the picker only offers the rail.
  assert.equal((await mod.create({ folderId: null, name: 'Fifth', spec: BLANK, workspace: 'sample-1' })).data.workspace, 'sample-1');
});

test('migration brings documents and pictures, and a picture left behind is still found', async () => {
  const { mod, dir } = fresh(rail);
  railDirs(dir);
  const docId = crypto.randomUUID();
  legacyBoard(mod, dir, 'sample-1', {
    name: 'With a document',
    spec: { kind: 'flow', nodes: [{ id: 'd', label: 'Doc', shape: 'document', documentId: docId }], edges: [] },
  });
  legacyFile(dir, path.join(mod.legacyKeyFor('sample-1'), 'documents', docId + '.md'), '# Kept\n');
  const png = 'a'.repeat(32) + '.png';
  const jpg = 'b'.repeat(32) + '.jpg';
  legacyFile(dir, path.join('images', png), 'fictional png');
  legacyFile(dir, path.join('images', jpg), 'fictional jpg');
  legacyFile(dir, path.join('images', png + '.123.4.tmp'), 'a write that never finished');

  // Before the migration, a picture is served from where it is.
  assert.equal(mod.imagePath(png), path.join(dir, 'diagrams', 'images', png));

  assert.equal((await mod.migrate()).ok, true);
  const doc = await mod.getDocument(docId);
  assert.equal(doc.ok, true);
  assert.equal(doc.data.text, '# Kept\n');
  assert.equal(doc.data.path, path.join(mod.rootDir(), 'documents', docId + '.md'));
  assert.deepEqual(fs.readdirSync(path.join(mod.rootDir(), 'images')).sort(), [png, jpg].sort());
  const legacyPng = path.join(dir, 'diagrams-before-whiteboards', 'images', png);
  assert.equal(fs.statSync(path.join(mod.rootDir(), 'images', png)).ino, fs.statSync(legacyPng).ino, 'linked, not copied');
  assert.equal(mod.imagePath(png), path.join(mod.rootDir(), 'images', png));

  // A picture missing from the store is found in the renamed tree.
  fs.unlinkSync(path.join(mod.rootDir(), 'images', jpg));
  const legacyJpg = path.join(dir, 'diagrams-before-whiteboards', 'images', jpg);
  assert.equal(mod.imagePath(jpg), legacyJpg);
  assert.deepEqual(await mod.getImagePath('sbimg://image/' + jpg), { ok: true, data: legacyJpg });
});

test('migration runs once: a second run changes nothing', async () => {
  const { mod, dir } = fresh(rail);
  railDirs(dir);
  legacyBoard(mod, dir, 'sample-1', { name: 'Once' });
  assert.equal((await mod.migrate()).ok, true);
  const store = fs.readFileSync(path.join(mod.rootDir(), 'store.json'), 'utf8');
  const boards = tree(path.join(mod.rootDir(), 'boards'));
  // Even with an old tree back in place, a finished migration does not look at it.
  legacyBoard(mod, dir, 'sample-2', { name: 'Late' });
  const again = await mod.migrate();
  assert.equal(again.ok, true);
  assert.equal(again.data.already, true);
  assert.equal(again.data.boards, 0);
  assert.equal(fs.readFileSync(path.join(mod.rootDir(), 'store.json'), 'utf8'), store);
  assert.deepEqual(tree(path.join(mod.rootDir(), 'boards')), boards);
  assert.ok(fs.existsSync(path.join(dir, 'diagrams')), 'and leaves it where it is');
});

test('a folder whose hash names no known workspace keeps its stem and no workspace', async () => {
  const { mod, dir } = fresh(rail);
  railDirs(dir);
  const odd = legacyBoard(mod, dir, 'demo-0123456789', {
    name: 'Unknown origin',
    spec: { kind: 'flow', nodes: [{ id: 'a', label: 'Answer', ai: true }], edges: [] },
  });
  assert.equal((await mod.migrate()).ok, true);
  const listed = (await mod.list()).data;
  assert.deepEqual(listed.folders.map(f => f.name), ['demo']);
  const got = (await mod.get(odd.id)).data;
  assert.equal(got.workspace, null);
  assert.equal(got.spec.nodes[0].answeredIn, undefined, 'no workspace: no tag');
  assert.equal(listed.lastWorkspace, null);
  const row = JSON.parse(fs.readFileSync(path.join(mod.rootDir(), 'boards', odd.id + '.json'), 'utf8'));
  assert.deepEqual(row.migratedFrom, { legacyKey: 'demo-0123456789', workspace: null });
});

test('a file that cannot be read is counted, left in the old tree, and still noticed', async () => {
  const { mod, dir } = fresh(rail);
  railDirs(dir);
  const key = mod.legacyKeyFor('sample-1');
  legacyFile(dir, path.join(key, crypto.randomUUID() + '.json'), '{ not json');
  legacyFile(dir, path.join(key, 'no-id.json'), JSON.stringify({ name: 'No id', spec: BLANK }));
  legacyFile(dir, 'stray-file.txt', 'not a workspace folder');
  fs.mkdirSync(path.join(dir, 'diagrams', 'not-a-key'), { recursive: true });
  const r = await quietly(() => mod.migrate());
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data, { boards: 0, folders: 0, skipped: 2, legacyRoot: 'diagrams-before-whiteboards' });
  const listed = (await mod.list()).data;
  assert.deepEqual(listed.folders, [], 'a folder only when a board lands in it');
  assert.deepEqual(listed.notice, { boards: 0, folders: 0, dismissed: false });
  assert.deepEqual(listed.migration, {
    error: null,
    skipped: 2,
    legacyRoot: 'diagrams-before-whiteboards',
    legacyLabel: path.join(dir, 'diagrams-before-whiteboards'),
  });
  // Under the home folder it is written the short way, as the bar shows it.
  const home = os.homedir;
  os.homedir = () => dir;
  try {
    assert.equal((await mod.list()).data.migration.legacyLabel, '~/diagrams-before-whiteboards');
  } finally {
    os.homedir = home;
  }
  const kept = tree(path.join(dir, 'diagrams-before-whiteboards'));
  assert.equal(kept.filter(f => f.startsWith(key)).length, 2);
  assert.ok(kept.includes('stray-file.txt'));
});

test('a migration that stops part way is reported, and the next run finishes it without a second copy', async () => {
  const { mod, dir } = fresh(rail);
  railDirs(dir);
  const a = legacyBoard(mod, dir, 'sample-1', { name: 'A', updatedAt: AT(2) });
  const b = legacyBoard(mod, dir, 'sample-2', { name: 'B', updatedAt: AT(3) });
  // boards/ cannot be made: a file is in its way.
  fs.mkdirSync(mod.rootDir(), { recursive: true });
  fs.writeFileSync(path.join(mod.rootDir(), 'boards'), 'in the way');

  const failed = await quietly(() => mod.migrate());
  assert.equal(failed.ok, false);
  assert.match(failed.error, /could not move “A”/);
  let listed = (await mod.list()).data;
  assert.equal(listed.migration.error, failed.error);
  assert.equal(listed.migration.legacyLabel, path.join(dir, 'diagrams'), 'the old tree, still where it was');
  assert.deepEqual(listed.folders.map(f => f.name), ['sample'], 'the folder was recorded before any board');
  const folderId = listed.folders[0].id;
  const store = JSON.parse(fs.readFileSync(path.join(mod.rootDir(), 'store.json'), 'utf8'));
  assert.equal(store.migration.at, null);
  assert.equal(store.migration.folders[mod.legacyKeyFor('sample-1')], folderId);
  assert.ok(fs.existsSync(path.join(dir, 'diagrams')), 'the old tree stays until it is done');
  assert.equal(listed.notice, null);

  // Fixed — and, as if the run had got further before stopping, one board already written.
  fs.unlinkSync(path.join(mod.rootDir(), 'boards'));
  const already = Object.assign({}, a, {
    folderId,
    workspace: 'sample-1',
    migratedFrom: { legacyKey: mod.legacyKeyFor('sample-1'), workspace: 'sample-1' },
  });
  fs.mkdirSync(path.join(mod.rootDir(), 'boards'));
  fs.writeFileSync(path.join(mod.rootDir(), 'boards', a.id + '.json'), JSON.stringify(already));

  const resumed = await mod.migrate();
  assert.equal(resumed.ok, true, resumed.error);
  assert.deepEqual(resumed.data, { boards: 2, folders: 1, skipped: 0, legacyRoot: 'diagrams-before-whiteboards' });
  listed = (await mod.list()).data;
  assert.deepEqual(listed.folders.map(f => [f.id, f.name, f.count]), [[folderId, 'sample', 2]], 'the same folder, once');
  assert.deepEqual(listed.boards.map(x => x.id).sort(), [a.id, b.id].sort());
  assert.equal(listed.migration.error, null);
  assert.deepEqual(listed.notice, { boards: 2, folders: 1, dismissed: false });
  assert.equal(listed.lastWorkspace, 'sample-2');
  assert.equal(fs.existsSync(path.join(dir, 'diagrams')), false);
});

test('a run that renamed the old tree but stopped before recording it is finished on the next', async () => {
  const { mod, dir } = fresh(rail);
  railDirs(dir);
  const a = legacyBoard(mod, dir, 'sample-1', { name: 'A' });
  assert.equal((await mod.migrate()).ok, true);
  // Wind the record back to just before its last write.
  editStore(mod, store => {
    store.migration.at = null;
    store.migration.legacyRoot = null;
    store.notice = null;
  });
  assert.equal((await mod.list()).data.migration.legacyLabel, path.join(dir, 'diagrams-before-whiteboards'),
    'the renamed tree, though nothing has said so yet');
  const finished = await mod.migrate();
  assert.equal(finished.ok, true, finished.error);
  assert.deepEqual(finished.data, { boards: 1, folders: 1, skipped: 0, legacyRoot: 'diagrams-before-whiteboards' });
  const listed = (await mod.list()).data;
  assert.deepEqual(listed.boards.map(x => x.id), [a.id]);
  assert.deepEqual(listed.notice, { boards: 1, folders: 1, dismissed: false });
});

test('the old tree is renamed beside an earlier rename, never over it', async () => {
  const { mod, dir } = fresh(rail);
  railDirs(dir);
  legacyBoard(mod, dir, 'sample-1', { name: 'A' });
  fs.mkdirSync(path.join(dir, 'diagrams-before-whiteboards'));
  fs.writeFileSync(path.join(dir, 'diagrams-before-whiteboards', 'earlier.txt'), 'earlier');
  const r = await mod.migrate();
  assert.equal(r.data.legacyRoot, 'diagrams-before-whiteboards-2');
  assert.equal((await mod.list()).data.migration.legacyLabel, path.join(dir, 'diagrams-before-whiteboards-2'));
  assert.equal(fs.readFileSync(path.join(dir, 'diagrams-before-whiteboards', 'earlier.txt'), 'utf8'), 'earlier');
  assert.ok(fs.existsSync(path.join(dir, 'diagrams-before-whiteboards-2', mod.legacyKeyFor('sample-1'))));
});

test('a migration folder never takes the name of a folder that is already there', async () => {
  const { mod, dir } = fresh(rail);
  railDirs(dir);
  legacyBoard(mod, dir, 'sample-1', { name: 'A' });
  const mine = await folderNamed(mod, 'Sample');
  assert.equal((await mod.migrate()).ok, true);
  const listed = (await mod.list()).data;
  assert.deepEqual(listed.folders.map(f => [f.name, f.moved]), [['Sample', false], ['sample 2', true]]);
  assert.equal(listed.folders.find(f => f.id === mine.id).count, 0);
});

/** One old board in sample-1 whose box opens the document `docId`, which holds `text`. */
function legacyDocument(mod, dir, wsId, docId, text) {
  const board = legacyBoard(mod, dir, wsId, {
    name: 'Brief ' + docId.slice(0, 4),
    spec: { kind: 'flow', nodes: [{ id: 'd', label: 'Brief', shape: 'document', documentId: docId }], edges: [] },
  });
  return { board, file: legacyFile(dir, path.join(mod.legacyKeyFor(wsId), 'documents', docId + '.md'), text) };
}

/**
 * Run `run` in a process that dies part way through copying a file whose source matches
 * `cut`: half its bytes reach the copy's target and the copy never returns — nor does
 * anything after it. Hard links are refused meanwhile, so a picture is copied too.
 * Resolves once the copy has stopped; the run itself is abandoned, as a crash leaves it.
 */
async function crashDuring(cut, run) {
  const { copyFile, link } = fs.promises;
  let died;
  const dead = new Promise(resolve => { died = resolve; });
  fs.promises.link = async () => { throw Object.assign(new Error('fictional: no hard links'), { code: 'EPERM' }); };
  fs.promises.copyFile = async (from, to, mode) => {
    if (!cut.test(from)) return copyFile(from, to, mode);
    const all = fs.readFileSync(from);
    fs.writeFileSync(to, all.subarray(0, all.length >> 1));
    died();
    return new Promise(() => {});
  };
  try {
    run();
    await dead;
  } finally {
    fs.promises.copyFile = copyFile;
    fs.promises.link = link;
  }
}

test('a copy a crash cuts short is never taken for a whole one: the next launch makes it again', async () => {
  const { mod, dir } = fresh(rail);
  railDirs(dir);
  const docId = crypto.randomUUID();
  const text = '# Whole\n' + 'a line of the fictional brief\n'.repeat(200);
  legacyDocument(mod, dir, 'sample-1', docId, text);
  const png = 'c'.repeat(32) + '.png';
  const bytes = 'fictional picture bytes '.repeat(200);
  legacyFile(dir, path.join('images', png), bytes);
  const doc = path.join(mod.rootDir(), 'documents', docId + '.md');
  const picture = path.join(mod.rootDir(), 'images', png);

  // Dies copying the document: nothing half-written is left where it belongs.
  await crashDuring(/\.md$/, () => mod.migrate());
  assert.equal(fs.existsSync(doc), false);

  // Launched again, it dies copying the picture — after bringing the whole document.
  const second = relaunch(dir);
  await crashDuring(/\.png$/, () => second.migrate());
  assert.equal(fs.readFileSync(doc, 'utf8'), text);
  assert.equal(fs.existsSync(picture), false);

  const third = relaunch(dir);
  const r = await third.migrate();
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data, { boards: 1, folders: 1, skipped: 0, legacyRoot: 'diagrams-before-whiteboards' });
  assert.equal(fs.readFileSync(picture, 'utf8'), bytes);
  assert.equal((await third.getDocument(docId)).data.text, text);
});

test('on a disk without hard links, copies still land whole, never over a file that is there', async () => {
  const { mod, dir } = fresh(rail);
  railDirs(dir);
  const fresher = crypto.randomUUID();
  const kept = crypto.randomUUID();
  legacyDocument(mod, dir, 'sample-1', fresher, '# From the old tree\n');
  legacyDocument(mod, dir, 'sample-1', kept, '# Old text\n');
  // Already in the store (an earlier run, then an edit): the old text must not win.
  fs.mkdirSync(path.join(mod.rootDir(), 'documents'), { recursive: true });
  fs.writeFileSync(path.join(mod.rootDir(), 'documents', kept + '.md'), '# Edited since\n');
  const png = 'd'.repeat(32) + '.png';
  legacyFile(dir, path.join('images', png), 'fictional picture');

  const link = fs.promises.link;
  fs.promises.link = async () => { throw Object.assign(new Error('fictional: no hard links'), { code: 'EPERM' }); };
  let r;
  try {
    r = await mod.migrate();
  } finally {
    fs.promises.link = link;
  }
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.skipped, 0);
  assert.equal((await mod.getDocument(fresher)).data.text, '# From the old tree\n');
  assert.equal((await mod.getDocument(kept)).data.text, '# Edited since\n');
  const picture = path.join(mod.rootDir(), 'images', png);
  assert.equal(fs.readFileSync(picture, 'utf8'), 'fictional picture');
  assert.notEqual(fs.statSync(picture).ino, fs.statSync(path.join(dir, 'diagrams-before-whiteboards', 'images', png)).ino);
  for (const sub of ['documents', 'images']) {
    assert.deepEqual(fs.readdirSync(path.join(mod.rootDir(), sub)).filter(n => n.endsWith('.tmp')), [], `no temp file left in ${sub}`);
  }
});

test('a document the migration did not bring is copied in from the old tree when it is first opened', async () => {
  const { mod, dir } = fresh(rail);
  railDirs(dir);
  const early = crypto.randomUUID();
  const left = crypto.randomUUID();
  legacyDocument(mod, dir, 'sample-1', early, '# Opened early\n');
  const { board, file: leftFile } = legacyDocument(mod, dir, 'sample-2', left, '# Left behind\n');
  const store = id => path.join(mod.rootDir(), 'documents', id + '.md');

  // Opened before the migration has run: found in diagrams/ and brought into the store.
  const opened = await mod.getDocument(early);
  assert.equal(opened.ok, true, opened.error);
  assert.deepEqual(opened.data, { id: early, text: '# Opened early\n', revision: opened.data.revision, path: store(early) });
  assert.equal(fs.readFileSync(store(early), 'utf8'), '# Opened early\n');

  // A copy the migration could not make is counted, and the old tree is renamed anyway.
  const copyFile = fs.promises.copyFile;
  fs.promises.copyFile = async (from, to, mode) => {
    if (from === leftFile) throw Object.assign(new Error('fictional: permission denied'), { code: 'EACCES' });
    return copyFile(from, to, mode);
  };
  let r;
  try {
    r = await quietly(() => mod.migrate());
  } finally {
    fs.promises.copyFile = copyFile;
  }
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.skipped, 1);
  assert.equal(fs.existsSync(store(left)), false);
  const renamedLeft = path.join(dir, 'diagrams-before-whiteboards', mod.legacyKeyFor('sample-2'), 'documents', left + '.md');

  // A duplicate made before anyone opens it still gets a document of its own.
  const copy = await mod.duplicate(board.id);
  assert.equal(copy.ok, true, copy.error);
  const copyDoc = copy.data.spec.nodes[0].documentId;
  assert.notEqual(copyDoc, left);
  assert.equal((await mod.getDocument(copyDoc)).data.text, '# Left behind\n');

  // Two boards opening it at once: both read it, and it is copied in once.
  const [one, two] = await Promise.all([mod.getDocument(left), mod.getDocument(left)]);
  assert.equal(one.ok && two.ok, true, one.error || two.error);
  assert.equal(one.data.text, '# Left behind\n');
  assert.equal(two.data.revision, one.data.revision);
  assert.equal(one.data.path, store(left));
  const saved = await mod.saveDocument(left, '# Edited\n', one.data.revision);
  assert.equal(saved.ok, true, saved.error);
  assert.equal((await mod.getDocument(left)).data.text, '# Edited\n');
  assert.equal(fs.readFileSync(renamedLeft, 'utf8'), '# Left behind\n', 'the old tree is never written');

  // Nowhere at all: still not found, and nothing is made.
  const nowhere = crypto.randomUUID();
  assert.deepEqual(await mod.getDocument(nowhere), { ok: false, error: 'Document file not found' });
  assert.equal(fs.existsSync(store(nowhere)), false);
});

test('migration happens only when asked: requiring the module leaves the old tree alone', async () => {
  const base = tempDir('whiteboards-require');
  const key = 'sample-1-' + crypto.createHash('sha1').update('sample-1').digest('hex').slice(0, 10);
  fs.mkdirSync(path.join(base, 'diagrams', key), { recursive: true });
  fs.writeFileSync(path.join(base, 'diagrams', key, crypto.randomUUID() + '.json'), JSON.stringify({ id: crypto.randomUUID(), name: 'Waiting' }));
  const saved = process.env.SWITCHBOARD_CONFIG;
  process.env.SWITCHBOARD_CONFIG = path.join(base, 'config.json');
  const cached = FRESH.map(file => [file, require.cache[file]]);
  for (const file of FRESH) delete require.cache[file];
  try {
    const mod = require('../src/main/whiteboards');
    assert.equal(typeof mod.migrate, 'function');
    assert.deepEqual(fs.readdirSync(base), ['diagrams']);
  } finally {
    for (const [file, entry] of cached) {
      if (entry) require.cache[file] = entry;
      else delete require.cache[file];
    }
    process.env.SWITCHBOARD_CONFIG = saved;
  }
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
