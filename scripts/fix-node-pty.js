'use strict';
// node-pty@1.1.0 publishes prebuilds/<plat>-<arch>/spawn-helper with mode 0644.
// Without +x every pty.spawn() dies with "Error: posix_spawnp failed."
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'node_modules', 'node-pty');
const targets = [
  path.join(root, 'build', 'Release', 'spawn-helper'),
  path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
];
for (const p of targets) {
  if (!fs.existsSync(p)) continue;
  if (!(fs.statSync(p).mode & 0o111)) {
    fs.chmodSync(p, 0o755);
    console.log('fix-node-pty: chmod +x ' + path.relative(process.cwd(), p));
  }
}

// node-pty 1.1.0's bundled ConPTY path leaves the output worker's pipe server
// alive on exit. On kill it waits for a data event that may never arrive after
// closing the console. Release the input and drain/dispose the worker on native
// exit, and schedule the same drain immediately on kill. Keep this repair tied
// to the pinned dependency so an upgrade cannot silently patch unrelated code.
if (process.platform === 'win32') {
  const file = path.join(root, 'lib', 'windowsPtyAgent.js');
  const marker = '// Switchboard: release ConPTY resources after native exit.';
  const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  if (!source.includes(marker)) {
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const onExit = 'this._exitCode = exitCode;';
    const onKill = "this._outSocket.on('data', function () {\n                    _this._conoutSocketWorker.dispose();\n                });";
    if (version !== '1.1.0' || source.split(onExit).length !== 2 || source.split(onKill).length !== 2) {
      throw new Error('node-pty changed; review the Windows ConPTY cleanup repair before building.');
    }
    fs.writeFileSync(file, source.replace(onExit,
      `${onExit}\n        ${marker}\n        this._inSocket.destroy();\n        this._conoutSocketWorker.dispose();`)
      .replace(onKill, 'this._conoutSocketWorker.dispose();'));
    console.log('fix-node-pty: repaired Windows ConPTY worker cleanup');
  }
}
