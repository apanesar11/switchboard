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
