'use strict';

// Shared by the command-line installer and Publish's final quit-time swap.
// Stage on the target volume, verify first, and retain the old bundle for rollback.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BUNDLE_ID = 'local.switchboard.app';

function exists(file) {
  try { return fs.lstatSync(file); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function isOurApp(file) {
  try {
    return execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw',
      path.join(file, 'Contents', 'Info.plist')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() === BUNDLE_ID;
  } catch (_) { return false; }
}

function verify(bundle) {
  if (!isOurApp(bundle)) throw new Error('The new build is not a Switchboard app.');
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'pipe' });
}

function validatePlan(plan) {
  if (!plan || !path.isAbsolute(plan.target || '') || !path.isAbsolute(plan.staging || '') ||
      path.dirname(plan.staging) !== path.dirname(plan.target) ||
      !path.basename(plan.staging).startsWith('.switchboard-install-') ||
      !plan.target.endsWith('.app') || exists(plan.staging)?.isSymbolicLink()) {
    throw new Error('The prepared update location is invalid. Publish again.');
  }
}

function prepare(bundle, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(target), '.switchboard-install-'));
  const plan = { staging, target };
  try {
    const stagedApp = path.join(staging, 'Switchboard.app');
    execFileSync('/usr/bin/ditto', [bundle, stagedApp]);
    verify(stagedApp);
    return plan;
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

function discard(plan) {
  validatePlan(plan);
  if (exists(path.join(plan.staging, 'previous.app'))) {
    throw new Error('The previous app is still in the update folder; it has been preserved for recovery.');
  }
  fs.rmSync(plan.staging, { recursive: true, force: true });
}

function commit(plan) {
  validatePlan(plan);
  const stagedApp = path.join(plan.staging, 'Switchboard.app');
  const backup = path.join(plan.staging, 'previous.app');
  verify(stagedApp);
  const previous = exists(plan.target);
  if (previous && (previous.isSymbolicLink() || !isOurApp(plan.target))) {
    throw new Error('The installed app has changed. The update was not applied.');
  }
  if (previous) fs.renameSync(plan.target, backup);
  try {
    fs.renameSync(stagedApp, plan.target);
  } catch (err) {
    if (previous) fs.renameSync(backup, plan.target);
    throw err;
  }
  // Installation has succeeded; failure to remove a backup must not report a
  // failed update or attempt to roll back an app that may already be reopening.
  try { fs.rmSync(plan.staging, { recursive: true, force: true }); } catch (err) { console.error('[switchboard] update cleanup:', err.message); }
}

module.exports = { exists, isOurApp, prepare, commit, discard };
