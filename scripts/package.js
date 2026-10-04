'use strict';

// Build a standalone macOS app, including its runtime, terminal native module and
// icon. No references back to this checkout are needed by the installed app.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');

function buildIcon() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-icon-'));
  try {
    const iconset = path.join(temp, 'Switchboard.iconset');
    fs.mkdirSync(iconset);
    const source = path.join(root, 'assets', 'switchboard.svg');
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const filename = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
        execFileSync('/usr/bin/sips', ['-s', 'format', 'png', '-z', String(size * scale), String(size * scale),
          source, '--out', path.join(iconset, filename)], { stdio: 'pipe' });
      }
    }
    fs.copyFileSync(path.join(iconset, 'icon_512x512@2x.png'), path.join(root, 'assets', 'switchboard.png'));
    const icon = path.join(root, 'assets', 'switchboard.icns');
    execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', icon]);
    return icon;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function packageApp(options = {}) {
  if (process.platform !== 'darwin') throw new Error('Building the desktop app requires macOS.');
  require('./fix-node-pty.js');
  // The Diagrams tab's bundle is generated, not committed: build it from the source
  // this app is being made from, so the installed app never carries a stale one.
  await require('./build-diagrams.js').build();
  const icon = buildIcon();
  const { packager } = await import('@electron/packager');
  const [output] = await packager({
    dir: root,
    name: 'Switchboard',
    executableName: 'Switchboard',
    appBundleId: 'local.switchboard.app',
    appCategoryType: 'public.app-category.developer-tools',
    platform: 'darwin',
    arch: process.arch,
    out: options.out || path.join(root, 'dist'),
    overwrite: true,
    icon,
    // tmux reads switchboard.tmux.conf itself, outside Electron's virtual FS.
    // Keep real files so it and node-pty can use their bundled resources directly.
    asar: false,
    ignore: [
      /^\/dist(?:\/|$)/,
      // The Diagrams tab's TypeScript sources: the app loads src/renderer/diagrams/, built from them.
      /^\/src\/diagrams(?:\/|$)/,
      // monaco-editor ships ~100 MB (dev/, esm/, min/); the Editor tab loads only min/vs through its AMD loader.
      /^\/node_modules\/monaco-editor\/(?!min(?:\/|$)|package\.json$|LICENSE$|ThirdPartyNotices\.txt$)/,
      // Legacy per-language worker entry points (the assets/ workers are the ones used) and non-English NLS bundles.
      /^\/node_modules\/monaco-editor\/min\/vs\/(?:nls|language)(?:\/|$)/,
    ],
    // A local ad-hoc signature needs no Apple account or signing certificate.
    osxSign: {
      identity: '-',
      identityValidation: false,
      preAutoEntitlements: false,
      // Hardened library validation requires a shared Apple Team ID. Ad-hoc
      // local builds have none, so use the normal development runtime instead.
      optionsForFile: () => ({ timestamp: 'none', hardenedRuntime: false }),
    },
  });
  const bundle = path.join(output, 'Switchboard.app');
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'pipe' });
  return bundle;
}

module.exports = { packageApp };

if (require.main === module) {
  packageApp().then(bundle => console.log(`Built ${bundle}`)).catch(err => {
    console.error('Could not package Switchboard:', err.message);
    process.exitCode = 1;
  });
}
