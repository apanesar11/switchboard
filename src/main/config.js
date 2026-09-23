'use strict';

// Config file load / save / defaults.  ARCHITECTURE §3 and §5 (M2).
//
// The shipped defaults live in default-config.json; the user's file at
// ~/.switchboard/config.json is deep-merged ON TOP of them, so a default that
// changes in a later version still reaches a user who has a config file.
// Nothing in here throws: a corrupt config file falls back to the defaults and
// reports itself through `configError` on the returned config.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = require('./default-config.json');

// SWITCHBOARD_CONFIG points the app at a different config file — used to run it
// against a fixture workspace without disturbing the real one.
const CONFIG_FILE = process.env.SWITCHBOARD_CONFIG || path.join(os.homedir(), '.switchboard', 'config.json');
const CONFIG_DIR = path.dirname(CONFIG_FILE);

let cached = null;      // the merged config handed to callers
let userConfig = null;  // the raw parsed user file, so save() only ever rewrites their overrides

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (isPlainObject(v)) {
    const out = {};
    for (const k of Object.keys(v)) out[k] = clone(v[k]);
    return out;
  }
  return v;
}

// Objects merge key by key; arrays and scalars are replaced outright, so a user
// who writes `"exclude": ["archive"]` gets exactly that list, not a union.
function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return clone(patch);
  const out = isPlainObject(base) ? clone(base) : {};
  for (const k of Object.keys(patch)) {
    const next = patch[k];
    out[k] = isPlainObject(next) && isPlainObject(out[k]) ? deepMerge(out[k], next) : clone(next);
  }
  return out;
}

function defaults() {
  return clone(DEFAULTS);
}

// `root` is the field ARCHITECTURE §3 names; `appsRoot` is the name the port
// inventory used and is kept as an alias so either one can be edited by hand.
function normaliseRoot(cfg, raw) {
  const userSetAppsRoot = isPlainObject(raw) && typeof raw.appsRoot === 'string';
  const userSetRoot = isPlainObject(raw) && typeof raw.root === 'string';
  if (userSetAppsRoot && !userSetRoot) cfg.root = cfg.appsRoot;
  // No root is selected until the user configures one.
  cfg.root = typeof cfg.root === 'string' && cfg.root.trim() ? cfg.root.trim() : null;
  // Keep the user's file as written; only the resolved runtime config is absolute.
  if (cfg.root === '~') cfg.root = os.homedir();
  else if (typeof cfg.root === 'string' && cfg.root.startsWith('~/')) {
    cfg.root = path.join(os.homedir(), cfg.root.slice(2));
  }
  cfg.appsRoot = cfg.root;
  return cfg;
}

function readUserFile() {
  let text;
  try {
    text = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { data: null, error: null, missing: true };
    return { data: null, error: `could not read ${CONFIG_FILE}: ${err.message}`, missing: false };
  }
  try {
    const data = JSON.parse(text);
    if (!isPlainObject(data)) return { data: null, error: `${CONFIG_FILE} is not a JSON object — using the defaults`, missing: false };
    return { data, error: null, missing: false };
  } catch (err) {
    return { data: null, error: `${CONFIG_FILE} is not valid JSON (${err.message}) — using the defaults`, missing: false };
  }
}

function writeAtomic(data) {
  const text = JSON.stringify(data, null, 2) + '\n';
  const tmp = CONFIG_FILE + '.' + process.pid + '.tmp';
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
}

function load() {
  const read = readUserFile();
  let configError = read.error;

  if (read.missing) {
    // First run starts empty. The example and setup skill are opt-in.
    userConfig = defaults();
    try {
      writeAtomic(userConfig);
    } catch (err) {
      configError = `could not create ${CONFIG_FILE}: ${err.message}`;
    }
  } else {
    userConfig = read.data || {};
  }

  if (configError) console.error('[switchboard] config: ' + configError);

  cached = normaliseRoot(deepMerge(defaults(), userConfig), read.data);
  cached.configPath = CONFIG_FILE;
  cached.configError = configError;
  return cached;
}

function get() {
  return cached || load();
}

// Merges `patch` into the user's file (never the defaults) and rewrites it
// atomically.  Returns the new merged config, with configError set if the write
// failed — it never throws.
function save(patch) {
  if (!cached) load();
  const next = deepMerge(userConfig || {}, patch || {});
  let configError = null;
  try {
    writeAtomic(next);
    userConfig = next;
  } catch (err) {
    configError = `could not write ${CONFIG_FILE}: ${err.message}`;
    console.error('[switchboard] config: ' + configError);
  }
  cached = normaliseRoot(deepMerge(defaults(), userConfig || {}), userConfig);
  cached.configPath = CONFIG_FILE;
  cached.configError = configError;
  return cached;
}

// ---------------------------------------------------------------------------
// Per-workspace resolution
// ---------------------------------------------------------------------------

// 'sample-2' → '-2'; 'demo' → ''.  The workspace's numeric suffix is also the
// suffix on every repo directory inside it (sample-api → sample-api-2).
function suffixOf(wsId) {
  const m = /-(\d+)$/.exec(String(wsId || ''));
  return m ? '-' + m[1] : '';
}

// Config is keyed by a repo's DISPLAY name (sample-api). This turns that back
// into the directory on disk (sample-api-2), preferring the real scanned repo.
// A single-repo workspace's one repo is the workspace folder itself, so it is '.'.
function repoDirName(ws, displayName) {
  if (Array.isArray(ws && ws.repos)) {
    const hit = ws.repos.find(r => r && r.name === displayName);
    if (hit && hit.dir && ws.dir && path.resolve(hit.dir) === path.resolve(ws.dir)) return '.';
    if (hit && hit.dirName) return hit.dirName;
  }
  return displayName + suffixOf(ws && ws.id);
}

// 'http://localhost:3000' → 'localhost:3000', which is what the row renders.
function labelForUrl(url) {
  return String(url).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
}

function projectOf(cfg, ws) {
  return (cfg.projects && cfg.projects[ws && ws.project]) || {};
}

function overrideOf(cfg, ws) {
  return (cfg.workspaces && cfg.workspaces[ws && ws.id]) || {};
}

function pick(over, project, key, fallback) {
  if (Object.prototype.hasOwnProperty.call(over, key)) return over[key];
  if (Object.prototype.hasOwnProperty.call(project, key)) return project[key];
  return fallback;
}

// Every link this workspace's Start will actually bring up, in declared order.
// A repo the dev command never launches (sample-web) gets no link, because a
// permanently dead address on the row is worse than no address at all.
function buildLinks(ws, project, over) {
  const declared = Object.assign({}, project.repos, over.repos);
  const present = Array.isArray(ws && ws.repos) ? ws.repos.map(r => r.name) : null;
  const links = [];

  for (const name of Object.keys(declared)) {
    const repo = declared[name] || {};
    if (!repo.url) continue;
    if (repo.startedByRootDev === false) continue;
    if (present && present.indexOf(name) === -1) continue;
    links.push({ label: labelForUrl(repo.url), url: repo.url, repo: name, live: false });
  }

  // Per-workspace `links: [{repo, url}]` overrides replace the matching repo's
  // link and append anything new.
  for (const extra of Array.isArray(over.links) ? over.links : []) {
    if (!extra || !extra.url) continue;
    const link = { label: extra.label || labelForUrl(extra.url), url: extra.url, repo: extra.repo || null, live: false };
    const at = links.findIndex(l => l.repo === link.repo);
    if (at === -1) links.push(link); else links[at] = link;
  }

  return links;
}

function buildPreflight(ws, checks) {
  const out = [];
  for (const check of Array.isArray(checks) ? checks : []) {
    if (!check || !check.check) continue;
    let value = check.value;
    // A fileExists check is written relative to a repo so it survives sample-5;
    // resolve it to the absolute path the runner will stat.
    if (check.check === 'fileExists' && ws && ws.dir) {
      value = check.repo
        ? path.join(ws.dir, repoDirName(ws, check.repo), String(check.value || ''))
        : path.join(ws.dir, String(check.value || ''));
    }
    out.push({ check: check.check, value, failMessage: check.failMessage || `${check.check} failed for ${value}` });
  }
  return out;
}

function buildProcesses(ws, list) {
  const out = [];
  for (const proc of Array.isArray(list) ? list : []) {
    if (!proc || !proc.command) continue;
    // A process dir is normally a repo's display name, which carries the
    // workspace's numeric suffix on disk (demo-nextjs, sample-api-2). But it
    // may also be a plain relative path ('.', 'packages/api'), which must be
    // joined as written — suffixing it would invent a directory.
    const raw = proc.dir || proc.name || '.';
    let dir = raw;
    if (ws && ws.dir) {
      const suffixed = path.join(ws.dir, repoDirName(ws, raw));
      dir = fs.existsSync(suffixed) ? suffixed : path.resolve(ws.dir, raw);
    }
    out.push({ name: proc.name || proc.dir, dir, command: proc.command });
  }
  return out;
}

// The merged run configuration for one discovered workspace: per-workspace
// overrides win over the project defaults.
function resolveWorkspace(ws) {
  const cfg = get();
  const project = projectOf(cfg, ws);
  const over = overrideOf(cfg, ws);

  return {
    devCommand: pick(over, project, 'devCommand', null) || null,
    processes: buildProcesses(ws, pick(over, project, 'processes', [])),
    preflight: buildPreflight(ws, pick(over, project, 'preflight', [])),
    sideEffects: pick(over, project, 'sideEffects', []) || [],
    extras: pick(over, project, 'extras', []) || [],
    needsPty: !!pick(over, project, 'needsPty', false),
    links: buildLinks(ws, project, over),
  };
}

// §5: linksFor(workspace, repo) — `repo` may be a Repo object or a display name.
function linksFor(workspace, repo) {
  const name = repo && typeof repo === 'object' ? repo.name : repo;
  return resolveWorkspace(workspace).links.filter(l => l.repo === name);
}

module.exports = {
  load,
  save,
  get,
  defaults,
  resolveWorkspace,
  linksFor,
  CONFIG_FILE,
};
