'use strict';

// npm run test:diagrams — a spreadsheet on a whiteboard, read for its panel
// (src/main/sheets.js and the worker it reads in, sheet-worker.js): CSV and TSV as
// spreadsheet apps read them (parseDelimited, decodeText), each cell's text as Excel
// shows it (cellText), Excel, OpenDocument and Numbers workbooks written with SheetJS
// here and read back, the panel's paging and search, the limits a huge file stops at,
// a reader that runs out of memory or time answering with a sentence, and the cache.
// Zips are looked through before SheetJS unpacks them — a zip bomb is refused, as is a
// zip SheetJS would trip on — and a reader that grows the app past its limit is stopped;
// one reader runs at a time. Plain node, no Electron: neither module requires it.
//
// Every workbook, name and number here is made up (AGENTS.md).

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { test, after, afterEach } = require('node:test');

const sheets = require('../src/main/sheets');

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-sheets-test-')));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
// Each test that swaps the worker or its limits puts them back.
afterEach(() => sheets.setOptions(null));

let seq = 0;
/** A file in the temp folder with these bytes, under a name of its own. */
function fixture(bytes, ext) {
  const file = path.join(temp, `example-${++seq}.${ext}`);
  fs.writeFileSync(file, bytes);
  return file;
}

/** A worker of the test's own, for the ways a reader fails. */
function workerFile(name, source) {
  const file = path.join(temp, name);
  fs.writeFileSync(file, source);
  return file;
}

// ---------------------------------------------------------------------------
// CSV and TSV
// ---------------------------------------------------------------------------

test('parseDelimited reads RFC 4180: quotes, doubled quotes, line breaks inside quotes, every line ending', () => {
  const rows = text => sheets.parseDelimited(text, ',').rows;
  assert.deepEqual(rows('a,b,c\n1,2,3\n'), [['a', 'b', 'c'], ['1', '2', '3']]);
  assert.deepEqual(rows('a,b\r\n1,2\r3,4\n5,6'), [['a', 'b'], ['1', '2'], ['3', '4'], ['5', '6']]);
  assert.deepEqual(rows('"North, East",2\n'), [['North, East', '2']]);
  assert.deepEqual(rows('"Says ""hi"" twice",x'), [['Says "hi" twice', 'x']]);
  assert.deepEqual(rows('"line one\nline two\r\nline three",end\nnext'), [['line one\nline two\r\nline three', 'end'], ['next']]);
  // A record with one empty field is a row with nothing in it.
  assert.deepEqual(rows('""'), [[]]);
  assert.deepEqual(rows('"",x'), [['', 'x']]);
  // Lenient where a spreadsheet app is: a quote inside a field is a quote, text after a
  // closing quote is kept, and a quote that never closes runs to the end.
  assert.deepEqual(rows('5" pipe,x'), [['5" pipe', 'x']]);
  assert.deepEqual(rows('"ab"cd,x'), [['abcd', 'x']]);
  assert.deepEqual(rows('"open\nto the end,still'), [['open\nto the end,still']]);
  // Empty rows in the middle stay rows; trailing empty fields and rows don't.
  assert.deepEqual(rows('a\n\nb\n'), [['a'], [], ['b']]);
  assert.deepEqual(rows('a,b,,\n,,\n'), [['a', 'b'], []]);
  assert.deepEqual(rows(',,c'), [['', '', 'c']]);
  assert.deepEqual(rows('a,'), [['a']]);
  assert.deepEqual(rows(''), []);
  assert.deepEqual(rows('\n'), [[]]);
  assert.deepEqual(sheets.parseDelimited('a\tb\t"c\td"\n', '\t').rows, [['a', 'b', 'c\td']]);
  assert.deepEqual(sheets.parseDelimited('a;b\n1,5;2', ';').rows, [['a', 'b'], ['1,5', '2']]);
  assert.equal(sheets.parseDelimited('a,b\n', ',').truncated, false);
});

test('a CSV separated by semicolons is told apart by its first line', () => {
  assert.equal(sheets.csvDelimiter('Region;Revenue;Growth\nNorth;1,5;2'), ';');
  assert.equal(sheets.csvDelimiter('Region,Revenue;Growth'), ',');
  assert.equal(sheets.csvDelimiter('a;b,c'), ',');
  // Semicolons inside quotes, and anything past the first line, don't count.
  assert.equal(sheets.csvDelimiter('"a;b;c",d\ne;f;g;h'), ',');
  assert.equal(sheets.csvDelimiter(''), ',');
  // With no delimiter given, parseDelimited asks the same question.
  assert.deepEqual(sheets.parseDelimited('Region;Revenue\nNorth;"1,5"').rows, [['Region', 'Revenue'], ['North', '1,5']]);
});

test('parseDelimited stops at its limits, and says so — but not for blank lines past them', () => {
  const ten = Array.from({ length: 10 }, (_, i) => `r${i},x`).join('\n');
  const byRows = sheets.parseDelimited(ten, ',', { rows: 4 });
  assert.equal(byRows.truncated, true);
  assert.deepEqual(byRows.rows.map(r => r[0]), ['r0', 'r1', 'r2', 'r3']);
  const blankTail = sheets.parseDelimited('a\nb\n\n\n\n', ',', { rows: 2 });
  assert.deepEqual(blankTail, { rows: [['a'], ['b']], truncated: false });
  const byCells = sheets.parseDelimited('a,b,c\nd,e,f\ng,h', ',', { cells: 7 });
  assert.equal(byCells.truncated, true);
  assert.deepEqual(byCells.rows, [['a', 'b', 'c'], ['d', 'e', 'f']]);
  // Trailing empty fields aren't cells.
  assert.deepEqual(sheets.parseDelimited('a,,,,\nb,,,,', ',', { cells: 2 }), { rows: [['a'], ['b']], truncated: false });
});

test('decodeText reads UTF-8 with or without its mark, UTF-16 either way round, and Windows-1252', () => {
  assert.equal(sheets.decodeText(Buffer.from('Café,€5\n')), 'Café,€5\n');
  assert.equal(sheets.decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Région')])), 'Région');
  assert.equal(sheets.decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Région,€', 'utf16le')])), 'Région,€');
  const be = Buffer.from('Région,€', 'utf16le').swap16();
  assert.equal(sheets.decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), 'Région,€');
  // An odd byte at the end of UTF-16 is dropped, not read as half a character.
  assert.equal(sheets.decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ab', 'utf16le'), Buffer.from([0x41])])), 'ab');
  // Not UTF-8: Windows-1252, curly quotes, dashes and € included.
  const cp1252 = Buffer.from([0x93, 0x51, 0x31, 0x94, 0x20, 0x96, 0x20, 0x80, 0x35, 0x20, 0x43, 0x61, 0x66, 0xe9, 0x20, 0x81]);
  assert.equal(sheets.decodeText(cp1252), '“Q1” – €5 Café \u0081');
  assert.equal(sheets.decodeText(new Uint8Array([0x61, 0x62])), 'ab');
  assert.equal(sheets.decodeText(Buffer.alloc(0)), '');
});

test('cellText is the text Excel shows, else the value, else nothing', () => {
  assert.equal(sheets.cellText({ t: 'n', v: 1234.5, w: '1,234.50' }), '1,234.50');
  assert.equal(sheets.cellText({ t: 'n', v: 0.25, w: '25%' }), '25%');
  assert.equal(sheets.cellText({ t: 'n', v: 0 }), '0');
  assert.equal(sheets.cellText({ t: 'b', v: false }), 'false');
  assert.equal(sheets.cellText({ t: 's', v: '' }), '');
  // A formula saved without its result.
  assert.equal(sheets.cellText({ t: 'e' }), '');
  assert.equal(sheets.cellText({ t: 'e', v: 7, w: '#DIV/0!' }), '#DIV/0!');
  assert.equal(sheets.cellText(null), '');
  assert.equal(sheets.cellText(undefined), '');
});

// ---------------------------------------------------------------------------
// workbooks, read in the worker
// ---------------------------------------------------------------------------

/**
 * A two-sheet workbook and a hidden third, written by SheetJS: formatted numbers, a
 * cell well away from A1, a formula with no saved result, and trailing blanks.
 */
function exampleBook() {
  const XLSX = require('xlsx');
  const summary = XLSX.utils.aoa_to_sheet([
    ['Region', 'Revenue', 'Growth'],
    ['North', 120000, 0.05],
    ['South', 135500.25, 0.08],
  ]);
  summary.B2.z = '#,##0.00';
  summary.B3.z = '#,##0.00';
  summary.C2.z = '0.0%';
  summary.C3.z = '0.0%';
  summary.E5 = { t: 's', v: 'Note: fictional' };
  summary.F6 = { t: 'n', f: 'B2*2' };
  summary['!ref'] = 'A1:F6';
  const orders = XLSX.utils.aoa_to_sheet(Array.from({ length: 1200 }, (_, i) => [`EX-${String(i).padStart(4, '0')}`, i % 7 === 0 ? 'Shipped' : 'Open']));
  const hidden = XLSX.utils.aoa_to_sheet([['Lookup']]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, summary, 'Summary');
  XLSX.utils.book_append_sheet(wb, orders, 'Orders');
  XLSX.utils.book_append_sheet(wb, hidden, 'Lookups');
  wb.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 0 }, { Hidden: 1 }] };
  return wb;
}

test('an xlsx, an xlsb, an xls and an ods read back as Excel shows them, cells in their places', async () => {
  const XLSX = require('xlsx');
  const wb = exampleBook();
  for (const [bookType, ext] of [['xlsx', 'xlsx'], ['xlsb', 'xlsb'], ['biff8', 'xls'], ['ods', 'ods']]) {
    const file = fixture(XLSX.write(wb, { type: 'buffer', bookType }), ext);
    const info = await sheets.info(file, ext);
    assert.equal(info.ok, true, `${ext}: ${info.error}`);
    // ODS keeps no hidden flag when SheetJS writes it; the others leave Lookups out.
    const names = info.data.sheets.map(s => s.name);
    assert.deepEqual(names, ext === 'ods' ? ['Summary', 'Orders', 'Lookups'] : ['Summary', 'Orders'], ext);
    assert.equal(info.data.format, ext);
    // E5 is the last cell with text: F6's formula was saved without a result — except in
    // ODS, where SheetJS writes it as an error, which has text.
    const summary = ext === 'ods' ? { rows: 6, cols: 6 } : { rows: 5, cols: 5 };
    assert.deepEqual(info.data.sheets[0], { name: 'Summary', ...summary, truncated: false, clipped: false }, ext);
    assert.deepEqual(info.data.sheets[1], { name: 'Orders', rows: 1200, cols: 2, truncated: false, clipped: false }, ext);

    const top = await sheets.rows(file, ext, 0, 0, 10);
    assert.equal(top.ok, true, top.error);
    assert.equal(top.data.start, 0);
    assert.deepEqual(top.data.rows[0], ['Region', 'Revenue', 'Growth']);
    assert.deepEqual(top.data.rows[3], [], ext);
    assert.deepEqual(top.data.rows[4], ['', '', '', '', 'Note: fictional'], ext);
    assert.equal(top.data.rows.length, summary.rows);
    if (ext !== 'ods') {
      // ODS keeps the value and the format apart; SheetJS writes the others' formatted text.
      assert.deepEqual(top.data.rows[1], ['North', '120,000.00', '5.0%'], ext);
      assert.deepEqual(top.data.rows[2], ['South', '135,500.25', '8.0%'], ext);
    }
  }
});

test('a Numbers file reads back too', async () => {
  const XLSX = require('xlsx');
  const zahl = require('xlsx/dist/xlsx.zahl.js');
  const ws = XLSX.utils.aoa_to_sheet([['Region', 'Revenue'], ['North', 1200.5]]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Example table');
  const file = fixture(XLSX.write(wb, { type: 'buffer', bookType: 'numbers', numbers: zahl }), 'numbers');
  const info = await sheets.info(file, 'numbers');
  assert.equal(info.ok, true, info.error);
  assert.deepEqual(info.data.sheets, [{ name: 'Example table', rows: 2, cols: 2, truncated: false, clipped: false }]);
  assert.deepEqual((await sheets.rows(file, 'numbers', 0, 0, 5)).data.rows, [['Region', 'Revenue'], ['North', '1200.5']]);
});

test('a CSV and a TSV are one sheet each, decoded and split as spreadsheet apps do', async () => {
  const csv = fixture(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Name,Comment\r\nExample Person,"Says ""hi"", then leaves"\r\n')]), 'csv');
  assert.deepEqual((await sheets.info(csv, 'csv')).data, { format: 'csv', sheets: [{ name: 'Sheet1', rows: 2, cols: 2, truncated: false, clipped: false }] });
  assert.deepEqual((await sheets.rows(csv, 'csv', 0, 0, 5)).data.rows, [['Name', 'Comment'], ['Example Person', 'Says "hi", then leaves']]);
  const semicolons = fixture(Buffer.from('Region;Revenue\nNorth;1,5\n'), 'csv');
  assert.deepEqual((await sheets.rows(semicolons, 'csv', 0, 0, 5)).data.rows, [['Region', 'Revenue'], ['North', '1,5']]);
  // A TSV is split at tabs only, whatever its first line holds.
  const tsv = fixture(Buffer.from('a;b;c\tx\n1,2\t3\n'), 'tsv');
  assert.deepEqual((await sheets.rows(tsv, 'tsv', 0, 0, 5)).data.rows, [['a;b;c', 'x'], ['1,2', '3']]);
});

test('rows come a page at a time, at most 500, and none past the end', async () => {
  const XLSX = require('xlsx');
  const file = fixture(XLSX.write(exampleBook(), { type: 'buffer', bookType: 'xlsx' }), 'xlsx');
  const page = await sheets.rows(file, 'xlsx', 1, 200, 500);
  assert.equal(page.ok, true, page.error);
  assert.equal(page.data.start, 200);
  assert.equal(page.data.rows.length, 500);
  assert.deepEqual(page.data.rows[0], ['EX-0200', 'Open']);
  assert.deepEqual(page.data.rows[499], ['EX-0699', 'Open']);
  const last = await sheets.rows(file, 'xlsx', 1, 1150, 500);
  assert.equal(last.data.rows.length, 50);
  assert.deepEqual(last.data.rows[49], ['EX-1199', 'Open']);
  assert.deepEqual(await sheets.rows(file, 'xlsx', 1, 5000, 10), { ok: true, data: { start: 5000, rows: [] } });

  for (const [sheet, start, count] of [[1, 0, 501], [1, 0, 0], [1, -1, 10], [1, 1.5, 10], [-1, 0, 10], ['1', 0, 10], [1, 0, '10'], [1, NaN, 10]]) {
    assert.deepEqual(await sheets.rows(file, 'xlsx', sheet, start, count), { ok: false, error: 'Invalid rows request' }, `${sheet} ${start} ${count}`);
  }
  // The hidden third sheet isn't one of the panel's.
  assert.deepEqual(await sheets.rows(file, 'xlsx', 2, 0, 10), { ok: false, error: "That sheet isn't in this spreadsheet" });
});

test('find looks through one sheet in reading order, ignoring case, and says when there is more', async () => {
  const lines = [
    'Name,Status,Note',
    'Example One,Shipped,ok',
    'Example Two,open,SHIPPED late',
    'ab,,cd,x',
    'Straße,Main office,end',
  ];
  // The same search both ways: through the whole sheet's text at once, and — once a
  // dotted capital İ, two characters lowercased, puts that text out of step with the
  // cells — cell by cell.
  const plain = fixture(Buffer.from(lines.join('\n')), 'csv');
  const dotted = fixture(Buffer.from([...lines, 'İzmir office,x'].join('\n')), 'csv');
  for (const file of [plain, dotted]) {
    const all = await sheets.find(file, 'csv', 0, 'shipped', 10);
    assert.deepEqual(all, { ok: true, data: { matches: [{ row: 1, col: 1 }, { row: 2, col: 2 }], more: false } });
    assert.deepEqual((await sheets.find(file, 'csv', 0, 'Shipped', 1)).data, { matches: [{ row: 1, col: 1 }], more: true });
    // A cell counts once, however often it holds the text.
    assert.deepEqual((await sheets.find(file, 'csv', 0, 'e', 1000)).data.matches.filter(m => m.row === 1), [{ row: 1, col: 0 }, { row: 1, col: 1 }]);
    // Text across two cells — even with an empty one between — is in neither.
    assert.deepEqual((await sheets.find(file, 'csv', 0, 'bc', 10)).data, { matches: [], more: false });
    assert.deepEqual((await sheets.find(file, 'csv', 0, 'STRASSE', 10)).data.matches, []);
    assert.deepEqual((await sheets.find(file, 'csv', 0, 'STRAßE', 10)).data.matches, [{ row: 4, col: 0 }]);
    assert.deepEqual((await sheets.find(file, 'csv', 0, 'end', 10)).data.matches, [{ row: 4, col: 2 }]);
    assert.deepEqual((await sheets.find(file, 'csv', 0, 'cd', 10)).data.matches, [{ row: 3, col: 2 }]);
  }
  assert.deepEqual((await sheets.find(dotted, 'csv', 0, 'office', 10)).data.matches, [{ row: 4, col: 1 }, { row: 5, col: 0 }]);
  assert.deepEqual((await sheets.find(dotted, 'csv', 0, 'İZMIR', 10)).data.matches, [{ row: 5, col: 0 }]);

  for (const [query, limit] of [['', 10], ['x'.repeat(201), 10], [7, 10], ['ok', 0], ['ok', 1001], ['ok', 2.5]]) {
    assert.deepEqual(await sheets.find(plain, 'csv', 0, query, limit), { ok: false, error: 'Invalid search' }, `${query} ${limit}`);
  }
  assert.equal((await sheets.find(plain, 'csv', 0, 'x'.repeat(200), 1000)).ok, true);
  assert.deepEqual(await sheets.find(plain, 'csv', 3, 'ok', 10), { ok: false, error: "That sheet isn't in this spreadsheet" });
});

test('a sheet stops at 100,000 rows, a workbook at 2,000,000 cells and a cell at 32,767 characters', async () => {
  const many = fixture(Buffer.from(Array.from({ length: sheets.ROW_LIMIT + 5 }, (_, i) => `r${i}`).join('\n')), 'csv');
  const manyInfo = await sheets.info(many, 'csv');
  assert.deepEqual(manyInfo.data.sheets[0], { name: 'Sheet1', rows: sheets.ROW_LIMIT, cols: 1, truncated: true, clipped: false });
  assert.deepEqual((await sheets.rows(many, 'csv', 0, sheets.ROW_LIMIT - 1, 10)).data.rows, [[`r${sheets.ROW_LIMIT - 1}`]]);

  // Exactly the limit, and blank lines after it, is the whole file.
  const exact = fixture(Buffer.from(Array.from({ length: sheets.ROW_LIMIT }, () => 'x').join('\n') + '\n\n\n'), 'csv');
  assert.equal((await sheets.info(exact, 'csv')).data.sheets[0].truncated, false);

  const cols = 2000;
  const wide = fixture(Buffer.from(Array.from({ length: sheets.CELL_LIMIT / cols + 1 }, () => '1,'.repeat(cols - 1) + '1').join('\n')), 'csv');
  assert.deepEqual((await sheets.info(wide, 'csv')).data.sheets[0], { name: 'Sheet1', rows: sheets.CELL_LIMIT / cols, cols, truncated: true, clipped: false });

  // A cell cut short leaves every row there: the sheet says so apart.
  const long = fixture(Buffer.from(`short,${'y'.repeat(sheets.CELL_CHARS + 100)}\nnext\n`), 'csv');
  assert.deepEqual((await sheets.info(long, 'csv')).data.sheets[0], { name: 'Sheet1', rows: 2, cols: 2, truncated: false, clipped: true });
  assert.equal((await sheets.rows(long, 'csv', 0, 0, 1)).data.rows[0][1].length, sheets.CELL_CHARS);
});

test('a workbook past its row limit says so', async () => {
  const XLSX = require('xlsx');
  const ws = XLSX.utils.aoa_to_sheet([['Example']]);
  ws[XLSX.utils.encode_cell({ r: sheets.ROW_LIMIT + 3, c: 0 })] = { t: 's', v: 'Far below' };
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: sheets.ROW_LIMIT + 3, c: 0 } });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Long');
  const read = await sheets.readBytes(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), 'xlsx');
  assert.equal(read.ok, true, read.error);
  assert.equal(read.sheets[0].truncated, true);
  assert.equal(read.sheets[0].rows, 1);
});

// ---------------------------------------------------------------------------
// failures, the worker and the cache
// ---------------------------------------------------------------------------

test('a file that is not a readable spreadsheet answers a sentence, and soon', async () => {
  // A zip header and nonsense — the very bytes SheetJS spins on for good — is turned away
  // before it is asked.
  const garbage = fixture(Buffer.concat([Buffer.from('504b0304140000000800', 'hex'), Buffer.from('not really a workbook')]), 'xlsx');
  const started = Date.now();
  assert.deepEqual(await sheets.info(garbage, 'xlsx'), { ok: false, error: "That spreadsheet can't be read here" });
  assert.ok(Date.now() - started < 5000);
  const XLSX = require('xlsx');
  const whole = XLSX.write(exampleBook(), { type: 'buffer', bookType: 'xlsx' });
  const cut = fixture(whole.subarray(0, whole.length >> 1), 'xlsx');
  assert.deepEqual(await sheets.info(cut, 'xlsx'), { ok: false, error: "That spreadsheet can't be read here" });
  const notOle = fixture(Buffer.from('d0cf11e0a1b11ae1' + '00'.repeat(600), 'hex'), 'xls');
  assert.deepEqual(await sheets.info(notOle, 'xls'), { ok: false, error: "That spreadsheet can't be read here" });
  assert.deepEqual(await sheets.info(path.join(temp, 'never-written.csv'), 'csv'), { ok: false, error: 'That file is no longer on this Mac' });
  assert.deepEqual(await sheets.info(garbage, 'pdf'), { ok: false, error: "That isn't a spreadsheet" });
  assert.deepEqual(await sheets.info('relative/example.csv', 'csv'), { ok: false, error: 'Invalid file' });
  assert.deepEqual(await sheets.rows(garbage, 'xlsx', 0, 0, 10), { ok: false, error: "That spreadsheet can't be read here" });
});

// ---------------------------------------------------------------------------
// zips, looked through before SheetJS unpacks them
// ---------------------------------------------------------------------------

/**
 * A zip of `parts`, each { name, data } — deflated here — or { name, deflated, size }
 * deflated already, with `extra` (its header's extra fields) and `listedExtra` (the
 * directory's) when given. `streamed` writes it as a streaming writer does: no sizes in
 * a part's header, a data descriptor after its data.
 */
function zipOf(parts, streamed = false) {
  const body = [];
  const central = [];
  let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name);
    const deflated = part.deflated || zlib.deflateRawSync(part.data);
    const size = part.size !== undefined ? part.size : part.data.length;
    const crc = part.data ? zlib.crc32(part.data) : 0;
    const extra = part.extra || Buffer.alloc(0);
    const listedExtra = part.listedExtra || Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(streamed ? 8 : 0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(streamed ? 0 : crc, 14);
    local.writeUInt32LE(streamed ? 0 : deflated.length, 18);
    local.writeUInt32LE(streamed ? 0 : size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const descriptor = Buffer.alloc(streamed ? 16 : 0);
    if (streamed) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(deflated.length, 8);
      descriptor.writeUInt32LE(size, 12);
    }
    body.push(local, name, extra, deflated, descriptor);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(streamed ? 8 : 0, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(deflated.length, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(listedExtra.length, 30);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name, listedExtra);
    offset += 30 + name.length + extra.length + deflated.length + descriptor.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...body, directory, end]);
}

/**
 * `mb` megabytes of zeros, deflated, without ever holding them: one megabyte deflated
 * and flushed to a byte boundary, repeated — each run refers only to itself — and an
 * empty last block to end the stream.
 */
function deflatedZeros(mb) {
  const run = zlib.deflateRawSync(Buffer.alloc(1024 * 1024), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  return Buffer.concat([...new Array(mb).fill(run), zlib.deflateRawSync(Buffer.alloc(0))]);
}

/** A ZIP64 extra field (0x0001) giving `usz` as the unpacked size. */
function zip64(usz) {
  const field = Buffer.alloc(20);
  field.writeUInt16LE(0x0001, 0);
  field.writeUInt16LE(16, 2);
  field.writeBigUInt64LE(BigInt(usz), 4);
  field.writeBigUInt64LE(10n, 12);
  return field;
}

/** Every part of a zip SheetJS wrote, as { name, data }. */
function partsOf(zip) {
  const XLSX = require('xlsx');
  const cfb = XLSX.CFB.read(zip, { type: 'buffer' });
  return cfb.FileIndex.map((entry, i) => ({ entry, name: cfb.FullPaths[i].replace(/^[^/]*\//, '') }))
    .filter(({ entry }) => entry.type === 2 && entry.content)
    .map(({ entry, name }) => ({ name, data: Buffer.from(entry.content) }));
}

test('a zip that would unpack to more than SheetJS should hold is refused before it is read', async () => {
  // A zip bomb: a megabyte and a bit that SheetJS would unpack, part by part, into 1.2 GB
  // of Buffers outside the worker's heap. The parts needn't be a workbook's.
  const zeros = deflatedZeros(400);
  const bomb = zipOf(['xl/media/image1.bin', 'xl/media/image2.bin', 'xl/media/image3.bin']
    .map(name => ({ name, deflated: zeros, size: 400 * 1024 * 1024 })));
  assert.ok(bomb.length < 2 * 1024 * 1024);
  const started = Date.now();
  assert.deepEqual(await sheets.readBytes(bomb, 'xlsx'), { ok: false, error: sheets.TOO_BIG });
  assert.ok(Date.now() - started < 1000);
  // Whatever it is called: SheetJS reads anything that starts as a zip as one.
  assert.deepEqual(await sheets.readBytes(bomb, 'xls'), { ok: false, error: sheets.TOO_BIG });

  // Written as a stream, the parts give no size, and SheetJS would let each grow as long
  // as its data goes on: they are unpacked to be measured, never past what is left.
  const small = deflatedZeros(4);
  const parts = ['a.bin', 'b.bin', 'c.bin'].map(name => ({ name, deflated: small, size: 4 * 1024 * 1024 }));
  assert.equal(await sheets.zipProblem(zipOf(parts, true), 10 * 1024 * 1024), sheets.TOO_BIG);
  assert.equal(await sheets.zipProblem(zipOf(parts, true), 12 * 1024 * 1024), null);
  assert.equal(await sheets.zipProblem(zipOf(parts), 10 * 1024 * 1024), sheets.TOO_BIG);
  assert.equal(await sheets.zipProblem(zipOf(parts), 12 * 1024 * 1024), null);

  // A ZIP64 field in a part's own header gives its size — and then the directory's does,
  // as SheetJS reads them; the directory's alone, SheetJS never looks at.
  const tiny = { name: 'x.bin', deflated: zlib.deflateRawSync(Buffer.from('example')), size: 7 };
  const huge = 2 * 1024 * 1024 * 1024;
  assert.equal(await sheets.zipProblem(zipOf([{ ...tiny, extra: zip64(huge) }])), sheets.TOO_BIG);
  assert.equal(await sheets.zipProblem(zipOf([{ ...tiny, extra: zip64(7), listedExtra: zip64(huge) }])), sheets.TOO_BIG);
  assert.equal(await sheets.zipProblem(zipOf([{ ...tiny, listedExtra: zip64(huge) }])), null);
});

test('a zip whose directory or parts SheetJS would trip on is refused as unreadable', async () => {
  const XLSX = require('xlsx');
  const good = XLSX.write(exampleBook(), { type: 'buffer', bookType: 'xlsx' });
  assert.equal(await sheets.zipProblem(good), null);
  // The directory pointing past the end of the file.
  const lost = Buffer.from(good);
  lost.writeUInt32LE(good.length + 100, lost.lastIndexOf(Buffer.from('504b0506', 'hex')) + 16);
  assert.equal(await sheets.zipProblem(lost), sheets.UNREADABLE);
  // An encrypted part, a method SheetJS doesn't know, and a stream that isn't one.
  const part = { name: 'x.bin', data: Buffer.from('example part') };
  const encrypted = zipOf([part]);
  encrypted.writeUInt16LE(1, 6);
  assert.equal(await sheets.zipProblem(encrypted), sheets.UNREADABLE);
  const bzip = zipOf([part]);
  bzip.writeUInt16LE(12, 8);
  assert.equal(await sheets.zipProblem(bzip), sheets.UNREADABLE);
  assert.equal(await sheets.zipProblem(zipOf([{ name: 'x.bin', deflated: Buffer.from('not deflate at all'), size: 0 }], true)), sheets.UNREADABLE);
  // A part kept as it is (stored) is read where it lies, and costs nothing.
  const stored = zipOf([{ name: 'x.bin', deflated: Buffer.alloc(64), size: 0xffffffff }]);
  stored.writeUInt16LE(0, 8);
  assert.equal(await sheets.zipProblem(stored, 1), null);
});

test('a workbook written as a stream, its parts sized only after their data, still reads', async () => {
  const XLSX = require('xlsx');
  const streamed = zipOf(partsOf(XLSX.write(exampleBook(), { type: 'buffer', bookType: 'xlsx' })), true);
  assert.equal(await sheets.zipProblem(streamed), null);
  const read = await sheets.readBytes(streamed, 'xlsx');
  assert.equal(read.ok, true, read.error);
  assert.deepEqual(read.sheets.map(s => [s.name, s.rows, s.cols]), [['Summary', 5, 5], ['Orders', 1200, 2]]);
});

test('an Excel workbook locked with a password — an OLE file, not a zip — says so', async () => {
  const XLSX = require('xlsx');
  // What Excel writes: the encrypted zip as one stream, beside how to unlock it.
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<encryption xmlns="http://schemas.microsoft.com/office/2006/encryption"><keyData saltSize="16" blockSize="16" keyBits="256" hashSize="64" cipherAlgorithm="AES" cipherChaining="ChainingModeCBC" hashAlgorithm="SHA512" saltValue="AAAA"/>' +
    '<keyEncryptors><keyEncryptor uri="http://schemas.microsoft.com/office/2006/keyEncryption/password"><p:encryptedKey xmlns:p="http://schemas.microsoft.com/office/2006/keyEncryption/password" spinCount="100000"/></keyEncryptor></keyEncryptors></encryption>';
  const cfb = XLSX.CFB.utils.cfb_new();
  XLSX.CFB.utils.cfb_add(cfb, '/EncryptionInfo', Buffer.concat([Buffer.from([4, 0, 4, 0, 0x40, 0, 0, 0]), Buffer.from(xml)]));
  XLSX.CFB.utils.cfb_add(cfb, '/EncryptedPackage', Buffer.alloc(4096, 7));
  const locked = Buffer.from(XLSX.CFB.write(cfb, { type: 'buffer' }));
  assert.ok(locked.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex')));
  for (const ext of ['xlsx', 'xlsm', 'xlsb']) assert.deepEqual(await sheets.readBytes(locked, ext), { ok: false, error: sheets.LOCKED }, ext);
});

test('a reader that runs out of memory or of time is stopped, and the panel told so', async () => {
  const csv = fixture(Buffer.from('a,b\n'), 'csv');
  sheets.setOptions({ workerFile: workerFile('hog.js', 'const keep = []; for (;;) keep.push(new Array(1e5).fill(Math.random()));\n'), heapMb: 16 });
  assert.deepEqual(await sheets.info(csv, 'csv'), { ok: false, error: sheets.TOO_BIG });
  sheets.setOptions({ workerFile: workerFile('hang.js', 'for (;;) {}\n'), timeoutMs: 200 });
  const started = Date.now();
  assert.deepEqual(await sheets.info(csv, 'csv'), { ok: false, error: sheets.TOO_SLOW });
  assert.ok(Date.now() - started < 5000);
  // One that breaks, or answers nonsense, can't be read.
  sheets.setOptions({ workerFile: workerFile('broken.js', 'throw new Error("example failure");\n') });
  assert.deepEqual(await sheets.info(csv, 'csv'), { ok: false, error: "That spreadsheet can't be read here" });
  sheets.setOptions({ workerFile: workerFile('nonsense.js', 'require("worker_threads").parentPort.postMessage({ ok: true, sheets: [{}] });\n') });
  assert.deepEqual(await sheets.info(csv, 'csv'), { ok: false, error: "That spreadsheet can't be read here" });
  sheets.setOptions({ workerFile: path.join(temp, 'no-such-worker.js') });
  assert.equal((await sheets.info(csv, 'csv')).ok, false);
  // A failure isn't remembered: the next ask reads again.
  sheets.setOptions(null);
  assert.equal((await sheets.info(csv, 'csv')).ok, true);
});

test('a reader that grows the app outside its heap — Buffers, as unpacking makes — is stopped too', async () => {
  const csv = fixture(Buffer.from('a,b\n'), 'csv');
  // Written to, so the memory is really the process's; the heap's cap never sees it.
  const grow = 'const keep = []; setInterval(() => keep.push(Buffer.alloc(16 * 1024 * 1024, 1)), 20);\n';
  sheets.setOptions({ workerFile: workerFile('buffers.js', grow), growthMb: 96, pollMs: 25, timeoutMs: 10000 });
  const started = Date.now();
  assert.deepEqual(await sheets.info(csv, 'csv'), { ok: false, error: sheets.TOO_BIG });
  assert.ok(Date.now() - started < 5000);
});

test('one reader runs at a time; the others wait their turn, in order', async () => {
  const log = path.join(temp, 'turns.txt');
  fs.writeFileSync(log, '');
  const real = path.join(__dirname, '..', 'src', 'main', 'sheet-worker.js');
  const source = `const fs = require('fs'); const { workerData } = require('worker_threads');
const name = require('path').basename(workerData.file);
fs.appendFileSync(${JSON.stringify(log)}, '+' + name + ' ');
setTimeout(() => { fs.appendFileSync(${JSON.stringify(log)}, '-' + name + ' '); require(${JSON.stringify(real)}); }, 60);\n`;
  sheets.setOptions({ workerFile: workerFile('turns.js', source) });
  const files = ['x', 'y', 'z'].map(name => fixture(Buffer.from(`Example ${name}\n`), 'csv'));
  const answers = await Promise.all(files.map(file => sheets.info(file, 'csv')));
  assert.deepEqual(answers.map(a => a.ok), [true, true, true]);
  const names = files.map(file => path.basename(file));
  assert.equal(fs.readFileSync(log, 'utf8').trim(), names.map(name => `+${name} -${name}`).join(' '));
});

test('a file is read once — later asks and asks at the same time share it — and three are kept', async () => {
  const counter = path.join(temp, 'reads.txt');
  fs.writeFileSync(counter, '');
  const real = path.join(__dirname, '..', 'src', 'main', 'sheet-worker.js');
  sheets.setOptions({ workerFile: workerFile('counting.js', `require('fs').appendFileSync(${JSON.stringify(counter)}, 'x');\nrequire(${JSON.stringify(real)});\n`) });
  const reads = () => fs.readFileSync(counter, 'utf8').length;
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(name => fixture(Buffer.from(`Example ${name}\n`), 'csv'));

  assert.equal((await sheets.info(a, 'csv')).ok, true);
  assert.equal((await sheets.rows(a, 'csv', 0, 0, 1)).ok, true);
  assert.equal((await sheets.find(a, 'csv', 0, 'example', 5)).ok, true);
  assert.equal(reads(), 1);
  const together = await Promise.all([sheets.info(b, 'csv'), sheets.rows(b, 'csv', 0, 0, 1), sheets.find(b, 'csv', 0, 'b', 1)]);
  assert.deepEqual(together.map(r => r.ok), [true, true, true]);
  assert.equal(reads(), 2);
  await sheets.info(c, 'csv');
  await sheets.info(d, 'csv');
  assert.equal(reads(), 4);
  assert.equal(sheets.cacheSize(), 3);
  // `a` was read longest ago and has gone; `b`, `c` and `d` are still kept.
  await sheets.info(b, 'csv');
  assert.equal(reads(), 4);
  await sheets.info(a, 'csv');
  assert.equal(reads(), 5);
});

test('main never loads SheetJS itself — only the worker does', () => {
  const XLSX = require('xlsx');
  const ws = XLSX.utils.aoa_to_sheet([['Example']]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Only');
  const file = fixture(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), 'xlsx');
  const script = `
    const sheets = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'main', 'sheets.js'))});
    sheets.info(${JSON.stringify(file)}, 'xlsx').then(info => {
      const loaded = Object.keys(require.cache).some(k => k.includes(${JSON.stringify(path.sep + 'xlsx' + path.sep)}));
      process.stdout.write(JSON.stringify({ ok: info.ok, loaded }));
    });`;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }));
  assert.deepEqual(out, { ok: true, loaded: false });
});
