'use strict';

// npm run test:diagrams — scripts/whiteboard.js, the CLI a Claude Code skill draws
// whiteboards with, run as a child process against a temporary SWITCHBOARD_CONFIG; and
// src/main/whiteboards.js watch(), which tells the app of a board the CLI wrote and
// says nothing of the app's own writes. Every board, folder and workspace is fictional.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, after } = require('node:test');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-whiteboard-cli-'));
const configFile = path.join(temp, 'config.json');
fs.mkdirSync(path.join(temp, 'example-workspace'));
fs.writeFileSync(configFile, JSON.stringify({ workspaces: { 'example-workspace': { dir: path.join(temp, 'example-workspace') } } }));
// The store module reads SWITCHBOARD_CONFIG as it is required, so it goes first.
process.env.SWITCHBOARD_CONFIG = configFile;
const whiteboards = require('../src/main/whiteboards');
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const cli = path.join(__dirname, 'whiteboard.js');
function run(args, { input, cwd = temp } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd, input, encoding: 'utf8', env: { ...process.env, SWITCHBOARD_CONFIG: configFile },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}
const json = value => JSON.stringify(value);
const boardFile = id => JSON.parse(fs.readFileSync(path.join(temp, 'whiteboards', 'boards', id + '.json'), 'utf8'));

const FLOW = {
  kind: 'flow',
  title: 'Checkout',
  nodes: [
    { id: 'start', label: 'Customer taps Pay', shape: 'pill', tone: 'muted' },
    { id: 'charge', label: 'Charge the card', detail: 'Example payments API' },
    { id: 'ok', label: 'Authorised?', shape: 'diamond', tone: 'accent' },
    { id: 'done', label: 'Confirm the order', tone: 'success' },
    { id: 'fail', label: 'Show the decline', tone: 'danger' },
  ],
  edges: [
    { from: 'start', to: 'charge' },
    { from: 'charge', to: 'ok' },
    { from: 'ok', to: 'done', label: 'yes' },
    { from: 'ok', to: 'fail', label: 'no' },
  ],
};

let boardId;

test('check validates and lays a spec out without writing anything', () => {
  const ok = run(['check', '-'], { input: json(FLOW) });
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /^Valid: 5 nodes, 4 arrows, laid out \d+×\d+\./);
  const bad = run(['check', '-'], { input: json({ kind: 'flow', nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'b' }] }) });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /Edge 1: "to" is "b", which is not one of the node ids/);
  const notJson = run(['check', '-'], { input: '{ nope' });
  assert.match(notJson.err, /not valid JSON/);
  assert.equal(fs.existsSync(path.join(temp, 'whiteboards', 'boards')), false);
});

test('create makes a board in a folder it makes, reading the workspace it is run in', () => {
  const made = run(['create', '-', '--name', 'Checkout flow', '--folder', 'Example folder'], {
    input: json(FLOW), cwd: path.join(temp, 'example-workspace'),
  });
  assert.equal(made.code, 0, made.err);
  assert.match(made.out, /Created "Checkout flow" in the new folder Example folder: 5 nodes, 4 arrows, reading example-workspace\./);
  boardId = /id ([0-9a-f-]{36})/.exec(made.out)[1];
  const row = boardFile(boardId);
  assert.equal(row.workspace, 'example-workspace');
  assert.deepEqual(row.spec.nodes.map(n => n.id), ['start', 'charge', 'ok', 'done', 'fail']);
  // A second board of the same name in the same folder is refused, as in the app.
  const again = run(['create', '-', '--name', 'Checkout flow', '--folder', 'example folder'], { input: json(FLOW) });
  assert.equal(again.code, 1);
  assert.match(again.err, /Could not create the whiteboard/);
  assert.equal(run(['create', '-'], { input: json(FLOW) }).code, 1, 'no --name');
});

test('list and show find a board by id or by name, and --here by workspace', () => {
  const listed = JSON.parse(run(['list', '--json']).out);
  assert.deepEqual(listed.map(b => [b.name, b.folder, b.workspace, b.boxes]), [['Checkout flow', 'Example folder', 'example-workspace', 5]]);
  assert.equal(JSON.parse(run(['list', '--here', '--json'], { cwd: path.join(temp, 'example-workspace') }).out).length, 1);
  assert.match(run(['list', '--here']).err, /none of the rail's workspaces/);
  for (const ref of [boardId, 'checkout flow', 'CHECKOUT']) {
    const shown = JSON.parse(run(['show', ref]).out);
    assert.equal(shown.id, boardId, ref);
    assert.equal(shown.folder, 'Example folder');
    assert.equal(shown.spec.nodes.length, 5);
  }
  assert.match(run(['show', 'nothing like it']).err, /No whiteboard is called "nothing like it"/);
  assert.match(run(['folders']).out, /Example folder {2}· {2}1 board/);
});

test('update keeps how the board was arranged, and adds what is new', () => {
  // As the editor leaves a board someone arranged: every box placed, one resized.
  const arranged = boardFile(boardId);
  arranged.spec.nodes = arranged.spec.nodes.map((node, i) => ({ ...node, position: { x: 40, y: 40 + i * 120 } }));
  arranged.spec.nodes[1].size = { width: 320, height: 80 };
  fs.writeFileSync(path.join(temp, 'whiteboards', 'boards', boardId + '.json'), JSON.stringify(arranged));

  // A spec written without positions — the boxes it keeps come back where they were.
  const next = { ...FLOW, nodes: [...FLOW.nodes, { id: 'receipt', label: 'Email the receipt' }], edges: [...FLOW.edges, { from: 'done', to: 'receipt', dashed: true }] };
  next.nodes[1] = { ...next.nodes[1], label: 'Charge the card once' };
  const updated = run(['update', 'Checkout flow', '-'], { input: json(next) });
  assert.equal(updated.code, 0, updated.err);
  assert.match(updated.out, /Updated "Checkout flow": 1 added, 1 changed, 0 removed — 6 nodes, 5 arrows now\./);
  const nodes = boardFile(boardId).spec.nodes;
  assert.deepEqual(nodes.slice(0, 5).map(n => n.position), [0, 1, 2, 3, 4].map(i => ({ x: 40, y: 40 + i * 120 })));
  assert.deepEqual(nodes[1].size, { width: 320, height: 80 });
  assert.equal(nodes[1].label, 'Charge the card once');
  assert.equal(nodes[5].id, 'receipt');
  assert.equal(nodes[5].position, undefined, 'a new box is left for the layout to place');

  // `show`'s whole output goes straight back in.
  const shown = JSON.parse(run(['show', boardId]).out);
  shown.spec.nodes[0].label = 'Customer taps Pay now';
  assert.equal(run(['update', boardId, '-'], { input: json(shown) }).code, 0);
  assert.equal(boardFile(boardId).spec.nodes[0].label, 'Customer taps Pay now');
  assert.equal(boardFile(boardId).name, 'Checkout flow', 'update never renames');
});

test('update refuses to drop nodes unless told to, and never writes an invalid spec', () => {
  const before = fs.readFileSync(path.join(temp, 'whiteboards', 'boards', boardId + '.json'), 'utf8');
  const partial = { kind: 'flow', nodes: [{ id: 'start', label: 'Only this' }], edges: [] };
  const refused = run(['update', boardId, '-'], { input: json(partial) });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /would remove 5 of "Checkout flow"'s nodes: charge \("Charge the card once"\), ok/);
  const invalid = run(['update', boardId, '-'], { input: json({ ...FLOW, edges: [{ from: 'start', to: 'nowhere' }] }) });
  assert.match(invalid.err, /not one of the node ids/);
  assert.equal(fs.readFileSync(path.join(temp, 'whiteboards', 'boards', boardId + '.json'), 'utf8'), before);

  const dry = run(['update', boardId, '-', '--allow-removals', '--dry-run'], { input: json(partial) });
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /Would update "Checkout flow": 0 added, 1 changed, 5 removed — 1 node, 0 arrows\. Nothing written\./);
  assert.equal(fs.readFileSync(path.join(temp, 'whiteboards', 'boards', boardId + '.json'), 'utf8'), before);

  const allowed = run(['update', boardId, '-', '--allow-removals'], { input: json(partial) });
  assert.equal(allowed.code, 0, allowed.err);
  assert.match(allowed.out, /0 added, 1 changed, 5 removed/);
  assert.deepEqual(boardFile(boardId).spec.nodes.map(n => n.id), ['start']);
});

test('new-document stores Markdown a document box can show', async () => {
  const made = run(['new-document', '-'], { input: '# Example brief\n\nWhy the card is charged first.\n' });
  assert.equal(made.code, 0, made.err);
  const id = /Document ([0-9a-f-]{36})/.exec(made.out)[1];
  assert.match(made.out, /"shape": "document", "documentId": "[0-9a-f-]{36}", "label": "Example brief"/);
  const doc = await whiteboards.getDocument(id);
  assert.equal(doc.ok, true);
  assert.equal(doc.data.text, '# Example brief\n\nWhy the card is charged first.\n');
});

test('watch() tells of a board another process wrote, and not of its own writes', async () => {
  const seen = [];
  const off = whiteboards.onChange(change => seen.push(change));
  const stop = whiteboards.watch();
  try {
    const waitFor = async (what, ok) => {
      for (let i = 0; i < 100 && !ok(); i++) await new Promise(resolve => setTimeout(resolve, 30));
      assert.ok(ok(), what + ': ' + JSON.stringify(seen));
    };
    // This process's own save: told once, as it is made, and never again by the watcher.
    const own = await whiteboards.saveSpec(boardId, { kind: 'flow', nodes: [{ id: 'start', label: 'Saved by the app' }], edges: [] });
    assert.equal(own.ok, true);
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.deepEqual(seen.map(c => [c.reason, !!c.external]), [['save', false]]);

    // The CLI's: told as external, with the board and its folder.
    seen.length = 0;
    const done = run(['update', boardId, '-'], { input: json({ kind: 'flow', nodes: [{ id: 'start', label: 'Written by the CLI' }], edges: [] }) });
    assert.equal(done.code, 0, done.err);
    await waitFor('an external save', () => seen.some(c => c.external && c.reason === 'save' && c.boardId === boardId));
    const told = seen.find(c => c.external);
    assert.equal(told.folderId, (await whiteboards.get(boardId)).data.folderId);
    // Told once, however many steps the write took.
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(seen.filter(c => c.external && c.reason === 'save').length, 1);

    // A folder the CLI makes changes store.json: told as a folder change.
    seen.length = 0;
    assert.equal(run(['create', '-', '--name', 'Another', '--folder', 'Second example folder', '--workspace', 'none'], { input: json(FLOW) }).code, 0);
    await waitFor('a folder change', () => seen.some(c => c.external && c.reason === 'folder'));
    assert.equal(whiteboards.watch(), stop, 'a second call hands back the first');
  } finally {
    stop();
    off();
  }
});
