'use strict';

// npm run test:config — the repos of a workspace (workspaces.reposOf, scan) and what git.js
// and editor.js make of a workspace FOLDER that is a repo itself, attached and parked.
// Plain node, no Electron.
//
// The fixture is fictional (AGENTS.md) and hermetic, the way test-editor.js is: a scratch
// SWITCHBOARD_CONFIG, and the user's own git config kept out. All of it is set BEFORE the
// modules are required — config.js reads SWITCHBOARD_CONFIG, and git.js copies process.env
// into GIT_ENV, at load.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test, before, after } = require('node:test');

// realpath: os.tmpdir() is under /var, which is a symlink to /private/var.
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-workspaces-test-')));
const ENV_KEYS = ['SWITCHBOARD_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'XDG_CONFIG_HOME'];
const previousEnv = {};
for (const key of ENV_KEYS) previousEnv[key] = process.env[key];
fs.mkdirSync(path.join(temp, 'xdg'));
process.env.SWITCHBOARD_CONFIG = path.join(temp, 'config.json');
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.XDG_CONFIG_HOME = path.join(temp, 'xdg');

const workspaces = require('../src/main/workspaces');
const editor = require('../src/main/editor');
const gitjs = require('../src/main/git');

const root = path.join(temp, 'root');
// demo-2: a folder of repos that is a repo itself, and does NOT gitignore its children.
const demo = path.join(root, 'demo-2');
const demoApi = path.join(demo, 'demo-api-2');
const demoWeb = path.join(demo, 'demo-web-2');
// sample-3: the same shape with its git dir PARKED, an origin, and its children gitignored.
const sample = path.join(root, 'sample-3');
const sampleApi = path.join(sample, 'sample-api-3');
const sampleWeb = path.join(sample, 'sample-web-3');
const origin = path.join(temp, 'origin', 'sample-workspace.git');
const upstream = path.join(temp, 'upstream');
// plain-1: a folder of repos that is not one. lone-1: a repo with ONE repo inside it.
const plain = path.join(root, 'plain-1');
const lone = path.join(root, 'lone-1');
// Declared single repos, outside the root: one attached, one parked.
const solo = path.join(temp, 'solo', 'demo-app');
const parkedSolo = path.join(temp, 'solo', 'parked-app');

function git(dir, ...args) {
  return execFileSync('git', [
    '-c', 'user.name=Sample Person', '-c', 'user.email=sample@example.com',
    '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false',
    '-C', dir,
  ].concat(args), { stdio: 'pipe', encoding: 'utf8' });
}

function put(dir, rel, content) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** A repo with one commit holding `files`. */
function repo(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  for (const rel of Object.keys(files)) put(dir, rel, files[rel]);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

function park(dir) {
  fs.renameSync(path.join(dir, '.git'), path.join(dir, gitjs.PARKED_GIT));
}

function names(list) {
  return list.map(r => r.name);
}

before(() => {
  repo(demo, { 'README.md': '# Demo\n', 'scripts/dev.sh': '#!/bin/sh\necho demo\n' });
  repo(demoApi, { 'server.js': "const needle = 'api';\n" });
  repo(demoWeb, { 'app.js': "const needle = 'web';\n" });
  put(demo, 'README.md', '# Demo\n\nOne more line.\n');       // modified
  put(demo, 'docs/plan.md', 'a needle in the plan\nline two'); // untracked, no final newline
  put(demoApi, 'notes.txt', 'untracked in the api\n');

  // sample-3 is pushed to a bare origin before it is parked, so it has something to fetch.
  repo(sample, { '.gitignore': 'sample-api-*/\nsample-web-*/\n', 'README.md': '# Sample\n' });
  fs.mkdirSync(path.dirname(origin), { recursive: true });
  git(temp, 'init', '-q', '--bare', origin);
  git(sample, 'remote', 'add', 'origin', origin);
  git(sample, 'push', '-q', '-u', 'origin', 'main');
  repo(sampleApi, { 'server.js': "const needle = 'api';\n" });
  repo(sampleWeb, { 'app.js': "const needle = 'web';\n" });
  put(sample, 'docs/notes.md', 'a needle in the notes\n');     // untracked
  park(sample);

  repo(path.join(plain, 'plain-api-1'), { 'a.txt': 'a\n' });
  repo(path.join(plain, 'plain-web-1'), { 'b.txt': 'b\n' });

  repo(lone, { 'README.md': '# Lone\n' });
  repo(path.join(lone, 'lone-api-1'), { 'a.txt': 'a\n' });

  repo(solo, { 'main.txt': 'solo\n' });
  repo(parkedSolo, { 'main.txt': 'parked solo\n' });
  park(parkedSolo);

  fs.writeFileSync(process.env.SWITCHBOARD_CONFIG, JSON.stringify({
    root,
    workspaces: { 'demo-app': { dir: solo }, 'parked-app': { dir: parkedSolo } },
  }));
});

after(() => {
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  fs.rmSync(temp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// discovery and reposOf
// ---------------------------------------------------------------------------

test('a folder being a repo itself changes nothing about which folders are workspaces', async () => {
  const found = (await workspaces.discover()).map(w => w.id).sort();
  // lone-1 is a repo with one repo inside: still not two children, still not discovered.
  assert.deepEqual(found, ['demo-2', 'demo-app', 'parked-app', 'plain-1', 'sample-3']);
});

test('reposOf lists the folder first when it is a repo, then its children', async () => {
  const list = workspaces.reposOf(await workspaces.lookup('demo-2'));
  assert.deepEqual(list, [
    { name: 'demo', dirName: 'demo-2', dir: demo, root: true, nested: ['demo-api-2', 'demo-web-2'] },
    { name: 'demo-api', dirName: 'demo-api-2', dir: demoApi, root: false, nested: [] },
    { name: 'demo-web', dirName: 'demo-web-2', dir: demoWeb, root: false, nested: [] },
  ]);
});

test('reposOf counts a parked git dir as a repo', async () => {
  assert.deepEqual(names(workspaces.reposOf(await workspaces.lookup('sample-3'))), ['sample', 'sample-api', 'sample-web']);
  assert.deepEqual(workspaces.reposOf(await workspaces.lookup('parked-app')),
    [{ name: 'parked-app', dirName: 'parked-app', dir: parkedSolo, root: true, nested: [] }]);
});

test('reposOf leaves a plain folder of repos and a single repo as they were', async () => {
  assert.deepEqual(names(workspaces.reposOf(await workspaces.lookup('plain-1'))), ['plain-api', 'plain-web']);
  assert.deepEqual(workspaces.reposOf(await workspaces.lookup('demo-app')),
    [{ name: 'demo-app', dirName: 'demo-app', dir: solo, root: true, nested: [] }]);
  assert.deepEqual(workspaces.reposOf(null), []);
});

test('the folder never takes a name one of its children answers to', () => {
  const clash = path.join(temp, 'clash', 'demo-2');
  // The child `demo-2` is shown as `demo`, which is what the folder would be called.
  for (const child of ['demo-2', 'demo-web-2']) fs.mkdirSync(path.join(clash, child, '.git'), { recursive: true });
  fs.mkdirSync(path.join(clash, '.git'));
  assert.deepEqual(names(workspaces.reposOf({ id: 'demo-2', dir: clash })), ['demo-2', 'demo', 'demo-web']);
  // …and when its full name is taken as well, it is `.`, which no child can be.
  fs.mkdirSync(path.join(clash, 'demo-2-2', '.git'), { recursive: true });
  assert.deepEqual(names(workspaces.reposOf({ id: 'demo-2', dir: clash })), ['.', 'demo', 'demo-2', 'demo-web']);
});

test('a .git beside a parked git dir wins: the repo is attached', () => {
  const both = repo(path.join(temp, 'both'), { 'a.txt': 'a\n' });
  fs.mkdirSync(path.join(both, gitjs.PARKED_GIT));
  assert.equal(gitjs.parkedGitDir(both), null);
  assert.equal(gitjs.gitDirs(both).gitDir, path.join(both, '.git'));
  // A FILE of that name is not a git dir of any kind.
  const notDir = path.join(temp, 'not-a-dir');
  put(notDir, gitjs.PARKED_GIT, 'not a folder\n');
  assert.equal(gitjs.parkedGitDir(notDir), null);
  assert.equal(gitjs.gitDirs(notDir), null);
});

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

test('scan reports the folder as the first repo, with its own changes and not its children', async () => {
  const ws = await workspaces.scan('demo-2');
  assert.equal(ws.error, null);
  assert.deepEqual(names(ws.repos), ['demo', 'demo-api', 'demo-web']);
  const [folder, api, web] = ws.repos;
  assert.equal(folder.root, true);
  assert.equal(folder.dir, demo);
  assert.equal(folder.error, null);
  assert.equal(folder.branch, 'main');
  assert.equal(folder.onMain, true);
  assert.deepEqual(folder.nested, ['demo-api-2', 'demo-web-2']);
  // The children are not gitignored here: without `nested` each is an untracked "file".
  assert.deepEqual(folder.files.map(f => f.status + ' ' + f.path), ['M README.md', '? docs/plan.md']);
  assert.equal(api.root, false);
  assert.deepEqual(api.files.map(f => f.status + ' ' + f.path), ['? notes.txt']);
  assert.deepEqual(web.files, []);
  // The workspace's totals are over every repo, the folder included.
  assert.equal(ws.files, 3);
  assert.equal(ws.add, folder.add + api.add);
  assert.equal(ws.branchSummary, 'main');
});

test('an untracked file is counted as git counts it, without a process per file', async () => {
  const dir = repo(path.join(temp, 'counts'), { 'kept.txt': 'kept\n' });
  put(dir, 'two.txt', 'a\nb\n');
  put(dir, 'no-final-newline.txt', 'a\nb');
  put(dir, 'crlf.txt', 'a\r\nb\r\n');
  put(dir, 'empty.txt', '');
  put(dir, 'image.bin', Buffer.from([0x89, 0x50, 0x00, 0x01]));
  put(dir, 'nul-after-the-sniff.txt', Buffer.concat([Buffer.alloc(8000, 0x61), Buffer.from([0x00, 0x0a, 0x62, 0x0a])]));
  fs.symlinkSync('two.txt', path.join(dir, 'link.txt'));       // not a regular file: git's own count
  const ch = await gitjs.changes(dir);
  assert.equal(ch.ok, true);
  const by = {};
  for (const f of ch.files) by[f.path] = [f.add, f.del, f.binary];
  assert.deepEqual(by, {
    'crlf.txt': [2, 0, false],
    'empty.txt': [0, 0, false],
    'image.bin': [0, 0, true],
    'link.txt': [1, 0, false],
    'no-final-newline.txt': [2, 0, false],
    'nul-after-the-sniff.txt': [2, 0, false],
    'two.txt': [2, 0, false],
  });
  // …and every one of them is what `git diff --no-index --numstat` says.
  for (const rel of Object.keys(by)) {
    let out;
    try {
      out = git(dir, 'diff', '--no-index', '--numstat', '--', '/dev/null', rel);
    } catch (err) {
      out = String(err.stdout || '');                           // exit 1 is "they differ"
    }
    const m = out.match(/^(\d+|-)\t(\d+|-)\t/);
    const want = !m ? [0, 0, false] : m[1] === '-' ? [0, 0, true] : [Number(m[1]), Number(m[2]), false];
    assert.deepEqual(by[rel], want, rel);
  }
});

// ---------------------------------------------------------------------------
// a parked git dir
// ---------------------------------------------------------------------------

test('a parked folder scans as the repo it is, and its git dir is not among its files', async () => {
  assert.equal(fs.existsSync(path.join(sample, '.git')), false);
  const ws = await workspaces.scan('sample-3');
  assert.deepEqual(names(ws.repos), ['sample', 'sample-api', 'sample-web']);
  const folder = ws.repos[0];
  assert.equal(folder.error, null);
  assert.equal(folder.root, true);
  assert.equal(folder.branch, 'main');
  assert.match(folder.head, /^[0-9a-f]{40}$/);
  assert.equal(folder.hasOrigin, true);
  assert.equal(folder.ahead, 0);
  assert.equal(folder.behind, 0);
  assert.deepEqual(folder.files.map(f => f.status + ' ' + f.path), ['? docs/notes.md']);
  assert.equal(folder.add, 1);
  assert.equal(typeof folder.fetchedAt, 'number', 'the push stamped refs/remotes in the parked git dir');
});

test('a parked repo answers every read git.js has', async () => {
  const dirs = gitjs.gitDirs(sample);
  assert.deepEqual(dirs, { gitDir: path.join(sample, gitjs.PARKED_GIT), commonDir: path.join(sample, gitjs.PARKED_GIT) });
  assert.equal(await gitjs.originUrl(sample), origin);
  assert.equal((await gitjs.branchInfo(sample)).branch, 'main');
  assert.deepEqual(await gitjs.headBlob(sample, 'README.md'), { ok: true, error: null, text: '# Sample\n', skip: false });

  const diff = await gitjs.fileDiff(sample, 'docs/notes.md');
  assert.equal(diff.ok, true);
  assert.match(diff.patch, /^\+a needle in the notes$/m);

  const all = await gitjs.allDiffs(sample);
  assert.deepEqual(all.files.map(f => f.path), ['docs/notes.md']);

  const ls = await gitjs.lsFiles(sample);
  assert.equal(ls.ok, true);
  assert.deepEqual(ls.files.slice().sort(), ['.gitignore', 'README.md', 'docs/notes.md']);
  assert.ok(!ls.files.concat(ls.ignored).some(p => p.split('/')[0] === gitjs.PARKED_GIT), 'nothing from the parked git dir');

  // HEAD holds `ref: refs/heads/main`, the config `bare = false`: both are untracked text.
  for (const query of ['refs/heads', 'bare']) {
    const found = await gitjs.grep(sample, query);
    assert.equal(found.ok, true);
    assert.deepEqual(found.matches, [], query);
  }
  assert.deepEqual((await gitjs.grep(sample, 'needle')).matches.map(m => m.path), ['docs/notes.md']);
});

test('a parked repo fetches and pulls main like any other', async () => {
  // Someone else pushes a commit to origin.
  execFileSync('git', ['clone', '-q', origin, upstream], { stdio: 'pipe' });
  put(upstream, 'CHANGELOG.md', 'one\n');
  git(upstream, 'add', '-A');
  git(upstream, 'commit', '-q', '-m', 'changelog');
  git(upstream, 'push', '-q', 'origin', 'main');

  assert.equal((await workspaces.scan('sample-3')).repos[0].behind, 0, 'not known until a fetch');
  const fetched = await workspaces.scan('sample-3', { fetch: true });
  assert.equal(fetched.repos[0].fetchError, null);
  assert.equal(fetched.repos[0].behind, 1);
  assert.equal(fetched.behindRepos, 1);

  const pulled = await gitjs.pullMain(sample);
  assert.equal(pulled.ok, true, pulled.message);
  assert.equal(pulled.reason, 'fast-forwarded');
  assert.equal(pulled.commits, 1);
  assert.equal(fs.readFileSync(path.join(sample, 'CHANGELOG.md'), 'utf8'), 'one\n');
  assert.equal((await workspaces.scan('sample-3')).repos[0].behind, 0);
  // It is still parked: nothing here attaches a repo.
  assert.equal(fs.existsSync(path.join(sample, '.git')), false);
  assert.equal(fs.existsSync(path.join(sample, gitjs.PARKED_GIT)), true);
});

// ---------------------------------------------------------------------------
// the Editor
// ---------------------------------------------------------------------------

test('the Editor lists the folder as a tree of its own, without the repos inside it', async () => {
  const r = await editor.tree('demo-2');
  assert.equal(r.ok, true);
  assert.deepEqual(names(r.repos), ['demo', 'demo-api', 'demo-web']);
  assert.deepEqual(r.repos[0].files.slice().sort(), ['README.md', 'docs/plan.md', 'scripts/dev.sh']);
  assert.deepEqual(r.repos[1].files.slice().sort(), ['notes.txt', 'server.js']);

  const parked = await editor.tree('sample-3');
  assert.deepEqual(names(parked.repos), ['sample', 'sample-api', 'sample-web']);
  assert.deepEqual(parked.repos[0].files.slice().sort(), ['.gitignore', 'CHANGELOG.md', 'README.md', 'docs/notes.md']);
  assert.deepEqual(parked.repos[0].ignored, []);
  assert.equal(parked.repos[0].error, null);
});

test('find in files searches the folder once, and each repo inside it once', async () => {
  const r = await editor.search('demo-2', 'needle');
  assert.equal(r.ok, true);
  const hits = r.matches.map(m => m.repo + ':' + m.path).sort();
  assert.deepEqual(hits, ['demo-api:server.js', 'demo-web:app.js', 'demo:docs/plan.md']);
});

test('the Editor reads and saves the folder\'s own files, and refuses a parked git dir', async () => {
  const read = await editor.read('sample-3', 'sample', 'README.md');
  assert.equal(read.ok, true);
  assert.equal(read.text, '# Sample\n');
  const base = await editor.base('sample-3', 'sample', 'README.md');
  assert.equal(base.text, '# Sample\n');

  const saved = await editor.write('sample-3', 'sample', 'README.md', '# Sample\n\nEdited.\n', { mtimeMs: read.mtimeMs });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(fs.readFileSync(path.join(sample, 'README.md'), 'utf8'), '# Sample\n\nEdited.\n');

  for (const rel of ['.git.disabled/config', '.git.disabled/HEAD', '.GIT.DISABLED/config', '.git.disabled']) {
    const r = await editor.read('sample-3', 'sample', rel);
    assert.equal(r.ok, false, `${rel} is refused`);
    assert.match(r.error, /is outside sample$/, rel);
  }
  const made = await editor.create('sample-3', 'sample', '.git.disabled/hooks/evil');
  assert.equal(made.ok, false);
  assert.equal(fs.existsSync(path.join(sample, '.git.disabled/hooks/evil')), false);
});
