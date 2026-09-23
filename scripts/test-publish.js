'use strict';

// Real signed fixture apps in a temporary directory: exercise replacement,
// rollback and the asynchronous publisher without touching the installed app.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const desktop = require('../src/main/desktop-install.js');
const { Publisher } = require('../src/main/publisher.js');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-publish-test-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

function app(name, revision) {
  const bundle = path.join(temp, name + '.app');
  fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(bundle, 'Contents', 'Resources'));
  fs.copyFileSync('/usr/bin/true', path.join(bundle, 'Contents', 'MacOS', 'Switchboard'));
  fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
    <key>CFBundleIdentifier</key><string>local.switchboard.app</string>
    <key>CFBundleExecutable</key><string>Switchboard</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    </dict></plist>`);
  fs.writeFileSync(path.join(bundle, 'Contents', 'Resources', 'revision'), revision);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', bundle], { stdio: 'pipe' });
  return bundle;
}
const revision = bundle => fs.readFileSync(path.join(bundle, 'Contents', 'Resources', 'revision'), 'utf8');
const next = app('next', 'new');

test('prepare leaves the running bundle intact; commit swaps the complete app', () => {
  const target = app('prepare-target', 'old');
  const plan = desktop.prepare(next, target);
  assert.equal(revision(target), 'old');
  desktop.commit(plan);
  assert.equal(revision(target), 'new');
  assert.equal(fs.existsSync(plan.staging), false);
});

test('a failed final rename restores the old app and allows a retry', t => {
  const target = app('rollback-target', 'old');
  const plan = desktop.prepare(next, target);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === path.join(plan.staging, 'Switchboard.app')) throw new Error('simulated failed swap');
    return rename(from, to);
  });
  assert.throws(() => desktop.commit(plan), /simulated failed swap/);
  assert.equal(revision(target), 'old');
  t.mock.restoreAll();
  desktop.commit(plan);
  assert.equal(revision(target), 'new');
});

test('tampered staged app and unrelated targets are never installed over', () => {
  const target = app('invalid-target', 'old');
  const plan = desktop.prepare(next, target);
  fs.writeFileSync(path.join(plan.staging, 'Switchboard.app', 'Contents', 'Resources', 'revision'), 'tampered');
  assert.throws(() => desktop.commit(plan));
  assert.equal(revision(target), 'old');
  desktop.discard(plan);
  const unrelated = path.join(temp, 'unrelated.app');
  fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(unrelated, 'keep'), 'keep');
  const other = desktop.prepare(next, unrelated);
  assert.throws(() => desktop.commit(other), /installed app has changed/);
  assert.equal(fs.readFileSync(path.join(unrelated, 'keep'), 'utf8'), 'keep');
  desktop.discard(other);
});

test('publish rejects other workspaces, deduplicates builds, recovers from failure, and installs on quit', async () => {
  const source = path.join(temp, "source with spaces and 'apostrophes'");
  const bin = path.join(temp, 'bin');
  const mode = path.join(temp, 'mode');
  fs.mkdirSync(source);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'switchboard', scripts: { 'install:desktop': 'fixture' } }));
  fs.writeFileSync(path.join(bin, 'npm'), `#!${process.execPath}\n
    const fs = require('fs');
    const desktop = require(${JSON.stringify(require.resolve('../src/main/desktop-install.js'))});
    const args = process.argv.slice(2);
    if (fs.readFileSync(${JSON.stringify(mode)}, 'utf8') === 'fail') {
      console.error('Could not install Switchboard: fixture build failed'); process.exit(1);
    }
    setTimeout(() => {
      const plan = desktop.prepare(${JSON.stringify(next)}, args[args.indexOf('--target') + 1]);
      fs.writeFileSync(args[args.indexOf('--stage') + 1], JSON.stringify(plan));
    }, 100);
  `, { mode: 0o755 });
  const target = app('publisher-target', 'old');
  const publisher = new Publisher({ target, logFile: path.join(temp, 'publish.log') });
  const ws = { id: 'switchboard', self: true, dir: source };
  // What the Logs tab sees: the build as a run of the workspace, one process
  // named `publish`, its output tagged the same way.
  const runs = [];
  const chunks = [];
  publisher.on('run', rs => runs.push(rs));
  publisher.on('log', (wsId, chunk, name) => chunks.push({ wsId, chunk, name }));
  const output = () => chunks.map(c => c.chunk).join('');
  const savedPath = process.env.PATH;
  process.env.PATH = bin + ':' + savedPath;
  try {
    assert.equal((await publisher.publish({ ...ws, self: false })).ok, false);
    assert.equal(publisher.state().status, 'idle');
    assert.equal(publisher.runState(), null);
    assert.equal(publisher.logs('switchboard'), null);
    assert.deepEqual(runs, []);
    fs.writeFileSync(mode, 'fail');
    assert.equal((await publisher.publish(ws)).ok, false);
    assert.equal(publisher.state().status, 'error');
    assert.equal(revision(target), 'old');
    assert.equal(runs[0].wsId, 'switchboard');
    assert.equal(runs[0].status, 'running');
    assert.deepEqual(runs[0].procs.map(p => p.name), ['publish']);
    assert.equal(runs[runs.length - 1].status, 'exited');
    assert.equal(runs[runs.length - 1].exitCode, 1);
    assert.equal(runs[runs.length - 1].procs[0].exitCode, 1);
    assert.match(output(), /fixture build failed/);
    assert.match(output(), /publish exited \(code 1\)/);
    assert.ok(chunks.every(c => c.wsId === 'switchboard' && c.name === 'publish'));
    assert.equal(publisher.runState().status, 'exited');
    assert.equal(publisher.logs('switchboard').text, output());
    assert.equal(publisher.logs('switchboard').name, 'publish');
    assert.equal(publisher.logs('other-workspace'), null);
    fs.writeFileSync(mode, 'success');
    runs.length = 0;
    chunks.length = 0;
    const first = publisher.publish(ws);
    assert.equal(first, publisher.publish(ws));
    assert.equal(publisher.state().status, 'publishing');
    assert.equal(publisher.runState().status, 'running');
    await publisher.wait();
    assert.equal((await first).ok, true);
    assert.equal(publisher.state().status, 'ready');
    assert.equal(runs[runs.length - 1].status, 'exited');
    assert.equal(runs[runs.length - 1].exitCode, 0);
    assert.match(output(), /publish exited \(code 0\)/);
    // A fresh build replaces the last one's text rather than appending to it.
    assert.doesNotMatch(publisher.logs('switchboard').text, /fixture build failed/);
    // Piped output has bare line feeds; the tab's xterm needs CR LF for every one.
    assert.doesNotMatch(publisher.logs('switchboard').text, /(?<!\r)\n/);
    assert.equal(revision(target), 'old');
    assert.equal(publisher.applyOnQuit().ok, true);
    assert.equal(revision(target), 'new');
    assert.equal(publisher.hasPending(), false);
  } finally { process.env.PATH = savedPath; }
});

test('build output reaches the Logs tab with CR LF line endings, whatever the chunking', () => {
  const publisher = new Publisher({ target: '/nowhere.app', logFile: path.join(temp, 'unused.log') });
  const seen = [];
  publisher.on('log', (_wsId, chunk) => seen.push(chunk));
  publisher.begin({ id: 'switchboard', dir: temp });
  seen.length = 0;
  publisher.write('one\ntwo\r\nthree\r');
  publisher.write('\nfour\n\nfive');
  publisher.write('\n');
  assert.equal(seen.join(''), 'one\r\ntwo\r\nthree\r\nfour\r\n\r\nfive\r\n');
  assert.equal(publisher.logs('switchboard').text.endsWith(seen.join('')), true);
  assert.equal(publisher.logs('switchboard').procs[0].lines > 0, true);
  publisher.finish(0);
  assert.equal(publisher.runState().status, 'exited');
  assert.equal(publisher.runState().exitCode, 0);
  // A second finish is a no-op: the exit banner is printed once.
  const before = publisher.logs('switchboard').text;
  publisher.finish(1);
  assert.equal(publisher.logs('switchboard').text, before);
  assert.equal(publisher.runState().exitCode, 0);
});
