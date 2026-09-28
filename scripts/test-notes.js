'use strict';

// npm run test:notes — src/main/notes.js (M9), against a scratch notes folder.
// Plain node, no Electron: notes.js never requires it.
//
// SWITCHBOARD_CONFIG is set BEFORE the module is required — config.js reads it at load,
// and notes.js puts its folder beside whatever config file that names, so the whole test
// stays inside a temp directory and never touches the user's own ~/.switchboard.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');

// realpath: os.tmpdir() is under /var, which is a symlink to /private/var.
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-notes-test-')));
const previousConfig = process.env.SWITCHBOARD_CONFIG;
process.env.SWITCHBOARD_CONFIG = path.join(temp, 'config.json');

const notes = require('../src/main/notes');

const DIR = path.join(temp, 'notes');

before(() => {
  fs.mkdirSync(DIR, { recursive: true });
});

after(() => {
  if (previousConfig === undefined) delete process.env.SWITCHBOARD_CONFIG;
  else process.env.SWITCHBOARD_CONFIG = previousConfig;
  fs.rmSync(temp, { recursive: true, force: true });
});

function fileOf(id) {
  return notes.fileFor(id);
}

// ---------------------------------------------------------------------------
// where a note lives
// ---------------------------------------------------------------------------

test('the notes folder follows SWITCHBOARD_CONFIG, never the real home', () => {
  assert.equal(notes.notesDir(), DIR);
  assert.ok(fileOf('sample-2').startsWith(DIR + path.sep));
});

test('every id is hashed, so no two ids can share a file', () => {
  // A plain workspace id keeps its readable stem and still carries a hash.
  assert.match(notes.keyFor('sample-2'), /^sample-2-[0-9a-f]{10}$/);
  // A folder square's absolute path is named by its last segment plus the hash of
  // the whole path, so two folders called `odds` are two notes.
  const a = notes.keyFor('/Users/me/one/odds');
  const b = notes.keyFor('/Users/me/two/odds');
  assert.match(a, /^odds-[0-9a-f]{10}$/);
  assert.match(b, /^odds-[0-9a-f]{10}$/);
  assert.notEqual(a, b);
  // A case-insensitive volume cannot collapse two ids either.
  assert.notEqual(notes.keyFor('Odds').toLowerCase(), notes.keyFor('odds').toLowerCase());
  // And a workspace literally called what a folder hashes to is still its own note.
  assert.notEqual(notes.keyFor(a), a);
});

test('a path cannot escape the notes folder', () => {
  for (const id of ['../../etc/passwd', '/etc/passwd', 'a/b/../../../c', '..']) {
    const file = fileOf(id);
    assert.ok(file, `${id} should still resolve to a file`);
    assert.equal(path.dirname(file), DIR, `${id} escaped to ${file}`);
  }
  assert.equal(notes.keyFor('   '), null);
  assert.equal(notes.keyFor(null), null);
  assert.equal(notes.fileFor(''), null);
});

// ---------------------------------------------------------------------------
// reading and writing
// ---------------------------------------------------------------------------

test('a note that was never written is an empty note, not an error', async () => {
  const r = await notes.read('never-written');
  assert.equal(r.ok, true);
  assert.equal(r.text, '');
  assert.equal(r.missing, true);
  assert.equal(r.mtimeMs, null);
});

test('an empty note writes no file at all', async () => {
  const r = await notes.write('still-empty', '');
  assert.equal(r.ok, true);
  assert.equal(r.missing, true);
  assert.equal(fs.existsSync(fileOf('still-empty')), false);
});

test('write then read is the same text, and the answer carries the new mtime', async () => {
  const text = '# Ideas\n\n- one\n- two\n';
  const w = await notes.write('sample-2', text);
  assert.equal(w.ok, true);
  assert.equal(w.missing, false);
  assert.equal(typeof w.mtimeMs, 'number');
  assert.equal(fs.readFileSync(fileOf('sample-2'), 'utf8'), text);

  const r = await notes.read('sample-2');
  assert.equal(r.text, text);
  assert.equal(r.missing, false);
  assert.equal(r.mtimeMs, w.mtimeMs);
});

test('emptying a note truncates the file and never deletes what was written elsewhere', async () => {
  await notes.write('emptied', 'something');
  const before = await notes.read('emptied');
  const r = await notes.write('emptied', '', { mtimeMs: before.mtimeMs });
  assert.equal(r.ok, true);
  // The file stays, at zero bytes: an empty note is a note, and unlinking it would
  // make a stray empty buffer indistinguishable from the user deleting their text.
  assert.equal(fs.existsSync(fileOf('emptied')), true);
  assert.equal(fs.readFileSync(fileOf('emptied'), 'utf8'), '');
  const back = await notes.read('emptied');
  assert.equal(back.text, '');
  assert.equal(back.missing, false);
});

test('a BOM is taken off the text, once', async () => {
  fs.writeFileSync(fileOf('bom'), '﻿# Title\n');
  const r = await notes.read('bom');
  assert.equal(r.text, '# Title\n');
});

// ---------------------------------------------------------------------------
// the conflict test
// ---------------------------------------------------------------------------

test('a note that moved on disk is a conflict, not an overwrite', async () => {
  const first = await notes.write('moved', 'mine\n');
  fs.writeFileSync(fileOf('moved'), 'theirs\n');
  fs.utimesSync(fileOf('moved'), new Date(), new Date(Date.now() + 5000));

  const clash = await notes.write('moved', 'mine again\n', { mtimeMs: first.mtimeMs });
  assert.equal(clash.ok, false);
  assert.equal(clash.conflict, true);
  assert.equal(clash.missing, false);
  assert.equal(typeof clash.mtimeMs, 'number');
  assert.equal(fs.readFileSync(fileOf('moved'), 'utf8'), 'theirs\n');

  // force is the user's "keep mine".
  const forced = await notes.write('moved', 'mine again\n', { mtimeMs: first.mtimeMs, force: true });
  assert.equal(forced.ok, true);
  assert.equal(fs.readFileSync(fileOf('moved'), 'utf8'), 'mine again\n');
});

test('a note deleted on disk is a conflict too', async () => {
  const first = await notes.write('vanished', 'here\n');
  fs.rmSync(fileOf('vanished'));
  const clash = await notes.write('vanished', 'still here\n', { mtimeMs: first.mtimeMs });
  assert.equal(clash.ok, false);
  assert.equal(clash.conflict, true);
  assert.equal(clash.missing, true);
});

test('a note that appeared where the renderer believed there was none is a conflict', async () => {
  fs.writeFileSync(fileOf('appeared'), 'written by something else\n');
  const clash = await notes.write('appeared', 'my first note\n', { mtimeMs: null });
  assert.equal(clash.ok, false);
  assert.equal(clash.conflict, true);
  assert.equal(fs.readFileSync(fileOf('appeared'), 'utf8'), 'written by something else\n');
});

test('no mtime in opts means no check — the very first save has nothing to compare', async () => {
  const r = await notes.write('unchecked', 'first\n');
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------------------
// limits and races
// ---------------------------------------------------------------------------

test('a note over 2 MB is reported, not handed back as a prefix', async () => {
  const big = fileOf('huge');
  fs.writeFileSync(big, 'x'.repeat(notes.MAX_BYTES + 10));
  const r = await notes.read('huge');
  assert.equal(r.ok, true);
  assert.equal(r.tooLarge, true);
  assert.equal(r.text, undefined);
  assert.equal(r.size, notes.MAX_BYTES + 10);
  // …and a save of that size is refused, so a truncated buffer can never land on it.
  const w = await notes.write('huge', 'y'.repeat(notes.MAX_BYTES + 1));
  assert.equal(w.ok, false);
  assert.match(w.error, /too long/);
  assert.equal(fs.statSync(big).size, notes.MAX_BYTES + 10);
});

test('two saves that overlap leave the newer text, not a spliced file', async () => {
  const a = notes.write('raced', 'first text\n');
  const b = notes.write('raced', 'second text, which is longer\n');
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
  assert.equal(fs.readFileSync(fileOf('raced'), 'utf8'), 'second text, which is longer\n');
  // No temp files left behind.
  assert.deepEqual(fs.readdirSync(DIR).filter(n => n.endsWith('.tmp')), []);
});

test('settle() waits for every write that has been started', async () => {
  notes.write('settled', 'one\n');
  notes.write('settled-too', 'two\n');
  await notes.settle();
  assert.equal(fs.readFileSync(fileOf('settled'), 'utf8'), 'one\n');
  assert.equal(fs.readFileSync(fileOf('settled-too'), 'utf8'), 'two\n');
});

test('nothing throws: a folder where the note should be is a sentence', async () => {
  fs.mkdirSync(fileOf('isafolder'));
  const r = await notes.read('isafolder');
  assert.equal(r.ok, false);
  assert.match(r.error, /not a file/);
  const w = await notes.write('isafolder', 'text\n');
  assert.equal(w.ok, false);
  assert.equal(typeof w.error, 'string');
});

test('write refuses anything that is not text', async () => {
  for (const bad of [null, undefined, 42, {}]) {
    const r = await notes.write('badtype', bad);
    assert.equal(r.ok, false);
  }
  const r = await notes.write('', 'text');
  assert.equal(r.ok, false);
});
