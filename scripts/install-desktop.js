'use strict';

// CLI: install now. Publish: prepare a verified update for the app to apply on quit.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { packageApp } = require('./package.js');
const desktop = require('../src/main/desktop-install.js');
const { buildTarget, installTarget } = require('../src/main/platform.js');

const root = path.resolve(__dirname, '..');

async function install(args = process.argv.slice(2)) {
  const platform = buildTarget();
  let receipt = null;
  let target = installTarget();
  if (args.length === 1 && args[0] === '--dry-run') {
    console.log(`Will build ${platform.label} and install to ${target}`);
    return;
  }
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i + 1] || !path.isAbsolute(args[i + 1])) throw new Error('Installer paths must be absolute.');
    if (args[i] === '--stage') receipt = args[i + 1];
    else if (args[i] === '--target') target = args[i + 1];
    else throw new Error('Unknown installer option: ' + args[i]);
  }
  if (platform.platform === 'darwin' && !target.endsWith('.app')) throw new Error('The install target must be a macOS app.');
  console.log(`Installing Switchboard for ${platform.label} to ${target}`);

  if (platform.platform === 'win32') {
    if (desktop.exists(target) && !desktop.isOurApp(target)) throw new Error(`${target} already exists and is not a Switchboard app.`);
    if (!receipt && desktop.runningAt(target)) throw new Error('Quit Switchboard before installing, or use Publish inside Switchboard.');
    const build = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-build-'));
    let plan;
    try {
      plan = desktop.prepare(await packageApp({ out: build }), target);
      if (receipt) {
        fs.writeFileSync(receipt, JSON.stringify(plan), { flag: 'wx' });
        plan = null;
        console.log('Published. Close Switchboard and wait for the update to finish before reopening.');
      } else {
        desktop.commit(plan);
        plan = null;
        console.log(`Installed ${path.join(target, 'Switchboard.exe')}`);
        try { desktop.createShortcut(target); }
        catch (err) { console.warn('Installed, but could not create the Desktop shortcut: ' + err.message); }
      }
    } finally {
      if (plan) desktop.discard(plan);
      fs.rmSync(build, { recursive: true, force: true });
    }
    return;
  }

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
