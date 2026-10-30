'use strict';

// Run after npm run package, on the native host. Isolate both app settings and
// Electron userData; never launch against the developer's personal workspaces.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist', `Switchboard-${process.platform}-${process.arch}`);
const executable = process.platform === 'win32' ? path.join(output, 'Switchboard.exe')
  : path.join(output, 'Switchboard.app', 'Contents', 'MacOS', 'Switchboard');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-desktop-smoke-'));
try {
  const appRoot = process.platform === 'win32' ? path.join(output, 'resources', 'app')
    : path.join(output, 'Switchboard.app', 'Contents', 'Resources', 'app');
  const script = path.join(temp, 'native.js');
  fs.writeFileSync(script, `
    const pty = require(${JSON.stringify(path.join(appRoot, 'node_modules', 'node-pty'))});
    const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
    const args = process.platform === 'win32'
      ? ['-NoProfile', '-Command', "Write-Output ('NATIVE' + '_PTY_OK')"] : ['-c', 'echo NATIVE_PTY_OK'];
    const term = pty.spawn(shell, args, { cols: 80, rows: 24, cwd: ${JSON.stringify(temp)}, env: process.env });
    let output = '';
    term.onData(data => { output += data; });
    term.onExit(() => { console.log(output); process.exit(output.includes('NATIVE_PTY_OK') ? 0 : 1); });
    setTimeout(() => process.exit(1), 15000).unref();
  `);
  const native = execFileSync(executable, [script], { encoding: 'utf8', timeout: 20000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  assert.match(native, /NATIVE_PTY_OK/);
  const screenshot = path.join(temp, 'app.png');
  const env = { ...process.env, SWITCHBOARD_CONFIG: path.join(temp, 'config.json'),
    SB_SMOKE: screenshot, SB_SMOKE_WAIT: '2000' };
  delete env.ELECTRON_RUN_AS_NODE;
  execFileSync(executable, ['--user-data-dir=' + path.join(temp, 'user-data')], { env, timeout: 45000, stdio: 'pipe' });
  assert.ok(fs.statSync(screenshot).size > 1000, 'Packaged app rendered a window');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temp, 'config.json'), 'utf8')), {});
  console.log('Packaged app and native terminal smoke checks passed.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
