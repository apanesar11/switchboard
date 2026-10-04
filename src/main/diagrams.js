'use strict';

// diagrams.js — the Diagrams tab's files. ARCHITECTURE §4.17, §5 M10.
//
// A diagram is the admin's flow spec (the same JSON its Diagrams page saves), kept on
// THIS Mac rather than in any database: one file per diagram, in a folder per
// workspace, beside the config — `~/.switchboard/diagrams/<workspace>-<hash>/<id>.json`
// for a normal run, wherever SWITCHBOARD_CONFIG points for a test or a smoke. Like a
// note it never lives in the workspace folder, so it never shows up in Changes, in the
// Editor's tree or in a commit.
//
// The file is { id, name, kind, createdAt, updatedAt, archivedAt, spec } — the row the
// admin's `diagrams` table holds, minus the product. The renderer validates a spec
// with the admin's own parser before it ever asks for a write (lib/diagrams/validate.ts
// in the bundle); this module checks only what it has to in order to keep the folder
// sane: an object of the right kind, under the size cap, under a name that is unique in
// its workspace.
//
// Pictures dropped or pasted onto a canvas are stored once, by content, in
// `diagrams/images/`, and a spec names one as `sbimg://image/<file>` — the scheme
// index.js serves from that folder and nowhere else.
//
// Rules that hold for the whole file, as in notes.js:
//   * Nothing throws. Every export resolves to a value; a failure is
//     `{ ok: false, error: '<human sentence>' }`.
//   * Writes to one file are serialised, and go through a temp file and a rename, so
//     two saves cannot splice a file and a crash cannot leave half of one.
//   * Nothing here deletes anything but the one diagram the user asked to delete.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./config.js');

// The admin's limits (lib/diagrams/types.ts), so a diagram moves between the two
// without either one refusing it.
const NAME_MAX = 120;
const SPEC_MAX_BYTES = 512000;
const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const IMAGE_FILE_RE = /^[0-9a-f]{32}\.(png|jpg|webp)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let seq = 0;
const chains = new Map();          // file → the promise the next write waits on

function rootDir() {
  // Beside the config, for the reason notes.js gives: SWITCHBOARD_CONFIG has to move
  // these too, or a test would write into the user's real ~/.switchboard.
  return path.join(path.dirname(config.CONFIG_FILE), 'diagrams');
}

function imagesDir() {
  return path.join(rootDir(), 'images');
}

/**
 * The folder's name for a workspace id: readable, and ending in a hash of the WHOLE id
 * so no id can name a path outside the diagrams folder and no two ids share one —
 * notes.js's keyFor(), for the same reasons.
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
    .slice(0, 40) || 'workspace';
  return stem + '-' + hash;
}

function dirFor(wsId) {
  const key = keyFor(wsId);
  return key ? path.join(rootDir(), key) : null;
}

function fileFor(wsId, id) {
  const dir = dirFor(wsId);
  if (!dir || typeof id !== 'string' || !UUID_RE.test(id)) return null;
  return path.join(dir, id.toLowerCase() + '.json');
}

function why(err) {
  const code = err && err.code;
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  if (code === 'EROFS') return 'the disk is read-only';
  if (code === 'ENOSPC') return 'the disk is full';
  return String((err && err.message) || err);
}

function serial(file, job) {
  const prev = chains.get(file) || Promise.resolve();
  const run = prev.then(job, job);
  const settled = run.then(() => {}, () => {});
  chains.set(file, settled);
  settled.then(() => { if (chains.get(file) === settled) chains.delete(file); });
  return run;
}

async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${++seq}.tmp`;
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(tmp, text, 'utf8');
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
}

// ── checks ──────────────────────────────────────────────────────────────────

/** The admin's normalizeDiagramName(): one line, collapsed, 1–120 characters. */
function cleanName(raw) {
  if (typeof raw !== 'string') return { error: 'Name is required' };
  const value = raw.trim().replace(/\s+/g, ' ');
  if (!value) return { error: 'Name is required' };
  if (value.length > NAME_MAX) return { error: `Name must be ${NAME_MAX} characters or fewer` };
  return { value };
}

function checkSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return 'the diagram came without a spec';
  if (spec.kind !== 'flow') return 'only flow diagrams can be saved here';
  if (Buffer.byteLength(JSON.stringify(spec), 'utf8') > SPEC_MAX_BYTES) {
    return `the diagram is over ${Math.round(SPEC_MAX_BYTES / 1000)} KB — split it into two`;
  }
  return null;
}

// ── reading ─────────────────────────────────────────────────────────────────

function summaryOf(row) {
  return {
    id: row.id,
    name: row.name,
    kind: 'flow',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt || null,
  };
}

/** A diagram file as stored, or null for one that is not a diagram we wrote. */
async function readRow(file) {
  let text;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  let row;
  try {
    row = JSON.parse(text);
  } catch (_) {
    return { broken: true, file };
  }
  if (!row || typeof row !== 'object' || typeof row.id !== 'string' || typeof row.name !== 'string') {
    return { broken: true, file };
  }
  return row;
}

async function rows(wsId) {
  const dir = dirFor(wsId);
  if (!dir) return [];
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names) {
    if (!/\.json$/.test(name)) continue;
    const row = await readRow(path.join(dir, name));
    if (!row) continue;
    if (row.broken) {
      console.error('[switchboard] diagrams: skipping a file that is not a diagram:', row.file);
      continue;
    }
    out.push(row);
  }
  return out;
}

/** Every diagram in a workspace, archived ones included, newest-touched first. */
async function list(wsId) {
  if (!dirFor(wsId)) return { ok: false, error: 'no workspace was named' };
  try {
    const all = await rows(wsId);
    all.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return { ok: true, data: all.map(summaryOf) };
  } catch (err) {
    return { ok: false, error: `could not list the diagrams: ${why(err)}` };
  }
}

/** One diagram WITH its spec, as stored — the renderer re-parses the spec. */
async function get(wsId, id) {
  const file = fileFor(wsId, id);
  if (!file) return { ok: false, error: 'Invalid diagram id' };
  try {
    const row = await readRow(file);
    if (!row) return { ok: false, error: 'Diagram not found' };
    if (row.broken) return { ok: false, error: 'That diagram file is not valid JSON' };
    return { ok: true, data: Object.assign(summaryOf(row), { spec: row.spec }) };
  } catch (err) {
    return { ok: false, error: `could not read that diagram: ${why(err)}` };
  }
}

// ── writing ─────────────────────────────────────────────────────────────────

async function nameTaken(wsId, name, exceptId) {
  const all = await rows(wsId);
  return all.some(row => row.name === name && row.id !== exceptId);
}

const DUPLICATE_NAME_ERROR =
  'A diagram with that name already exists — pick another name, or edit the existing one';

/** A new diagram. Answers { ok, data: detail } like the admin's createDiagram. */
function create(wsId, name, spec) {
  const dir = dirFor(wsId);
  if (!dir) return Promise.resolve({ ok: false, error: 'no workspace was named' });
  const clean = cleanName(name);
  if (clean.error) return Promise.resolve({ ok: false, error: clean.error });
  const problem = checkSpec(spec);
  if (problem) return Promise.resolve({ ok: false, error: problem });
  // Serialised on the folder, so two creates with one name cannot both pass the check.
  return serial(dir, async () => {
    try {
      if (await nameTaken(wsId, clean.value, null)) return { ok: false, error: DUPLICATE_NAME_ERROR };
      const now = new Date().toISOString();
      const row = {
        id: crypto.randomUUID(),
        name: clean.value,
        kind: 'flow',
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        spec,
      };
      await writeAtomic(path.join(dir, row.id + '.json'), JSON.stringify(row, null, 2) + '\n');
      return { ok: true, data: Object.assign(summaryOf(row), { spec }) };
    } catch (err) {
      return { ok: false, error: `could not create that diagram: ${why(err)}` };
    }
  });
}

/** The editor's autosave: name and spec, archivedAt left alone (the admin's rule). */
function update(wsId, id, name, spec) {
  const dir = dirFor(wsId);
  const file = fileFor(wsId, id);
  if (!dir || !file) return Promise.resolve({ ok: false, error: 'Invalid diagram id' });
  const clean = cleanName(name);
  if (clean.error) return Promise.resolve({ ok: false, error: clean.error });
  const problem = checkSpec(spec);
  if (problem) return Promise.resolve({ ok: false, error: problem });
  return serial(dir, async () => {
    try {
      const row = await readRow(file);
      if (!row || row.broken) return { ok: false, error: 'Diagram not found' };
      if (row.name !== clean.value && await nameTaken(wsId, clean.value, row.id)) {
        return { ok: false, error: DUPLICATE_NAME_ERROR };
      }
      row.name = clean.value;
      row.kind = 'flow';
      row.spec = spec;
      row.updatedAt = new Date().toISOString();
      await writeAtomic(file, JSON.stringify(row, null, 2) + '\n');
      return { ok: true, data: Object.assign(summaryOf(row), { spec }) };
    } catch (err) {
      return { ok: false, error: `could not save that diagram: ${why(err)}` };
    }
  });
}

/**
 * Archive or unarchive. updatedAt stays where it was, as in the admin: "updated 3d
 * ago" keeps meaning the spec last changed then, and archiving doesn't reshuffle the
 * newest-first order.
 */
function setArchived(wsId, id, archived) {
  const dir = dirFor(wsId);
  const file = fileFor(wsId, id);
  if (!dir || !file) return Promise.resolve({ ok: false, error: 'Invalid diagram id' });
  const want = !!archived;
  return serial(dir, async () => {
    try {
      const row = await readRow(file);
      if (!row || row.broken) return { ok: false, error: 'Diagram not found' };
      if (want && row.archivedAt) return { ok: false, error: 'Diagram not found (or already archived)' };
      if (!want && !row.archivedAt) return { ok: false, error: 'Diagram not found (or already active)' };
      row.archivedAt = want ? new Date().toISOString() : null;
      await writeAtomic(file, JSON.stringify(row, null, 2) + '\n');
      return { ok: true, data: summaryOf(row) };
    } catch (err) {
      return { ok: false, error: `could not ${want ? 'archive' : 'unarchive'} that diagram: ${why(err)}` };
    }
  });
}

/** For good — the confirmation dialog in the renderer is the gate, as in the admin. */
function remove(wsId, id) {
  const dir = dirFor(wsId);
  const file = fileFor(wsId, id);
  if (!dir || !file) return Promise.resolve({ ok: false, error: 'Invalid diagram id' });
  return serial(dir, async () => {
    try {
      await fs.promises.unlink(file);
      return { ok: true, data: { id: String(id).toLowerCase() } };
    } catch (err) {
      if (err && err.code === 'ENOENT') return { ok: false, error: 'Diagram not found' };
      return { ok: false, error: `could not delete that diagram: ${why(err)}` };
    }
  });
}

// ── pictures ────────────────────────────────────────────────────────────────

/**
 * Keep a picture's bytes and answer the address a spec names it by. Stored by content,
 * so the same screenshot pasted twice is one file, and the name is all a request for it
 * can ever carry (imagePath()).
 */
async function saveImage(bytes, type) {
  const ext = IMAGE_TYPES[type];
  if (!ext) return { ok: false, error: "That isn't a PNG, JPEG or WebP image" };
  let buf;
  try {
    buf = Buffer.from(bytes);
  } catch (_) {
    return { ok: false, error: 'the picture came without its bytes' };
  }
  if (!buf.length) return { ok: false, error: 'that picture is empty' };
  if (buf.length > IMAGE_MAX_BYTES) {
    return { ok: false, error: `That image is over ${Math.round(IMAGE_MAX_BYTES / 1024 / 1024)} MB` };
  }
  const name = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32) + '.' + ext;
  const file = path.join(imagesDir(), name);
  try {
    await fs.promises.access(file);
  } catch (_) {
    try {
      await fs.promises.mkdir(imagesDir(), { recursive: true });
      const tmp = `${file}.${process.pid}.${++seq}.tmp`;
      await fs.promises.writeFile(tmp, buf);
      await fs.promises.rename(tmp, file);
    } catch (err) {
      return { ok: false, error: `could not keep that picture: ${why(err)}` };
    }
  }
  return { ok: true, src: 'sbimg://image/' + name };
}

/** The file behind `sbimg://image/<name>`, or null for any name we did not make. */
function imagePath(name) {
  if (typeof name !== 'string' || !IMAGE_FILE_RE.test(name)) return null;
  return path.join(imagesDir(), name);
}

/** Every write that has been started has finished — the quit path waits on this. */
function settle() {
  return Promise.all(Array.from(chains.values())).then(() => ({ ok: true }), () => ({ ok: true }));
}

module.exports = {
  list,
  get,
  create,
  update,
  setArchived,
  remove,
  saveImage,
  imagePath,
  settle,
  // For the tests, and for a sentence that has to name the folder.
  rootDir,
  dirFor,
  keyFor,
  IMAGE_TYPES,
};
