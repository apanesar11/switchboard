#!/usr/bin/env node
'use strict';

// whiteboard.js — Switchboard's whiteboards from a terminal. A Claude Code skill runs
// it to draw a flowchart onto a board, or to change one, without the app's editor:
//
//   node scripts/whiteboard.js list [--here] [--archived] [--json]
//   node scripts/whiteboard.js folders
//   node scripts/whiteboard.js show <board>
//   node scripts/whiteboard.js check <spec.json | ->
//   node scripts/whiteboard.js create <spec.json | -> --name <name> [--folder <name>] [--workspace <id>]
//   node scripts/whiteboard.js update <board> <spec.json | -> [--allow-removals] [--dry-run]
//   node scripts/whiteboard.js new-document <file.md | ->
//
// <board> is a board's id, or its name (any case; a name in more than one folder needs
// --folder). `-` reads the spec from stdin. A spec is the flow spec the editor saves —
// src/diagrams/lib/diagrams/types.ts says what it holds — or `show`'s whole output,
// whose `spec` is taken.
//
// Every write goes through src/main/whiteboards.js, the store the app itself writes
// with, rooted where the app's is (beside SWITCHBOARD_CONFIG, or ~/.switchboard). A
// spec is first checked by the editor's own parser and laid out by its own layout
// (lib/diagrams/validate.ts, layout.ts — bundled here with esbuild), so nothing goes
// on disk that the canvas would refuse. The running app watches the store
// (whiteboards.watch()), so an open board takes the new drawing in as one undo step.
//
// `update` keeps the board as it was arranged: a box whose id survives keeps the
// position, size and styling it had wherever the new spec leaves them out
// (carryOverFlowLayout), and a spec that would drop boxes is refused unless
// --allow-removals says that is the point — a spec written from memory rather than
// from `show` would otherwise wipe the board.
//
// A PDF or a spreadsheet on a board is a file the app keeps (whiteboards/files/, named
// by its content and shared by every board), which only the app's editor adds — from
// a file dropped, pasted or picked. Here a "pdf" or "sheet" box is checked and kept as
// any other is, and its "file" must name one of those, as `show` gives it.

const fs = require('fs');
const path = require('path');
const Module = require('module');

const whiteboards = require('../src/main/whiteboards.js');
const workspaces = require('../src/main/workspaces.js');

const USAGE = `Usage:
  whiteboard.js list [--here] [--archived] [--json]   boards, the latest first
  whiteboard.js folders                              folders and how many boards each has
  whiteboard.js show <board>                         a board and its spec, as JSON
  whiteboard.js check <spec.json|->                  validate and lay out; writes nothing
  whiteboard.js create <spec.json|-> --name <name> [--folder <name>] [--workspace <id>]
  whiteboard.js update <board> <spec.json|-> [--allow-removals] [--dry-run]
  whiteboard.js new-document <file.md|->             a Markdown document a "document" box can show

<board> is an id or a name; --folder picks between boards of one name.
--here keeps the boards whose workspace is the one this directory is in.
A "pdf" or "sheet" box shows a file the app keeps, which only the app takes in (drop,
paste or pick one onto a board there); a spec keeps such a box as \`show\` gives it.`;

class Refusal extends Error {}

// ── the editor's own parser and layout ─────────────────────────────────────

let lib = null;
function editorLib() {
  if (lib) return lib;
  const esbuild = require('esbuild');
  const dir = path.join(__dirname, '..', 'src', 'diagrams', 'lib', 'diagrams');
  const out = esbuild.buildSync({
    stdin: {
      contents: [
        'export { parseDiagramSpec } from "./validate"',
        'export { layoutDiagram } from "./layout"',
        'export { carryOverFlowLayout } from "./flow-editor"',
        'export { VIDEO_LABEL, PDF_LABEL, SHEET_LABEL } from "./types"',
      ].join('\n'),
      resolveDir: dir,
      loader: 'ts',
      sourcefile: 'whiteboard-cli.ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    logLevel: 'error',
  });
  const file = path.join(dir, 'whiteboard-cli.js');
  const mod = new Module(file, module);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(dir);
  mod._compile(out.outputFiles[0].text, file);
  lib = mod.exports;
  return lib;
}

// ── arguments and input ────────────────────────────────────────────────────

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-' || !arg.startsWith('--')) { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (['here', 'archived', 'json', 'allow-removals', 'dry-run', 'help'].includes(name)) { flags[name] = true; continue; }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) throw new Refusal(`--${name} needs a value`);
    flags[name] = value;
  }
  return { positional, flags };
}

function readInput(source) {
  if (!source) throw new Refusal('Name a spec file, or - to read it from stdin');
  try {
    return fs.readFileSync(source === '-' ? 0 : source, 'utf8');
  } catch (err) {
    throw new Refusal(`Could not read ${source === '-' ? 'stdin' : source}: ${err.message}`);
  }
}

/** A spec from a file or stdin: a bare spec, or `show`'s output (its `spec`). */
function readSpec(source) {
  const text = readInput(source);
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Refusal(`That spec is not valid JSON: ${err.message}`);
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.spec && typeof raw.spec === 'object') raw = raw.spec;
  return checked(raw);
}

/** Validated by the editor's parser and laid out, or a Refusal saying what is wrong. */
function checked(raw) {
  const { parseDiagramSpec, layoutDiagram } = editorLib();
  const parsed = parseDiagramSpec(raw);
  if (!parsed.ok) throw new Refusal(`The spec is not valid: ${parsed.error}`);
  let layout;
  try {
    layout = layoutDiagram(parsed.value);
  } catch (err) {
    throw new Refusal(`The spec could not be laid out: ${err.message}`);
  }
  return { spec: parsed.value, layout };
}

function unwrap(result, what) {
  if (!result || !result.ok) throw new Refusal(`${what}: ${(result && result.error) || 'no answer'}`);
  return result.data;
}

// ── boards, folders and workspaces ─────────────────────────────────────────

async function index() {
  return unwrap(await whiteboards.list(), 'Could not list the whiteboards');
}

function folderName(idx, folderId) {
  const folder = folderId ? idx.folders.find(f => f.id === folderId) : null;
  return folder ? folder.name : 'No folder';
}

function findFolder(idx, name) {
  const want = String(name).trim().toLowerCase();
  if (want === 'no folder' || want === '') return { id: null, name: 'No folder' };
  return idx.folders.find(f => f.name.toLowerCase() === want) || null;
}

/** The board `ref` names: an id, or a name (exactly, then as part of one). */
async function findBoard(ref, folder) {
  if (!ref) throw new Refusal('Name a board: its id, or its name');
  const idx = await index();
  const byId = idx.boards.find(b => b.id === String(ref).toLowerCase());
  if (byId) return { board: byId, idx };
  let boards = idx.boards;
  if (folder !== undefined) {
    const f = findFolder(idx, folder);
    if (!f) throw new Refusal(`There is no folder called "${folder}"`);
    boards = boards.filter(b => b.folderId === f.id);
  }
  const want = String(ref).trim().toLowerCase();
  const pick = list => {
    const live = list.filter(b => !b.archivedAt);
    return live.length ? live : list;
  };
  let hits = pick(boards.filter(b => b.name.toLowerCase() === want));
  if (!hits.length) hits = pick(boards.filter(b => b.name.toLowerCase().includes(want)));
  if (hits.length === 1) return { board: hits[0], idx };
  if (!hits.length) throw new Refusal(`No whiteboard is called "${ref}". \`list\` shows them all.`);
  const lines = hits.map(b => `  ${b.name}  (${folderName(idx, b.folderId)})  ${b.id}`);
  throw new Refusal(`"${ref}" could be any of these — give the id, or --folder:\n${lines.join('\n')}`);
}

/** The rail workspace this directory is in — the deepest one that holds it — or null. */
async function workspaceHere() {
  let list = [];
  try { list = await workspaces.discover(); } catch (_) {}
  const here = fs.realpathSync(process.cwd());
  let best = null;
  for (const ws of Array.isArray(list) ? list : []) {
    if (!ws || typeof ws.dir !== 'string') continue;
    let dir;
    try { dir = fs.realpathSync(ws.dir); } catch (_) { continue; }
    if ((here === dir || here.startsWith(dir + path.sep)) && (!best || dir.length > best.dir.length)) best = { id: ws.id, dir };
  }
  return best ? best.id : null;
}

function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function shapeCount(spec) {
  const nodes = (spec && spec.nodes) || [];
  return `${nodes.length} node${nodes.length === 1 ? '' : 's'}, ${((spec && spec.edges) || []).length} arrow${((spec && spec.edges) || []).length === 1 ? '' : 's'}`;
}

function describeNode(node) {
  if (node.shape === 'terminal') return `the pinned ${node.workspace || node.label} terminal`;
  if (node.shape === 'teleport') return `${node.id} (a teleport${node.teleportTo ? ` to ${node.teleportTo}` : ''})`;
  const label = String(node.label || '').replace(/\s+/g, ' ').trim();
  const quoted = label.length > 40 ? label.slice(0, 39) + '…' : label;
  // A video's label is its title, or the words every untitled video has.
  if (node.shape === 'video') return `${node.id} (a YouTube video${label && label !== editorLib().VIDEO_LABEL ? ` "${quoted}"` : ''})`;
  // A PDF's and a spreadsheet's is its file's name, or the word every unnamed one has.
  if (node.shape === 'pdf') return `${node.id} (a PDF${label && label !== editorLib().PDF_LABEL ? ` "${quoted}"` : ''})`;
  if (node.shape === 'sheet') return `${node.id} (a spreadsheet${label && label !== editorLib().SHEET_LABEL ? ` "${quoted}"` : ''})`;
  return `${node.id}${label ? ` ("${quoted}")` : ''}`;
}

// ── commands ───────────────────────────────────────────────────────────────

async function list(flags) {
  const idx = await index();
  let boards = idx.boards.filter(b => flags.archived || !b.archivedAt);
  let note = '';
  if (flags.here) {
    const ws = await workspaceHere();
    if (!ws) throw new Refusal('This directory is in none of the rail\'s workspaces');
    boards = boards.filter(b => b.workspace === ws);
    note = ` reading ${ws}`;
  }
  if (flags.json) {
    console.log(JSON.stringify(boards.map(b => ({
      id: b.id, name: b.name, folder: folderName(idx, b.folderId), workspace: b.workspace,
      boxes: b.boxes, updatedAt: b.updatedAt, archived: !!b.archivedAt,
    })), null, 2));
    return;
  }
  if (!boards.length) { console.log(`No whiteboards${note}.`); return; }
  console.log(`${boards.length} whiteboard${boards.length === 1 ? '' : 's'}${note}, the latest first:`);
  for (const b of boards) {
    const bits = [folderName(idx, b.folderId), b.workspace ? `reads ${b.workspace}` : 'no workspace', `${b.boxes} box${b.boxes === 1 ? '' : 'es'}`, `saved ${ago(b.updatedAt)}`];
    if (b.archivedAt) bits.push('archived');
    console.log(`  ${b.name}  ·  ${bits.join(' · ')}  ·  ${b.id}`);
  }
}

async function folders() {
  const idx = await index();
  const loose = idx.boards.filter(b => !b.folderId && !b.archivedAt).length;
  for (const f of idx.folders) console.log(`  ${f.name}  ·  ${f.count} board${f.count === 1 ? '' : 's'}`);
  console.log(`  No folder  ·  ${loose} board${loose === 1 ? '' : 's'}`);
}

async function show(positional, flags) {
  const { board, idx } = await findBoard(positional[0], flags.folder);
  const data = unwrap(await whiteboards.get(board.id), `Could not read "${board.name}"`);
  console.log(JSON.stringify({
    id: data.id,
    name: data.name,
    folder: folderName(idx, data.folderId),
    workspace: data.workspace,
    updatedAt: data.updatedAt,
    archived: !!data.archivedAt,
    spec: data.spec,
  }, null, 2));
}

async function check(positional) {
  const { spec, layout } = readSpec(positional[0]);
  console.log(`Valid: ${shapeCount(spec)}, laid out ${Math.round(layout.width)}×${Math.round(layout.height)}.`);
}

async function create(positional, flags) {
  if (!flags.name) throw new Refusal('A new whiteboard needs --name');
  const { spec } = readSpec(positional[0]);
  const idx = await index();
  let folderId = null;
  let madeFolder = false;
  if (flags.folder !== undefined) {
    const found = findFolder(idx, flags.folder);
    if (found) folderId = found.id;
    else {
      folderId = unwrap(await whiteboards.createFolder(flags.folder), `Could not make the folder "${flags.folder}"`).id;
      madeFolder = true;
    }
  }
  // The board reads the workspace this terminal is in, unless told otherwise; outside
  // every workspace, the one ✦ Answer used last (main's own default).
  const workspace = flags.workspace === 'none' ? null : flags.workspace !== undefined ? flags.workspace : (await workspaceHere()) || undefined;
  const made = unwrap(await whiteboards.create({ folderId, name: flags.name, spec, ...(workspace === undefined ? {} : { workspace }) }), 'Could not create the whiteboard');
  await whiteboards.settle();
  console.log(`Created "${made.name}" in ${madeFolder ? 'the new folder ' : ''}${folderName(await index(), made.folderId)}: ${shapeCount(spec)}${made.workspace ? `, reading ${made.workspace}` : ''}.`);
  console.log(`id ${made.id} — open it from Whiteboards in Switchboard.`);
}

async function update(positional, flags) {
  const { board } = await findBoard(positional[0], flags.folder);
  const { parseDiagramSpec, carryOverFlowLayout } = editorLib();
  const data = unwrap(await whiteboards.get(board.id), `Could not read "${board.name}"`);
  const before = parseDiagramSpec(data.spec);
  const previous = before.ok ? before.value : { kind: 'flow', nodes: Array.isArray(data.spec && data.spec.nodes) ? data.spec.nodes : [], edges: [] };
  const { spec: next } = readSpec(positional[1]);

  const key = node => String(node.id).toLowerCase();
  const kept = new Set(next.nodes.map(key));
  const gone = previous.nodes.filter(node => !kept.has(key(node)));
  if (gone.length && !flags['allow-removals']) {
    throw new Refusal(`That would remove ${gone.length} of "${board.name}"'s nodes: ${gone.map(describeNode).join(', ')}.\n` +
      'Start from `show`, keep every node you are not removing, or pass --allow-removals when removing them is the point.');
  }
  const merged = checked(carryOverFlowLayout(previous, next).spec).spec;
  const old = new Map(previous.nodes.map(node => [key(node), JSON.stringify(node)]));
  const added = merged.nodes.filter(node => !old.has(key(node))).length;
  const changed = merged.nodes.filter(node => old.has(key(node)) && old.get(key(node)) !== JSON.stringify(node)).length;
  const parts = [`${added} added`, `${changed} changed`, `${gone.length} removed`];
  if (flags['dry-run']) {
    console.log(`Would update "${board.name}": ${parts.join(', ')} — ${shapeCount(merged)}. Nothing written.`);
    return;
  }
  unwrap(await whiteboards.saveSpec(board.id, merged), `Could not save "${board.name}"`);
  await whiteboards.settle();
  console.log(`Updated "${board.name}": ${parts.join(', ')} — ${shapeCount(merged)} now.`);
  console.log('Open in Switchboard, it redraws as it lands; Undo there puts back what it showed before.');
}

async function newDocument(positional) {
  const text = readInput(positional[0]);
  const doc = unwrap(await whiteboards.createDocument(text), 'Could not create the document');
  await whiteboards.settle();
  const title = (/^#\s+(.+)$/m.exec(text) || [])[1];
  console.log(`Document ${doc.id}`);
  console.log(`Put it on a board as { "id": "…", "shape": "document", "documentId": "${doc.id}", "label": ${JSON.stringify((title || 'Document').trim())} }.`);
}

async function main(argv) {
  const [command, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  if (!command || command === 'help' || command === '--help' || flags.help) { console.log(USAGE); return; }
  switch (command) {
    case 'list': return list(flags);
    case 'folders': return folders();
    case 'show': return show(positional, flags);
    case 'check': return check(positional);
    case 'create': return create(positional, flags);
    case 'update': return update(positional, flags);
    case 'new-document': return newDocument(positional);
    default: throw new Refusal(`Unknown command "${command}"\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch(err => {
  console.error(err instanceof Refusal ? `whiteboard: ${err.message}` : err.stack || String(err));
  process.exitCode = 1;
});
