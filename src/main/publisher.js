'use strict';

// Build from the selected source checkout, not the app's bundled snapshot.
// The installer prepares an update; only the normal quit path replaces the app.
//
// The build's output goes two places: `publish.log` on disk, verbatim, and the
// Logs tab, through the same 'log' / 'run' events runner.js emits. The publisher
// is deliberately NOT a runner session — a session is stopped on quit, and a quit
// during a publish has to wait for the build instead — so it speaks the runner's
// event language under a single pseudo-process named `publish`, and index.js
// answers the Logs tab's replay from here when the runner has nothing for the
// workspace. The self workspace never runs a dev process, so the two never meet.
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const fs = require('fs');
const os = require('os');
const path = require('path');
const desktop = require('./desktop-install.js');

const PROC = 'publish';
const MAX_CHARS = 1024 * 1024;   // the same cap as a runner ring buffer

const dim = s => '\u001b[90m' + s + '\u001b[0m\r\n';
const warn = s => '\u001b[33m' + s + '\u001b[0m\r\n';

class Publisher extends EventEmitter {
  constructor({ target, logFile }) {
    super();
    this.target = target;
    this.logFile = logFile;
    this.current = { status: 'idle', wsId: null, message: '' };
    this.inflight = null;
    this.pending = null;
    // The Logs tab's view of the last build: replayed into a fresh pane, and
    // reported as a RunState so the tab opens a pane at all.
    this.run = null;
    this.text = '';
    this.lastChar = '';
  }

  state() { return { ...this.current }; }
  hasPending() { return !!this.pending; }

  set(status, wsId, message) {
    this.current = { status, wsId, message };
    this.emit('state', this.state());
  }

  publish(ws) {
    if (!ws || !ws.self) return Promise.resolve({ ok: false, error: 'Only Switchboard itself can be published.' });
    if (this.inflight) return this.inflight;
    if (this.pending) return Promise.resolve({ ok: true, ...this.state() });
    this.set('publishing', ws.id, 'Publishing the latest changes…');
    this.begin(ws);
    this.inflight = this.build(ws).then(() => {
      this.finish(0);
      this.set('ready', ws.id, 'Published — close Switchboard and reopen it to use the update.');
      return { ok: true, ...this.state() };
    }).catch(err => {
      this.write(warn('[switchboard] ' + err.message));
      this.finish(1);
      this.set('error', ws.id, 'Publish failed: ' + err.message);
      return { ok: false, error: this.current.message, ...this.state() };
    }).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  // ── the Logs tab ──────────────────────────────────────────────────────────

  // runner.logs() has the same shape; the tab replays `text` and reads `procs`.
  logs(wsId) {
    if (!this.run || this.run.wsId !== wsId) return null;
    const procs = [{ name: PROC, status: this.run.status, bytes: this.text.length, lines: countLines(this.text) }];
    return { ok: true, text: this.text, name: PROC, procs };
  }

  // A RunState (ARCHITECTURE §4.2) for the workspace's last publish, or null.
  runState() { return this.run ? this.snapshot() : null; }

  snapshot() {
    const proc = {
      name: PROC,
      pid: this.run.pid,
      status: this.run.status,
      exitCode: this.run.exitCode,
      signal: null,
      startedAt: this.run.startedAt,
      command: this.run.command,
      cwd: this.run.cwd,
      mode: 'spawn',
      bytes: this.text.length,
      lines: countLines(this.text),
    };
    return {
      wsId: this.run.wsId,
      status: this.run.status,
      pid: this.run.pid,
      startedAt: this.run.startedAt,
      exitCode: this.run.exitCode,
      links: [],
      procs: [proc],
      mode: 'spawn',
      error: null,
      teardown: null,
    };
  }

  begin(ws) {
    this.text = '';
    this.lastChar = '';
    this.run = {
      wsId: ws.id, status: 'running', pid: null, startedAt: Date.now(), exitCode: null,
      command: 'npm run install:desktop', cwd: ws.dir,
    };
    this.write(dim('— ' + PROC + ': ' + this.run.command + ' —'));
    this.emit('run', this.snapshot());
  }

  finish(code) {
    if (!this.run || this.run.status === 'exited') return;
    this.run.status = 'exited';
    this.run.exitCode = code;
    this.write(dim('— ' + PROC + ' exited (code ' + code + ') —'));
    this.emit('run', this.snapshot());
  }

  // Straight into the ring and out to the tab. Piped output arrives with bare
  // line feeds, and xterm treats those as a line feed and nothing else, so each
  // becomes CR LF here — remembering the last character, because a CR LF pair can
  // straddle two chunks. The file on disk gets the bytes untouched (see build()).
  write(chunk) {
    if (!this.run || !chunk) return;
    let s = String(chunk);
    // The CR of a pair split across chunks is already in the ring; leave its LF bare.
    const head = this.lastChar === '\r' && s[0] === '\n' ? '\n' : '';
    this.lastChar = s[s.length - 1];
    s = head + s.slice(head.length).replace(/(?<!\r)\n/g, '\r\n');
    this.text += s;
    if (this.text.length > MAX_CHARS) {
      // Trimmed at a line boundary, so a replay never starts inside an escape.
      let cut = this.text.length - Math.floor(MAX_CHARS * 0.75);
      const nl = this.text.indexOf('\n', cut);
      if (nl !== -1) cut = nl + 1;
      this.text = this.text.slice(cut);
    }
    this.emit('log', this.run.wsId, s, PROC);
  }

  // ── the build ─────────────────────────────────────────────────────────────

  async build(ws) {
    if (process.platform !== 'darwin') throw new Error('desktop publishing requires macOS.');
    const pkg = JSON.parse(fs.readFileSync(path.join(ws.dir, 'package.json'), 'utf8'));
    if (pkg.name !== 'switchboard' || !pkg.scripts?.['install:desktop']) {
      throw new Error('this source folder has no desktop installer.');
    }
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-publish-'));
    const receipt = path.join(temp, 'ready.json');
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.writeFileSync(this.logFile, '');
      const env = { ...process.env };
      for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[name];
      await new Promise((resolve, reject) => {
        const child = spawn('npm', ['run', 'install:desktop', '--', '--stage', receipt, '--target', this.target], {
          cwd: ws.dir, env, stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (this.run) this.run.pid = child.pid || null;
        let tail = '';
        const log = decoder => chunk => {
          tail = (tail + chunk.toString()).slice(-12000);
          try { fs.appendFileSync(this.logFile, chunk); } catch (_) { /* logging must not interrupt the build */ }
          this.write(decoder.write(chunk));
        };
        child.stdout.on('data', log(new StringDecoder('utf8')));
        child.stderr.on('data', log(new StringDecoder('utf8')));
        child.once('error', err => reject(new Error(err.code === 'ENOENT'
          ? 'npm could not be found. Check that Node.js is installed.' : err.message)));
        child.once('close', (code, signal) => {
          if (code === 0) return resolve();
          const summary = tail.split('\n').find(line => line.startsWith('Could not install Switchboard:'));
          reject(new Error(summary?.replace('Could not install Switchboard:', '').trim().slice(0, 350) ||
            `the build ${signal ? 'was interrupted' : 'failed'}; details are in ${this.logFile}.`));
        });
      });
      const plan = JSON.parse(fs.readFileSync(receipt, 'utf8'));
      if (plan.target !== this.target) throw new Error('the installer prepared a different app.');
      this.pending = plan;
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }

  async wait() { if (this.inflight) await this.inflight; }

  applyOnQuit() {
    if (!this.pending) return { ok: true };
    try {
      desktop.commit(this.pending);
      this.pending = null;
      return { ok: true };
    } catch (err) {
      this.set('error', this.current.wsId, 'Could not install the update: ' + err.message + ' Close Switchboard to retry.');
      return { ok: false, error: this.current.message };
    }
  }
}

function countLines(s) {
  let n = 0;
  let i = -1;
  while ((i = s.indexOf('\n', i + 1)) !== -1) n++;
  return n;
}

module.exports = { Publisher };
