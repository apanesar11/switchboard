'use strict';

// shell.js — the interactive login shell per workspace. ARCHITECTURE §5 M6.
//
// An EventEmitter singleton:
//   open(ws, {cols, rows}) / write(wsId, data) / resize(wsId, cols, rows)
//   buffer(wsId) / close(wsId) / state(wsId) / states() / closeAll() / info()
//   events: 'data' (wsId, chunk), 'state' (Shell)
//
// This is the Terminal tab, not the dev server. One login shell per workspace,
// spawned in the workspace directory so `claude` runs where iTerm2 would have run
// it. A deliberately much simpler sibling of runner.js: same Ring, same env
// discipline, same 128+N exit convention — but its teardown is a terminal's, not a
// process manager's. Anything this shell started belongs to the USER, so there is
// no census, no orphan sweep and no port sweep here; hanging up the session is the
// whole of close(), exactly as closing an iTerm2 window is.
//
// THE SHELL OUTLIVES THE APP. When tmux is installed, the shell runs inside a tmux
// session on Switchboard's own socket (-L switchboard, with src/main/switchboard
// .tmux.conf, so the user's own tmux is never touched), and what this process holds
// is a tmux *client* attached to it in a pty. Quitting detaches the client; the
// session — zsh, Claude mid-turn, the screen — stays up in tmux's server, and the
// next launch attaches again and tmux repaints the screen that was there. Without
// tmux everything below still works the old way: a bare `zsh -l`, hung up at quit.
//
// The two directions of that separation both hold. A shell has its own session
// (forkpty calls setsid) and therefore its own pgid, which is the only thing
// runner.js's Session.sweepOrphans treats as "ours" — so Stop can never reach a
// shell, and closeAll() can never reach a dev server.
//
// Nothing throws across the API: every method resolves to a value.

const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_CHARS = 1024 * 1024;     // ARCHITECTURE §5: 1 MB per shell
const MAX_LINES = 5000;

// 80x24 is what every curses program assumes when nothing has told it otherwise,
// and the renderer's first fit() replaces it within a frame. It only ever shows if
// the shell prints something before the Terminal tab has measured its pane.
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

const HUP_GRACE_MS = 2000;         // ARCHITECTURE §5: SIGHUP, then SIGKILL after 2 s
const KILL_GRACE_MS = 500;

// Signals the user sends by hand: ^C typed at the prompt, `kill`, the hangup
// close() itself sends. A death by one of those is a stop, not a crash.
const CLEAN_SIGNALS = new Set([1, 2, 3, 15]);   // HUP INT QUIT TERM

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** node-pty reports a number; accept a name too, in case it ever stops. */
function signum(signal) {
  if (typeof signal === 'number') return signal;
  if (!signal) return 0;
  return os.constants.signals[signal] || 0;
}

function intOr(value, fallback) {
  const n = Number(value);
  return (Number.isInteger(n) && n >= 2) ? n : fallback;
}

// TERM_PROGRAM_VERSION, read once at require time. A version we cannot read is left
// unset rather than invented: an empty or made-up version is worse than none, and
// anything that sniffs TERM_PROGRAM_VERSION treats absent as "old client".
let appVersion = null;
try {
  appVersion = String((require('../../package.json') || {}).version || '') || null;
} catch (e) {
  appVersion = null;
}

// 'light' | 'dark' — the RESOLVED appearance, never 'system'. index.js sets it before
// the window exists and again on every change; the default matches the stylesheet's,
// so a shell spawned before anyone has said otherwise is still told the truth.
let appearance = 'dark';

// ---------------------------------------------------------------------------
// node-pty, loaded defensively
// ---------------------------------------------------------------------------

/**
 * node-pty@1.1.0 publishes prebuilds/<platform>-<arch>/spawn-helper with mode 0644,
 * and without +x every single spawn dies with "Error: posix_spawnp failed."
 *
 * runner.js runs exactly this before its own require, and in practice it has always
 * run by the time a Terminal tab opens. The helper is idempotent and costs two
 * stat()s, so repeat it rather than `require('./runner.js')` for the side effect —
 * that would be a module cycle for no benefit.
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

// The same escape hatch runner.js has, so the one-sentence failure the Terminal tab
// shows can be seen on a machine where node-pty loads perfectly well.
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
 * Replay buffer for one shell. Capped at 1 MB / 5000 lines and always trimmed at a
 * line boundary: xterm replays this text verbatim, and a buffer that starts in the
 * middle of an escape sequence paints garbage across the whole terminal.
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

  // Drop back to 75% of the cap rather than exactly to it, so a shell running
  // something chatty trims once every quarter-megabyte instead of on every chunk.
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
// Environment
// ---------------------------------------------------------------------------

/**
 * node-pty's _parseEnv tests `keys[i] === undefined` — the KEY, which is never
 * undefined — instead of the value, so `{FOO: undefined}` reaches the child as the
 * literal string "FOO=undefined". Delete keys, never assign undefined to them.
 *
 * Deliberately absent, and this is the difference from runner.js's buildEnv:
 * FORCE_COLOR, CLICOLOR_FORCE and npm_config_color. The runner sets those because a
 * dev server writing into a pipe needs coaxing into colour. This is a real tty, which
 * needs none — and forcing them would lie to everything the user pipes by hand, so
 * `ls | cat` and `git log | grep` would come out full of escape sequences.
 */
function buildEnv() {
  const env = Object.assign({}, process.env, {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'Switchboard',
    // Which way round the terminal is, in the one form a program can read without
    // asking: `fg;bg` as xterm colour indices, so 15;0 is light-on-dark and 0;15 is
    // dark-on-light. xterm.js answers the OSC 11 background query too, and that path
    // stays true for the life of a pane — but a program has to know to ask, and the
    // ones that do gate it on a short list of terminal names that cannot include this
    // one. Claude Code is the case in point: it reads COLORFGBG, and on `theme: auto`
    // it is this line that stops it defaulting to its dark theme on a white pane.
    //
    // Fixed at fork, like every other variable here. A shell already running when the
    // appearance changes keeps the old value; the next one is right. Nothing repaints
    // a running TUI from an env var anyway, so re-exporting it would buy nothing.
    COLORFGBG: appearance === 'light' ? '0;15' : '15;0',
  });
  if (appVersion) env.TERM_PROGRAM_VERSION = appVersion;

  // A UTF-8 locale, without which everything non-ASCII breaks — and the one thing a
  // terminal gives its shells that a Finder-launched app does not. Double-clicking the
  // bundle hands the app launchd's environment, which sets no LANG or LC_*; the tmux
  // client we attach then runs in its non-UTF-8 mode (TMUX unset, no "UTF-8" in
  // LC_ALL/LC_CTYPE/LANG) and rewrites every non-ASCII cell as `_` — Claude Code's
  // banner, its ⏺ ✻ ❯ glyphs and all box drawing turn to underscores. It shows only
  // in the installed app: `npm start` and the smoke harness inherit the terminal's
  // LANG. Terminal.app and iTerm2 set this for their shells for exactly this reason.
  // Inject one only when the inherited environment names no UTF-8 codeset, so a user
  // who set their own is left untouched.
  const codeset = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  if (!/utf-?8/i.test(codeset)) env.LANG = 'en_US.UTF-8';

  // Electron leaks nothing here today, but a packaged app relaunching itself can,
  // and ELECTRON_RUN_AS_NODE would make every `node` the user types run as Electron.
  const leaks = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'NODE_OPTIONS'];
  for (const k of leaks) delete env[k];

  for (const k of Object.keys(env)) {
    // SB_SMOKE* is index.js's screenshot harness. It is the app's own scaffolding and
    // has no business in a shell the user is about to type real commands into.
    if (k.indexOf('SB_SMOKE') === 0) delete env[k];
    else if (env[k] === undefined || env[k] === null) delete env[k];
  }
  return env;
}

// ---------------------------------------------------------------------------
// tmux — the process that outlives the app
// ---------------------------------------------------------------------------

// Its own socket, so `tmux` typed anywhere else never sees these sessions and they
// never see the user's. SB_TMUX_SOCKET is for the smoke harness, which must not
// share a server with the app the user may have open at the same time.
const TMUX_SOCKET = process.env.SB_TMUX_SOCKET || 'switchboard';
const TMUX_CONF = path.join(__dirname, 'switchboard.tmux.conf');
const TMUX_MS = 5000;

let tmuxBin;               // undefined: not looked up yet; null: not installed

/** The tmux binary, found once. Homebrew's usual homes are tried after PATH. */
function tmuxPath() {
  if (tmuxBin !== undefined) return tmuxBin;
  tmuxBin = null;
  if (process.env.SWITCHBOARD_NO_TMUX === '1') return null;
  const dirs = String(process.env.PATH || '').split(':').filter(Boolean)
    .concat(['/opt/homebrew/bin', '/usr/local/bin']);
  for (const dir of dirs) {
    const candidate = path.join(dir, 'tmux');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      tmuxBin = candidate;
      break;
    } catch (e) { /* not here */ }
  }
  return tmuxBin;
}

/**
 * One tmux command on our socket. Never rejects: { code, out, err }.
 *
 * `-f` on EVERY command, not on a start-server of its own: the server exits the
 * moment it has no sessions (exit-empty), so whichever command happens to be the
 * one that starts it must be the one carrying the config, or that server comes up
 * on the user's ~/.tmux.conf instead.
 */
function tmux(args) {
  return new Promise((resolve) => {
    const bin = tmuxPath();
    if (!bin) { resolve({ code: 127, out: '', err: 'tmux is not installed' }); return; }
    execFile(bin, ['-L', TMUX_SOCKET, '-f', TMUX_CONF].concat(args), {
      env: buildEnv(), timeout: TMUX_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }, (err, out, errOut) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        out: String(out || ''),
        err: String(errOut || ''),
      });
    });
  });
}

// A session name may not contain '.' or ':'. A workspace id is a folder name and is
// used as it is — and MUST stay so across versions, or the next launch would stop
// finding last week's session. A folder square's id is an absolute path (§4.10): its
// session is the folder's name plus a short hash of the whole path, so two folders
// called `api` are two sessions and the name still reads in `tmux -L switchboard ls`.
function sessionName(wsId) {
  const id = String(wsId);
  if (path.isAbsolute(id)) {
    const hash = crypto.createHash('sha1').update(id).digest('hex').slice(0, 8);
    const base = (path.basename(id) || 'root').replace(/[^A-Za-z0-9_-]/g, '_');
    return 'sb-' + base + '-' + hash;
  }
  return 'sb-' + id.replace(/[^A-Za-z0-9_-]/g, '_');
}

// ---------------------------------------------------------------------------
// Bare-id resolution
// ---------------------------------------------------------------------------

// A terminal's id is either a workspace id — the rail's name for it, whose folder is
// whatever the config declares (`website` lives in `website-landing-v2`) —
// or an absolute path: a folder chosen for a Grid square (§4.10), a terminal and
// nothing else. workspaces.js owns both mappings, so a shell opens in exactly the
// folder discover() listed rather than in a folder merely named after the id.
function isFolderId(id) {
  return path.isAbsolute(String(id === null || id === undefined ? '' : id));
}

async function lookupDir(id) {
  try {
    const workspaces = require('./workspaces.js');
    if (typeof workspaces.dirOf === 'function') return await workspaces.dirOf(id);
  } catch (e) { /* fall through to the old resolution */ }
  try {
    const config = require('./config.js');
    const cfg = typeof config.load === 'function' ? await config.load() : null;
    const root = cfg && cfg.root;
    if (!isFolderId(id) && !root) return null;
    const dir = isFolderId(id) ? String(id) : path.join(root, id);
    return fs.existsSync(dir) ? dir : null;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// One shell
// ---------------------------------------------------------------------------

class Term {
  constructor(opts) {
    this.wsId = opts.wsId;
    this.cwd = opts.cwd;
    this.shellPath = opts.shell;
    // 'tmux': `term` is a tmux client attached to this.session, which holds the real
    // shell and outlives us. 'plain': `term` is the shell itself.
    this.mode = opts.mode === 'tmux' ? 'tmux' : 'plain';
    this.session = this.mode === 'tmux' ? sessionName(opts.wsId) : null;
    this.resumed = false;          // the session was already there when we attached
    this.reattaches = 0;
    this.cols = opts.cols || DEFAULT_COLS;
    this.rows = opts.rows || DEFAULT_ROWS;
    this.onData = opts.onData || function () {};
    this.onExit = opts.onExit || function () {};

    this.ring = new Ring();
    this.status = 'running';
    this.pid = null;
    this.startedAt = null;
    this.exitedAt = null;
    this.exitCode = null;
    this.signal = null;
    this.exited = false;
    this.error = null;
    this.term = null;
    // Set by close(): Switchboard hung this shell up, as opposed to the user typing
    // `exit` or the shell dying on its own. It matters because zsh's exit status after
    // SIGHUP is 1 — verified — so without this a shell the user deliberately closed is
    // indistinguishable from one that crashed, and the Terminal tab paints the red bar.
    this.closed = false;
  }

  /** Throws only if the spawn itself fails; open() turns that into a value. */
  async start() {
    if (this.mode === 'tmux') return this.startTmux();
    // No banner line. runner.js opens with a dim "— name: command —" because a pane
    // shared by two dev servers has to say whose output follows; a login shell must
    // open on the user's own prompt and nothing else.
    //
    // `-l` is the whole point: a login shell reads .zprofile/.zshrc, so the PATH,
    // aliases and prompt are the ones iTerm2 gives — which is what puts `claude`
    // (~/.local/bin/claude) within reach.
    this.term = pty.spawn(this.shellPath, ['-l'], {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: buildEnv(),
    });
    // forkpty() calls setsid(), so the shell is a session leader and its pgid equals
    // its pid — which is what makes the group hangup in close() exact, and what keeps
    // it invisible to runner.js's orphan sweep.
    this.pid = this.term.pid;
    this.startedAt = Date.now();
    this.term.onData((d) => this.emit(d));
    this.term.onExit((e) => this.finish(e ? e.exitCode : null, e ? e.signal : null));
  }

  /**
   * The session first, then a client on it. A session that is already there — the
   * last launch's, Claude still in it — is attached as it is; only a missing one is
   * created, as a login shell in the workspace directory at the pane's size (tmux
   * runs default-shell as a login shell itself). Whichever command starts the
   * server carries the config; source-file afterwards re-reads it into a server
   * that was already up with an older one.
   */
  async startTmux() {
    let r = await tmux(['has-session', '-t', '=' + this.session]);
    this.resumed = r.code === 0;
    if (!this.resumed) {
      // The environment a shell reads at fork, per session rather than per server:
      // COLORFGBG is the appearance NOW, and a server started under a light theme
      // must not hand a dark one to next week's shell. TERM is tmux's own.
      r = await tmux(['new-session', '-d', '-s', this.session, '-c', this.cwd,
        '-x', String(this.cols), '-y', String(this.rows),
        '-e', 'COLORFGBG=' + (appearance === 'light' ? '0;15' : '15;0'),
        '-e', 'TERM_PROGRAM=Switchboard',
        '-e', 'TERM_PROGRAM_VERSION=' + (appVersion || '0')]);
      if (r.code !== 0) throw new Error('tmux could not open a session: ' + (r.err || r.out).trim());
    }
    await tmux(['source-file', TMUX_CONF]);

    // The shell inside and its birth, which is the generation the renderer keys on:
    // a session that is attached again next week has the same startedAt, so the
    // Terminal tab reads it as the same shell it is.
    // `name:` rather than `=name` here: display-message takes a pane target, where the
    // exact-match prefix answers with nothing (measured on tmux 3.7).
    r = await tmux(['display-message', '-p', '-t', this.session + ':', '#{session_created} #{pane_pid}']);
    const m = /^(\d+)\s+(\d+)/.exec(r.out.trim());
    this.startedAt = m ? Number(m[1]) * 1000 : Date.now();
    this.pid = m ? Number(m[2]) : null;
    this.attach();
  }

  /** A client in a fresh pty. tmux paints the whole screen to a new client. */
  attach() {
    // -u forces UTF-8 output regardless of the locale tmux reads at attach: buildEnv
    // now sets a UTF-8 LANG, but the pane is always xterm.js and must never depend on
    // the environment to be drawn correctly.
    const client = pty.spawn(tmuxPath(), ['-u', '-L', TMUX_SOCKET, 'attach-session', '-t', '=' + this.session], {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: buildEnv(),
    });
    this.term = client;
    client.onData((d) => { if (this.term === client) this.emit(d); });
    client.onExit((e) => this.clientExited(client, e));
  }

  /**
   * A client that ended when we did not ask it to. Either the session is gone — the
   * user typed `exit`, and that is this shell's end — or the client alone was
   * detached (a `tmux detach` typed inside, say) and the session is still there, in
   * which case it simply gets a new client. A client we replaced ourselves is not
   * ours any more and says nothing.
   */
  async clientExited(client, e) {
    if (this.term !== client) return;
    this.term = null;
    if (this.exited) return;
    const r = await tmux(['has-session', '-t', '=' + this.session]);
    if (r.code === 0 && !this.exited && this.reattaches < 3) {
      this.reattaches++;
      try { this.attach(); return; } catch (err) { /* fall through to the exit */ }
    }
    this.finish(e ? e.exitCode : null, e ? e.signal : null);
  }

  /**
   * A fresh xterm has asked for the screen (§4.6 sb:term:buffer). The ring buffer
   * would replay everything the old client saw, half-painted TUI frames included;
   * a new client gets the screen as it is now, painted whole by tmux. The old
   * client is dropped first so its exit is not mistaken for the shell's.
   */
  reattach() {
    if (this.mode !== 'tmux' || this.exited) return false;
    const old = this.term;
    this.term = null;
    this.ring = new Ring();
    if (old) { try { old.kill('SIGHUP'); } catch (e) { /* already gone */ } }
    try { this.attach(); return true; } catch (e) { return false; }
  }

  /**
   * Quit. The client goes, the session stays: this is the whole reason tmux is here.
   * SIGHUP to the client is what closing its terminal would send, and a tmux client
   * takes it as detach.
   */
  detach() {
    if (this.mode !== 'tmux') return;
    const client = this.term;
    this.term = null;
    if (client) { try { client.kill('SIGHUP'); } catch (e) { /* already gone */ } }
  }

  emit(chunk) {
    if (!chunk) return;
    this.ring.write(chunk);
    this.onData(chunk);
  }

  finish(code, signal) {
    if (this.exited) return;
    this.exited = true;
    this.status = 'exited';
    // Stamped HERE rather than in the renderer: main is the only side that knows when
    // the pty actually ended. app.js infers RunState.exitedAt from a status flip it
    // happens to witness, which cannot work for a shell that exits while its window is
    // shut — and without it the footer can only ever say 'exited 0', never 'exited 0 · 4s'.
    this.exitedAt = Date.now();
    const sig = signum(signal);
    this.signal = sig || null;
    // runner.js's convention, kept so both terminals read alike: node-pty reports a
    // signal death as exitCode 0, so without this a shell the OOM killer took out
    // looks exactly like the user typing `exit`. The signals a user sends by hand
    // really are a clean stop, and SIGHUP is the one close() itself sends.
    this.exitCode = (sig && !CLEAN_SIGNALS.has(sig))
      ? 128 + sig
      : ((typeof code === 'number') ? code : null);
    this.onExit(this);
  }

  write(data) {
    if (this.exited || data === undefined || data === null) return false;
    try {
      if (this.term) { this.term.write(String(data)); return true; }
    } catch (e) { /* the shell died between the check and the write */ }
    return false;
  }

  resize(cols, rows) {
    this.cols = cols || this.cols;
    this.rows = rows || this.rows;
    if (this.exited || !this.term) return false;
    try { this.term.resize(this.cols, this.rows); return true; } catch (e) { return false; }
  }

  /**
   * A terminal's teardown, and nothing more.
   *
   * SIGHUP the process group — the pgid is this shell's own pid, so the signal
   * reaches zsh and everything it is running, which is precisely what closing a
   * terminal window does — then SIGKILL the group if it is still there two seconds
   * later. That is all.
   *
   * Emphatically NOT runner.js's teardown: no census, no orphan sweep, no port
   * sweep. Those exist because a dev server daemonises children the app is
   * responsible for. A login shell's children are the USER'S, and killing them by
   * cwd or by port is how you SIGKILL the editor they left running in this folder.
   */
  async close() {
    this.closed = true;
    if (this.mode === 'tmux') {
      // Ending the session ends the shell and everything in it, the way SIGHUP to the
      // group does below — and the client then leaves on its own, which clientExited()
      // turns into the exit. A client that lingers is hung up as a last resort.
      await tmux(['kill-session', '-t', '=' + this.session]);
      const t0 = Date.now();
      while (!this.exited && Date.now() - t0 < HUP_GRACE_MS) await sleep(50);
      if (!this.exited) {
        const client = this.term;
        this.term = null;
        if (client) { try { client.kill('SIGHUP'); } catch (e) { /* already gone */ } }
        this.finish(null, 1);
      }
      return;
    }
    const pid = this.pid;
    if (!pid) { this.finish(null, null); return; }

    try { process.kill(-pid, 'SIGHUP'); } catch (e) { /* ESRCH: it already went */ }

    const t0 = Date.now();
    while (!this.exited && Date.now() - t0 < HUP_GRACE_MS) await sleep(50);

    if (!this.exited) {
      try { process.kill(-pid, 'SIGKILL'); } catch (e) { /* it already went */ }
      const t1 = Date.now();
      while (!this.exited && Date.now() - t1 < KILL_GRACE_MS) await sleep(50);
    }

    // node-pty's own kill() is process.kill(pid, 'SIGHUP') with a POSITIVE pid, so it
    // only ever reaches the shell itself. Last resort, and really to release the pty
    // file descriptors.
    try { if (this.term) this.term.kill(); } catch (e) { /* it already went */ }

    // onExit never arrives if the pty fd was closed under us, and the record still has
    // to read as exited — states() is what the Terminal tab draws its footer from.
    if (!this.exited) this.finish(null, 1);
  }

  /** ARCHITECTURE §2, field for field. */
  state() {
    return {
      wsId: this.wsId,
      status: this.status,
      pid: this.pid,
      startedAt: this.startedAt,
      exitedAt: this.exitedAt,
      exitCode: this.exitCode,
      signal: this.signal,
      cwd: this.cwd,
      shell: this.shellPath,
      pty: !!pty,
      closed: this.closed,
      persistent: this.mode === 'tmux',   // it outlives the app; see the header comment
      error: this.error,
    };
  }
}

// ---------------------------------------------------------------------------
// The singleton
// ---------------------------------------------------------------------------

class Shells extends EventEmitter {
  constructor() {
    super();
    this.terms = new Map();
    // wsId -> { cols, rows }: the last size the renderer reported for that
    // workspace's pane, kept even when no shell is running so the NEXT open() spawns
    // at the size the pane already is. Same reason runner.js keeps this.sizes.
    this.sizes = new Map();
  }

  /** Whether a terminal is possible at all, for whoever wants to say so in the UI. */
  info() {
    return { pty: !!pty, ptyError: pty ? null : ptyError, tmux: !!tmuxPath() };
  }

  /**
   * { id, dir } out of whatever index.js hands us — a Workspace, a bare { id }, or a
   * bare id string resolved through config.js the way runner.lookup() does.
   */
  async resolve(ws) {
    let id = null;
    let dir = null;
    if (typeof ws === 'string') {
      id = ws.trim();
    } else if (ws && typeof ws === 'object') {
      id = typeof ws.id === 'string' ? ws.id.trim() : null;
      dir = (typeof ws.dir === 'string' && ws.dir) ? ws.dir : null;
    }
    if (!id) return { error: 'the terminal needs a workspace id' };
    if (!dir) {
      dir = await lookupDir(id);
      if (!dir) {
        return {
          error: isFolderId(id)
            ? 'that folder is not there any more: ' + id
            : 'unknown workspace "' + id + '"',
        };
      }
    }
    if (!fs.existsSync(dir)) {
      return { error: (isFolderId(id) ? 'that folder is not there any more: ' : 'workspace directory is missing: ') + dir };
    }
    return { id, dir };
  }

  /**
   * open(ws, {cols, rows}) -> { ok:true, state: Shell } | { ok:false, error }
   *
   * Idempotent, because the Terminal tab calls it on every render: a live shell comes
   * back untouched, with its scrollback and whatever is running in it intact. The size
   * is the one thing that may legitimately have changed since, so it is always applied.
   */
  async open(ws, opts) {
    const o = opts || {};
    const resolved = await this.resolve(ws);
    if (resolved.error) return { ok: false, error: resolved.error };
    const wsId = resolved.id;

    const last = this.sizes.get(wsId) || { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
    const cols = intOr(o.cols, last.cols);
    const rows = intOr(o.rows, last.rows);
    this.sizes.set(wsId, { cols, rows });

    const live = this.terms.get(wsId);
    if (live && !live.exited) {
      live.resize(cols, rows);
      return { ok: true, state: live.state() };
    }

    if (!pty) {
      // No child_process.spawn fallback, unlike runner.js. A pipe has no line
      // discipline and no job control: ^C would not interrupt, zsh would not even
      // draw a prompt, and Claude Code's full-screen TUI would not run at all. One
      // honest sentence beats a terminal that looks present and does nothing.
      return {
        ok: false,
        error: 'the terminal needs node-pty, which did not load (' +
          (ptyError || 'unknown reason') + ')',
      };
    }

    const term = new Term({
      wsId,
      cwd: resolved.dir,
      shell: process.env.SHELL || '/bin/zsh',
      mode: tmuxPath() ? 'tmux' : 'plain',
      cols,
      rows,
      onData: (chunk) => this.emit('data', wsId, chunk),
      onExit: (t) => this.emit('state', t.state()),
    });
    // Replaces the exited record §5 M6 asks us to keep: it is kept so the Terminal
    // tab can draw its "New shell" footer, and this IS that new shell.
    this.terms.set(wsId, term);

    try {
      await term.start();
    } catch (e) {
      const message = 'could not open a shell in ' + resolved.dir + ': ' +
        ((e && e.message) || String(e));
      term.status = 'exited';
      term.exited = true;
      term.error = message;
      // Recorded rather than merely returned, so that after a renderer reload
      // shellStates() still says why that workspace's terminal is dead. The no-pty
      // case above gets no record on purpose: nothing workspace-specific happened,
      // every workspace would hold an identical copy, and info() already says it once.
      this.emit('state', term.state());
      return { ok: false, error: message };
    }

    this.emit('state', term.state());
    return { ok: true, state: term.state() };
  }

  write(wsId, data) {
    const term = this.terms.get(wsId);
    if (!term || term.exited) return { ok: false, error: 'no shell is open for ' + wsId };
    if (!term.write(data)) {
      return { ok: false, error: 'the shell in ' + wsId + ' is not accepting input' };
    }
    return { ok: true };
  }

  /**
   * The renderer is the only thing that knows how big the pane really is, so it has
   * to say — otherwise zsh wraps at the wrong column and Claude Code lays its TUI out
   * for a terminal that is not the one on screen.
   */
  resize(wsId, cols, rows) {
    if (!wsId) return { ok: false, error: 'resize needs a workspace id' };
    const c = Number(cols);
    const r = Number(rows);
    if (!Number.isInteger(c) || !Number.isInteger(r) || c < 2 || r < 2) {
      return { ok: false, error: 'resize needs a column and row count' };
    }
    this.sizes.set(wsId, { cols: c, rows: r });
    const term = this.terms.get(wsId);
    if (!term || term.exited) return { ok: false, error: 'no shell is open for ' + wsId };
    term.resize(c, r);
    return { ok: true };
  }

  /**
   * The ring buffer, for replay into a fresh xterm. Never an error: '' is the honest
   * answer for a workspace whose terminal has not been opened yet, and the renderer
   * would have nothing else to do with an error here anyway.
   */
  buffer(wsId) {
    const term = this.terms.get(wsId);
    if (!term) return { ok: true, text: '' };
    // A live tmux-backed shell answers with a repaint instead of a replay: the fresh
    // pane gets a fresh client, and tmux draws the screen as it is now into it. The
    // text arrives as ordinary output, so '' is the honest replay.
    if (term.mode === 'tmux' && !term.exited && term.reattach()) return { ok: true, text: '' };
    return { ok: true, text: term.ring.toString() };
  }

  /** Always { ok:true }: "there is no shell open" is the outcome close() asked for. */
  async close(wsId) {
    const term = this.terms.get(wsId);
    if (!term || term.exited) return { ok: true };
    try {
      await term.close();
    } catch (e) { /* every step inside close() already swallows its own ESRCH */ }
    return { ok: true };
  }

  state(wsId) {
    const term = this.terms.get(wsId);
    return term ? term.state() : null;
  }

  /** Every shell this process has opened, keyed by id — including exited ones, which
   *  is what lets the Terminal tab adopt them after a renderer reload. */
  states() {
    const out = {};
    for (const [id, term] of this.terms) out[id] = term.state();
    return out;
  }

  /**
   * app.before-quit. A shell inside tmux is detached and lives on — that is what
   * tmux is here for — so the next launch finds it where it was. A shell without
   * tmux is hung up exactly as closing an iTerm2 window does; Claude Code survives
   * that too, with `claude --continue` in the next one.
   */
  async closeAll() {
    const live = [...this.terms.values()].filter((t) => !t.exited);
    const results = await Promise.all(live.map(async (term) => {
      try {
        if (term.mode === 'tmux') term.detach();
        else await term.close();
        return { wsId: term.wsId, ok: true };
      } catch (e) {
        return { wsId: term.wsId, ok: false, error: (e && e.message) || String(e) };
      }
    }));
    return { ok: results.every((r) => r.ok), results };
  }

  /**
   * The resolved terminal appearance, for COLORFGBG. Takes effect on the NEXT shell
   * spawned — an environment cannot be rewritten after fork — so a running shell is
   * deliberately left alone rather than restarted under the user.
   */
  setAppearance(name) {
    appearance = name === 'light' ? 'light' : 'dark';
    return appearance;
  }
}

const shells = new Shells();

module.exports = shells;
