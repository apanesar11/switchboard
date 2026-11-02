#!/usr/bin/env node
'use strict';

// widget.js — Switchboard's whiteboard widgets from a terminal. An agent runs it (the
// switchboard-create-widget skill) to make a widget, check it, and put it on a board;
// the user runs set-secret to hand the widget its API key without the key ever passing
// through the agent:
//
//   node scripts/widget.js list [--json]
//   node scripts/widget.js create <id> --name <name> [--width N --height N] [--api <baseUrl>] [--secret <NAME>]
//   node scripts/widget.js check <id>
//   node scripts/widget.js set-secret <id> [NAME]        the key on stdin, never as an argument
//   node scripts/widget.js add <id> --board <board> [--folder <name>] [--x N --y N] [--width N --height N]
//   node scripts/widget.js remove <id> [--yes]
//
// A widget is a folder, <config dir>/widgets/<id>/ — beside SWITCHBOARD_CONFIG, or in
// ~/.switchboard — holding widget.json and the widget's own HTML, CSS and JavaScript
// (src/main/widgets.js says what the app does with it). Everything here goes through that
// module and src/main/whiteboards.js, rooted where the running app's are, and the app
// watches both: a widget's frame loads again as its files are saved, and a board takes a
// widget added to it as one undo step.
//
// set-secret reads the key from stdin only — typed with no echo on a terminal, or piped
// from the clipboard (`pbpaste | …` on a Mac, `powershell -NoProfile -Command
// Get-Clipboard | …` on Windows: pasteCommand) — so it never lands in an argument list, a
// shell's history or an agent's transcript. Plain node can't reach the system's keychain,
// so the key is written to a pending file only the user can read
// (widget-secrets.pending.json, mode 0600), with the API origin it was given for, and the
// app encrypts it into its own keys file and takes it out of the pending one as soon as
// it sees it.

const fs = require('fs');
const path = require('path');

const widgets = require('../src/main/widgets.js');
const whiteboards = require('../src/main/whiteboards.js');
const board = require('./whiteboard.js');

const { Refusal } = board;

/**
 * The command that hands the key on the clipboard to set-secret, on this system — piped,
 * so it works where a hidden prompt can't (a `!` command in an agent's session has no
 * terminal to type into).
 */
function pasteCommand(id) {
  const cli = `node scripts/widget.js set-secret ${id}`;
  if (process.platform === 'win32') return `powershell -NoProfile -Command Get-Clipboard | ${cli}`;
  if (process.platform === 'darwin') return `pbpaste | ${cli}`;
  return `xclip -selection clipboard -o | ${cli}`;
}

const USAGE = `Usage:
  widget.js list [--json]                      the installed widgets
  widget.js create <id> --name <name> [--width N --height N] [--api <baseUrl>] [--secret <NAME>]
                                               a new widget: widget.json and a starter index.html
  widget.js check <id>                         validate it; list its files; say whether its key is kept
  widget.js set-secret <id> [NAME]             its API key, read from stdin (typed hidden, or piped)
  widget.js add <id> --board <board> [--folder <name>] [--x N --y N] [--width N --height N]
                                               put it on a whiteboard
  widget.js remove <id> [--yes]                move its folder aside and forget its key

<id> is lowercase letters, digits and dashes, starting with a letter.
<board> is a board's id or name; --folder picks between boards of one name.
Never pass a key as an argument: set-secret reads it from stdin — typed at its hidden
prompt in a terminal, or piped from the clipboard:
  ${pasteCommand('<id>')}`;

const BOOLEAN_FLAGS = new Set(['json', 'yes', 'help']);
// Where `add` puts a widget when told nothing: this far right of what is on the board.
const ADD_GAP = 80;
const ADD_ORIGIN = { x: 80, y: 80 };
const FILES_SHOWN = 200;

// ── arguments and input ────────────────────────────────────────────────────

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-' || !arg.startsWith('--')) { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (BOOLEAN_FLAGS.has(name)) { flags[name] = true; continue; }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) throw new Refusal(`--${name} needs a value`);
    flags[name] = value;
  }
  return { positional, flags };
}

function widgetId(raw) {
  const id = String(raw || '').trim();
  if (!id) throw new Refusal('Name a widget: its id, like weather');
  if (!widgets.isWidgetId(id)) throw new Refusal(`"${id}" isn't a widget id: lowercase letters, digits and dashes, starting with a letter, at most 63 characters`);
  return id;
}

function number(flags, name) {
  if (flags[name] === undefined) return undefined;
  const value = Number(flags[name]);
  if (!Number.isFinite(value)) throw new Refusal(`--${name} must be a number`);
  return Math.round(value);
}

function manifestOf(id) {
  const read = widgets.readManifest(id);
  if (!read.ok) {
    if (read.code === 'missing') throw new Refusal(`There is no widget called "${id}" — \`create\` makes one, \`list\` shows them`);
    throw new Refusal(read.error);
  }
  return read;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

/** Every board that shows a widget, by widget id: [{ id, name, folder }]. */
async function boardsByWidget() {
  const idx = await board.index();
  const uses = new Map();
  for (const b of idx.boards) {
    const got = await whiteboards.get(b.id);
    if (!got.ok) continue;
    const nodes = got.data.spec && Array.isArray(got.data.spec.nodes) ? got.data.spec.nodes : [];
    const seen = new Set();
    for (const node of nodes) {
      if (!node || node.shape !== 'widget' || typeof node.widget !== 'string' || seen.has(node.widget)) continue;
      seen.add(node.widget);
      if (!uses.has(node.widget)) uses.set(node.widget, []);
      uses.get(node.widget).push({ id: b.id, name: b.name, folder: board.folderName(idx, b.folderId), archived: !!b.archivedAt });
    }
  }
  return uses;
}

function keyWords(where) {
  if (where === 'stored') return 'key kept (encrypted)';
  if (where === 'pending') return 'key waiting for Switchboard to encrypt it';
  if (where === 'elsewhere') return 'key kept for another API, so not sent — the user gives it again';
  return 'no key yet';
}

// ── the starter page ───────────────────────────────────────────────────────

/**
 * A widget's first index.html: responsive (it fills its frame, its type sized by the
 * frame through container units), light or dark as the board is (the SDK keeps
 * data-theme on <html>), and either a clock or, with an API, one request through the
 * host's fetch — a page to replace, written so the agent sees every part of the SDK.
 */
function starterPage(name, api) {
  const fetchPart = `
    // Data comes through Switchboard.fetch: the app adds the key and talks only to
    // widget.json's api.baseUrl. Replace "status" with the endpoint under it.
    function load() {
      label.textContent = 'Loading…';
      Switchboard.fetch('status', { query: {} })
        .then(function (res) {
          if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
          var data = res.json();
          value.textContent = Object.keys(data).length + ' fields';
          label.textContent = ${JSON.stringify(name)};
        })
        .catch(function (error) {
          value.textContent = '—';
          label.textContent = error.message;
        });
    }
    Switchboard.ready().then(load);
    Switchboard.onRefresh(load);`;
  const clockPart = `
    function tick() {
      value.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    tick();
    setInterval(tick, 1000);
    Switchboard.ready();`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(name)}</title>
  <!-- The app's SDK: window.Switchboard (ready, fetch, onTheme, onResize, onRefresh). -->
  <script src="/__switchboard/widget.js"></script>
  <style>
    :root { --bg: #ffffff; --fg: #111827; --muted: #6b7280; --accent: #4f46e5; }
    [data-theme="dark"] { --bg: #111827; --fg: #f3f4f6; --muted: #9ca3af; --accent: #a5b4fc; }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      display: grid; place-items: center; overflow: hidden;
      background: var(--bg); color: var(--fg);
      font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      container-type: size;
    }
    main { display: grid; gap: 4px; padding: 12px; text-align: center; }
    .value { font-size: clamp(20px, 20cqmin, 96px); font-weight: 600; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; color: var(--accent); }
    .label { font-size: clamp(11px, 6cqmin, 18px); color: var(--muted); }
  </style>
</head>
<body>
  <main>
    <div class="value" id="value">…</div>
    <div class="label" id="label">${escapeHtml(name)}</div>
  </main>
  <script>
    var value = document.getElementById('value');
    var label = document.getElementById('label');
${api ? fetchPart : clockPart}
  </script>
</body>
</html>
`;
}

// ── commands ───────────────────────────────────────────────────────────────

async function list(flags) {
  const uses = await boardsByWidget();
  const rows = widgets.listIds().map(id => {
    const read = widgets.readManifest(id);
    const m = read.ok ? read.manifest : null;
    const secret = m && m.api && m.api.secret ? m.api.secret : null;
    return {
      id,
      name: m ? m.name : null,
      entry: m ? m.entry : null,
      api: m && m.api ? m.api.host : null,
      secret,
      key: secret ? widgets.secretWhere(id, secret, m.api.origin) : null,
      boards: (uses.get(id) || []).length,
      error: read.ok ? null : read.error,
    };
  });
  if (flags.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (!rows.length) { console.log(`No widgets yet. \`create\` makes one in ${widgets.widgetsDir()}.`); return; }
  console.log(`${rows.length} widget${rows.length === 1 ? '' : 's'}:`);
  for (const row of rows) {
    if (row.error) { console.log(`  ${row.id}  ·  can't be shown: ${row.error}`); continue; }
    const bits = [row.name, row.api ? `reads ${row.api}` : 'no API'];
    if (row.secret) bits.push(keyWords(row.key));
    bits.push(`on ${row.boards} board${row.boards === 1 ? '' : 's'}`);
    console.log(`  ${row.id}  ·  ${bits.join(' · ')}`);
  }
}

async function create(positional, flags) {
  const id = widgetId(positional[0]);
  if (flags.name === undefined) throw new Refusal('A new widget needs --name, what it is called (1–60 characters)');
  const dir = widgets.widgetDir(id);
  if (fs.existsSync(dir)) throw new Refusal(`A widget called "${id}" already exists, in ${dir} — edit its files, or pick another id`);
  const manifest = { name: String(flags.name), entry: 'index.html' };
  const width = number(flags, 'width');
  const height = number(flags, 'height');
  if ((width === undefined) !== (height === undefined)) throw new Refusal('Give --width and --height together, or neither');
  if (width !== undefined) manifest.size = { width, height };
  if (flags.secret !== undefined && flags.api === undefined) throw new Refusal('--secret names the key an API needs: give --api <baseUrl> with it');
  if (flags.api !== undefined) {
    manifest.api = { baseUrl: String(flags.api) };
    if (flags.secret !== undefined) manifest.api.secret = String(flags.secret);
  }
  const parsed = widgets.parseManifest(manifest);
  if (!parsed.ok) throw new Refusal(parsed.error);
  // The base URL as the app reads it (always ending in "/"), so the file says what is meant.
  if (manifest.api) manifest.api.baseUrl = parsed.manifest.api.baseUrl;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, widgets.MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'index.html'), starterPage(parsed.manifest.name, parsed.manifest.api));
  } catch (err) {
    throw new Refusal(`Could not make the widget: ${err.message}`);
  }
  console.log(`Created "${parsed.manifest.name}" (${id}) in ${dir}`);
  console.log('  widget.json   its name, size and API');
  console.log('  index.html    a starter page using the SDK — replace it with the widget');
  if (parsed.manifest.api && parsed.manifest.api.secret) {
    console.log(`Its key (${parsed.manifest.api.secret}) is the user's to give — never in a file or the chat:`);
    console.log(`  ${pasteCommand(id)}     (or paste it into the widget's "Needs a key" panel)`);
  }
  console.log(`Next: node scripts/widget.js check ${id}, then add ${id} --board <board>.`);
}

/** Every file under `dir`, relative, dotfiles and node_modules left out. */
function filesIn(dir, prefix = '', out = []) {
  let entries = [];
  try { entries = fs.readdirSync(path.join(dir, prefix), { withFileTypes: true }); } catch (_) { return out; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) filesIn(dir, rel, out);
    else out.push(rel);
  }
  return out;
}

async function check(positional) {
  const id = widgetId(positional[0]);
  const { manifest, dir } = manifestOf(id);
  const entryFile = path.join(dir, ...manifest.entry.split('/'));
  if (!fs.existsSync(entryFile)) throw new Refusal(`widget.json's entry, ${manifest.entry}, isn't in ${dir}`);
  const files = filesIn(dir);
  console.log(`Valid: "${manifest.name}" (${id}), ${files.length} file${files.length === 1 ? '' : 's'} in ${dir}`);
  for (const file of files.slice(0, FILES_SHOWN)) {
    const ext = path.extname(file).slice(1).toLowerCase();
    const served = Object.prototype.hasOwnProperty.call(widgets.MIME, ext);
    console.log(`  ${file}${served ? '' : '   (not served: kept in the folder, never sent to the page)'}`);
  }
  if (files.length > FILES_SHOWN) console.log(`  … and ${files.length - FILES_SHOWN} more`);
  if (manifest.size) console.log(`Size: ${manifest.size.width}×${manifest.size.height}${manifest.minSize ? `, at least ${manifest.minSize.width}×${manifest.minSize.height}` : ''}`);
  if (manifest.api) {
    console.log(`API: ${manifest.api.baseUrl} — the only place Switchboard.fetch reaches`);
    if (manifest.api.secret) {
      const where = widgets.secretWhere(id, manifest.api.secret, manifest.api.origin);
      console.log(`Key: ${manifest.api.secret}, sent as ${manifest.api.header}: ${manifest.api.prefix ? `"${manifest.api.prefix}…"` : '…'} — ${keyWords(where)}`);
      if (where === 'elsewhere') {
        const record = widgets.secretRecord(id, manifest.api.secret);
        const given = record && record.origin ? new URL(record.origin).host : 'another address';
        console.log(`  It was given for ${given}; widget.json now names ${manifest.api.host}, and a key goes only where it was given for.`);
      }
      if (where === 'missing' || where === 'elsewhere') console.log(`  The user gives it: ${pasteCommand(id)}`);
    }
  } else {
    console.log('API: none — Switchboard.fetch refuses every request (add "api": { "baseUrl": … } to widget.json)');
  }
  const uses = (await boardsByWidget()).get(id) || [];
  console.log(uses.length ? `On ${uses.map(b => `"${b.name}" (${b.folder})`).join(', ')}` : 'On no board yet.');
  console.log(`Address: sbwidget://${id}/${manifest.entry}`);
}

/** The key, typed on a terminal with nothing echoed. */
function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    let value = '';
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
    };
    function onData(chunk) {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') { cleanup(); resolve(value); return; }
        if (ch === '\u0003') { cleanup(); reject(new Refusal('Cancelled — nothing kept')); return; }
        if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }
        value += ch;
      }
    }
    stdin.on('data', onData);
    stdin.resume();
  });
}

async function setSecret(positional) {
  const id = widgetId(positional[0]);
  const { manifest } = manifestOf(id);
  const named = manifest.api && manifest.api.secret;
  if (!named) throw new Refusal(`${id}'s widget.json names no key: add "secret": "API_KEY" to its "api" first`);
  // Never echo an argument that isn't a key's NAME: it may be the key itself, pasted in the
  // wrong place.
  if (positional.length > 2 || (positional[1] !== undefined && !widgets.isSecretName(positional[1]))) {
    throw new Refusal('Never pass a key as an argument — set-secret reads it from stdin (the second argument, if any, is its NAME, like API_KEY)');
  }
  if (positional[1] !== undefined && positional[1] !== named) {
    throw new Refusal(`${id}'s widget.json names its key ${named}, not ${positional[1]}`);
  }
  let value;
  if (process.stdin.isTTY) {
    value = await readHidden(`${named} for ${manifest.name} (${manifest.api.host}) — paste it, then Enter; nothing is shown: `);
  } else {
    try { value = fs.readFileSync(0, 'utf8'); } catch (err) { throw new Refusal(`Could not read the key from stdin: ${err.message}`); }
  }
  if (!String(value || '').trim()) {
    throw new Refusal(`No key came in on stdin. Run node scripts/widget.js set-secret ${id} in a terminal and paste it at the prompt, or copy the key and run: ${pasteCommand(id)}`);
  }
  // Kept for the API the user was shown (the manifest read above), and sent nowhere else.
  const kept = widgets.setPendingSecret(id, named, value, manifest.api.origin);
  if (!kept.ok) throw new Refusal(kept.error);
  console.log(`Kept ${named} for ${id}, to be sent to ${manifest.api.host} only. Switchboard encrypts it with the system's`);
  console.log('keychain as soon as it sees it (at once if it is running, else when it next starts) and takes it out of the');
  console.log('pending file. The key was not printed anywhere.');
}

async function add(positional, flags) {
  const id = widgetId(positional[0]);
  const { manifest } = manifestOf(id);
  if (!flags.board) throw new Refusal('Name the board with --board <id or name>');
  const { board: found } = await board.findBoard(flags.board, flags.folder);
  const { parseDiagramSpec, layoutDiagram, FLOW_WIDGET_DEFAULT_SIZE, FLOW_WIDGET_MIN_SIZE } = board.editorLib();
  const data = board.unwrap(await whiteboards.get(found.id), `Could not read "${found.name}"`);
  const before = parseDiagramSpec(data.spec);
  if (!before.ok) throw new Refusal(`"${found.name}" doesn't validate as it is, so nothing was added: ${before.error}`);
  const previous = before.value;

  // A board drawn from a terminal and never opened has no positions; one placed node
  // would then push all the rest after it. Every node takes the place it is drawn at now
  // — what the app does the first time it saves the board — and the widget goes beside.
  const layout = layoutDiagram(previous);
  const placed = new Map(layout.nodes.map(node => [node.id, { x: node.position.x, y: node.position.y, width: node.width, height: node.height }]));
  const nodes = previous.nodes.map(node => (node.position ? node : { ...node, position: { x: Math.round(placed.get(node.id).x), y: Math.round(placed.get(node.id).y) } }));

  const least = manifest.minSize || FLOW_WIDGET_MIN_SIZE;
  const width = number(flags, 'width');
  const height = number(flags, 'height');
  if ((width === undefined) !== (height === undefined)) throw new Refusal('Give --width and --height together, or neither');
  const wanted = width !== undefined ? { width, height } : (manifest.size || FLOW_WIDGET_DEFAULT_SIZE);
  const size = { width: Math.max(least.width, wanted.width), height: Math.max(least.height, wanted.height) };

  const x = number(flags, 'x');
  const y = number(flags, 'y');
  if ((x === undefined) !== (y === undefined)) throw new Refusal('Give --x and --y together, or neither');
  let position;
  if (x !== undefined) position = { x, y };
  else if (!placed.size) position = { ...ADD_ORIGIN };
  else {
    const rects = Array.from(placed.values());
    position = {
      x: Math.round(Math.max(...rects.map(r => r.x + r.width)) + ADD_GAP),
      y: Math.round(Math.min(...rects.map(r => r.y))),
    };
  }

  const taken = new Set(previous.nodes.map(node => node.id.toLowerCase()));
  const stem = `widget-${id}`.slice(0, 60);
  let nodeId = stem;
  for (let n = 2; taken.has(nodeId.toLowerCase()); n++) nodeId = `${stem.slice(0, 60 - String(n).length - 1)}-${n}`;

  const node = { id: nodeId, shape: 'widget', widget: id, label: manifest.name, position, size };
  const { spec } = board.checked({ ...previous, nodes: [...nodes, node] });
  board.unwrap(await whiteboards.saveSpec(found.id, spec), `Could not save "${found.name}"`);
  await whiteboards.settle();
  console.log(`Added "${manifest.name}" to "${found.name}" as ${nodeId}, ${size.width}×${size.height} at ${position.x}, ${position.y}.`);
  console.log('Open in Switchboard, the board shows it as it lands; Undo there takes it off again.');
}

async function remove(positional, flags) {
  const id = widgetId(positional[0]);
  const dir = widgets.widgetDir(id);
  if (!fs.existsSync(dir)) throw new Refusal(`There is no widget called "${id}"`);
  const uses = (await boardsByWidget()).get(id) || [];
  if (uses.length && !flags.yes) {
    throw new Refusal(`${id} is on ${uses.map(b => `"${b.name}" (${b.folder})`).join(', ')} — those boards would show "This widget isn't installed".\n` +
      'Take it off them first, or pass --yes when that is the point.');
  }
  // Moved aside rather than deleted: nothing a person or an agent made is destroyed by a
  // typo. A folder whose name isn't a widget id is never served or listed.
  const aside = path.join(widgets.widgetsDir(), '.removed', `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  try {
    fs.mkdirSync(path.dirname(aside), { recursive: true });
    fs.renameSync(dir, aside);
  } catch (err) {
    throw new Refusal(`Could not move the widget aside: ${err.message}`);
  }
  const forgot = widgets.forgetSecrets(id);
  console.log(`Removed ${id}: its folder is now ${aside}${forgot.ok && forgot.forgot ? `, and its key is forgotten` : ''}.`);
  if (uses.length) console.log(`${uses.length} board${uses.length === 1 ? '' : 's'} still name it and show it as not installed.`);
}

async function main(argv) {
  const [command, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  if (!command || command === 'help' || command === '--help' || flags.help) { console.log(USAGE); return; }
  switch (command) {
    case 'list': return list(flags);
    case 'create': return create(positional, flags);
    case 'check': return check(positional);
    case 'set-secret': return setSecret(positional);
    case 'add': return add(positional, flags);
    case 'remove': return remove(positional, flags);
    default: throw new Refusal(`Unknown command "${command}"\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch(err => {
  console.error(err instanceof Refusal ? `widget: ${err.message}` : err.stack || String(err));
  process.exitCode = 1;
});
