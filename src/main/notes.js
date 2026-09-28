'use strict';

// notes.js — the Notes tab's one file per workspace. ARCHITECTURE §4.15, §5 M9.
//
// A note is a scratch pad, not a document in the repo: one markdown file per workspace,
// kept BESIDE the config in `<config dir>/notes/` — `~/.switchboard/notes/` for a normal
// run, and wherever SWITCHBOARD_CONFIG points for a test or a smoke. It deliberately
// does not live in the workspace folder: a file written there would show up in
// `git status`, in the Changes tab and in the Editor's tree, and would be one
// `git add -A` away from being committed to someone else's repository. The point of the
// tab is a place to write down an idea without thinking about any of that. (The repo's
// own `.gitignore` carries `/notes/` for the one supported case where the two do meet:
// SWITCHBOARD_CONFIG pointed at an ignored config.json inside a checkout.)
//
// Rules that hold for the whole file:
//   * Nothing throws. Every export resolves to a value; a failure is
//     `{ ok: false, error: '<human sentence>' }`, the way editor.js and git.js do it.
//   * A note that has never been written is not an error: read() answers
//     `{ ok: true, text: '', missing: true }`, which is an empty note.
//   * An id is a workspace id OR — a Grid folder square (§4.10) has a terminal and can
//     have a note too — an absolute path. Neither is ever a filename directly: keyFor()
//     always ends the name with a hash of the WHOLE id, so nothing can escape the notes
//     folder, two folders with the same last segment cannot share a note, and neither
//     can two ids that differ only in case on a case-insensitive volume.
//   * Nothing here ever deletes what someone wrote. An empty note writes no file if
//     there was none (so a workspace that was merely looked at leaves nothing behind),
//     and truncates the file if there was one. Emptying a note is the user's edit;
//     an empty BUFFER arriving because a read failed or had not landed yet is not, and
//     that distinction is the renderer's to keep — see views/notes.js and `loaded`.
//   * A save is refused when the file has moved underneath it, exactly as editor.js
//     refuses one: `{ ok:false, conflict:true }` with the file's current mtime, and the
//     renderer decides. `opts.force` is the user saying overwrite.
//   * Writes for one note are serialised. Three things can start one — the typing
//     debounce, a blur, the quit flush — and two overlapping ones through the same
//     temp path would splice the file and lose the newer text.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./config.js');

// A note is prose someone typed. Past this it is not a note any more, and the
// renderer's block editor would take a visible pause to lay it out.
const MAX_BYTES = 2 * 1024 * 1024;

// editor.js's slop, for the same reason: mtimeMs survives IPC exactly, but a copy or a
// filesystem that stores less precision can move it by a rounding step.
const MTIME_SLOP_MS = 0.5;

let seq = 0;                       // makes each temp file's name its own
const chains = new Map();          // note file → the promise the next write waits on

function notesDir() {
  // path.dirname(CONFIG_FILE), not os.homedir(): SWITCHBOARD_CONFIG has to move the
  // notes as well, or a test would write into the user's real ~/.switchboard.
  return path.join(path.dirname(config.CONFIG_FILE), 'notes');
}

/**
 * keyFor(id) → the file's stem, or null for an id that names nothing.
 *
 * `sample-2` → `sample-2-72b8587ce3`; `/Users/me/Projects/odds` → `odds-e1d2c8e200`.
 * The readable part is there so the folder makes sense in Finder; the ten hex of
 * SHA-1 over the whole id is what makes the name unique and unforgeable. Every id is
 * hashed, with no exceptions: a scheme where some ids pass through verbatim collides
 * the moment a workspace happens to be called what another id hashes to, and on a
 * case-insensitive volume it collides for `Odds` and `odds`.
 */
function keyFor(id) {
  const want = typeof id === 'string' ? id.trim() : '';
  if (!want) return null;
  const hash = crypto.createHash('sha1').update(want).digest('hex').slice(0, 10);
  const stem = want
    .replace(/\/+$/, '')
    .split('/')
    .pop()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-._]+/, '')
    .slice(0, 40) || 'note';
  return stem + '-' + hash;
}

function fileFor(id) {
  const key = keyFor(id);
  return key ? path.join(notesDir(), key + '.md') : null;
}

/** An fs error as the tail of a sentence the renderer can show — editor.js's why(). */
function why(err) {
  const code = err && err.code;
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  if (code === 'EROFS') return 'the disk is read-only';
  if (code === 'ENOSPC') return 'the disk is full';
  if (code === 'EEXIST' || code === 'ENOTDIR') return `${notesDir()} is not a folder`;
  return String((err && err.message) || err);
}

/** One write at a time per note, in the order they were asked for. */
function serial(file, job) {
  const prev = chains.get(file) || Promise.resolve();
  const run = prev.then(job, job);
  const settled = run.then(() => {}, () => {});
  chains.set(file, settled);
  settled.then(() => { if (chains.get(file) === settled) chains.delete(file); });
  return run;
}

/** Every write that has been started has finished — the quit path waits on this. */
function settle() {
  return Promise.all(Array.from(chains.values())).then(() => ({ ok: true }), () => ({ ok: true }));
}

/**
 * read(id)
 *   → { ok:true, text, mtimeMs, size, missing:false }   the note
 *   → { ok:true, text:'', mtimeMs:null, size:0, missing:true }   nothing written yet
 *   → { ok:true, tooLarge:true, mtimeMs, size }         over 2 MB: NOT opened for editing
 *   → { ok:false, error }
 *
 * A file too large is answered with no text at all, the way editor.read() answers one.
 * Handing back a prefix would be worse than useless: the editor would hold two thirds
 * of a note, and the first autosave would write that prefix over the whole file.
 */
async function read(id) {
  const file = fileFor(id);
  if (!file) return { ok: false, error: 'no workspace was named' };
  let handle = null;
  try {
    handle = await fs.promises.open(file, 'r');
    const st = await handle.stat();
    if (!st.isFile()) return { ok: false, error: 'that note is not a file' };
    if (st.size > MAX_BYTES) return { ok: true, tooLarge: true, mtimeMs: st.mtimeMs, size: st.size, missing: false };
    const buf = await handle.readFile();
    // A BOM would show as a stray character on the note's first line. It is ours to
    // drop: nothing but this module writes the file, and write() never puts one back.
    const text = buf.toString('utf8').replace(/^﻿/, '');
    return { ok: true, text, mtimeMs: st.mtimeMs, size: st.size, missing: false };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ok: true, text: '', mtimeMs: null, size: 0, missing: true };
    }
    return { ok: false, error: `could not read that note: ${why(err)}` };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * write(id, text, { mtimeMs, force }) → { ok:true, mtimeMs, size, missing }
 *   or { ok:false, conflict:true, mtimeMs, missing, error } or { ok:false, error }.
 *
 * `opts.mtimeMs` is what the renderer last read or wrote: a number when it believes
 * there is a file, null when it believes there is none. Either belief being wrong is a
 * conflict, not an overwrite — something else has touched the note since.
 *
 * `missing:true` in a SUCCESSFUL answer means there is still no file: the note is empty
 * and none was made. An empty note and no note are the same note, and a folder full of
 * empty files for every workspace that was ever opened is not.
 *
 * Written through a temp file and renamed, unlike editor.js's Save, and for the
 * opposite reason: nothing else holds this file open, it has no mode or hard links
 * worth keeping, and it is rewritten whole every few seconds while someone types — so
 * the thing to guard against is a crash mid-write leaving half a note.
 */
function write(id, text, opts) {
  const file = fileFor(id);
  if (!file) return Promise.resolve({ ok: false, error: 'no workspace was named' });
  if (typeof text !== 'string') return Promise.resolve({ ok: false, error: 'there was no text to save' });
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
    return Promise.resolve({ ok: false, error: 'that note is too long to save' });
  }
  const o = opts || {};
  return serial(file, () => writeNow(file, text, o));
}

async function writeNow(file, text, o) {
  let current = null;
  try {
    current = await fs.promises.stat(file);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') return { ok: false, error: `could not save that note: ${why(err)}` };
  }
  if (current && !current.isFile()) return { ok: false, error: 'that note is not a file' };

  if (!o.force && o.mtimeMs !== undefined) {
    const want = o.mtimeMs;
    if (typeof want === 'number' && Number.isFinite(want)) {
      if (!current) {
        return { ok: false, conflict: true, missing: true, mtimeMs: null, error: 'that note was deleted on disk' };
      }
      if (Math.abs(current.mtimeMs - want) > MTIME_SLOP_MS) {
        return { ok: false, conflict: true, missing: false, mtimeMs: current.mtimeMs, error: 'that note changed on disk since it was opened' };
      }
    } else if (want === null && current && current.size > 0) {
      return { ok: false, conflict: true, missing: false, mtimeMs: current.mtimeMs, error: 'that note changed on disk since it was opened' };
    }
  }

  // Nothing to write and nothing there: leave the folder empty.
  if (!text && !current) return { ok: true, mtimeMs: null, size: 0, missing: true };

  const dir = path.dirname(file);
  const tmp = `${file}.${process.pid}.${++seq}.tmp`;
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(tmp, text, 'utf8');
    await fs.promises.rename(tmp, file);
    const st = await fs.promises.stat(file);
    return { ok: true, mtimeMs: st.mtimeMs, size: st.size, missing: false };
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    return { ok: false, error: `could not save that note: ${why(err)}` };
  }
}

module.exports = {
  read,
  write,
  settle,
  // For the tests, and for a sentence that has to name the file.
  fileFor,
  keyFor,
  notesDir,
  MAX_BYTES,
};
