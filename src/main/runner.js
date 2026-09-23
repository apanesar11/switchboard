'use strict';

// runner.js — dev process lifecycle, pty, log buffer. ARCHITECTURE §5 M5.
//
// An EventEmitter singleton:
//   start(ws) / stop(wsId) / states() / logs(wsId) / write(wsId, data)
//   resize(wsId, cols, rows) / stopAll()
//   events: 'log' (wsId, chunk, procName), 'run' (RunState), 'links' (wsId, Link[])
//
// A workspace runs either ONE root dev command (sample, example: scripts/dev.sh)
// or SEVERAL per-repo processes (demo, which has no root package.json). Both
// shapes are a list of named processes here; the renderer picks which one's output
// to show, and every 'log' event carries the process name as a third argument.
//
// Nothing throws across the API: every method resolves to a value.

const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { promisify } = require('util');

const ports = require('./ports.js');

const pexec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MAX_CHARS = 1024 * 1024;     // ARCHITECTURE §5: 1 MB per process
const MAX_LINES = 5000;
const START_GRACE_MS = 10 * 1000;  // 'starting' -> 'running' when nothing listens
const STOP_GRACE_MS = 4 * 1000;    // ARCHITECTURE §5: SIGTERM, then SIGKILL after 4 s
const EXIT_REAP_MS = 1000;         // a crashed dev script gets a shorter grace
const CENSUS_MS = 2000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

// Signals the user sends by hand: ^C typed into the logs terminal, `kill`, a
// hangup. A death by one of those is a stop, not a crash.
const CLEAN_SIGNALS = new Set([1, 2, 3, 15]);   // HUP INT QUIT TERM

/** node-pty reports a number, child_process a name like 'SIGKILL'. */
function signum(signal) {
  if (typeof signal === 'number') return signal;
  if (!signal) return 0;
  return os.constants.signals[signal] || 0;
}

const dim = (s) => '\u001b[90m' + s + '\u001b[0m\r\n';
const warn = (s) => '\u001b[33m' + s + '\u001b[0m\r\n';

// ---------------------------------------------------------------------------
// node-pty, loaded defensively
// ---------------------------------------------------------------------------

/**
 * node-pty@1.1.0 publishes prebuilds/<platform>-<arch>/spawn-helper with mode
 * 0644, and without +x every single spawn dies with "Error: posix_spawnp failed."
 * scripts/fix-node-pty.js fixes it on install; this is the second line of defence
 * for `npm ci` in an odd order, a clone where postinstall never ran, and the
 * packaged app (where node-pty rewrites app.asar -> app.asar.unpacked itself).
 */
function ensureSpawnHelperExecutable() {
  const root = path.dirname(require.resolve('node-pty/package.json'));
  const candidates = [
    path.join(root, 'build', 'Release', 'spawn-helper'),
    path.join(root, 'prebuilds', process.platform + '-' + process.arch, 'spawn-helper'),
  ].map((p) => p.replace('app.asar', 'app.asar.unpacked'));
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      if (!(fs.statSync(p).mode & 0o111)) fs.chmodSync(p, 0o755);
    } catch (e) { /* read-only packaged FS — the packaging step must have fixed it */ }
  }
}

let pty = null;
let ptyError = null;

try {
  ensureSpawnHelperExecutable();
  pty = require('node-pty');
  if (!pty || typeof pty.spawn !== 'function') {
    pty = null;
    ptyError = 'node-pty loaded but exposes no spawn()';
  }
} catch (e) {
  pty = null;
  ptyError = (e && e.message) || String(e);
}

// The escape hatch that makes the no-TTY fallback testable on a machine where
// node-pty loads perfectly well.
if (process.env.SWITCHBOARD_NO_PTY === '1') {
  pty = null;
  ptyError = 'disabled by SWITCHBOARD_NO_PTY=1';
}

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

function countNewlines(s) {
  let n = 0;
  let i = -1;
  while ((i = s.indexOf('\n', i + 1)) !== -1) n++;
  return n;
}

/**
 * Per-process replay buffer. Capped at 1 MB / 5000 lines and always trimmed at a
 * line boundary: xterm replays this text verbatim, and a buffer that starts in
 * the middle of an escape sequence paints garbage across the whole terminal.
 *
 * The cap counts characters rather than bytes. Terminal output is overwhelmingly
 * ASCII, so the two agree closely, and counting characters keeps every append O(1).
 */
class Ring {
  constructor(maxChars, maxLines) {
    this.maxChars = maxChars || MAX_CHARS;
    this.maxLines = maxLines || MAX_LINES;
    this.text = '';
    this.lines = 0;
  }

  write(chunk) {
    if (chunk === null || chunk === undefined) return;
    const s = String(chunk);
    if (!s) return;
    this.text += s;
    this.lines += countNewlines(s);
    if (this.text.length > this.maxChars) this.trimChars();
    if (this.lines > this.maxLines) this.trimLines();
  }

  // Drop back to 75% of the cap rather than exactly to it, so a busy process
  // trims once every quarter-megabyte instead of on every chunk.
  trimChars() {
    let cut = this.text.length - Math.floor(this.maxChars * 0.75);
    const nl = this.text.indexOf('\n', cut);
    if (nl !== -1) cut = nl + 1;
    this.drop(cut);
  }

  trimLines() {
    let drop = this.lines - Math.floor(this.maxLines * 0.75);
    let idx = -1;
    while (drop-- > 0) {
      const nl = this.text.indexOf('\n', idx + 1);
      if (nl === -1) break;
      idx = nl;
    }
    if (idx >= 0) this.drop(idx + 1);
  }

  drop(cut) {
    if (cut <= 0) return;
    this.lines -= countNewlines(this.text.slice(0, cut));
    this.text = this.text.slice(cut);
    if (this.lines < 0) this.lines = 0;
  }

  toString() { return this.text; }
}

// ---------------------------------------------------------------------------
// Process census
// ---------------------------------------------------------------------------

/**
 * One `ps` snapshot: { kids: ppid -> [pid], info: pid -> { ppid, pgid, start } }.
 *
 * `start` is the process's absolute start time, and it is the ONLY field here
 * that identifies a pid rather than merely describing it. macOS recycles the
 * whole 100k pid space in minutes under ordinary load, so "pid 81662 is alive"
 * says nothing about whether pid 81662 is still the process we censused — but
 * "pid 81662 is alive AND started at the same second we first saw it" does,
 * because reusing a pid requires ~100k allocations, i.e. minutes. Every kill on
 * this path re-checks it. ppid is deliberately NOT part of the identity: a
 * child of ours legitimately reparents to launchd when its parent dies.
 *
 * `pgid` is how sweepOrphans() tells our daemonised children from the user's:
 * forkpty() and spawn(detached) both setsid, so each Proc is a group leader and
 * anything it backgrounded keeps that pgid even after launchd adopts it.
 */
async function processTable() {
  const kids = new Map();
  const info = new Map();
  let stdout = '';
  try {
    const r = await pexec('/bin/ps', ['-eo', 'pid=,ppid=,pgid=,lstart='], { maxBuffer: 8 * 1024 * 1024 });
    stdout = r.stdout;
  } catch (e) {
    return { kids, info };
  }
  for (const line of stdout.split('\n')) {
    // 'Fri 18 Sep 02:19:08 2026' has spaces in it, so take it as the remainder
    // rather than splitting on whitespace. It is compared verbatim, never parsed.
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (!pid) continue;
    info.set(pid, { ppid, pgid: Number(m[3]), start: m[4] });
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  return { kids, info };
}

/**
 * pid -> start time, for whichever of `pids` still exist. Used at kill time to
 * re-validate a pid recorded seconds or hours earlier; see processTable().
 */
async function startTimesOf(pids) {
  const list = (Array.isArray(pids) ? pids : []).map(Number).filter((p) => Number.isInteger(p) && p > 0);
  const out = new Map();
  if (!list.length) return out;
  let stdout = '';
  try {
    const r = await pexec('/bin/ps', ['-o', 'pid=,lstart=', '-p', list.join(',')], { maxBuffer: 4 * 1024 * 1024 });
    stdout = r.stdout;
  } catch (e) {
    stdout = (e && e.stdout) || '';   // ps exits 1 when every pid has gone
  }
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\S.*?)\s*$/);
    if (m) out.set(Number(m[1]), m[2]);
  }
  return out;
}

function walk(kids, rootPid) {
  const out = [];
  const seen = new Set();
  const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop();
    for (const k of kids.get(p) || []) {
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
      stack.push(k);
    }
  }
  return out;
}

/**
 * [{ pid, command }] for whatever is still alive out of a pid list — a bare pid in
 * the teardown report tells the user nothing about what refused to die.
 */
async function describePids(pids) {
  const list = (Array.isArray(pids) ? pids : []).map(Number).filter((p) => Number.isInteger(p));
  if (!list.length) return [];
  let stdout = '';
  try {
    const r = await pexec('/bin/ps', ['-o', 'pid=,command=', '-p', list.join(',')]);
    stdout = r.stdout;
  } catch (e) {
    stdout = (e && e.stdout) || '';   // ps exits 1 when every pid has gone
  }
  const out = [];
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (m) out.push({ pid: Number(m[1]), command: m[2].slice(0, 120) });
  }
  return out;
}

// Deliberately NO bare `alive(pid)` helper any more: "pid 4711 answers signal 0"
// was the test this module used to kill on, and it is not a test of identity —
// see processTable(). Aliveness questions about a recorded pid go through
// startTimesOf(). A process GROUP id, by contrast, is only ever our own Proc's
// pid, which we hold a live reference to, so this one is safe.
const groupAlive = (pid) => {
  try { process.kill(-pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * node-pty's _parseEnv tests `keys[i] === undefined` — the KEY, which is never
 * undefined — instead of the value, so `{FOO: undefined}` reaches the child as the
 * literal string "FOO=undefined". ELECTRON_RUN_AS_NODE=undefined is truthy and
 * would make every child `node` run as bare node. Delete keys, never assign
 * undefined to them.
 */
function buildEnv(extra) {
  const env = Object.assign({}, process.env, {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '1',
    CLICOLOR_FORCE: '1',
    npm_config_color: 'always',
  }, extra || {});
  // Electron leaks nothing here today, but a packaged app relaunching itself can.
  for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'NODE_OPTIONS']) delete env[k];
  // Never set CI: it actively DISABLES colour in chalk/supports-color.
  delete env.CI;
  for (const k of Object.keys(env)) if (env[k] === undefined || env[k] === null) delete env[k];
  return env;
}

// ---------------------------------------------------------------------------
// One process
// ---------------------------------------------------------------------------

class Proc {
  constructor(opts) {
    this.name = opts.name;
    this.command = opts.command;
    this.cwd = opts.cwd;
    this.env = opts.env || null;
    this.shell = opts.shell || process.env.SHELL || '/bin/bash';
    this.cols = opts.cols || DEFAULT_COLS;
    this.rows = opts.rows || DEFAULT_ROWS;
    this.onData = opts.onData || function () {};
    this.onExit = opts.onExit || function () {};

    this.ring = new Ring();
    // pid -> start time, for every process ever seen in this Proc's subtree.
    // The value is what makes a kill safe; see processTable() and census().
    this.descendants = new Map();
    this.mode = pty ? 'pty' : 'spawn';
    this.status = 'starting';
    this.pid = null;
    this.startedAt = null;
    this.exitCode = null;
    this.signal = null;
    this.exited = false;
    this.term = null;
    this.child = null;
  }

  /** Throws only if the spawn itself fails; the caller turns that into a value. */
  start() {
    if (!pty) {
      this.emit(warn('[switchboard] node-pty is unavailable (' + (ptyError || 'unknown reason') +
        ') - running without a TTY, so interactive keys (Expo i/r/w, Ctrl-C) will not reach this process.'));
    }
    // The header already carries the workspace and its directory (title=ws.dir),
    // and the mock-up's terminal opens on a single dim command line. Keep the name
    // — demo runs two processes into one pane and this banner is what separates
    // them, and the exit banner below uses the same bracket — but not the cwd.
    this.emit(dim('— ' + this.name + ': ' + this.command + ' —'));
    this.startedAt = Date.now();
    const env = buildEnv(this.env);

    if (pty) {
      // forkpty() calls setsid(), so the child is a session leader and its pgid
      // equals its pid — which is what makes the group kill in stop() exact.
      this.term = pty.spawn(this.shell, ['-lc', this.command], {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: this.cwd,
        env,
      });
      this.pid = this.term.pid;
      this.term.onData((d) => this.emit(d));
      this.term.onExit((e) => this.finish(e ? e.exitCode : null, e ? e.signal : null));
      return;
    }

    // detached:true is not optional here: without it the child shares
    // Switchboard's own process group, and the group kill in stop() would take
    // the app down with the dev server.
    this.child = spawn(this.shell, ['-lc', this.command], {
      cwd: this.cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.pid = this.child.pid;
    const out = new StringDecoder('utf8');
    const err = new StringDecoder('utf8');
    this.child.stdout.on('data', (b) => this.emit(out.write(b)));
    this.child.stderr.on('data', (b) => this.emit(err.write(b)));
    this.child.on('error', (e) => {
      this.emit(warn('[switchboard] ' + this.name + ' could not start: ' + e.message));
      this.finish(1, null);
    });
    this.child.on('exit', (code, signal) => this.finish(code === null ? null : code, signal));
  }

  emit(chunk) {
    if (!chunk) return;
    this.ring.write(chunk);
    this.onData(chunk, this.name);
  }

  finish(code, signal) {
    if (this.exited) return;
    this.exited = true;
    this.status = 'exited';
    const sig = signum(signal);
    this.signal = sig || null;
    // node-pty reports a signal death as exitCode 0 and child_process as null, so
    // without this a crash — the OOM killer taking out Metro, a native module
    // segfaulting — is indistinguishable from a clean stop, and the rail shows no
    // fail dot. Use the shell's 128+N convention, except for the signals the user
    // sends by hand (^C in the terminal, `kill`), which really are a stop.
    this.exitCode = (sig && !CLEAN_SIGNALS.has(sig))
      ? 128 + sig
      : ((typeof code === 'number') ? code : null);
    this.emit(dim('— ' + this.name + ' exited (' +
      (sig ? 'signal ' + sig : 'code ' + this.exitCode) + ') —'));
    this.onExit(this, this.exitCode, this.signal);
  }

  write(data) {
    if (this.exited || data === undefined || data === null) return false;
    try {
      if (this.term) { this.term.write(String(data)); return true; }
      if (this.child && this.child.stdin && this.child.stdin.writable) {
        // xterm sends Enter as a bare CR and a pty's line discipline turns that
        // into NL. A pipe has no line discipline, so `read` would block for ever
        // on a prompt; do the translation ourselves in the degraded mode.
        this.child.stdin.write(String(data).replace(/\r(?!\n)/g, '\n'));
        return true;
      }
    } catch (e) { /* the process died between the check and the write */ }
    return false;
  }

  resize(cols, rows) {
    this.cols = cols || this.cols;
    this.rows = rows || this.rows;
    if (this.exited || !this.term) return false;   // a pipe has no window size
    try { this.term.resize(this.cols, this.rows); return true; } catch (e) { return false; }
  }

  census(table) {
    if (!this.pid) return;
    const info = table.info;
    // Drop anything that has exited, and anything whose pid is now a different
    // process. Without this the Set only ever grew, and a pid censused minutes
    // ago was a coin flip by the time Stop ran.
    for (const [p, start] of this.descendants) {
      const rec = info.get(p);
      if (!rec || rec.start !== start) this.descendants.delete(p);
    }
    for (const p of walk(table.kids, this.pid)) {
      const rec = info.get(p);
      if (rec) this.descendants.set(p, rec.start);
    }
  }

  /**
   * Steps 1-3 of the verified teardown: SIGTERM the group, escalate to SIGKILL,
   * then reap by pid anything that left the group. The workspace-wide port sweep
   * (step 4) belongs to the Session, because ports are declared per workspace.
   */
  async stop(graceMs) {
    const steps = [];
    const pid = this.pid;
    if (!pid) return { steps: ['never started'] };

    // Take one last census while the tree is still up.
    this.census(await processTable());

    if (groupAlive(pid)) {
      try { process.kill(-pid, 'SIGTERM'); steps.push('SIGTERM group'); }
      catch (e) { steps.push('SIGTERM group: ' + e.code); }

      const t0 = Date.now();
      while (groupAlive(pid) && Date.now() - t0 < graceMs) await sleep(100);

      if (groupAlive(pid)) {
        try { process.kill(-pid, 'SIGKILL'); steps.push('SIGKILL group after ' + (Date.now() - t0) + 'ms'); }
        catch (e) { steps.push('SIGKILL group: ' + e.code); }
        const t1 = Date.now();
        while (groupAlive(pid) && Date.now() - t1 < 2000) await sleep(50);
      } else {
        steps.push('group gone in ' + (Date.now() - t0) + 'ms');
      }
    } else {
      steps.push('group already gone');
    }

    // A child that called setsid — Node's spawn(.., {detached:true}) does exactly
    // that — has its own pgid and CANNOT be reached by the group kill. This is
    // what the running census is for.
    //
    // Re-validate every pid against the process table AS IT IS NOW, not as it was
    // at the census up to `graceMs` ago: "still alive" is not "still ours". Only a
    // matching start time proves the pid was not recycled in the meantime.
    const now = await startTimesOf([...this.descendants.keys()]);
    for (const [p, start] of this.descendants) {
      if (p === pid) continue;
      const live = now.get(p);
      if (live === undefined) continue;                     // already gone
      if (live !== start) {
        steps.push('left pid ' + p + ' alone (recycled since the census)');
        continue;
      }
      try { process.kill(p, 'SIGKILL'); steps.push('SIGKILL escapee ' + p); } catch (e) { /* already gone */ }
    }

    // node-pty's own kill() is process.kill(this.pid, 'SIGHUP') with a POSITIVE
    // pid, so it only ever signals the pty child — it leaks anything that traps
    // HUP. It is called last, purely to release the pty file descriptors.
    try { if (this.term) this.term.kill(); } catch (e) { /* already gone */ }
    try { if (this.child) this.child.kill('SIGKILL'); } catch (e) { /* already gone */ }

    return { steps };
  }

  /** Still-running pids that really are still ours — same identity test as stop(). */
  survivors(now) {
    const out = [];
    for (const [p, start] of this.descendants) {
      if (p !== this.pid && now.get(p) === start) out.push(p);
    }
    if (this.pid && now.has(this.pid)) out.push(this.pid);
    return out;
  }

  /** pids this Proc might still need to account for, for one batched `ps`. */
  watched() {
    const out = [...this.descendants.keys()];
    if (this.pid) out.push(this.pid);
    return out;
  }

  state() {
    return {
      name: this.name,
      pid: this.pid,
      status: this.status,
      exitCode: this.exitCode,
      signal: this.signal,
      startedAt: this.startedAt,
      command: this.command,
      cwd: this.cwd,
      mode: this.mode,
      bytes: this.ring.text.length,
      lines: this.ring.lines,
    };
  }
}

// ---------------------------------------------------------------------------
// Planning a workspace into processes, links and preflight checks
// ---------------------------------------------------------------------------

function firstString() {
  for (const v of arguments) if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

function firstArray() {
  for (const v of arguments) if (Array.isArray(v) && v.length) return v;
  return [];
}

function absDir(dir, base) {
  if (!dir) return base;
  return path.isAbsolute(dir) ? dir : path.join(base, dir);
}

function planProcesses(ws, run, id, dir) {
  const listed = firstArray(ws.processes, run.processes);
  if (listed.length) {
    return listed
      .map((p, i) => ({
        name: (p && (p.name || p.repo || p.dir)) || ('process ' + (i + 1)),
        command: p && firstString(p.command, p.devCommand, p.devScript),
        cwd: absDir(p && (p.cwd || p.dir), dir),
        env: (p && p.env) || null,
      }))
      .filter((p) => p.command);
  }

  const devCommand = firstString(ws.devCommand, run.devCommand);
  if (devCommand) return [{ name: id, command: devCommand, cwd: dir, env: null }];

  // No root script and no configured process list: run each repo's own dev script
  // in declared order, so a backend can start before its dependent client.
  return (Array.isArray(ws.repos) ? ws.repos : [])
    .map((r) => ({
      name: (r && (r.name || r.dirName)) || null,
      command: r && firstString(r.devScript, r.devCommand),
      cwd: r && (r.dir ? r.dir : absDir(r.dirName || r.name, dir)),
      env: null,
    }))
    .filter((p) => p.name && p.command);
}

function planLinks(ws, run) {
  const raw = [];
  for (const l of firstArray(ws.links, run.links)) raw.push(l);
  for (const r of (Array.isArray(ws.repos) ? ws.repos : [])) {
    if (r && r.url) raw.push({ repo: r.name || r.dirName, url: r.url, port: r.port });
  }

  const links = ports.normalizeLinks(raw);
  // An ngrok extra fronts a local port; without one declared, assume the first
  // local port the workspace serves (sample tunnels sample-api on 3000).
  const firstPort = (links.find((l) => l.port && l.kind !== 'ngrok') || {}).port || null;
  for (const e of firstArray(ws.extras, run.extras)) {
    if (!e) continue;
    if (e.kind === 'ngrok') links.push(ports.normalizeLink({
      label: e.label || 'ngrok', kind: 'ngrok', repo: e.repo || null, port: e.port || firstPort,
    }));
    else if (e.url) links.push(ports.normalizeLink(e));
  }

  const seen = new Set();
  return links.filter((l) => {
    const key = (l.kind || '') + '|' + (l.url || '') + '|' + (l.port || '') + '|' + (l.repo || '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Turn whatever index.js hands us into the plan a Session runs. Accepts the merged
 * Workspace + run config, or a bare Workspace from workspaces.js — in which case
 * config.js is consulted for the dev command, links, extras and preflight checks.
 * Pass `links` (even an empty array) to declare a workspace already resolved.
 */
function planWorkspace(input) {
  const ws = input || {};
  const id = firstString(ws.id);
  if (!id) return { error: 'start() needs a workspace object with an id' };

  const dir = ws.dir || null;
  if (!dir) return { error: id + ' has no directory' };
  if (!fs.existsSync(dir)) return { error: 'workspace directory is missing: ' + dir };

  let run = {};
  if (!Array.isArray(ws.links)) {
    try {
      const config = require('./config.js');
      if (config && typeof config.resolveWorkspace === 'function') run = config.resolveWorkspace(ws) || {};
    } catch (e) { run = {}; }
  }

  const processes = planProcesses(ws, run, id, dir);
  if (!processes.length) return { error: id + ' has no dev command configured' };

  return {
    id,
    project: firstString(ws.project) || id.replace(/-\d+$/, ''),
    dir,
    processes,
    links: planLinks(ws, run),
    preflight: firstArray(ws.preflight, run.preflight),
    cols: Number(ws.cols) || DEFAULT_COLS,
    rows: Number(ws.rows) || DEFAULT_ROWS,
  };
}

/**
 * The dev command runs in a login shell, so it sees the PATH from the user's
 * profile. A Finder-launched Electron app does not: its own PATH is a bare
 * /usr/bin:/bin:/usr/sbin:/sbin, which has no /opt/homebrew/bin and therefore no
 * ngrok. Ask the very shell that will run the command.
 */
async function onPath(binary) {
  const shell = process.env.SHELL || '/bin/bash';
  try {
    await pexec(shell, ['-lc', 'command -v ' + JSON.stringify(String(binary))], { timeout: 8000 });
    return true;
  } catch (e) { return false; }
}

function statKind(p) {
  try { return fs.statSync(p).isDirectory() ? 'dir' : 'file'; } catch (e) { return null; }
}

/**
 * sample's scripts/dev.sh exits before starting anything if ngrok is missing
 * (line 70) or sample-api/.env.local is absent (line 93). Running the same checks
 * here turns "Start flashes and dies with no output" into the config's own
 * failMessage.
 */
async function preflight(plan) {
  for (const check of plan.preflight) {
    if (!check || !check.value) continue;
    const kind = String(check.check || check.kind || '').toLowerCase();
    let ok;
    if (kind === 'binaryonpath' || kind === 'binary' || kind === 'command') {
      ok = await onPath(check.value);
    } else if (kind === 'fileexists' || kind === 'file') {
      ok = statKind(absDir(String(check.value), plan.dir)) === 'file';
    } else if (kind === 'direxists' || kind === 'dir') {
      ok = statKind(absDir(String(check.value), plan.dir)) === 'dir';
    } else {
      continue;   // an unrecognised check must never be the reason Start refuses
    }
    if (!ok) return { ok: false, error: check.failMessage || (plan.id + ': ' + kind + ' ' + check.value + ' failed') };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// One workspace
// ---------------------------------------------------------------------------

class Session {
  constructor(runner, plan) {
    this.runner = runner;
    this.plan = plan;
    this.id = plan.id;
    this.project = plan.project;
    this.dir = plan.dir;
    this.ports = ports.portsOf(plan.links);

    this.procs = [];
    this.status = 'idle';
    this.startedAt = null;
    this.exitCode = null;
    this.error = null;
    this.teardown = null;
    this.links = plan.links.map((l) => Object.assign({}, l));
    this.poller = null;
    this.censusTimer = null;
    this.graceTimer = null;
    this.stopping = false;
    this.reaped = false;    // a session is torn down once, not once per ⌘Q
    this.baseline = null;   // every pid on the machine just before we spawned
  }

  isActive() {
    if (this.status === 'starting' || this.status === 'running') return true;
    return this.procs.some((p) => !p.exited);
  }

  primary(name) {
    if (name) return this.procs.find((p) => p.name === name) || null;
    return this.procs[0] || null;
  }

  async start() {
    this.status = 'starting';
    this.startedAt = Date.now();
    this.exitCode = null;
    this.error = null;
    this.teardown = null;
    this.stopping = false;
    this.reaped = false;
    this.links = this.plan.links.map((l) => Object.assign({}, l, { live: false }));

    // Taken BEFORE anything spawns: a process that daemonises (fork, setsid, let
    // the parent exit) is reparented to launchd within milliseconds and is never
    // visible as our descendant. Everything that was already an orphan is in here,
    // so at teardown the new ones stand out. See sweepOrphans().
    this.baseline = new Set((await processTable()).info.keys());

    this.procs = this.plan.processes.map((p) => new Proc({
      name: p.name,
      command: p.command,
      cwd: p.cwd,
      env: p.env,
      cols: this.plan.cols,
      rows: this.plan.rows,
      onData: (chunk, name) => this.runner.emit('log', this.id, chunk, name),
      onExit: (proc) => this.onProcExit(proc),
    }));

    for (const proc of this.procs) {
      try {
        proc.start();
      } catch (e) {
        const message = 'could not start ' + proc.name + ': ' + ((e && e.message) || String(e));
        proc.status = 'exited';
        proc.exited = true;
        // Whatever did start has to come back down before we report the failure.
        await this.reap(500);
        this.status = 'exited';
        this.error = message;
        this.exitCode = 1;
        this.emitRun();
        return { ok: false, error: message };
      }
    }

    this.censusTimer = setInterval(() => { this.census(); }, CENSUS_MS);
    if (this.censusTimer.unref) this.censusTimer.unref();
    this.census();

    this.poller = ports.createPoller({
      links: this.links,
      mode: 'starting',
      onUpdate: (links) => this.onLinks(links),
    });
    this.poller.start();

    // 'starting' until a configured port answers or ten seconds pass — a dev
    // server with no declared port must not sit on 'starting' for ever.
    this.graceTimer = setTimeout(() => this.markRunning(), START_GRACE_MS);
    if (this.graceTimer.unref) this.graceTimer.unref();

    this.emitRun();
    this.runner.emit('links', this.id, this.visibleLinks());
    return { ok: true, state: this.state() };
  }

  async census() {
    const table = await processTable();
    for (const proc of this.procs) proc.census(table);
  }

  markRunning() {
    if (this.status !== 'starting') return;
    this.status = 'running';
    for (const proc of this.procs) if (!proc.exited) proc.status = 'running';
    if (this.poller) this.poller.setMode('running');
    this.emitRun();
  }

  onLinks(links) {
    this.links = links;
    if (links.some((l) => l.live)) this.markRunning();
    this.runner.emit('links', this.id, this.visibleLinks());
  }

  onProcExit() {
    if (this.stopping) return;              // stop() reports once, at the end
    if (!this.procs.every((p) => p.exited)) {
      this.emitRun();                       // one of several died; the rest run on
      return;
    }

    this.clearTimers();
    const failed = this.procs.find((p) => p.exitCode !== 0 && p.exitCode !== null);
    this.status = 'exited';
    this.exitCode = failed ? failed.exitCode : 0;
    this.emitRun();

    // The command is gone but its backgrounded children are not: example's
    // dev.sh ends in `wait`, and a crash there orphans four npm trees.
    this.reap(EXIT_REAP_MS).then((teardown) => {
      this.teardown = teardown;
      this.markLinksDown();
      this.emitRun();
    });
  }

  markLinksDown() {
    this.links = this.links.map((l) => Object.assign({}, l, { live: false }));
    this.runner.emit('links', this.id, this.visibleLinks());
  }

  clearTimers() {
    if (this.censusTimer) clearInterval(this.censusTimer);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.censusTimer = null;
    this.graceTimer = null;
    if (this.poller) { this.poller.stop(); this.poller = null; }
  }

  /**
   * Processes THIS SESSION created that are now children of launchd.
   *
   * A child that daemonises (fork, setsid, parent exits) is reparented before any
   * census can see it in our subtree, and it may hold no port either, so its
   * pedigree is all we have. Four signals, all required:
   *
   *   1. reparented to pid 1;
   *   2. absent from the pid baseline taken before Start;
   *   3. its process group is one of ours — forkpty() and spawn(detached) both
   *      setsid, so every Proc is a group leader and anything it backgrounded
   *      keeps that pgid even after launchd adopts it;
   *   4. its working directory is inside THIS workspace.
   *
   * Signal 3 is the one that means "ours". Without it this swept up whatever the
   * user happened to have detached in the same folder — `stripe listen`, a
   * nodemon whose terminal was closed, an editor's MCP server — all of which sit
   * at ppid 1 with a matching cwd and none of which we started. cwd is a
   * corroborating signal, never an identifying one.
   *
   * Trade-off, stated plainly: a grandchild that calls setsid() ITSELF has its own
   * pgid and escapes this test — but it also escaped the group kill, which is why
   * the running census (Proc.stop) exists and catches it there. A stray dev server
   * the user can see beats an editor SIGKILLed without warning.
   */
  async sweepOrphans(table) {
    if (!this.baseline) return [];
    const t = table || await processTable();
    const candidates = (t.kids.get(1) || []).filter((p) => !this.baseline.has(p) && p !== process.pid);
    if (!candidates.length) return [];

    const ourGroups = new Set(this.procs.map((p) => p.pid).filter(Boolean));
    const mine = candidates.filter((p) => {
      const rec = t.info.get(p);
      return rec && ourGroups.has(rec.pgid);
    });
    if (!mine.length) return [];

    const cwds = await ports.cwdOfPids(mine);
    const root = String(this.dir).replace(/\/+$/, '');
    const found = [];
    for (const [pid, cwd] of cwds) {
      if (!cwd) continue;
      if (cwd !== root && cwd.indexOf(root + '/') !== 0) continue;
      found.push(pid);
    }
    return found;
  }

  /**
   * Whether `pid` is a process this session actually owns, proved one of two ways:
   * the census saw it inside one of our subtrees and it is STILL that same process
   * (identical start time), or its ancestry as it stands right now still reaches
   * one of our processes — which covers something spawned since the last census.
   *
   * Everything else on the machine is somebody else's, however suggestive its cwd
   * or its port.
   */
  ownsPid(pid, table, starts) {
    const ours = new Set(this.procs.map((p) => p.pid).filter(Boolean));
    if (ours.has(pid)) return true;
    for (const proc of this.procs) {
      const start = proc.descendants.get(pid);
      if (start !== undefined && starts.get(pid) === start) return true;
    }
    let cur = pid;
    const seen = new Set();
    while (cur && cur !== 1 && !seen.has(cur)) {
      seen.add(cur);
      if (ours.has(cur)) return true;
      const rec = table.info.get(cur);
      if (!rec) return false;   // the chain is broken; we cannot prove anything
      cur = rec.ppid;
    }
    return false;
  }

  async killOrphans(steps, label, table) {
    const found = await this.sweepOrphans(table);
    for (const pid of found) {
      try {
        process.kill(pid, 'SIGKILL');
        steps.push('SIGKILL ' + label + ' ' + pid + ' (daemonised inside the workspace)');
      } catch (e) { /* it exited between the scan and the signal */ }
    }
    return found;
  }

  /**
   * The verified teardown, then proof that it worked.
   *   per process:   SIGTERM group -> SIGKILL group -> SIGKILL census escapees
   *   per workspace: kill daemonised orphans, then whatever still holds one of
   *                  its declared ports
   *
   * Every kill here is gated on ownership, never on circumstantial evidence. A
   * control panel that leaves the odd orphan behind is a nuisance; one that
   * SIGKILLs a process the user started is a disaster, and SIGKILL means no save
   * and no cleanup. The port step in particular needs FOUR signals — the port is
   * one this workspace declared, the holder's cwd is inside the workspace, the
   * holder was not already on the machine before Start, and it descends from this
   * session — because port plus cwd alone killed a dev server the user had
   * started by hand in the same folder.
   */
  async reap(graceMs) {
    const t0 = Date.now();
    const steps = [];

    for (const proc of this.procs) {
      const r = await proc.stop(graceMs);
      for (const s of r.steps) steps.push(proc.name + ': ' + s);
    }

    const table = await processTable();
    await this.killOrphans(steps, 'orphan', table);

    const starts = new Map();
    for (const [pid, rec] of table.info) starts.set(pid, rec.start);
    for (const port of this.ports) {
      const owner = await ports.ownerInWorkspace(port, { dir: this.dir, ports: this.ports });
      if (!owner) continue;
      // Already on the machine before we spawned anything: the user's, whatever
      // its cwd says. This is sweepOrphans()'s second signal, which this loop used
      // to be missing.
      if (this.baseline && this.baseline.has(owner.pid)) continue;
      if (!this.ownsPid(owner.pid, table, starts)) continue;
      try {
        process.kill(owner.pid, 'SIGKILL');
        steps.push('port ' + port + ': SIGKILL ' + owner.pid + ' (' + (owner.command || '?') + ')');
      } catch (e) { /* it exited between the lookup and the signal */ }
    }

    await sleep(150);

    // A child forked in the instant before the group SIGKILL lands is reparented
    // to launchd with the signal already delivered to a process that no longer
    // exists, so one late pass is genuinely needed.
    await this.killOrphans(steps, 'late orphan');
    await sleep(100);

    const watched = [];
    for (const proc of this.procs) for (const p of proc.watched()) watched.push(p);
    const now = await startTimesOf(watched);
    const left = [];
    for (const proc of this.procs) for (const p of proc.survivors(now)) if (left.indexOf(p) === -1) left.push(p);
    for (const p of await this.sweepOrphans()) if (left.indexOf(p) === -1) left.push(p);
    const survivors = await describePids(left);

    const portsHeld = [];
    for (const port of this.ports) {
      const owner = await ports.ownerInWorkspace(port, { dir: this.dir, ports: this.ports });
      if (owner) portsHeld.push({ port, pid: owner.pid, cwd: owner.cwd });
    }

    // Set only now that the teardown has actually finished: a session still inside
    // onProcExit's async reap must not be skipped by stopAll(), or ⌘Q can quit out
    // from under an unfinished teardown.
    this.reaped = true;

    return {
      at: Date.now(),
      ms: Date.now() - t0,
      steps,
      survivors,
      portsHeld,
      clean: survivors.length === 0 && portsHeld.length === 0,
    };
  }

  async stop(graceMs) {
    this.stopping = true;
    this.clearTimers();
    this.teardown = await this.reap(typeof graceMs === 'number' ? graceMs : STOP_GRACE_MS);
    this.status = 'idle';
    this.stopping = false;
    this.links = this.links.map((l) => Object.assign({}, l, { live: false }));
    this.emitRun();
    this.runner.emit('links', this.id, this.visibleLinks());
    return { ok: true, state: this.state() };
  }

  visibleLinks() {
    // An ngrok chip with no tunnel yet has no address to open — hide it until the
    // poll finds one rather than rendering a dead row.
    return this.links.filter((l) => l.url).map((l) => ({
      label: l.label, url: l.url, repo: l.repo, live: !!l.live,
    }));
  }

  logs(name) {
    const proc = this.primary(name);
    const list = this.procs.map((p) => ({ name: p.name, status: p.status, bytes: p.ring.text.length, lines: p.ring.lines }));
    if (!proc) return { ok: false, error: 'no process named ' + name + ' in ' + this.id, text: '', name: null, procs: list };
    return { ok: true, text: proc.ring.toString(), name: proc.name, procs: list };
  }

  state() {
    const first = this.procs[0] || null;
    return {
      wsId: this.id,
      status: this.status,
      pid: first ? first.pid : null,
      startedAt: this.startedAt,
      exitCode: this.exitCode,
      links: this.visibleLinks(),
      procs: this.procs.map((p) => p.state()),
      mode: first ? first.mode : (pty ? 'pty' : 'spawn'),
      error: this.error,
      teardown: this.teardown,
    };
  }

  emitRun() {
    this.runner.emit('run', this.state());
  }
}

// ---------------------------------------------------------------------------
// The singleton
// ---------------------------------------------------------------------------

class Runner extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    // wsId -> { cols, rows }, the last size the renderer reported for that
    // workspace's pane. A Restart spawns a brand-new pty, and without this it
    // would go back to 120x30 until the renderer's next fit came round.
    this.sizes = new Map();
  }

  /** Whether interactive keys will work, for whoever wants to say so in the UI. */
  info() {
    return { pty: !!pty, ptyError: pty ? null : ptyError };
  }

  /**
   * What Start would actually run: { id, project, dir, processes, links, preflight }
   * or { error } — the sentence to show beside a disabled Start button.
   */
  plan(ws) {
    return planWorkspace(ws);
  }

  /**
   * start(ws) -> { ok:true, state } | { ok:false, error } | { ok:false, conflict:{ wsId } }
   * The conflict case names the copy that is already running; the renderer decides
   * whether to stop it, because main never stops a workspace the user did not ask it to.
   */
  async start(ws) {
    let input = ws;
    if (typeof input === 'string') {
      input = await this.lookup(input);
      if (!input) return { ok: false, error: 'unknown workspace "' + ws + '"' };
    }

    const plan = planWorkspace(input);
    if (plan.error) return { ok: false, error: plan.error };

    const mine = this.sessions.get(plan.id);
    if (mine && mine.isActive()) return { ok: false, conflict: { wsId: mine.id, project: mine.project } };
    for (const session of this.sessions.values()) {
      if (session.id !== plan.id && session.project === plan.project && session.isActive()) {
        // Copies of a project deliberately share ports (and sample's free-tier
        // ngrok allows one tunnel), so a second copy would only die on EADDRINUSE.
        return { ok: false, conflict: { wsId: session.id, project: session.project } };
      }
    }

    const checks = await preflight(plan);
    if (!checks.ok) return { ok: false, error: checks.error };

    const size = this.sizes.get(plan.id);
    if (size) { plan.cols = size.cols; plan.rows = size.rows; }

    const session = new Session(this, plan);
    this.sessions.set(plan.id, session);
    try {
      return await session.start();
    } catch (e) {
      const error = 'could not start ' + plan.id + ': ' + ((e && e.message) || String(e));
      session.status = 'exited';
      session.error = error;
      session.emitRun();
      return { ok: false, error };
    }
  }

  /**
   * Bare-id convenience: the workspace the rail shows under that id, through
   * workspaces.js — so a declared workspace (`website`, folder
   * `website-landing-v2`) starts in its declared folder, not in a folder named
   * after its id, which does not exist. Only { id, project, dir }: planWorkspace()
   * fills the processes in from the config, and discover()'s `processes` are names.
   */
  async lookup(id) {
    try {
      const workspaces = require('./workspaces.js');
      const ws = typeof workspaces.lookup === 'function' ? await workspaces.lookup(id) : null;
      if (ws && ws.dir) return { id: ws.id, project: ws.project || ws.id.replace(/-\d+$/, ''), dir: ws.dir };
    } catch (e) { /* fall through to the old resolution */ }
    try {
      const config = require('./config.js');
      const cfg = typeof config.load === 'function' ? await config.load() : null;
      if (!cfg) return null;
      const root = cfg.root;
      if (!root) return null;
      const dir = path.join(root, id);
      if (!fs.existsSync(dir)) return null;
      return { id, project: id.replace(/-\d+$/, ''), dir };
    } catch (e) { return null; }
  }

  async stop(wsId) {
    const session = this.sessions.get(wsId);
    if (!session) return { ok: true, state: null };
    try {
      return await session.stop();
    } catch (e) {
      return { ok: false, error: 'could not stop ' + wsId + ': ' + ((e && e.message) || String(e)) };
    }
  }

  /** Every workspace this process has started, keyed by id. */
  states() {
    const out = {};
    for (const [id, session] of this.sessions) out[id] = session.state();
    return out;
  }

  state(wsId) {
    const session = this.sessions.get(wsId);
    return session ? session.state() : null;
  }

  /**
   * logs(wsId, procName) -> { ok, text, name, procs }. `text` is the whole ring
   * buffer for one process, ready to replay into xterm; `procs` lets the renderer
   * offer the picker a multi-process workspace needs. With no name, the first
   * process (sample's dev.sh, demo's demo-nextjs).
   */
  logs(wsId, procName) {
    const session = this.sessions.get(wsId);
    if (!session) return { ok: true, text: '', name: null, procs: [] };
    return session.logs(procName);
  }

  write(wsId, data, procName) {
    const session = this.sessions.get(wsId);
    if (!session) return { ok: false, error: wsId + ' is not running' };
    const proc = session.primary(procName);
    if (!proc) return { ok: false, error: 'no process named ' + procName + ' in ' + wsId };
    if (!proc.write(data)) return { ok: false, error: proc.name + ' is not accepting input' };
    return { ok: true };
  }

  /**
   * resize(wsId, cols, rows, procName) -> { ok } | { ok:false, error }
   *
   * The pty is spawned at 120x30 and the renderer is the only thing that knows how
   * big the pane really is, so it has to say — otherwise the dev server wraps its
   * output, draws its progress bars and lays out Expo's full-screen key menu for a
   * terminal that is not the one on screen. With no procName, every process: they
   * all render into the same-sized pane.
   */
  resize(wsId, cols, rows, procName) {
    const c = Number(cols);
    const r = Number(rows);
    if (!Number.isInteger(c) || !Number.isInteger(r) || c < 2 || r < 2) {
      return { ok: false, error: 'resize needs a column and row count' };
    }
    // Remembered even when nothing is running, so the next Start spawns at the
    // size the pane already is.
    this.sizes.set(wsId, { cols: c, rows: r });
    const session = this.sessions.get(wsId);
    if (!session) return { ok: false, error: wsId + ' is not running' };
    const targets = procName ? [session.primary(procName)].filter(Boolean) : session.procs;
    if (!targets.length) return { ok: false, error: 'no process to resize in ' + wsId };
    for (const proc of targets) proc.resize(c, r);
    return { ok: true };
  }

  /** app.before-quit: never leave a dev server behind. */
  async stopAll() {
    // `!s.reaped` rather than a plain isActive() filter, so a session still inside
    // onProcExit's async reap is not skipped — but one stopped minutes ago is. It
    // used to be torn down all over again on every ⌘Q.
    const active = [...this.sessions.values()].filter((s) => s.isActive() || (s.procs.length && !s.reaped));
    const results = await Promise.all(active.map(async (session) => {
      try {
        await session.stop(3000);
        return { wsId: session.id, ok: true, teardown: session.teardown };
      } catch (e) {
        return { wsId: session.id, ok: false, error: (e && e.message) || String(e) };
      }
    }));
    return { ok: results.every((r) => r.ok), results };
  }
}

const runner = new Runner();

module.exports = runner;
