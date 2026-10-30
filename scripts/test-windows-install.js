'use strict';

// Exercise Windows bundle integrity and rollback on every host, using scratch
// files rather than executing a fixture .exe. Native behavior is covered on Windows.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { once } = require('events');
const { execFileSync } = require('child_process');
const desktop = require('../src/main/windows-install.js');
const { Publisher } = require('../src/main/publisher.js');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-windows-test-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const revision = dir => fs.readFileSync(path.join(dir, 'revision'), 'utf8');
function app(name, value) {
  const dir = path.join(temp, name);
  fs.mkdirSync(path.join(dir, 'resources', 'app'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'resources', 'app', 'package.json'), JSON.stringify({ name: 'switchboard' }));
  fs.writeFileSync(path.join(dir, 'Switchboard.exe'), 'fixture');
  fs.writeFileSync(path.join(dir, 'revision'), value);
  desktop.writeManifest(dir);
  return dir;
}
const next = app('next', 'new');

test('Windows prepare preserves the running app, commit replaces it, and rollback permits retry', t => {
  const target = app('target', 'old');
  const plan = desktop.prepare(next, target);
  assert.equal(revision(target), 'old');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === path.join(plan.staging, 'Switchboard')) throw new Error('simulated locked file');
    rename(from, to);
  });
  assert.throws(() => desktop.commit(plan), /locked file/);
  assert.equal(revision(target), 'old');
  t.mock.restoreAll();
  desktop.commit(plan);
  assert.equal(revision(target), 'new');
  assert.equal(fs.existsSync(plan.staging), false);
});

test('Windows rejects tampered bundles and manifests, unexpected files and unrelated targets', () => {
  const target = app('tamper-target', 'old');
  for (const change of [
    dir => fs.writeFileSync(path.join(dir, 'revision'), 'tampered'),
    dir => fs.writeFileSync(path.join(dir, 'unexpected.dll'), 'extra'),
    dir => { fs.writeFileSync(path.join(dir, 'revision'), 'tampered'); desktop.writeManifest(dir); },
  ]) {
    const plan = desktop.prepare(next, target);
    change(path.join(plan.staging, 'Switchboard'));
    assert.throws(() => desktop.commit(plan), /changed|incomplete/);
    assert.equal(revision(target), 'old');
    desktop.discard(plan);
  }
  const unrelated = path.join(temp, 'unrelated');
  fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(unrelated, 'keep'), 'keep');
  const plan = desktop.prepare(next, unrelated);
  assert.throws(() => desktop.commit(plan), /installed app has changed/);
  assert.equal(fs.readFileSync(path.join(unrelated, 'keep'), 'utf8'), 'keep');
  desktop.discard(plan);
  assert.throws(() => desktop.discard({ ...plan, staging: temp }), /invalid/);
});

test('the detached Windows updater waits for exit before replacing the app', async t => {
  const target = app('delayed-target', 'old');
  const plan = desktop.prepare(next, target);
  const receipt = path.join(plan.staging, 'update.json');
  fs.writeFileSync(receipt, JSON.stringify(plan));
  const log = path.join(temp, 'helper.log');
  const parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => parent.kill());
  await once(parent, 'spawn');
  const child = spawn(process.execPath, [require.resolve('../src/main/windows-install.js'), receipt, String(parent.pid), log], { stdio: 'pipe' });
  t.after(() => child.kill());
  const finished = once(child, 'exit');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(revision(target), 'old');
  const parentExited = once(parent, 'exit');
  parent.kill();
  await parentExited;
  assert.equal((await finished)[0], 0);
  assert.equal(revision(target), 'new');
  assert.match(fs.readFileSync(log, 'utf8'), /update installed/);
});

test('Windows Publish uses npm safely for checkout paths with spaces and shell characters',
  { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
    const source = path.join(temp, "source with spaces & 'quotes'");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'switchboard', scripts: { 'install:desktop': 'node fixture.js' } }));
    fs.writeFileSync(path.join(source, 'fixture.js'), `
      const fs = require('fs');
      const desktop = require(${JSON.stringify(require.resolve('../src/main/windows-install.js'))});
      const args = process.argv.slice(2);
      const plan = desktop.prepare(${JSON.stringify(next)}, args[args.indexOf('--target') + 1]);
      fs.writeFileSync(args[args.indexOf('--stage') + 1], JSON.stringify(plan));
    `);
    const target = app('publisher target & spaces', 'old');
    const publisher = new Publisher({ target, logFile: path.join(temp, 'publish.log') });
    const ws = { id: 'switchboard', self: true, dir: source };
    assert.equal((await publisher.publish({ ...ws, self: false })).ok, false);
    const first = publisher.publish(ws);
    assert.equal(first, publisher.publish(ws));
    const result = await first;
    assert.equal(result.ok, true, result.error);
    assert.equal(revision(target), 'old');
    assert.equal(publisher.hasPending(), true);
    // Actual helper scheduling is exercised by the standalone updater test;
    // this process is the test runner, so it must stay alive here.
    desktop.commit(publisher.pending);
    publisher.pending = null;
    assert.equal(revision(target), 'new');
  });

test('Windows Publish hands its pending update to a helper on quit',
  { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
    const target = app('quit target', 'old');
    const plan = desktop.prepare(next, target);
    const script = path.join(temp, 'quit.js');
    const log = path.join(temp, 'quit.log');
    fs.writeFileSync(script, `
      const { Publisher } = require(${JSON.stringify(require.resolve('../src/main/publisher.js'))});
      const publisher = new Publisher({ target: ${JSON.stringify(target)}, logFile: ${JSON.stringify(log)} });
      publisher.pending = ${JSON.stringify(plan)};
      publisher.applyOnQuit().then(result => process.exit(result.ok ? 0 : 1));
    `);
    execFileSync(process.execPath, [script], { timeout: 10000 });
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(target) && revision(target) === 'new') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(revision(target), 'new', fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : 'Updater did not finish');
  });

test('Windows Publish preserves a failed update and reports its error before quitting',
  { skip: process.platform !== 'win32' }, async () => {
    const target = app('failed quit target', 'old');
    const plan = desktop.prepare(next, target);
    const publisher = new Publisher({ target, logFile: path.join(temp, 'failed-quit.log') });
    publisher.pending = plan;
    fs.writeFileSync(path.join(plan.staging, 'Switchboard', 'revision'), 'tampered');
    const result = await publisher.applyOnQuit();
    assert.equal(result.ok, false);
    assert.equal(publisher.state().status, 'error');
    assert.equal(publisher.hasPending(), true);
    assert.equal(revision(target), 'old');
    desktop.discard(plan);
  });
