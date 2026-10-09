'use strict';

// answer.js — ✦ Answer on a whiteboard: which AI answers a box's question, and the
// asking. ARCHITECTURE §4.18, §5 M11.
//
// Four ways to answer, picked on the Settings screen or under ✦ Answer's chevron:
//
//   claude-code   Claude Code's CLI, run in the whiteboard's workspace folder with ONLY
//                 its read and search tools, so it reads the code before it answers.
//                 Slower — it opens files first — and it knows the code.
//   codex         Codex's CLI, `codex exec` in its read-only sandbox, the same idea.
//   claude-api    The Claude API with a key the user typed in. Sees only the whiteboard;
//                 answers in seconds.
//   openai-api    The OpenAI Responses API, likewise — the admin's ✦ Answer, with the
//                 models and efforts the admin offers.
//
// The renderer builds the prompt (the admin's lib/diagrams/ai.ts, in the bundle) and
// reads the answer back into boxes; this module only gets the words to whoever answers
// and the JSON back. Which model and effort a provider uses is read here, from the
// stored settings, never taken from the request: this module is the one place that
// knows what each provider accepts.
//
// Keys never touch config.json. They are encrypted with Electron's safeStorage — the
// macOS Keychain — into keys.json beside the config, and nothing ever hands one back to
// the renderer: it sees whether there is a key and its last four characters.
//
// Which workspace a CLI reads is the whiteboard's (each board remembers its own), and
// resolveAnswerDir() turns that id into a folder through the rail's own list — never a
// path the page hands over. A condensation reads no files at all, so it needs no
// workspace: without one a CLI runs it in the system's temp folder.
//
// A CLI's answers on one whiteboard are one conversation (2026-10-09): every question
// asked on the board, from any box, continues the same Claude Code session or Codex
// thread, so the CLI asked about one branch already knows what it read and said for the
// others. Only a board with no conversation yet starts one. The APIs still take each
// question on its own, and a condensation is never part of a conversation. Where a
// conversation is kept is the caller's — index.js hands start() a store with
// whiteboards.js behind it — and the section "one conversation per whiteboard" below
// says the rest.
//
// Nothing throws. Every export resolves to a value; a failure is
// `{ ok: false, error: '<human sentence>', code? }`, where `code` is what the renderer
// needs to offer the one action that fixes it: 'missing' (not installed), 'signed-out',
// 'no-key', 'bad-key', 'timeout', 'stopped', 'no-workspace' (a CLI was asked to read a
// whiteboard's workspace and it has none, or that workspace is no longer on the rail).

const { net, safeStorage } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const config = require('./config.js');

// ── what is on offer ────────────────────────────────────────────────────────

// The admin's OpenAI models, with the efforts each one took when probed against the
// Responses API (lib/diagrams/ai.ts there): Astra and Sol refuse "none"; none take
// "minimal".
const OPENAI_MODELS = [
  { id: 'gpt-6-astra', name: 'Astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gpt-6.1-sol', name: 'Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gpt-5.6-terra', name: 'Terra', efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gpt-6-luna', name: 'Luna', efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
];

const CLAUDE_MODELS = [
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
  { id: 'claude-opus-5-5', name: 'Opus 5.5' },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5' },
  { id: 'claude-fable-5-1', name: 'Fable 5.1' },
];

// Claude Code's own --effort levels, plus "own": leave it to whatever Claude Code is
// set to. Codex is always left to its own settings.
const CLAUDE_CODE_EFFORTS = ['own', 'low', 'medium', 'high', 'xhigh', 'max'];

const EFFORT_NAMES = {
  own: 'Its own', none: 'None', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-high', max: 'Max',
};

const PROVIDERS = [
  { id: 'claude-code', name: 'Claude Code', kind: 'cli', bin: 'claude' },
  { id: 'codex', name: 'Codex', kind: 'cli', bin: 'codex' },
  { id: 'claude-api', name: 'Claude API', kind: 'api', models: CLAUDE_MODELS },
  { id: 'openai-api', name: 'OpenAI API', kind: 'api', models: OPENAI_MODELS },
];

const PROVIDER_IDS = PROVIDERS.map(p => p.id);

const DEFAULTS = {
  provider: null,                     // null: the first one that is ready (effectiveProvider)
  split: 'auto',
  context: true,
  web: true,                          // Web access: it may open a link or search, when it needs to
  subtext: false,                     // a line of detail under each answer box
  claudeCodeEffort: 'own',
  claudeApiModel: 'claude-sonnet-5-5',
  openaiModel: 'gpt-5.6-terra',
  openaiEffort: 'medium',
};

// A CLI answer that has not finished by now is stopped and said so. Generous: reading
// a big workspace can take a few minutes, and the user has Stop.
const CLI_TIMEOUT_MS = 5 * 60 * 1000;
const API_TIMEOUT_MS = 3 * 60 * 1000;
const DETECT_TTL_MS = 60 * 1000;

// ── settings ────────────────────────────────────────────────────────────────

function pickFrom(list, value, fallback) {
  return list.indexOf(value) !== -1 ? value : fallback;
}

function openaiModel(id) {
  return OPENAI_MODELS.find(m => m.id === id) || null;
}

/** The nearest effort `model` takes to `effort`, the admin's effortFor(). */
function openaiEffortFor(modelId, effort) {
  const model = openaiModel(modelId) || openaiModel(DEFAULTS.openaiModel);
  if (model.efforts.indexOf(effort) !== -1) return effort;
  const order = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
  const at = order.indexOf(effort);
  let best = model.efforts[0];
  for (const e of model.efforts) {
    if (Math.abs(order.indexOf(e) - at) < Math.abs(order.indexOf(best) - at)) best = e;
  }
  return best;
}

/** The stored settings made safe: anything missing or retired falls back. */
function settings() {
  const raw = (config.get() || {}).answer;
  const s = raw && typeof raw === 'object' ? raw : {};
  const model = pickFrom(OPENAI_MODELS.map(m => m.id), s.openaiModel, DEFAULTS.openaiModel);
  return {
    provider: pickFrom(PROVIDER_IDS, s.provider, null),
    split: s.split === 'one' ? 'one' : 'auto',
    context: typeof s.context === 'boolean' ? s.context : DEFAULTS.context,
    web: typeof s.web === 'boolean' ? s.web : DEFAULTS.web,
    subtext: typeof s.subtext === 'boolean' ? s.subtext : DEFAULTS.subtext,
    claudeCodeEffort: pickFrom(CLAUDE_CODE_EFFORTS, s.claudeCodeEffort, DEFAULTS.claudeCodeEffort),
    claudeApiModel: pickFrom(CLAUDE_MODELS.map(m => m.id), s.claudeApiModel, DEFAULTS.claudeApiModel),
    openaiModel: model,
    openaiEffort: openaiEffortFor(model, typeof s.openaiEffort === 'string' ? s.openaiEffort : DEFAULTS.openaiEffort),
  };
}

/** Merge a change in and keep it in config.json's `answer` block. Answers status(). */
function setSettings(patch) {
  const p = patch && typeof patch === 'object' ? patch : {};
  const next = Object.assign({}, settings());
  if ('provider' in p) next.provider = pickFrom(PROVIDER_IDS, p.provider, next.provider);
  if ('split' in p) next.split = p.split === 'one' ? 'one' : 'auto';
  if ('context' in p) next.context = !!p.context;
  if ('web' in p) next.web = !!p.web;
  if ('subtext' in p) next.subtext = !!p.subtext;
  if ('claudeCodeEffort' in p) next.claudeCodeEffort = pickFrom(CLAUDE_CODE_EFFORTS, p.claudeCodeEffort, next.claudeCodeEffort);
  if ('claudeApiModel' in p) next.claudeApiModel = pickFrom(CLAUDE_MODELS.map(m => m.id), p.claudeApiModel, next.claudeApiModel);
  if ('openaiModel' in p) next.openaiModel = pickFrom(OPENAI_MODELS.map(m => m.id), p.openaiModel, next.openaiModel);
  if ('openaiEffort' in p && typeof p.openaiEffort === 'string') next.openaiEffort = p.openaiEffort;
  next.openaiEffort = openaiEffortFor(next.openaiModel, next.openaiEffort);
  config.save({ answer: next });
  return status({ fresh: false });
}

// ── keys ────────────────────────────────────────────────────────────────────

function keysFile() {
  return path.join(path.dirname(config.CONFIG_FILE), 'keys.json');
}

function readKeys() {
  try {
    const data = JSON.parse(fs.readFileSync(keysFile(), 'utf8'));
    return data && typeof data === 'object' && data.keys && typeof data.keys === 'object' ? data.keys : {};
  } catch (_) {
    return {};
  }
}

function writeKeys(keys) {
  const file = keysFile();
  const tmp = file + '.' + process.pid + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, keys }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort */ }
}

/** The key itself, decrypted, or null. Only ever used here, for a request. */
function keyFor(provider) {
  const entry = readKeys()[provider];
  if (!entry || typeof entry.enc !== 'string') return null;
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(Buffer.from(entry.enc, 'base64')) || null;
  } catch (err) {
    console.error('[switchboard] answer: could not decrypt the ' + provider + ' key:', err.message);
    return null;
  }
}

function last4(provider) {
  const entry = readKeys()[provider];
  return entry && typeof entry.last4 === 'string' ? entry.last4 : null;
}

/**
 * Check a key with its provider, then keep it encrypted. A key the provider refuses is
 * never stored: the answer says why, and the old key (if any) stays.
 */
async function setKey(provider, key) {
  if (provider !== 'claude-api' && provider !== 'openai-api') return { ok: false, error: 'that provider takes no key' };
  const value = typeof key === 'string' ? key.trim() : '';
  if (!value) return { ok: false, error: 'Paste the key first' };
  if (value.length > 400 || /\s/.test(value)) return { ok: false, error: "That doesn't look like an API key" };
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: "This Mac's keychain isn't available, so the key can't be kept safely" };
  }
  const check = await checkKey(provider, value);
  if (!check.ok) return check;
  try {
    const keys = readKeys();
    keys[provider] = {
      enc: safeStorage.encryptString(value).toString('base64'),
      last4: value.slice(-4),
      savedAt: new Date().toISOString(),
    };
    writeKeys(keys);
  } catch (err) {
    return { ok: false, error: 'could not keep the key: ' + err.message };
  }
  return status({ fresh: false });
}

function removeKey(provider) {
  try {
    const keys = readKeys();
    if (keys[provider]) {
      delete keys[provider];
      writeKeys(keys);
    }
  } catch (err) {
    return { ok: false, error: 'could not remove the key: ' + err.message };
  }
  return status({ fresh: false });
}

async function checkKey(provider, key) {
  const url = provider === 'claude-api' ? 'https://api.anthropic.com/v1/models?limit=1' : 'https://api.openai.com/v1/models';
  const headers = provider === 'claude-api'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { Authorization: 'Bearer ' + key };
  const who = provider === 'claude-api' ? 'Anthropic' : 'OpenAI';
  try {
    const res = await fetchWithTimeout(url, { method: 'GET', headers }, 20000);
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, error: `${who} says that key isn't valid`, code: 'bad-key' };
    const detail = await res.text().catch(() => '');
    return { ok: false, error: `${who} answered ${res.status} — ${errorText(detail) || 'try again'}` };
  } catch (err) {
    return { ok: false, error: `Couldn't reach ${who} to check the key — ${err.message}` };
  }
}

// ── is each CLI here? ───────────────────────────────────────────────────────

let detected = null;               // { at, claude, codex }
let detecting = null;

function runQuiet(bin, args, timeout) {
  return new Promise(resolve => {
    execFile(bin, args, { timeout: timeout || 8000, env: process.env, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        missing: !!(err && err.code === 'ENOENT'),
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        out: String(stdout || ''),
        err: String(stderr || ''),
      });
    });
  });
}

async function detectClaude() {
  const v = await runQuiet('claude', ['--version']);
  if (v.missing) return { installed: false };
  if (v.code !== 0) return { installed: true, version: null, signedIn: null };
  const version = (v.out.trim().split(/\s+/)[0] || '').replace(/[^0-9A-Za-z.+-]/g, '') || null;
  const a = await runQuiet('claude', ['auth', 'status']);
  let signedIn = null;
  try { signedIn = !!JSON.parse(a.out).loggedIn; } catch (_) { signedIn = a.code === 0 ? null : false; }
  return { installed: true, version, signedIn };
}

async function detectCodex() {
  const v = await runQuiet('codex', ['--version']);
  if (v.missing) return { installed: false };
  if (v.code !== 0) return { installed: true, version: null, signedIn: null };
  const words = v.out.trim().split(/\s+/);
  const version = (words[words.length - 1] || '').replace(/[^0-9A-Za-z.+-]/g, '') || null;
  const a = await runQuiet('codex', ['login', 'status']);
  const said = (a.out + ' ' + a.err).toLowerCase();
  const signedIn = a.code === 0 ? !/not logged in/.test(said) : (/not logged in/.test(said) ? false : null);
  return { installed: true, version, signedIn };
}

function detect(fresh) {
  if (!fresh && detected && Date.now() - detected.at < DETECT_TTL_MS) return Promise.resolve(detected);
  if (detecting) return detecting;
  detecting = Promise.all([detectClaude(), detectCodex()]).then(([claude, codex]) => {
    detected = { at: Date.now(), claude, codex };
    detecting = null;
    return detected;
  }, err => {
    detecting = null;
    throw err;
  });
  return detecting;
}

// ── status: what the Settings screen and the menu draw ──────────────────────

function cliLine(found) {
  if (!found || !found.installed) return 'Not installed on this Mac';
  const parts = ['Installed'];
  if (found.version) parts.push(found.version);
  if (found.signedIn === true) parts.push('signed in');
  if (found.signedIn === false) parts.push('not signed in');
  return parts.join(' · ');
}

/** The first provider that is ready: a CLI that is here, then an API with a key. */
function effectiveProvider(stored, list) {
  if (stored) return stored;
  const ready = list.find(p => p.ready);
  return ready ? ready.id : 'claude-code';
}

async function status(opts) {
  let found = detected;
  try {
    found = await detect(!!(opts && opts.fresh));
  } catch (err) {
    console.error('[switchboard] answer: detect:', err.message);
  }
  const s = settings();
  const list = PROVIDERS.map(p => {
    const out = { id: p.id, name: p.name, kind: p.kind };
    if (p.kind === 'cli') {
      const f = found && (p.id === 'claude-code' ? found.claude : found.codex);
      out.installed = !!(f && f.installed);
      out.signedIn = f ? f.signedIn : null;
      out.version = f ? f.version || null : null;
      out.ready = out.installed && out.signedIn !== false;
      out.state = !out.installed ? 'missing' : out.signedIn === false ? 'signed-out' : 'ready';
      out.line = found ? cliLine(f) : 'Checking…';
      if (p.id === 'claude-code') {
        out.efforts = CLAUDE_CODE_EFFORTS.map(id => ({ id, name: EFFORT_NAMES[id] }));
        out.effort = s.claudeCodeEffort;
      }
    } else {
      const four = last4(p.id);
      out.hasKey = !!four;
      out.last4 = four;
      out.ready = !!four;
      out.state = four ? 'ready' : 'no-key';
      out.models = p.models.map(m => Object.assign({}, m, m.efforts ? { efforts: m.efforts.map(id => ({ id, name: EFFORT_NAMES[id] })) } : {}));
      out.model = p.id === 'claude-api' ? s.claudeApiModel : s.openaiModel;
      if (p.id === 'openai-api') out.effort = s.openaiEffort;
      const model = p.models.find(m => m.id === out.model);
      out.line = four ? `Key ending ${four} · ${model ? model.name : out.model}` : 'No key';
    }
    return out;
  });
  const provider = effectiveProvider(s.provider, list);
  return {
    ok: true,
    settings: Object.assign({}, s, { provider, chosen: s.provider }),
    providers: list,
    keysSafe: (() => { try { return safeStorage.isEncryptionAvailable(); } catch (_) { return false; } })(),
  };
}

// ── asking ──────────────────────────────────────────────────────────────────

const runs = new Map();            // request id → { stop() }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function errorText(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  try {
    const data = JSON.parse(text);
    const msg = (data && data.error && (data.error.message || data.error)) || data.message;
    if (typeof msg === 'string') return msg.slice(0, 300);
  } catch (_) { /* not JSON */ }
  return text.replace(/\s+/g, ' ').slice(0, 300);
}

/** A GET that gives up after `ms` — checking a key. The body is read after it resolves. */
async function fetchWithTimeout(url, init, ms) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms);
  try {
    return await net.fetch(url, Object.assign({}, init, { signal: controller.signal }));
  } catch (err) {
    if (timedOut) throw new Error('it did not answer in time');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── web access ──────────────────────────────────────────────────────────────

/** Whether `provider` gets its web tools for this answer: Web access is on. */
function webFor(provider, s) {
  return !!(s && s.web);
}

/** What whoever answers is told about the web, matching the tools it was handed. */
function webPrompt(on, provider, operation) {
  if (operation === 'condense') {
    return 'Condense only the discussion supplied in this request. External web access is disabled. ' +
      'Do not read workspace files, run commands, call tools, or research new facts. ' +
      'The selected discussion is the entire evidence; preserve its uncertainty instead of investigating it.';
  }
  if (!on) {
    return "You can't open web pages or search the web here. If the question depends on a page you can't see, " +
      "say so in the answer rather than guess what the page says.";
  }
  const own = provider === 'claude-code' || provider === 'codex' ? 'the diagram and the code' : 'the diagram';
  return `You can also open a web page or search the web. Do it only when the question needs something ${own} ` +
    "can't tell you — a link written in a box, or facts that live elsewhere — and answer without the web otherwise. " +
    'The answer is still only the boxes: no list of sources, no links or markdown in them.';
}

/**
 * resolveAnswerDir(req, lookup) → { ok, dir, wsId } — the folder a CLI answer runs in —
 * or { ok:false, code:'no-workspace', error }.
 *
 * `req.wsId` is the whiteboard's workspace (null when it has none); `lookup(id)` is
 * workspaces.lookup, which knows rail workspaces only, so an absolute path or an id the
 * rail has never heard of resolves to nothing rather than to a folder. Only Claude Code
 * and Codex read a folder: the APIs get `dir: null` without a lookup. A condensation
 * reads no files, so it is never refused for a missing workspace — it runs in the
 * workspace's folder when there is one, else in the system's temp folder. `wsId` in the
 * answer is the workspace that resolved, or null.
 */
async function resolveAnswerDir(req, lookup) {
  const r = req && typeof req === 'object' ? req : {};
  const cli = r.provider === 'claude-code' || r.provider === 'codex';
  const condense = r.operation === 'condense';
  if (!cli) return { ok: true, dir: null, wsId: null };
  const wsId = typeof r.wsId === 'string' ? r.wsId.trim() : '';
  let ws = null;
  if (wsId && typeof lookup === 'function') {
    try { ws = await lookup(wsId); } catch (_) { ws = null; }
  }
  const dir = ws && typeof ws.dir === 'string' && ws.dir ? ws.dir : null;
  if (dir) return { ok: true, dir, wsId };
  if (condense) return { ok: true, dir: os.tmpdir(), wsId: null };
  if (!wsId) return { ok: false, code: 'no-workspace', error: 'Pick a workspace for ✦ Answer to read' };
  return { ok: false, code: 'no-workspace', error: `could not find the folder for ${wsId}` };
}

/**
 * start(id, req, onStep, opts) → { ok, text, conversation? } — the answer's JSON, for the
 * renderer to read into boxes — or { ok:false, error, code }.
 *
 * req: { provider, dir, wsId, system, user, schema, operation?, boardId? }. `dir` is the
 * workspace folder and `wsId` the workspace it is, both resolved by index.js with
 * resolveAnswerDir(); a CLI runs there and nowhere else. A condensation without one runs
 * in the temp folder, since it reads nothing. `boardId` is the whiteboard asking, and
 * with `opts.conversations` — the store a board's conversations are kept in, { get, set,
 * name? } (conversationFor says when it is used) — a CLI's answer is a turn of that
 * board's conversation, and `conversation: { turns, resumed }` says which.
 */
function start(id, req, onStep, opts) {
  const key = String(id || '');
  if (!key) return Promise.resolve({ ok: false, error: 'the request came without an id' });
  if (runs.has(key)) return Promise.resolve({ ok: false, error: 'that answer is already being asked for' });
  const r = req && typeof req === 'object' ? req : {};
  if (r.operation !== undefined && r.operation !== 'condense') {
    return Promise.resolve({ ok: false, error: 'Unknown diagram AI operation' });
  }
  if (typeof r.system !== 'string' || typeof r.user !== 'string' || !r.user.trim()) {
    return Promise.resolve({ ok: false, error: 'Write a question in the box first' });
  }
  if (!r.schema || typeof r.schema !== 'object') return Promise.resolve({ ok: false, error: 'the request came without its answer format' });
  const provider = pickFrom(PROVIDER_IDS, r.provider, null);
  if (!provider) return Promise.resolve({ ok: false, error: 'Pick who answers first' });
  const step = typeof onStep === 'function' ? onStep : () => {};
  const s = settings();
  // Web access: the tools go to whoever answers here, so what it is told about the web
  // is added here too — the prompt and the tools never disagree.
  const web = r.operation !== 'condense' && webFor(provider, s);
  const talk = conversationFor(provider, r, opts);
  const alone = Object.assign({}, r, { system: r.system + '\n\n' + webPrompt(web, provider, r.operation) });
  // A turn of a conversation is also told it is one, beside what it is told about the web —
  // and keeps the question as it is asked on its own, for a Codex that cannot resume.
  const ask = talk ? Object.assign({}, alone, { system: alone.system + '\n\n' + conversationPrompt() }) : alone;
  if (talk) talk.alone = alone;

  let job;
  if (talk) job = converse(talk, ask, s, web, step);
  else if (provider === 'claude-code') job = askClaudeCode(ask, s, web, step);
  else if (provider === 'codex') job = askCodex(ask, web, step);
  else if (provider === 'claude-api') job = askClaudeApi(ask, s, web);
  else job = askOpenAi(ask, s, web, step);

  runs.set(key, job);
  return job.done.then(res => {
    runs.delete(key);
    return res;
  }, err => {
    runs.delete(key);
    return { ok: false, error: String((err && err.message) || err) };
  });
}

function stop(id) {
  const job = runs.get(String(id || ''));
  if (job) job.stop();
  return { ok: true };
}

/** Everything still asking, or waiting its turn to — the quit path, so no CLI outlives the app. */
function stopAll() {
  runs.forEach(job => { try { job.stop(); } catch (_) { /* gone */ } });
}

// ── a CLI ───────────────────────────────────────────────────────────────────

/**
 * Spawn `bin` in its own process group, so Stop takes the whole tree (a CLI runs its
 * own children: ripgrep, a shell) and not just the parent. Lines of stdout go to
 * `onLine` as they arrive.
 */
function spawnCli(bin, args, opts) {
  let child;
  let stopped = null;
  let timer = null;
  let settle;
  const done = new Promise(resolve => { settle = resolve; });

  function kill(why) {
    if (stopped || !child || child.exitCode !== null) return;
    stopped = why;
    try { process.kill(-child.pid, 'SIGTERM'); } catch (_) { try { child.kill('SIGTERM'); } catch (__) { /* gone */ } }
    setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* gone */ }
    }, 2000).unref();
  }

  try {
    child = spawn(bin, args, {
      cwd: opts.cwd,
      env: Object.assign({}, process.env, opts.env || {}),
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      detached: true,
    });
  } catch (err) {
    settle({ code: null, missing: err && err.code === 'ENOENT', error: err, stopped: null, err: '' });
    return { done, stop: () => {} };
  }

  let buffer = '';
  let errText = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line.trim()) { try { opts.onLine(line); } catch (err) { console.error('[switchboard] answer: line:', err); } }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    errText += chunk;
    if (errText.length > 20000) errText = errText.slice(-20000);
  });
  child.on('error', err => {
    clearTimeout(timer);
    settle({ code: null, missing: err && err.code === 'ENOENT', error: err, stopped, err: errText });
  });
  child.on('close', code => {
    clearTimeout(timer);
    if (buffer.trim()) { try { opts.onLine(buffer); } catch (_) { /* ignore */ } }
    settle({ code, missing: false, error: null, stopped, err: errText });
  });
  if (opts.input !== undefined && child.stdin) {
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input);
  }
  timer = setTimeout(() => kill('timeout'), opts.timeout || CLI_TIMEOUT_MS);
  return { done, stop: () => kill('stopped') };
}

/** A path as the workspace sees it: relative to its folder, '' for the folder itself. */
function rel(dir, file) {
  if (typeof file !== 'string' || !file) return '';
  const out = path.isAbsolute(file) ? path.relative(dir, file) : file;
  if (out === '' || out === '.') return '';
  return out.startsWith('..') ? path.basename(file) : out;
}

function clip(text, n) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** A page as the activity card names it: "example.com/docs/intro", no scheme, no query. */
function pageName(url) {
  try {
    const u = new URL(String(url || ''));
    return clip(u.host.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname), 70);
  } catch (_) {
    return clip(url, 70);
  }
}

/** What one of Claude Code's tool calls is doing, in a line the activity card shows. */
function claudeStep(dir, block) {
  const input = (block && block.input) || {};
  switch (block && block.name) {
    case 'Read': return { kind: 'read', text: 'Reading', target: rel(dir, input.file_path) };
    case 'Grep': {
      const where = rel(dir, input.path);
      return { kind: 'search', text: 'Searching for', target: clip(input.pattern, 60) + (where ? ' in ' + where : '') };
    }
    case 'Glob': return { kind: 'list', text: 'Looking for', target: clip(input.pattern, 60) };
    case 'WebFetch': return { kind: 'fetch', text: 'Opening', target: pageName(input.url) };
    case 'WebSearch': return { kind: 'web', text: 'Searching the web for', target: clip(input.query, 60) };
    case 'StructuredOutput': return { kind: 'write', text: 'Writing the answer', target: '' };
    default: return { kind: 'other', text: clip(block && block.name, 40) || 'Working', target: '' };
  }
}

const SIGNED_OUT_RE = /(not logged in|please run \/login|log in|invalid api key|authentication|unauthori[sz]ed|oauth token)/i;

/**
 * The folder a CLI runs in: the workspace's, or — for a condensation, which is told not
 * to read any file and is handed no tool that could — the temp folder when there is none.
 */
function cliDir(r) {
  if (r.dir) return r.dir;
  return r.operation === 'condense' ? os.tmpdir() : null;
}

/**
 * Claude Code's arguments. Read and search only — nothing it can do changes a file or
 * runs a command — and with Web access, its two web tools too. A tool left out of
 * --tools is one it never sees: leaving it out of --allowedTools alone would not do,
 * since dontAsk still lets WebFetch open the documentation sites Claude Code trusts.
 *
 * Without `turn` nothing is kept. With one — a turn of the board's conversation,
 * { resume, id, name?, snapshot? } — the session is kept so the next question can
 * continue it: a new one under the id chosen here (--session-id) and named after the
 * board, so wherever it is listed it reads as the board's (askClaudeCode says where it
 * is not), or the kept one (--resume). Either
 * way --system-prompt-snapshot off: Claude Code otherwise records the system prompt on a
 * conversation's first request and sends that record on every resume, and ours changes
 * from one question to the next (Web access, Subtext). The rest — the tools, dontAsk —
 * is given at every launch, a resume included. An id that is not a UUID is never
 * passed — it would be an argument of its own — and the turn keeps nothing instead.
 */
function claudeCodeArgs(r, s, web, turn) {
  const tools = r.operation === 'condense' ? '' : (web ? 'Read,Grep,Glob,WebFetch,WebSearch' : 'Read,Grep,Glob');
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--json-schema', JSON.stringify(r.schema),
    '--tools', tools,
    '--allowedTools', tools,
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config',
    '--disable-slash-commands',
  ];
  const talk = turn && isUuid(turn.id) ? turn : null;
  if (!talk) {
    args.push('--no-session-persistence');
  } else {
    if (talk.snapshot !== false) args.push('--system-prompt-snapshot', 'off');
    if (talk.resume) {
      args.push('--resume', talk.id.toLowerCase());
    } else {
      args.push('--session-id', talk.id.toLowerCase());
      if (typeof talk.name === 'string' && talk.name) args.push('--name', talk.name);
    }
  }
  args.push('--append-system-prompt', r.system);
  if (s.claudeCodeEffort && s.claudeCodeEffort !== 'own') args.push('--effort', s.claudeCodeEffort);
  return args;
}

/**
 * Ask Claude Code. With `turn` (claudeCodeArgs says what it is) the answer is the same,
 * and what the conversation needs to know is left on the turn itself: `session`, the
 * session id the result names; `gone`, a resume of a conversation Claude Code no longer
 * has; `unknown`, an option a conversation adds that this Claude Code is too old to know.
 *
 * A kept session lies beside the user's own, in Claude Code's folder for the workspace,
 * so a turn is recorded as print mode's (CLAUDE_CODE_ENTRYPOINT=sdk-cli — what `-p` takes
 * when nothing says otherwise, said here whatever Switchboard was started from): an
 * interactive `claude --continue` or `claude --resume` in the workspace passes over those,
 * so a whiteboard's conversation never comes back in place of the user's own (probed
 * 2026-10-09, Claude Code 2.1.296: "filtered from /resume: entrypoint=sdk-cli"). Only a
 * `claude -p --continue`, print mode itself, would pick it, and a Claude Code from before
 * that filter (2.1.83 has none) would offer it too. The session is not moved to a folder
 * of Switchboard's own to keep it out of the way: run anywhere but the workspace, Claude
 * Code no longer reads the workspace's .claude/settings.json, so a `deny` there (a Read
 * of `.env`, say) would stop holding — probed the same day with `--add-dir`, and with
 * that file handed over as `--settings`.
 */
function askClaudeCode(r, s, web, step, turn) {
  const dir = cliDir(r);
  if (!dir) return { done: Promise.resolve({ ok: false, error: 'This workspace has no folder to read' }), stop: () => {} };
  const args = claudeCodeArgs(r, s, web, turn);

  let result = null;
  let files = 0;
  const run = spawnCli('claude', args, {
    cwd: dir,
    input: r.user,
    env: turn ? { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } : undefined,
    onLine: line => {
      let ev;
      try { ev = JSON.parse(line); } catch (_) { return; }
      if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        for (const block of ev.message.content) {
          if (block && block.type === 'tool_use') {
            const st = claudeStep(dir, block);
            if (st.kind === 'read') files++;
            step(st);
          }
        }
      } else if (ev.type === 'result') {
        result = ev;
      }
    },
  });

  const done = run.done.then(exit => {
    if (turn && result && typeof result.session_id === 'string') turn.session = result.session_id;
    if (exit.missing) return { ok: false, code: 'missing', error: "Claude Code isn't installed on this Mac" };
    if (exit.stopped === 'stopped') return { ok: false, code: 'stopped', error: 'Stopped' };
    if (exit.stopped === 'timeout') return { ok: false, code: 'timeout', error: 'Claude Code was still going after 5 minutes, so it was stopped' };
    if (exit.error) return { ok: false, error: 'Claude Code could not start: ' + exit.error.message };
    if (turn && (!result || result.is_error)) {
      const raw = ((result && result.errors) || []).join(' ') + ' ' + exit.err;
      if (turn.resume && GONE_RE['claude-code'].test(raw)) turn.gone = true;
      const unknown = !result && UNKNOWN_OPTION_RE.exec(exit.err);
      if (unknown && args.indexOf(unknown[1]) !== -1) turn.unknown = unknown[1];
    }
    if (result && !result.is_error && result.structured_output) {
      return { ok: true, text: JSON.stringify(result.structured_output), files };
    }
    if (result && !result.is_error && typeof result.result === 'string' && result.result.trim()) {
      return { ok: true, text: result.result, files };
    }
    const said = clip((result && (result.result || (result.errors || []).join(' '))) || exit.err, 300);
    if (SIGNED_OUT_RE.test(said)) return { ok: false, code: 'signed-out', error: "Claude Code isn't signed in on this Mac" };
    return { ok: false, error: said ? 'Claude Code said: ' + said : `Claude Code stopped without answering (exit ${exit.code})` };
  });
  return { done, stop: run.stop };
}

/**
 * `codex exec`'s arguments. Read-only: the commands it runs to look around cannot write
 * anything, nor reach the network. Its web search is OpenAI's, run on OpenAI's side —
 * and on by default ("cached", OpenAI's index) since Codex 0.92, so Web access off has
 * to say "disabled", and on says "live" so it can open the page a box links to. A
 * Codex too old to know the key ignores it.
 *
 * With `turn` — { resume: true, id }, a kept thread of the board's conversation — it is
 * `codex exec resume` instead, which has no --cd (it runs where it is spawned, the same
 * folder) and keeps no sandbox of its own: a resumed thread takes whatever config.toml
 * says, full access included (probed 2026-10-09), so read-only is said twice: as exec's
 * own --sandbox, ahead of the subcommand — the flag a new thread is given — and as
 * `-c sandbox_mode`. Each was seen to hold a resumed turn read-only on its own. The id
 * and the prompt follow `--`, so neither can be read as an option, and an id that is not
 * a UUID is never passed: that turn starts a thread instead.
 */
function codexArgs(r, web, dir, schemaFile, outFile, turn) {
  // `codex exec` has no separate system prompt: the instructions lead the prompt.
  const prompt = r.system + '\n\n' + r.user;
  const search = web && r.operation !== 'condense' ? 'web_search="live"' : 'web_search="disabled"';
  if (turn && turn.resume && isUuid(turn.id)) {
    return [
      'exec',
      '--sandbox', 'read-only',
      'resume',
      '--json',
      '--skip-git-repo-check',
      '-c', 'sandbox_mode="read-only"',
      '-c', search,
      '--output-schema', schemaFile,
      '--output-last-message', outFile,
      '--', turn.id.toLowerCase(), prompt,
    ];
  }
  return [
    'exec',
    '--json',
    '--sandbox', 'read-only',
    '--skip-git-repo-check',
    '-c', search,
    '--cd', dir,
    '--output-schema', schemaFile,
    '--output-last-message', outFile,
    prompt,
  ];
}

/**
 * A finished web search, as the activity card says it — Codex's `web_search` item and
 * the Responses API's `web_search_call` carry the same `action`. Null when there is
 * nothing to say (an action it doesn't name).
 */
function webStep(action, query) {
  const a = action && typeof action === 'object' ? action : {};
  if (a.type === 'open_page' || a.type === 'find_in_page') {
    const url = a.url || query;
    return url ? { kind: 'fetch', text: 'Opened', target: pageName(url) } : null;
  }
  const q = a.query || (Array.isArray(a.queries) && a.queries[0]) || query;
  return q ? { kind: 'web', text: 'Searched the web for', target: clip(q, 60) } : null;
}

/**
 * Ask Codex. With `turn` (codexArgs says what it is), what the conversation needs is left
 * on it: `thread`, the thread id `thread.started` names; `gone`, a resume of a thread
 * Codex no longer has; `cantResume`, a resume this Codex is too old to take
 * (CODEX_REFUSED_RE).
 */
function askCodex(r, web, step, turn) {
  const dir = cliDir(r);
  if (!dir) return { done: Promise.resolve({ ok: false, error: 'This workspace has no folder to read' }), stop: () => {} };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-codex-'));
  const schemaFile = path.join(tmp, 'schema.json');
  const outFile = path.join(tmp, 'answer.json');
  fs.writeFileSync(schemaFile, JSON.stringify(r.schema));
  const args = codexArgs(r, web, dir, schemaFile, outFile, turn);

  let lastMessage = '';
  let failure = '';
  let files = 0;
  const run = spawnCli('codex', args, {
    cwd: dir,
    onLine: line => {
      let ev;
      try { ev = JSON.parse(line); } catch (_) { return; }
      const item = ev.item || null;
      if (ev.type === 'thread.started' && typeof ev.thread_id === 'string') {
        if (turn) turn.thread = ev.thread_id;
      } else if (item && (ev.type === 'item.started' || ev.type === 'item.completed')) {
        if (item.type === 'command_execution' && ev.type === 'item.started') {
          files++;
          step({ kind: 'run', text: 'Running', target: clip(String(item.command || '').replace(/^bash -lc /, ''), 70) });
        } else if (item.type === 'reasoning' && ev.type === 'item.started') {
          step({ kind: 'think', text: 'Thinking', target: '' });
        } else if (item.type === 'web_search' && ev.type === 'item.completed') {
          // Only once it is done: until then the item has no query or address yet.
          const st = webStep(item.action, typeof item.query === 'string' ? item.query : '');
          if (st) step(st);
        } else if (item.type === 'agent_message' && ev.type === 'item.completed' && typeof item.text === 'string') {
          lastMessage = item.text;
        }
      } else if (ev.msg && ev.msg.type === 'exec_command_begin') {
        // Older `codex exec --json` spoke in protocol events instead of items.
        files++;
        step({ kind: 'run', text: 'Running', target: clip([].concat(ev.msg.command || []).join(' '), 70) });
      } else if (ev.msg && ev.msg.type === 'web_search_end' && typeof ev.msg.query === 'string') {
        const st = webStep(null, ev.msg.query);
        if (st) step(st);
      } else if (ev.msg && ev.msg.type === 'agent_message' && typeof ev.msg.message === 'string') {
        lastMessage = ev.msg.message;
      } else if (ev.type === 'turn.failed' || ev.type === 'error') {
        const e = ev.error || ev;
        failure = String((e && e.message) || failure || 'Codex failed');
      }
    },
  });

  const done = run.done.then(exit => {
    let text = '';
    try { text = fs.readFileSync(outFile, 'utf8'); } catch (_) { text = ''; }
    fs.rm(tmp, { recursive: true, force: true }, () => {});
    if (!text.trim()) text = lastMessage;
    if (turn && turn.resume && exit.code !== 0 && GONE_RE.codex.test(failure + ' ' + exit.err)) turn.gone = true;
    if (turn && turn.resume && exit.code === 2 && CODEX_REFUSED_RE.test(exit.err)) turn.cantResume = true;
    if (exit.missing) return { ok: false, code: 'missing', error: "Codex isn't installed on this Mac" };
    if (exit.stopped === 'stopped') return { ok: false, code: 'stopped', error: 'Stopped' };
    if (exit.stopped === 'timeout') return { ok: false, code: 'timeout', error: 'Codex was still going after 5 minutes, so it was stopped' };
    if (exit.error) return { ok: false, error: 'Codex could not start: ' + exit.error.message };
    if (exit.code === 0 && text.trim()) return { ok: true, text, files };
    const said = clip(failure || exit.err, 300);
    if (SIGNED_OUT_RE.test(said)) return { ok: false, code: 'signed-out', error: "Codex isn't signed in on this Mac" };
    return { ok: false, error: said ? 'Codex said: ' + said : `Codex stopped without answering (exit ${exit.code})` };
  });
  return { done, stop: run.stop };
}

// ── one conversation per whiteboard ─────────────────────────────────────────
//
// A CLI's answer on a whiteboard continues the board's conversation with that CLI, so
// every branch explored on the board is context for the next question. The board keeps,
// per CLI, { id, workspace, dir, startedAt, lastAt, turns } — whiteboards.js, through the
// store index.js hands start() — and an answer continues that conversation only when
// the id is a UUID (it goes into the CLI's arguments) and it was had in this workspace's
// folder; anything else starts a new one, kept in its place once it has answered. A turn
// that fails or is stopped changes nothing: a new conversation is not kept, a continued
// one keeps its place. One the CLI no longer has (cleaned out, deleted by hand) is
// forgotten, and the same question starts a new one at once. A Codex too old to resume a
// thread (before 0.132) is found out by its first resume, which is asked again at once on
// its own; from then until the app quits its answers each stand alone, as an API's do.
//
// A conversation takes one question at a time, so the answers on one board and CLI wait
// in line, in the order they were asked — a lane each — while other boards and the other
// CLI answer meanwhile. One that has to wait says so (a 'wait' step); Stop takes it out
// of the line without anything spawned, and its 5 minutes start only when its CLI does.

// What each CLI says when asked to continue a conversation it does not have (probed
// 2026-10-09: Claude Code 2.1.292 exits 1, and codex-cli 0.160.0 exits 1 before asking).
const GONE_RE = {
  'claude-code': /No conversation found with session ID/i,
  codex: /no rollout found for thread id/i,
};

// A Claude Code too old for an option a conversation adds says so in commander's words —
// "error: unknown option '--name'" — and the turn goes again without it. Remembered until
// the app quits, so it is found out once; nothing that matters is lost: a Claude Code
// without the snapshot never recorded the system prompt in the first place.
const UNKNOWN_OPTION_RE = /unknown option '(--system-prompt-snapshot|--name)'/;
const claudeLacks = new Set();

// A Codex too old to continue a thread the way a turn asks refuses the resume's
// arguments in clap's words, exit 2, before it asks anything: `exec resume` took
// --output-schema only in 0.132 (probed 2026-10-09: 0.114 and 0.128 say "error:
// unexpected argument '--output-schema' found"), and one older still has no `exec
// resume` to hand them to. Such a Codex answers as it did before conversations — each
// question on its own, in no line, kept nowhere — from then until the app quits.
const CODEX_REFUSED_RE = /unexpected argument '[^']*' found/;
let codexCantResume = false;

/** The CLIs that answer each question on their own on this Mac, conversations or not. */
function cliAlone() {
  return codexCantResume ? ['codex'] : [];
}

const CONVERSATION_PROVIDERS = ['claude-code', 'codex'];
const WAIT_STEP = { kind: 'wait', text: 'Waiting for the answer before it', target: '' };
// What an answer that waited says once its turn comes, before its CLI has done anything
// to show: the card reads the last step as what is happening now, and a wait left last
// would go on saying "waiting" while the CLI thinks over the question.
const TURN_STEP = { kind: 'think', text: 'Thinking', target: '' };

// `${boardId} ${provider}` → { key, tail, waiting, generation, clearing }. `tail` settles
// when the last answer in line is done, `waiting` counts the answers in line (the one at
// work included), `generation` moves with every reset so a turn under way when the
// conversation was forgotten never writes it back, and `clearing` is a reset's write,
// which the next turn waits for before it reads. A lane goes once it is idle.
const lanes = new Map();

function laneFor(boardId, provider) {
  const key = boardId + ' ' + provider;
  let lane = lanes.get(key);
  if (!lane) {
    lane = { key, tail: Promise.resolve(), waiting: 0, generation: 0, clearing: null };
    lanes.set(key, lane);
  }
  return lane;
}

function idle(lane) {
  if (!lane.waiting && !lane.clearing && lanes.get(lane.key) === lane) lanes.delete(lane.key);
}

function stoppedAnswer() {
  return { ok: false, code: 'stopped', error: 'Stopped' };
}

/**
 * What a CLI is told on every turn of a conversation, beside webPrompt: that the board's
 * questions all come to it, and which of what it saw before still holds.
 */
function conversationPrompt() {
  return 'This whiteboard keeps one conversation with you: every question asked on it, from any box, ' +
    'comes to you here in turn. Earlier questions in it may be on other branches of the same flowchart, ' +
    'and the person may have edited, moved or deleted boxes since you saw them. The boxes sent with this ' +
    'question are the flowchart as it is now, and they win wherever they disagree with an earlier turn. ' +
    'Use what you have already read and learned in this conversation rather than reading it again, and ' +
    "don't repeat an answer already hanging off the question.";
}

/**
 * The conversation an ask is a turn of, or null for none — asked exactly as it always
 * was. Only Claude Code and Codex (not a Codex found too old to resume: cliAlone), only
 * an answer (a condensation reads nothing and is told to use only what it is sent), only
 * from a board named by its id, in a workspace that resolved to a folder, and only when
 * start() was handed somewhere to keep it.
 */
function conversationFor(provider, r, opts) {
  const store = opts && typeof opts === 'object' ? opts.conversations : null;
  if (CONVERSATION_PROVIDERS.indexOf(provider) === -1 || r.operation === 'condense') return null;
  if (cliAlone().indexOf(provider) !== -1) return null;
  if (!isUuid(r.boardId)) return null;
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') return null;
  const workspace = typeof r.wsId === 'string' ? r.wsId.trim() : '';
  if (!workspace || typeof r.dir !== 'string' || !r.dir) return null;
  const boardId = r.boardId.toLowerCase();
  return { store, boardId, provider, workspace, dir: r.dir, lane: laneFor(boardId, provider) };
}

/** The kept conversation, or null — a store that fails reads as none, and a new one starts. */
async function keptConversation(store, boardId, provider) {
  try {
    const entry = await store.get(boardId, provider);
    return entry && typeof entry === 'object' ? entry : null;
  } catch (err) {
    console.error('[switchboard] answer: could not read the conversation:', (err && err.message) || err);
    return null;
  }
}

/** Keep (or with null forget) a conversation: { ok } or { ok:false, error }, never a throw. */
async function keepConversation(store, boardId, provider, entry) {
  try {
    const res = await store.set(boardId, provider, entry);
    if (res && res.ok === false) return { ok: false, error: String(res.error || 'it was refused') };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/** A new conversation's turn: Claude Code takes the id chosen here; Codex names its own. */
async function newTurn(talk) {
  if (talk.provider !== 'claude-code') return { resume: false, id: null };
  return { resume: false, id: crypto.randomUUID(), name: await sessionName(talk) };
}

/** "Whiteboard · <its name>", what the session is called wherever it is listed, or null. */
async function sessionName(talk) {
  if (typeof talk.store.name !== 'function') return null;
  let name = null;
  try { name = await talk.store.name(talk.boardId); } catch (_) { name = null; }
  const clean = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return clean ? 'Whiteboard · ' + clean.slice(0, 120) : null;
}

/**
 * Ask `r` as the board's next turn: in line behind every answer on the same board and
 * CLI asked before it, then continued or started (conversationTurn). Stop while it
 * waits answers at once and spawns nothing, and the answers behind it still wait for the
 * one at work, never for it.
 */
function converse(talk, r, s, web, step) {
  const { lane } = talk;
  const ctl = { stopped: false, run: null, waited: lane.waiting > 0 };
  let leave;
  const left = new Promise(resolve => { leave = resolve; });
  if (ctl.waited) step(Object.assign({}, WAIT_STEP));
  lane.waiting++;
  const turn = lane.tail.then(() => (ctl.stopped ? stoppedAnswer() : conversationTurn(talk, r, s, web, step, ctl)));
  const settled = turn.then(() => {}, () => {});
  lane.tail = settled;
  settled.then(() => { lane.waiting--; idle(lane); });
  return {
    done: Promise.race([turn, left]),
    stop: () => {
      ctl.stopped = true;
      leave(stoppedAnswer());
      if (ctl.run) ctl.run.stop();
    },
  };
}

/** Once it is this answer's turn: continue the kept conversation, or start one, and keep it. */
async function conversationTurn(talk, r, s, web, step, ctl) {
  const { store, boardId, provider, lane } = talk;
  if (ctl.waited) step(Object.assign({}, TURN_STEP));
  // Found too old to resume while this answer waited: it goes on its own too.
  if (cliAlone().indexOf(provider) !== -1) return askAlone(talk, s, web, step, ctl);
  // Read only now: the answer ahead in line may have just started the conversation. A
  // reset meanwhile is waited for, and the conversation read again after it.
  let generation;
  let saved;
  do {
    generation = lane.generation;
    if (lane.clearing) await lane.clearing;
    saved = await keptConversation(store, boardId, provider);
  } while (generation !== lane.generation);
  // Continued only in the folder it was had in: a conversation about another workspace's
  // code would answer about the wrong code.
  const resume = !!(saved && isUuid(saved.id) && saved.workspace === talk.workspace && saved.dir === talk.dir);
  let turn = resume ? { resume: true, id: saved.id.toLowerCase() } : await newTurn(talk);
  let res = await askTurn(provider, r, s, web, step, turn, ctl);
  if (turn.cantResume && !ctl.stopped) {
    // A Codex too old to resume (CODEX_REFUSED_RE): the board's thread, which can never
    // be continued here, is forgotten, and the question asked again at once on its own,
    // as it was before conversations — as is every Codex answer after it.
    codexCantResume = true;
    if (generation === lane.generation) {
      const forgot = await keepConversation(store, boardId, provider, null);
      if (!forgot.ok) console.error('[switchboard] answer: could not forget a conversation Codex cannot resume:', forgot.error);
    }
    return askAlone(talk, s, web, step, ctl);
  }
  if (turn.resume && turn.gone && !ctl.stopped) {
    if (generation === lane.generation) {
      const forgot = await keepConversation(store, boardId, provider, null);
      if (!forgot.ok) console.error('[switchboard] answer: could not forget a conversation that is gone:', forgot.error);
    }
    turn = await newTurn(talk);
    res = await askTurn(provider, r, s, web, step, turn, ctl);
  }
  if (ctl.stopped) return stoppedAnswer();
  if (!res.ok) return res;
  // The id the CLI says it used: Claude Code's result names its session, Codex's
  // thread.started its thread. A Codex that named none has nothing to continue.
  const id = provider === 'claude-code'
    ? (isUuid(turn.session) ? turn.session : turn.id)
    : (isUuid(turn.thread) ? turn.thread : (turn.resume ? turn.id : null));
  // Reset while it answered: the answer lands, the conversation stays forgotten.
  if (!id || generation !== lane.generation) return res;
  const at = new Date().toISOString();
  const before = turn.resume && Number.isSafeInteger(saved.turns) && saved.turns > 0 ? saved.turns : 0;
  const entry = {
    id: id.toLowerCase(),
    workspace: talk.workspace,
    dir: talk.dir,
    startedAt: turn.resume && typeof saved.startedAt === 'string' ? saved.startedAt : at,
    lastAt: at,
    turns: before + 1,
  };
  const kept = await keepConversation(store, boardId, provider, entry);
  if (!kept.ok) {
    // The answer is still the answer; the next one starts a conversation of its own.
    console.error('[switchboard] answer: could not keep the conversation:', kept.error);
    return res;
  }
  return Object.assign({}, res, { conversation: { turns: entry.turns, resumed: turn.resume } });
}

/**
 * The question asked on its own, as start() asks one that is no turn of a conversation
 * (its prompt without conversationPrompt): nothing read from the board, nothing kept.
 */
async function askAlone(talk, s, web, step, ctl) {
  const res = await askTurn(talk.provider, talk.alone, s, web, step, { resume: false, id: null }, ctl);
  return ctl.stopped ? stoppedAnswer() : res;
}

/**
 * One CLI run of a turn. Stop before it spawns spawns nothing; Claude Code refusing an
 * option a conversation adds goes again without it (UNKNOWN_OPTION_RE), a new session
 * under a new id.
 */
async function askTurn(provider, r, s, web, step, turn, ctl) {
  for (;;) {
    if (ctl.stopped) return stoppedAnswer();
    let run;
    if (provider === 'claude-code') {
      turn.snapshot = !claudeLacks.has('--system-prompt-snapshot');
      if (claudeLacks.has('--name')) turn.name = null;
      run = askClaudeCode(r, s, web, step, turn);
    } else {
      run = askCodex(r, web, step, turn);
    }
    ctl.run = run;
    const res = await run.done;
    ctl.run = null;
    if (!res.ok && turn.unknown && !ctl.stopped) {
      claudeLacks.add(turn.unknown);
      turn.unknown = null;
      if (!turn.resume) turn.id = crypto.randomUUID();
      continue;
    }
    return res;
  }
}

/** The store and the board an IPC call names, or the error to answer with. */
function conversationTarget(boardId, opts) {
  const store = opts && typeof opts === 'object' ? opts.conversations : null;
  if (!isUuid(boardId)) return { error: 'Invalid whiteboard id' };
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    return { error: 'there is nowhere to keep conversations' };
  }
  return { store, boardId: boardId.toLowerCase() };
}

/** A kept conversation as the page may see it: how long and where — never its id or folder. */
function publicConversation(entry) {
  if (!entry || typeof entry !== 'object' || !isUuid(entry.id)) return null;
  if (!Number.isSafeInteger(entry.turns) || entry.turns < 1) return null;
  return {
    turns: entry.turns,
    startedAt: typeof entry.startedAt === 'string' ? entry.startedAt : '',
    lastAt: typeof entry.lastAt === 'string' ? entry.lastAt : '',
    workspace: typeof entry.workspace === 'string' ? entry.workspace : '',
  };
}

/**
 * conversation(boardId, { conversations, lookup? }) → { ok, data: { 'claude-code', codex },
 * alone? } — each CLI's conversation on the board as publicConversation() shows it, or
 * null. With `lookup` (workspaces.lookup, as resolveAnswerDir takes it), one had in a
 * folder its workspace is no longer reads as none: the next answer would start a new one
 * there. `alone` lists a CLI that answers each question on its own on this Mac — a Codex
 * too old to resume (cliAlone) — whose conversation reads as none; it is left out when
 * there is no such CLI.
 */
async function conversation(boardId, opts) {
  const target = conversationTarget(boardId, opts);
  if (target.error) return { ok: false, error: target.error };
  try {
    const data = {};
    const alone = cliAlone();
    for (const provider of CONVERSATION_PROVIDERS) {
      if (alone.indexOf(provider) !== -1) {
        data[provider] = null;
        continue;
      }
      const entry = await target.store.get(target.boardId, provider);
      data[provider] = (await movedAway(entry, opts)) ? null : publicConversation(entry);
    }
    return alone.length ? { ok: true, data, alone } : { ok: true, data };
  } catch (err) {
    return { ok: false, error: `could not read the whiteboard's conversations: ${(err && err.message) || err}` };
  }
}

/**
 * Whether a kept conversation's workspace now has another folder — the rail's config
 * changed under the same id — so conversationTurn would not continue it. A workspace that
 * resolves to nothing says nothing here: the answer is refused for it before it is asked.
 */
async function movedAway(entry, opts) {
  const lookup = opts && typeof opts === 'object' && typeof opts.lookup === 'function' ? opts.lookup : null;
  if (!lookup || !entry || typeof entry !== 'object' || typeof entry.workspace !== 'string') return false;
  let ws = null;
  try { ws = await lookup(entry.workspace); } catch (_) { return false; }
  return !!(ws && typeof ws.dir === 'string' && ws.dir && ws.dir !== entry.dir);
}

/**
 * resetConversation(boardId, provider?, { conversations }) → { ok } — the board forgets
 * its conversation with `provider`, or with both CLIs when it is left out, and its next
 * answer starts a new one. An answer already on its way still lands; it just is not
 * written back. The lane's generation moves first, at once, and the next turn in line
 * waits for the write before it reads.
 */
async function resetConversation(boardId, provider, opts) {
  const target = conversationTarget(boardId, opts);
  if (target.error) return { ok: false, error: target.error };
  if (provider !== undefined && provider !== null && CONVERSATION_PROVIDERS.indexOf(provider) === -1) {
    return { ok: false, error: 'that provider keeps no conversation' };
  }
  const which = provider ? [provider] : CONVERSATION_PROVIDERS;
  const results = await Promise.all(which.map(p => {
    const lane = laneFor(target.boardId, p);
    lane.generation++;
    const write = keepConversation(target.store, target.boardId, p, null);
    const clearing = write.then(() => {});
    lane.clearing = clearing;
    clearing.then(() => {
      if (lane.clearing === clearing) lane.clearing = null;
      idle(lane);
    });
    return write;
  }));
  const failed = results.find(res => !res.ok);
  return failed ? { ok: false, error: `could not forget the conversation: ${failed.error}` } : { ok: true };
}

// ── an API ──────────────────────────────────────────────────────────────────

function apiJob(fn) {
  const controller = new AbortController();
  let why = null;
  const timer = setTimeout(() => { why = 'timeout'; controller.abort(); }, API_TIMEOUT_MS);
  // The signal stays wired until the answer is in, the streamed body included: Stop in
  // the middle of a long OpenAI answer has to end it there.
  const done = fn(controller.signal).then(res => res, err => {
    if (why === 'timeout') return { ok: false, code: 'timeout', error: 'It took too long to answer. Try a lower effort.' };
    if (controller.signal.aborted) return { ok: false, code: 'stopped', error: 'Stopped' };
    return { ok: false, error: String((err && err.message) || err) };
  }).finally(() => clearTimeout(timer));
  return { done, stop: () => { if (!why) why = 'stopped'; controller.abort(); } };
}

// Anthropic's own web tools, run on its side. The basic versions: every model on offer
// takes them, and they are called directly rather than from code execution. A few
// uses each — a question on a diagram needs a page or two, not a research project.
const CLAUDE_WEB_TOOLS = [
  { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
  { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 3, max_content_tokens: 20000 },
];

// How many times a turn Anthropic paused in its web loop (stop_reason "pause_turn") is
// sent back to carry on, before giving up.
const CLAUDE_MAX_RESUMES = 3;

/**
 * The Messages API request. The answer comes back as the response's text, in the
 * schema's shape (structured outputs) — not as a forced tool call, which Opus 5.5,
 * Sonnet 5.5 and Fable 5.1 refuse with a 400, and which would leave no room to look
 * anything up first.
 */
function claudeApiBody(r, s, web) {
  const body = {
    model: s.claudeApiModel,
    max_tokens: 4096,
    system: r.system,
    messages: [{ role: 'user', content: r.user }],
    output_config: { format: { type: 'json_schema', schema: r.schema } },
  };
  if (web && r.operation !== 'condense') body.tools = CLAUDE_WEB_TOOLS;
  return body;
}

/**
 * The answer's JSON out of a turn's content: the text after the last web block (any
 * words before a search are not the answer). The text can come split across blocks,
 * so they are joined.
 */
function claudeAnswerText(content) {
  const blocks = Array.isArray(content) ? content.filter(Boolean) : [];
  let at = blocks.length;
  while (at > 0 && blocks[at - 1].type === 'text') at--;
  return blocks.slice(at).map(b => (typeof b.text === 'string' ? b.text : '')).join('').trim();
}

function askClaudeApi(r, s, web) {
  return apiJob(async signal => {
    const key = keyFor('claude-api');
    if (!key) return { ok: false, code: 'no-key', error: 'There is no Claude API key on this Mac yet' };
    const body = claudeApiBody(r, s, web);
    let turn = [];                                   // the assistant's turn so far, across pauses
    let searchDropped = false;
    for (let resumes = 0; ; resumes++) {
      const messages = turn.length ? body.messages.concat([{ role: 'assistant', content: turn }]) : body.messages;
      const res = await net.fetch('https://api.anthropic.com/v1/messages', {
        signal,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(Object.assign({}, body, { messages })),
      });
      const raw = await res.text();
      if (res.status === 401 || res.status === 403) {
        return { ok: false, code: 'bad-key', error: "Anthropic says the Claude API key isn't valid" };
      }
      if (!res.ok) {
        const said = errorText(raw);
        // Web search always cites what it found, and should the API ever refuse citations
        // beside a structured answer, the answer goes again with only web fetch, whose
        // citations are off: a link in a box still opens.
        if (web && res.status === 400 && /citation/i.test(said) && !searchDropped && !turn.length) {
          searchDropped = true;
          body.tools = body.tools.filter(t => t.name !== 'web_search');
          resumes--;
          continue;
        }
        // An organisation can switch Anthropic's web tools off; the way through is ours.
        if (web && /web[ _-]?(search|fetch)/i.test(said)) {
          return { ok: false, error: `The Claude API won't use the web with this key — ${said}. Turn Web access off to answer without it.` };
        }
        return { ok: false, error: `The Claude API answered ${res.status} — ${said || 'try again'}` };
      }
      let data;
      try { data = JSON.parse(raw); } catch (_) { return { ok: false, error: 'The Claude API sent back something that is not JSON' }; }
      turn = turn.concat(Array.isArray(data.content) ? data.content : []);
      // A long web turn is paused, not finished: sent back as it is, it carries on.
      if (data.stop_reason === 'pause_turn' && resumes < CLAUDE_MAX_RESUMES) continue;
      if (data.stop_reason === 'refusal') return { ok: false, error: 'Claude declined to answer that' };
      if (data.stop_reason === 'max_tokens') return { ok: false, error: 'The answer was cut off before it finished — try asking for less' };
      const text = claudeAnswerText(turn);
      if (!text) return { ok: false, error: 'The Claude API answered without boxes' };
      return { ok: true, text };
    }
  });
}

/**
 * The Responses API request. With Web access, OpenAI's own web search, which also opens
 * a page a box links to; a few calls at most, and the smallest search context, since a
 * box is eight words.
 */
function openAiBody(r, s, web) {
  const body = {
    model: s.openaiModel,
    reasoning: { effort: s.openaiEffort },
    // Streamed, as the admin's caller does: a long think with nothing on the wire is
    // the connection a VPN or a proxy drops.
    stream: true,
    input: [
      { role: 'system', content: r.system },
      { role: 'user', content: r.user },
    ],
    text: { format: { type: 'json_schema', name: 'flow_answer', strict: true, schema: r.schema } },
  };
  if (web && r.operation !== 'condense') {
    body.tools = [{ type: 'web_search', search_context_size: 'low' }];
    body.max_tool_calls = 4;
  }
  return body;
}

function askOpenAi(r, s, web, step) {
  return apiJob(async signal => {
    const key = keyFor('openai-api');
    if (!key) return { ok: false, code: 'no-key', error: 'There is no OpenAI API key on this Mac yet' };
    const res = await net.fetch('https://api.openai.com/v1/responses', {
      signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(openAiBody(r, s, web)),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, code: 'bad-key', error: "OpenAI says the API key isn't valid" };
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `OpenAI answered ${res.status} — ${errorText(detail) || 'try again'}` };
    }
    return { ok: true, text: await readOpenAiStream(res.body, step) };
  });
}

// The admin's own Responses API stream reader, ported: output-text deltas
// accumulated into the answer, a refusal or a failed response surfaced as an error.
// Switchboard: each finished web search goes to `onStep`, and only the final message's
// text is the answer — a model may say a word before it searches (a "commentary"
// message), which is not part of the JSON.
async function readOpenAiStream(body, onStep) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let refusal = '';
  let streamError = '';
  let incomplete = '';
  const step = typeof onStep === 'function' ? onStep : () => {};
  const messages = [];                   // [{ id, phase, text }], in the order they began
  const byId = new Map();

  const handle = raw => {
    const data = raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data === '[DONE]') return;
    let ev;
    try { ev = JSON.parse(data); } catch (_) { return; }
    const item = ev.item && typeof ev.item === 'object' ? ev.item : null;
    if (ev.type === 'response.output_item.added' && item && item.type === 'message' && item.id) {
      const m = { id: item.id, phase: item.phase || null, text: '' };
      messages.push(m);
      byId.set(item.id, m);
    } else if (ev.type === 'response.output_item.done' && item && item.type === 'web_search_call') {
      const st = webStep(item.action, '');
      if (st) step(st);
    } else if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
      text += ev.delta;
      const m = byId.get(ev.item_id);
      if (m) m.text += ev.delta;
    } else if (ev.type === 'response.refusal.delta' && typeof ev.delta === 'string') refusal += ev.delta;
    else if (ev.type === 'response.incomplete') {
      const reason = ev.response && ev.response.incomplete_details && ev.response.incomplete_details.reason;
      incomplete = typeof reason === 'string' ? reason : 'incomplete';
    } else if (ev.type === 'response.failed') {
      const msg = ev.response && ev.response.error && ev.response.error.message;
      streamError = typeof msg === 'string' ? msg : 'The answer failed.';
    } else if (ev.type === 'error') {
      streamError = typeof ev.message === 'string' ? ev.message : 'Stream error.';
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        handle(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
      }
    }
    if (buffer.trim()) handle(buffer);
  } finally {
    try { reader.releaseLock(); } catch (_) { /* already released */ }
  }
  if (streamError) throw new Error('OpenAI: ' + streamError);
  if (refusal.trim()) throw new Error('The model refused to answer: ' + refusal.trim());
  // The last message that isn't commentary — none, when all it said was commentary (an
  // answer cut short says why below). Every delta together only when the stream named
  // no messages at all (the admin's reading).
  if (messages.length) {
    const answers = messages.filter(m => m.phase !== 'commentary' && m.text.trim());
    text = answers.length ? answers[answers.length - 1].text : '';
  }
  if (!text.trim()) throw new Error(incomplete ? `The answer stopped early (${incomplete}). Try a lower effort.` : 'OpenAI sent back an empty answer');
  return text;
}

module.exports = {
  status,
  settings,
  setSettings,
  setKey,
  removeKey,
  start,
  stop,
  stopAll,
  resolveAnswerDir,
  conversation,
  resetConversation,
  // For the tests.
  PROVIDERS,
  OPENAI_MODELS,
  CLAUDE_MODELS,
  claudeStep,
  cliDir,
  openaiEffortFor,
  keysFile,
  webPrompt,
  webStep,
  conversationPrompt,
  publicConversation,
  claudeCodeArgs,
  codexArgs,
  claudeApiBody,
  claudeAnswerText,
  openAiBody,
  readOpenAiStream,
};

// A request id the renderer can use when it has none of its own.
module.exports.newId = () => crypto.randomUUID();
