'use strict';

// whiteboards.js — the Whiteboards screen's files. ARCHITECTURE §4.17, §5 M10.
//
// A whiteboard is the admin's flow spec (the same JSON its Diagrams page saves), kept on
// THIS Mac rather than in any database, beside the config — `~/.switchboard/whiteboards/`
// for a normal run, wherever SWITCHBOARD_CONFIG points for a test or a smoke. Like a note
// it never lives in a workspace folder, so it never shows up in Changes, in the Editor's
// tree or in a commit.
//
//   whiteboards/
//     store.json           folders, the workspace used last, the recent workspaces, the
//                          one-time migration notice and the migration's own record
//     boards/<id>.json     one whiteboard: { id, name, kind, folderId, workspace,
//                          createdAt, updatedAt, archivedAt, migratedFrom?,
//                          conversations?, spec }
//     documents/<id>.md    every whiteboard's Markdown documents, keyed by document id
//     images/<sha>.<ext>   pictures, stored once by content and named in a spec as
//                          sbimg://image/<file> — the scheme index.js serves from here
//
// Folders exist only in store.json. A board names its folder by id and every board file
// sits flat in boards/, so moving a board or renaming a folder is one small write and a
// folder name is only ever data, never a path. A board also names the workspace ✦ Answer
// reads for it; that is a rail workspace id, resolved to a folder by index.js and nowhere
// else, so nothing stored here can point a CLI at an arbitrary path.
//
// A board also keeps ✦ Answer's conversations (answer.js says what they are): for each
// CLI that has answered on it, the session or thread that every later answer continues,
// as { id, workspace, dir, startedAt, lastAt, turns }. They sit beside the spec, never in
// it — the spec is the admin's format — and they are bookkeeping, not an edit: writing
// one leaves updatedAt alone and tells no screen. The id goes into a CLI's arguments, so
// an entry is read back only when the id is a UUID and the rest is what answer.js could
// have written; anything else reads as no conversation. A copy of a board starts
// conversations of its own, and a board given another workspace forgets its own, since
// they read the old one.
//
// The renderer validates a spec with the admin's own parser before it asks for a write
// (lib/diagrams/validate.ts in the bundle); this module checks only what it has to in
// order to keep the folder sane: an object of the right kind, under a name that is
// unique in its folder.
//
// Before this module there was one folder of diagrams per workspace,
// `diagrams/<workspace>-<hash>/`. migrate() — called by index.js before the first window,
// never at require time — copies those into the store once, one folder per project, and
// then renames the old tree to `diagrams-before-whiteboards`. It deletes nothing.
//
// Rules that hold for the whole file:
//   * Nothing throws. Every export resolves to a value; a failure is
//     `{ ok: false, error: '<human sentence>', code? }`.
//   * Every board write and every store.json write goes through ONE serial chain, so a
//     name check and the write it guards cannot interleave with another, and a write
//     goes through a temp file and a rename, so a crash cannot leave half a file.
//     Documents keep a chain per file. settle() waits for all of them.
//   * Nothing here deletes anything but the one whiteboard the user asked to delete.
//   * Every path is computed from config.CONFIG_FILE when it is needed, never at require
//     time, and requiring this module does nothing on disk.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const config = require('./config.js');
// Discovery only — which workspaces the rail has, for the pickers and the migration. It
// runs no git and reads nothing until asked.
const workspaces = require('./workspaces.js');

// The admin's name limit, so a whiteboard moves between the two without either refusing
// its name. A whiteboard's size is not limited here (lib/diagrams/types.ts says why).
const NAME_MAX = 120;
const FOLDER_NAME_MAX = 60;
const WORKSPACE_MAX = 200;
const RECENT_MAX = 8;
const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const IMAGE_FILE_RE = /^[0-9a-f]{32}\.(png|jpg|webp)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOARD_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;
const DOCUMENT_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/i;

// The list's mini preview: at most this many boxes, fitted inside a 4px margin of a
// 40×30 frame. The renderer draws each with a 1px outline inside its rect, so none is
// smaller than 6×4 — anything less is all outline and reads as a dash, not a box. One
// axis may scale up to twice the other (see thumbOf).
const THUMB_MAX = 14;
const THUMB_W = 40;
const THUMB_H = 30;
const THUMB_PAD = 4;
const THUMB_MIN_W = 6;
const THUMB_MIN_H = 4;
const THUMB_STRETCH = 2;

// What the editor draws a node at, in flow units — lib/diagrams/layout.ts flowNodeSize
// and the constants beside it, which this mirrors for the preview only. A box is always
// 200 wide and as tall as its text; a note, a text and an image keep the size someone
// gave them in `size`. Main has no fonts to measure with, so a label's lines are counted
// at an average glyph width: exact for the usual one-line box, and close enough for the
// rest at a twentieth of the size.
const FLOW_BOX_WIDTH = 200;
const FLOW_BOX_MIN_HEIGHT = 52;
const FLOW_DIAMOND_HEIGHT = 92;
const FLOW_BOX_TEXT_PAD_Y = 22;
const FLOW_LABEL_WIDTH = FLOW_BOX_WIDTH - 28;
const FLOW_DIAMOND_LABEL_WIDTH = FLOW_BOX_WIDTH - 64;
const FLOW_NOTE_SIZE = 176;
const FLOW_NOTE_PAD = 14;
const FLOW_IMAGE_SIZE = { width: 240, height: 180 };
const FLOW_DOCUMENT_SIZE = { width: 240, height: 76 };
const FLOW_TEXT_MAX_WIDTH = 320;
const FLOW_TEXT_MIN_WIDTH = 40;
const FLOW_TEXT_PAD_X = 4;
const FLOW_TEXT_PAD_Y = 3;
const FLOW_DETAIL_FONT = 11;
const FLOW_DETAIL_LINE = 16;
const FLOW_DETAIL_GAP = 2;
// [font size, line height] per text size.
const FLOW_TEXT_METRICS = { small: [11, 15], medium: [13, 18], large: [17, 24] };
const GLYPH_EM = 0.55;

// The pre-whiteboards layout: `diagrams/<stem>-<sha1 of the workspace id, 10 hex>/`.
const LEGACY_DIR = 'diagrams';
const LEGACY_RENAMED = 'diagrams-before-whiteboards';
const LEGACY_KEY_RE = /^(.+)-([0-9a-f]{10})$/;
// What a store.json may name as the old tree. Anything else is ignored, so an edited
// store.json can never send imagePath() outside the config folder.
const LEGACY_ROOT_RE = /^diagrams(?:-before-whiteboards(?:-\d+)?)?$/;

const STORE_CHAIN = 'store';
const NO_FOLDER = 'No folder';
// The CLIs ✦ Answer keeps a conversation with (answer.js); a board keeps one of each.
const CONVERSATION_PROVIDERS = ['claude-code', 'codex'];
const CONVERSATION_DIR_MAX = 4096;

let seq = 0;
const chains = new Map();          // chain key → the promise the next job waits on
const listeners = new Set();       // onChange() callbacks
// Summaries by board file, reused while the file's mtime, size and inode are unchanged,
// so list() does not re-parse a board nobody has touched.
const summaryCache = new Map();
// The old tree's name as store.json last said it — imagePath() is synchronous and reads
// it often. undefined: not read yet.
let legacyRootName;
// What the last migrate() failed with, for list() to report until one succeeds.
let lastMigrationError = null;

// ── where things live ───────────────────────────────────────────────────────

function configDir() {
  // Beside the config: SWITCHBOARD_CONFIG has to move these too, or a test would write
  // into the user's real ~/.switchboard.
  return path.dirname(config.CONFIG_FILE);
}

function rootDir() {
  return path.join(configDir(), 'whiteboards');
}

function storeFile() {
  return path.join(rootDir(), 'store.json');
}

function boardsDir() {
  return path.join(rootDir(), 'boards');
}

function documentsDir() {
  return path.join(rootDir(), 'documents');
}

function imagesDir() {
  return path.join(rootDir(), 'images');
}

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function boardFile(id) {
  return isUuid(id) ? path.join(boardsDir(), id.toLowerCase() + '.json') : null;
}

function documentFile(id) {
  return isUuid(id) ? path.join(documentsDir(), id.toLowerCase() + '.md') : null;
}

/**
 * The folder name the old layout gave a workspace id: readable, and ending in a hash of
 * the WHOLE id so no id could name a path outside the diagrams folder and no two ids
 * shared one. Byte-for-byte the old diagrams.js keyFor(); migrate() matches folders by
 * recomputing it for every candidate id, since the hash cannot be inverted.
 */
function legacyKeyFor(id) {
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

// ── small helpers ───────────────────────────────────────────────────────────

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function now() {
  return new Date().toISOString();
}

function why(err) {
  const code = err && err.code;
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  if (code === 'EROFS') return 'the disk is read-only';
  if (code === 'ENOSPC') return 'the disk is full';
  return String((err && err.message) || err);
}

function serial(key, job) {
  const prev = chains.get(key) || Promise.resolve();
  const run = prev.then(job, job);
  const settled = run.then(() => {}, () => {});
  chains.set(key, settled);
  settled.then(() => { if (chains.get(key) === settled) chains.delete(key); });
  return run;
}

/** A job on the one chain every board and store.json write goes through. */
function serialStore(job) {
  return serial(STORE_CHAIN, job);
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

function isFileSync(file) {
  try { return fs.statSync(file).isFile(); } catch (_) { return false; }
}

function isDirSync(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch (_) { return false; }
}

function existsSync(target) {
  try { fs.lstatSync(target); return true; } catch (_) { return false; }
}

async function readdirOrEmpty(dir, opts) {
  try {
    return await fs.promises.readdir(dir, opts);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return [];
    throw err;
  }
}

/** Locale order that puts "sample 2" before "sample 10" and ignores case. */
function byName(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// ── change events ───────────────────────────────────────────────────────────

/**
 * onChange(fn) → unsubscribe. `fn({ reason, boardId?, folderId? })` runs after every
 * successful write, reason ∈ save | create | rename | workspace | move | duplicate |
 * archive | delete | folder | notice. index.js forwards it as sb:evt:wbChanged. The
 * recent-workspaces list changes no board or folder and says nothing.
 */
function onChange(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(reason, boardId, folderId) {
  const event = { reason };
  if (boardId !== undefined) event.boardId = boardId;
  if (folderId !== undefined) event.folderId = folderId;
  for (const fn of listeners) {
    try { fn(event); } catch (err) { console.error('[switchboard] whiteboards: a change listener failed:', err); }
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

/** A folder's name: one line, collapsed, 1–60 characters. */
function cleanFolderName(raw) {
  if (typeof raw !== 'string') return { error: 'Folder name is required' };
  const value = raw.trim().replace(/\s+/g, ' ');
  if (!value) return { error: 'Folder name is required' };
  if (value.length > FOLDER_NAME_MAX) return { error: `Folder names must be ${FOLDER_NAME_MAX} characters or fewer` };
  return { value };
}

/**
 * A rail workspace id as a whiteboard may store it, or null. One line, at most 200
 * characters, no slash of either kind and no leading dot: an absolute path, or anything
 * that could be mistaken for one, is never a workspace here. index.js resolves the id
 * with workspaces.lookup() — the rail's own list — and nothing else.
 */
function cleanWorkspace(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > WORKSPACE_MAX) return null;
  if (/[/\\]/.test(value) || value.startsWith('.')) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function checkSpec(spec) {
  if (!isObject(spec)) return 'the whiteboard came without a spec';
  if (spec.kind !== 'flow') return 'only flow whiteboards can be saved here';
  return null;
}

function duplicateNameError(name, folder) {
  return `A whiteboard named “${name}” is already in “${folder ? folder.name : NO_FOLDER}” — pick another name`;
}

/**
 * One CLI's conversation as a board keeps it, or null when it is not one answer.js could
 * have written: the id a UUID (it becomes a CLI argument, so nothing else is ever handed
 * back), the workspace an id as cleanWorkspace() takes it, the folder an absolute path,
 * both times dates, and at least one question asked.
 */
function cleanConversation(raw) {
  if (!isObject(raw) || !isUuid(raw.id)) return null;
  const workspace = cleanWorkspace(raw.workspace);
  if (!workspace || workspace !== raw.workspace) return null;
  const dir = raw.dir;
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || dir.length > CONVERSATION_DIR_MAX) return null;
  if (/[\u0000-\u001f\u007f]/.test(dir)) return null;
  for (const at of [raw.startedAt, raw.lastAt]) {
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null;
  }
  if (!Number.isSafeInteger(raw.turns) || raw.turns < 1) return null;
  return { id: raw.id.toLowerCase(), workspace, dir, startedAt: raw.startedAt, lastAt: raw.lastAt, turns: raw.turns };
}

/** A row's conversations, one per CLI, each null when there is none worth reading. */
function conversationsOf(row) {
  const raw = isObject(row) && isObject(row.conversations) ? row.conversations : {};
  const out = {};
  for (const provider of CONVERSATION_PROVIDERS) {
    out[provider] = Object.prototype.hasOwnProperty.call(raw, provider) ? cleanConversation(raw[provider]) : null;
  }
  return out;
}

// ── store.json ──────────────────────────────────────────────────────────────

function blankStore() {
  return { version: 1, folders: [], lastWorkspace: null, recentWorkspaces: [], notice: null, migration: null };
}

function cleanFolders(raw) {
  const out = [];
  const seen = new Set();
  for (const f of Array.isArray(raw) ? raw : []) {
    if (!isObject(f) || !isUuid(f.id) || typeof f.name !== 'string' || !f.name.trim()) continue;
    const id = f.id.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(Object.assign({}, f, {
      id,
      name: f.name,
      createdAt: typeof f.createdAt === 'string' ? f.createdAt : null,
      moved: f.moved === true,
    }));
  }
  return out;
}

function cleanRecent(raw) {
  const out = [];
  for (const id of Array.isArray(raw) ? raw : []) {
    const ws = cleanWorkspace(id);
    if (ws && out.indexOf(ws) === -1) out.push(ws);
    if (out.length >= RECENT_MAX) break;
  }
  return out;
}

function cleanNotice(raw) {
  if (!isObject(raw)) return null;
  return {
    boards: Number.isFinite(raw.boards) ? raw.boards : 0,
    folders: Number.isFinite(raw.folders) ? raw.folders : 0,
    dismissed: raw.dismissed === true,
  };
}

function cleanLegacyRoot(raw) {
  return typeof raw === 'string' && LEGACY_ROOT_RE.test(raw) ? raw : null;
}

function cleanMigration(raw) {
  if (!isObject(raw)) return null;
  const folders = {};
  if (isObject(raw.folders)) {
    for (const key of Object.keys(raw.folders)) {
      if (isUuid(raw.folders[key])) folders[key] = raw.folders[key].toLowerCase();
    }
  }
  return Object.assign({}, raw, {
    from: raw.from === 'diagrams' ? 'diagrams' : null,
    at: typeof raw.at === 'string' && raw.at ? raw.at : null,
    imported: (Array.isArray(raw.imported) ? raw.imported : []).filter(isUuid).map(id => id.toLowerCase()),
    folders,
    skipped: Number.isFinite(raw.skipped) && raw.skipped > 0 ? Math.floor(raw.skipped) : 0,
    legacyRoot: cleanLegacyRoot(raw.legacyRoot),
    error: typeof raw.error === 'string' ? raw.error : null,
  });
}

/** store.json as written, any field this version does not know about kept as it was. */
function cleanStore(raw) {
  const s = isObject(raw) ? raw : {};
  return Object.assign({}, s, {
    version: 1,
    folders: cleanFolders(s.folders),
    lastWorkspace: cleanWorkspace(s.lastWorkspace),
    recentWorkspaces: cleanRecent(s.recentWorkspaces),
    notice: cleanNotice(s.notice),
    migration: cleanMigration(s.migration),
  });
}

function rememberLegacyRoot(store) {
  legacyRootName = store.migration ? store.migration.legacyRoot : null;
}

/**
 * { store, broken } — `broken` when store.json is there but unreadable: the store then
 * starts from blank, and the first write keeps the unreadable file beside it.
 */
async function loadStore() {
  let text;
  try {
    text = await fs.promises.readFile(storeFile(), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const store = blankStore();
      rememberLegacyRoot(store);
      return { store, broken: false };
    }
    throw err;
  }
  try {
    const store = cleanStore(JSON.parse(text));
    rememberLegacyRoot(store);
    return { store, broken: false };
  } catch (_) {
    console.error('[switchboard] whiteboards: store.json is not valid JSON; starting from a blank store');
    const store = blankStore();
    rememberLegacyRoot(store);
    return { store, broken: true };
  }
}

/** Write store.json. An unreadable one is copied aside first, never overwritten unseen. */
async function saveStore(loaded) {
  if (loaded.broken) {
    const aside = path.join(rootDir(), `store.unreadable-${Date.now()}.json`);
    await fs.promises.copyFile(storeFile(), aside, fs.constants.COPYFILE_EXCL);
    console.error('[switchboard] whiteboards: kept the unreadable store.json as', aside);
    loaded.broken = false;
  }
  await writeAtomic(storeFile(), JSON.stringify(loaded.store, null, 2) + '\n');
  rememberLegacyRoot(loaded.store);
}

/** Like saveStore(), for a write the action it belongs to has already succeeded without. */
async function saveStoreQuietly(loaded, what) {
  try {
    await saveStore(loaded);
    return true;
  } catch (err) {
    console.error(`[switchboard] whiteboards: could not ${what}:`, why(err));
    return false;
  }
}

function folderById(store, id) {
  return id ? store.folders.find(f => f.id === id) || null : null;
}

/** The folder a board is in as far as anyone can see: one that no longer exists is none. */
function effectiveFolder(store, folderId) {
  return folderById(store, folderId) ? folderId : null;
}

/** A migrated folder is "moved" until the first time something happens in it. */
function touchFolder(store, folderId) {
  const folder = folderById(store, folderId);
  if (!folder || !folder.moved) return false;
  folder.moved = false;
  return true;
}

function pushRecent(store, wsId) {
  const next = [wsId].concat(store.recentWorkspaces.filter(id => id !== wsId)).slice(0, RECENT_MAX);
  const changed = next.join('\n') !== store.recentWorkspaces.join('\n');
  store.recentWorkspaces = next;
  return changed;
}

/**
 * The ids of the workspaces on the rail right now — discovery, which runs no git — or
 * null when discovery failed, which leaves a caller nothing to check against.
 */
async function railIds() {
  try {
    const list = await workspaces.discover();
    return new Set((Array.isArray(list) ? list : []).filter(w => w && typeof w.id === 'string').map(w => w.id));
  } catch (err) {
    console.error('[switchboard] whiteboards: could not list the rail workspaces:', why(err));
    return null;
  }
}

/**
 * The workspace a new board starts with: the one used last while it is still on the
 * rail, else the most recent one that is, else none. Workspaces leave the rail (a folder
 * goes, a declaration is dropped), and the one used last may be one a migrated board
 * brought; a new board never starts out reading one that is gone. `rail` null (discovery
 * failed) trusts the store.
 */
function startingWorkspace(store, rail) {
  if (!rail) return store.lastWorkspace;
  if (store.lastWorkspace && rail.has(store.lastWorkspace)) return store.lastWorkspace;
  return store.recentWorkspaces.find(id => rail.has(id)) || null;
}

// ── reading boards ──────────────────────────────────────────────────────────

/** Boxes, the workspaces answers read, and the mini preview, from a spec. */
function specStats(spec) {
  const nodes = isObject(spec) && Array.isArray(spec.nodes) ? spec.nodes : [];
  let boxes = 0;
  const reads = new Set();
  const rects = [];
  for (const node of nodes) {
    if (!isObject(node)) continue;
    // A pinned terminal is a window onto a shell, not a box anyone wrote.
    if (node.shape === 'terminal') continue;
    boxes++;
    // Only a box whose words are still the AI's says which workspace was read for them.
    if (node.ai === true) {
      const ws = cleanWorkspace(node.answeredIn);
      if (ws) reads.add(ws);
    }
    const p = node.position;
    if (rects.length < THUMB_MAX && isObject(p) && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      const s = flowNodeSize(node);
      rects.push([p.x, p.y, s.width, s.height]);
    }
  }
  return { boxes, reads: Array.from(reads).sort(byName), thumb: thumbOf(rects) };
}

/** How many lines `text` wraps to at `width` — counted, not measured (see GLYPH_EM). */
function textLines(text, width, fontSize) {
  const perLine = Math.max(1, Math.floor(width / (fontSize * GLYPH_EM)));
  return String(text).split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / perLine)), 0);
}

/** How wide the longest line of `text` runs, unwrapped — counted the same way. */
function textWidth(text, fontSize) {
  return String(text).split('\n').reduce((n, line) => Math.max(n, line.length), 0) * fontSize * GLYPH_EM;
}

/**
 * A node's width and height as the editor draws it (layout.ts flowNodeSize), for the
 * preview: the sizes a real board is laid out with, so the gaps between boxes come out
 * in proportion. A `size` counts only on the shapes that keep one, and only when it is
 * a real size.
 */
function flowNodeSize(node) {
  const shape = typeof node.shape === 'string' ? node.shape : 'rounded';
  const s = node.size;
  const size = isObject(s) && Number.isFinite(s.width) && Number.isFinite(s.height) && s.width > 0 && s.height > 0 ? s : null;
  if (shape === 'image') return size ? { width: size.width, height: size.height } : FLOW_IMAGE_SIZE;
  if (shape === 'document') return FLOW_DOCUMENT_SIZE;

  const label = typeof node.label === 'string' ? node.label : '';
  const detail = typeof node.detail === 'string' ? node.detail : '';
  // Own keys only: a hand-edited file's textSize is not trusted to name one.
  const [fontSize, lineHeight] = Object.prototype.hasOwnProperty.call(FLOW_TEXT_METRICS, node.textSize)
    ? FLOW_TEXT_METRICS[node.textSize]
    : FLOW_TEXT_METRICS.medium;
  const detailHeight = width => (detail ? textLines(detail, width, FLOW_DETAIL_FONT) * FLOW_DETAIL_LINE + FLOW_DETAIL_GAP : 0);

  if (shape === 'note') {
    const width = size ? size.width : FLOW_NOTE_SIZE;
    const inner = width - FLOW_NOTE_PAD * 2;
    const needed = textLines(label, inner, fontSize) * lineHeight + detailHeight(inner) + FLOW_NOTE_PAD * 2;
    return { width, height: Math.max(size ? size.height : FLOW_NOTE_SIZE, needed) };
  }
  if (shape === 'text') {
    // Free text runs as wide as its words until someone sizes it; its height always
    // follows its lines.
    const wrapAt = (size ? size.width : FLOW_TEXT_MAX_WIDTH) - FLOW_TEXT_PAD_X * 2;
    const words = Math.max(textWidth(label, fontSize), detail ? textWidth(detail, FLOW_DETAIL_FONT) : 0);
    const width = size ? size.width : Math.min(FLOW_TEXT_MAX_WIDTH, Math.max(FLOW_TEXT_MIN_WIDTH, words + FLOW_TEXT_PAD_X * 2 + 2));
    return { width, height: textLines(label, wrapAt, fontSize) * lineHeight + detailHeight(wrapAt) + FLOW_TEXT_PAD_Y * 2 };
  }
  // A box, of any outline. A diamond pads its label further in and stands taller.
  const diamond = shape === 'diamond';
  const labelWidth = diamond ? FLOW_DIAMOND_LABEL_WIDTH : FLOW_LABEL_WIDTH;
  const text = textLines(label, labelWidth, fontSize) * lineHeight + detailHeight(labelWidth) + FLOW_BOX_TEXT_PAD_Y;
  return { width: FLOW_BOX_WIDTH, height: Math.max(diamond ? FLOW_DIAMOND_HEIGHT : FLOW_BOX_MIN_HEIGHT, text) };
}

/**
 * Rects in flow units → the preview's rects in the 40×30 frame, 1 decimal.
 *
 * The rects' bounds fit inside the frame's 4px margin, centred. Each axis fits on its
 * own and the looser one is then held to twice the tighter: a tree's ranks, a column's
 * rows, spread far enough apart to see between them, while a single row of boxes still
 * reads as a row rather than a band of tall bars. Every rect then grows to at least
 * 6×4 about its own centre — so a box far smaller than a pixel at this scale is still
 * an outlined box — and stays inside the frame.
 */
function thumbOf(rects) {
  if (!rects.length) return [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y, w, h] of rects) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }
  const bw = Math.max(maxX - minX, 1);
  const bh = Math.max(maxY - minY, 1);
  const innerW = THUMB_W - THUMB_PAD * 2;
  const innerH = THUMB_H - THUMB_PAD * 2;
  let sx = innerW / bw;
  let sy = innerH / bh;
  sx = Math.min(sx, sy * THUMB_STRETCH);
  sy = Math.min(sy, sx * THUMB_STRETCH);
  const ox = (THUMB_W - bw * sx) / 2;
  const oy = (THUMB_H - bh * sy) / 2;
  const r1 = n => Math.round(n * 10) / 10;
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  return rects.map(([x, y, w, h]) => {
    // Sizes are rounded first and the corner placed from the rounded size, so a rect
    // pushed against the far edge ends on it rather than a tenth past it.
    const tw = r1(clamp(w * sx, THUMB_MIN_W, THUMB_W));
    const th = r1(clamp(h * sy, THUMB_MIN_H, THUMB_H));
    const cx = (x - minX + w / 2) * sx + ox;
    const cy = (y - minY + h / 2) * sy + oy;
    return [r1(clamp(cx - tw / 2, 0, THUMB_W - tw)), r1(clamp(cy - th / 2, 0, THUMB_H - th)), tw, th];
  });
}

/** What every list and every write answers for a board — never its spec. */
function summaryOf(row) {
  const stats = specStats(row.spec);
  return {
    id: row.id.toLowerCase(),
    name: row.name,
    kind: 'flow',
    folderId: isUuid(row.folderId) ? row.folderId.toLowerCase() : null,
    workspace: cleanWorkspace(row.workspace),
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : null,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null,
    archivedAt: row.archivedAt || null,
    boxes: stats.boxes,
    reads: stats.reads,
    thumb: stats.thumb,
  };
}

/** A summary as the renderer sees it: a folder that no longer exists reads as none. */
function shown(summary, store) {
  const folderId = effectiveFolder(store, summary.folderId);
  return folderId === summary.folderId ? Object.assign({}, summary) : Object.assign({}, summary, { folderId });
}

/** A board file as stored, null when it is not there, or { broken } when it is not a board. */
async function readBoardFile(file) {
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
  const stem = path.basename(file, '.json').toLowerCase();
  if (!isObject(row) || !isUuid(row.id) || row.id.toLowerCase() !== stem || typeof row.name !== 'string') {
    return { broken: true, file };
  }
  return row;
}

/** Every board's summary, archived ones included, unchanged files from the cache. */
async function boardSummaries() {
  const names = await readdirOrEmpty(boardsDir());
  const out = [];
  const seen = new Set();
  for (const name of names) {
    if (!BOARD_FILE_RE.test(name)) continue;
    const file = path.join(boardsDir(), name);
    seen.add(file);
    let st;
    try {
      st = await fs.promises.stat(file);
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      throw err;
    }
    const stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
    const cached = summaryCache.get(file);
    if (cached && cached.stamp === stamp) {
      if (cached.summary) out.push(cached.summary);
      continue;
    }
    const row = await readBoardFile(file);
    if (!row) continue;
    if (row.broken) {
      console.error('[switchboard] whiteboards: skipping a file that is not a whiteboard:', file);
      summaryCache.set(file, { stamp, summary: null });
      continue;
    }
    const summary = summaryOf(row);
    summaryCache.set(file, { stamp, summary });
    out.push(summary);
  }
  for (const file of Array.from(summaryCache.keys())) {
    if (!seen.has(file)) summaryCache.delete(file);
  }
  return out;
}

async function writeRow(row) {
  const file = boardFile(row.id);
  await writeAtomic(file, JSON.stringify(row, null, 2) + '\n');
  summaryCache.delete(file);
}

/** Inside the store chain: the row behind `id`, or an error value to answer with. */
async function rowFor(id) {
  const file = boardFile(id);
  if (!file) return { error: 'Invalid whiteboard id' };
  const row = await readBoardFile(file);
  if (!row) return { error: 'Whiteboard not found' };
  if (row.broken) return { error: 'That whiteboard file is not valid JSON' };
  return { row };
}

async function nameTaken(store, folderId, name, exceptId) {
  const all = await boardSummaries();
  return all.some(s => s.id !== exceptId && s.name === name && effectiveFolder(store, s.folderId) === folderId);
}

async function namesIn(store, folderId) {
  const all = await boardSummaries();
  return new Set(all.filter(s => effectiveFolder(store, s.folderId) === folderId).map(s => s.name));
}

/** `base + suffix`, the base cut so the whole stays within the name limit. */
function fitName(base, suffix) {
  return base.slice(0, Math.max(1, NAME_MAX - suffix.length)).trimEnd() + suffix;
}

// ── the screen's reads ──────────────────────────────────────────────────────

/** A folder written for a sentence: the home folder as ~, anything else in full. */
function homeLabel(dir) {
  const home = os.homedir();
  const d = String(dir || '');
  if (d === home) return '~';
  return d.startsWith(home + path.sep) ? '~' + d.slice(home.length) : d;
}

/**
 * Where the old diagrams are now, for the screen's sentences about them — the real
 * folder, so a store kept elsewhere by SWITCHBOARD_CONFIG is named as it is. A finished
 * run names the tree it renamed (null when there was none); an unfinished one, the old
 * tree where it still is, or a rename an interrupted run made and never recorded.
 */
function legacyLabel(m) {
  const base = configDir();
  let name;
  if (m && m.at) name = m.legacyRoot;
  else if (isDirSync(path.join(base, LEGACY_DIR))) name = LEGACY_DIR;
  else name = findRenamedLegacy(base) || LEGACY_DIR;
  return name ? homeLabel(path.join(base, name)) : null;
}

function migrationReport(store) {
  const m = store.migration;
  if (!m && !lastMigrationError) return null;
  return {
    error: lastMigrationError,
    skipped: m ? m.skipped : 0,
    legacyRoot: m ? m.legacyRoot : null,
    legacyLabel: legacyLabel(m),
  };
}

/**
 * Everything the Whiteboards screen draws, in one read: the folders (by name, each with
 * how many active and archived boards it holds), every board (newest edit first), the
 * migration notice and report (migrationReport) and the workspaces used last.
 */
async function list() {
  try {
    const { store } = await loadStore();
    const boards = (await boardSummaries()).map(s => shown(s, store));
    boards.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const counts = new Map();
    for (const b of boards) {
      if (!b.folderId) continue;
      const c = counts.get(b.folderId) || { count: 0, archived: 0 };
      if (b.archivedAt) c.archived++;
      else c.count++;
      counts.set(b.folderId, c);
    }
    const folders = store.folders
      .map(f => {
        const c = counts.get(f.id) || { count: 0, archived: 0 };
        return { id: f.id, name: f.name, createdAt: f.createdAt, moved: f.moved, count: c.count, archived: c.archived };
      })
      .sort((a, b) => byName(a.name, b.name));
    return {
      ok: true,
      data: {
        folders,
        boards,
        notice: store.notice,
        lastWorkspace: store.lastWorkspace,
        recentWorkspaces: store.recentWorkspaces,
        migration: migrationReport(store),
      },
    };
  } catch (err) {
    return { ok: false, error: `could not list the whiteboards: ${why(err)}` };
  }
}

/** One whiteboard WITH its spec, as stored — the renderer re-parses the spec. */
async function get(id) {
  const file = boardFile(id);
  if (!file) return { ok: false, error: 'Invalid whiteboard id' };
  try {
    const row = await readBoardFile(file);
    if (!row) return { ok: false, error: 'Whiteboard not found' };
    if (row.broken) return { ok: false, error: 'That whiteboard file is not valid JSON' };
    const { store } = await loadStore();
    return { ok: true, data: Object.assign(shown(summaryOf(row), store), { spec: row.spec }) };
  } catch (err) {
    return { ok: false, error: `could not read that whiteboard: ${why(err)}` };
  }
}

/**
 * The workspaces a picker offers: every rail workspace (discovery order) with its
 * project and its folder written the short way, the recent ones that still exist, and
 * the one a new board would start with (startingWorkspace: the one used last, while it
 * is still on the rail).
 */
async function workspaceChoices() {
  try {
    const list = await workspaces.discover();
    const all = (Array.isArray(list) ? list : []).map(w => ({ id: w.id, project: w.project, dirLabel: homeLabel(w.dir) }));
    const ids = new Set(all.map(w => w.id));
    const { store } = await loadStore();
    return {
      ok: true,
      data: {
        workspaces: all,
        recent: store.recentWorkspaces.filter(id => ids.has(id)),
        last: startingWorkspace(store, ids),
      },
    };
  } catch (err) {
    return { ok: false, error: `could not list the workspaces: ${why(err)}` };
  }
}

// ── writing boards ──────────────────────────────────────────────────────────

/**
 * A new whiteboard: { folderId, name, spec, workspace? }. `workspace` left out starts it
 * with the workspace used last, as long as that is still on the rail (startingWorkspace);
 * null starts it with none. Answers the board with its spec.
 */
function create(req) {
  const r = isObject(req) ? req : {};
  const clean = cleanName(r.name);
  if (clean.error) return Promise.resolve({ ok: false, error: clean.error });
  const problem = checkSpec(r.spec);
  if (problem) return Promise.resolve({ ok: false, error: problem });
  let folderId = null;
  if (r.folderId !== null && r.folderId !== undefined) {
    if (!isUuid(r.folderId)) return Promise.resolve({ ok: false, error: 'That folder no longer exists' });
    folderId = r.folderId.toLowerCase();
  }
  let workspace;
  if (r.workspace !== undefined && r.workspace !== null) {
    workspace = cleanWorkspace(r.workspace);
    if (!workspace) return Promise.resolve({ ok: false, error: 'That is not a workspace on the rail' });
  } else if (r.workspace === null) {
    workspace = null;
  }
  // Asked before joining the chain, so discovery overlaps the writes queued ahead.
  const rail = workspace === undefined ? railIds() : Promise.resolve(null);
  return serialStore(async () => {
    try {
      const loaded = await loadStore();
      const { store } = loaded;
      if (workspace === undefined) workspace = startingWorkspace(store, await rail);
      const folder = folderById(store, folderId);
      if (folderId && !folder) return { ok: false, error: 'That folder no longer exists' };
      if (await nameTaken(store, folderId, clean.value, null)) return { ok: false, error: duplicateNameError(clean.value, folder) };
      const at = now();
      const row = {
        id: crypto.randomUUID(),
        name: clean.value,
        kind: 'flow',
        folderId,
        workspace,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        spec: r.spec,
      };
      await writeRow(row);
      if (touchFolder(store, folderId)) await saveStoreQuietly(loaded, 'mark the folder touched');
      emit('create', row.id, folderId);
      return { ok: true, data: Object.assign(shown(summaryOf(row), store), { spec: row.spec }) };
    } catch (err) {
      return { ok: false, error: `could not create that whiteboard: ${why(err)}` };
    }
  });
}

/** The editor's autosave: the spec only — never the name — and updatedAt moves. */
function saveSpec(id, spec) {
  if (!boardFile(id)) return Promise.resolve({ ok: false, error: 'Invalid whiteboard id' });
  const problem = checkSpec(spec);
  if (problem) return Promise.resolve({ ok: false, error: problem });
  return serialStore(async () => {
    try {
      const found = await rowFor(id);
      if (found.error) return { ok: false, error: found.error };
      const { row } = found;
      row.kind = 'flow';
      row.spec = spec;
      row.updatedAt = now();
      await writeRow(row);
      const loaded = await loadStore();
      const folderId = effectiveFolder(loaded.store, row.folderId);
      if (touchFolder(loaded.store, folderId)) await saveStoreQuietly(loaded, 'mark the folder touched');
      emit('save', row.id, folderId);
      return { ok: true, data: shown(summaryOf(row), loaded.store) };
    } catch (err) {
      return { ok: false, error: `could not save that whiteboard: ${why(err)}` };
    }
  });
}

/** A new name, unique in the board's folder. updatedAt moves. */
function rename(id, name) {
  if (!boardFile(id)) return Promise.resolve({ ok: false, error: 'Invalid whiteboard id' });
  const clean = cleanName(name);
  if (clean.error) return Promise.resolve({ ok: false, error: clean.error });
  return serialStore(async () => {
    try {
      const found = await rowFor(id);
      if (found.error) return { ok: false, error: found.error };
      const { row } = found;
      const loaded = await loadStore();
      const { store } = loaded;
      const folderId = effectiveFolder(store, row.folderId);
      if (row.name === clean.value) return { ok: true, data: shown(summaryOf(row), store) };
      if (await nameTaken(store, folderId, clean.value, row.id.toLowerCase())) {
        return { ok: false, error: duplicateNameError(clean.value, folderById(store, folderId)) };
      }
      row.name = clean.value;
      row.updatedAt = now();
      await writeRow(row);
      if (touchFolder(store, folderId)) await saveStoreQuietly(loaded, 'mark the folder touched');
      emit('rename', row.id, folderId);
      return { ok: true, data: shown(summaryOf(row), store) };
    } catch (err) {
      return { ok: false, error: `could not rename that whiteboard: ${why(err)}` };
    }
  });
}

/**
 * The workspace ✦ Answer reads for this board, or null for none. Not an edit of the
 * board, so updatedAt stays; a workspace (not null) also becomes the one used last and
 * goes to the front of the recent list. A real change forgets the board's conversations:
 * they read the old workspace, and the next answer starts one in the new.
 */
function setWorkspace(id, wsId) {
  if (!boardFile(id)) return Promise.resolve({ ok: false, error: 'Invalid whiteboard id' });
  let workspace = null;
  if (wsId !== null && wsId !== undefined) {
    workspace = cleanWorkspace(wsId);
    if (!workspace) return Promise.resolve({ ok: false, error: 'That is not a workspace on the rail' });
  }
  return serialStore(async () => {
    try {
      const found = await rowFor(id);
      if (found.error) return { ok: false, error: found.error };
      const { row } = found;
      const loaded = await loadStore();
      const { store } = loaded;
      const changed = cleanWorkspace(row.workspace) !== workspace;
      if (changed) {
        row.workspace = workspace;
        delete row.conversations;
        await writeRow(row);
      }
      if (workspace) {
        const last = store.lastWorkspace !== workspace;
        store.lastWorkspace = workspace;
        if (pushRecent(store, workspace) || last) await saveStoreQuietly(loaded, 'remember the workspace');
      }
      if (changed) emit('workspace', row.id, effectiveFolder(store, row.folderId));
      return { ok: true, data: shown(summaryOf(row), store) };
    } catch (err) {
      return { ok: false, error: `could not change that whiteboard's workspace: ${why(err)}` };
    }
  });
}

/** Into another folder (or none). Refused when the folder has a board of that name. */
function move(id, folderId) {
  if (!boardFile(id)) return Promise.resolve({ ok: false, error: 'Invalid whiteboard id' });
  let target = null;
  if (folderId !== null && folderId !== undefined) {
    if (!isUuid(folderId)) return Promise.resolve({ ok: false, error: 'That folder no longer exists' });
    target = folderId.toLowerCase();
  }
  return serialStore(async () => {
    try {
      const found = await rowFor(id);
      if (found.error) return { ok: false, error: found.error };
      const { row } = found;
      const loaded = await loadStore();
      const { store } = loaded;
      const folder = folderById(store, target);
      if (target && !folder) return { ok: false, error: 'That folder no longer exists' };
      if (effectiveFolder(store, row.folderId) === target) return { ok: true, data: shown(summaryOf(row), store) };
      if (await nameTaken(store, target, row.name, row.id.toLowerCase())) {
        return { ok: false, error: `A whiteboard named “${row.name}” is already in “${folder ? folder.name : NO_FOLDER}” — rename it first` };
      }
      row.folderId = target;
      await writeRow(row);
      if (touchFolder(store, target)) await saveStoreQuietly(loaded, 'mark the folder touched');
      emit('move', row.id, target);
      return { ok: true, data: shown(summaryOf(row), store) };
    } catch (err) {
      return { ok: false, error: `could not move that whiteboard: ${why(err)}` };
    }
  });
}

/**
 * A copy in the same folder with the same workspace, active, named "X copy" (then
 * "X copy 2", …). Every Markdown document the spec names is copied to a new file and the
 * copy points at that, so editing one board's document never edits the other's. The
 * copy has no conversations: two boards continuing one CLI session would each find the
 * other's questions in it.
 */
function duplicate(id) {
  if (!boardFile(id)) return Promise.resolve({ ok: false, error: 'Invalid whiteboard id' });
  return serialStore(async () => {
    try {
      const found = await rowFor(id);
      if (found.error) return { ok: false, error: found.error };
      const { row } = found;
      const loaded = await loadStore();
      const { store } = loaded;
      const folderId = effectiveFolder(store, row.folderId);
      const taken = await namesIn(store, folderId);
      let name = fitName(row.name, ' copy');
      for (let n = 2; taken.has(name); n++) name = fitName(row.name, ` copy ${n}`);
      const spec = row.spec === undefined ? undefined : JSON.parse(JSON.stringify(row.spec));
      await copyDocuments(spec);
      const at = now();
      const copy = Object.assign({}, row, {
        id: crypto.randomUUID(),
        name,
        kind: 'flow',
        folderId,
        workspace: cleanWorkspace(row.workspace),
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        spec,
      });
      delete copy.migratedFrom;
      delete copy.conversations;
      await writeRow(copy);
      if (touchFolder(store, folderId)) await saveStoreQuietly(loaded, 'mark the folder touched');
      emit('duplicate', copy.id, folderId);
      return { ok: true, data: Object.assign(shown(summaryOf(copy), store), { spec: copy.spec }) };
    } catch (err) {
      return { ok: false, error: `could not duplicate that whiteboard: ${why(err)}` };
    }
  });
}

/** Give every document a copied spec names a file of its own (in place). */
async function copyDocuments(spec) {
  if (!isObject(spec) || !Array.isArray(spec.nodes)) return;
  const made = new Map();
  for (const node of spec.nodes) {
    if (!isObject(node) || !isUuid(node.documentId)) continue;
    const from = node.documentId.toLowerCase();
    if (!made.has(from)) {
      let text;
      try {
        text = await fs.promises.readFile(documentFile(from), 'utf8');
      } catch (err) {
        if (!err || err.code !== 'ENOENT') throw err;
        // One the migration left in the old tree (getDocument() brings it in when it is
        // opened) is copied from there, so the copy still has a document of its own.
        const old = await legacyDocumentFile(from);
        // A document that is already gone stays a reference to nothing, as it was.
        if (!old) { made.set(from, from); continue; }
        text = await fs.promises.readFile(old, 'utf8');
      }
      const to = crypto.randomUUID();
      await writeAtomic(documentFile(to), text);
      made.set(from, to);
    }
    node.documentId = made.get(from);
  }
}

/**
 * Archive or unarchive. updatedAt stays where it was, as in the admin: "edited 3d ago"
 * keeps meaning the spec last changed then, and archiving doesn't reshuffle the order.
 */
function setArchived(id, archived) {
  if (!boardFile(id)) return Promise.resolve({ ok: false, error: 'Invalid whiteboard id' });
  const want = !!archived;
  return serialStore(async () => {
    try {
      const found = await rowFor(id);
      if (found.error) return { ok: false, error: 'Whiteboard not found' };
      const { row } = found;
      if (want && row.archivedAt) return { ok: false, error: 'Whiteboard not found (or already archived)' };
      if (!want && !row.archivedAt) return { ok: false, error: 'Whiteboard not found (or already active)' };
      row.archivedAt = want ? now() : null;
      await writeRow(row);
      const { store } = await loadStore();
      emit('archive', row.id, effectiveFolder(store, row.folderId));
      return { ok: true, data: shown(summaryOf(row), store) };
    } catch (err) {
      return { ok: false, error: `could not ${want ? 'archive' : 'unarchive'} that whiteboard: ${why(err)}` };
    }
  });
}

/**
 * For good — the confirmation dialog in the renderer is the gate, as in the admin. Only
 * the board's own file goes: its documents stay, since undo and a copied box may still
 * name them.
 */
function remove(id) {
  const file = boardFile(id);
  if (!file) return Promise.resolve({ ok: false, error: 'Invalid whiteboard id' });
  return serialStore(async () => {
    try {
      let folderId = null;
      try {
        const row = await readBoardFile(file);
        if (row && !row.broken && isUuid(row.folderId)) folderId = row.folderId.toLowerCase();
      } catch (_) { folderId = null; }
      await fs.promises.unlink(file);
      summaryCache.delete(file);
      const { store } = await loadStore().catch(() => ({ store: blankStore() }));
      const gone = String(id).toLowerCase();
      emit('delete', gone, effectiveFolder(store, folderId));
      return { ok: true, data: { id: gone } };
    } catch (err) {
      if (err && err.code === 'ENOENT') return { ok: false, error: 'Whiteboard not found' };
      return { ok: false, error: `could not delete that whiteboard: ${why(err)}` };
    }
  });
}

// ── ✦ Answer's conversations ────────────────────────────────────────────────

/** One CLI's conversation on a board: { ok, data } with the entry, or null for none. */
async function conversation(id, provider) {
  if (CONVERSATION_PROVIDERS.indexOf(provider) === -1) return { ok: false, error: 'that provider keeps no conversation' };
  const all = await conversations(id);
  return all.ok ? { ok: true, data: all.data[provider] } : all;
}

/** Both CLIs' conversations on a board: { ok, data: { 'claude-code', codex } }, each null for none. */
async function conversations(id) {
  const file = boardFile(id);
  if (!file) return { ok: false, error: 'Invalid whiteboard id' };
  try {
    const row = await readBoardFile(file);
    if (!row) return { ok: false, error: 'Whiteboard not found' };
    if (row.broken) return { ok: false, error: 'That whiteboard file is not valid JSON' };
    return { ok: true, data: conversationsOf(row) };
  } catch (err) {
    return { ok: false, error: `could not read that whiteboard: ${why(err)}` };
  }
}

/**
 * Keep `entry` as the board's conversation with `provider`, or forget it (null). On the
 * store chain like every board write, reading the row again inside it, so it can never
 * undo an autosave nor be undone by one. Not an edit of the board: updatedAt stays and no
 * change is emitted, so an open editor never reloads for it. Answers the entry kept.
 */
function setConversation(id, provider, entry) {
  if (!boardFile(id)) return Promise.resolve({ ok: false, error: 'Invalid whiteboard id' });
  if (CONVERSATION_PROVIDERS.indexOf(provider) === -1) {
    return Promise.resolve({ ok: false, error: 'that provider keeps no conversation' });
  }
  let next = null;
  if (entry !== null && entry !== undefined) {
    next = cleanConversation(entry);
    if (!next) return Promise.resolve({ ok: false, error: 'that is not a conversation ✦ Answer could have kept' });
  }
  return serialStore(async () => {
    try {
      const found = await rowFor(id);
      if (found.error) return { ok: false, error: found.error };
      const { row } = found;
      const kept = conversationsOf(row);
      kept[provider] = next;
      // Only the entries worth reading go back: anything malformed is dropped on the way.
      const out = {};
      for (const p of CONVERSATION_PROVIDERS) if (kept[p]) out[p] = kept[p];
      const want = Object.keys(out).length ? out : undefined;
      // Already so (forgetting one there is none of, say): no write at all.
      if (JSON.stringify(want) === JSON.stringify(row.conversations)) return { ok: true, data: next };
      if (want) row.conversations = want;
      else delete row.conversations;
      await writeRow(row);
      return { ok: true, data: next };
    } catch (err) {
      return { ok: false, error: `could not keep that whiteboard's conversation: ${why(err)}` };
    }
  });
}

// ── folders ─────────────────────────────────────────────────────────────────

function publicFolder(folder) {
  return { id: folder.id, name: folder.name, createdAt: folder.createdAt, moved: folder.moved };
}

function folderNameTaken(store, name, exceptId) {
  const want = name.toLowerCase();
  return store.folders.some(f => f.id !== exceptId && f.name.toLowerCase() === want);
}

/** A new, empty folder. Names are unique whatever their case. */
function createFolder(name) {
  const clean = cleanFolderName(name);
  if (clean.error) return Promise.resolve({ ok: false, error: clean.error });
  return serialStore(async () => {
    try {
      const loaded = await loadStore();
      const { store } = loaded;
      if (folderNameTaken(store, clean.value, null)) return { ok: false, error: `A folder named “${clean.value}” already exists` };
      const folder = { id: crypto.randomUUID(), name: clean.value, createdAt: now(), moved: false };
      store.folders.push(folder);
      await saveStore(loaded);
      emit('folder', undefined, folder.id);
      return { ok: true, data: publicFolder(folder) };
    } catch (err) {
      return { ok: false, error: `could not make that folder: ${why(err)}` };
    }
  });
}

/** A new name for a folder; a migrated folder stops being "moved". */
function renameFolder(id, name) {
  if (!isUuid(id)) return Promise.resolve({ ok: false, error: 'That folder no longer exists' });
  const clean = cleanFolderName(name);
  if (clean.error) return Promise.resolve({ ok: false, error: clean.error });
  const want = id.toLowerCase();
  return serialStore(async () => {
    try {
      const loaded = await loadStore();
      const { store } = loaded;
      const folder = folderById(store, want);
      if (!folder) return { ok: false, error: 'That folder no longer exists' };
      if (folderNameTaken(store, clean.value, want)) return { ok: false, error: `A folder named “${clean.value}” already exists` };
      folder.name = clean.value;
      folder.moved = false;
      await saveStore(loaded);
      emit('folder', undefined, folder.id);
      return { ok: true, data: publicFolder(folder) };
    } catch (err) {
      return { ok: false, error: `could not rename that folder: ${why(err)}` };
    }
  });
}

/** An empty folder goes; one with any board in it — archived ones too — stays. */
function removeFolder(id) {
  if (!isUuid(id)) return Promise.resolve({ ok: false, error: 'That folder no longer exists' });
  const want = id.toLowerCase();
  return serialStore(async () => {
    try {
      const loaded = await loadStore();
      const { store } = loaded;
      if (!folderById(store, want)) return { ok: false, error: 'That folder no longer exists' };
      const all = await boardSummaries();
      if (all.some(s => s.folderId === want)) return { ok: false, error: 'Move its whiteboards out first' };
      store.folders = store.folders.filter(f => f.id !== want);
      await saveStore(loaded);
      emit('folder', undefined, want);
      return { ok: true, data: { id: want } };
    } catch (err) {
      return { ok: false, error: `could not delete that folder: ${why(err)}` };
    }
  });
}

// ── what the store remembers ────────────────────────────────────────────────

/** The migration notice has been read: it does not come back. */
function dismissNotice() {
  return serialStore(async () => {
    try {
      const loaded = await loadStore();
      const { store } = loaded;
      if (!store.notice || store.notice.dismissed) return { ok: true, data: {} };
      store.notice.dismissed = true;
      await saveStore(loaded);
      emit('notice');
      return { ok: true, data: {} };
    } catch (err) {
      return { ok: false, error: `could not dismiss that notice: ${why(err)}` };
    }
  });
}

/**
 * A workspace was just used — a terminal opened on a board, or a CLI asked to read it —
 * so it goes to the front of the recent list. `opts.last` also makes it the workspace a
 * new board starts with.
 */
function noteWorkspace(wsId, opts) {
  const workspace = cleanWorkspace(wsId);
  if (!workspace) return Promise.resolve({ ok: false, error: 'That is not a workspace on the rail' });
  const last = !!(opts && opts.last);
  return serialStore(async () => {
    try {
      const loaded = await loadStore();
      const { store } = loaded;
      let changed = pushRecent(store, workspace);
      if (last && store.lastWorkspace !== workspace) {
        store.lastWorkspace = workspace;
        changed = true;
      }
      if (changed) await saveStore(loaded);
      return { ok: true, data: { recentWorkspaces: store.recentWorkspaces.slice() } };
    } catch (err) {
      return { ok: false, error: `could not remember that workspace: ${why(err)}` };
    }
  });
}

// ── documents ───────────────────────────────────────────────────────────────

function documentRevision(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

async function readDocumentFile(file) {
  const stat = await fs.promises.stat(file);
  if (stat.size > DOCUMENT_MAX_BYTES) throw new Error('Documents must be 10 MB or smaller');
  const text = await fs.promises.readFile(file, 'utf8');
  return { text, revision: documentRevision(text), path: file };
}

function documentTextError(text) {
  if (typeof text !== 'string') return 'Document text is required';
  if (Buffer.byteLength(text, 'utf8') > DOCUMENT_MAX_BYTES) return 'Documents must be 10 MB or smaller';
  return null;
}

// Markdown stays in an ordinary file, independent of the canvas JSON, in one folder for
// every board: a document id is a UUID, so moving a board between folders moves no file.
// Removing a node keeps its file: undo, redo and a copied node must still open it.
function createDocument(text = '') {
  const problem = documentTextError(text);
  if (problem) return Promise.resolve({ ok: false, error: problem });
  const id = crypto.randomUUID();
  const file = documentFile(id);
  return serial(file, async () => {
    try {
      await writeAtomic(file, text);
      return { ok: true, data: { id, text, revision: documentRevision(text), path: file } };
    } catch (err) {
      return { ok: false, error: `Could not create the document: ${why(err)}` };
    }
  });
}

function getDocument(id) {
  const file = documentFile(id);
  if (!file) return Promise.resolve({ ok: false, error: 'Invalid document id' });
  return serial(file, async () => {
    try {
      if (!existsSync(file)) {
        // One the migration did not bring (its copy failed, or the run has not got that
        // far) comes in from the old tree the first time a board opens it.
        const old = await legacyDocumentFile(id);
        if (old) await placeCopy(old, file, false);
      }
      return { ok: true, data: { id: id.toLowerCase(), ...await readDocumentFile(file) } };
    } catch (err) {
      return { ok: false, error: err.code === 'ENOENT' ? 'Document file not found' : `Could not read the document: ${why(err)}` };
    }
  });
}

/**
 * Where the old layout kept document `id`, if it still has it: under a workspace folder of
 * `diagrams/` (before the rename) or of the renamed tree store.json names — the places
 * imagePath() looks for a picture. A document id is a UUID, so the first one found is
 * the one; old folders are read in the order the migration reads them. Null when none.
 */
async function legacyDocumentFile(id) {
  const want = id.toLowerCase() + '.md';
  const roots = [LEGACY_DIR];
  const renamed = knownLegacyRoot();
  if (renamed && renamed !== LEGACY_DIR) roots.push(renamed);
  for (const root of roots) {
    let entries;
    try {
      entries = await readdirOrEmpty(path.join(configDir(), root), { withFileTypes: true });
    } catch (_) {
      continue;
    }
    const dirs = entries
      .filter(e => e.isDirectory() && e.name !== 'images' && LEGACY_KEY_RE.test(e.name))
      .map(e => e.name)
      .sort();
    for (const dirName of dirs) {
      const file = path.join(configDir(), root, dirName, 'documents', want);
      if (isFileSync(file)) return file;
    }
  }
  return null;
}

function saveDocument(id, text, revision) {
  const file = documentFile(id);
  const problem = documentTextError(text);
  if (!file || problem || typeof revision !== 'string') {
    return Promise.resolve({ ok: false, error: problem || 'Invalid document id or revision' });
  }
  return serial(file, async () => {
    try {
      const current = await readDocumentFile(file);
      if (current.revision !== revision) {
        return { ok: false, code: 'conflict', error: 'This file changed in another editor. Reload it, or save your version over it.' };
      }
      await writeAtomic(file, text);
      return { ok: true, data: { id: id.toLowerCase(), text, revision: documentRevision(text), path: file } };
    } catch (err) {
      return { ok: false, error: `Could not save the document: ${why(err)}` };
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

/** The old tree's name, from store.json — read once here when nothing has read it yet. */
function knownLegacyRoot() {
  if (legacyRootName === undefined) {
    try {
      const store = cleanStore(JSON.parse(fs.readFileSync(storeFile(), 'utf8')));
      rememberLegacyRoot(store);
    } catch (_) {
      return null;
    }
  }
  return legacyRootName || null;
}

/**
 * The file behind `sbimg://image/<name>`, or null for any name we did not make. A
 * picture the migration could not bring across is still found where it was: in the old
 * `diagrams/images`, or in that tree after its rename.
 */
function imagePath(name) {
  if (typeof name !== 'string' || !IMAGE_FILE_RE.test(name)) return null;
  const file = path.join(imagesDir(), name);
  if (isFileSync(file)) return file;
  const fallbacks = [path.join(configDir(), LEGACY_DIR, 'images', name)];
  const renamed = knownLegacyRoot();
  if (renamed && renamed !== LEGACY_DIR) fallbacks.push(path.join(configDir(), renamed, 'images', name));
  for (const old of fallbacks) {
    if (isFileSync(old)) return old;
  }
  return file;
}

/** Resolve a canvas image address to an existing local file for terminal paste. */
async function getImagePath(src) {
  const match = typeof src === 'string' && /^sbimg:\/\/image\/([0-9a-f]{32}\.(?:png|jpg|webp))$/.exec(src);
  const file = match && imagePath(match[1]);
  if (!file) return { ok: false, error: 'Invalid image address' };
  try {
    if (!(await fs.promises.stat(file)).isFile()) return { ok: false, error: 'Image file not found' };
    return { ok: true, data: file };
  } catch (err) {
    return { ok: false, error: err.code === 'ENOENT' ? 'Image file not found' : `Could not read the image: ${why(err)}` };
  }
}

// ── migration from the per-workspace diagrams ───────────────────────────────

/**
 * Copy every board under `<config dir>/diagrams/<workspace>-<hash>/` into the store,
 * once. index.js calls this before the first window opens (and again from the screen's
 * Try again); nothing calls it at require time.
 *
 * One folder per project (sample-1 and sample-2 share "sample"), each board keeping its
 * id and recording its old workspace as its own, so ✦ Answer reads what it read before.
 * Documents and pictures are copied — pictures hard-linked where the disk allows, so they
 * take no extra space — and the old tree is then renamed `diagrams-before-whiteboards`.
 * Nothing is deleted, and a file that cannot be read stays where it was.
 *
 * Crash-consistent: the folders and the record of the run are written BEFORE any board,
 * each old folder's boards are written before its ids are recorded as imported, and the
 * record is marked finished (`at`) only after the rename. A run that stops anywhere —
 * a full disk, a crash — leaves `at` null, and the next launch picks up where it left
 * off without making a second copy of anything. Only a failed write to boards/ or
 * store.json stops a run; a document or picture that will not copy is counted in
 * `skipped` and left behind — where imagePath() still serves the picture from, and
 * getDocument() copies the document in from the first time a board opens it. A copy
 * lands whole or not at all (placeCopy), so a resumed run never keeps half a file.
 *
 * Answers { boards, folders, skipped, legacyRoot } — `already: true` when an earlier run
 * finished it.
 */
function migrate() {
  return serialStore(async () => {
    let result;
    try {
      result = await runMigration();
    } catch (err) {
      result = { ok: false, error: `could not move the diagrams: ${why(err)}` };
    }
    lastMigrationError = result.ok ? null : result.error;
    if (!result.ok) console.error('[switchboard] whiteboards: migration stopped:', result.error);
    return result;
  });
}

/** Which old folders hold what, and where each board goes — read-only. */
async function surveyLegacy(legacy, migration) {
  let discovered = [];
  try {
    discovered = await workspaces.discover();
  } catch (_) {
    discovered = [];
  }
  if (!Array.isArray(discovered)) discovered = [];
  let declared = [];
  try {
    const cfg = config.get();
    declared = Object.keys((cfg && isObject(cfg.workspaces) && cfg.workspaces) || {});
  } catch (_) {
    declared = [];
  }
  const byId = new Map(discovered.filter(w => w && typeof w.id === 'string').map(w => [w.id, w]));
  const candidates = Array.from(new Set(Array.from(byId.keys()).concat(declared)));

  const imported = new Set(migration ? migration.imported : []);
  const entries = await readdirOrEmpty(legacy, { withFileTypes: true });
  const dirs = entries
    .filter(e => e.isDirectory() && e.name !== 'images' && LEGACY_KEY_RE.test(e.name))
    .map(e => e.name)
    .sort();

  const seenIds = new Set();
  let broken = 0;
  const plan = [];
  for (const dirName of dirs) {
    const stem = LEGACY_KEY_RE.exec(dirName)[1];
    // The hash cannot be inverted, but any id can be checked against it: the stem
    // itself (any plain id is its own stem), then every workspace the rail knows, then
    // every one the config declares — a declared folder that is missing included.
    let matched = null;
    for (const c of [stem].concat(candidates)) {
      if (legacyKeyFor(c) === dirName) { matched = c; break; }
    }
    const wsId = cleanWorkspace(matched);
    const label = wsId || stem;
    const known = wsId ? byId.get(wsId) : null;
    const project = known && typeof known.project === 'string' && known.project ? known.project : workspaces.projectOf(label);
    const folderName = project.replace(/\s+/g, ' ').trim().slice(0, FOLDER_NAME_MAX).trim() || stem.slice(0, FOLDER_NAME_MAX);

    const dir = path.join(legacy, dirName);
    const boards = [];
    const already = [];
    for (const name of (await readdirOrEmpty(dir)).filter(n => /\.json$/.test(n)).sort()) {
      let row;
      try {
        row = JSON.parse(await fs.promises.readFile(path.join(dir, name), 'utf8'));
      } catch (err) {
        if (err && err.code === 'EISDIR') continue;
        row = null;
      }
      if (!isObject(row) || !isUuid(row.id) || typeof row.name !== 'string') {
        console.error('[switchboard] whiteboards: left behind a file that is not a diagram:', path.join(dir, name));
        broken++;
        continue;
      }
      const id = row.id.toLowerCase();
      if (seenIds.has(id)) {
        console.error('[switchboard] whiteboards: left behind a second diagram with the same id:', path.join(dir, name));
        broken++;
        continue;
      }
      seenIds.add(id);
      if (imported.has(id)) continue;
      // Written by a run that stopped before recording it: it is ours, and imported.
      if (existsSync(boardFile(id))) {
        let there = null;
        try { there = await readBoardFile(boardFile(id)); } catch (_) { there = null; }
        if (there && !there.broken && isObject(there.migratedFrom) && there.migratedFrom.legacyKey === dirName) already.push(id);
        continue;
      }
      boards.push({ id, row });
    }
    plan.push({ dirName, dir, stem, wsId, label, folderName, boards, already });
  }
  return { plan, broken };
}

/** The old tree's name after an earlier run renamed it and stopped before saying so. */
function findRenamedLegacy(base) {
  let found = null;
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? LEGACY_RENAMED : `${LEGACY_RENAMED}-${n}`;
    if (!existsSync(path.join(base, name))) break;
    found = name;
  }
  return found;
}

/** Copy one file unless the target is there (placeCopy). False when it could not be copied. */
async function copyIfAbsent(from, to, link) {
  try {
    await placeCopy(from, to, link);
    return true;
  } catch (err) {
    console.error(`[switchboard] whiteboards: could not copy ${from}:`, why(err));
    return false;
  }
}

/**
 * Put a copy of `from` at `to` unless something is there already — whole or not at all.
 * A run resumes by skipping every target that exists, so a copy cut short by a crash must
 * never sit at `to`: the bytes go to a temp file beside it, and only a finished one is
 * linked into place. A link, unlike a rename, refuses a name that is taken, so a file
 * that appeared meanwhile (a document opened and edited) is never replaced. `link` first
 * tries a hard link to `from` itself (pictures: one entry, the whole file, no extra
 * space). Rejects with the reason when it could not be copied.
 */
async function placeCopy(from, to, link) {
  if (existsSync(to)) return;
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  if (link) {
    try {
      await fs.promises.link(from, to);
      return;
    } catch (err) {
      if (err && err.code === 'EEXIST') return;
    }
  }
  const tmp = `${to}.${process.pid}.${++seq}.tmp`;
  try {
    await fs.promises.copyFile(from, tmp, fs.constants.COPYFILE_EXCL);
    try {
      await fs.promises.link(tmp, to);
    } catch (err) {
      if (err && err.code === 'EEXIST') return;
      // A disk without hard links: a rename, which would replace — so only while the
      // name is still free. Documents copy on their own chain, so nothing writes one
      // between this look and the rename.
      if (existsSync(to)) return;
      await fs.promises.rename(tmp, to);
    }
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
}

/** A name for a migration folder no other folder has, whatever its case. */
function uniqueFolderName(store, name) {
  if (!folderNameTaken(store, name, null)) return name;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = name.slice(0, FOLDER_NAME_MAX - suffix.length).trimEnd() + suffix;
    if (!folderNameTaken(store, candidate, null)) return candidate;
  }
}

/** A node list with every AI box that does not say which workspace it read saying `wsId`. */
function backfillAnswers(spec, wsId) {
  if (!wsId || !isObject(spec) || !Array.isArray(spec.nodes)) return spec;
  let changed = false;
  const nodes = spec.nodes.map(node => {
    if (!isObject(node) || node.ai !== true) return node;
    if (typeof node.answeredIn === 'string' && node.answeredIn) return node;
    changed = true;
    return Object.assign({}, node, { answeredIn: wsId });
  });
  return changed ? Object.assign({}, spec, { nodes }) : spec;
}

async function runMigration() {
  const loaded = await loadStore();
  const { store } = loaded;
  const previous = store.migration;
  if (previous && previous.at) {
    return { ok: true, data: { boards: 0, folders: 0, skipped: previous.skipped, legacyRoot: previous.legacyRoot, already: true } };
  }

  const base = configDir();
  const legacy = path.join(base, LEGACY_DIR);
  if (!isDirSync(legacy)) {
    if (previous && previous.from === 'diagrams') {
      // A run renamed the old tree and stopped before it could record that: finish it.
      return finishMigration(loaded, findRenamedLegacy(base), previous.skipped);
    }
    store.migration = { from: null, at: now(), imported: [], folders: {}, skipped: 0, legacyRoot: null, error: null };
    await saveStore(loaded);
    return { ok: true, data: { boards: 0, folders: 0, skipped: 0, legacyRoot: null } };
  }

  const m = Object.assign({ from: 'diagrams', at: null, imported: [], folders: {}, skipped: 0, legacyRoot: null, error: null },
    previous || {}, { from: 'diagrams', at: null, error: null });
  m.imported = m.imported.slice();
  m.folders = Object.assign({}, m.folders);
  store.migration = m;

  const { plan, broken } = await surveyLegacy(legacy, m);
  let skipped = broken;

  // (a) Every folder that will receive a board, and the record of this run, BEFORE any
  // board is written — so a board on disk always names a folder that exists.
  const ours = () => new Set(Object.values(m.folders));
  for (const item of plan) {
    if (!item.boards.length) continue;
    const mapped = m.folders[item.dirName];
    if (mapped && folderById(store, mapped)) continue;
    const want = item.folderName.toLowerCase();
    const mine = ours();
    const sibling = store.folders.find(f => mine.has(f.id) && f.name.toLowerCase() === want);
    if (sibling) {
      m.folders[item.dirName] = sibling.id;
      continue;
    }
    const folder = { id: crypto.randomUUID(), name: uniqueFolderName(store, item.folderName), createdAt: now(), moved: true };
    store.folders.push(folder);
    m.folders[item.dirName] = folder.id;
  }
  m.skipped = skipped;
  await saveStore(loaded);

  // (b) Each old folder's boards, then its documents, then the record of its ids.
  const names = new Map();      // folderId → names already in it
  for (const item of plan) {
    const folderId = item.boards.length || item.already.length ? effectiveFolder(store, m.folders[item.dirName]) : null;
    const written = [];
    if (item.boards.length) {
      if (!names.has(folderId)) names.set(folderId, await namesIn(store, folderId));
      const taken = names.get(folderId);
      const tag = item.label.slice(0, 40);
      for (const { id, row } of item.boards) {
        const clean = cleanName(row.name);
        const base = clean.value || (clean.error === 'Name is required' ? 'Untitled whiteboard' : row.name.trim().replace(/\s+/g, ' ').slice(0, NAME_MAX).trim());
        let name = base;
        if (taken.has(name)) {
          name = fitName(base, ` (${tag})`);
          for (let n = 2; taken.has(name); n++) name = fitName(base, ` (${tag}) ${n}`);
        }
        taken.add(name);
        const at = now();
        const created = typeof row.createdAt === 'string' && row.createdAt ? row.createdAt : at;
        const out = Object.assign({}, row, {
          id,
          name,
          kind: 'flow',
          folderId,
          workspace: item.wsId,
          createdAt: created,
          updatedAt: typeof row.updatedAt === 'string' && row.updatedAt ? row.updatedAt : created,
          archivedAt: typeof row.archivedAt === 'string' && row.archivedAt ? row.archivedAt : null,
          migratedFrom: { legacyKey: item.dirName, workspace: item.wsId },
          spec: backfillAnswers(row.spec, item.wsId),
        });
        try {
          await writeRow(out);
        } catch (err) {
          return { ok: false, error: `could not move “${name}”: ${why(err)}` };
        }
        written.push(id);
      }
    }
    for (const doc of (await readdirOrEmpty(path.join(item.dir, 'documents'))).filter(n => DOCUMENT_FILE_RE.test(n))) {
      // On the document's own chain, as getDocument() may be copying the same one in.
      const to = path.join(documentsDir(), doc.toLowerCase());
      const ok = await serial(to, () => copyIfAbsent(path.join(item.dir, 'documents', doc), to, false));
      if (!ok) skipped++;
    }
    const add = written.concat(item.already).filter(id => m.imported.indexOf(id) === -1);
    if (add.length || m.skipped !== skipped) {
      m.imported = m.imported.concat(add);
      m.skipped = skipped;
      await saveStore(loaded);
    }
  }

  // (d) Pictures, all of them, shared by every board.
  for (const name of (await readdirOrEmpty(path.join(legacy, 'images'))).filter(n => IMAGE_FILE_RE.test(n))) {
    const ok = await copyIfAbsent(path.join(legacy, 'images', name), path.join(imagesDir(), name), true);
    if (!ok) skipped++;
  }

  // (e) Retire the old tree — renamed, never deleted — and only then say it is done.
  let legacyRoot = LEGACY_DIR;
  let target = null;
  for (let n = 1; n < 1000 && !target; n++) {
    const name = n === 1 ? LEGACY_RENAMED : `${LEGACY_RENAMED}-${n}`;
    if (!existsSync(path.join(base, name))) target = name;
  }
  if (target) {
    try {
      await fs.promises.rename(legacy, path.join(base, target));
      legacyRoot = target;
    } catch (err) {
      console.error('[switchboard] whiteboards: could not rename the old diagrams folder:', why(err));
    }
  }
  return finishMigration(loaded, legacyRoot, skipped);
}

/** Mark the migration finished, with its notice and the workspaces it brought. */
async function finishMigration(loaded, legacyRoot, skipped) {
  const { store } = loaded;
  const m = store.migration;
  const imported = new Set(m.imported);
  const moved = (await boardSummaries()).filter(s => imported.has(s.id));
  const folders = new Set(moved.map(s => effectiveFolder(store, s.folderId)).filter(Boolean));

  // A new board starts with the workspace used last: before anyone has used one, that is
  // the workspace of the most recently edited migrated board — among those still on the
  // rail. A board whose workspace has gone keeps it (its ✦ Answer says so), but a gone
  // workspace is no start for a new board and no recent pick.
  const rail = await railIds();
  const newest = new Map();
  for (const s of moved) {
    if (!s.workspace || (rail && !rail.has(s.workspace))) continue;
    const at = String(s.updatedAt || '');
    if (!newest.has(s.workspace) || newest.get(s.workspace) < at) newest.set(s.workspace, at);
  }
  const seeded = Array.from(newest.keys()).sort((a, b) => newest.get(b).localeCompare(newest.get(a)));
  store.recentWorkspaces = Array.from(new Set(store.recentWorkspaces.concat(seeded))).slice(0, RECENT_MAX);
  if (!store.lastWorkspace && seeded.length) store.lastWorkspace = seeded[0];

  m.at = now();
  m.legacyRoot = cleanLegacyRoot(legacyRoot);
  m.skipped = skipped;
  m.error = null;
  if (moved.length || skipped) store.notice = { boards: moved.length, folders: folders.size, dismissed: false };
  await saveStore(loaded);
  emit('notice');
  return { ok: true, data: { boards: moved.length, folders: folders.size, skipped, legacyRoot: m.legacyRoot } };
}

/** Every write that has been started has finished — the quit path waits on this. */
function settle() {
  return Promise.all(Array.from(chains.values())).then(() => ({ ok: true }), () => ({ ok: true }));
}

module.exports = {
  list,
  get,
  create,
  saveSpec,
  rename,
  setWorkspace,
  move,
  duplicate,
  setArchived,
  remove,
  conversation,
  conversations,
  setConversation,
  createFolder,
  renameFolder,
  removeFolder,
  dismissNotice,
  noteWorkspace,
  workspaceChoices,
  createDocument,
  getDocument,
  saveDocument,
  saveImage,
  imagePath,
  getImagePath,
  migrate,
  settle,
  onChange,
  IMAGE_TYPES,
  // For the tests, and for a sentence that has to name the folder.
  rootDir,
  legacyKeyFor,
};
