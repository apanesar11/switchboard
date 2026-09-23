'use strict';

// Every `gh` command Switchboard runs (ARCHITECTURE §5 M4).
//
// Errors are values. Nothing here throws or rejects: a failure comes back as one of the
// sentences the renderer shows verbatim — `gh is not installed`, `gh is not signed in`,
// `no pull request for <branch> yet`.
//
// Everything is keyed by the LOCAL repo directory, never by owner/repo: sample-1..4 clone
// the same four GitHub repos on the same branches, so an owner/repo key would make the four
// workspaces show each other's pull requests.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const TTL_MS = 60 * 1000;
const NOT_INSTALLED = 'gh is not installed';
const NOT_SIGNED_IN = 'gh is not signed in';
const NO_GITHUB_REMOTE = 'this repo has no GitHub remote';
const noPrMessage = (branch) => `no pull request for ${branch || 'this branch'} yet`;

// A branch whose PR was merged still belongs on its row, so a closed/merged PR is a fallback
// for the open one — but not on main, where an ancient main→somewhere PR would be pure noise.
const TRUNK_BRANCHES = new Set(['main', 'master']);

const ALIAS_BATCH = 30;              // aliases per GraphQL document; 11 aliases measured 0.86s
const THREADS_PER_PR = 100;          // GitHub's own review-thread page size
const COMMENTS_PER_THREAD = 50;
const CONVERSATION_PER_PR = 100;     // issue comments on the PR — the conversation tab
const REVIEWS_PER_PR = 100;
const MY_PRS_MAX = 100;              // one search page; nobody has more open PRs than that

// ---------------------------------------------------------------- running gh

// Built per call, not once: an Electron main process may repair PATH (macOS GUI launches get a
// stub PATH without /opt/homebrew/bin) long after this module is required.
function ghEnv() {
  return Object.assign({}, process.env, {
    GH_PAGER: 'cat',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1',
    CLICOLOR: '0',
  });
}

/** Run gh. Never rejects; resolves { code, stdout, stderr, enoent, timedOut }. */
function gh(args, { timeout = 25000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile('gh', args, { env: ghEnv(), timeout, maxBuffer, encoding: 'utf8', windowsHide: true },
      (err, stdout, stderr) => resolve({
        // err.code is the numeric exit status, or the string 'ENOENT' when gh is not on PATH.
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        enoent: !!(err && err.code === 'ENOENT'),
        timedOut: !!(err && err.killed),
        stdout: stdout || '',
        stderr: stderr || '',
      }));
  });
}

/**
 * gh's first invocation costs 3.4-3.6s (macOS keyring unlock + TLS); every later one is
 * 0.7-0.95s. Call this once at app start so the first PR panel is not the one that pays it.
 */
function prewarm() {
  return gh(['api', 'rate_limit'], { timeout: 12000 }).then(() => undefined, () => undefined);
}

function firstLine(text) {
  const line = String(text || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
  return line.replace(/^gh:\s*/, '');
}

/** Turn a failed gh run into the one sentence the renderer should show. */
function failureMessage(r) {
  if (r.enoent) return NOT_INSTALLED;
  if (r.timedOut) return 'GitHub took too long to answer';
  const stderr = String(r.stderr || '');
  // Verified on gh 2.86.0: no credentials at all exits 4 ("please run: gh auth login"), a bad
  // or expired token exits 1 with "gh: Bad credentials (HTTP 401)". Both are "sign in again".
  if (r.code === 4 || /gh auth login|not logged in|not logged into|bad credentials|HTTP 401|requires authentication|authentication token/i.test(stderr)) {
    return NOT_SIGNED_IN;
  }
  if (/no such host|network is unreachable|connection refused|i\/o timeout|dial tcp|TLS handshake|EOF/i.test(stderr)) {
    return 'GitHub is unreachable';
  }
  return firstLine(stderr) || `gh exited with code ${r.code}`;
}

/**
 * `gh api graphql` EXITS 1 on a PARTIAL error — one alias pointing at a repo you cannot see
 * makes it print the full payload (that alias null, the rest populated) and still fail — so
 * stdout must be read before the exit code is trusted.
 */
function readGraphql(r) {
  let json = null;
  if (r.stdout) { try { json = JSON.parse(r.stdout); } catch (_) { json = null; } }
  if (json && json.data) return { data: json.data, errors: json.errors || [] };
  if (json && Array.isArray(json.errors) && json.errors.length) {
    return { data: null, error: firstLine(json.errors[0].message) || 'GitHub rejected the query' };
  }
  if (r.code === 0) return { data: null, error: 'gh returned an unreadable answer' };
  return { data: null, error: failureMessage(r) };
}

function hostArgs(remote) {
  return remote.host && remote.host !== 'github.com' ? ['--hostname', remote.host] : [];
}

// ---------------------------------------------------------------- cache

const cache = new Map();   // `${kind}\0${dir}\0${rest}` -> { at, promise }

function isFailure(value) {
  return !!(value && typeof value === 'object' && value.error);
}

/** Memoise one call for 60 s. Failures are never cached, so recovery is immediate. */
function cachedCall(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const entry = { at: Date.now(), promise: null };
  entry.promise = Promise.resolve().then(fn).then(
    (value) => { if (isFailure(value)) cache.delete(key); return value; },
    // Nothing above is expected to reject; this is the backstop that keeps an unhandled
    // rejection from ever reaching the user.
    (err) => { cache.delete(key); return { error: firstLine(err && err.message) || 'gh failed' }; });
  cache.set(key, entry);
  return entry.promise;
}

function remember(key, value) {
  cache.set(key, { at: Date.now(), promise: Promise.resolve(value) });
}

function freshHit(key) {
  const hit = cache.get(key);
  return hit && Date.now() - hit.at < TTL_MS ? hit.promise : null;
}

// Keys are NUL-separated so no directory name can collide with another directory's entries.
const prKey = (dir, branch) => `pr\u0000${dir}\u0000${branch}`;
const nodeKey = (dir, number) => `node\u0000${dir}\u0000${number}`;
const detailKey = (dir, number) => `detail\u0000${dir}\u0000${number}`;
const remoteKey = (dir) => `remote\u0000${dir}\u0000`;
const MINE_KEY = 'mine\u0000mine\u0000';

/** Drop cached answers — everything, or just one repo directory's. */
function invalidate(dir) {
  if (!dir) { cache.clear(); return; }
  const needle = `\u0000${dir}\u0000`;
  for (const key of cache.keys()) if (key.includes(needle)) cache.delete(key);
}

// ---------------------------------------------------------------- the repo's remote

/**
 * owner/repo/host from any remote URL shape:
 *   https://github.com/o/r(.git)   git@github.com:o/r(.git)   ssh://git@github.com/o/r
 *   https://user:token@github.com/o/r   https://github.com/o/r/   git://github.com/o/r.git
 * Returns null for anything unparseable.
 */
function parseRemoteUrl(url) {
  if (!url) return null;
  let s = String(url).trim().replace(/\/+$/, '');
  s = s.replace(/^[a-zA-Z0-9._-]+::/, '');                                 // transport helper prefix
  let host = null;
  let rest = null;
  let m = s.match(/^[a-z+]+:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i);   // scheme://[user@]host[:port]/path
  if (m) { host = m[1]; rest = m[2]; } else {
    m = s.match(/^(?:[^@]+@)?([^/:]+):(.+)$/);                             // scp-style user@host:path
    if (m) { host = m[1]; rest = m[2]; }
  }
  if (!rest) return null;
  const seg = rest.replace(/\.git$/i, '').split('/').filter(Boolean);
  if (seg.length < 2) return null;
  return {
    owner: seg[seg.length - 2],
    repo: seg[seg.length - 1],
    host: host ? host.toLowerCase() : null,
  };
}

function isGitHubHost(host) {
  if (!host) return false;
  return host === 'github.com' || host.endsWith('.github.com') || /(^|\.)github\./.test(host);
}

/**
 * The repo's git dir and its COMMON git dir. They differ inside a worktree, where `.git` is a
 * file holding `gitdir: <path>`, HEAD lives in that per-worktree dir and config lives in the
 * common one named by `commondir`.
 */
function gitDirs(repoDir) {
  const dotGit = path.join(repoDir, '.git');
  let stat;
  try { stat = fs.statSync(dotGit); } catch (_) { return null; }
  let gitDir = dotGit;
  if (!stat.isDirectory()) {
    let pointer;
    try { pointer = fs.readFileSync(dotGit, 'utf8'); } catch (_) { return null; }
    const m = pointer.match(/^gitdir:\s*(.+)$/m);
    if (!m) return null;
    gitDir = path.resolve(repoDir, m[1].trim());
  }
  let commonDir = gitDir;
  try {
    const common = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    if (common) commonDir = path.resolve(gitDir, common);
  } catch (_) { /* not a worktree */ }
  return { gitDir, commonDir };
}

/** origin's URL straight out of .git/config — no process, ~0.1 ms. */
function originUrlFromConfig(repoDir) {
  const dirs = gitDirs(repoDir);
  if (!dirs) return null;
  let text;
  try { text = fs.readFileSync(path.join(dirs.commonDir, 'config'), 'utf8'); } catch (_) { return null; }
  let inOrigin = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#' || line[0] === ';') continue;
    if (line[0] === '[') { inOrigin = /^\[remote\s+"origin"\]$/i.test(line); continue; }
    if (!inOrigin) continue;
    const m = line.match(/^url\s*=\s*(.*)$/i);
    if (m) return m[1].trim();
  }
  return null;
}

/** Fallback for a config this parser cannot read (url.insteadOf rewrites, includes). */
function originUrlFromGit(repoDir) {
  return new Promise((resolve) => {
    execFile('git', ['-C', repoDir, 'remote', 'get-url', 'origin'], {
      env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }),
      timeout: 5000, encoding: 'utf8', windowsHide: true,
    }, (err, stdout) => resolve(err ? null : String(stdout || '').trim() || null));
  });
}

/** { owner, repo, host } for a repo directory, or null when it has no GitHub origin. */
function remoteFor(repoDir) {
  return cachedCall(remoteKey(repoDir), async () => {
    const url = originUrlFromConfig(repoDir) || await originUrlFromGit(repoDir);
    const parsed = parseRemoteUrl(url);
    return parsed && isGitHubHost(parsed.host) ? parsed : null;
  });
}

/** The checked-out branch, read from HEAD; null when detached or unreadable. */
function currentBranch(repoDir) {
  const dirs = gitDirs(repoDir);
  if (!dirs) return null;
  let head;
  try { head = fs.readFileSync(path.join(dirs.gitDir, 'HEAD'), 'utf8'); } catch (_) { return null; }
  const m = head.match(/^ref:\s*refs\/heads\/(.+)$/m);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------- PR for a branch

const PR_FIELDS = 'number state isDraft';

function gqlString(s) { return JSON.stringify(String(s)); }

function prState(pr) {
  return pr.state === 'OPEN' && pr.isDraft ? 'DRAFT' : pr.state;   // OPEN | DRAFT | MERGED | CLOSED
}

function pickPr(node) {
  if (!node) return null;                                          // alias resolved to null (NOT_FOUND)
  const open = node.open && node.open.nodes && node.open.nodes[0];
  const recent = node.recent && node.recent.nodes && node.recent.nodes[0];
  const pr = open || recent;
  return pr ? { number: pr.number, state: prState(pr) } : null;
}

/**
 * ONE GraphQL call for every (repo, branch) pair given — the whole workspace at once.
 * Costs rateLimit.cost 1 out of 5000 points/hour and returns in ~0.5-0.9s warm.
 * The argument is `headRefName` (String, singular); `headRefNames` does not exist and the
 * server rejects the entire document with argumentNotAccepted.
 *
 * targets: [{ key, owner, repo, host, branch }] → { byKey: Map<key, {number,state}|null>, error }
 */
async function runBatch(targets) {
  const byKey = new Map(targets.map((t) => [t.key, null]));

  // sample-1..4 share owner/repo AND branch, so dedupe to distinct pairs before asking.
  const pairs = new Map();
  for (const t of targets) {
    if (!t.owner || !t.repo || !t.branch) continue;
    const host = t.host || 'github.com';
    const id = `${host}\u0000${t.owner}/${t.repo}\u0000${t.branch}`;
    if (!pairs.has(id)) pairs.set(id, { host, owner: t.owner, repo: t.repo, branch: t.branch, keys: [] });
    pairs.get(id).keys.push(t.key);
  }
  if (!pairs.size) return { byKey, error: null };

  const byHost = new Map();
  for (const pair of pairs.values()) {
    if (!byHost.has(pair.host)) byHost.set(pair.host, []);
    byHost.get(pair.host).push(pair);
  }

  let error = null;
  for (const [host, list] of byHost) {
    for (let start = 0; start < list.length; start += ALIAS_BATCH) {
      const chunk = list.slice(start, start + ALIAS_BATCH);
      const body = chunk.map((pair, i) => {
        const open = `open: pullRequests(headRefName:${gqlString(pair.branch)}, states:OPEN, first:1){nodes{${PR_FIELDS}}}`;
        const recent = TRUNK_BRANCHES.has(pair.branch.toLowerCase()) ? ''
          : ` recent: pullRequests(headRefName:${gqlString(pair.branch)}, first:1, orderBy:{field:UPDATED_AT, direction:DESC}){nodes{${PR_FIELDS}}}`;
        return `  a${i}: repository(owner:${gqlString(pair.owner)}, name:${gqlString(pair.repo)}){ ${open}${recent} }`;
      }).join('\n');

      const r = await gh(['api', 'graphql'].concat(hostArgs({ host }), ['-f', `query=query {\n${body}\n}`]),
        { timeout: 20000 });
      const res = readGraphql(r);
      if (!res.data) { error = error || res.error; continue; }
      chunk.forEach((pair, i) => {
        const pr = pickPr(res.data[`a${i}`]);
        for (const key of pair.keys) byKey.set(key, pr);
      });
    }
  }
  return { byKey, error };
}

/**
 * The pull request for one repo's branch: { number, state } | null.
 * On a gh failure the result still LOOKS like "no PR" ({number:null}) so a naive caller
 * renders nothing, and carries the sentence in `error` for a caller that checks.
 */
function prForBranch(dir, branch) {
  if (!dir || !branch) return Promise.resolve(null);
  const name = String(branch);
  return cachedCall(prKey(dir, name), async () => {
    const remote = await remoteFor(dir);
    if (!remote) return null;                       // not a GitHub repo → no PR, cleanly
    const { byKey, error } = await runBatch([
      { key: dir, owner: remote.owner, repo: remote.repo, host: remote.host, branch: name },
    ]);
    if (error) return { number: null, state: null, error };
    return byKey.get(dir) || null;
  });
}

function displayName(repo) {
  if (!repo) return null;
  if (repo.name) return String(repo.name);
  if (repo.dirName) return String(repo.dirName);
  return repo.dir ? path.basename(String(repo.dir)) : null;
}

/**
 * One batched call for a whole workspace: { [repoName]: {number,state} | null }.
 * Repos already answered within the last 60 s are served from cache and left out of the query.
 * A total gh failure leaves every entry null and sets a NON-ENUMERABLE `error` — so the map
 * stays clean over IPC while a main-process caller can still see what went wrong.
 */
async function prSummaryForRepos(repos) {
  const list = Array.isArray(repos) ? repos.filter(Boolean) : [];
  const out = {};
  const waits = [];
  const misses = [];

  for (const repo of list) {
    const name = displayName(repo);
    if (!name) continue;
    out[name] = null;
    const branch = repo.branch ? String(repo.branch) : null;
    if (!repo.dir || !branch) continue;
    const hit = freshHit(prKey(repo.dir, branch));
    if (hit) {
      waits.push(hit.then((pr) => { out[name] = pr && pr.number ? { number: pr.number, state: pr.state } : null; }));
      continue;
    }
    const known = repo.remote && repo.remote.owner && repo.remote.repo
      ? { owner: repo.remote.owner, repo: repo.remote.repo, host: repo.remote.host || 'github.com' }
      : null;
    misses.push({ name, dir: repo.dir, branch, remote: known });
  }

  await Promise.all(misses.map(async (m) => { if (!m.remote) m.remote = await remoteFor(m.dir); }));

  const targets = misses.filter((m) => m.remote).map((m) => ({
    key: m.dir, owner: m.remote.owner, repo: m.remote.repo, host: m.remote.host, branch: m.branch,
  }));
  for (const m of misses) if (!m.remote) remember(prKey(m.dir, m.branch), null);

  let failed = null;
  if (targets.length) {
    const { byKey, error } = await runBatch(targets);
    failed = error;
    if (!error) {
      for (const m of misses) {
        if (!m.remote) continue;
        const pr = byKey.get(m.dir) || null;
        remember(prKey(m.dir, m.branch), pr);
        out[m.name] = pr;
      }
    }
  }

  await Promise.all(waits);
  if (failed) Object.defineProperty(out, 'error', { value: failed, enumerable: false, configurable: true });
  return out;
}

// ---------------------------------------------------------------- reactions

// GitHub's eight reactions, as the emoji GitHub itself draws for them.
const REACTION_EMOJI = {
  THUMBS_UP: '👍', THUMBS_DOWN: '👎', LAUGH: '😄', HOORAY: '🎉',
  CONFUSED: '😕', HEART: '❤️', ROCKET: '🚀', EYES: '👀',
};
const REACTORS_SHOWN = 10;

// Two spellings of the same field, and the difference is the rate limit. WHO reacted matters
// on the description, the conversation comments and the reviews: a 👍 from
// chatgpt-codex-connector on the description is the Codex connector saying the PR is clean
// (it posts no review at all in that case), and that is only readable with the login. On the
// inline review comments a count is enough — and it is what keeps the query cheap: reactors
// under every inline comment cost 53 points of the 5000/hour per PR (measured on #81),
// counts alone cost 3.
const REACTIONS_WHO = `reactionGroups{content reactors(first:${REACTORS_SHOWN}){totalCount nodes{__typename ... on User{login} ... on Bot{login} ... on Mannequin{login} ... on Organization{login}}}}`;
const REACTIONS_COUNT = 'reactionGroups{content users{totalCount}}';

/** [{ content, emoji, count, users }] — only the reactions somebody actually left. */
function reactions(groups) {
  const out = [];
  for (const g of groups || []) {
    if (!g || !g.content) continue;
    const box = g.reactors || g.users || {};
    const count = Number(box.totalCount) || 0;
    if (!count) continue;
    const users = (box.nodes || []).map((n) => n && n.login).filter(Boolean);
    out.push({ content: g.content, emoji: REACTION_EMOJI[g.content] || g.content, count, users });
  }
  return out;
}

// ---------------------------------------------------------------- PR detail

const PR_DETAIL_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      number title state isDraft url headRefName baseRefName headRefOid mergeable
      additions deletions changedFiles createdAt updatedAt
      body author{login} reviewDecision
      ${REACTIONS_WHO}
      commits{totalCount}
      comments(first:${CONVERSATION_PER_PR}){totalCount nodes{
        databaseId url body createdAt author{login} ${REACTIONS_WHO}
      }}
      reviews(first:${REVIEWS_PER_PR}){totalCount nodes{
        databaseId state body url createdAt submittedAt author{login} ${REACTIONS_WHO}
      }}
      reviewThreads(first:${THREADS_PER_PR}){nodes{
        isResolved isOutdated subjectType path line originalLine diffSide
        comments(first:${COMMENTS_PER_THREAD}){nodes{
          databaseId url body createdAt diffHunk author{login} replyTo{databaseId}
          pullRequestReview{databaseId} ${REACTIONS_COUNT}
        }}
      }}
    }}}`;

function toPrNumber(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The PR's GraphQL node — metadata plus every review thread with its isResolved / isOutdated
 * flags. isResolved exists ONLY in GraphQL; no REST endpoint exposes it.
 * `-F number=` (capital F) coerces to Int; lowercase -f sends a String and the query fails.
 */
function prNode(target) {
  const { dir, remote, number } = target;
  return cachedCall(nodeKey(dir, number), async () => {
    const r = await gh(['api', 'graphql'].concat(hostArgs(remote), [
      '-f', `owner=${remote.owner}`, '-f', `repo=${remote.repo}`, '-F', `number=${number}`,
      '-f', `query=${PR_DETAIL_QUERY}`,
    ]), { timeout: 25000 });
    const res = readGraphql(r);
    if (!res.data) return { error: res.error };
    const repository = res.data.repository;
    const pr = repository && repository.pullRequest;
    if (!pr) return { error: target.missing };
    return pr;
  });
}

/** Per-file patches. `gh api --jq` streams NDJSON — one object per line, never a JSON array. */
async function prFiles(remote, number) {
  const r = await gh(['api', '--paginate'].concat(hostArgs(remote), [
    `repos/${remote.owner}/${remote.repo}/pulls/${number}/files`,
    '--jq', '.[] | {path:.filename, add:.additions, del:.deletions, patch:.patch}',
  ]), { timeout: 30000 });
  if (r.code !== 0) return { error: failureMessage(r) };
  const files = [];
  for (const line of r.stdout.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    let row;
    try { row = JSON.parse(text); } catch (_) { continue; }   // one odd line must not lose the PR
    const patch = typeof row.patch === 'string' ? row.patch : '';
    const add = Number(row.add) || 0;
    const del = Number(row.del) || 0;
    files.push({
      path: row.path || '',
      add,
      del,
      // GitHub sends `patch: null` for binary files (0/0) and for files over its size cap.
      patch,
      binary: !patch && add === 0 && del === 0,
    });
  }
  return { files };
}

function initials(login) {
  const letters = String(login || '').replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase();
  return letters || '??';
}

function relativeTime(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * Flatten review threads into PrComments.
 *
 * A LINE thread with `line: null` is OUTDATED — the line it was written against is gone from
 * the PR's current diff (this matches GraphQL's isOutdated exactly on the verified PR). Those
 * comments are kept and flagged, but deliberately left UNANCHORED (`line: null`):
 * `originalLine` indexes the diff of an OLDER head commit, so reusing it against the patch on
 * screen pins the card to whatever code now sits at that number. On PR #81 that put a comment
 * about `outcome: session.weightDelta > 0 ? …` under an unrelated `const done = …`
 * declaration, which reads as a reviewer objecting to an innocent line. diffview renders a
 * `line: null` comment under the file's diff instead. `originalLine` and `diffHunk` are still
 * carried so the card can show which line, and which code, it WAS written against — the whole
 * point of keeping an outdated comment is that a reader can see what it was aimed at.
 *
 * `subjectType: 'FILE'` also has `line: null`, but means a file-level comment — never
 * outdated. Only GraphQL's own isOutdated, or a LINE thread that lost its line, is.
 *
 * `position` / `original_position` are never used: on the verified PR one comment reported
 * position 1 next to original_position 539, which is incoherent.
 */
function commentsFromThreads(threads) {
  const out = [];
  for (const thread of threads || []) {
    const live = thread.line !== null && thread.line !== undefined;
    const fileLevel = thread.subjectType === 'FILE';
    const outdated = !!thread.isOutdated || (!live && !fileLevel);
    const originalLine = thread.originalLine === null || thread.originalLine === undefined
      ? null
      : thread.originalLine;
    const nodes = (thread.comments && thread.comments.nodes) || [];
    for (const c of nodes) {
      const author = (c.author && c.author.login) || 'ghost';
      out.push({
        id: c.databaseId,
        path: thread.path || '',
        line: live ? thread.line : null,
        originalLine,
        diffHunk: typeof c.diffHunk === 'string' ? c.diffHunk : '',
        side: thread.diffSide || 'RIGHT',
        url: c.url || '',
        body: c.body || '',
        author,
        avatarInitials: initials(author),
        createdAt: c.createdAt || '',
        relative: relativeTime(c.createdAt),
        resolved: !!thread.isResolved,
        outdated,
        replyTo: c.replyTo ? c.replyTo.databaseId : null,
        // The review this comment was posted as part of — how the Overview folds it
        // under that review's body, the way GitHub's conversation tab does.
        reviewId: c.pullRequestReview ? c.pullRequestReview.databaseId : null,
        reactions: reactions(c.reactionGroups),
      });
    }
  }
  // Unanchored comments sort last within their file. Infinity - Infinity is NaN, which a
  // comparator must never return, so the rank is a finite number.
  const rank = (c) => (c.line === null || c.line === undefined ? Number.MAX_SAFE_INTEGER : c.line);
  out.sort((a, b) => (
    a.path.localeCompare(b.path)
    || rank(a) - rank(b)
    || String(a.createdAt).localeCompare(String(b.createdAt))
    || a.id - b.id
  ));
  return out;
}

function withHiddenError(value, message) {
  Object.defineProperty(value, 'error', { value: message, enumerable: false, configurable: true });
  return value;
}

/**
 * Resolve a directory (and an optional PR number) to { dir, remote, number, missing } or to an
 * { error } sentence. `missing` is what to say if GitHub turns out not to have that PR: the
 * branch sentence when we looked the number up ourselves, a number sentence when the caller
 * handed us one that has since gone away.
 */
async function resolveTarget(dir, number, branchHint) {
  if (!dir) return { error: 'no repository to look at' };
  const remote = await remoteFor(dir);
  if (!remote) return { error: NO_GITHUB_REMOTE };
  const explicit = toPrNumber(number);
  if (explicit) {
    return { dir, remote, number: explicit, branch: branchHint || null,
             missing: `no pull request #${explicit} in ${remote.owner}/${remote.repo}` };
  }
  const branch = branchHint || currentBranch(dir);
  const found = await prForBranch(dir, branch);
  if (found && found.error) return { error: found.error };
  if (!found || !found.number) return { error: noPrMessage(branch) };
  return { dir, remote, number: found.number, branch, missing: noPrMessage(branch) };
}

const REVIEW_VERDICTS = {
  APPROVED: 'approved', CHANGES_REQUESTED: 'requested changes', COMMENTED: 'commented',
  DISMISSED: 'dismissed', PENDING: 'pending',
};

function person(node) {
  const login = (node && node.login) || 'ghost';
  return { author: login, avatarInitials: initials(login) };
}

/**
 * The conversation, as GitHub's own tab shows it (ARCHITECTURE §2 `PrEvent`): every comment
 * on the pull request and every review, oldest first, each review carrying the inline
 * comments it was submitted with. A review with nothing to say — no body, no inline
 * comments, state COMMENTED — is the empty shell GitHub leaves when a single inline comment
 * is posted on its own; it is dropped. An empty APPROVED or CHANGES_REQUESTED review is
 * kept: the verdict is the content. An inline comment whose review is not on the first page
 * (or has no review at all) still gets a row of its own rather than going missing.
 */
function timelineOf(pr, inline) {
  const byReview = new Map();
  for (const c of inline) {
    if (c.reviewId === null || c.reviewId === undefined) continue;
    if (!byReview.has(c.reviewId)) byReview.set(c.reviewId, []);
    byReview.get(c.reviewId).push(c);
  }
  const out = [];
  for (const c of (pr.comments && pr.comments.nodes) || []) {
    if (!c) continue;
    out.push(Object.assign({
      kind: 'comment', id: c.databaseId, url: c.url || '', body: c.body || '',
      createdAt: c.createdAt || '', relative: relativeTime(c.createdAt),
      reactions: reactions(c.reactionGroups), state: null, verdict: null, comments: [],
    }, person(c.author)));
  }
  const claimed = new Set();
  for (const r of (pr.reviews && pr.reviews.nodes) || []) {
    if (!r) continue;
    const mine = byReview.get(r.databaseId) || [];
    for (const c of mine) claimed.add(c.id);
    const body = r.body || '';
    const state = r.state || 'COMMENTED';
    if (!body.trim() && !mine.length && state === 'COMMENTED') continue;
    const at = r.submittedAt || r.createdAt || '';
    out.push(Object.assign({
      kind: 'review', id: r.databaseId, url: r.url || '', body,
      createdAt: at, relative: relativeTime(at),
      reactions: reactions(r.reactionGroups),
      state, verdict: REVIEW_VERDICTS[state] || String(state).toLowerCase(), comments: mine,
    }, person(r.author)));
  }
  for (const c of inline) {
    if (claimed.has(c.id)) continue;
    out.push({
      kind: 'inline', id: c.id, url: c.url, body: '', author: c.author, avatarInitials: c.avatarInitials,
      createdAt: c.createdAt, relative: c.relative, reactions: [], state: null, verdict: null, comments: [c],
    });
  }
  // ISO timestamps sort as strings; the id breaks a tie the way GitHub does.
  out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || (Number(a.id) || 0) - (Number(b.id) || 0));
  return out;
}

/**
 * The comments on the PR: the conversation's, plus every inline review comment. A
 * review's own body is a review, not a comment — which is also what keeps this number
 * the one the Pull requests list shows (comments + review threads, from the search).
 */
function countSaid(timeline) {
  let n = 0;
  for (const t of timeline) {
    if (t.kind === 'comment') n++;
    n += (t.comments || []).length;
  }
  return n;
}

/**
 * The whole Pull request screen's data (ARCHITECTURE §2 `Pr`), in two gh calls: one GraphQL
 * round trip for metadata, the description, the conversation and every review thread; one
 * REST call for the per-file patches. `target` is what resolveTarget() answers.
 */
async function fetchDetail(target) {
  const [pr, filesResult] = await Promise.all([
    prNode(target),
    prFiles(target.remote, target.number),
  ]);
  if (pr.error) return { error: pr.error };
  if (filesResult.error) return { error: filesResult.error };
  const comments = commentsFromThreads(pr.reviewThreads && pr.reviewThreads.nodes);
  const timeline = timelineOf(pr, comments);
  return Object.assign({
    number: pr.number,
    title: pr.title || '',
    state: prState(pr),
    url: pr.url || '',
    owner: target.remote.owner,
    repo: target.remote.repo,
    headRef: pr.headRefName || '',
    baseRef: pr.baseRefName || '',
    headSha: pr.headRefOid || null,
    mergeable: pr.mergeable || 'UNKNOWN',       // MERGEABLE | CONFLICTING | UNKNOWN (still computing)
    commits: (pr.commits && pr.commits.totalCount) || 0,
    changedFiles: pr.changedFiles || 0,
    additions: pr.additions || 0,
    deletions: pr.deletions || 0,
    createdAt: pr.createdAt || '',
    relative: relativeTime(pr.createdAt),
    updatedAt: pr.updatedAt || '',
    body: pr.body || '',
    reviewDecision: pr.reviewDecision || null,
    reactions: reactions(pr.reactionGroups),
    timeline,
    files: filesResult.files,
    comments,
    commentCount: countSaid(timeline),
  }, person(pr.author));
}

/**
 * The Pull request screen for one repo's branch. `number` may be omitted — the branch's PR
 * is looked up, and its absence is reported as `no pull request for <branch> yet`.
 */
async function prDetail(dir, number, options) {
  const opts = options || {};
  const target = await resolveTarget(dir, number, opts.branch);
  if (target.error) return { error: target.error };
  return cachedCall(detailKey(dir, target.number), () => fetchDetail(target));
}

/**
 * The same screen for a pull request named by owner/repo/number alone — the way the "My pull
 * requests" list opens one, which may be in a repo that is cloned nowhere under the root.
 * Cached under a `host/owner/repo` pseudo-directory, which no real directory can collide
 * with (those start with a slash). `fresh` drops what is cached for that repo first.
 */
function prDetailByRemote(remote, number, options) {
  const opts = options || {};
  const n = toPrNumber(number);
  if (!remote || !remote.owner || !remote.repo) return Promise.resolve({ error: 'no repository to look at' });
  if (!n) return Promise.resolve({ error: 'no pull request number' });
  const host = remote.host || 'github.com';
  const key = `${host}/${remote.owner}/${remote.repo}`;
  if (opts.fresh) invalidate(key);
  const target = {
    dir: key, number: n,
    remote: { owner: String(remote.owner), repo: String(remote.repo), host },
    missing: `no pull request #${n} in ${remote.owner}/${remote.repo}`,
  };
  return cachedCall(detailKey(key, n), () => fetchDetail(target));
}

// ---------------------------------------------------------------- squash and merge

/**
 * gh's refusal reads `X Pull request #12 is not mergeable: the base branch policy prohibits
 * the merge.` — one glyph and one sentence. The glyph goes, and so does the "failed to merge
 * pull request:" wrapper gh puts round GitHub's own words, so the bar holds the sentence.
 */
function mergeFailure(r) {
  return failureMessage(r)
    .replace(/^[X✓!-]\s+/, '')
    .replace(/^failed to merge pull request:\s*/i, '')
    .replace(/^GraphQL:\s*/, '')
    .replace(/\s*\(mergePullRequest\)\s*$/, '');   // GraphQL's field path, no use to a reader
}

// After a merge, what GitHub says it merged — asked rather than trusted from the screen,
// because the branch about to be deleted is the one GitHub names, and only if the merge
// really happened and the branch is this repository's own (a fork's is not ours to delete).
const MERGED_HEAD_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){ pullRequest(number:$number){
    state headRefName baseRefName isCrossRepository
  }}}`;

/**
 * `DELETE /repos/o/r/git/refs/heads/<branch>` — the click GitHub's own "Delete branch"
 * button makes. A 422 "Reference does not exist" means it is already gone (the repository
 * may delete head branches by itself), which is the outcome wanted, so it counts as deleted;
 * any other refusal (a protected branch, say) is reported as GitHub's sentence.
 */
async function deleteRemoteBranch(remote, branch) {
  const ref = String(branch).split('/').map(encodeURIComponent).join('/');
  const r = await gh(['api', '--method', 'DELETE'].concat(hostArgs(remote), [
    `repos/${remote.owner}/${remote.repo}/git/refs/heads/${ref}`,
  ]), { timeout: 25000 });
  if (r.code === 0) return { name: branch, deleted: true };
  if (/Reference does not exist/i.test(r.stderr)) return { name: branch, deleted: true, already: true };
  return { name: branch, deleted: false, error: mergeFailure(r) };
}

/**
 * The merged pull request's branch, deleted on GitHub — and only there: the checkout's
 * local branch is left exactly as it was (§0). Refuses, with a reason, when GitHub does not
 * say the pull request is merged, when the branch lives in a fork, or when it is a trunk.
 * `dryRun` answers what would be deleted without deleting it — the verification path.
 *
 * Resolves { name, deleted: true, already? } | { name, deleted: false, skipped } |
 * { name, deleted: false, error } | { name, dryRun: true }.
 */
async function deleteHeadBranch(target, options) {
  const opts = options || {};
  const { remote, number } = target;
  const r = await gh(['api', 'graphql'].concat(hostArgs(remote), [
    '-f', `owner=${remote.owner}`, '-f', `repo=${remote.repo}`, '-F', `number=${number}`,
    '-f', `query=${MERGED_HEAD_QUERY}`,
  ]), { timeout: 25000 });
  const res = readGraphql(r);
  const pr = res.data && res.data.repository && res.data.repository.pullRequest;
  if (!pr) return { name: null, deleted: false, error: res.error || target.missing || 'GitHub did not answer' };
  const name = pr.headRefName || null;
  if (pr.state !== 'MERGED') return { name, deleted: false, skipped: 'the pull request is not merged' };
  if (pr.isCrossRepository) return { name, deleted: false, skipped: 'it lives in a fork' };
  if (!name || TRUNK_BRANCHES.has(name) || name === pr.baseRefName) {
    return { name, deleted: false, skipped: 'it is the trunk' };
  }
  if (opts.dryRun) return { name, deleted: false, dryRun: true };
  return deleteRemoteBranch(remote, name);
}

/**
 * `gh pr merge --squash`, on GitHub and nowhere else: `-R` names the repository outright, so
 * gh never looks at — let alone touches — a checkout (§0: nothing is checked out, no local
 * branch is deleted). `headSha` is the head the screen showed, and GitHub refuses the merge
 * if the branch has moved since — the guard its own button uses. The squash commit's message
 * is GitHub's default, the one its button writes. Then the merged branch is deleted on
 * GitHub (deleteHeadBranch), the click the user was always making after a merge; its fate
 * rides along in `branch` and never turns a merge that happened into a failure. Every cached
 * answer is dropped on success: the same pull request may sit under four workspace
 * directories, the list's pseudo-directory and the list itself.
 *
 * Resolves { merged: true, branch } — or { merged: false, queued: true, branch: null } when
 * the base branch has a merge queue and gh could only enrol the pull request in it, the
 * branch then being still needed — or { error }.
 */
async function runMerge(target, options) {
  const opts = options || {};
  const { remote, number } = target;
  const where = (remote.host && remote.host !== 'github.com' ? `${remote.host}/` : '') + `${remote.owner}/${remote.repo}`;
  const args = ['pr', 'merge', String(number), '--squash', '--repo', where];
  if (opts.headSha) args.push('--match-head-commit', String(opts.headSha));
  const r = await gh(args, { timeout: 60000 });
  if (r.code !== 0) return { error: mergeFailure(r) };
  invalidate();
  const said = `${r.stdout}\n${r.stderr}`;
  const queued = /automatically merged|merge queue/i.test(said);
  const base = { number, owner: remote.owner, repo: remote.repo };
  if (queued) return Object.assign(base, { merged: false, queued: true, branch: null });
  const branch = await deleteHeadBranch(target);
  invalidate();
  return Object.assign(base, { merged: true, queued: false, branch });
}

/** Squash and merge the pull request of one local repo — its branch's, or `number`. */
async function mergePr(dir, number, options) {
  const target = await resolveTarget(dir, number, options && options.branch);
  if (target.error) return { error: target.error };
  return runMerge(target, options);
}

/** The same for a pull request named by owner/repo/number alone — a row of the list. */
function mergePrByRemote(remote, number, options) {
  const n = toPrNumber(number);
  if (!remote || !remote.owner || !remote.repo) return Promise.resolve({ error: 'no repository to look at' });
  if (!n) return Promise.resolve({ error: 'no pull request number' });
  const target = {
    number: n,
    remote: { owner: String(remote.owner), repo: String(remote.repo), host: remote.host || 'github.com' },
  };
  return runMerge(target, options);
}

// ---------------------------------------------------------------- my pull requests

// GitHub's own search, which is the only call that spans every repository at once.
// `author:@me` is resolved server-side to the signed-in user; `sort:updated-desc` is the
// order the list shows. Cost: one point.
const MY_PRS_QUERY = `query {
  viewer { login }
  search(query:"is:pr is:open author:@me archived:false sort:updated-desc", type:ISSUE, first:${MY_PRS_MAX}) {
    issueCount
    nodes { ... on PullRequest {
      number title url isDraft state headRefName baseRefName createdAt updatedAt
      additions deletions changedFiles reviewDecision
      repository { name owner { login } }
      comments { totalCount } reviewThreads { totalCount }
      commits(last:1) { nodes { commit { statusCheckRollup { state } } } }
    } }
  }
}`;

function checksOf(node) {
  const last = node.commits && node.commits.nodes && node.commits.nodes[0];
  const rollup = last && last.commit && last.commit.statusCheckRollup;
  return rollup && rollup.state ? rollup.state : null;   // SUCCESS | FAILURE | ERROR | PENDING | EXPECTED | null
}

/**
 * Every open pull request the signed-in user authored, in any repository, newest activity
 * first (ARCHITECTURE §2 `MyPr`): { login, prs, total, fetchedAt } or { error }. Cached for
 * 60 s like everything else; `fresh` throws that away first — ⌘R and the ↻ button.
 */
function myPullRequests(options) {
  const opts = options || {};
  if (opts.fresh) cache.delete(MINE_KEY);
  return cachedCall(MINE_KEY, async () => {
    const r = await gh(['api', 'graphql', '-f', `query=${MY_PRS_QUERY}`], { timeout: 25000 });
    const res = readGraphql(r);
    if (!res.data) return { error: res.error };
    const login = (res.data.viewer && res.data.viewer.login) || '';
    const search = res.data.search || {};
    const prs = [];
    for (const n of search.nodes || []) {
      if (!n || !n.number) continue;
      const repo = n.repository || {};
      prs.push({
        number: n.number,
        title: n.title || '',
        url: n.url || '',
        state: prState(n),
        owner: (repo.owner && repo.owner.login) || '',
        repo: repo.name || '',
        headRef: n.headRefName || '',
        baseRef: n.baseRefName || '',
        createdAt: n.createdAt || '',
        updatedAt: n.updatedAt || '',
        relative: relativeTime(n.updatedAt),
        additions: n.additions || 0,
        deletions: n.deletions || 0,
        changedFiles: n.changedFiles || 0,
        reviewDecision: n.reviewDecision || null,   // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
        checks: checksOf(n),
        // Threads, not comments: a thread with three replies is one conversation.
        comments: ((n.comments && n.comments.totalCount) || 0) + ((n.reviewThreads && n.reviewThreads.totalCount) || 0),
      });
    }
    return { login, prs, total: Number(search.issueCount) || prs.length, fetchedAt: Date.now() };
  });
}

/**
 * Every review comment on the PR, ready to place in a diff. Returns PrComment[]; a failure
 * returns an empty array carrying a non-enumerable `error` sentence, so a caller that just
 * renders the list can never break on it.
 */
async function reviewComments(dir, number, options) {
  const opts = options || {};
  const target = await resolveTarget(dir, number, opts.branch);
  if (target.error) return withHiddenError([], target.error);
  const pr = await prNode(target);
  if (pr.error) return withHiddenError([], pr.error);
  return commentsFromThreads(pr.reviewThreads && pr.reviewThreads.nodes);
}

/**
 * The ids of comments sitting in a thread somebody has marked resolved, so the screen can
 * collapse them. Same failure contract as reviewComments().
 */
async function resolvedThreads(dir, number, options) {
  const opts = options || {};
  const target = await resolveTarget(dir, number, opts.branch);
  if (target.error) return withHiddenError([], target.error);
  const pr = await prNode(target);
  if (pr.error) return withHiddenError([], pr.error);
  const ids = [];
  for (const thread of (pr.reviewThreads && pr.reviewThreads.nodes) || []) {
    if (!thread.isResolved) continue;
    for (const c of (thread.comments && thread.comments.nodes) || []) ids.push(c.databaseId);
  }
  return ids;
}

module.exports = {
  prForBranch,
  prSummaryForRepos,
  prDetail,
  prDetailByRemote,
  myPullRequests,
  mergePr,
  mergePrByRemote,
  deleteHeadBranch,
  deleteRemoteBranch,
  reviewComments,
  resolvedThreads,
  invalidate,
  prewarm,
};
