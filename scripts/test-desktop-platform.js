'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildTarget, installTarget } = require('../src/main/platform.js');

test('desktop targets detect both OS and CPU and reject unsupported hosts', () => {
  assert.deepEqual(buildTarget(), buildTarget(process.platform, process.arch));
  for (const platform of ['darwin', 'win32']) for (const arch of ['x64', 'arm64']) {
    assert.equal(buildTarget(platform, arch).label, `${platform === 'darwin' ? 'macOS' : 'Windows'} ${arch}`);
  }
  assert.throws(() => buildTarget('linux', 'x64'), /macOS and Windows/);
  assert.throws(() => buildTarget('win32', 'ia32'), /x64 or ARM64/);
  assert.equal(installTarget('darwin', {}, '/home/example'), path.join('/home/example', 'Desktop', 'Switchboard.app'));
  assert.equal(installTarget('win32', { LOCALAPPDATA: '/local' }, '/home/example'), path.join('/local', 'Programs', 'Switchboard'));
});

test('build and install previews work without building or installing', () => {
  for (const script of ['package.js', 'install-desktop.js']) {
    const output = execFileSync(process.execPath, [path.join(__dirname, script), '--dry-run'], { encoding: 'utf8' });
    assert.ok(output.includes(buildTarget().label));
    assert.match(output, /Will build/);
  }
});
