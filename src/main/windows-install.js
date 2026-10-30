'use strict';

// Also copied outside the installed app and run by Node after the Windows app
// exits: Windows locks its running executable, so quit-time swaps need a helper.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const MANIFEST = 'switchboard-build.json';
const ID = 'local.switchboard.app';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function exists(file) {
  try { return fs.lstatSync(file); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function inventory(dir, prefix = '') {
  const files = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!prefix && entry.name === MANIFEST) continue;
    const relative = prefix + entry.name;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(files, inventory(file, relative + '/'));
    else if (entry.isFile()) files[relative] = hash(file);
    else throw new Error('Windows app bundles cannot contain links or special files.');
  }
  return files;
}

function writeManifest(bundle) {
  const manifest = { id: ID, platform: 'win32', arch: process.arch, files: inventory(bundle) };
  fs.writeFileSync(path.join(bundle, MANIFEST), JSON.stringify(manifest));
  verify(bundle);
}

function isOurApp(bundle) {
  try {
    if (exists(bundle)?.isSymbolicLink()) return false;
    const marker = JSON.parse(fs.readFileSync(path.join(bundle, MANIFEST), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(bundle, 'resources', 'app', 'package.json'), 'utf8'));
    return marker.id === ID && marker.platform === 'win32' && pkg.name === 'switchboard' &&
      fs.statSync(path.join(bundle, 'Switchboard.exe')).isFile();
  } catch (_) { return false; }
}

function verify(bundle, digest) {
  if (!isOurApp(bundle)) throw new Error('The new build is not a Switchboard Windows app.');
  const marker = path.join(bundle, MANIFEST);
  if (!fs.lstatSync(marker).isFile()) throw new Error('The build manifest must be a regular file.');
  if (digest && hash(marker) !== digest) throw new Error('The prepared build manifest has changed. Publish again.');
  const expected = JSON.parse(fs.readFileSync(marker, 'utf8')).files;
  const actual = inventory(bundle);
  if (!expected || !expected['Switchboard.exe'] || !expected['resources/app/package.json'] ||
      Object.keys(expected).length !== Object.keys(actual).length ||
      Object.entries(actual).some(([file, value]) => expected[file] !== value)) {
    throw new Error('The Windows build is incomplete or has changed. Build again.');
  }
}

function validatePlan(plan) {
  if (!plan || !path.isAbsolute(plan.target || '') || !path.isAbsolute(plan.staging || '') ||
      path.dirname(plan.staging) !== path.dirname(plan.target) ||
      !path.basename(plan.staging).startsWith('.switchboard-install-') ||
      exists(plan.staging)?.isSymbolicLink() || !/^[a-f0-9]{64}$/.test(plan.digest || '')) {
    throw new Error('The prepared update location is invalid. Publish again.');
  }
}

function prepare(bundle, target) {
  verify(bundle);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(target), '.switchboard-install-'));
  const plan = { staging, target, digest: hash(path.join(bundle, MANIFEST)) };
  try {
    fs.cpSync(bundle, path.join(staging, 'Switchboard'), { recursive: true, dereference: false });
    verify(path.join(staging, 'Switchboard'), plan.digest);
    return plan;
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

function discard(plan) {
  validatePlan(plan);
  if (exists(path.join(plan.staging, 'previous'))) {
    throw new Error('The previous app has been preserved in the update folder for recovery.');
  }
  fs.rmSync(plan.staging, { recursive: true, force: true });
}

function commit(plan) {
  validatePlan(plan);
  const staged = path.join(plan.staging, 'Switchboard');
  const backup = path.join(plan.staging, 'previous');
  verify(staged, plan.digest);
  if (exists(backup)) throw new Error('A previous app is awaiting recovery in the update folder.');
  const previous = exists(plan.target);
  if (previous && !isOurApp(plan.target)) throw new Error('The installed app has changed. The update was not applied.');
  if (previous) fs.renameSync(plan.target, backup);
  try { fs.renameSync(staged, plan.target); } catch (err) {
    if (previous) fs.renameSync(backup, plan.target);
    throw err;
  }
  try { fs.rmSync(plan.staging, { recursive: true, force: true }); }
  catch (err) { console.error('[switchboard] update cleanup:', err.message); }
}

function runningAt(target) {
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process -Filter "Name = \'Switchboard.exe\'" | Where-Object { $_.ExecutablePath -eq $env:SB_INSTALL_EXE } | Select-Object -ExpandProperty ProcessId'],
  { encoding: 'utf8', windowsHide: true, timeout: 15000,
    env: { ...process.env, SB_INSTALL_EXE: path.join(target, 'Switchboard.exe') } });
  return /\d/.test(output);
}

function createShortcut(target) {
  // Let Windows resolve the real Desktop location, including OneDrive redirects.
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$desktop = [Environment]::GetFolderPath("Desktop"); ' +
    '$link = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop "Switchboard.lnk")); ' +
    '$link.TargetPath = $env:SB_INSTALL_EXE; $link.WorkingDirectory = $env:SB_INSTALL_DIR; $link.Save()'],
  { windowsHide: true, timeout: 15000, env: { ...process.env,
    SB_INSTALL_DIR: target, SB_INSTALL_EXE: path.join(target, 'Switchboard.exe') } });
}

async function applyAfterExit(plan, pid, logFile) {
  validatePlan(plan);
  const deadline = Date.now() + 60000;
  while (true) {
    try { process.kill(pid, 0); }
    catch (err) { if (err.code === 'ESRCH') break; throw err; }
    if (Date.now() >= deadline) throw new Error('Switchboard did not exit; the prepared update was preserved.');
    await sleep(200);
  }
  // Antivirus and late Electron child processes can hold files briefly after exit.
  for (let attempt = 0; ; attempt++) {
    try { commit(plan); break; } catch (err) {
      if (!['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(err.code) || attempt >= 30) throw err;
      await sleep(500);
    }
  }
  fs.appendFileSync(logFile, '\nWindows desktop update installed.\n');
}

function scheduleCommit(plan, logFile) {
  validatePlan(plan);
  verify(path.join(plan.staging, 'Switchboard'), plan.digest);
  const helper = path.join(plan.staging, 'apply-update.js');
  const receipt = path.join(plan.staging, 'update.json');
  fs.copyFileSync(__filename, helper);
  fs.writeFileSync(receipt, JSON.stringify(plan));
  const env = { ...process.env };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[name];
  return new Promise((resolve, reject) => {
    const child = spawn('node.exe', [helper, receipt, String(process.pid), logFile], {
      detached: true, windowsHide: true, stdio: 'ignore', cwd: os.tmpdir(), env,
    });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

module.exports = { exists, isOurApp, verify, writeManifest, prepare, commit, discard,
  runningAt, createShortcut, scheduleCommit, applyAfterExit };

if (require.main === module) {
  const [receipt, parent, logFile] = process.argv.slice(2);
  const pid = Number(parent);
  Promise.resolve().then(() => {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid updater parent process.');
    return applyAfterExit(JSON.parse(fs.readFileSync(receipt, 'utf8')), pid, logFile);
  }).catch(err => {
    try { fs.appendFileSync(logFile, '\nWindows update failed: ' + err.message + '\nPrepared update: ' + receipt + '\n'); } catch (_) { /* preserve the staged app */ }
    process.exitCode = 1;
  });
}
