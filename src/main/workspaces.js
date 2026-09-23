'use strict';

// workspaces.js — discovery and per-workspace scan orchestration. ARCHITECTURE §5 M2.
//
// discover() is cheap and runs no git at all. scan() fans every repo out in
// parallel and folds the per-repo results into the workspace-level totals the
// header line needs. Neither ever throws: a repo that fails carries an `error`
// sentence and empty change data, and the rest of the scan still lands.
//
// PR numbers are NOT filled in here — src/main/index.js folds the cached PR
// summary in after the scan, so this module never touches the network or `gh`.
//
// Two shapes of workspace come out of here. A FOLDER OF REPOS is what discovery
// finds on its own: a child of the root with two or more git repos inside
// (sample-2). A SINGLE REPO is a folder that is the repo itself, with nothing
// nested — Switchboard, or any app that is one repository — which discovery would
// never keep, so the config declares it by hand with `workspaces.<id>.dir`. From
// there on the two are the same thing: scan() reports the single repo as the
// workspace's one repo, named after the folder.
//
// One of those single repos is THIS APP. A workspace whose package.json is
// Switchboard's own is marked `self`, and is never startable — its devCommand is
// null and its processes [] whatever the folder or the config says — because the
// only thing Start could do there is launch a second copy of the app that is
// already running, which the single-instance lock would quit on sight. The
// renderer offers Publish in place of Start and drops the "no dev script" complaint.

const fs = require('fs');
const path = require('path');
const os = require('os');

const git = require('./git');

// Used only when config.js cannot be loaded or hands back something unusable —
// the app must still come up, without scanning an unconfigured directory.
const FALLBACK_CONFIG = {
  root: null,
  exclude: ['node_modules'],
  workspaces: {},
};

let configModule = null;
try {
  configModule = require('./config');
} catch (e) {
  configModule = null;
}

async function loadConfig() {
  if (configModule && typeof configModule.load === 'function') {
    try {
      const loaded = await configModule.load();
      if (loaded && typeof loaded === 'object') {
        return {
          root: typeof loaded.root === 'string' && loaded.root ? loaded.root : FALLBACK_CONFIG.root,
          exclude: Array.isArray(loaded.exclude) ? loaded.exclude : FALLBACK_CONFIG.exclude,
          workspaces: loaded.workspaces && typeof loaded.workspaces === 'object' ? loaded.workspaces : {},
          projects: loaded.projects && typeof loaded.projects === 'object' ? loaded.projects : {},
        };
      }
    } catch (e) {
      // fall through to the defaults below
    }
  }
  return FALLBACK_CONFIG;
}

function listDirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  return entries
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

function isRepo(dir) {
  // `.git` is a directory in a normal clone and a FILE in a worktree.
  return fs.existsSync(path.join(dir, '.git'));
}

/** Immediate child directories of a workspace that are git repos. */
function repoDirsIn(workspaceDir) {
  return listDirs(workspaceDir)
    .map((name) => path.join(workspaceDir, name))
    .filter(isRepo);
}

/** 'sample-2' → 'sample'; 'demo' → 'demo'. */
function projectOf(id) {
  return id.replace(/-\d+$/, '');
}

/** The workspace's numeric suffix: 'sample-2' → '-2', 'demo' → null. */
function suffixOf(id) {
  const m = id.match(/-(\d+)$/);
  return m ? '-' + m[1] : null;
}

/** 'sample-api-2' in workspace 'sample-2' → 'sample-api' (the name the mock-up shows). */
function displayName(dirName, wsId) {
  const suffix = suffixOf(wsId);
  if (suffix && dirName.length > suffix.length && dirName.endsWith(suffix)) {
    return dirName.slice(0, -suffix.length);
  }
  return dirName;
}

/**
 * Fallback when config carries no devCommand for a workspace: a root package.json
 * with a `dev` script. Without one, Start stays disabled unless processes
 * are configured explicitly.
 */
function devCommandFromPackageJson(workspaceDir) {
  try {
    const raw = fs.readFileSync(path.join(workspaceDir, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    if (pkg && pkg.scripts && typeof pkg.scripts.dev === 'string' && pkg.scripts.dev.trim()) {
      return 'npm run dev';
    }
  } catch (e) {
    // no package.json, or unreadable / malformed — treat as "no dev command"
  }
  return null;
}

// This app's own package name, read once. A workspace whose package.json carries it
// IS Switchboard — the folder this process was started from, or a copy of it.
let ownName = null;
try {
  ownName = String((require('../../package.json') || {}).name || '') || null;
} catch (e) {
  ownName = null;
}

/**
 * Is this folder Switchboard itself? Decided by package name rather than by path,
 * so a packaged app (whose own files live inside an asar) still recognises the
 * checkout on the rail, and a second checkout of the app counts too: starting
 * either would only collide with the single-instance lock.
 */
function isSelf(workspaceDir) {
  if (!ownName) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(workspaceDir, 'package.json'), 'utf8'));
    return !!pkg && pkg.name === ownName;
  } catch (e) {
    return false;
  }
}

/** One Workspace record without `repos`. `dir` is absolute and is a folder. */
function makeWorkspace(name, dir, cfg) {
  const wsCfg = (cfg.workspaces && cfg.workspaces[name]) || {};
  // The app itself is never startable, whatever its package.json or the config
  // says — see the header comment.
  const self = isSelf(dir);
  const devCommand = self
    ? null
    : typeof wsCfg.devCommand === 'string' && wsCfg.devCommand.trim()
      ? wsCfg.devCommand
      : wsCfg.devCommand === null
        ? null
        : devCommandFromPackageJson(dir);

  // A workspace without a root dev script can start configured per-repo processes.
  // Surface their names so the renderer knows Start is live.
  const ws = { id: name, project: projectOf(name), section: null, dir, self, devCommand, processes: [] };
  if (!self && configModule && typeof configModule.resolveWorkspace === 'function') {
    try {
      const resolved = configModule.resolveWorkspace(ws);
      if (resolved && Array.isArray(resolved.processes)) {
        ws.processes = resolved.processes.map((p) => p.name).filter(Boolean);
      }
    } catch (e) { /* a broken config must not hide a workspace */ }
  }
  return ws;
}

// Declared folders that were not there, each complained about once: discover()
// runs behind every scan, and a missing folder is not news the second time.
const warnedMissing = new Set();

/** `workspaces.<id>.dir` → the absolute folder, or null when it is not a folder. */
function declaredDir(cfg, id, decl) {
  if (!decl || typeof decl !== 'object' || typeof decl.dir !== 'string' || !decl.dir.trim()) return null;
  const raw = decl.dir.trim().replace(/^~(?=\/|$)/, os.homedir());
  if (!path.isAbsolute(raw) && !cfg.root) return null;
  const dir = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cfg.root, raw);
  let ok = false;
  try { ok = fs.statSync(dir).isDirectory(); } catch (e) { ok = false; }
  if (!ok && !warnedMissing.has(id)) {
    warnedMissing.add(id);
    console.error('[switchboard] workspaces.' + id + '.dir is not a folder, so it is not on the rail: ' + dir);
  }
  return ok ? dir : null;
}

/**
 * discover() → Workspace[] without `repos`. No git, no network.
 *
 * A workspace is an immediate child of the root with at least TWO immediate child
 * directories that each contain a `.git` entry, minus the exclude list.
 *
 * A root may itself be a Git repo or contain disabled Git metadata; neither
 * changes the two-child rule. Loose single repos are declared explicitly.
 *
 * Those single repos get on the rail one at a time, by being DECLARED: a
 * `workspaces.<id>.dir` in the config (relative to the root, or absolute) is a
 * workspace whether or not the rule above would keep it. Switchboard itself is
 * the first. A declared folder is not discovered, so `exclude` has no say over
 * it; a discovered workspace with the same id wins over the declaration; and a
 * declared folder that is not there is left off rather than shown dead.
 */
async function discover() {
  const cfg = await loadConfig();
  const exclude = new Set(cfg.exclude);
  const out = [];
  const seen = new Set();

  for (const name of cfg.root ? listDirs(cfg.root) : []) {
    if (exclude.has(name)) continue;
    const dir = path.join(cfg.root, name);
    if (repoDirsIn(dir).length < 2) continue;
    out.push(makeWorkspace(name, dir, cfg));
    seen.add(name);
  }

  for (const id of Object.keys(cfg.workspaces || {})) {
    if (seen.has(id)) continue;
    const dir = declaredDir(cfg, id, cfg.workspaces[id]);
    if (!dir) continue;
    out.push(makeWorkspace(id, dir, cfg));
    seen.add(id);
  }

  // Sections are the rail's group headings. A project with more than one
  // workspace (sample-1 … sample-4) is a section of its own; the projects with a
  // single workspace — demo, switchboard — share one called 'other', because a
  // heading over one row is a heading over nothing. It is a count, not a setting:
  // the day a demo-2 appears, Demo becomes a section on its own.
  const counts = new Map();
  for (const ws of out) counts.set(ws.project, (counts.get(ws.project) || 0) + 1);
  for (const ws of out) ws.section = counts.get(ws.project) > 1 ? ws.project : 'other';

  // Sections come out in the order the config lists their projects (sample,
  // example) rather than alphabetically — the sidebar should open on the
  // project that is worked in most, not on whichever name sorts first — with
  // 'other' last. Inside a section the same config order holds, and anything the
  // config has never heard of falls in behind, alphabetically.
  const order = Object.keys((cfg.projects || {}));
  const rank = (p) => { const i = order.indexOf(p); return i === -1 ? order.length : i; };
  const byProject = (a, b) => rank(a) - rank(b) || a.localeCompare(b);
  out.sort((a, b) => {
    if (a.section !== b.section) {
      if (a.section === 'other') return 1;
      if (b.section === 'other') return -1;
      return byProject(a.section, b.section);
    }
    if (a.project !== b.project) return byProject(a.project, b.project);
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  });
  return out;
}

function emptyRepo(dir, wsId, error) {
  const dirName = path.basename(dir);
  return {
    name: displayName(dirName, wsId),
    dirName,
    dir,
    branch: null,
    head: null,
    detached: false,
    onMain: false,
    ahead: null,
    behind: null,
    remote: null,
    hasOrigin: false,
    files: [],
    add: 0,
    del: 0,
    pr: null,
    fetchedAt: null,
    fetchError: null,
    error,
  };
}

async function scanRepo(dir, wsId, fetched) {
  const dirName = path.basename(dir);
  // One `git remote get-url origin` answers both questions: which GitHub repo this is (for
  // the PR lookup) and whether there is any origin at all (for the freshness numbers). A
  // local-path or file:// origin parses to no owner/repo but is perfectly fetchable.
  const [ch, origin] = await Promise.all([git.changes(dir), git.originUrl(dir)]);
  const remote = git.parseRemoteUrl(origin);
  const hasOrigin = origin !== null;

  // How old the remote-tracking refs are, and why they are not newer. Read after any fetch
  // this scan ran, so a repo that just fetched reports its new timestamp.
  //
  // A repo with NO origin is not stale, it is local: it has nothing to be behind, and
  // `git fetch` there fails every time with "'origin' does not appear to be a git
  // repository". Reporting that as an error would put a permanent, unfixable complaint on
  // the row of a workspace that is working exactly as intended.
  const fetchedAt = hasOrigin ? (fetched ? fetched.at : git.lastFetch(dir)) : null;
  const fetchError = hasOrigin && fetched && !fetched.ok ? fetched.error : null;

  if (!ch.ok) {
    const repo = emptyRepo(dir, wsId, ch.error);
    repo.remote = remote ? { owner: remote.owner, repo: remote.repo } : null;
    repo.hasOrigin = hasOrigin;
    repo.fetchedAt = fetchedAt;
    repo.fetchError = fetchError;
    return repo;
  }

  const b = ch.branch;
  let ahead = b.ahead;
  let behind = b.behind;
  // porcelain v2's `# branch.ab` is free but only exists when the branch tracks
  // something. Without an upstream, fall back to comparing against origin/main.
  if (ahead === null || behind === null) {
    const d = await git.divergence(dir, b.branch);
    ahead = d.ahead;
    behind = d.behind;
  }

  return {
    name: displayName(dirName, wsId),
    dirName,
    dir,
    branch: b.branch,
    // The full HEAD sha (null on an unborn HEAD). A DETACHED repo has no branch name, so
    // this is the only identity its pill can show — without it the pill falls back to the
    // literal word "HEAD", which names nothing. The renderer shortens it.
    head: b.head,
    detached: b.detached,
    onMain: b.onMain,
    ahead,
    behind,
    remote: remote ? { owner: remote.owner, repo: remote.repo } : null,
    hasOrigin,
    files: ch.files,
    add: ch.add,
    del: ch.del,
    pr: null,
    fetchedAt,
    fetchError,
    error: null,
  };
}

/**
 * The sub line wants one branch name. All on main → 'main'. Otherwise the
 * non-main branch the most repos sit on, and 'mixed' when no single one leads —
 * including the case where the only thing off main is a detached HEAD.
 */
function branchSummary(repos) {
  const named = repos.filter((r) => !r.error);
  if (!named.length) return 'main';
  if (named.every((r) => r.onMain)) return 'main';

  const counts = new Map();
  for (const r of named) {
    if (r.onMain || r.detached || !r.branch) continue;
    counts.set(r.branch, (counts.get(r.branch) || 0) + 1);
  }
  if (!counts.size) return 'mixed';

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return 'mixed';
  return ranked[0][0];
}

/**
 * scan(id, { fetch }) → Workspace with `repos`.
 *
 * Every repo runs in parallel; the whole thing is ~50 ms for a four-repo workspace without
 * `fetch`.
 *
 * With `fetch: true` every repo's `git fetch` runs first, all at once, each one bounded by
 * git.FETCH_TIMEOUT_MS — so the fetch phase costs about as long as the slowest single repo
 * (~0.7 s warm) and can never cost more than that ceiling no matter how many repos there are
 * or how dead the network is. A repo whose fetch fails is not an error: it is simply scanned
 * with the refs it already had, and says so through `fetchedAt` / `fetchError`.
 *
 * Either way the result reports how old the remote-tracking data actually is. `behind`,
 * `behindRepos` and the row's "up to date" are all computed from refs/remotes, which only a
 * fetch refreshes — without `fetchedAt` and `fetchStale` the screen states them with a confidence
 * they have not earned, and can go on doing so for days.
 */
async function scan(id, opts) {
  const doFetch = !!(opts && opts.fetch);
  const spaces = await discover();
  const ws = spaces.find((w) => w.id === id);

  if (!ws) {
    return {
      id,
      project: projectOf(id),
      section: 'other',
      dir: null,
      self: false,
      devCommand: null,
      processes: [],
      repos: [],
      branchSummary: 'main',
      files: 0,
      add: 0,
      del: 0,
      behindRepos: 0,
      fetchedAt: null,
      fetchAgeMs: null,
      fetchStale: false,
      fetchStaleAfterMs: git.STALE_AFTER_MS,
      fetched: false,
      fetchError: null,
      error: 'No workspace named ' + id + '.',
    };
  }

  // A folder of repos scans its children. A single-repo workspace has none — the
  // folder IS the repo — so it scans itself, as its one repo, named after the folder.
  let dirs = repoDirsIn(ws.dir);
  if (!dirs.length && isRepo(ws.dir)) dirs = [ws.dir];

  const fetched = new Map();
  if (doFetch) {
    const results = await Promise.all(dirs.map((d) => git.fetch(d)));
    dirs.forEach((d, i) => fetched.set(d, results[i]));
  }

  const repos = await Promise.all(dirs.map((d) => scanRepo(d, ws.id, fetched.get(d) || null)));

  let files = 0;
  let add = 0;
  let del = 0;
  let behindRepos = 0;
  // The workspace is only as fresh as its stalest repo, and one repo that has never fetched
  // makes the whole answer unknown rather than merely old. Only repos with an origin count:
  // a local-only one has nothing to be behind of, so it can neither be stale nor fix itself.
  let fetchedAt = null;
  let tracked = 0;
  let unknown = false;
  let fetchError = null;
  for (const r of repos) {
    files += r.files.length;
    add += r.add;
    del += r.del;
    if (r.onMain && r.behind > 0) behindRepos++;
    if (!r.hasOrigin) continue;
    tracked++;
    if (r.fetchedAt === null || r.fetchedAt === undefined) unknown = true;
    else if (fetchedAt === null || r.fetchedAt < fetchedAt) fetchedAt = r.fetchedAt;
    if (!fetchError && r.fetchError) fetchError = r.fetchError;
  }
  if (unknown) fetchedAt = null;

  const fetchAgeMs = fetchedAt === null ? null : Math.max(0, Date.now() - fetchedAt);
  const fetchStale = tracked > 0 && (fetchAgeMs === null || fetchAgeMs > git.STALE_AFTER_MS);

  return {
    id: ws.id,
    project: ws.project,
    section: ws.section,
    dir: ws.dir,
    self: !!ws.self,
    devCommand: ws.devCommand,
    processes: ws.processes || [],
    repos,
    branchSummary: branchSummary(repos),
    files,
    add,
    del,
    behindRepos,
    fetchedAt,
    fetchAgeMs,
    fetchStale,
    fetchStaleAfterMs: git.STALE_AFTER_MS,
    fetched: doFetch,
    fetchError,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// One id → one folder
// ---------------------------------------------------------------------------

function isDir(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch (e) { return false; }
}

/**
 * lookup(id) → the Workspace (without repos) the rail shows under that id, or null.
 * The one place a bare id turns back into a folder, so the terminal and the runner
 * open exactly what discover() listed — a declared workspace's `dir` included. That
 * is what gives `website` (folder `website-landing-v2`) a terminal at all:
 * joining the root with the id names a folder that does not exist.
 */
async function lookup(id) {
  const want = String(id === null || id === undefined ? '' : id).trim();
  if (!want) return null;
  const list = await discover();
  return list.find((w) => w.id === want) || null;
}

/**
 * dirOf(id) → the absolute folder a terminal for `id` opens in, or null.
 *
 * `id` is a workspace id (lookup(), above) or an ABSOLUTE PATH: a folder the user chose
 * for a Grid square (§4.10), which is a terminal and nothing more — not on the rail,
 * not scanned, not startable. A relative id the rail does not know falls back to a
 * child of the root, which is the resolution the terminal always had.
 */
async function dirOf(id) {
  const want = String(id === null || id === undefined ? '' : id).trim();
  if (!want) return null;
  if (path.isAbsolute(want)) {
    const dir = path.resolve(want);
    return isDir(dir) ? dir : null;
  }
  const ws = await lookup(want);
  if (ws) return ws.dir;
  const cfg = await loadConfig();
  if (!cfg.root) return null;
  const dir = path.join(cfg.root, want);
  return isDir(dir) ? dir : null;
}

module.exports = {
  discover,
  scan,
  lookup,
  dirOf,
  // exported so index.js can resolve a repoName to a directory without re-deriving the rules
  repoDirsIn,
  displayName,
  projectOf,
};
