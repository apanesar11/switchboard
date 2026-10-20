'use strict';

// npm run test:diagrams — which files a whiteboard takes as a PDF or a spreadsheet
// (src/diagrams/lib/diagrams/files.ts): the extension a dropped file's name or type
// gives it, why one is refused, the sbfile address a node names it by and only that
// one, the label and the card's subtitle made from it, a sheet's column letters, the
// size a PDF goes onto the canvas at from its cover, and whether pasted words are the
// names of files Finder copied. The module is TypeScript with no dependencies but
// types.ts, so it is bundled here with esbuild, as test-youtube.js bundles youtube.ts,
// and required as CommonJS.
//
// Every file name and address here is made up (AGENTS.md).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const esbuild = require('esbuild');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-flow-files-'));
const outfile = path.join(temp, 'files.js');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'diagrams', 'lib', 'diagrams', 'files.ts')],
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'error',
});
const {
  FLOW_FILE_EXTENSIONS,
  FLOW_FILE_ACCEPT,
  FLOW_PDF_MAX_BYTES,
  FLOW_SHEET_MAX_BYTES,
  flowFileExtension,
  flowFileKind,
  flowFileProblem,
  parseFlowFileSrc,
  flowFileLabel,
  sheetFormatName,
  sheetColumnName,
  flowPdfSize,
  flowLooksLikeCopiedFiles,
} = require(outfile);

after(() => fs.rmSync(temp, { recursive: true, force: true }));

const MB = 1024 * 1024;
const HEX = '0123456789abcdef0123456789abcdef';
const SHEETS = ['xlsx', 'xlsm', 'xlsb', 'xls', 'ods', 'numbers', 'csv', 'tsv'];

test('a whiteboard keeps PDFs and eight kinds of spreadsheet, and the picker offers exactly those', () => {
  assert.deepEqual(
    { ...FLOW_FILE_EXTENSIONS },
    { pdf: 'pdf', ...Object.fromEntries(SHEETS.map((ext) => [ext, 'sheet'])) },
  );
  assert.equal(FLOW_FILE_ACCEPT, '.pdf,.xlsx,.xlsm,.xlsb,.xls,.ods,.numbers,.csv,.tsv');
  assert.equal(FLOW_PDF_MAX_BYTES, 100 * MB);
  assert.equal(FLOW_SHEET_MAX_BYTES, 50 * MB);
});

// [name, type, the extension it is] — null: neither a PDF nor a spreadsheet.
const EXTENSIONS = [
  ['Example quarterly report.pdf', '', 'pdf'],
  ['Example quarterly report.PDF', '', 'pdf'],
  ['  Example handout.pdf  ', '', 'pdf'],
  ['Example budget.xlsx', '', 'xlsx'],
  ['Example macros.XLSM', '', 'xlsm'],
  ['Example binary.xlsb', '', 'xlsb'],
  ['Example legacy.xls', '', 'xls'],
  ['Example open.ods', '', 'ods'],
  ['Example plan.numbers', '', 'numbers'],
  ['Example export.csv', '', 'csv'],
  ['Example export.tsv', '', 'tsv'],
  // Only the last extension counts.
  ['Example archive.v2.xlsx', '', 'xlsx'],
  ['Example export.csv.pdf', '', 'pdf'],
  // The extension wins over the type a browser guessed.
  ['Example export.csv', 'application/vnd.ms-excel', 'csv'],
  ['Example scan.pdf', 'application/octet-stream', 'pdf'],
  // No extension it knows: the type says what it is.
  ['Example scan', 'application/pdf', 'pdf'],
  ['Example scan', 'APPLICATION/PDF', 'pdf'],
  ['Example export', 'text/csv; charset=utf-8', 'csv'],
  ['Example export.txt', 'text/csv', 'csv'],
  ['Example data', 'text/tab-separated-values', 'tsv'],
  ['Example budget', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['Example macros', 'application/vnd.ms-excel.sheet.macroEnabled.12', 'xlsm'],
  ['Example binary', 'application/vnd.ms-excel.sheet.binary.macroEnabled.12', 'xlsb'],
  ['Example legacy', 'application/vnd.ms-excel', 'xls'],
  ['Example open', 'application/vnd.oasis.opendocument.spreadsheet', 'ods'],
  ['Example plan', 'application/vnd.apple.numbers', 'numbers'],
  ['Example plan', 'application/x-iwork-numbers-sffnumbers', 'numbers'],
  // Neither.
  ['Example photo.png', 'image/png', null],
  ['Example notes.txt', 'text/plain', null],
  ['Example notes.md', '', null],
  ['Example page.html', 'text/html', null],
  ['Example archive.tar.gz', 'application/gzip', null],
  ['Example scan', '', null],
  ['pdf', '', null],
  ['Example.pdf.', '', null],
  ['', '', null],
  // Object's own keys are never extensions or types.
  ['Example.constructor', '', null],
  ['Example.toString', '', null],
  ['Example', 'constructor', null],
  ['Example', '__proto__', null],
];

for (const [name, type, expected] of EXTENSIONS) {
  test(`${JSON.stringify(name)} (${JSON.stringify(type)}) is ${expected ?? 'neither'}`, () => {
    assert.equal(flowFileExtension(name, type), expected);
    assert.equal(flowFileKind(name, type), expected === null ? null : expected === 'pdf' ? 'pdf' : 'sheet');
  });
}

test('the type is optional', () => {
  assert.equal(flowFileExtension('Example quarterly report.pdf'), 'pdf');
  assert.equal(flowFileKind('Example budget.xlsx'), 'sheet');
  assert.equal(flowFileKind('Example photo.jpg'), null);
});

test('a file is refused for being something else, empty, or past its kind\'s size — and only then', () => {
  const file = (name, size, type = '') => ({ name, size, type });
  assert.equal(flowFileProblem(file('Example quarterly report.pdf', 2 * MB)), null);
  assert.equal(flowFileProblem(file('Example budget.xlsx', 2 * MB)), null);
  assert.equal(flowFileProblem(file('Example scan', 1, 'application/pdf')), null);
  assert.equal(flowFileProblem(file('Example quarterly report.pdf', 100 * MB)), null);
  assert.equal(flowFileProblem(file('Example budget.xlsx', 50 * MB)), null);

  assert.equal(flowFileProblem(file('Example photo.png', 10, 'image/png')), "Example photo.png isn't a PDF or a spreadsheet");
  assert.equal(flowFileProblem(file('', 10)), "That file isn't a PDF or a spreadsheet");
  assert.equal(flowFileProblem(file('Example quarterly report.pdf', 0)), 'Example quarterly report.pdf is empty');
  assert.equal(flowFileProblem(file('Example quarterly report.pdf', 100 * MB + 1)), 'Example quarterly report.pdf is over 100 MB');
  // A spreadsheet's limit is its own, half a PDF's.
  assert.equal(flowFileProblem(file('Example budget.xlsx', 50 * MB + 1)), 'Example budget.xlsx is over 50 MB');
  assert.equal(flowFileProblem(file('Example export.csv', 60 * MB)), 'Example export.csv is over 50 MB');
  assert.equal(flowFileProblem(file('', 0, 'application/pdf')), 'That file is empty');
});

test('a file address is sbfile://file/, 32 lowercase hex and an extension a whiteboard keeps', () => {
  assert.deepEqual(parseFlowFileSrc(`sbfile://file/${HEX}.pdf`), { name: `${HEX}.pdf`, ext: 'pdf', kind: 'pdf' });
  for (const ext of SHEETS) {
    assert.deepEqual(parseFlowFileSrc(`sbfile://file/${HEX}.${ext}`), { name: `${HEX}.${ext}`, ext, kind: 'sheet' }, ext);
  }
});

test('nothing else is a file address', () => {
  const NOT = [
    `sbfile://file/${HEX.toUpperCase()}.pdf`,
    `sbfile://file/${HEX.slice(1)}.pdf`,
    `sbfile://file/${HEX}0.pdf`,
    `sbfile://file/${HEX}.PDF`,
    `sbfile://file/${HEX}.png`,
    `sbfile://file/${HEX}.exe`,
    `sbfile://file/${HEX}.constructor`,
    `sbfile://file/${HEX}`,
    `sbfile://file/${HEX}.pdf/`,
    `sbfile://file/${HEX}.pdf?page=2`,
    `sbfile://file/${HEX}.pdf#page=2`,
    ` sbfile://file/${HEX}.pdf`,
    `sbfile://file/${HEX}.pdf\n`,
    `sbfile://file/../${HEX}.pdf`,
    `sbfile://file/sub/${HEX}.pdf`,
    `sbfile://image/${HEX}.pdf`,
    `sbimg://image/${HEX}.png`,
    `SBFILE://file/${HEX}.pdf`,
    `file:///Users/example/${HEX}.pdf`,
    `https://example.com/${HEX}.pdf`,
    '',
  ];
  for (const src of NOT) assert.equal(parseFlowFileSrc(src), null, JSON.stringify(src));
  for (const src of [null, undefined, 42, {}, [`sbfile://file/${HEX}.pdf`]]) assert.equal(parseFlowFileSrc(src), null);
});

test('a label is the file name without its extension, on one line, at most 200 characters', () => {
  assert.equal(flowFileLabel('Example quarterly report.pdf', 'pdf'), 'Example quarterly report');
  assert.equal(flowFileLabel('Example budget.xlsx', 'sheet'), 'Example budget');
  assert.equal(flowFileLabel('Example archive.v2.xlsx', 'sheet'), 'Example archive.v2');
  assert.equal(flowFileLabel('Example notes', 'pdf'), 'Example notes');
  assert.equal(flowFileLabel('  Example   spaced\tout\nname .csv', 'sheet'), 'Example spaced out name');
  assert.equal(flowFileLabel('Example\u0000hidden\u007fbytes.pdf', 'pdf'), 'Example hidden bytes');
  // The extension goes even with space after it, as flowFileExtension still reads it.
  assert.equal(flowFileLabel('Example trailing.csv ', 'sheet'), 'Example trailing');
  assert.equal(flowFileLabel('Example trailing.pdf\n', 'pdf'), 'Example trailing');
  // Counted in characters, never in UTF-16 halves: an emoji is never cut in two.
  assert.equal(flowFileLabel(`${'😀'.repeat(250)}.pdf`, 'pdf'), '😀'.repeat(200));
  assert.equal(flowFileLabel(`${'a'.repeat(199)} b.pdf`, 'pdf'), 'a'.repeat(199));
  assert.equal(Array.from(flowFileLabel(`${'x'.repeat(500)}.csv`, 'sheet')).length, 200);
});

test('a name that leaves nothing is labelled PDF or Spreadsheet', () => {
  assert.equal(flowFileLabel('.pdf', 'pdf'), 'PDF');
  assert.equal(flowFileLabel('', 'pdf'), 'PDF');
  assert.equal(flowFileLabel('   .xlsx', 'sheet'), 'Spreadsheet');
  assert.equal(flowFileLabel('\n\t.csv', 'sheet'), 'Spreadsheet');
});

test('a spreadsheet card says what kind of file it is', () => {
  assert.equal(sheetFormatName('csv'), 'CSV file');
  assert.equal(sheetFormatName('tsv'), 'TSV file');
  assert.equal(sheetFormatName('ods'), 'OpenDocument spreadsheet');
  assert.equal(sheetFormatName('numbers'), 'Numbers spreadsheet');
  for (const ext of ['xlsx', 'xlsm', 'xlsb', 'xls']) assert.equal(sheetFormatName(ext), 'Excel spreadsheet', ext);
});

test('columns are lettered as a spreadsheet letters them', () => {
  const cases = [
    [0, 'A'], [1, 'B'], [25, 'Z'], [26, 'AA'], [27, 'AB'], [51, 'AZ'], [52, 'BA'],
    [701, 'ZZ'], [702, 'AAA'], [703, 'AAB'], [18277, 'ZZZ'],
    // Excel's last column.
    [16383, 'XFD'],
  ];
  for (const [index, name] of cases) assert.equal(sheetColumnName(index), name, String(index));
  // Never anything but letters, whatever it is handed.
  assert.equal(sheetColumnName(-3), 'A');
  assert.equal(sheetColumnName(2.7), 'C');
});

test('the letters run on without a gap or a repeat', () => {
  const seen = new Set();
  let previous = '';
  for (let i = 0; i < 1000; i++) {
    const name = sheetColumnName(i);
    assert.match(name, /^[A-Z]+$/);
    assert.ok(name.length > previous.length || (name.length === previous.length && name > previous), `${previous} → ${name}`);
    seen.add(name);
    previous = name;
  }
  assert.equal(seen.size, 1000);
});

test('a PDF goes on 240 wide at its cover\'s shape, over the bar, held between a slide and a receipt', () => {
  // A US Letter page as Quick Look draws it at 600.
  assert.deepEqual(flowPdfSize({ width: 619, height: 800 }), { width: 240, height: 310 + 30 });
  // A slide.
  assert.deepEqual(flowPdfSize({ width: 1600, height: 900 }), { width: 240, height: 135 + 30 });
  // A banner far wider than tall: no shorter than 120 above the bar.
  assert.deepEqual(flowPdfSize({ width: 6000, height: 100 }), { width: 240, height: 120 + 30 });
  // A long receipt: no taller than 600 above the bar.
  assert.deepEqual(flowPdfSize({ width: 100, height: 10000 }), { width: 240, height: 600 + 30 });
});

test('a PDF with no cover, or a cover with no size, goes on at the default size — a copy of it', () => {
  const defaults = { width: 240, height: 341 };
  for (const cover of [undefined, null, { width: 0, height: 800 }, { width: 600, height: 0 }, { width: -5, height: 800 }, { width: NaN, height: 800 }, { width: 600, height: NaN }]) {
    assert.deepEqual(flowPdfSize(cover), defaults, JSON.stringify(cover));
  }
  const one = flowPdfSize();
  one.width = 1;
  assert.deepEqual(flowPdfSize(), defaults);
});

test('words are taken for files Finder copied only when every line is a file\'s name', () => {
  for (const text of ['Example quarterly report.pdf', 'Example sales.xlsx\rExample chart.png', 'Example a.csv\nExample b.tsv\n',
    'Example archive.zip', ' Example notes.numbers \r\n']) {
    assert.equal(flowLooksLikeCopiedFiles(text), true, JSON.stringify(text));
  }
  for (const text of ['', '   ', 'Example quarterly report', 'see Example.pdf and more words.', 'https://example.com/Example.pdf',
    '.pdf', 'Example.pdf\nnot a name', '/Users/example/Example.pdf', Array(21).fill('Example.pdf').join('\n'), `${'x'.repeat(260)}.pdf`]) {
    assert.equal(flowLooksLikeCopiedFiles(text), false, JSON.stringify(text));
  }
});
