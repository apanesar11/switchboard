'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createTimerService, createTimerAlerts } = require('../src/main/timers');

function board(id = 'board-a', nodes = [node()]) {
  return { id, name: 'Example board', archivedAt: null, spec: { kind: 'flow', nodes, edges: [] } };
}
function node(id = 'timer-a', endsAt = 2000, extra = {}) {
  return { id, label: 'Focus', shape: 'timer', timer: {
    durationMs: 1000, remainingMs: 1000, status: 'running', endsAt, sound: true, ...extra,
  } };
}
function fixture(t, options = {}) {
  const directory = options.directory || fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-timers-'));
  if (!options.directory) t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const rows = new Map((options.boards || [board()]).map(row => [row.id, row]));
  const listeners = new Set();
  let at = options.now ?? 1000;
  let pending = null;
  const elapsed = [], changed = [], errors = [];
  const service = createTimerService({
    store: {
      list: async () => ({ ok: true, data: { boards: Array.from(rows.values()).map(row => ({ id: row.id })) } }),
      get: async id => rows.has(id) ? { ok: true, data: structuredClone(rows.get(id)) } : { ok: false },
      onChange: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    }, directory, now: () => at,
    setTimer: (callback, delay) => { pending = { callback, delay }; return pending; },
    clearTimer: timer => { if (pending === timer) pending = null; },
    onElapsed: item => elapsed.push(item), onChanged: items => changed.push(items), log: error => errors.push(error),
  });
  t.after(() => service.stop());
  return { service, rows, elapsed, changed, errors, directory,
    get pending() { return pending; },
    setTime: value => { at = value; },
    change: async id => { for (const listener of listeners) listener({ boardId: id }); await service.settle(); },
    tick: async value => { at = value; if (pending) pending.callback(); await service.settle(); },
  };
}

test('a saved deadline runs without any mounted canvas, then rings exactly once', async t => {
  const f = fixture(t);
  await f.service.start();
  assert.equal(f.pending.delay, 1000);
  assert.deepEqual(f.service.list(), [{ boardId: 'board-a', nodeId: 'timer-a', boardName: 'Example board',
    label: 'Focus', endsAt: 2000, sound: true, status: 'running' }]);
  await f.tick(2000);
  assert.equal(f.elapsed.length, 1);
  assert.equal(f.elapsed[0].status, 'finished');
  await f.service.check();
  await f.service.refresh();
  assert.equal(f.elapsed.length, 1);
  assert.equal(f.service.list()[0].status, 'finished');
  assert.equal(f.rows.get('board-a').spec.nodes[0].timer.status, 'running', 'ticks do not rewrite the board');
  assert.equal(f.errors.length, 0);
});

test('completion is durable across a process restart, while a new run can ring', async t => {
  const f = fixture(t, { now: 3000 });
  await f.service.start();
  assert.equal(f.elapsed.length, 1, 'a timer saved after its deadline still rings');
  f.service.stop();
  const next = fixture(t, { directory: f.directory, now: 3000 });
  await next.service.start();
  assert.equal(next.elapsed.length, 0, 'the same completion is not replayed on launch');
  next.rows.get('board-a').spec.nodes[0] = node('timer-a', 4000);
  await next.change('board-a');
  await next.tick(4000);
  assert.equal(next.elapsed.length, 1);
});

test('pause, reset, node removal, board deletion and archive cancel pending alarms', async t => {
  for (const action of ['paused', 'idle', 'remove-node', 'delete', 'archive']) {
    const f = fixture(t);
    await f.service.start();
    const row = f.rows.get('board-a');
    if (action === 'paused' || action === 'idle') row.spec.nodes[0].timer.status = action;
    else if (action === 'remove-node') row.spec.nodes = [];
    else if (action === 'delete') f.rows.delete('board-a');
    else row.archivedAt = new Date().toISOString();
    await f.change('board-a');
    f.setTime(3000);
    await f.service.check();
    assert.deepEqual(f.service.list(), [], action);
    assert.deepEqual(f.elapsed, [], action);
    assert.equal(f.pending, null, action);
  }
});

test('independent timers, silence and resume after sleep retain their own deadlines', async t => {
  const f = fixture(t, { boards: [board('board-a', [node(), node('timer-b', 3000, { sound: false })]),
    board('board-b', [node()])] });
  await f.service.start();
  f.setTime(10000);
  await f.service.check();
  assert.equal(f.elapsed.length, 3);
  assert.equal(f.elapsed.filter(item => !item.sound).length, 1);
  assert.deepEqual(f.service.list().map(item => item.status), ['finished', 'finished', 'finished']);
  await f.service.check();
  assert.equal(f.elapsed.length, 3);
});

test('external edits, new boards and renamed labels are picked up by store changes', async t => {
  const f = fixture(t, { boards: [] });
  await f.service.start();
  assert.deepEqual(f.service.list(), []);
  f.rows.set('board-a', board());
  await f.change('board-a');
  f.rows.get('board-a').name = 'Planning';
  f.rows.get('board-a').spec.nodes[0].label = 'Break';
  await f.change('board-a');
  await f.tick(2000);
  assert.equal(f.elapsed[0].boardName, 'Planning');
  assert.equal(f.elapsed[0].label, 'Break');
});

test('invalid or inactive timer entries never schedule an alarm', async t => {
  const f = fixture(t, { boards: [board('board-a', [node('a', NaN), node('b', -1), node('c', 1.5),
    node('d', 2000, { status: 'paused' }), { id: 'box', shape: 'box', timer: node().timer }])] });
  await f.service.start();
  assert.deepEqual(f.service.list(), []);
  assert.equal(f.pending, null);
});

test('an explicit finished state retains its run identity and stays discoverable until dismissed', async t => {
  const f = fixture(t, { now: 3000, boards: [board('board-a', [node('timer-a', 2000, { status: 'finished' })])] });
  await f.service.start();
  assert.equal(f.elapsed.length, 1, 'a just-expired timer paused before the scheduler observes it still rings');
  f.rows.get('board-a').spec.nodes[0].timer.status = 'finished';
  await f.change('board-a');
  assert.equal(f.service.list()[0].status, 'finished');
  assert.equal(f.elapsed.length, 1, 'materializing completion is not a second alarm');
  f.rows.get('board-a').spec.nodes.push(node('imported', undefined, { status: 'finished', endsAt: undefined }));
  await f.change('board-a');
  assert.equal(f.service.list().length, 2);
  assert.equal(f.elapsed.length, 1, 'an imported finished timer has no alarm to replay');
  f.rows.get('board-a').spec.nodes[0].timer.status = 'idle';
  await f.change('board-a');
  assert.deepEqual(f.service.list().map(item => item.nodeId), ['imported']);
});

test('long timers check the wall clock periodically and stop releases scheduling', async t => {
  const f = fixture(t, { boards: [board('board-a', [node('timer-a', 1000000)])] });
  await f.service.start();
  assert.equal(f.pending.delay, 60000);
  f.service.stop();
  assert.equal(f.pending, null);
  f.setTime(2000000);
  await f.service.check();
  assert.equal(f.elapsed.length, 0);
});

test('the system chime respects sound toggle; background notifications navigate to the timer', () => {
  const shown = [], chimes = [], elapsed = [], navigation = [];
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; }
    show() { shown.push(this); }
  }
  let focused = false;
  const notify = createTimerAlerts({ shell: { beep: () => chimes.push('beep') }, Notification,
    getWindow: () => ({ isDestroyed: () => false, isFocused: () => focused, isVisible: () => true }),
    onElapsed: item => elapsed.push(item), onNavigate: item => navigation.push(item) });
  const item = { boardId: 'board-a', nodeId: 'timer-a', label: 'Focus', boardName: 'Example board', sound: true };
  notify(item);
  assert.equal(chimes.length, 1);
  assert.equal(elapsed.length, 1);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].options.silent, true, 'the notification never plays a second alarm');
  shown[0].emit('click');
  assert.deepEqual(navigation, [{ boardId: 'board-a', nodeId: 'timer-a' }]);
  notify({ ...item, sound: false });
  assert.equal(chimes.length, 1);
  assert.equal(shown.length, 2, 'a muted timer still has a visual alert');
  focused = true;
  notify(item);
  assert.equal(chimes.length, 2);
  assert.equal(shown.length, 2, 'foreground completion is shown on the canvas');
});

test('a missing window or unsupported notifications never prevent the system chime', () => {
  let chimes = 0;
  const notify = createTimerAlerts({ shell: { beep: () => { chimes++; } },
    Notification: { isSupported: () => false }, getWindow: () => null,
    onElapsed: () => { throw new Error('renderer closed'); }, onNavigate: () => {}, log: () => {} });
  notify({ sound: true });
  assert.equal(chimes, 1);
});

test('real board duplication resets timers and the local alert ledger survives service restart', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-timer-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, 'config.json');
  fs.writeFileSync(configFile, '{}\n');
  // The store resolves its root when required. A separate process gives it a wholly
  // fictional config without changing the environment of other tests in this file.
  const source = `
    const assert = require('node:assert/strict');
    const store = require('./src/main/whiteboards');
    const { createTimerService } = require('./src/main/timers');
    (async () => {
      const timer = { durationMs: 1000, remainingMs: 1000, status: 'running', endsAt: 2000, sound: false };
      const result = await store.create({ name: 'Example board', workspace: null,
        spec: { kind: 'flow', nodes: [{ id: 'focus', shape: 'timer', label: 'Focus', timer }], edges: [] } });
      assert.equal(result.ok, true, result.error);
      const elapsed = [];
      let at = 3000;
      const options = { store, directory: store.rootDir(), now: () => at,
        onElapsed: item => elapsed.push(item), setTimer: () => 1, clearTimer: () => {} };
      const first = createTimerService(options);
      await first.start();
      assert.equal(elapsed.length, 1);
      const copy = await store.duplicate(result.data.id);
      assert.equal(copy.ok, true, copy.error);
      assert.deepEqual(copy.data.spec.nodes[0].timer,
        { durationMs: 1000, remainingMs: 1000, status: 'idle', sound: false });
      assert.deepEqual((await store.get(result.data.id)).data.spec.nodes[0].timer, timer);
      await first.settle();
      assert.equal(first.list().length, 1, 'the copy has no active alarm');
      first.stop();
      const second = createTimerService(options);
      await second.start();
      assert.equal(elapsed.length, 1, 'the old completion is not replayed');
      copy.data.spec.nodes[0].timer = { ...timer, endsAt: 4000 };
      assert.equal((await store.saveSpec(copy.data.id, copy.data.spec)).ok, true);
      await second.settle();
      assert.equal(second.list().length, 2);
      at = 5000;
      await second.check();
      assert.equal(elapsed.length, 2, 'starting the copy creates an independent alarm');
      assert.equal(elapsed[1].boardId, copy.data.id);
      second.stop();
      await store.settle();
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  execFileSync(process.execPath, ['-e', source], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, SWITCHBOARD_CONFIG: configFile }, encoding: 'utf8', timeout: 10000 });
});
