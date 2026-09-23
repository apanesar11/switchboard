'use strict';

// CLI: install now. Publish: prepare a verified update for the app to apply on quit.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { packageApp } = require('./package.js');
const desktop = require('../src/main/desktop-install.js');

const root = path.resolve(__dirname, '..');

async function install(args = process.argv.slice(2)) {
  if (process.platform !== 'darwin') throw new Error('The desktop app requires macOS.');
  let receipt = null;
  let target = path.join(os.homedir(), 'Desktop', 'Switchboard.app');
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i + 1] || !path.isAbsolute(args[i + 1])) throw new Error('Installer paths must be absolute.');
    if (args[i] === '--stage') receipt = args[i + 1];
    else if (args[i] === '--target') target = args[i + 1];
    else throw new Error('Unknown installer option: ' + args[i]);
  }
  if (!target.endsWith('.app')) throw new Error('The install target must be a macOS app.');

  const oldLauncher = path.join(os.homedir(), 'Applications', 'Switchboard.app');
  let ownsOldLauncher = false;
  try {
    const marker = path.join(oldLauncher, 'Contents', 'Resources', 'switchboard-launcher.json');
    ownsOldLauncher = JSON.parse(fs.readFileSync(marker, 'utf8')).project === root;
  } catch (_) { /* Leave unrelated Applications items alone. */ }
  const existing = desktop.exists(target);
  const oldLink = existing?.isSymbolicLink() && ownsOldLauncher &&
    path.resolve(path.dirname(target), fs.readlinkSync(target)) === oldLauncher;
  if (existing && !oldLink && (existing.isSymbolicLink() || !desktop.isOurApp(target))) {
    throw new Error(`${target} already exists and is not a Switchboard app.`);
  }
  if (receipt && oldLink) throw new Error('Run npm run install:desktop once to replace the old launcher first.');
  if (!receipt) {
    const processes = execFileSync('/bin/ps', ['-axo', 'comm='], { encoding: 'utf8' });
    if (processes.split('\n').some(line => line.trim() === path.join(target, 'Contents', 'MacOS', 'Switchboard'))) {
      throw new Error('Quit the desktop app before using the install command, or use Publish inside Switchboard.');
    }
  }

  const build = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-build-'));
  let plan;
  try {
    const bundle = await packageApp({ out: build });
    plan = desktop.prepare(bundle, target);
    if (receipt) {
      fs.writeFileSync(receipt, JSON.stringify(plan), { flag: 'wx' });
      plan = null; // The running app now owns the prepared update.
      console.log('Published. Close Switchboard and reopen it to use the update.');
      return;
    }
    // Only the old, known shortcut is removed before the normal bundle swap.
    if (oldLink) fs.unlinkSync(target);
    try { desktop.commit(plan); } catch (err) {
      if (oldLink && !desktop.exists(target)) fs.symlinkSync(oldLauncher, target);
      throw err;
    }
    plan = null;
    if (ownsOldLauncher) fs.rmSync(oldLauncher, { recursive: true });
    console.log(`Installed ${target}`);
    console.log('Use Publish in the Switchboard workspace for future updates.');
  } finally {
    if (plan) desktop.discard(plan);
    fs.rmSync(build, { recursive: true, force: true });
  }
}

module.exports = { install };
if (require.main === module) install().catch(err => {
  console.error('Could not install Switchboard:', err.message);
  process.exitCode = 1;
});
