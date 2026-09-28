'use strict';

// npm run test:editor — src/main/editor.js (M8) and the git.js helpers under it, against
// fixture repos in a temp dir. Plain node, no Electron: editor.js never requires it.
//
// The fixture is fictional (AGENTS.md) and hermetic: SWITCHBOARD_CONFIG points config.js
// at a scratch file, and GIT_CONFIG_GLOBAL / GIT_CONFIG_NOSYSTEM / XDG_CONFIG_HOME keep the
// user's own git config out of it — a global core.excludesFile or color.grep=always would
// otherwise change what the tree lists and what grep prints. All of it is set BEFORE the
// modules are required: config.js reads SWITCHBOARD_CONFIG, and git.js copies process.env
// into GIT_ENV, at load.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test, before, after } = require('node:test');

// realpath: os.tmpdir() is under /var, which is a symlink to /private/var.
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-editor-test-')));
const ENV_KEYS = ['SWITCHBOARD_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'XDG_CONFIG_HOME'];
const previousEnv = {};
for (const key of ENV_KEYS) previousEnv[key] = process.env[key];
fs.mkdirSync(path.join(temp, 'xdg'));
process.env.SWITCHBOARD_CONFIG = path.join(temp, 'config.json');
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.XDG_CONFIG_HOME = path.join(temp, 'xdg');

const editor = require('../src/main/editor');
const gitjs = require('../src/main/git');

const root = path.join(temp, 'root');
const ws = path.join(root, 'sample-2');
const api = path.join(ws, 'sample-api-2');
const fresh = path.join(ws, 'sample-new-2');
const web = path.join(ws, 'sample-web-2');
const solo = path.join(temp, 'solo', 'demo-app');
// Outside the workspace root, for git.js's helpers asked directly: find-in-files spans, and
// a tree bigger than a small cap.
const spans = path.join(temp, 'spans');
const cap = path.join(temp, 'cap');
const WS = 'sample-2';

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

const INDEX_JS = 'const answer = 42;\nconsole.log(answer);\n';
const LONG_LINE = 'a'.repeat(1000) + 'NEEDLE' + 'b'.repeat(1000);
const UTIL_JS = 'export const helper = 1;\n';
const PLAIN = 'one answer, two Answer, three ANSWER';
// Its window is [920, 1320): NEEDLE at 1000, one across the window's end at 1317, one past it.
const WINDOW_LINE = 'a'.repeat(1000) + 'NEEDLE' + 'b'.repeat(311) + 'NEEDLE' + 'c'.repeat(177) + 'NEEDLE' + 'd'.repeat(100);
let hasPcre = false;

// git.js copies process.env into GIT_ENV as it loads, so a test that needs git run under
// another environment — a user's own config, a git built otherwise — asks a child node that
// loads git.js afresh under it, with the fake git first on PATH.
const fakeBin = path.join(temp, 'fake-bin');
const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
function childGit(env, fn, args) {
  const src = `require(${JSON.stringify(require.resolve('../src/main/git'))}).${fn}(...${JSON.stringify(args)})` +
    '.then(r => process.stdout.write(JSON.stringify(r)))';
  const out = execFileSync(process.execPath, ['-e', src], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { PATH: fakeBin + path.delimiter + process.env.PATH, REAL_GIT: realGit }, env),
  });
  return JSON.parse(out);
}

before(() => {
  // sample-api-2: tracked files of every kind, then untracked, ignored and deleted ones.
  fs.mkdirSync(api, { recursive: true });
  git(api, 'init', '-q');
  put(api, '.gitignore', 'build/\n*.log\n.env\n.env.*\n!.env.example\n.DS_Store\n');
  put(api, 'README.md', '# Sample API\n');
  put(api, 'src/index.js', INDEX_JS);
  put(api, 'src/with space.js', '// answer, with a space in the name\n');
  put(api, 'src/naïve.js', "const naive = 'answer';\n");
  put(api, 'bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello bom\n')]));
  put(api, 'image.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01, 0x02]));
  put(api, 'latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));   // "café" in Latin-1: not UTF-8
  put(api, 'crlf.txt', 'answer with crlf\r\n');
  fs.chmodSync(put(api, 'script.sh', '#!/bin/sh\necho answer\n'), 0o755);
  put(api, 'gone.txt', 'soon gone\n');
  git(api, 'add', '-A');
  git(api, 'commit', '-q', '-m', 'initial');
  fs.rmSync(path.join(api, 'gone.txt'));
  put(api, 'notes.txt', 'untracked answer\n');
  put(api, 'long.txt', LONG_LINE + '\n');
  put(api, 'debug.log', 'answer in a log\n');
  // Ignored files the tree still shows: a secret, and one in a folder git does show.
  put(api, '.env.local', 'SAMPLE_TOKEN=answer\n');
  put(api, 'src/trace.log', 'answer in a nested log\n');
  put(api, '.env.example', 'SAMPLE_TOKEN=\n');          // un-ignored by the ! rule: untracked
  put(api, '.DS_Store', Buffer.from([0, 0, 0, 1]));        // ignored AND junk: in neither list
  put(api, 'build/out.js', 'answer in a build\n');
  // Sparse 6 MB files: text as far as the first 8 KB goes, and binary.
  put(api, 'build/big.txt', 'x'.repeat(9000) + '\n');
  fs.truncateSync(path.join(api, 'build/big.txt'), 6 * 1024 * 1024);
  put(api, 'build/big.bin', Buffer.from([0, 1, 2, 3]));
  fs.truncateSync(path.join(api, 'build/big.bin'), 6 * 1024 * 1024);
  // Symlinks: one that stays inside, and every way out of the repo.
  put(temp, 'outside.txt', 'top secret\n');
  put(temp, 'outside-dir/secret.txt', 'top secret\n');
  fs.symlinkSync('src/index.js', path.join(api, 'link-in.js'));
  fs.symlinkSync(path.join(temp, 'outside.txt'), path.join(api, 'link-out.txt'));
  fs.symlinkSync(path.join(temp, 'outside-dir'), path.join(api, 'dir-out'));
  fs.symlinkSync(path.join(temp, 'nowhere.txt'), path.join(api, 'dangling-out'));
  fs.symlinkSync('.git', path.join(api, 'dot-git-link'));

  // sample-new-2: no commit yet — an unborn HEAD.
  fs.mkdirSync(fresh, { recursive: true });
  git(fresh, 'init', '-q');
  put(fresh, 'fresh.txt', 'brand new answer\n');

  // sample-web-2
  fs.mkdirSync(web, { recursive: true });
  git(web, 'init', '-q');
  put(web, 'app.js', "export const answer = 'web';\n");
  put(web, 'pages/index.html', '<h1>Sample</h1>\n');
  // Committed symlinks: to a file, and to the folder holding it.
  put(web, 'lib/util.js', UTIL_JS);
  fs.symlinkSync('lib/util.js', path.join(web, 'util-link.js'));
  fs.symlinkSync('lib', path.join(web, 'libdir'));
  git(web, 'add', '-A');
  git(web, 'commit', '-q', '-m', 'initial');
  put(web, 'odd\nname.txt', 'answer behind a newline\n');
  // An untracked clone inside the repo and a linked worktree: `ls-files -o` lists each as
  // ONE entry with a trailing slash, since git does not look inside another repo.
  fs.mkdirSync(path.join(web, 'vendor', 'lib'), { recursive: true });
  git(path.join(web, 'vendor', 'lib'), 'init', '-q');
  put(web, 'vendor/lib/inner.txt', 'inside a nested repo\n');
  git(web, 'worktree', 'add', '-q', '-b', 'feature-2', '.wt/feature');

  // demo-app: a single-repo workspace, declared by hand.
  fs.mkdirSync(solo, { recursive: true });
  git(solo, 'init', '-q');
  put(solo, 'main.txt', 'demo\n');
  git(solo, 'add', '-A');
  git(solo, 'commit', '-q', '-m', 'initial');

  // spans: never committed — grep --untracked reads them all the same.
  fs.mkdirSync(spans, { recursive: true });
  git(spans, 'init', '-q');
  put(spans, 'plain.txt', PLAIN + '\n');
  put(spans, 'many.txt', 'ab '.repeat(60) + '\n');
  put(spans, 'window.txt', WINDOW_LINE + '\n');
  put(spans, 'empty.txt', 'axxbx\n');
  put(spans, 'dash.txt', 'a-b\n');
  put(spans, 'emoji.txt', '// \u{1F680} launch a rocket\n');   // an astral character, in u mode
  put(spans, 'bom.txt', '\uFEFFhello bom\nhello two\n');
  put(spans, 'dotted.txt', '\u0130stanbul answer\n');       // İ lowercases to two code units
  // `(\h+)+b`: PCRE reads \h as whitespace and finds " b" at once; V8 reads it as the letter
  // h and backtracks 2^40 times over the h's — on a long line and on a short one.
  put(spans, 'hang.txt', 'h'.repeat(40) + 'X b' + 'z'.repeat(500) + '\n');
  put(spans, 'hang-short.txt', 'h'.repeat(40) + 'X b\n');
  // `(a+)+b|\d\d`: PCRE gives up on the first line (match limit); POSIX ERE reads \d as d.
  put(spans, 'limit.txt', 'a'.repeat(40) + 'X ab\n');
  put(spans, 'digits.txt', 'value 42\nodd dd\n');
  try {
    execFileSync('git', ['-C', spans, 'grep', '-P', '-e', 'zz-probe', '--'], { stdio: 'pipe' });
    hasPcre = true;
  } catch (err) {
    hasPcre = err.status === 1;                // exit 1 is "no match": -P itself was fine
  }

  // cap: two tracked files, twenty untracked ones, two ignored ones (by info/exclude, so
  // that no .gitignore joins the untracked list).
  fs.mkdirSync(cap, { recursive: true });
  git(cap, 'init', '-q');
  put(cap, 'package.json', '{}\n');
  put(cap, 'src/app.js', 'export {};\n');
  git(cap, 'add', '-A');
  git(cap, 'commit', '-q', '-m', 'initial');
  for (let i = 0; i < 20; i++) put(cap, `node_modules/pkg-${i}/index.js`, '\n');
  put(cap, '.git/info/exclude', '*.tmp\n');
  put(cap, 'a.tmp', '\n');
  put(cap, 'b.tmp', '\n');

  // A git that is this one, except where FAKE_GIT says to fail the way another git would.
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'git'), [
    '#!/bin/sh',
    'for a in "$@"; do',
    '  case "$FAKE_GIT:$a" in',
    '    no-pcre:-P) echo "fatal: cannot use Perl-compatible regexes when not compiled with USE_LIBPCRE" >&2; exit 128 ;;',
    '    pcre-limit:-P) echo "fatal: pcre2_match failed with error code -47: match limit exceeded" >&2; exit 128 ;;',
    '    no-others:-o) echo "fatal: simulated failure" >&2; exit 128 ;;',
    '  esac',
    'done',
    'exec "$REAL_GIT" "$@"',
    '',
  ].join('\n'), { mode: 0o755 });

  fs.writeFileSync(process.env.SWITCHBOARD_CONFIG, JSON.stringify({
    root,
    workspaces: { 'demo-app': { dir: solo, devCommand: null } },
  }));
});

after(() => {
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  fs.rmSync(temp, { recursive: true, force: true });
});

const nfc = list => list.map(p => p.normalize('NFC'));

// ---------------------------------------------------------------------------
// tree
// ---------------------------------------------------------------------------

test('tree lists tracked and untracked-not-ignored files, per repo, under display names', async () => {
  const r = await editor.tree(WS);
  assert.equal(r.ok, true);
  assert.deepEqual(r.repos.map(x => x.name), ['sample-api', 'sample-new', 'sample-web']);
  const files = nfc(r.repos[0].files);
  for (const want of ['.gitignore', 'README.md', 'src/index.js', 'src/with space.js', 'src/naïve.js',
    'bom.txt', 'image.bin', 'script.sh', 'notes.txt', 'long.txt', 'link-in.js', '.env.example']) {
    assert.ok(files.includes(want), `${want} is listed`);
  }
  for (const hidden of ['gone.txt', 'debug.log', '.env.local', 'src/trace.log', '.DS_Store', 'build/out.js', 'build/big.txt']) {
    assert.ok(!files.includes(hidden), `${hidden} is not among the files git shows`);
  }
  assert.equal(new Set(files).size, files.length, 'no path twice');
  assert.equal(r.repos[0].truncated, false);
  assert.equal(r.repos[0].error, null);
  assert.deepEqual(r.repos[1].files, ['fresh.txt'], 'an unborn repo lists its untracked files');
  assert.ok(r.repos[2].files.includes('odd\nname.txt'), 'a newline in a name survives -z');
});

test('tree lists ignored files apart, without ignored folders or OS junk, and they open', async () => {
  const r = await editor.tree(WS);
  const ignored = r.repos[0].ignored;
  assert.deepEqual(ignored.slice().sort(), ['.env.local', 'debug.log', 'src/trace.log'],
    'the ignored files, and none from inside build/');
  assert.ok(!ignored.some(p => p.endsWith('/')), 'no ignored folder entry');
  assert.ok(!r.repos[0].files.some(p => ignored.includes(p)), 'no path in both lists');
  assert.deepEqual(r.repos[1].ignored, []);
  assert.deepEqual(r.repos[2].ignored, []);
  const secret = await editor.read(WS, 'sample-api', '.env.local');
  assert.equal(secret.ok, true);
  assert.equal(secret.text, 'SAMPLE_TOKEN=answer\n');
  // Inside an ignored folder: not listed, but nothing stops a path the guard allows.
  assert.equal((await editor.read(WS, 'sample-api', 'build/out.js')).text, 'answer in a build\n');
});

test('tree of a single-repo workspace is the folder itself, named after it', async () => {
  const r = await editor.tree('demo-app');
  assert.equal(r.ok, true);
  assert.deepEqual(r.repos, [{ name: 'demo-app', files: ['main.txt'], ignored: [], truncated: false, error: null }]);
});

test('tree refuses an absolute-path id and an unknown workspace', async () => {
  assert.match((await editor.tree(ws)).error, /no workspace called/);
  assert.match((await editor.tree('nowhere-9')).error, /no workspace called nowhere-9/);
});

test('an untracked nested repo or worktree is one plain path in the tree, and reads as a folder', async () => {
  const files = (await editor.tree(WS)).repos[2].files;
  assert.ok(files.includes('vendor/lib'), 'the nested repo, without its slash');
  assert.ok(files.includes('.wt/feature'), 'the linked worktree, without its slash');
  assert.ok(!files.some(p => p.endsWith('/')), 'no path ends in a slash');
  assert.ok(!files.includes('vendor/lib/inner.txt'), 'nothing from inside the other repo');
  assert.equal(new Set(files).size, files.length, 'no path twice');
  assert.deepEqual(await editor.read(WS, 'sample-web', 'vendor/lib'), { ok: false, error: 'vendor/lib is a folder' });
});

test('the tree cap keeps tracked files first, so a cut costs ignored files, then untracked ones', async () => {
  const cut = await gitjs.lsFiles(cap, { max: 3 });
  assert.equal(cut.ok, true);
  assert.equal(cut.truncated, true);
  assert.deepEqual(cut.files.slice(0, 2), ['package.json', 'src/app.js']);
  assert.equal(cut.files.length, 3);
  assert.match(cut.files[2], /^node_modules\/pkg-\d+\/index\.js$/);
  assert.deepEqual(cut.ignored, []);
  const some = await gitjs.lsFiles(cap, { max: 23 });
  assert.equal(some.truncated, true);
  assert.equal(some.files.length, 22, 'every tracked and untracked file');
  assert.deepEqual(some.ignored, ['a.tmp'], 'and the ignored ones are what the cut costs');
  const whole = await gitjs.lsFiles(cap);
  assert.equal(whole.truncated, false);
  assert.equal(whole.files.length, 22);
  assert.deepEqual(whole.ignored, ['a.tmp', 'b.tmp']);
});

test('an untracked listing that fails is a cut tree, never a repo with no tree', () => {
  assert.deepEqual(childGit({ FAKE_GIT: 'no-others' }, 'lsFiles', [cap]),
    { ok: true, error: null, files: ['package.json', 'src/app.js'], ignored: [], truncated: true });
});

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

test('read answers text with the mtime and size of what was read', async () => {
  const r = await editor.read(WS, 'sample-api', 'src/index.js');
  const st = fs.statSync(path.join(api, 'src/index.js'));
  assert.deepEqual(r, { ok: true, text: INDEX_JS, mtimeMs: st.mtimeMs, size: st.size, bom: false });
  const spaced = await editor.read(WS, 'sample-api', 'src/with space.js');
  assert.equal(spaced.ok, true);
});

test('read strips a UTF-8 BOM and says so', async () => {
  const r = await editor.read(WS, 'sample-api', 'bom.txt');
  assert.equal(r.ok, true);
  assert.equal(r.text, 'hello bom\n');
  assert.equal(r.bom, true);
  assert.equal(r.size, 13);
});

test('read calls NUL bytes and non-UTF-8 binary, and big files too large', async () => {
  const bin = await editor.read(WS, 'sample-api', 'image.bin');
  assert.equal(bin.ok, true);
  assert.equal(bin.binary, true);
  assert.equal(bin.text, undefined);
  assert.equal((await editor.read(WS, 'sample-api', 'latin1.txt')).binary, true);
  const big = await editor.read(WS, 'sample-api', 'build/big.txt');
  assert.equal(big.tooLarge, true);
  assert.equal(big.size, 6 * 1024 * 1024);
  assert.equal(big.text, undefined);
  assert.equal((await editor.read(WS, 'sample-api', 'build/big.bin')).binary, true, 'a big file that is binary says binary');
});

test('read reports a missing file and a folder', async () => {
  assert.deepEqual(await editor.read(WS, 'sample-api', 'nope.txt'),
    { ok: false, missing: true, error: 'nope.txt is not there any more' });
  assert.equal((await editor.read(WS, 'sample-api', 'gone.txt')).missing, true);
  assert.equal((await editor.read(WS, 'sample-api', 'dangling-out')).missing, true, 'a link to nothing reads as missing');
  assert.deepEqual(await editor.read(WS, 'sample-api', 'src'), { ok: false, error: 'src is a folder' });
});

// ---------------------------------------------------------------------------
// the path guard
// ---------------------------------------------------------------------------

test('the guard refuses every way out of the repo and into .git', async () => {
  for (const rel of ['../sample-web-2/app.js', '/etc/passwd', '.git/config', '.GIT/config', '.g\u200cit/config',
    'src/../../outside.txt', 'src//index.js', './src/index.js', 'link-out.txt', 'dir-out/secret.txt',
    'dot-git-link/config', 'src/index.js\0']) {
    const r = await editor.read(WS, 'sample-api', rel);
    assert.equal(r.ok, false, `${JSON.stringify(rel)} is refused`);
    assert.match(r.error, /is outside sample-api$/, JSON.stringify(rel));
    assert.equal(r.text, undefined);
  }
  assert.equal((await editor.read(WS, 'sample-api', '')).ok, false);
  assert.equal((await editor.read(WS, 'sample-api', null)).ok, false);
});

test('a symlink that stays inside the repo reads through', async () => {
  const r = await editor.read(WS, 'sample-api', 'link-in.js');
  assert.equal(r.ok, true);
  assert.equal(r.text, INDEX_JS);
});

test('the guard refuses an absolute-path workspace id, a dir name and an unknown repo', async () => {
  assert.match((await editor.read(ws, 'sample-api', 'README.md')).error, /^no workspace called/);
  assert.match((await editor.read(api, 'sample-api', 'README.md')).error, /^no workspace called/);
  assert.equal((await editor.read(WS, 'sample-api-2', 'README.md')).error, 'sample-api-2 is not a repo in sample-2');
  assert.equal((await editor.read(WS, 'nope', 'README.md')).error, 'nope is not a repo in sample-2');
  assert.equal((await editor.read('nowhere-9', 'sample-api', 'README.md')).error, 'no workspace called nowhere-9');
});

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

test('save writes in place: same inode, same mode, hard links still share it', async () => {
  const file = path.join(api, 'script.sh');
  const hard = path.join(temp, 'script-hardlink.sh');
  fs.linkSync(file, hard);
  const before = fs.statSync(file);
  const opened = await editor.read(WS, 'sample-api', 'script.sh');
  const text = '#!/bin/sh\necho saved\n';
  const r = await editor.write(WS, 'sample-api', 'script.sh', text, { mtimeMs: opened.mtimeMs, bom: false });
  const after = fs.statSync(file);
  assert.deepEqual(r, { ok: true, mtimeMs: after.mtimeMs, size: after.size });
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mode & 0o777, 0o755);
  assert.equal(fs.readFileSync(hard, 'utf8'), text);
});

test('save refuses to overwrite a change on disk unless forced', async () => {
  const file = path.join(api, 'README.md');
  const opened = await editor.read(WS, 'sample-api', 'README.md');
  fs.writeFileSync(file, '# Changed elsewhere\n');
  const later = new Date(Date.now() + 10000);
  fs.utimesSync(file, later, later);
  const now = fs.statSync(file).mtimeMs;

  const r = await editor.write(WS, 'sample-api', 'README.md', '# Mine\n', { mtimeMs: opened.mtimeMs });
  assert.deepEqual(r, { ok: false, conflict: true, missing: false, mtimeMs: now, error: 'README.md changed on disk since it was opened' });
  assert.equal(fs.readFileSync(file, 'utf8'), '# Changed elsewhere\n');

  const forced = await editor.write(WS, 'sample-api', 'README.md', '# Mine\n', { mtimeMs: opened.mtimeMs, force: true });
  assert.equal(forced.ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), '# Mine\n');
  // …and the mtime it answered is the one the next save is tested against.
  assert.equal((await editor.write(WS, 'sample-api', 'README.md', '# Mine again\n', { mtimeMs: forced.mtimeMs })).ok, true);
});

test('save after a delete on disk is a conflict, and force recreates it where its folder still is', async () => {
  const file = put(api, 'scratch/note.txt', 'draft\n');
  const opened = await editor.read(WS, 'sample-api', 'scratch/note.txt');
  fs.rmSync(file);
  assert.deepEqual(await editor.write(WS, 'sample-api', 'scratch/note.txt', 'kept\n', { mtimeMs: opened.mtimeMs }),
    { ok: false, conflict: true, missing: true, mtimeMs: null, error: 'note.txt was deleted on disk' });
  const again = await editor.write(WS, 'sample-api', 'scratch/note.txt', 'kept\n', { mtimeMs: opened.mtimeMs, force: true });
  assert.equal(again.ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'kept\n');

  fs.rmSync(path.join(api, 'scratch'), { recursive: true });
  const noFolder = await editor.write(WS, 'sample-api', 'scratch/note.txt', 'kept\n', { force: true });
  assert.equal(noFolder.ok, false);
  assert.match(noFolder.error, /folder is not there/);
  assert.equal(fs.existsSync(path.join(api, 'scratch')), false, 'no folder is created');
});

test('save puts the BOM back and refuses anything that is not a string', async () => {
  const opened = await editor.read(WS, 'sample-api', 'bom.txt');
  const r = await editor.write(WS, 'sample-api', 'bom.txt', 'hello again\n', { mtimeMs: opened.mtimeMs, bom: true });
  assert.equal(r.ok, true);
  const bytes = fs.readFileSync(path.join(api, 'bom.txt'));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.subarray(3).toString('utf8'), 'hello again\n');
  const reread = await editor.read(WS, 'sample-api', 'bom.txt');
  assert.equal(reread.text, 'hello again\n');
  assert.equal(reread.bom, true);

  for (const bad of [42, null, undefined, { text: 'x' }, Buffer.from('x')]) {
    const refused = await editor.write(WS, 'sample-api', 'bom.txt', bad, { force: true });
    assert.equal(refused.ok, false);
  }
  assert.equal(fs.readFileSync(path.join(api, 'bom.txt')).subarray(3).toString('utf8'), 'hello again\n');
});

test('save never writes outside the repo, through a link or otherwise', async () => {
  for (const rel of ['../escape.txt', 'link-out.txt', 'dangling-out', 'dir-out/new.txt', '.git/config', 'dot-git-link/hooks/pre-commit']) {
    const r = await editor.write(WS, 'sample-api', rel, 'pwned\n', { force: true });
    assert.equal(r.ok, false, `${rel} is refused`);
  }
  // Where a dangling link points cannot be checked, so it is never written through.
  assert.equal((await editor.write(WS, 'sample-api', 'dangling-out', 'pwned\n', {})).error,
    'dangling-out is a link to a file that is not there');
  assert.equal(fs.readFileSync(path.join(temp, 'outside.txt'), 'utf8'), 'top secret\n');
  assert.equal(fs.existsSync(path.join(temp, 'nowhere.txt')), false);
  assert.equal(fs.existsSync(path.join(temp, 'outside-dir', 'new.txt')), false);
  assert.equal(fs.existsSync(path.join(ws, 'escape.txt')), false);
  assert.equal(fs.existsSync(path.join(api, '.git', 'hooks', 'pre-commit')), false);
});

// ---------------------------------------------------------------------------
// base
// ---------------------------------------------------------------------------

test('base is the HEAD version, whatever the worktree holds', async () => {
  fs.appendFileSync(path.join(api, 'src/index.js'), 'console.log("edited");\n');
  assert.deepEqual(await editor.base(WS, 'sample-api', 'src/index.js'), { ok: true, text: INDEX_JS });
  assert.deepEqual(await editor.base(WS, 'sample-api', 'gone.txt'), { ok: true, text: 'soon gone\n' }, 'deleted on disk, still in HEAD');
  assert.deepEqual(await editor.base(WS, 'sample-api', 'bom.txt'), { ok: true, text: 'hello bom\n' }, 'the BOM comes off, as in read()');
  assert.deepEqual(await editor.base(WS, 'sample-api', 'crlf.txt'), { ok: true, text: 'answer with crlf\r\n' });
});

test('base is null for an untracked file and for a repo with no HEAD, and skips binaries', async () => {
  assert.deepEqual(await editor.base(WS, 'sample-api', 'notes.txt'), { ok: true, text: null });
  assert.deepEqual(await editor.base(WS, 'sample-new', 'fresh.txt'), { ok: true, text: null });
  assert.deepEqual(await editor.base(WS, 'sample-api', 'image.bin'), { ok: true, text: null, skip: true });
});

test('base of a path through a symlink is the HEAD version of the file it shows', async () => {
  for (const rel of ['util-link.js', 'libdir/util.js']) {
    const shown = await editor.read(WS, 'sample-web', rel);
    assert.equal(shown.text, UTIL_JS, rel);
    assert.deepEqual(await editor.base(WS, 'sample-web', rel), { ok: true, text: shown.text }, rel);
  }
  // …where HEAD's own blob for the link is the name it points at, which painted an
  // unchanged file as rewritten.
  assert.equal((await gitjs.headBlob(web, 'util-link.js')).text, 'lib/util.js');
});

test('base follows a rename to its old path, and guards both paths', async () => {
  assert.deepEqual(await editor.base(WS, 'sample-web', 'pages/home.html', 'pages/index.html'), { ok: true, text: '<h1>Sample</h1>\n' });
  assert.equal((await editor.base(WS, 'sample-api', '../x')).ok, false);
  assert.equal((await editor.base(WS, 'sample-api', 'src/index.js', '../sample-web-2/app.js')).ok, false);
  assert.equal((await editor.base(WS, 'sample-api', 'link-out.txt')).ok, false);
});

// ---------------------------------------------------------------------------
// stat
// ---------------------------------------------------------------------------

test('stat answers in order, and anything guarded or gone is simply not there', async () => {
  const st = fs.statSync(path.join(api, 'src/index.js'));
  const none = (repo, p) => ({ repo, path: p, exists: false, mtimeMs: null, size: null });
  const r = await editor.stat(WS, [
    { repo: 'sample-api', path: 'src/index.js' },
    { repo: 'sample-api', path: 'nope.txt' },
    { repo: 'sample-api', path: '../sample-web-2/app.js' },
    { repo: 'sample-api', path: 'link-out.txt' },
    { repo: 'sample-api', path: 'dangling-out' },
    { repo: 'sample-api', path: 'src' },
    { repo: 'nope', path: 'README.md' },
    null,
  ]);
  assert.deepEqual(r, {
    ok: true,
    stats: [
      { repo: 'sample-api', path: 'src/index.js', exists: true, mtimeMs: st.mtimeMs, size: st.size },
      none('sample-api', 'nope.txt'),
      none('sample-api', '../sample-web-2/app.js'),
      none('sample-api', 'link-out.txt'),
      none('sample-api', 'dangling-out'),
      none('sample-api', 'src'),
      none('nope', 'README.md'),
      none(null, null),
    ],
  });
});

test('stat looks at no more than 200 files and refuses a bad workspace', async () => {
  const many = new Array(250).fill(0).map(() => ({ repo: 'sample-web', path: 'app.js' }));
  const r = await editor.stat(WS, many);
  assert.equal(r.stats.length, 200);
  assert.ok(r.stats.every(s => s.exists));
  assert.equal((await editor.stat(ws, many)).ok, false);
  assert.deepEqual(await editor.stat(WS, 'not a list'), { ok: true, stats: [] });
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

const where = r => r.matches.map(m => `${m.repo}:${m.path.normalize('NFC')}:${m.line}`);

test('search finds a fixed string across repos, in repo order, untracked files included and ignored ones not', async () => {
  const r = await editor.search(WS, 'answer', {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.equal(r.truncated, false);
  const hits = where(r);
  for (const want of ['sample-api:src/index.js:1', 'sample-api:src/index.js:2', 'sample-api:src/with space.js:1',
    'sample-api:src/naïve.js:1', 'sample-api:notes.txt:1', 'sample-new:fresh.txt:1', 'sample-web:app.js:1',
    'sample-web:odd\nname.txt:1']) {
    assert.ok(hits.includes(want), `${JSON.stringify(want)} is found`);
  }
  assert.ok(!hits.some(h => /debug\.log|build\//.test(h)), 'ignored files are not searched');
  const order = r.matches.map(m => m.repo).filter((name, i, all) => all.indexOf(name) === i);
  assert.deepEqual(order, ['sample-api', 'sample-new', 'sample-web']);
  assert.equal(r.files, new Set(r.matches.map(m => m.repo + '/' + m.path)).size);
  const crlf = r.matches.find(m => m.path === 'crlf.txt');
  assert.equal(crlf.text, 'answer with crlf', 'no \\r on a CRLF line');
  assert.equal(crlf.offset, 0);
  assert.deepEqual(crlf.ranges, [[0, 6]]);
  assert.deepEqual(r.matches.find(m => m.path === 'src/index.js' && m.line === 2).ranges, [[12, 18]]);
});

test('search is case-insensitive unless asked, and does regular expressions', async () => {
  assert.ok((await editor.search(WS, 'ANSWER', { caseSensitive: false })).matches.length > 0);
  assert.deepEqual((await editor.search(WS, 'ANSWER', { caseSensitive: true })).matches, []);
  const re = await editor.search(WS, 'answer\\s*=\\s*\\d+', { regex: true, caseSensitive: true });
  assert.deepEqual(where(re), ['sample-api:src/index.js:1']);
  assert.equal(re.matches[0].text, 'const answer = 42;');
  assert.deepEqual(re.matches[0].ranges, [[6, 17]]);
  // Fixed-string mode means it: the dot and the parens are literal.
  assert.deepEqual((await editor.search(WS, 'console.log(answer)', {})).matches.map(m => m.path), ['src/index.js']);
  assert.deepEqual((await editor.search(WS, 'console.log(answer', { regex: true })).matches, []);
});

test('a search with no match is empty, not an error', async () => {
  assert.deepEqual(await editor.search(WS, 'zz-not-anywhere-zz', {}),
    { ok: true, matches: [], truncated: false, files: 0, errors: [] });
});

test('a long line comes back as a 400-character window around the match, with its offset', async () => {
  const r = await editor.search(WS, 'NEEDLE', { caseSensitive: true });
  assert.equal(r.matches.length, 1);
  const m = r.matches[0];
  assert.equal(m.path, 'long.txt');
  assert.equal(m.text.length, 400);
  assert.equal(m.offset, 1000 - 80);
  assert.equal(LONG_LINE.slice(m.offset, m.offset + 400), m.text);
  assert.equal(m.text.indexOf('NEEDLE'), 80);
  assert.deepEqual(m.ranges, [[80, 86]], 'spans are relative to the window');
});

test('search refuses empty, overlong and multi-line queries, and a bad workspace', async () => {
  const empty = { ok: true, matches: [], truncated: false, files: 0, errors: [] };
  assert.deepEqual(await editor.search(WS, '', {}), empty);
  assert.deepEqual(await editor.search(WS, '   ', {}), empty);
  assert.deepEqual(await editor.search(WS, null, {}), empty);
  assert.deepEqual(await editor.search(WS, 'x'.repeat(501), {}), { ok: false, error: 'that search is too long' });
  assert.equal((await editor.search(WS, 'a\nb', {})).ok, false);
  assert.equal((await editor.search(ws, 'answer', {})).ok, false);
  // A pattern git cannot compile is a per-repo error, not a thrown one.
  const bad = await editor.search(WS, 'a(', { regex: true });
  assert.equal(bad.ok, true);
  assert.deepEqual(bad.matches, []);
  assert.equal(bad.errors.length, 3);
});

// ---------------------------------------------------------------------------
// find in files: the spans main computes, and the git it runs (git.grep directly)
// ---------------------------------------------------------------------------

const hit = (r, p) => r.matches.find(m => m.path === p);

test('fixed-string spans: every match on the line, case-insensitively unless asked', async () => {
  const any = await gitjs.grep(spans, 'answer', {});
  assert.deepEqual(hit(any, 'plain.txt').ranges, [[4, 10], [16, 22], [30, 36]]);
  const exact = await gitjs.grep(spans, 'answer', { caseSensitive: true });
  assert.deepEqual(hit(exact, 'plain.txt').ranges, [[4, 10]]);
  assert.deepEqual(hit(exact, 'dotted.txt').ranges, [[9, 15]]);
  // İ lowercases to two code units, so lowercase indices are not the line's: no spans.
  assert.deepEqual([hit(any, 'dotted.txt').offset, hit(any, 'dotted.txt').ranges], [0, []]);
  // Fifty a line at most.
  const many = hit(await gitjs.grep(spans, 'ab', { caseSensitive: true }), 'many.txt').ranges;
  assert.equal(many.length, 50);
  assert.deepEqual(many[49], [147, 149]);
});

test('spans in a long line are inside its window, clipped to its end', async () => {
  const want = [[80, 86], [397, 400]];
  for (const [query, opts] of [['NEEDLE', { caseSensitive: true }], ['NEE+DLE', { regex: true, caseSensitive: true }]]) {
    const m = hit(await gitjs.grep(spans, query, opts), 'window.txt');
    assert.equal(m.offset, 920, query);
    assert.equal(m.text, WINDOW_LINE.slice(920, 1320), query);
    assert.deepEqual(m.ranges, want, query);
  }
});

test('regex spans: V8 reads the pattern with u when it can, without when it cannot, and skips empty matches', async (t) => {
  if (!hasPcre) return t.skip('this git has no PCRE');
  const exact = { regex: true, caseSensitive: true };
  assert.deepEqual(hit(await gitjs.grep(spans, '\\p{Lu}nswer', exact), 'plain.txt').ranges, [[16, 22]]);
  assert.deepEqual(hit(await gitjs.grep(spans, 'a\\-b', exact), 'dash.txt').ranges, [[0, 3]]);
  assert.deepEqual(hit(await gitjs.grep(spans, 'x*', exact), 'empty.txt').ranges, [[1, 3], [4, 5]]);
  assert.deepEqual(hit(await gitjs.grep(spans, 'ANSWER', { regex: true }), 'plain.txt').ranges, [[4, 10], [16, 22], [30, 36]]);
});

test('an empty-matchable pattern steps over an emoji instead of spinning on it', async (t) => {
  if (!hasPcre) return t.skip('this git has no PCRE');
  const exact = { regex: true, caseSensitive: true };
  const started = Date.now();
  // `(rocket)?` matches empty everywhere, including just before the emoji's surrogate pair.
  assert.deepEqual(hit(await gitjs.grep(spans, '(rocket)?', exact), 'emoji.txt').ranges, [[15, 21]]);
  assert.deepEqual(hit(await gitjs.grep(spans, 'a*', exact), 'emoji.txt').ranges, [[7, 8], [13, 14]]);
  const ms = Date.now() - started;
  assert.ok(ms < 200, `answered in ${ms} ms, well inside the 250 ms budget`);
});

test('line 1 of a file with a BOM is measured without it, as read() hands it to the Editor', async () => {
  const r = await gitjs.grep(spans, 'hello', { caseSensitive: true });
  const first = r.matches.find(m => m.path === 'bom.txt' && m.line === 1);
  assert.deepEqual([first.text, first.offset, first.ranges], ['hello bom', 0, [[0, 5]]]);
  const second = r.matches.find(m => m.path === 'bom.txt' && m.line === 2);
  assert.deepEqual(second.ranges, [[0, 5]]);
});

test('a pattern V8 cannot compile still finds its lines, unhighlighted', async (t) => {
  if (!hasPcre) return t.skip('this git has no PCRE');
  const r = await gitjs.grep(spans, 'ans(?#a PCRE comment)wer', { regex: true, caseSensitive: true });
  assert.equal(r.ok, true);
  assert.deepEqual([hit(r, 'plain.txt').offset, hit(r, 'plain.txt').ranges], [0, []]);
});

test('a pattern that backtracks without end in V8 is cut off: the lines come back in time, unhighlighted', async (t) => {
  if (!hasPcre) return t.skip('this git has no PCRE');
  const started = Date.now();
  const r = await gitjs.grep(spans, '(\\h+)+b', { regex: true, caseSensitive: true });
  const ms = Date.now() - started;
  assert.ok(ms < 1000, `answered in ${ms} ms`);
  assert.equal(r.ok, true);
  const long = hit(r, 'hang.txt');
  const short = hit(r, 'hang-short.txt');
  assert.deepEqual([long.offset, long.ranges, long.text.length], [0, [], 400]);
  assert.deepEqual([short.offset, short.ranges], [0, []]);
});

test('a PCRE that gives up mid-search is never quietly re-read as POSIX ERE', async (t) => {
  if (!hasPcre) return t.skip('this git has no PCRE');
  const r = await gitjs.grep(spans, '(a+)+b|\\d\\d', { regex: true, caseSensitive: true });
  assert.ok(!r.matches.some(m => m.text === 'odd dd'), 'ERE reads \\d as the letter d');
  if (r.ok) assert.ok(r.matches.some(m => m.text === 'value 42'));
  else assert.match(r.error, /match limit|pcre/i);
});

test('regex mode retries with -E only when git was built without PCRE', () => {
  const query = ['two [A-Z]nswer', { regex: true, caseSensitive: true }];
  const noPcre = childGit({ FAKE_GIT: 'no-pcre' }, 'grep', [spans].concat(query));
  assert.equal(noPcre.ok, true);
  assert.deepEqual(noPcre.matches.map(m => [m.path, m.ranges]), [['plain.txt', [[12, 22]]]]);
  assert.deepEqual(childGit({ FAKE_GIT: 'pcre-limit' }, 'grep', [spans].concat(query)),
    { ok: false, error: 'pcre2_match failed with error code -47: match limit exceeded.', matches: [], truncated: false });
});

test('find in files works for a user whose git config says submodule.recurse=true', () => {
  const recurse = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'submodule.recurse', GIT_CONFIG_VALUE_0: 'true' };
  // The setting is live in that environment: plain `git grep --untracked` is refused under it.
  assert.throws(() => execFileSync('git', ['-C', spans, 'grep', '--untracked', '-e', 'answer', '--'],
    { stdio: 'pipe', env: Object.assign({}, process.env, recurse) }), /--untracked not supported with --recurse-submodules/);
  const r = childGit(recurse, 'grep', [spans, 'answer', { caseSensitive: true }]);
  assert.equal(r.ok, true);
  assert.deepEqual(hit(r, 'plain.txt').ranges, [[4, 10]]);
});

// ---------------------------------------------------------------------------
// §4.16 — making, renaming and removing a file
//
// The three writes the Editor's tree can do. They go through the SAME guard as read()
// and write(), so every refusal below is the guard's, not a second set of rules — and
// none of them runs a git command: a new file is untracked, and `ls-files -o` shows it
// on the next listing with nothing staged.
// ---------------------------------------------------------------------------

// The Trash is Electron's, so the tests pass their own: one that records what it was
// asked to bin, and one that refuses, which is the fallback path.
function binned() {
  const seen = [];
  return { trash: async p => { seen.push(p); fs.rmSync(p, { recursive: true, force: true }); }, seen };
}
const NO_TRASH = { trash: async () => { throw new Error('no Finder here'); } };

test('create makes an empty file that git lists at once, with nothing staged', async () => {
  const r = await editor.create(WS, 'sample-api', 'src/made.js');
  assert.deepEqual(r, { ok: true, path: 'src/made.js', dir: false });
  assert.equal(fs.readFileSync(path.join(api, 'src/made.js'), 'utf8'), '');
  const tree = await editor.tree(WS);
  const repo = tree.repos.find(x => x.name === 'sample-api');
  assert.ok(repo.files.includes('src/made.js'), 'the new file should be in the tree');
  // Untracked, not added: the index is the user's.
  assert.match(git(api, 'status', '--porcelain', '--', 'src/made.js'), /^\?\? /);
});

test('create makes the folders on the way, and never outside the repo', async () => {
  const r = await editor.create(WS, 'sample-api', 'src/deep/deeper/leaf.txt');
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(path.join(api, 'src/deep/deeper/leaf.txt')), true);
  const dir = await editor.create(WS, 'sample-api', 'src/newdir', { dir: true });
  assert.deepEqual(dir, { ok: true, path: 'src/newdir', dir: true });
  assert.equal(fs.statSync(path.join(api, 'src/newdir')).isDirectory(), true);
});

test('create never overwrites, and never follows a link out of the repo', async () => {
  const before = fs.readFileSync(path.join(api, 'README.md'), 'utf8');
  const again = await editor.create(WS, 'sample-api', 'README.md');
  assert.equal(again.ok, false);
  assert.match(again.error, /already there/);
  assert.equal(fs.readFileSync(path.join(api, 'README.md'), 'utf8'), before);
  // A path whose last segment is an existing symlink out of the repo: refused as
  // "already there", and the target is untouched.
  fs.symlinkSync(path.join(temp, 'outside.txt'), path.join(api, 'create-link.txt'));
  const onLink = await editor.create(WS, 'sample-api', 'create-link.txt');
  assert.equal(onLink.ok, false);
  assert.equal(fs.readFileSync(path.join(temp, 'outside.txt'), 'utf8'), 'top secret\n');
  // And a path THROUGH a link out of the repo never reaches the far side.
  const through = await editor.create(WS, 'sample-api', 'dir-out/new.txt');
  assert.equal(through.ok, false);
  assert.match(through.error, /outside sample-api/);
  assert.equal(fs.existsSync(path.join(temp, 'outside-dir', 'new.txt')), false);
});

test('create is refused for .git, for an escape and for an unknown repo', async () => {
  for (const rel of ['.git/hooks/evil', '../escaped.txt', '/etc/passwd', 'a/../../b']) {
    const r = await editor.create(WS, 'sample-api', rel);
    assert.equal(r.ok, false, `${rel} should have been refused`);
  }
  assert.equal(fs.existsSync(path.join(api, '.git/hooks/evil')), false);
  assert.equal(fs.existsSync(path.join(temp, 'escaped.txt')), false);
  assert.equal((await editor.create(WS, 'no-such-repo', 'x.txt')).ok, false);
  assert.equal((await editor.create('no-such-ws', 'sample-api', 'x.txt')).ok, false);
});

test('rename moves a file, making the folders it needs', async () => {
  put(api, 'movable.txt', 'move me\n');
  const r = await editor.rename(WS, 'sample-api', 'movable.txt', 'moved/here.txt');
  assert.deepEqual(r, { ok: true, from: 'movable.txt', to: 'moved/here.txt', dir: false });
  assert.equal(fs.existsSync(path.join(api, 'movable.txt')), false);
  assert.equal(fs.readFileSync(path.join(api, 'moved/here.txt'), 'utf8'), 'move me\n');
});

test('rename moves a whole folder', async () => {
  put(api, 'bundle/one.txt', 'one\n');
  const r = await editor.rename(WS, 'sample-api', 'bundle', 'bundled');
  assert.equal(r.ok, true);
  assert.equal(r.dir, true);
  assert.equal(fs.readFileSync(path.join(api, 'bundled/one.txt'), 'utf8'), 'one\n');
});

test('rename refuses to land on something else, and to eat its own folder', async () => {
  put(api, 'keepme.txt', 'keep\n');
  put(api, 'other.txt', 'other\n');
  const clash = await editor.rename(WS, 'sample-api', 'keepme.txt', 'other.txt');
  assert.equal(clash.ok, false);
  assert.match(clash.error, /already something called/);
  assert.equal(fs.readFileSync(path.join(api, 'other.txt'), 'utf8'), 'other\n');

  const inside = await editor.rename(WS, 'sample-api', 'bundled', 'bundled/deeper');
  assert.equal(inside.ok, false);
  assert.match(inside.error, /inside itself/);
});

test('rename moves the LINK, never what it points at', async () => {
  // `link-in.js` points at `src/index.js`, inside the repo. Renaming what the guard
  // RESOLVED the path to would move the source file and leave a dangling link.
  const target = fs.readFileSync(path.join(api, 'src/index.js'), 'utf8');
  const r = await editor.rename(WS, 'sample-api', 'link-in.js', 'link-moved.js');
  assert.equal(r.ok, true);
  assert.equal(fs.lstatSync(path.join(api, 'link-moved.js')).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(api, 'link-in.js')), false);
  assert.equal(fs.readFileSync(path.join(api, 'src/index.js'), 'utf8'), target);
  await editor.rename(WS, 'sample-api', 'link-moved.js', 'link-in.js');
});

test('rename is refused for a file that is not there, and outside the repo', async () => {
  const gone = await editor.rename(WS, 'sample-api', 'never-existed.txt', 'x.txt');
  assert.equal(gone.ok, false);
  assert.equal(gone.missing, true);
  const out = await editor.rename(WS, 'sample-api', 'README.md', '../escaped.md');
  assert.equal(out.ok, false);
  assert.equal(fs.existsSync(path.join(temp, 'escaped.md')), false);
  assert.equal(fs.existsSync(path.join(api, 'README.md')), true);
  const intoGit = await editor.rename(WS, 'sample-api', 'README.md', '.git/README.md');
  assert.equal(intoGit.ok, false);
});

test('a case-only rename is allowed on a case-insensitive disk', async () => {
  put(api, 'casing.txt', 'x\n');
  const r = await editor.rename(WS, 'sample-api', 'casing.txt', 'Casing.txt');
  assert.equal(r.ok, true);
  const names = fs.readdirSync(api);
  assert.ok(names.includes('Casing.txt'), `expected Casing.txt in ${names.join(', ')}`);
});

test('delete moves the file to the Trash', async () => {
  put(api, 'binme.txt', 'bin\n');
  const bin = binned();
  const r = await editor.remove(WS, 'sample-api', 'binme.txt', bin);
  assert.deepEqual(r, { ok: true, path: 'binme.txt', dir: false, trashed: true });
  assert.deepEqual(bin.seen, [path.join(api, 'binme.txt')]);
  assert.equal(fs.existsSync(path.join(api, 'binme.txt')), false);
});

test('delete bins a LINK, never what it points at', async () => {
  fs.symlinkSync('src/index.js', path.join(api, 'bin-link.js'));
  const target = fs.readFileSync(path.join(api, 'src/index.js'), 'utf8');
  const bin = binned();
  const r = await editor.remove(WS, 'sample-api', 'bin-link.js', bin);
  assert.equal(r.ok, true);
  assert.deepEqual(bin.seen, [path.join(api, 'bin-link.js')]);
  assert.equal(fs.existsSync(path.join(api, 'bin-link.js')), false);
  assert.equal(fs.readFileSync(path.join(api, 'src/index.js'), 'utf8'), target);
});

test('a link that points out of the repo cannot be renamed or binned either', async () => {
  // The guard refuses it for the same reason read() does: what it resolves to is not
  // in this repo, and the Editor does not touch anything that is not.
  const moved = await editor.rename(WS, 'sample-api', 'link-out.txt', 'link-elsewhere.txt');
  assert.equal(moved.ok, false);
  assert.match(moved.error, /outside sample-api/);
  const gone = await editor.remove(WS, 'sample-api', 'link-out.txt', binned());
  assert.equal(gone.ok, false);
  assert.equal(fs.lstatSync(path.join(api, 'link-out.txt')).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(temp, 'outside.txt'), 'utf8'), 'top secret\n');
});

test('a file falls back to an unlink when the Trash refuses; a FOLDER never does', async () => {
  put(api, 'nofinder.txt', 'x\n');
  const r = await editor.remove(WS, 'sample-api', 'nofinder.txt', NO_TRASH);
  assert.deepEqual(r, { ok: true, path: 'nofinder.txt', dir: false, trashed: false });
  assert.equal(fs.existsSync(path.join(api, 'nofinder.txt')), false);

  put(api, 'keepdir/inner.txt', 'still here\n');
  const dir = await editor.remove(WS, 'sample-api', 'keepdir', NO_TRASH);
  assert.equal(dir.ok, false);
  assert.match(dir.error, /Trash/);
  assert.equal(fs.readFileSync(path.join(api, 'keepdir/inner.txt'), 'utf8'), 'still here\n');
});

test('delete is refused for .git, for an escape and for nothing at all', async () => {
  const bin = binned();
  for (const rel of ['.git', '.git/config', '../outside.txt', '', 'nope.txt', 'dir-out/secret.txt']) {
    const r = await editor.remove(WS, 'sample-api', rel, bin);
    assert.equal(r.ok, false, `${rel} should have been refused`);
  }
  assert.deepEqual(bin.seen, []);
  assert.equal(fs.existsSync(path.join(api, '.git/config')), true);
  assert.equal(fs.readFileSync(path.join(temp, 'outside.txt'), 'utf8'), 'top secret\n');
});

test('delete removes a whole folder through the Trash', async () => {
  put(api, 'bindir/inner.txt', 'gone\n');
  const bin = binned();
  const r = await editor.remove(WS, 'sample-api', 'bindir', bin);
  assert.equal(r.ok, true);
  assert.equal(r.dir, true);
  assert.equal(fs.existsSync(path.join(api, 'bindir')), false);
});

test('renaming a link onto its own target is refused, not a destroyed file', async () => {
  // `CLAUDE.md -> AGENTS.md` is the pair §4.16 names. A realpath-based "same file?"
  // test read the two as one and fs.rename replaced the real file with the link,
  // leaving a self-referential dangling symlink and no bytes anywhere.
  put(api, 'AGENTS.md', 'the real file\n');
  fs.symlinkSync('AGENTS.md', path.join(api, 'CLAUDE.md'));
  const r = await editor.rename(WS, 'sample-api', 'CLAUDE.md', 'AGENTS.md');
  assert.equal(r.ok, false);
  assert.match(r.error, /already something called/);
  assert.equal(fs.readFileSync(path.join(api, 'AGENTS.md'), 'utf8'), 'the real file\n');
  assert.equal(fs.lstatSync(path.join(api, 'AGENTS.md')).isSymbolicLink(), false);
  // …and the other way round eats the link just as happily.
  const back = await editor.rename(WS, 'sample-api', 'AGENTS.md', 'CLAUDE.md');
  assert.equal(back.ok, false);
  assert.equal(fs.lstatSync(path.join(api, 'CLAUDE.md')).isSymbolicLink(), true);
});

test('a case-only rename is still allowed beside that', async () => {
  put(api, 'casing2.txt', 'x\n');
  const r = await editor.rename(WS, 'sample-api', 'casing2.txt', 'Casing2.txt');
  assert.equal(r.ok, true);
  assert.ok(fs.readdirSync(api).includes('Casing2.txt'));
});

test('create names a FILE in the middle of the path, not "already there"', async () => {
  put(api, 'plain.txt', 'x\n');
  const r = await editor.create(WS, 'sample-api', 'plain.txt/child.txt');
  assert.equal(r.ok, false);
  assert.match(r.error, /is a file, not a folder/);
  assert.equal(fs.readFileSync(path.join(api, 'plain.txt'), 'utf8'), 'x\n');
});
