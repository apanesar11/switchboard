'use strict';

// npm run test:diagrams — PDFs and spreadsheets on a whiteboard, main's store for them
// (src/main/whiteboards.js saveFile, parseFileSrc, filePath, getFilePath): which files it
// keeps and which it refuses, by their extension and by their bytes; that a file is kept
// once, by its content, read-only; that its address names that one file and nothing
// else; that copying or deleting a board leaves the files alone; and the sizes the list's
// thumbnail draws a PDF and a spreadsheet at; and the files Finder copied, read for a
// whiteboard's Edit ▸ Paste (readPastedFiles, and drops.js readCopiedFiles against a
// pasteboard of the test's own — never the clipboard). The bundle's side of the same rules
// (lib/diagrams/files.ts, types.ts) is bundled with esbuild and held to agree.
//
// SWITCHBOARD_CONFIG is set BEFORE the module is required, so every file this writes
// lands in a temp directory and never in ~/.switchboard. Every file here is made up
// (AGENTS.md).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const esbuild = require('esbuild');

const temps = [];
function tempDir(label) {
  // realpath: os.tmpdir() is under /var, which is a symlink to /private/var.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `switchboard-${label}-test-`)));
  temps.push(dir);
  return dir;
}

const previousConfig = process.env.SWITCHBOARD_CONFIG;
const temp = tempDir('files');
process.env.SWITCHBOARD_CONFIG = path.join(temp, 'config.json');

const wb = require('../src/main/whiteboards');

// The bundle's rules — files.ts and the sizes in types.ts — as plain CommonJS.
const libDir = tempDir('files-lib');
for (const name of ['files', 'types']) {
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', 'src', 'diagrams', 'lib', 'diagrams', `${name}.ts`)],
    outfile: path.join(libDir, `${name}.js`), bundle: true, format: 'cjs', platform: 'node', logLevel: 'error',
  });
}
const files = require(path.join(libDir, 'files.js'));
const types = require(path.join(libDir, 'types.js'));

after(() => {
  if (previousConfig === undefined) delete process.env.SWITCHBOARD_CONFIG;
  else process.env.SWITCHBOARD_CONFIG = previousConfig;
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

const filesDir = () => path.join(wb.rootDir(), 'files');

// The smallest of each kind that passes for one from outside.
const PDF = Buffer.from('%PDF-1.7\n% Example quarterly report\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
// A zip's local header — version, flags, method, as every one has, NULs and all.
const ZIP = Buffer.concat([Buffer.from('504b0304140000000800', 'hex'), Buffer.from('example workbook parts')]);
const OLE = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(56)]);
const CSV = Buffer.from('Region,Revenue\nNorth,"1,200"\n');
const TSV = Buffer.from('Region\tRevenue\nNorth\t1200\n');
const HTML_XLS = Buffer.from('<html><body><table><tr><td>Example</td></tr></table></body></html>');
const UTF16_CSV = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Region,Revenue\n', 'utf16le')]);

test('the extensions, the limits and the address agree with the bundle\'s files.ts', () => {
  assert.deepEqual(wb.FILE_EXTENSIONS, files.FLOW_FILE_EXTENSIONS);
  assert.deepEqual(wb.FILE_MAX_BYTES, { pdf: files.FLOW_PDF_MAX_BYTES, sheet: files.FLOW_SHEET_MAX_BYTES });
  const name = 'a'.repeat(32);
  const samples = [
    `sbfile://file/${name}.pdf`, `sbfile://file/${name}.xlsx`, `sbfile://file/${name}.numbers`,
    `sbfile://file/${name}.tsv`, `sbfile://file/${name}.png`, `sbfile://file/${name}.PDF`,
    `sbfile://file/${'A'.repeat(32)}.pdf`, `sbfile://file/${name.slice(1)}.pdf`, `sbfile://file/${name}0.pdf`,
    `sbfile://file/${name}.pdf?x=1`, `sbfile://file/${name}.pdf#page=2`, `sbfile://other/${name}.pdf`,
    `sbfile://file/../${name}.pdf`, `sbimg://image/${name}.png`, `https://example.com/${name}.pdf`,
    `sbfile://file/${name}.constructor`, `sbfile://file/${name}.__proto__`, '', null, 7, {},
  ];
  for (const src of samples) assert.deepEqual(wb.parseFileSrc(src), files.parseFlowFileSrc(src), String(src));
  assert.deepEqual(wb.parseFileSrc(`sbfile://file/${name}.xlsb`), { name: `${name}.xlsb`, ext: 'xlsb', kind: 'sheet' });
});

test('a PDF and every kind of spreadsheet is kept, by content, read-only, as sbfile://file/<sha>.<ext>', async () => {
  const kept = [
    [PDF, 'pdf', 'pdf'],
    // A mail client may put a line before the header; a reader looks a kilobyte in.
    [Buffer.concat([Buffer.from('X'.repeat(1000)), PDF]), 'pdf', 'pdf'],
    [ZIP, 'xlsx', 'sheet'], [ZIP, 'xlsm', 'sheet'], [ZIP, 'xlsb', 'sheet'], [ZIP, 'ods', 'sheet'], [ZIP, 'numbers', 'sheet'],
    // Excel's zips, locked with a password, are OLE files — kept, for the panel to say so.
    [OLE, 'xlsx', 'sheet'], [OLE, 'xlsm', 'sheet'], [OLE, 'xlsb', 'sheet'],
    [OLE, 'xls', 'sheet'], [HTML_XLS, 'xls', 'sheet'],
    [CSV, 'csv', 'sheet'], [TSV, 'tsv', 'sheet'], [UTF16_CSV, 'csv', 'sheet'],
  ];
  for (const [bytes, ext, kind] of kept) {
    const saved = await wb.saveFile(new Uint8Array(bytes), ext);
    assert.equal(saved.ok, true, `${ext}: ${saved.error}`);
    assert.equal(saved.kind, kind);
    assert.match(saved.src, new RegExp(`^sbfile://file/[0-9a-f]{32}\\.${ext}$`));
    const name = saved.src.slice('sbfile://file/'.length);
    assert.equal(saved.file, path.join(filesDir(), name));
    assert.equal(wb.filePath(name), saved.file);
    assert.deepEqual(fs.readFileSync(saved.file), bytes);
    // Read-only for everyone: an app it is opened in can't save over the board's copy.
    assert.equal(fs.statSync(saved.file).mode & 0o777, 0o444, ext);
  }
  // Nothing half-written is left beside them.
  assert.deepEqual(fs.readdirSync(filesDir()).filter(f => f.endsWith('.tmp')), []);
});

test('the same bytes are one file; the same bytes under another extension are another', async () => {
  const a = await wb.saveFile(new Uint8Array(CSV), 'csv');
  const b = await wb.saveFile(Buffer.from(CSV), 'csv');
  assert.equal(a.ok && b.ok, true);
  assert.equal(a.src, b.src);
  const asTsv = await wb.saveFile(new Uint8Array(CSV), 'tsv');
  assert.equal(asTsv.ok, true);
  assert.notEqual(asTsv.src, a.src);
  assert.equal(path.parse(asTsv.file).name, path.parse(a.file).name);
  // Saved again over its read-only self, and at the same moment as another save of it.
  const again = await Promise.all([wb.saveFile(new Uint8Array(CSV), 'csv'), wb.saveFile(new Uint8Array(CSV), 'csv')]);
  assert.deepEqual(again.map(r => r.src), [a.src, a.src]);
  assert.equal(fs.readdirSync(filesDir()).filter(f => f === path.basename(a.file)).length, 1);

  // A view onto part of a bigger buffer keeps that part, not the whole.
  const big = Buffer.concat([Buffer.from('junk before'), PDF, Buffer.from('junk after')]);
  const view = new Uint8Array(big.buffer, big.byteOffset + 11, PDF.length);
  const fromView = await wb.saveFile(view, 'pdf');
  assert.equal(fromView.ok, true, fromView.error);
  assert.deepEqual(fs.readFileSync(fromView.file), PDF);
});

test('a file is refused when its extension is not one we keep, or its bytes are not what it says', async () => {
  for (const ext of ['exe', 'png', 'PDF', 'txt', '', '__proto__', 'constructor', 'hasOwnProperty', undefined, null, 7]) {
    const saved = await wb.saveFile(new Uint8Array(PDF), ext);
    assert.deepEqual(saved, { ok: false, error: "That isn't a PDF or a spreadsheet" }, String(ext));
  }
  const refused = [
    [CSV, 'pdf', 'a PDF'],
    // The header past the first kilobyte is not where a reader looks.
    [Buffer.concat([Buffer.from('X'.repeat(1024)), PDF]), 'pdf', 'a PDF'],
    [CSV, 'xlsx', 'an Excel spreadsheet'],
    [PDF, 'ods', 'an OpenDocument spreadsheet'],
    // Only Excel's own formats are locked that way.
    [OLE, 'ods', 'an OpenDocument spreadsheet'],
    [OLE, 'numbers', 'a Numbers spreadsheet'],
    [CSV, 'numbers', 'a Numbers spreadsheet'],
    [ZIP, 'xls', 'an Excel spreadsheet'],
    [Buffer.from([0x41, 0x00, 0x42]), 'xls', 'an Excel spreadsheet'],
    [ZIP, 'csv', 'a CSV file'],
    [Buffer.concat([Buffer.from('Region,Revenue\n'), Buffer.from([0])]), 'csv', 'a CSV file'],
    [OLE, 'tsv', 'a TSV file'],
  ];
  for (const [bytes, ext, what] of refused) {
    const saved = await wb.saveFile(new Uint8Array(bytes), ext);
    assert.equal(saved.ok, false, ext);
    assert.equal(saved.error, `That file isn't really ${what} — it may be damaged, or named for something else`);
  }
  // A NUL past the first 64 KB isn't looked for.
  const longCsv = Buffer.concat([Buffer.from('a,b\n'.repeat(16384 + 1)), Buffer.from([0])]);
  assert.equal((await wb.saveFile(new Uint8Array(longCsv), 'csv')).ok, true);

  assert.deepEqual(await wb.saveFile(new Uint8Array(0), 'pdf'), { ok: false, error: 'That file is empty' });
  assert.equal((await wb.saveFile(undefined, 'csv')).ok, false);
  assert.equal((await wb.saveFile(42, 'csv')).ok, false);
});

test('a spreadsheet may be at most 50 MB and a PDF 100 MB', async () => {
  const sheet = Buffer.alloc(files.FLOW_SHEET_MAX_BYTES + 1, 'a');
  assert.deepEqual(await wb.saveFile(sheet, 'csv'), { ok: false, error: 'That spreadsheet is over 50 MB' });
  const atMost = await wb.saveFile(sheet.subarray(0, files.FLOW_SHEET_MAX_BYTES), 'csv');
  assert.equal(atMost.ok, true, atMost.error);
  const pdf = Buffer.alloc(files.FLOW_PDF_MAX_BYTES + 1, ' ');
  PDF.copy(pdf);
  assert.deepEqual(await wb.saveFile(pdf, 'pdf'), { ok: false, error: 'That PDF is over 100 MB' });
});

test('a file address resolves only to a kept file — never to another, a folder or a traversal', async () => {
  const saved = await wb.saveFile(new Uint8Array(Buffer.from('Example,list\n1,2\n')), 'csv');
  assert.deepEqual(await wb.getFilePath(saved.src), { ok: true, data: saved.file });
  for (const src of [null, {}, saved.file, 'file://' + saved.file, 'https://example.com/example.csv',
    'sbfile://file/../config.json', 'sbfile://file/%2e%2e%2fconfig.json', saved.src + '?extra=1', saved.src + '#extra',
    saved.src.replace('sbfile://file/', 'sbfile://other/'), saved.src.replace('sbfile://', 'sbimg://'),
    saved.src.replace('.csv', '.exe'), saved.src.toUpperCase()]) {
    assert.deepEqual(await wb.getFilePath(src), { ok: false, error: 'Invalid file address' }, String(src));
  }
  const name = path.basename(saved.file);
  for (const bad of ['../config.json', name.toUpperCase(), name.replace('.csv', '.png'), name.slice(1), `x${name}`,
    `${name}/`, `/${name}`, '', null, undefined, 7]) {
    assert.equal(wb.filePath(bad), null, String(bad));
  }
  // A well-formed address of a file that was never kept, or is gone, is not found.
  assert.deepEqual(await wb.getFilePath(`sbfile://file/${'b'.repeat(32)}.pdf`), { ok: false, error: 'That file is no longer on this Mac' });
  fs.unlinkSync(saved.file);
  assert.deepEqual(await wb.getFilePath(saved.src), { ok: false, error: 'That file is no longer on this Mac' });
  // A folder where the file should be is not the file.
  fs.mkdirSync(saved.file);
  assert.deepEqual(await wb.getFilePath(saved.src), { ok: false, error: 'That file is no longer on this Mac' });
  fs.rmdirSync(saved.file);
});

test('copying and deleting a board leave its files where they are', async () => {
  const pdf = await wb.saveFile(new Uint8Array(PDF), 'pdf');
  const sheet = await wb.saveFile(new Uint8Array(TSV), 'tsv');
  const spec = {
    kind: 'flow',
    nodes: [
      { id: 'p', label: 'Example quarterly report', shape: 'pdf', file: pdf.src, position: { x: 0, y: 0 } },
      { id: 's', label: 'Example sales', shape: 'sheet', file: sheet.src, position: { x: 300, y: 0 } },
    ],
    edges: [],
  };
  const before = fs.readdirSync(filesDir()).sort();
  const made = await wb.create({ folderId: null, name: 'Files kept', spec });
  assert.equal(made.ok, true, made.error);
  const copy = await wb.duplicate(made.data.id);
  assert.equal(copy.ok, true, copy.error);
  assert.deepEqual(copy.data.spec.nodes.map(n => n.file), [pdf.src, sheet.src]);
  assert.equal((await wb.remove(made.data.id)).ok, true);
  assert.equal((await wb.remove(copy.data.id)).ok, true);
  assert.deepEqual(fs.readdirSync(filesDir()).sort(), before);
  assert.equal((await wb.getFilePath(pdf.src)).ok, true);
});

test('the thumbnail draws a PDF at its size (a Letter page with none) and a spreadsheet as a document\'s card', async () => {
  const thumb = async (name, nodes) => (await wb.create({ folderId: null, name, spec: { kind: 'flow', nodes, edges: [] } })).data.thumb;
  const picture = (id, size, position) => ({ id, label: 'Picture', shape: 'image', src: 'https://example.com/fictional.png', size, position });
  const at = [{ x: 0, y: 0 }, { x: 600, y: 100 }];

  assert.deepEqual(types.FLOW_PDF_DEFAULT_SIZE, { width: 240, height: 341 });
  assert.deepEqual(types.FLOW_SHEET_SIZE, { width: 240, height: 76 });
  const pdfs = await thumb('Thumb PDFs', [
    { id: 'a', label: 'Example quarterly report', shape: 'pdf', file: `sbfile://file/${'c'.repeat(32)}.pdf`, position: at[0] },
    { id: 'b', label: 'Example slides', shape: 'pdf', file: `sbfile://file/${'d'.repeat(32)}.pdf`, size: { width: 240, height: 165 }, position: at[1] },
  ]);
  assert.deepEqual(pdfs, await thumb('Thumb PDF pictures', [
    picture('a', types.FLOW_PDF_DEFAULT_SIZE, at[0]),
    picture('b', { width: 240, height: 165 }, at[1]),
  ]));

  // A spreadsheet is always the card: a size in the file changes nothing.
  const sheets = await thumb('Thumb sheets', [
    { id: 'a', label: 'Example sales', shape: 'sheet', file: `sbfile://file/${'e'.repeat(32)}.xlsx`, position: at[0] },
    { id: 'b', label: 'Example contacts', shape: 'sheet', file: `sbfile://file/${'f'.repeat(32)}.csv`, size: { width: 900, height: 900 }, position: at[1] },
  ]);
  assert.deepEqual(sheets, await thumb('Thumb sheet pictures', [
    picture('a', types.FLOW_SHEET_SIZE, at[0]),
    picture('b', types.FLOW_SHEET_SIZE, at[1]),
  ]));
  assert.deepEqual(sheets, await thumb('Thumb documents', [
    { id: 'a', label: 'Doc', shape: 'document', position: at[0] },
    { id: 'b', label: 'Doc', shape: 'document', position: at[1] },
  ]));
});

test('files Finder copied are read for a paste: a picture, a PDF or a spreadsheet, by extension and size', async () => {
  const dir = tempDir('paste');
  const at = name => path.join(dir, name);
  fs.writeFileSync(at('Example quarterly report.pdf'), PDF);
  fs.writeFileSync(at('Example sales.CSV'), CSV);
  fs.writeFileSync(at('Example chart.jpeg'), Buffer.from('ffd8ffe0', 'hex'));
  fs.writeFileSync(at('Example archive.zip'), ZIP);
  fs.mkdirSync(at('Example folder.pdf'));
  // Past a PDF's 100 MB without writing it: a sparse file.
  fs.writeFileSync(at('Example scan.pdf'), PDF);
  fs.truncateSync(at('Example scan.pdf'), files.FLOW_PDF_MAX_BYTES + 1);

  const read = await wb.readPastedFiles([
    at('Example quarterly report.pdf'), at('Example sales.CSV'), at('Example chart.jpeg'), at('Example archive.zip'),
    at('Example folder.pdf'), at('Example scan.pdf'), 'relative/Example.pdf', 42, at('Example missing.pdf'),
  ]);
  assert.deepEqual(read.map(entry => entry.name), [
    'Example quarterly report.pdf', 'Example sales.CSV', 'Example chart.jpeg', 'Example archive.zip',
    'Example scan.pdf', 'Example missing.pdf',
  ]);
  const [pdf, csv, jpeg, zip, scan, missing] = read;
  assert.equal(pdf.type, '');
  assert.deepEqual(Buffer.from(pdf.bytes), PDF);
  assert.deepEqual(Buffer.from(csv.bytes), CSV);
  assert.equal(jpeg.type, 'image/jpeg');
  assert.equal(jpeg.bytes.length, 4);
  // Anything else is its name alone, never read: the bundle refuses it by name.
  assert.deepEqual(zip, { name: 'Example archive.zip', type: '', bytes: null });
  assert.deepEqual(scan, { name: 'Example scan.pdf', error: 'Example scan.pdf is over 100 MB' });
  assert.match(missing.error, /^Couldn't read Example missing\.pdf: /);
  // And what comes back is what the bundle takes for a PDF and a spreadsheet.
  assert.equal(files.flowFileKind(pdf.name, pdf.type), 'pdf');
  assert.equal(files.flowFileKind(csv.name, csv.type), 'sheet');
  assert.equal(files.flowFileKind(zip.name, zip.type), null);
  assert.deepEqual(await wb.readPastedFiles(undefined), []);
  assert.equal((await wb.readPastedFiles(new Array(30).fill(at('Example sales.CSV')))).length, 20);
});

test('the copied files are read off a pasteboard as paths, in order, and only files that exist', { skip: process.platform !== 'darwin' && 'macOS only' }, async () => {
  const { execFileSync } = require('node:child_process');
  const drops = require('../src/main/drops');
  const dir = tempDir('copied');
  const report = path.join(dir, 'Example quarterly report.pdf');
  const sales = path.join(dir, 'Example sales, final.csv');
  // Past ASCII, read back whatever locale osascript runs in.
  const accented = path.join(dir, 'Exemple – résumé 報告.pdf');
  fs.writeFileSync(report, PDF);
  fs.writeFileSync(sales, CSV);
  fs.writeFileSync(accented, PDF);
  // A pasteboard of the test's own, never the clipboard: written as Finder writes one,
  // a file URL per item; the folder is a URL too, and is no file.
  const board = `local.switchboard.test.${process.pid}.${Date.now()}`;
  const write = `ObjC.import('AppKit');
function run(argv) {
  var pb = $.NSPasteboard.pasteboardWithName(argv[0]);
  pb.clearContents;
  var urls = [];
  for (var i = 1; i < argv.length; i++) urls.push($.NSURL.fileURLWithPath(argv[i]));
  return String(pb.writeObjects($(urls)));
}`;
  const release = `ObjC.import('AppKit'); function run(argv) { $.NSPasteboard.pasteboardWithName(argv[0]).releaseGlobally; return ''; }`;
  try {
    assert.equal(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', write, board, sales, dir, report, accented]).toString().trim(), 'true');
    const copied = await drops.readCopiedFiles(board);
    // The pasteboard's paths come decomposed (NFD); the disk takes either, and the name a
    // paste shows is composed again.
    assert.deepEqual(copied.map(p => p.normalize('NFC')), [sales, report, accented]);
    assert.deepEqual((await wb.readPastedFiles(copied)).map(entry => entry.name),
      ['Example sales, final.csv', 'Example quarterly report.pdf', 'Exemple – résumé 報告.pdf']);
    execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', write, board]);
    assert.deepEqual(await drops.readCopiedFiles(board), []);
  } finally {
    execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', release, board]);
  }
});
