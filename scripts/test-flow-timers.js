'use strict';

// Timer state crosses a save, an unloaded board and a later launch. These tests
// exercise the public spec/layout boundary and deadline arithmetic without a clock.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const esbuild = require('esbuild');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-flow-timers-'));
function load(name) {
  const outfile = path.join(temp, name + '.js');
  esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src/diagrams/lib/diagrams', name + '.ts')], outfile,
    bundle: true, format: 'cjs', platform: 'node', logLevel: 'error' });
  return require(outfile);
}
const timers = load('timers');
const { parseDiagramSpec } = load('validate');
const { layoutDiagram, flowNodeSize } = load('layout');
const { flowSpecFromCanvas } = load('flow-editor');
const { flowQuestionPath } = load('ai');
const { inspectFlowCondenseSelection } = load('condense');
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const flow = (nodes) => ({ kind: 'flow', nodes, edges: [] });
const card = (timer, extra = {}) => ({ id: 'focus', shape: 'timer', label: 'Focus session', timer, ...extra });
const value = (spec) => {
  const result = parseDiagramSpec(spec);
  assert.equal(result.ok, true, result.error);
  return result.value;
};

test('a timer defaults to 25 minutes with sound, an editable label and a resizable card', () => {
  const spec = value(flow([{ id: 'focus', shape: 'timer' }]));
  assert.equal(spec.nodes[0].label, 'Timer');
  assert.deepEqual(spec.nodes[0].timer, { durationMs: 1500000, remainingMs: 1500000, status: 'idle', sound: true });
  assert.deepEqual(flowNodeSize(spec.nodes[0]), { width: 300, height: 260 });
  assert.deepEqual(flowNodeSize({ ...spec.nodes[0], size: { width: 320, height: 290 } }), { width: 320, height: 290 });
  assert.deepEqual(flowNodeSize({ ...spec.nodes[0], size: { width: 16, height: 16 } }), { width: 260, height: 240 });
});

test('saving and reopening preserves a running deadline, remaining state, sound and size', () => {
  const timer = timers.startFlowTimer(timers.createFlowTimer(60000, false), 100000);
  const spec = value(flow([card(timer, { size: { width: 350, height: 280 }, position: { x: 80, y: 120 } })]));
  const layout = layoutDiagram(spec);
  assert.deepEqual(layout.nodes[0].data.timer, timer);
  const saved = flowSpecFromCanvas({}, layout.nodes, layout.edges);
  const reopened = value(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(reopened.nodes[0].timer, timer);
  assert.deepEqual(reopened.nodes[0].size, { width: 350, height: 280 });
  assert.deepEqual(reopened.nodes[0].position, { x: 80, y: 120 });
  assert.equal(timers.flowTimerRemaining(reopened.nodes[0].timer, 135000), 25000);
});

test('deadline arithmetic survives unmounts and sleep; pause and resume preserve remaining time', () => {
  const idle = timers.createFlowTimer(60000);
  const running = timers.startFlowTimer(idle, 100000);
  assert.equal(timers.flowTimerRemaining(running, 110001), 49999);
  assert.equal(timers.flowTimerStatus(running, 159999), 'running');
  assert.equal(timers.flowTimerRemaining(running, 500000), 0);
  assert.equal(timers.flowTimerStatus(running, 500000), 'finished');
  const paused = timers.pauseFlowTimer(running, 115000);
  assert.deepEqual(paused, { durationMs: 60000, remainingMs: 45000, status: 'paused', sound: true });
  assert.equal(timers.flowTimerRemaining(paused, 900000), 45000);
  const resumed = timers.startFlowTimer(paused, 900000);
  assert.equal(resumed.endsAt, 945000);
  assert.equal(timers.pauseFlowTimer(resumed, 950000).status, 'finished');
  assert.equal(timers.pauseFlowTimer(resumed, 950000).remainingMs, 0);
  assert.equal(timers.pauseFlowTimer(resumed, 950000).endsAt, 945000);
  const expiredPaused = timers.pauseFlowTimer(resumed, 950000);
  assert.deepEqual(value(flow([card(expiredPaused)])).nodes[0].timer, expiredPaused, 'an expired pause keeps the alarm identity across a save');
  assert.deepEqual(idle, timers.createFlowTimer(60000), 'transitions leave undo snapshots unchanged');
  assert.equal(running.endsAt, 160000);
});

test('reset, dismissal and duplication get a fresh idle duration without an active deadline', () => {
  const running = timers.startFlowTimer(timers.createFlowTimer(120000, false), 100000);
  for (const timer of [running, timers.pauseFlowTimer(running, 120000), { ...running, status: 'finished', remainingMs: 0 }]) {
    assert.deepEqual(timers.resetFlowTimer(timer), { durationMs: 120000, remainingMs: 120000, status: 'idle', sound: false });
  }
  assert.deepEqual(timers.setFlowTimerDuration(running, 5000), { durationMs: 5000, remainingMs: 5000, status: 'idle', sound: false });
  assert.equal(timers.startFlowTimer({ ...running, status: 'finished', remainingMs: 0 }, 400000).endsAt, 520000);
});

test('invalid persisted timer fields cannot enter the canvas, and unrelated nodes shed timer state', () => {
  const valid = timers.createFlowTimer();
  const invalid = [null, [], {}, { ...valid, durationMs: 999 }, { ...valid, durationMs: 86400001 },
    { ...valid, durationMs: Infinity }, { ...valid, remainingMs: -1 }, { ...valid, remainingMs: 1500001 },
    { ...valid, remainingMs: 12.5 }, { ...valid, sound: 'true' }, { ...valid, status: 'unknown' },
    { ...valid, status: 'running' }, { ...valid, status: 'running', endsAt: 0 },
    { ...valid, status: 'running', endsAt: Infinity }, { ...valid, status: 'running', endsAt: 100.5 }];
  invalid.push({ ...valid, status: 'finished', endsAt: -1 });
  for (const timer of invalid) {
    const parsed = parseDiagramSpec(flow([card(timer)]));
    assert.equal(parsed.ok, false, JSON.stringify(timer));
    assert.match(parsed.error, /Node 1:/);
  }
  assert.equal(value(flow([{ id: 'plain', label: 'Plain box', timer: valid }])).nodes[0].timer, undefined);
  assert.equal(timers.parseFlowTimer({ ...valid, endsAt: 100000 }).endsAt, undefined);
});

test('duration entry accepts minutes and clock forms, within 1 second and 24 hours', () => {
  for (const [text, expected] of [['25', 1500000], [' 5 ', 300000], ['0.5', 30000], ['0:01', 1000],
    ['25:00', 1500000], ['1:02:03', 3723000], ['24:00:00', 86400000]]) {
    assert.equal(timers.parseFlowTimerDuration(text), expected, text);
  }
  for (const text of ['', '0', '0:00', '-5', 'tomorrow', '1:60', '1:2', '24:00:01', '1441', '1:00:00:00']) {
    assert.equal(timers.parseFlowTimerDuration(text), null, text);
  }
  for (const [ms, display] of [[0, '00:00'], [1, '00:01'], [1001, '00:02'], [60000, '01:00'], [3723000, '1:02:03']]) {
    assert.equal(timers.formatFlowTimer(ms), display);
  }
});

test('timers cannot be condensed or sent as question context', () => {
  const spec = value(flow([card(timers.createFlowTimer()), { id: 'question', label: 'Explain this' }]));
  assert.throws(() => inspectFlowCondenseSelection(spec, ['focus', 'question']), /Leave timers out/);
  const nodes = layoutDiagram(spec).nodes;
  assert.deepEqual(flowQuestionPath(nodes, [{ source: 'focus', target: 'question', targetHandle: 'left' }], 'question'), []);
});
