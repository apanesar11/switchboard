'use strict';

// answer.js — ✦ Answer on the Diagrams tab: which AI answers a box's question, and the
// asking. ARCHITECTURE §4.18, §5 M11.
//
// Four ways to answer, picked on the Settings screen or under ✦ Answer's chevron:
//
//   claude-code   Claude Code's CLI, run in the workspace folder with ONLY its read and
//                 search tools, so it reads the code before it answers. Slower — it
//                 opens files first — and it knows the code.
//   codex         Codex's CLI, `codex exec` in its read-only sandbox, the same idea.
//   claude-api    The Claude API with a key the user typed in. Sees only the diagram;
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
// Nothing throws. Every export resolves to a value; a failure is
// `{ ok: false, error: '<human sentence>', code? }`, where `code` is what the renderer
// needs to offer the one action that fixes it: 'missing' (not installed), 'signed-out',
// 'no-key', 'bad-key', 'timeout', 'stopped'.

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

/**
 * start(id, req, onStep) → { ok, text } — the answer's JSON, for the renderer to read
 * into boxes — or { ok:false, error, code }.
 *
 * req: { provider, dir, system, user, schema }. `dir` is the workspace folder, resolved
 * by index.js from the workspace id; a CLI runs there and nowhere else.
 */
function start(id, req, onStep) {
  const key = String(id || '');
  if (!key) return Promise.resolve({ ok: false, error: 'the request came without an id' });
  if (runs.has(key)) return Promise.resolve({ ok: false, error: 'that answer is already being asked for' });
  const r = req && typeof req === 'object' ? req : {};
  if (typeof r.system !== 'string' || typeof r.user !== 'string' || !r.user.trim()) {
    return Promise.resolve({ ok: false, error: 'Write a question in the box first' });
  }
  if (!r.schema || typeof r.schema !== 'object') return Promise.resolve({ ok: false, error: 'the request came without its answer format' });
  const provider = pickFrom(PROVIDER_IDS, r.provider, null);
  if (!provider) return Promise.resolve({ ok: false, error: 'Pick who answers first' });
  const step = typeof onStep === 'function' ? onStep : () => {};
  const s = settings();

  let job;
  if (provider === 'claude-code') job = askClaudeCode(r, s, step);
  else if (provider === 'codex') job = askCodex(r, step);
  else if (provider === 'claude-api') job = askClaudeApi(r, s);
  else job = askOpenAi(r, s);

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

/** Everything still asking — the quit path, so no CLI outlives the app. */
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
    case 'StructuredOutput': return { kind: 'write', text: 'Writing the answer', target: '' };
    default: return { kind: 'other', text: clip(block && block.name, 40) || 'Working', target: '' };
  }
}

const SIGNED_OUT_RE = /(not logged in|please run \/login|log in|invalid api key|authentication|unauthori[sz]ed|oauth token)/i;

function askClaudeCode(r, s, step) {
  const dir = r.dir;
  if (!dir) return { done: Promise.resolve({ ok: false, error: 'This workspace has no folder to read' }), stop: () => {} };
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--json-schema', JSON.stringify(r.schema),
    // Read and search only. Nothing it can do changes a file or runs a command.
    '--tools', 'Read,Grep,Glob',
    '--allowedTools', 'Read,Grep,Glob',
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--append-system-prompt', r.system,
  ];
  if (s.claudeCodeEffort && s.claudeCodeEffort !== 'own') args.push('--effort', s.claudeCodeEffort);

  let result = null;
  let files = 0;
  const run = spawnCli('claude', args, {
    cwd: dir,
    input: r.user,
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
    if (exit.missing) return { ok: false, code: 'missing', error: "Claude Code isn't installed on this Mac" };
    if (exit.stopped === 'stopped') return { ok: false, code: 'stopped', error: 'Stopped' };
    if (exit.stopped === 'timeout') return { ok: false, code: 'timeout', error: 'Claude Code was still going after 5 minutes, so it was stopped' };
    if (exit.error) return { ok: false, error: 'Claude Code could not start: ' + exit.error.message };
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

function askCodex(r, step) {
  const dir = r.dir;
  if (!dir) return { done: Promise.resolve({ ok: false, error: 'This workspace has no folder to read' }), stop: () => {} };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-codex-'));
  const schemaFile = path.join(tmp, 'schema.json');
  const outFile = path.join(tmp, 'answer.json');
  fs.writeFileSync(schemaFile, JSON.stringify(r.schema));
  // `codex exec` has no separate system prompt: the instructions lead the prompt.
  const prompt = r.system + '\n\n' + r.user;
  const args = [
    'exec',
    '--json',
    // Read-only: the commands it runs to look around cannot write anything.
    '--sandbox', 'read-only',
    '--skip-git-repo-check',
    '--cd', dir,
    '--output-schema', schemaFile,
    '--output-last-message', outFile,
    prompt,
  ];

  let lastMessage = '';
  let failure = '';
  let files = 0;
  const run = spawnCli('codex', args, {
    cwd: dir,
    onLine: line => {
      let ev;
      try { ev = JSON.parse(line); } catch (_) { return; }
      const item = ev.item || null;
      if (item && (ev.type === 'item.started' || ev.type === 'item.completed')) {
        if (item.type === 'command_execution' && ev.type === 'item.started') {
          files++;
          step({ kind: 'run', text: 'Running', target: clip(String(item.command || '').replace(/^bash -lc /, ''), 70) });
        } else if (item.type === 'reasoning' && ev.type === 'item.started') {
          step({ kind: 'think', text: 'Thinking', target: '' });
        } else if (item.type === 'agent_message' && ev.type === 'item.completed' && typeof item.text === 'string') {
          lastMessage = item.text;
        }
      } else if (ev.msg && ev.msg.type === 'exec_command_begin') {
        // Older `codex exec --json` spoke in protocol events instead of items.
        files++;
        step({ kind: 'run', text: 'Running', target: clip([].concat(ev.msg.command || []).join(' '), 70) });
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

function askClaudeApi(r, s) {
  return apiJob(async signal => {
    const key = keyFor('claude-api');
    if (!key) return { ok: false, code: 'no-key', error: 'There is no Claude API key on this Mac yet' };
    const res = await net.fetch('https://api.anthropic.com/v1/messages', {
      signal,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: s.claudeApiModel,
        max_tokens: 1024,
        system: r.system,
        messages: [{ role: 'user', content: r.user }],
        // The answer as one forced tool call, whose input IS the JSON the schema says.
        tools: [{
          name: 'flow_answer',
          description: 'Give the answer as the boxes to add to the flowchart.',
          input_schema: r.schema,
        }],
        tool_choice: { type: 'tool', name: 'flow_answer' },
      }),
    });
    const body = await res.text();
    if (res.status === 401 || res.status === 403) {
      return { ok: false, code: 'bad-key', error: "Anthropic says the Claude API key isn't valid" };
    }
    if (!res.ok) return { ok: false, error: `The Claude API answered ${res.status} — ${errorText(body) || 'try again'}` };
    let data;
    try { data = JSON.parse(body); } catch (_) { return { ok: false, error: 'The Claude API sent back something that is not JSON' }; }
    const block = (data.content || []).find(b => b && b.type === 'tool_use');
    if (!block || !block.input) return { ok: false, error: 'The Claude API answered without boxes' };
    return { ok: true, text: JSON.stringify(block.input) };
  });
}

function askOpenAi(r, s) {
  return apiJob(async signal => {
    const key = keyFor('openai-api');
    if (!key) return { ok: false, code: 'no-key', error: 'There is no OpenAI API key on this Mac yet' };
    const res = await net.fetch('https://api.openai.com/v1/responses', {
      signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
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
      }),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, code: 'bad-key', error: "OpenAI says the API key isn't valid" };
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `OpenAI answered ${res.status} — ${errorText(detail) || 'try again'}` };
    }
    return { ok: true, text: await readOpenAiStream(res.body) };
  });
}

// The admin's own Responses API stream reader, ported: output-text deltas
// accumulated into the answer, a refusal or a failed response surfaced as an error.
async function readOpenAiStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let refusal = '';
  let streamError = '';
  let incomplete = '';

  const handle = raw => {
    const data = raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data === '[DONE]') return;
    let ev;
    try { ev = JSON.parse(data); } catch (_) { return; }
    if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') text += ev.delta;
    else if (ev.type === 'response.refusal.delta' && typeof ev.delta === 'string') refusal += ev.delta;
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
  // For the tests.
  PROVIDERS,
  OPENAI_MODELS,
  CLAUDE_MODELS,
  claudeStep,
  openaiEffortFor,
  keysFile,
};

// A request id the renderer can use when it has none of its own.
module.exports.newId = () => crypto.randomUUID();
