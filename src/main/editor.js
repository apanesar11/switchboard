'use strict';

// editor.js — the Editor tab's file access. ARCHITECTURE §4.14, §5 M8.
//
// The Editor (views/editor.js, R13) is Monaco over a workspace's repos, and the renderer
// cannot touch a file itself (§0: contextIsolation, a sandboxed preload), so everything
// it reads or writes comes through here: the tree, a file's text, Save, the HEAD version
// its modified-line markers diff against, the stat poll that notices an external change,
// and find in files. The git half of that (ls-files, cat-file, grep) is git.js's (M3
// owns every git command); this module decides which folder a request is about, whether
// the path in it may be touched at all, and what the answer looks like.
//
// Rules that hold for the whole file:
//   * Nothing throws. Every export resolves to a value; a failure is
//     `{ ok: false, error: '<human sentence>' }`, the way git.js does it — this module's
//     own sentences are lowercase, git's arrive as git.js's sentence() wrote them.
//   * The renderer names a file as (workspace id, Repo.name, repo-relative path) — the
//     same key sb:diff:file uses — and never as an absolute path. guard() turns that
//     back into a file and refuses, before anything is opened: an absolute-path id (a
//     Grid folder square, which has no Editor), a repo the workspace does not have, a
//     path that is absolute or holds an empty, `.`, `..` or `.git` segment, and anything
//     whose REAL path — every symlink resolved — lands outside the repo or inside a
//     `.git` folder. A symlink pointing out of the repo is the case the segment test
//     cannot see and the realpath test exists for.
//   * guard() resolves a repo WITHOUT workspaces.scan(): a scan runs several git commands
//     per repo (status, numstat, remote), which is wrong for a stat poll every 3 s.
//     lookup() + repoDirsIn() + displayName() are the rules scan() itself uses, so the
//     answer is the same repo, for the cost of discover() alone.
//   * Save is the one write, and it writes exactly the file the user edited (§0): no git
//     command of any kind, no formatting, no other file. It writes IN PLACE — open, truncate,
//     write — never a temp file renamed over the original: a rename gives the file a new
//     inode, which drops its mode (an executable script stops being one), breaks every
//     hard link to it, and makes an editor or watcher that holds the old inode lose it.
//     The price is that a crash mid-write leaves a short file; the buffer is still in the
//     renderer, and Save again writes it whole.
//   * A save never clobbers what someone else wrote: the renderer sends the mtime it read
//     the file at, and a file whose mtime has moved since — or that has gone — is a
//     conflict the user decides (Overwrite / Reload), not a silent overwrite.
//   * Limits, each a thing the renderer shows rather than a failure: a file over 5 MB is
//     `tooLarge`, one with a NUL in its first 8 KB or that is not valid UTF-8 is `binary`
//     (neither is ever put in a Monaco model); a HEAD blob over 3 MB or binary gets no
//     markers; a tree stops at 100 000 files a repo (tracked ones first), a search at
//     2 000 matches, its highlights at 50 a line and 250 ms of regex a repo (git.js); a
//     stat poll is at most 200 files.
//   * There is no file watcher. The renderer stat-polls its open tabs — every 3 s while
//     the Editor is on screen and the window focused, and again on every window focus —
//     which costs one stat per open file, needs no teardown, and cannot be fooled the way
//     fs.watch on a file is by an atomic save (the watched inode is replaced and the
//     watch goes quiet). The tree re-lists on focus and ⌘R, as the Changes tab rescans.

const fs = require('fs');
const path = require('path');

const workspaces = require('./workspaces');
const git = require('./git');

const READ_MAX_BYTES = 5 * 1024 * 1024;
const SNIFF_BYTES = 8 * 1024;
// The renderer's model text arrives over IPC; past this it is not a file anyone meant.
const WRITE_MAX_BYTES = 20 * 1024 * 1024;
const STAT_MAX_FILES = 200;
const SEARCH_MAX_QUERY = 500;
// mtimeMs is a double with sub-millisecond digits; it survives IPC exactly, but a copy
// or a filesystem that stores less precision can move it by a rounding step. Half a
// millisecond is far below any real edit and far above that noise.
const MTIME_SLOP_MS = 0.5;

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// ---------------------------------------------------------------------------
// The path guard
// ---------------------------------------------------------------------------

/**
 * workspaceRepos(id) → { ok, id, repos: [{ name, dir }] } in the order scan() reports them:
 * the workspace's child repos, or the folder itself for a single-repo workspace (the rule
 * at workspaces.js scan()). An absolute-path id is a Grid folder square — a terminal and
 * nothing more — and is refused here, before lookup() is asked.
 */
async function workspaceRepos(id) {
  const want = typeof id === 'string' ? id.trim() : '';
  if (!want || path.isAbsolute(want)) return { ok: false, error: `no workspace called ${id}` };
  const ws = await workspaces.lookup(want);
  if (!ws || !ws.dir) return { ok: false, error: `no workspace called ${want}` };
  let dirs = workspaces.repoDirsIn(ws.dir);
  if (!dirs.length && fs.existsSync(path.join(ws.dir, '.git'))) dirs = [ws.dir];
  return {
    ok: true,
    id: ws.id,
    repos: dirs.map(dir => ({ name: workspaces.displayName(path.basename(dir), ws.id), dir })),
  };
}

// git's own is_hfs_dotgit() test: HFS+ ignores these code points in a name, so on such a
// volume `.g\u200cit` IS the .git folder. Stripped before comparing, as git does.
const HFS_IGNORABLE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;

function isDotGit(name) {
  return name.replace(HFS_IGNORABLE, '').toLowerCase() === '.git';
}

/** A repo-relative path the guard will consider at all: `a/b.txt`, nothing cleverer. */
function cleanRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.indexOf('\0') !== -1 || path.isAbsolute(rel)) return false;
  return rel.split('/').every(seg => seg !== '' && seg !== '.' && seg !== '..' && !isDotGit(seg));
}

/** `real` is the repo itself or below it, and not inside any .git folder on the way. */
function inside(repoReal, real) {
  if (real === repoReal) return true;
  if (!real.startsWith(repoReal + path.sep)) return false;
  return !real.slice(repoReal.length + 1).split(path.sep).some(isDotGit);
}

function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch (_) { return null; }
}

/** Some segment of `rel`, the last included, is a symlink. */
function throughLink(repoReal, rel) {
  let at = repoReal;
  return rel.split('/').some(seg => {
    at = path.join(at, seg);
    const st = lstatOrNull(at);
    return !!st && st.isSymbolicLink();
  });
}

/**
 * checkPath(repo, rel) → { ok:true, repo, repoReal, rel, real, exists, dangling, parentReal }
 * or { ok:false, error }.
 *
 * realpathSync.native, not the JS realpath: macOS's realpath(3) hands back each name as the
 * disk stores it, so `.GIT` reached through a symlink comes back `.git` and the test above
 * sees it — the JS version echoes whatever spelling it was given.
 *
 *   repoReal    the repo folder's own real path — `real` is always it or below it
 *   exists      the path resolves (through any symlinks) to something inside the repo;
 *               `real` is where it resolved to, and what gets opened
 *   dangling    a symlink whose target is not there: where it points cannot be checked, so
 *               it reads as missing and is never written through
 *   parentReal  when nothing is there: the real path of its folder, if that exists — Save
 *               may create the file there (a file deleted on disk, saved again)
 * When nothing is there, the nearest folder that IS must still resolve inside the repo,
 * or `a-link-out/new.txt` would create a file wherever the link points.
 */
function checkPath(repo, rel) {
  if (typeof rel !== 'string' || !rel) return { ok: false, error: 'no file was named' };
  const outside = { ok: false, error: `${rel} is outside ${repo.name}` };
  if (!cleanRel(rel)) return outside;
  let repoReal;
  try {
    repoReal = fs.realpathSync.native(repo.dir);
  } catch (_) {
    return { ok: false, error: `${repo.name} is not there any more` };
  }
  const abs = path.join(repoReal, rel);
  const base = { ok: true, repo, repoReal, rel, real: null, exists: false, dangling: false, parentReal: null };

  if (lstatOrNull(abs)) {
    let real;
    try {
      real = fs.realpathSync.native(abs);
    } catch (_) {
      return Object.assign(base, { dangling: true });
    }
    if (!inside(repoReal, real)) return outside;
    return Object.assign(base, { real, exists: true });
  }

  const parent = path.dirname(abs);
  let dir = parent;
  while (dir.length > repoReal.length && !lstatOrNull(dir)) dir = path.dirname(dir);
  let dirReal;
  try {
    dirReal = fs.realpathSync.native(dir);
  } catch (_) {
    return outside;
  }
  if (!inside(repoReal, dirReal)) return outside;
  return Object.assign(base, { parentReal: dir === parent ? dirReal : null });
}

/**
 * guard(id, repoName, rel) — the one gate in front of read, write, base and stat.
 * stat() asks the two halves itself so that a 200-file poll looks the workspace up once.
 */
async function guard(id, repoName, rel) {
  const ws = await workspaceRepos(id);
  if (!ws.ok) return ws;
  const repo = ws.repos.find(r => r.name === repoName);
  if (!repo) return { ok: false, error: `${repoName} is not a repo in ${ws.id}` };
  return checkPath(repo, rel);
}

/** An fs error as the tail of a sentence the renderer can show. */
function why(err) {
  const code = err && err.code;
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  if (code === 'EROFS') return 'the disk is read-only';
  if (code === 'ENOSPC') return 'the disk is full';
  return String((err && err.message) || err);
}

function missing(rel) {
  return { ok: false, missing: true, error: `${rel} is not there any more` };
}

// ---------------------------------------------------------------------------
// §4.14 — one export per sb:code:* channel
// ---------------------------------------------------------------------------

/**
 * tree(id) → { ok, repos: [{ name, files: [path], ignored: [path], truncated, error }] }
 * One entry per repo, in scan() order. `files` are the files git shows (tracked and
 * untracked-not-ignored); `ignored` the ones .gitignore keeps out of git, which the tree
 * still shows, dimmed — a file inside an ignored FOLDER is in neither (git.lsFiles). A repo
 * git cannot list gets files:[] and its sentence; the rest of the tree still lands.
 */
async function tree(id) {
  const ws = await workspaceRepos(id);
  if (!ws.ok) return ws;
  const repos = await Promise.all(ws.repos.map(async repo => {
    const r = await git.lsFiles(repo.dir);
    return {
      name: repo.name,
      files: r.ok ? r.files : [],
      ignored: r.ok ? r.ignored : [],
      truncated: !!(r.ok && r.truncated),
      error: r.ok ? null : r.error || `git could not list the files in ${repo.name}`,
    };
  }));
  return { ok: true, repos };
}

/**
 * read(id, repoName, rel)
 *   → { ok:true, text, mtimeMs, size, bom }            UTF-8 text, ≤ 5 MB
 *   → { ok:true, binary:true, mtimeMs, size }          a NUL in the first 8 KB, or not UTF-8
 *   → { ok:true, tooLarge:true, mtimeMs, size }        over 5 MB (and text as far as 8 KB shows)
 *   → { ok:false, missing:true, error }                not there
 *   → { ok:false, error }                              a folder (a submodule's gitlink is one), refused, unreadable
 *
 * The first 8 KB are looked at before the size, so a 50 MB video says "binary" and a
 * 50 MB log says "too large" — the more useful of the two things to be told. `mtimeMs`
 * and `size` come from the open file itself, so they describe the bytes that were read;
 * the renderer hands `mtimeMs` back on Save, and that is the conflict test.
 *
 * A UTF-8 BOM is taken off `text` and reported as `bom`, and Save puts it back: Monaco
 * would otherwise show it as a stray character on line 1, and dropping it on save would
 * change a file the user did not touch there.
 */
async function read(id, repoName, rel) {
  const g = await guard(id, repoName, rel);
  if (!g.ok) return g;
  if (!g.exists) return missing(g.rel);
  let fh = null;
  try {
    // stat before open: opening a FIFO for reading waits for a writer, forever.
    const pre = await fs.promises.stat(g.real);
    if (pre.isDirectory()) return { ok: false, error: `${g.rel} is a folder` };
    if (!pre.isFile()) return { ok: false, error: `${g.rel} is not a regular file` };
    fh = await fs.promises.open(g.real, 'r');
    const st = await fh.stat();
    const meta = { mtimeMs: st.mtimeMs, size: st.size };
    if (st.size > READ_MAX_BYTES) {
      const head = Buffer.alloc(SNIFF_BYTES);
      const { bytesRead } = await fh.read(head, 0, SNIFF_BYTES, 0);
      if (head.subarray(0, bytesRead).includes(0)) return Object.assign({ ok: true, binary: true }, meta);
      return Object.assign({ ok: true, tooLarge: true }, meta);
    }
    const buf = await fh.readFile();
    if (buf.length > READ_MAX_BYTES) return Object.assign({ ok: true, tooLarge: true }, meta);   // grew while we read
    if (buf.subarray(0, SNIFF_BYTES).includes(0)) return Object.assign({ ok: true, binary: true }, meta);
    const bom = buf.length >= 3 && buf.subarray(0, 3).equals(UTF8_BOM);
    let text;
    try {
      // ignoreBOM:true keeps TextDecoder's hands off the BOM — exactly one is taken off
      // here, by hand, so exactly one goes back on at Save.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? buf.subarray(3) : buf);
    } catch (_) {
      return Object.assign({ ok: true, binary: true }, meta);
    }
    return Object.assign({ ok: true, text }, meta, { bom });
  } catch (err) {
    if (err && err.code === 'ENOENT') return missing(g.rel);
    if (err && err.code === 'EISDIR') return { ok: false, error: `${g.rel} is a folder` };
    return { ok: false, error: `could not read ${g.rel}: ${why(err)}` };
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/**
 * write(id, repoName, rel, text, { mtimeMs, bom, force }) → { ok:true, mtimeMs, size }
 *   or { ok:false, conflict:true, missing, mtimeMs, error } or { ok:false, error }.
 *
 * Save. Unless `force`, a number in `opts.mtimeMs` is the mtime the renderer read the file
 * at: a file whose mtime has moved by more than MTIME_SLOP_MS since, or that is gone, is a
 * conflict — `mtimeMs` in the answer is the file's current one (null when it is gone), so
 * the renderer's Overwrite can go ahead knowingly. The answer's mtimeMs and size are a
 * fresh stat of what was just written: the next Save's conflict test starts from them.
 *
 * A file that is not there is created only where its folder still is — Save again after a
 * delete on disk, never a new folder tree — and with O_EXCL, so that if something
 * appeared at that name meanwhile (a symlink included) this fails instead of following it.
 */
async function write(id, repoName, rel, text, opts) {
  const o = opts || {};
  if (typeof text !== 'string') return { ok: false, error: 'there was no text to save' };
  if (Buffer.byteLength(text, 'utf8') > WRITE_MAX_BYTES) return { ok: false, error: `${rel} is too large to save` };
  const g = await guard(id, repoName, rel);
  if (!g.ok) return g;
  const name = path.basename(g.rel);
  if (g.dangling) return { ok: false, error: `${g.rel} is a link to a file that is not there` };

  let current = null;
  if (g.exists) {
    try {
      current = await fs.promises.stat(g.real);
    } catch (err) {
      if (!err || err.code !== 'ENOENT') return { ok: false, error: `could not save ${g.rel}: ${why(err)}` };
    }
  }
  if (current && current.isDirectory()) return { ok: false, error: `${g.rel} is a folder` };
  if (current && !current.isFile()) return { ok: false, error: `${g.rel} is not a regular file` };

  if (!o.force && typeof o.mtimeMs === 'number' && Number.isFinite(o.mtimeMs)) {
    if (!current) {
      return { ok: false, conflict: true, missing: true, mtimeMs: null, error: `${name} was deleted on disk` };
    }
    if (Math.abs(current.mtimeMs - o.mtimeMs) > MTIME_SLOP_MS) {
      return { ok: false, conflict: true, missing: false, mtimeMs: current.mtimeMs, error: `${name} changed on disk since it was opened` };
    }
  }

  let target = g.real;
  let flag = 'w';                         // O_TRUNC on the same inode: in place
  if (!current) {
    // Gone since the guard looked (or never there): only into a folder that still is.
    const parentReal = g.parentReal || (g.real ? path.dirname(g.real) : null);
    let isDir = false;
    try { isDir = !!parentReal && (await fs.promises.stat(parentReal)).isDirectory(); } catch (_) { isDir = false; }
    if (!isDir) return { ok: false, error: `could not save ${g.rel}: its folder is not there any more` };
    target = path.join(parentReal, path.basename(g.real || g.rel));
    flag = 'wx';
  }

  try {
    await fs.promises.writeFile(target, (o.bom ? '\ufeff' : '') + text, { encoding: 'utf8', flag });
    const st = await fs.promises.stat(target);
    return { ok: true, mtimeMs: st.mtimeMs, size: st.size };
  } catch (err) {
    if (err && err.code === 'EEXIST') return { ok: false, error: `could not save ${g.rel}: something else was created there` };
    return { ok: false, error: `could not save ${g.rel}: ${why(err)}` };
  }
}

/**
 * base(id, repoName, rel, oldPath) → { ok:true, text } | { ok:true, text:null } |
 *   { ok:true, text:null, skip:true } — git.headBlob()'s answer, for the markers.
 *
 * `oldPath` is a rename's pre-rename path (Repo.files[].oldPath): HEAD knows the file by
 * that name, and asking by the new one would paint every line as added. The file itself
 * need not exist on disk — this reads git's objects, not the worktree — but the path still
 * has to pass the guard, so nothing here is a way to name a file the Editor could not open.
 *
 * A path that goes through a symlink — `CLAUDE.md -> AGENTS.md`, or a file under a linked
 * folder — is asked for by where it really is: read() shows the target's text, while HEAD's
 * blob for the link itself is the target's NAME, and diffing one against the other painted
 * an unchanged file as rewritten. Only then: a path with no link in it keeps git's own
 * spelling, which is what HEAD knows it by on a case-insensitive disk that spells it
 * otherwise (a case-only rename not yet committed).
 */
async function base(id, repoName, rel, oldPath) {
  const g = await guard(id, repoName, rel);
  if (!g.ok) return g;
  let blobPath = g.rel;
  if (oldPath !== undefined && oldPath !== null && oldPath !== '') {
    if (!cleanRel(oldPath)) return { ok: false, error: `${oldPath} is outside ${g.repo.name}` };
    blobPath = oldPath;
  } else if (g.exists && throughLink(g.repoReal, g.rel)) {
    // `real` is inside the repo and outside .git — the guard said so — and never the repo
    // itself for anything read() would open, but '' would ask for HEAD's whole tree.
    blobPath = path.relative(g.repoReal, g.real).split(path.sep).join('/') || g.rel;
  }
  const r = await git.headBlob(g.repo.dir, blobPath);
  if (!r.ok) return { ok: false, error: r.error || `git could not read ${blobPath} at HEAD` };
  if (r.skip) return { ok: true, text: null, skip: true };
  // read() hands the renderer the text without its BOM, so the base loses it too — or
  // every such file's first line would be "modified" by a character nobody can see.
  return { ok: true, text: typeof r.text === 'string' ? r.text.replace(/^\ufeff/, '') : null };
}

/**
 * stat(id, files: [{ repo, path }]) → { ok, stats: [{ repo, path, exists, mtimeMs, size }] }
 * Same order as asked, at most STAT_MAX_FILES (the rest are ignored). An entry the guard
 * refuses reads exactly like one that is not there, and so does a folder: either way there
 * is no file for that tab any more.
 */
async function stat(id, files) {
  const ws = await workspaceRepos(id);
  if (!ws.ok) return ws;
  const list = Array.isArray(files) ? files.slice(0, STAT_MAX_FILES) : [];
  const stats = await Promise.all(list.map(async entry => {
    const repoName = entry && typeof entry.repo === 'string' ? entry.repo : null;
    const rel = entry && typeof entry.path === 'string' ? entry.path : null;
    const none = { repo: repoName, path: rel, exists: false, mtimeMs: null, size: null };
    const repo = ws.repos.find(r => r.name === repoName);
    if (!repo) return none;
    const g = checkPath(repo, rel);
    if (!g.ok || !g.exists) return none;
    try {
      const st = await fs.promises.stat(g.real);
      if (!st.isFile()) return none;
      return { repo: repoName, path: rel, exists: true, mtimeMs: st.mtimeMs, size: st.size };
    } catch (_) {
      return none;
    }
  }));
  return { ok: true, stats };
}

/**
 * search(id, query, { caseSensitive, regex })
 *   → { ok, matches: [{ repo, path, line, text, offset, ranges }], truncated, files, errors: [{ repo, error }] }
 *
 * Find in files, every repo at once, answered in repo order and cut at git.GREP_MAX_MATCHES
 * in all. What is searched is the files on disk — an unsaved buffer is not, and the
 * renderer says so. A repo that fails (a bad pattern, a timeout) is one entry in `errors`
 * and never costs the other repos their matches. `files` is how many distinct files matched.
 * `ranges` are the highlights inside `text`, git.grep()'s: the renderer paints them and
 * never runs the pattern itself — [] when there is nothing it could safely show.
 */
async function search(id, query, opts) {
  const o = opts || {};
  const q = typeof query === 'string' ? query : '';
  const empty = { ok: true, matches: [], truncated: false, files: 0, errors: [] };
  if (!q.trim()) return empty;
  if (q.length > SEARCH_MAX_QUERY) return { ok: false, error: 'that search is too long' };
  // git grep splits a pattern on newlines and ORs the pieces — not what a one-line field
  // means, and nothing the renderer could highlight.
  if (/[\r\n]/.test(q)) return { ok: false, error: 'find in files searches one line at a time' };
  const ws = await workspaceRepos(id);
  if (!ws.ok) return ws;

  const answers = await Promise.all(ws.repos.map(repo =>
    git.grep(repo.dir, q, { caseSensitive: !!o.caseSensitive, regex: !!o.regex })));
  const matches = [];
  const errors = [];
  const seen = new Set();
  let truncated = false;
  ws.repos.forEach((repo, i) => {
    const r = answers[i] || { ok: false, error: null, matches: [] };
    if (!r.ok) errors.push({ repo: repo.name, error: r.error || `git could not search ${repo.name}` });
    if (r.truncated) truncated = true;
    for (const m of r.matches || []) {
      if (matches.length >= git.GREP_MAX_MATCHES) { truncated = true; break; }
      matches.push({ repo: repo.name, path: m.path, line: m.line, text: m.text, offset: m.offset, ranges: m.ranges || [] });
      seen.add(repo.name + '\0' + m.path);
    }
  });
  return { ok: true, matches, truncated, files: seen.size, errors };
}

module.exports = {
  tree,
  read,
  write,
  base,
  stat,
  search,
};
