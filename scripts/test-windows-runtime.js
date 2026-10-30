'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { once } = require('events');
const { execFileSync } = require('child_process');

const windows = { skip: process.platform !== 'win32', timeout: 60000 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await sleep(100); }
  throw new Error('Timed out waiting for the Windows process.');
}

test('Windows terminal opens PowerShell through ConPTY and accepts commands', windows, async t => {
  const shell = require('../src/main/shell.js');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-terminal-'));
  t.after(async () => { await shell.close('fixture'); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  assert.equal(shell.info().pty, true, shell.info().ptyError);
  assert.equal(shell.info().tmux, false);
  const opened = await shell.open({ id: 'fixture', dir: temp });
  assert.equal(opened.ok, true, opened.error);
  let text = '';
  shell.on('data', (_id, data) => { text += data; });
  shell.write('fixture', "Write-Output ('WINDOWS' + '_PTY_OK')\r");
  await until(() => text.includes('WINDOWS_PTY_OK'));
  assert.equal((await shell.close('fixture')).ok, true);
});

test('Windows Start/Stop ends its process tree and leaves unrelated processes alone', windows, async t => {
  const runner = require('../src/main/runner.js');
  const processes = require('../src/main/windows-processes.js');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-runner-'));
  const outsider = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(outsider, 'spawn');
  t.after(async () => { outsider.kill(); await runner.stopAll(); fs.rmSync(temp, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(temp, 'server with spaces.js'), `
    const fs = require('fs');
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync('pids.json', JSON.stringify([process.pid, child.pid]));
    setInterval(() => {}, 1000);
  `);
  const started = await runner.start({ id: 'fixture', dir: temp, links: [], devCommand: 'node "server with spaces.js"' });
  assert.equal(started.ok, true, started.error);
  await until(() => fs.existsSync(path.join(temp, 'pids.json')));
  const pids = JSON.parse(fs.readFileSync(path.join(temp, 'pids.json'), 'utf8'));
  const stopped = await runner.stop('fixture');
  assert.equal(stopped.ok, true, stopped.error);
  await until(async () => pids.every(pid => { try { process.kill(pid, 0); return false; } catch (_) { return true; } }));
  assert.doesNotThrow(() => process.kill(outsider.pid, 0));
  // A PID with a different creation time must never be terminated.
  const current = (await processes.snapshot()).info.get(outsider.pid);
  await processes.killKnown(new Map([[outsider.pid, current.start + '0']]));
  assert.doesNotThrow(() => process.kill(outsider.pid, 0));
});

test('npm CLI shims preserve prompt arguments without shell interpretation on Windows', windows, () => {
  const { cliInvocation } = require('../src/main/platform.js');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-cli-'));
  const savedPath = process.env.PATH;
  try {
    const entry = path.join(temp, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, 'console.log(JSON.stringify(process.argv.slice(2)))');
    fs.writeFileSync(path.join(temp, 'codex.cmd'), '@echo shim');
    process.env.PATH = [temp, path.dirname(process.execPath), path.join(process.env.SystemRoot, 'System32')].join(path.delimiter);
    const args = ['exec', 'a prompt with "quotes" & | %PATH% $text'];
    const invocation = cliInvocation('codex', args);
    const output = execFileSync(invocation.file, invocation.args, { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(output), args);
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
