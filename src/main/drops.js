'use strict';

// Files that reach a terminal by drop or by paste — ARCHITECTURE §4.6 (R8) and §4.7.
// Everything here answers one question: what should the terminal type at the cursor?
// The answer is always a path, because a path is all "put an image into Claude Code"
// ever was: Claude reads the image from it, exactly as after a Finder drop on iTerm2.
//
// Three kinds of File reach the drop handler, and only the first is a file on disk:
//
//   1. A Finder drop — a path that exists. Type it.
//   2. A File built in memory — an image dragged out of a browser. No path, but the
//      renderer can read its bytes; they are written under the paste folder and that
//      path is typed.
//   3. A file PROMISE — an unsaved macOS screenshot dragged off its floating thumbnail
//      (⇧⌘4, then drag the corner preview). The drag advertises a file URL plus the PNG
//      bytes as "promised content". Chromium 152 keeps the file URL and drops the bytes
//      (web_drag_dest_mac.mm, test FileURLAndFilePromiseContentDoNotDuplicate), and it
//      never fulfils a promise. The URL is the screenshot tool's OWN temporary copy —
//      $TMPDIR/TemporaryItems/NSIRD_screencaptureui_<random>/Screenshot ….png. It exists
//      at the moment of the drop, which is why existence is no test, and it is useless
//      to everyone else: that folder is unreadable to other processes (`zsh: permission
//      denied` on the typed path, and `ls` of TemporaryItems is "Operation not
//      permitted"), and it is deleted when the thumbnail goes. Typed as-is it is a
//      dead path and Claude Code sees text, not an image (observed 2026-09-20: six
//      drops, six such paths). The bytes are still on the macOS drag pasteboard.
//      Electron's clipboard module cannot read that (no drag buffer in the six-method
//      API), but /usr/bin/osascript's JavaScript can, in ~90 ms. So main SNAPSHOTS the
//      drag pasteboard the moment a drag enters a pane — while the drag is live and its
//      source still holds the data; the pasteboard can be cleared by the time the DOM
//      drop event has crossed IPC — and the drop types the snapshot's files, in
//      preference to any path, whenever the drag carried promised content at all.
//
// The Desktop-file-vs-thumbnail distinction the user sees is exactly (1) vs (3): let the
// thumbnail expire and the screenshot is a real file on the Desktop.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// A backslash before whitespace and every shell metacharacter, never quotes — the
// identical rule to views/terminal.js's shellEscape, so every path the terminal types
// is typed the same way, and the form Claude Code's "that pasted text is a path to an
// image" detection was built against (it is what Terminal.app and iTerm2 type).
function shellEscapePath(p) {
  return String(p).replace(/[\s'"\\$&|;<>()*?[\]{}!#~^`]/g, c => '\\' + c);
}

// Where pasted and rescued images land. Its own directory so old ones can be pruned
// without touching anything else in the temp folder; macOS clears it eventually anyway.
function pasteDir() {
  const dir = path.join(os.tmpdir(), 'switchboard-pastes');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Best-effort prune so a long-lived session does not leave a pile of screenshots:
// anything older than a day, and never a failure the caller has to care about.
function prunePastes(dir) {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try { if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true }); } catch (_) { /* leave it */ }
    }
  } catch (_) { /* the directory not existing is fine */ }
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch (_) { return false; }
}

// A file name a path can be built from: the base name alone, path separators and
// control characters out, and `fallback` when nothing is left.
function safeName(name, fallback) {
  let base = path.basename(String(name == null ? '' : name)).replace(/[\u0000-\u001f\u007f/]/g, '').trim();
  if (!base || base === '.' || base === '..') base = fallback;
  return base;
}

// A path under `dir` nothing else holds: `name`, else name-2, name-3, … before the
// extension. Two screenshots cannot share a name (they carry the second), but a file
// dropped twice must not overwrite the one Claude may still be reading.
function freePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${stem}-${i}${ext}`);
  return candidate;
}

// Writes `bytes` under the paste folder as `name` and answers the file's path, '' when
// it could not be written.
function savePaste(bytes, name) {
  const dir = pasteDir();
  prunePastes(dir);
  const file = freePath(dir, safeName(name, `pasted-${Date.now()}.png`));
  try { fs.writeFileSync(file, bytes); } catch (_) { return ''; }
  return file;
}

// What structured cloning made of the renderer's Uint8Array, as a Buffer; null when it
// is not bytes at all.
function toBuffer(bytes) {
  if (!bytes) return null;
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return null;
}

// ── the drag pasteboard ─────────────────────────────────────────────────────────

// Run by /usr/bin/osascript -l JavaScript with the paste folder as its one argument.
// Writes every promised file the drag pasteboard holds into that folder and prints
// `count <changeCount>` then one written path per line. Chromium's own rule, mirrored:
// an item's promised content type first (com.apple.pasteboard.promised-file-content-type
// names the UTI its bytes sit under); failing that, an image type — but only on an item
// with no file URL, because a Finder drag carries its file's URL and its icon, and the
// icon is not the file. Read-only where it matters: the pasteboard is never cleared.
const DRAG_READER = `
ObjC.import('Foundation');
ObjC.import('AppKit');
function run(argv) {
  var dir = argv[0];
  var exts = { 'public.png': 'png', 'public.jpeg': 'jpg', 'public.tiff': 'tiff', 'public.heic': 'heic',
               'com.compuserve.gif': 'gif', 'org.webmproject.webp': 'webp', 'com.microsoft.bmp': 'bmp' };
  var pb = $.NSPasteboard.pasteboardWithName($.NSPasteboardNameDrag);
  var count = pb.changeCount;
  var items = pb.pasteboardItems;
  var n = items.isNil() ? 0 : items.count;
  var out = ['count ' + count];
  for (var i = 0; i < n; i++) {
    var item = items.objectAtIndex(i);
    var types = ObjC.deepUnwrap(item.types) || [];
    var promised = item.stringForType('com.apple.pasteboard.promised-file-content-type');
    var uti = promised.isNil() ? '' : String(ObjC.unwrap(promised));
    if (!uti || types.indexOf(uti) < 0) {
      uti = '';
      if (types.indexOf('public.file-url') < 0) {
        for (var k = 0; k < types.length; k++) { if (exts[types[k]]) { uti = types[k]; break; } }
      }
    }
    if (!uti) continue;
    var data = item.dataForType(uti);
    if (data.isNil() || !data.length) continue;
    var ext = exts[uti] || '';
    if (!ext) {
      try {
        ObjC.import('UniformTypeIdentifiers');
        var t = $.UTType.typeWithIdentifier(uti);
        if (!t.isNil() && !t.preferredFilenameExtension.isNil()) ext = String(ObjC.unwrap(t.preferredFilenameExtension));
      } catch (_) { ext = ''; }
    }
    var file = dir + '/drag-' + count + '-' + i + (ext ? '.' + ext : '');
    if (data.writeToFileAtomically(file, true)) out.push(file);
  }
  return out.join('\\n');
}`;

// The promised files on the drag pasteboard right now, written under the paste folder;
// [] when there are none, on any failure, and off macOS.
function readDragPasteboard() {
  if (process.platform !== 'darwin') return Promise.resolve([]);
  const dir = pasteDir();
  prunePastes(dir);
  return new Promise(resolve => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', DRAG_READER, dir],
      { timeout: 5000, maxBuffer: 1 << 20 }, (err, stdout) => {
        if (err) { console.error('[switchboard] drag pasteboard:', err.message); return resolve([]); }
        const files = String(stdout || '').split('\n').map(s => s.trim())
          .filter(line => line.startsWith(dir + path.sep) && isFile(line));
        resolve(files);
      });
  });
}

// The one snapshot in flight or just taken. dragenter fires again and again as a drag
// crosses the pane's children — and, in the Grid, once per square it passes — so a
// snapshot younger than a moment is reused rather than retaken; a fresh drag cannot
// start inside that window.
const SNAPSHOT_REUSE_MS = 1500;
// A drop long after the drag entered is still that drag: the user hovered. Longer than
// this and the snapshot is stale — some other drag's, or none.
const SNAPSHOT_MAX_AGE_MS = 60 * 1000;
let snapshot = null;   // { at, promise: Promise<string[]> }

// The renderer's dragenter. Answers once the pasteboard has been read, though the
// renderer need not wait for that: the drop waits instead.
function dragBegan() {
  if (snapshot && Date.now() - snapshot.at < SNAPSHOT_REUSE_MS) return snapshot.promise;
  snapshot = { at: Date.now(), promise: readDragPasteboard().catch(() => []) };
  return snapshot.promise;
}

// The promised files of the drag now dropping: its dragenter's snapshot, consumed so
// the next drag takes its own; without one (a drop with no dragenter seen), the
// pasteboard as it is now, which may already be empty.
async function draggedFiles() {
  const current = snapshot && Date.now() - snapshot.at < SNAPSHOT_MAX_AGE_MS ? snapshot : null;
  snapshot = null;
  const files = current ? await current.promise : await readDragPasteboard().catch(() => []);
  return files.filter(isFile);
}

// Gives a rescued file the name the drop called it, in the paste folder — the name
// Claude Code shows — keeping the rescued file's extension when the name has none.
function claim(file, name) {
  let wanted = safeName(name, '');
  if (!wanted) return file;
  if (!path.extname(wanted)) wanted += path.extname(file);
  const target = freePath(path.dirname(file), wanted);
  try { fs.renameSync(file, target); return target; } catch (_) { return file; }
}

// ── what a drop types ──────────────────────────────────────────────────────────

// `entries` is the renderer's account of a drop's Files: [{ path, name, type, bytes? }],
// `path` from webUtils.getPathForFile ('' for a File with none) and `bytes` the File's
// contents when it had no path. Answers the text to paste: every file's escaped path,
// space-separated, a space after the last so the user can go on typing; '' when the
// drop carried no file. The drag's promised files come first, one per entry in order,
// each renamed to what the drop called it: when the pasteboard carried promised
// content, the path beside it is the promise's own copy, which exists now and is gone
// or unreadable by the time anything opens it (see the header). A Finder drag promises
// nothing, so its paths are typed as they are; a File with bytes and no path is written
// and its path typed; and a path that exists nowhere, with nothing rescued for it, is
// typed as it is, which is no worse than before.
async function droppedFiles(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const out = [];
  const promised = list.length ? await draggedFiles() : [];
  for (const entry of list) {
    const p = entry && typeof entry.path === 'string' ? entry.path : '';
    const name = entry && typeof entry.name === 'string' ? entry.name : '';
    if (promised.length) {
      out.push(shellEscapePath(claim(promised.shift(), name || path.basename(p))));
      continue;
    }
    if (p && isFile(p)) { out.push(shellEscapePath(p)); continue; }
    const bytes = toBuffer(entry && entry.bytes);
    if (bytes && bytes.length) {
      const file = savePaste(bytes, name || `dropped-${Date.now()}`);
      if (file) { out.push(shellEscapePath(file)); continue; }
    }
    if (p) out.push(shellEscapePath(p));
  }
  return out.length ? out.join(' ') + ' ' : '';
}

module.exports = { shellEscapePath, pasteDir, prunePastes, savePaste, dragBegan, droppedFiles, readDragPasteboard };
