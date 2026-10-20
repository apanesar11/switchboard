'use strict';

// sheets.js — a spreadsheet on a whiteboard, read for the panel that shows it.
// ARCHITECTURE §4.17.
//
// A "sheet" node names a file whiteboards.js kept (files/<sha>.<ext>). Opening it asks
// main for the file's sheets, then for their rows a page at a time as the grid scrolls,
// and for the cells a search finds — index.js's sb:diagrams:sheet* handlers, which hand
// this module the kept file's path. Reading the file is the expensive part and the
// dangerous one — a 50 MB workbook can unpack to gigabytes, and a hostile one is built
// to — so it never happens on main's thread:
//   * Each file is read once, in a worker thread (sheet-worker.js) with a heap of its own,
//     capped, and a minute to finish. A worker that runs out of memory dies alone, one
//     that takes too long — a huge file, or a damaged one SheetJS goes round in circles
//     on — is terminated, and either way the panel is told so in a sentence ("That
//     spreadsheet is too big to show here"), beside its Open in … button.
//   * The heap cap doesn't count the Buffers a zip's parts are unpacked into, and every
//     format but CSV, TSV and .xls is a zip. So a zip is looked through before SheetJS
//     sees it, and refused when its parts would unpack to more than 1 GB (zipProblem);
//     main stops a worker that grows the app by 2 GB all the same; and one worker runs at
//     a time, the others waiting their turn.
//   * What comes back is packed: each sheet's cells as ONE string, with the offsets where
//     each cell and each row starts in Uint32Arrays that are transferred, not copied.
//     Cloning two million little strings across threads would cost main the very pause
//     the worker is there to spare it.
//   * The last three workbooks read are kept, by file — a kept file's name is its
//     content's hash, so a kept workbook is never stale — and two asks for one file while
//     it is being read share the one read.
//
// Excel's formats, OpenDocument and Numbers are read with SheetJS (the `xlsx` package —
// in the worker only; main never loads it), each cell's text as Excel shows it
// ("1,234.50", "25%", "1/13/26"). CSV and TSV are read here: parseDelimited() is RFC
// 4180, decodeText() reads the encodings spreadsheet apps write, and a CSV from a
// comma-decimal locale, which separates with `;`, is told apart by its first line.
//
// Limits, past which a sheet stops short and says so (`truncated`): 100,000 rows a sheet,
// 2,000,000 cells and 64M characters a workbook. A cell stops at 32,767 characters,
// Excel's own limit, and its sheet says that apart (`clipped`), since every row is still
// there. Rows and columns keep their places: a sheet whose first cell is C5 starts with
// four empty rows and two empty columns, so a cell's reference reads as it does in Excel.
// Each row ends at its last cell with text, and the sheet at its last row with any.
//
// Nothing throws: info(), rows() and find() resolve to { ok: true, data } or
// { ok: false, error: '<human sentence>' }. The rest is pure and loads nothing, so
// scripts/test-sheets.js runs it under plain node and sheet-worker.js runs readBook()
// (a promise: a zip's streamed parts are measured as a stream).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROW_LIMIT = 100000;
const CELL_LIMIT = 2000000;
// Characters, across a workbook: a few thousand shared strings of Excel's longest can
// fill two million cells, which no file size would have warned of.
const TEXT_LIMIT = 64 * 1024 * 1024;
const CELL_CHARS = 32767;
// What the panel may ask for at once — lib/bridge.ts says the same.
const ROWS_MAX = 500;
const FIND_MAX = 1000;
const QUERY_MAX = 200;
const CACHE_MAX = 3;
const SHEET_EXTENSIONS = new Set(['xlsx', 'xlsm', 'xlsb', 'xls', 'ods', 'numbers', 'csv', 'tsv']);
// A CSV or a TSV is one sheet; Excel names it after the file, which main doesn't know.
const DELIMITED_SHEET = 'Sheet1';

const TOO_BIG = 'That spreadsheet is too big to show here';
const TOO_SLOW = 'That spreadsheet took too long to read';
const UNREADABLE = "That spreadsheet can't be read here";
const LOCKED = 'That spreadsheet is protected with a password';
const MISSING = 'That file is no longer on this Mac';
const NOT_A_SHEET = "That isn't a spreadsheet";
// A zip ends with its directory, whose record starts with this, within its last 64 KB
// and 22 bytes (the record, and the longest comment it may carry).
const ZIP_END = Buffer.from('504b0506', 'hex');
const ZIP_END_WITHIN = 65535 + 22;
// The most a zip may unpack to. SheetJS unpacks every part of one before it reads a
// cell, each into a Buffer of its own — memory outside the worker's heap, which its cap
// never counts — so a zip bomb, a few megabytes that unpack to gigabytes, would grow the
// app itself. More than this is more than SheetJS could read anyway: it reads a sheet's
// XML as one string, and V8's longest string is half a gigabyte.
const UNPACKED_LIMIT = 1024 * 1024 * 1024;

// Where the worker is, the most memory it may use and the longest it may take. A plain
// path beside this file: the app is packaged without an asar (scripts/package.js), so
// the worker is a real file there too. The heap cap counts only the worker's JavaScript
// objects, not the Buffers SheetJS unpacks into, so main also watches the whole app's
// memory every `pollMs` while a worker runs, and stops it past `growthMb` more than when
// it started. The tests swap these (setOptions).
const DEFAULTS = {
  workerFile: path.join(__dirname, 'sheet-worker.js'),
  heapMb: 1536,
  timeoutMs: 60 * 1000,
  growthMb: 2048,
  pollMs: 250,
};
let options = Object.assign({}, DEFAULTS);

// Windows-1252's 0x80–0x9F, which Latin-1 leaves as control characters: the curly quotes,
// dashes, € and the rest an older Excel's CSV is full of. The five it leaves undefined
// stay as they were.
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
].map(code => String.fromCharCode(code));

const cache = new Map();           // `${ext}:${file}` → a packed workbook, least recent first
const reading = new Map();         // the same key → the read in flight
const queue = [];                  // reads waiting for the worker that is running, oldest first
let busy = false;                  // whether a worker is running

// ── text ────────────────────────────────────────────────────────────────────

/**
 * A CSV's or a TSV's bytes as text: UTF-8 (its BOM dropped), UTF-16 in either byte
 * order when a BOM says so, and otherwise — bytes that are not UTF-8 at all — Windows-
 * 1252, what Excel on Windows writes for "CSV" and every Mac app reads it as.
 */
function decodeText(buf) {
  let b;
  try {
    b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  } catch (_) {
    return '';
  }
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.toString('utf8', 3);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.toString('utf16le', 2, 2 + ((b.length - 2) & ~1));
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    // Node reads UTF-16 one way round only, so a big-endian file is turned round first.
    return Buffer.from(b.subarray(2, 2 + ((b.length - 2) & ~1))).swap16().toString('utf16le');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b);
  } catch (_) {
    return b.toString('latin1').replace(/[\x80-\x9f]/g, ch => CP1252_HIGH[ch.charCodeAt(0) - 0x80]);
  }
}

/**
 * A CSV's delimiter, from its first line: `;` when that line has more semicolons than
 * commas outside quotes — a CSV written where a comma is the decimal point — else `,`.
 */
function csvDelimiter(text) {
  const s = String(text == null ? '' : text);
  let commas = 0;
  let semicolons = 0;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 34) quoted = !quoted;                 // a doubled quote flips twice
    else if (quoted) continue;
    else if (c === 10 || c === 13) break;
    else if (c === 44) commas++;
    else if (c === 59) semicolons++;
  }
  return semicolons > commas ? ';' : ',';
}

/**
 * Delimited text → { rows, truncated }: RFC 4180, as spreadsheet apps read it. A field
 * in double quotes may hold the delimiter, line breaks and "" for a quote; text after
 * its closing quote is kept, and a quote that never closes runs to the end. Records end
 * at CRLF, CR or LF, and a final line break makes no empty last record. `delim` is one
 * character — the CSV's own (csvDelimiter) when it isn't given.
 *
 * Each row ends at its last field with text. `limits` — { rows, cells }, the cells
 * counted that way — stops the read at the first row that would pass one, `truncated`
 * then true; empty rows past the row limit don't count, so a file's trailing blank lines
 * never make it look cut short.
 */
function parseDelimited(text, delim, limits) {
  const s = String(text == null ? '' : text);
  const sep = typeof delim === 'string' && delim.length === 1 ? delim.charCodeAt(0) : csvDelimiter(s).charCodeAt(0);
  const maxRows = limits && Number.isFinite(limits.rows) ? limits.rows : Infinity;
  const maxCells = limits && Number.isFinite(limits.cells) ? limits.cells : Infinity;
  const n = s.length;
  const rows = [];
  let row = [];
  let cells = 0;
  let truncated = false;
  let i = 0;
  // Where the unquoted text from `j` ends: the delimiter, a line break, or the end.
  const fieldEnd = j => {
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === sep || c === 10 || c === 13) break;
      j++;
    }
    return j;
  };
  // A row is done: trimmed, counted, kept — false when a limit stops the read.
  const commit = () => {
    let end = row.length;
    while (end > 0 && row[end - 1] === '') end--;
    row.length = end;
    if (rows.length >= maxRows) {
      if (end === 0) { row = []; return true; }
      truncated = true;
      return false;
    }
    if (cells + end > maxCells) {
      truncated = true;
      return false;
    }
    cells += end;
    rows.push(row);
    row = [];
    return true;
  };
  while (i < n) {
    let field;
    if (s.charCodeAt(i) === 34) {
      field = '';
      let from = ++i;
      for (;;) {
        const q = s.indexOf('"', i);
        if (q === -1) { field += s.slice(from); i = n; break; }
        if (s.charCodeAt(q + 1) === 34) { field += s.slice(from, q + 1); i = q + 2; from = i; continue; }
        field += s.slice(from, q);
        i = q + 1;
        break;
      }
      const end = fieldEnd(i);
      field += s.slice(i, end);
      i = end;
    } else {
      const end = fieldEnd(i);
      field = s.slice(i, end);
      i = end;
    }
    row.push(field);
    if (i >= n) break;
    const c = s.charCodeAt(i);
    if (c === sep) {
      i++;
      // A delimiter at the very end leaves one more, empty, field.
      if (i >= n) row.push('');
      continue;
    }
    i += c === 13 && s.charCodeAt(i + 1) === 10 ? 2 : 1;
    if (!commit()) return { rows, truncated };
  }
  if (row.length && !commit()) return { rows, truncated };
  return { rows, truncated };
}

/**
 * A SheetJS cell's text as Excel shows it: its formatted text (`w`), else its value,
 * else nothing — a formula saved without its result has neither.
 */
function cellText(cell) {
  if (cell == null) return '';
  if (typeof cell !== 'object') return String(cell);
  if (cell.w != null) return String(cell.w);
  return cell.v == null ? '' : String(cell.v);
}

// ── packing ─────────────────────────────────────────────────────────────────

/** A field of parseDelimited's, as a cell's text. */
function plainText(value) {
  return value == null ? '' : String(value);
}

/**
 * One sheet's rows → { name, rows, cols, truncated, clipped, text, offsets, rowStart }:
 * every cell's text end to end in `text`, cell c being text.slice(offsets[c],
 * offsets[c + 1]), and row r's cells being rowStart[r] up to rowStart[r + 1]. `source`
 * is an array of rows, each an array of cells read with `textOf`; either may have holes.
 * `budget` — { cells, chars, full } — is the workbook's, shared by its sheets: a sheet
 * that would pass it stops at the row before, and sets `full` for the sheets after it.
 * `truncated` is rows left out — `cut`, rows the reader already left out, or this
 * sheet's limits — and `clipped` a cell kept cut short.
 */
function packSheet(name, source, textOf, budget, cut) {
  const parts = [];
  const offsets = [0];
  const rowStart = [0];
  let chars = 0;
  let cols = 0;
  let filled = 0;                  // rows up to the last one with any text
  let truncated = !!cut;
  let clipped = false;
  const list = Array.isArray(source) ? source : [];
  for (let r = 0; r < list.length; r++) {
    const row = list[r];
    const texts = [];
    let end = 0;
    let length = 0;
    let shortened = false;
    if (row && typeof row.length === 'number') {
      for (let c = 0; c < row.length; c++) {
        let t = textOf(row[c]);
        if (t.length > CELL_CHARS) { t = t.slice(0, CELL_CHARS); shortened = true; }
        texts.push(t);
        if (t !== '') { end = c + 1; length += t.length; }
      }
    }
    if (r >= ROW_LIMIT) {
      if (end === 0) continue;
      truncated = true;
      break;
    }
    if (budget.cells + end > CELL_LIMIT || budget.chars + length > TEXT_LIMIT) {
      truncated = true;
      budget.full = true;
      break;
    }
    for (let c = 0; c < end; c++) {
      parts.push(texts[c]);
      chars += texts[c].length;
      offsets.push(chars);
    }
    budget.cells += end;
    budget.chars += length;
    if (shortened) clipped = true;
    rowStart.push(parts.length);
    if (end > 0) {
      filled = r + 1;
      if (end > cols) cols = end;
    }
  }
  rowStart.length = filled + 1;
  return {
    name: String(name),
    rows: filled,
    cols,
    truncated,
    clipped,
    text: parts.join(''),
    offsets: Uint32Array.from(offsets),
    rowStart: Uint32Array.from(rowStart),
  };
}

/** A sheet left out because the workbook's budget was spent before it: every row cut. */
function emptySheet(name) {
  return { name: String(name), rows: 0, cols: 0, truncated: true, clipped: false, text: '', offsets: Uint32Array.of(0), rowStart: Uint32Array.of(0) };
}

// ── zips ────────────────────────────────────────────────────────────────────

/**
 * How much `data`, raw deflate, unpacks to — counted a megabyte at a time and let go of,
 * never held whole — stopping once that is more than `room`. Raw inflate ends where the
 * stream does, whatever follows it; data that isn't deflate, or stops short, rejects.
 */
function inflatedSize(data, room) {
  return new Promise((resolve, reject) => {
    const inflate = zlib.createInflateRaw({ chunkSize: 1024 * 1024 });
    let size = 0;
    inflate.on('data', chunk => {
      size += chunk.length;
      if (size > room) {
        inflate.destroy();
        resolve(size);
      }
    });
    inflate.on('end', () => resolve(size));
    inflate.on('error', reject);
    inflate.end(data);
  });
}

/**
 * The sizes a zip's ZIP64 extra field (0x0001) gives — { usz, csz } — or null when the
 * extra fields hold none: read as SheetJS reads them, the last such field winning and a
 * byte past the fields' end reading as 0.
 */
function zip64Sizes(extra) {
  const word = at => {
    let value = 0;
    for (let b = 3; b >= 0; b--) value = value * 256 + (extra[at + b] || 0);
    return value;
  };
  let sizes = null;
  for (let at = 0; at <= extra.length - 4; at += 4 + extra.readUInt16LE(at + 2)) {
    if (extra.readUInt16LE(at) === 0x0001) {
      sizes = { usz: word(at + 8) * 2 ** 32 + word(at + 4), csz: word(at + 16) * 2 ** 32 + word(at + 12) };
    }
  }
  return sizes;
}

/**
 * Why SheetJS shouldn't be handed this zip — UNREADABLE, TOO_BIG — or null. A zip with
 * no directory at its end is cut short or isn't one, and SheetJS can spin on one for good
 * (measured: a header and a few bytes of nonsense). Otherwise its parts are added up the
 * way SheetJS unpacks them (its parse_zip and parse_local_file): every entry the directory
 * lists, in order, each by its own header's size — which a ZIP64 field there overrides,
 * and, when that header has extra fields at all, the directory's after it. A deflated
 * part that gives no size, one written as a stream, SheetJS lets grow for as long as its
 * data goes on, so it is unpacked here to measure it, natively, as a stream, and never
 * past what is left of UNPACKED_LIMIT. A stored part is read where it lies and costs
 * nothing. A header outside the file, an
 * encrypted part, a method SheetJS doesn't know or a stream that doesn't inflate would
 * stop SheetJS too, and stops it here first. `limit` is for the tests.
 */
async function zipProblem(buf, limit = UNPACKED_LIMIT) {
  if (!buf.subarray(Math.max(0, buf.length - ZIP_END_WITHIN)).includes(ZIP_END)) return UNREADABLE;
  try {
    const end = buf.lastIndexOf(ZIP_END);
    // SheetJS counts the entries on "this disk" — every one, in a zip that is one file.
    const count = buf.readUInt16LE(end + 8);
    let entry = buf.readUInt32LE(end + 16);
    let total = 0;
    for (let i = 0; i < count; i++) {
      const nameLength = buf.readUInt16LE(entry + 28);
      const extraLength = buf.readUInt16LE(entry + 30);
      const commentLength = buf.readUInt16LE(entry + 32);
      const local = buf.readUInt32LE(entry + 42);
      const listed = zip64Sizes(buf.subarray(entry + 46 + nameLength, entry + 46 + nameLength + extraLength));
      entry += 46 + nameLength + extraLength + commentLength;

      const flags = buf.readUInt16LE(local + 6);
      const method = buf.readUInt16LE(local + 8);
      let size = buf.readUInt32LE(local + 22);
      const ownExtra = buf.readUInt16LE(local + 28);
      const extraStart = local + 30 + buf.readUInt16LE(local + 26);
      const data = extraStart + ownExtra;
      if (flags & 0x2041) return UNREADABLE;
      if (method === 0) continue;
      if (method !== 8) return UNREADABLE;
      if (ownExtra) {
        const own = zip64Sizes(buf.subarray(extraStart, data));
        if (own && own.usz) size = own.usz;
        if (listed && listed.usz) size = listed.usz;
      }
      if (!size) size = await inflatedSize(buf.subarray(data), limit - total);
      total += size;
      if (total > limit) return TOO_BIG;
    }
    return null;
  } catch (_) {
    // A read outside the file, or a stream that isn't one.
    return UNREADABLE;
  }
}

/**
 * A spreadsheet's bytes → a promise of { ok: true, format, sheets } (packSheet's shape,
 * each) or { ok: false, error }. The worker's whole job; a test calls it directly.
 */
async function readBytes(bytes, ext) {
  if (!SHEET_EXTENSIONS.has(ext)) return { ok: false, error: NOT_A_SHEET };
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const budget = { cells: 0, chars: 0, full: false };
  if (ext === 'csv' || ext === 'tsv') {
    const text = decodeText(buf);
    const parsed = parseDelimited(text, ext === 'tsv' ? '\t' : csvDelimiter(text), { rows: ROW_LIMIT, cells: CELL_LIMIT });
    return { ok: true, format: ext, sheets: [packSheet(DELIMITED_SHEET, parsed.rows, plainText, budget, parsed.truncated)] };
  }
  // What SheetJS takes for a zip (XLSX.read's own test, whatever the extension) is looked
  // through first: one that is cut short, or would unpack to too much, isn't asked.
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] < 9 && buf[3] < 9) {
    const problem = await zipProblem(buf);
    if (problem) return { ok: false, error: problem };
  }
  let XLSX;
  let book;
  try {
    XLSX = require('xlsx');
    // One row past the limit, so a sheet with more says so. Formulas, HTML, styles and
    // dates as Date objects are all things the panel never shows.
    book = XLSX.read(buf, {
      type: 'buffer', dense: true, sheetRows: ROW_LIMIT + 1,
      cellFormula: false, cellHTML: false, cellStyles: false, cellDates: false,
    });
  } catch (err) {
    const message = String((err && err.message) || err);
    if (/password/i.test(message)) return { ok: false, error: LOCKED };
    console.error('[switchboard] sheets: could not read a spreadsheet:', message.slice(0, 200));
    return { ok: false, error: UNREADABLE };
  }
  const names = Array.isArray(book && book.SheetNames) ? book.SheetNames : [];
  // The sheets Excel would show: hidden ones stay hidden, unless every one is.
  const meta = book.Workbook && Array.isArray(book.Workbook.Sheets) ? book.Workbook.Sheets : [];
  const hidden = new Set(meta.filter(m => m && m.Hidden).map(m => m.name));
  let shown = names.filter(name => !hidden.has(name));
  if (!shown.length) shown = names;
  if (!shown.length) return { ok: false, error: 'That spreadsheet has no sheets' };
  const sheets = shown.map(name => {
    if (budget.full) return emptySheet(name);
    const ws = book.Sheets[name] || {};
    const data = Array.isArray(ws['!data']) ? ws['!data'] : [];
    // SheetJS read ROW_LIMIT + 1 rows; `!fullref` is the range it would have read
    // without the limit, when that was more.
    let cut = false;
    try {
      if (ws['!fullref']) cut = XLSX.utils.decode_range(ws['!fullref']).e.r > ROW_LIMIT;
    } catch (_) { cut = false; }
    return packSheet(name, data, cellText, budget, cut);
  });
  return { ok: true, format: ext, sheets };
}

/** readBytes() of the file at `file`. */
async function readBook(file, ext) {
  if (!SHEET_EXTENSIONS.has(ext)) return { ok: false, error: NOT_A_SHEET };
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    return { ok: false, error: err && err.code === 'ENOENT' ? MISSING : `Could not read the file: ${String((err && err.message) || err)}` };
  }
  return readBytes(buf, ext);
}

// ── the worker ──────────────────────────────────────────────────────────────

function isBook(msg) {
  return !!msg && msg.ok === true && Array.isArray(msg.sheets) && msg.sheets.every(s =>
    s && typeof s.text === 'string' && s.offsets instanceof Uint32Array && s.rowStart instanceof Uint32Array);
}

/**
 * Read `file` in a worker of its own: { ok: true, book } or { ok: false, error }. One
 * worker runs at a time, the rest waiting their turn in order, so opening several big
 * files one after another can't add up what each may use.
 */
function readInWorker(file, ext) {
  return new Promise(resolve => {
    queue.push({ file, ext, resolve });
    nextRead();
  });
}

/** Start the oldest waiting read, when no worker is running. */
function nextRead() {
  if (busy || !queue.length) return;
  busy = true;
  const { file, ext, resolve } = queue.shift();
  runWorker(file, ext, resolve).then(() => {
    busy = false;
    nextRead();
  });
}

/**
 * readInWorker()'s worker, its answer handed to `answer`. It is terminated however it
 * ends — answered, failed, out of memory (its heap, or the app's: the Buffers SheetJS
 * unpacks into are outside the heap) or out of time — and what this returns resolves
 * once its thread is gone, and what it held with it, so the next starts only then.
 */
function runWorker(file, ext, answer) {
  return new Promise(stopped => {
    let worker = null;
    let timer = null;
    let watch = null;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watch);
      answer(result);
      (worker ? worker.terminate().catch(() => {}) : Promise.resolve()).then(() => stopped());
    };
    try {
      const { Worker } = require('worker_threads');
      worker = new Worker(options.workerFile, {
        workerData: { file, ext },
        resourceLimits: { maxOldGenerationSizeMb: options.heapMb },
      });
    } catch (err) {
      console.error('[switchboard] sheets: could not start a reader:', String((err && err.message) || err));
      finish({ ok: false, error: UNREADABLE });
      return;
    }
    timer = setTimeout(() => finish({ ok: false, error: TOO_SLOW }), options.timeoutMs);
    // The worker is a thread of this process, so what it holds outside its heap shows in
    // the process's resident memory — the one measure that counts it all.
    const ceiling = process.memoryUsage.rss() + options.growthMb * 1024 * 1024;
    watch = setInterval(() => {
      if (process.memoryUsage.rss() > ceiling) finish({ ok: false, error: TOO_BIG });
    }, options.pollMs);
    worker.on('message', msg => {
      if (isBook(msg)) finish({ ok: true, book: msg });
      else finish({ ok: false, error: msg && typeof msg.error === 'string' && msg.error ? msg.error : UNREADABLE });
    });
    worker.on('error', err => {
      if (err && err.code === 'ERR_WORKER_OUT_OF_MEMORY') return finish({ ok: false, error: TOO_BIG });
      console.error('[switchboard] sheets: a reader failed:', String((err && err.message) || err).slice(0, 200));
      finish({ ok: false, error: UNREADABLE });
    });
    // An exit with no answer and no error — a worker killed from outside.
    worker.on('exit', () => finish({ ok: false, error: UNREADABLE }));
  });
}

/** The workbook at `file`, read once: from the cache, from a read in flight, or now. */
function load(file, ext) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return Promise.resolve({ ok: false, error: 'Invalid file' });
  if (!SHEET_EXTENSIONS.has(ext)) return Promise.resolve({ ok: false, error: NOT_A_SHEET });
  const key = `${ext}:${file}`;
  const kept = cache.get(key);
  if (kept) {
    cache.delete(key);
    cache.set(key, kept);
    return Promise.resolve({ ok: true, book: kept });
  }
  let job = reading.get(key);
  if (!job) {
    // A failure isn't kept: a read that ran out of time on a busy Mac may manage next time.
    job = readInWorker(file, ext).then(result => {
      reading.delete(key);
      if (result.ok) {
        cache.set(key, result.book);
        while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      }
      return result;
    });
    reading.set(key, job);
  }
  return job;
}

// ── what the panel asks ─────────────────────────────────────────────────────

function isIndex(n) {
  return Number.isSafeInteger(n) && n >= 0;
}

/** The last index i < `count` with arr[i] <= value — arr ascending. */
function lastAtMost(arr, value, count) {
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid] <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function rowCells(sheet, r) {
  const out = [];
  for (let c = sheet.rowStart[r]; c < sheet.rowStart[r + 1]; c++) out.push(sheet.text.slice(sheet.offsets[c], sheet.offsets[c + 1]));
  return out;
}

/**
 * The sheet's text lowercased cell by cell, kept on the sheet — or null when lowercasing
 * changed a cell's length (a dotted capital İ is two characters lowercased), so offsets
 * into it would no longer land on the cells.
 */
function lowerText(sheet) {
  if (sheet.lower !== undefined) return sheet.lower;
  const cells = sheet.offsets.length - 1;
  const parts = new Array(cells);
  let same = true;
  for (let c = 0; c < cells && same; c++) {
    const text = sheet.text.slice(sheet.offsets[c], sheet.offsets[c + 1]);
    parts[c] = text.toLowerCase();
    same = parts[c].length === text.length;
  }
  sheet.lower = same ? parts.join('') : null;
  return sheet.lower;
}

/** Cells holding `query`, ignoring case, in reading order: at most `limit`, `more` past it. */
function searchSheet(sheet, query, limit) {
  const q = query.toLowerCase();
  const matches = [];
  let more = false;
  const cells = sheet.offsets.length - 1;
  const rows = sheet.rowStart.length - 1;
  // False once the list is full — and then there is more.
  const add = c => {
    if (matches.length === limit) { more = true; return false; }
    const row = lastAtMost(sheet.rowStart, c, rows);
    matches.push({ row, col: c - sheet.rowStart[row] });
    return true;
  };
  const lower = cells > 0 ? lowerText(sheet) : '';
  if (lower !== null) {
    // One search of the whole text, each hit mapped to its cell; a hit across two cells
    // is none, and a cell counts once.
    let from = 0;
    while (from < lower.length) {
      const at = lower.indexOf(q, from);
      if (at === -1) break;
      const c = lastAtMost(sheet.offsets, at, cells);
      if (at + q.length <= sheet.offsets[c + 1] && !add(c)) break;
      from = sheet.offsets[c + 1];
    }
  } else {
    for (let c = 0; c < cells; c++) {
      if (sheet.text.slice(sheet.offsets[c], sheet.offsets[c + 1]).toLowerCase().includes(q) && !add(c)) break;
    }
  }
  return { matches, more };
}

/**
 * { format, sheets: [{ name, rows, cols, truncated, clipped }] } — the panel's first
 * question. A sheet `truncated` with no rows was left out whole: the workbook's budget
 * was spent before it (or its first 100,000 rows are all empty).
 */
async function info(file, ext) {
  const loaded = await load(file, ext);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  return {
    ok: true,
    data: {
      format: loaded.book.format,
      sheets: loaded.book.sheets.map(s => ({ name: s.name, rows: s.rows, cols: s.cols, truncated: s.truncated, clipped: s.clipped })),
    },
  };
}

/**
 * Up to `count` (≤ 500) rows of sheet `sheet` from row `start`, all 0-based: { start,
 * rows }, each row its cells' text up to its last one with any — so rows differ in
 * length, and a cell past a row's end is empty. Past the sheet's end there are none.
 */
async function rows(file, ext, sheet, start, count) {
  if (!isIndex(sheet) || !isIndex(start) || !Number.isInteger(count) || count < 1 || count > ROWS_MAX) {
    return { ok: false, error: 'Invalid rows request' };
  }
  const loaded = await load(file, ext);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const s = loaded.book.sheets[sheet];
  if (!s) return { ok: false, error: "That sheet isn't in this spreadsheet" };
  const out = [];
  for (let r = start; r < Math.min(s.rows, start + count); r++) out.push(rowCells(s, r));
  return { ok: true, data: { start, rows: out } };
}

/** { matches: [{ row, col }], more } — the cells of sheet `sheet` holding `query`. */
async function find(file, ext, sheet, query, limit) {
  if (!isIndex(sheet) || typeof query !== 'string' || query.length < 1 || query.length > QUERY_MAX ||
    !Number.isInteger(limit) || limit < 1 || limit > FIND_MAX) {
    return { ok: false, error: 'Invalid search' };
  }
  const loaded = await load(file, ext);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const s = loaded.book.sheets[sheet];
  if (!s) return { ok: false, error: "That sheet isn't in this spreadsheet" };
  return { ok: true, data: searchSheet(s, query, limit) };
}

/**
 * For the tests: another worker file, heap, memory or time limit (`null` puts back the
 * defaults), and the cache emptied — so a test starts from no workbook read.
 */
function setOptions(next) {
  options = Object.assign({}, DEFAULTS, next || {});
  cache.clear();
}

module.exports = {
  info,
  rows,
  find,
  parseDelimited,
  decodeText,
  cellText,
  // For sheet-worker.js.
  readBook,
  // For the tests.
  csvDelimiter,
  readBytes,
  zipProblem,
  setOptions,
  cacheSize: () => cache.size,
  ROW_LIMIT,
  CELL_LIMIT,
  CELL_CHARS,
  UNPACKED_LIMIT,
  TOO_BIG,
  TOO_SLOW,
  UNREADABLE,
  LOCKED,
};
