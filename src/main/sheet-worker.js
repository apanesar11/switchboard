'use strict';

// sheet-worker.js — reads one spreadsheet, off main's thread. ARCHITECTURE §4.17.
//
// sheets.js starts one of these per file it has to read, with the file's path and
// extension as workerData, a capped heap of its own and a time limit, and terminates it
// once it has answered — so a workbook too big or too strange to read takes down this
// thread and nothing else. The reading is sheets.js's readBook(); the answer is its
// result, with every sheet's offsets handed over rather than copied.

const { parentPort, workerData } = require('worker_threads');
const sheets = require('./sheets.js');

const data = workerData || {};
(async () => {
  let answer;
  try {
    answer = await sheets.readBook(data.file, data.ext);
  } catch (err) {
    // readBook answers rather than throws; this is a bug's last stop, still a sentence.
    console.error('[switchboard] sheets: the reader failed:', String((err && err.message) || err).slice(0, 200));
    answer = { ok: false, error: "That spreadsheet can't be read here" };
  }
  const transfer = answer.ok ? answer.sheets.flatMap(s => [s.offsets.buffer, s.rowStart.buffer]) : [];
  parentPort.postMessage(answer, transfer);
})();
