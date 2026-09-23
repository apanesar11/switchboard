'use strict';

// git.js — every git command Switchboard runs. ARCHITECTURE §5 M3.
//
// Rules that hold for the whole file:
//   * execFile, never a shell. No user string is ever concatenated into a command.
//   * Nothing throws. Every export resolves to a value; failures come back as
//     `{ ok: false, error: '<human sentence>' }` or as nulls meaning "unknown".
//   * The only command here that writes anything the user can see is pullMain().
//     Everything else is read-only; fetch() touches refs/remotes + FETCH_HEAD only.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const GIT_ENV = Object.assign({}, process.env, {
  // A credential prompt inside an Electron child has no terminal and would hang forever.
  GIT_TERMINAL_PROMPT: '0',
  // Read-only calls must never take index.lock or rewrite the index while the user
  // is mid-command in their own terminal.
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  // pullMain() matches git's English messages, so pin the locale.
  LC_ALL: 'C.UTF-8',
});

const MAX_BUFFER = 16 * 1024 * 1024;
const PATCH_MAX_LINES = 2000;          // ARCHITECTURE §4.3
const UNTRACKED_STAT_MAX_BYTES = 2 * 1024 * 1024;
const UNTRACKED_STAT_MAX_FILES = 300;  // a stray un-ignored build dir must not stall a scan
const ALL_DIFFS_MAX_FILES = 200;
const ALL_DIFFS_CONCURRENCY = 8;

// A warm fetch against github.com measures 0.55–0.76 s per repo. Ten seconds is ~13x that:
// long enough that a slow link still succeeds, short enough that a dead one cannot make the
// user think the app has hung.
const FETCH_TIMEOUT_MS = 10000;
// Remote-tracking refs older than this are treated as "we do not actually know": every
// behind-count and every "up to date" derived from them is a guess at that point.
const STALE_AFTER_MS = 10 * 60 * 1000;

/** Run git in `dir`. Never rejects: resolves {code, stdout, stderr, overflow}. */
function run(dir, args, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', dir].concat(args),
      {
        env: GIT_ENV,
        maxBuffer: o.maxBuffer || MAX_BUFFER,
        timeout: o.timeout || 20000,
        encoding: 'utf8',
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: stdout || '',
          stderr: stderr || '',
          overflow: !!(err && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'),
          timedOut: !!(err && err.killed),
        });
      }
    );
  });
}

/** First non-empty line of git's stderr, as a sentence the user can read. */
function sentence(r, fallback) {
  const line = String(r.stderr || '')
    .split('\n')
    .map((s) => s.trim())
    .find(Boolean);
  if (!line) return fallback;
  const clean = line.replace(/^(fatal|error|warning):\s*/i, '');
  return /[.!?]$/.test(clean) ? clean : clean + '.';
}

/** Split a NUL-delimited stream into fields, dropping the trailing empty one. */
function nulFields(s) {
  const parts = s.split('\0');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(new Array(Math.min(limit, items.length)).fill(0).map(worker));
  return out;
}

// ---------------------------------------------------------------------------
// status (porcelain v2) — branch, detached, upstream, ahead/behind and every
// changed path from ONE process.
//
// -z is MANDATORY: without it git C-quotes any path holding a space or a
// non-ASCII byte, inconsistently between commands, and there is no safe way to
// unquote afterwards.
// -uall is MANDATORY for the file list: the default -unormal collapses an
// untracked directory into a single "? sub/" entry with no per-file counts.
//
// Headers: "# branch.oid <sha>|(initial)", "# branch.head <name>|(detached)",
// "# branch.upstream <name>" and "# branch.ab +N -M" — the last two are ABSENT,
// not empty, when the branch has no upstream.
// ---------------------------------------------------------------------------
async function readStatus(dir, opts) {
  const untracked = (opts && opts.untracked) || 'all';
  const r = await run(dir, [
    'status', '--porcelain=v2', '--branch', '-z',
    untracked === 'all' ? '-uall' : '-uno',
    '--ignore-submodules=dirty',
  ]);
  if (r.code !== 0) {
    return { ok: false, error: sentence(r, 'git status failed in ' + path.basename(dir) + '.'), records: [] };
  }

  const out = {
    ok: true,
    error: null,
    branch: null,
    detached: false,
    head: null,
    unborn: false,
    upstream: null,
    ahead: null,
    behind: null,
    records: [],
  };

  const fields = nulFields(r.stdout);
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (rec.startsWith('# ')) {
      const sp = rec.indexOf(' ', 2);
      const key = sp === -1 ? rec.slice(2) : rec.slice(2, sp);
      const val = sp === -1 ? '' : rec.slice(sp + 1);
      if (key === 'branch.oid') {
        out.unborn = val === '(initial)';
        out.head = out.unborn ? null : val;
      } else if (key === 'branch.head') {
        out.detached = val === '(detached)';
        out.branch = out.detached ? null : val;
      } else if (key === 'branch.upstream') {
        out.upstream = val;
      } else if (key === 'branch.ab') {
        const ab = val.match(/^\+(\d+)\s+-(\d+)$/);
        if (ab) { out.ahead = Number(ab[1]); out.behind = Number(ab[2]); }
      }
      continue;
    }
    const kind = rec[0];
    if (kind === '?') {
      out.records.push({ path: rec.slice(2), oldPath: null, xy: '??', untracked: true });
    } else if (kind === '1') {
      const p = rec.split(' ');
      out.records.push({ path: p.slice(8).join(' '), oldPath: null, xy: p[1], untracked: false });
    } else if (kind === '2') {
      // Rename/copy: the path is field 9+, and the VERY NEXT NUL field is the old
      // path. Note this is NEW-then-OLD; `git diff --numstat -z` is the reverse.
      const p = rec.split(' ');
      const newPath = p.slice(9).join(' ');
      const oldPath = fields[++i];
      out.records.push({ path: newPath, oldPath: oldPath === undefined ? null : oldPath, xy: p[1], untracked: false });
    } else if (kind === 'u') {
      const p = rec.split(' ');
      out.records.push({ path: p.slice(10).join(' '), oldPath: null, xy: p[1], untracked: false });
    }
    // '!' = ignored, only emitted with --ignored, which we never pass.
  }
  return out;
}

function isMainName(branch) {
  return branch === 'main' || branch === 'master';
}

function branchFields(st) {
  return {
    branch: st.branch,
    detached: st.detached,
    head: st.head,
    unborn: st.unborn,
    onMain: isMainName(st.branch),
    upstream: st.upstream,
    ahead: st.ahead,
    behind: st.behind,
  };
}

/**
 * branchInfo(dir) → { ok, error, branch, detached, head, unborn, onMain,
 *                     upstream, ahead, behind, dirty }
 * `ahead`/`behind` are against the configured upstream and are null — never 0 —
 * when there is no upstream, because 0/0 reads as "in sync" and would be a lie.
 * `dirty` counts tracked modifications only; untracked files do not block a pull.
 */
async function branchInfo(dir) {
  const st = await readStatus(dir, { untracked: 'no' });
  if (!st.ok) {
    return {
      ok: false, error: st.error, branch: null, detached: false, head: null,
      unborn: false, onMain: false, upstream: null, ahead: null, behind: null, dirty: 0,
    };
  }
  return Object.assign({ ok: true, error: null }, branchFields(st), { dirty: st.records.length });
}

// ---------------------------------------------------------------------------
// divergence
// ---------------------------------------------------------------------------

/**
 * divergence(dir, branch) → { ok, error, ref, ahead, behind }
 * Compares HEAD against origin/<branch> when that ref exists, else origin/main,
 * else origin/master. A missing ref is a FATAL exit (128) for rev-list, not empty
 * output, so every candidate is guarded with `rev-parse --verify --quiet` first.
 * When nothing to compare against exists, ahead/behind are null = unknown.
 */
async function divergence(dir, branch) {
  const candidates = [];
  if (branch) candidates.push('origin/' + branch);
  for (const ref of ['origin/main', 'origin/master']) {
    if (candidates.indexOf(ref) === -1) candidates.push(ref);
  }
  for (const ref of candidates) {
    const exists = await run(dir, ['rev-parse', '--verify', '--quiet', ref + '^{commit}']);
    if (exists.code !== 0) continue;
    // `A...B` (three dots) prints exactly "<left>\t<right>": left = ahead, right = behind.
    const r = await run(dir, ['rev-list', '--left-right', '--count', 'HEAD...' + ref]);
    if (r.code !== 0) continue;
    const parts = r.stdout.trim().split('\t');
    if (parts.length !== 2) continue;
    return { ok: true, error: null, ref, ahead: Number(parts[0]), behind: Number(parts[1]) };
  }
  return { ok: true, error: null, ref: null, ahead: null, behind: null };
}

// ---------------------------------------------------------------------------
// changes
// ---------------------------------------------------------------------------

/**
 * `git diff HEAD --numstat -z -M` for tracked changes.
 *   normal : "<add>\t<del>\t<path>\0"
 *   rename : "<add>\t<del>\t\0<OLD>\0<NEW>\0"  — OLD first, after an EMPTY path
 *            field. That is the OPPOSITE order from `git status -z`.
 *   binary : both counts are literally "-" (never parseInt them).
 * Exits 128 on an unborn HEAD; an empty map is the right answer there.
 */
async function readNumstat(dir) {
  const map = new Map();
  const r = await run(dir, ['diff', 'HEAD', '--numstat', '-z', '--no-color', '--ignore-submodules=dirty', '-M']);
  if (r.code !== 0) return map;
  const fields = nulFields(r.stdout);
  for (let i = 0; i < fields.length; i++) {
    const m = fields[i].match(/^(\d+|-)\t(\d+|-)\t([\s\S]*)$/);
    if (!m) continue;
    const binary = m[1] === '-';
    let p = m[3];
    let oldPath = null;
    if (p === '') { oldPath = fields[++i]; p = fields[++i]; }
    if (p === undefined) break;
    map.set(p, { add: binary ? 0 : Number(m[1]), del: binary ? 0 : Number(m[2]), binary, oldPath: oldPath || null });
  }
  return map;
}

/**
 * Line counts for ONE untracked file:
 *   git diff --no-index --numstat -z -- /dev/null <file>
 * EXIT 1 MEANS SUCCESS here (the two inputs differ). Exit 0 means identical,
 * exit > 1 is a real error. The output always uses the three-field rename layout
 * because /dev/null → path reads as a path change.
 * `git add -N` would also work and is forbidden: it mutates the user's index.
 */
async function untrackedNumstat(dir, relPath) {
  let size = 0;
  try {
    size = fs.statSync(path.join(dir, relPath)).size;
  } catch (e) {
    return null;
  }
  if (size > UNTRACKED_STAT_MAX_BYTES) return { add: 0, del: 0, binary: false };
  const r = await run(dir, ['diff', '--no-index', '--numstat', '-z', '--no-color', '--', '/dev/null', relPath]);
  if (r.code > 1) return null;
  const fields = nulFields(r.stdout);
  if (!fields.length) return { add: 0, del: 0, binary: false };
  const m = fields[0].match(/^(\d+|-)\t(\d+|-)\t/);
  if (!m) return null;
  const binary = m[1] === '-';
  return { add: binary ? 0 : Number(m[1]), del: binary ? 0 : Number(m[2]), binary };
}

/** GitHub's precedence: rename beats delete beats add beats modify. */
function statusLetter(rec) {
  if (rec.untracked) return '?';
  const x = rec.xy[0];
  const y = rec.xy[1];
  if (x === 'R' || y === 'R' || x === 'C' || y === 'C') return 'R';
  if (x === 'D' || y === 'D') return 'D';
  if (x === 'A') return 'A';
  return 'M';
}

/**
 * changes(dir) → { ok, error, branch: {…}, files: [FileChange], add, del }
 * FileChange = { path, status, add, del, binary, oldPath } per ARCHITECTURE §2.
 * `branch` carries the same fields branchInfo() returns, so a caller that wants
 * both pays for only one `git status`.
 */
async function changes(dir) {
  const [st, numstat] = await Promise.all([readStatus(dir, { untracked: 'all' }), readNumstat(dir)]);
  if (!st.ok) {
    return {
      ok: false,
      error: st.error,
      branch: { branch: null, detached: false, head: null, unborn: false, onMain: false, upstream: null, ahead: null, behind: null },
      files: [],
      add: 0,
      del: 0,
    };
  }

  const files = [];
  let add = 0;
  let del = 0;
  let untrackedBudget = UNTRACKED_STAT_MAX_FILES;

  for (const rec of st.records) {
    let stat = null;
    if (rec.untracked) {
      if (untrackedBudget-- > 0) stat = await untrackedNumstat(dir, rec.path);
    } else {
      stat = numstat.get(rec.path) || null;
      // `git status` and `git diff -M` can disagree on rename detection, so a
      // rename's new path may be absent from the numstat map.
      if (!stat && rec.oldPath) stat = numstat.get(rec.oldPath) || null;
    }
    const fileAdd = stat ? stat.add : 0;
    const fileDel = stat ? stat.del : 0;
    add += fileAdd;
    del += fileDel;
    const status = statusLetter(rec);
    files.push({
      path: rec.path,
      status,
      add: fileAdd,
      del: fileDel,
      binary: !!(stat && stat.binary),
      oldPath: status === 'R' ? rec.oldPath : null,
    });
  }

  return { ok: true, error: null, branch: branchFields(st), files, add, del };
}

// ---------------------------------------------------------------------------
// diffs
// ---------------------------------------------------------------------------

/**
 * Keep the unified diff BODY — hunk headers and their lines — and drop the
 * `diff --git` / `index` / `similarity` / `---` / `+++` preamble (ARCHITECTURE §4.3).
 * A body line never starts at column 0 with "@@ " (context lines are prefixed
 * with a space, added lines with '+'), so the first such line is the body start.
 */
function patchBody(text) {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('@@ ')) { start = i; break; }
  }
  if (start === -1) return { patch: '', truncated: false };
  let body = lines.slice(start);
  const truncated = body.length > PATCH_MAX_LINES;
  if (truncated) body = body.slice(0, PATCH_MAX_LINES);
  return { patch: body.join('\n'), truncated };
}

function looksBinary(text) {
  return /^Binary files .* differ$/m.test(text) || /^GIT binary patch$/m.test(text);
}

/**
 * One `git status` so fileDiff() can be called with nothing but a path and still
 * know whether the file is untracked and what its pre-rename path was. Roughly
 * 14 ms even on the 1 GB repo here. Returns null when the path is not in status.
 */
async function probePath(dir, relPath) {
  const st = await readStatus(dir, { untracked: 'all' });
  if (!st.ok) return null;
  for (const rec of st.records) {
    if (rec.path === relPath) return { untracked: rec.untracked, oldPath: rec.oldPath };
  }
  return null;
}

/**
 * fileDiff(dir, path, { untracked, oldPath, context, probe })
 *   → { ok, error, patch, binary, truncated }
 *
 * `patch` is the diff body only; a binary file has an empty patch and binary:true;
 * anything past 2000 lines is cut with truncated:true.
 *
 * Two traps handled here:
 *  - `git diff HEAD -- <newPath>` on a RENAMED file silently loses the pairing and
 *    renders the whole file as a new addition. Both paths must be passed with -M.
 *  - `--no-index` returns EXIT 1 on success (the files differ), so the guard is
 *    `code > 1`, never `code !== 0`.
 */
async function fileDiff(dir, relPath, opts) {
  const o = opts || {};
  const context = typeof o.context === 'number' ? o.context : 3;
  let untracked = o.untracked === true;
  let oldPath = o.oldPath || null;

  if (o.probe !== false) {
    const probed = await probePath(dir, relPath);
    if (probed) {
      untracked = probed.untracked;
      oldPath = probed.oldPath;
    }
  }

  // core.quotePath=false keeps non-ASCII paths raw in the ---/+++ headers.
  const base = ['-c', 'core.quotePath=false', 'diff', '--no-color', '-U' + context];
  const args = untracked
    ? base.concat(['--no-index', '--', '/dev/null', relPath])
    : base.concat(['HEAD', '-M', '--ignore-submodules=dirty', '--'], oldPath ? [oldPath, relPath] : [relPath]);

  const r = await run(dir, args);
  if (r.overflow) {
    return { ok: false, error: 'This diff is too large to display.', patch: '', binary: false, truncated: true };
  }
  if (untracked ? r.code > 1 : r.code !== 0) {
    return { ok: false, error: sentence(r, 'Could not read the diff for ' + relPath + '.'), patch: '', binary: false, truncated: false };
  }

  const binary = looksBinary(r.stdout);
  const body = patchBody(r.stdout);
  return { ok: true, error: null, patch: binary ? '' : body.patch, binary, truncated: binary ? false : body.truncated };
}

/**
 * allDiffs(dir) → { ok, error, files: [{ path, status, oldPath, add, del, patch,
 *                   binary, truncated, error }], omitted }
 * One diff process per changed file, eight at a time. Capped at 200 files;
 * `omitted` says how many were left out.
 */
async function allDiffs(dir) {
  const ch = await changes(dir);
  if (!ch.ok) return { ok: false, error: ch.error, files: [], omitted: 0 };

  const wanted = ch.files.slice(0, ALL_DIFFS_MAX_FILES);
  const files = await mapLimit(wanted, ALL_DIFFS_CONCURRENCY, async (f) => {
    const d = await fileDiff(dir, f.path, { untracked: f.status === '?', oldPath: f.oldPath, probe: false });
    return {
      path: f.path,
      status: f.status,
      oldPath: f.oldPath,
      add: f.add,
      del: f.del,
      patch: d.patch,
      binary: d.binary || f.binary,
      truncated: d.truncated,
      error: d.ok ? null : d.error,
    };
  });

  return { ok: true, error: null, files, omitted: ch.files.length - wanted.length };
}

// ---------------------------------------------------------------------------
// pull main
// ---------------------------------------------------------------------------

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

/**
 * pullMain(dir) → { ok, reason, message, from, to, commits }
 *
 * `message` is always one sentence, ready to render.
 *
 * The gate is not optional: on a FEATURE branch `git pull --ff-only origin main`
 * does not refuse — it quietly fast-forwards or merges main INTO that branch and
 * exits 0 with "Already up to date." So we refuse anywhere but main/master, and
 * refuse on tracked modifications (untracked files are harmless).
 */
async function pullMain(dir) {
  const st = await readStatus(dir, { untracked: 'no' });
  if (!st.ok) return { ok: false, reason: 'status-failed', message: st.error, from: null, to: null, commits: 0 };

  if (st.detached) {
    const at = st.head ? st.head.slice(0, 7) : 'an unknown commit';
    return { ok: false, reason: 'detached', message: 'Skipped — HEAD is detached at ' + at + '.', from: null, to: null, commits: 0 };
  }
  if (!isMainName(st.branch)) {
    return { ok: false, reason: 'wrong-branch', message: 'Skipped — this repo is on ' + st.branch + ', not main.', from: null, to: null, commits: 0 };
  }
  // A dirty tree is NOT refused here. `git pull --ff-only` only fails when the
  // incoming commits actually touch a file that was edited locally, and it says
  // so — the "would be overwritten by merge" branch below turns that into a
  // sentence. Refusing up front would block the common case: a repo on main
  // carrying an unrelated local edit (dev.sh rewrites sample-api/.env.local on
  // every run) that fast-forwards perfectly well.

  // -c advice.diverging=false suppresses six lines of hint noise on the diverged path.
  const r = await run(dir, ['-c', 'advice.diverging=false', 'pull', '--ff-only', '--no-tags', 'origin', st.branch], { timeout: 120000 });
  // `git pull` writes "From <url>" to STDERR even on complete success, so a
  // non-empty stderr is not an error signal for this command — only the exit code is.
  const all = r.stdout + '\n' + r.stderr;

  if (r.code === 0) {
    const m = all.match(/^Updating ([0-9a-f]+)\.\.([0-9a-f]+)$/m);
    if (m) {
      const count = await run(dir, ['rev-list', '--count', m[1] + '..' + m[2]]);
      const n = count.code === 0 ? Number(count.stdout.trim()) : 0;
      return {
        ok: true,
        reason: 'fast-forwarded',
        message: n > 0 ? 'Fast-forwarded ' + plural(n, 'commit') + '.' : 'Fast-forwarded to the latest origin/' + st.branch + '.',
        from: m[1],
        to: m[2],
        commits: n,
      };
    }
    return { ok: true, reason: 'up-to-date', message: 'Already up to date.', from: null, to: null, commits: 0 };
  }

  let reason = 'failed';
  let message;
  if (/Not possible to fast-forward/.test(all)) {
    reason = 'diverged';
    message = 'Could not fast-forward — ' + st.branch + ' has diverged from origin.';
  } else if (/would be overwritten by merge/.test(all)) {
    reason = 'dirty';
    message = 'Could not pull — local changes would be overwritten; commit or stash first.';
  } else if (/Could not resolve host|Connection refused|Could not resolve proxy|timed out|Network is unreachable/i.test(all)) {
    reason = 'offline';
    message = 'Could not reach origin — check your network.';
  } else if (/Authentication failed|could not read Username|Permission denied|403 Forbidden/i.test(all)) {
    reason = 'auth';
    message = 'GitHub rejected the request — check your git credentials.';
  } else {
    message = sentence(r, 'git pull exited ' + r.code + '.');
  }
  return { ok: false, reason, message, from: null, to: null, commits: 0 };
}

// ---------------------------------------------------------------------------
// remote
// ---------------------------------------------------------------------------

/**
 * owner/repo out of any remote URL shape seen on this machine and the obvious
 * others: https, scp-style git@host:o/r, ssh://, git://, embedded credentials,
 * a trailing slash, and with or without the .git suffix.
 */
function parseRemoteUrl(url) {
  if (!url) return null;
  let s = String(url).trim().replace(/\/+$/, '');
  s = s.replace(/^[a-zA-Z0-9._-]+::/, ''); // transport helper prefix
  let host = null;
  let pathPart = null;
  let m = s.match(/^[a-z+]+:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i);
  if (m) {
    host = m[1];
    pathPart = m[2];
  } else {
    m = s.match(/^(?:[^@]+@)?([^/:]+):(.+)$/);
    if (m) { host = m[1]; pathPart = m[2]; }
  }
  if (!pathPart) return null;
  pathPart = pathPart.replace(/\.git$/i, '');
  const seg = pathPart.split('/').filter(Boolean);
  if (seg.length < 2) return null;
  const owner = seg[seg.length - 2];
  const repo = seg[seg.length - 1];
  return { owner, repo, nameWithOwner: owner + '/' + repo, host: host ? host.toLowerCase() : null, url: s };
}

/**
 * originUrl(dir) → the raw URL configured for `origin`, or null when there is no such remote.
 *
 * Kept separate from remoteInfo() because the two answer different questions. remoteInfo()
 * says "which GitHub repo is this", and is null for a remote whose URL names no owner/repo —
 * a local path, a plain `file://`. This one says "is there anything to fetch from at all",
 * which those remotes very much are.
 */
async function originUrl(dir, remote) {
  const r = await run(dir, ['remote', 'get-url', remote || 'origin']);
  if (r.code !== 0) return null;
  return r.stdout.trim() || null;
}

/** remoteInfo(dir) → { owner, repo, nameWithOwner, host, url } or null. */
async function remoteInfo(dir, remote) {
  return parseRemoteUrl(await originUrl(dir, remote));
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

/**
 * The repo's git dir, and the COMMON git dir shared with its worktrees. They differ inside a
 * worktree, where `.git` is a FILE holding `gitdir: <path>`: FETCH_HEAD is per-worktree and
 * lives in the first, refs live in the second.
 */
function gitDirs(dir) {
  const dotGit = path.join(dir, '.git');
  let st;
  try { st = fs.statSync(dotGit); } catch (e) { return null; }
  let gitDir = dotGit;
  if (!st.isDirectory()) {
    let pointer;
    try { pointer = fs.readFileSync(dotGit, 'utf8'); } catch (e) { return null; }
    const m = pointer.match(/^gitdir:\s*(.+)$/m);
    if (!m) return null;
    gitDir = path.resolve(dir, m[1].trim());
  }
  let commonDir = gitDir;
  try {
    const common = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    if (common) commonDir = path.resolve(gitDir, common);
  } catch (e) { /* not a worktree */ }
  return { gitDir, commonDir };
}

function statOf(file) {
  try { return fs.statSync(file); } catch (e) { return null; }
}

/**
 * lastFetch(dir) → epoch ms of the last time this repo SUCCESSFULLY talked to its remote, or
 * null when it never has. Pure fs, ~0.02 ms — cheap enough to run on every scan.
 *
 * `git fetch` and `git pull` both stamp FETCH_HEAD, so its mtime is exactly "how old are the
 * remote-tracking refs the behind-counts are computed from".
 *
 * Two traps, both verified here:
 *  - A fetch that never reaches the remote still TRUNCATES FETCH_HEAD to zero bytes and
 *    stamps its mtime to now. Taking that at face value would report a repo as freshly
 *    checked at the exact moment we failed to check it — the precise lie this field exists to
 *    stop — so an empty FETCH_HEAD counts as no evidence at all.
 *  - A fresh clone writes no FETCH_HEAD, so packed-refs / refs/remotes/origin stand in for
 *    the clone itself; otherwise a just-cloned repo would report unknown age when it is in
 *    fact perfectly current. Those only move when a ref does, so they under-report rather
 *    than over-report freshness — the safe direction, since it asks for a refresh.
 */
function lastFetch(dir) {
  const dirs = gitDirs(dir);
  if (!dirs) return null;
  const head = statOf(path.join(dirs.gitDir, 'FETCH_HEAD'));
  if (head && head.size > 0) return Math.round(head.mtimeMs);
  let best = null;
  for (const file of [path.join(dirs.commonDir, 'packed-refs'),
                      path.join(dirs.commonDir, 'refs', 'remotes', 'origin')]) {
    const st = statOf(file);
    if (st && (best === null || st.mtimeMs > best)) best = st.mtimeMs;
  }
  return best === null ? null : Math.round(best);
}

/**
 * fetch(dir, { timeout }) → { ok, error, ms, timedOut, at }
 *
 * Behind-counts are frozen at the last fetch, so they lie until this runs — reproduced here:
 * a clone whose origin had moved on by three commits reported 0 behind before this call and
 * 3 behind after, in the same second.
 *
 * Every flag here is about not touching anything the user can see, and not costing more than
 * the refs are worth:
 *   --no-tags                 nothing but the branches we already track
 *   --no-recurse-submodules   a repo with `fetch.recurseSubmodules = true` configured would
 *                             otherwise drag every submodule's remote along with it
 *   -c gc.auto=0              a fetch can trip git's automatic gc, which repacks the object
 *                             store — unbounded work nobody asked for, in the middle of a scan
 *   GIT_TERMINAL_PROMPT=0     (from GIT_ENV) a credential prompt inside an Electron child has
 *                             no terminal and would block until the timeout
 * What is left writes refs/remotes and FETCH_HEAD and nothing else — never the working tree,
 * never the index — which is why this is safe to run unattended on the user's repos.
 *
 * Roughly 0.6–0.8 s per repo against github.com. Run them in parallel: a network stall then
 * cannot wedge a scan, it only leaves that repo's data as old as it already was, which
 * `fetchedAt` / `fetchError` report rather than hide.
 */
async function fetchRepo(dir, opts) {
  const o = opts || {};
  const started = Date.now();
  // Read before, because a failed fetch destroys the evidence: it truncates FETCH_HEAD, so
  // after one the only honest answer to "when did this last work" is the one taken now.
  const before = lastFetch(dir);
  const args = ['-c', 'gc.auto=0', 'fetch', '--no-tags', '--no-recurse-submodules', '--quiet', 'origin'];
  const r = await run(dir, args, { timeout: o.timeout || FETCH_TIMEOUT_MS });
  const ms = Date.now() - started;
  if (r.timedOut) return { ok: false, error: 'Fetching from origin timed out.', ms, timedOut: true, at: before };
  if (r.code !== 0) return { ok: false, error: sentence(r, 'Could not fetch from origin.'), ms, timedOut: false, at: before };
  return { ok: true, error: null, ms, timedOut: false, at: lastFetch(dir) };
}

module.exports = {
  branchInfo,
  divergence,
  changes,
  fileDiff,
  allDiffs,
  pullMain,
  remoteInfo,
  originUrl,
  fetch: fetchRepo,
  lastFetch,
  // exported for workspaces.js and for tests
  parseRemoteUrl,
  isMainName,
  FETCH_TIMEOUT_MS,
  STALE_AFTER_MS,
};
