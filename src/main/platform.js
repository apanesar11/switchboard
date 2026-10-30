'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

function buildTarget(platform = process.platform, arch = process.arch) {
  if (!['darwin', 'win32'].includes(platform)) throw new Error('Desktop builds support macOS and Windows.');
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Desktop builds require an x64 or ARM64 computer.');
  return { platform, arch, label: `${platform === 'darwin' ? 'macOS' : 'Windows'} ${arch}` };
}

function installTarget(platform = process.platform, env = process.env, home = os.homedir()) {
  return platform === 'win32'
    ? path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'Switchboard')
    : path.join(home, 'Desktop', 'Switchboard.app');
}

function terminalShell() {
  return process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh';
}

function commandShell() {
  return process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/bash';
}

function commandArgs(command) {
  // cmd /s strips this outer pair, preserving quotes inside the user's command.
  return process.platform === 'win32' ? ['/d', '/s', '/c', `"${command}"`] : ['-lc', command];
}

// Execute npm's JS entry directly on Windows. npm.cmd cannot be execFile'd;
// passing checkout/receipt paths through cmd.exe would interpret shell characters.
function npmInvocation(args) {
  if (process.platform !== 'win32') return { file: 'npm', args };
  const node = execFileSync('where.exe', ['node.exe'], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
    .trim().split(/\r?\n/)[0];
  const candidates = [
    path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const cli = candidates.find(file => fs.existsSync(file));
  if (!cli) throw new Error('npm could not be found. Install Node.js with npm to publish.');
  return { file: node, args: [cli, ...args] };
}

function cliInvocation(bin, args) {
  if (process.platform !== 'win32') return { file: bin, args };
  let found;
  try {
    found = execFileSync('where.exe', [bin], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
      .trim().split(/\r?\n/);
  } catch (_) {
    const error = new Error(`${bin} is not installed or is not on PATH.`);
    error.code = 'ENOENT';
    throw error;
  }
  const executable = found.find(file => /\.exe$/i.test(file));
  if (executable) return { file: executable, args };
  // The supported npm installs expose .cmd shims. Run their JS entrypoints
  // directly so a user's prompt never passes through cmd.exe quoting.
  const entries = { codex: ['@openai', 'codex', 'bin', 'codex.js'],
    claude: ['@anthropic-ai', 'claude-code', 'cli.js'] };
  for (const shim of found) {
    const entry = entries[bin] && path.join(path.dirname(shim), 'node_modules', ...entries[bin]);
    if (entry && fs.existsSync(entry)) return { file: 'node.exe', args: [entry, ...args] };
  }
  throw new Error(`Could not resolve ${bin}. Install its native executable or standard npm package.`);
}

module.exports = { buildTarget, installTarget, terminalShell, commandShell, commandArgs, npmInvocation, cliInvocation };
