'use strict';

// ports.js — listening-port probe, ngrok tunnel lookup, PID attribution. ARCHITECTURE §5 M5.
//
// Zero dependencies, CommonJS, main process only. Nothing in here throws: every
// path resolves to a value (false / null / []), because the runner polls this
// module on a timer and an unhandled rejection there would reach the user.

const net = require('net');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');

const pexec = promisify(execFile);

// A TCP connect probe sweeps the whole 10-port inventory in ~2.6 ms; the same
// sweep through lsof takes ~58 ms even in parallel. lsof is only reached when we
// need the PID behind a port, which is never on the hot path.
const PROBE_TIMEOUT = 150;
const NGROK_TIMEOUT = 1000;
const NGROK_API = { host: '127.0.0.1', port: 4040, path: '/api/tunnels' };

// /usr/sbin is on the PATH even for a Finder-launched Electron app, but spelling
// the path out removes the doubt entirely.
const LSOF = fs.existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof';

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function parseUrl(url) {
  try { return new URL(String(url)); } catch (e) { return null; }
}

/** 'http://tenant.localhost:5179' -> 5179; 'https://x.ngrok-free.app' -> 443. */
function portOf(url) {
  const u = parseUrl(url);
  if (!u) return null;
  if (u.port) return Number(u.port);
  if (u.protocol === 'https:') return 443;
  if (u.protocol === 'http:') return 80;
  return null;
}

/**
 * Everything a browser routes to the loopback. `*.localhost` included — that is
 * how example-customer-portal's tenant subdomain reaches 127.0.0.1:5179.
 */
function isLocalHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') ||
    h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' || h === '::';
}

/** The label the mock-up's link chip shows: 'localhost:3000'. */
function labelFor(url) {
  const u = parseUrl(url);
  if (!u) return String(url || '');
  return u.port ? u.hostname + ':' + u.port : u.hostname;
}

function normalizeLink(link) {
  const l = (typeof link === 'string') ? { url: link } : Object.assign({}, link || {});
  const url = l.url || null;
  const port = Number(l.port) || portOf(url) || null;
  const kind = l.kind || null;
  return {
    label: l.label || (url ? labelFor(url) : (kind === 'ngrok' ? 'ngrok' : String(port || ''))),
    url,
    repo: l.repo || null,
    port,
    kind,
    live: !!l.live,
  };
}

function normalizeLinks(links) {
  return (Array.isArray(links) ? links : []).map(normalizeLink);
}

/** Every distinct local port a set of links declares. */
function portsOf(links) {
  const out = [];
  for (const l of normalizeLinks(links)) {
    if (!l.port) continue;
    if (l.url && !isLocalHost((parseUrl(l.url) || {}).hostname)) continue;
    if (out.indexOf(l.port) === -1) out.push(l.port);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

/** True when something accepts a TCP connection on the port. ECONNREFUSED === free. */
function isListening(port, opts) {
  const o = opts || {};
  const host = o.host || '127.0.0.1';
  const timeout = Number(o.timeout) || PROBE_TIMEOUT;
  const p = Number(port);
  return new Promise((resolve) => {
    if (!Number.isInteger(p) || p < 1 || p > 65535) return resolve(false);
    const socket = new net.Socket();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch (e) { /* already gone */ }
      resolve(v);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try { socket.connect(p, host); } catch (e) { finish(false); }
  });
}

/** { 3000: true, 5173: false, ... } for a list of ports, all at once. */
async function sweep(list, opts) {
  const uniq = [];
  for (const n of (Array.isArray(list) ? list : [])) {
    const p = Number(n);
    if (Number.isInteger(p) && uniq.indexOf(p) === -1) uniq.push(p);
  }
  const pairs = await Promise.all(uniq.map(async (p) => [p, await isListening(p, opts)]));
  const out = {};
  for (const pair of pairs) out[pair[0]] = pair[1];
  return out;
}

/**
 * probe(links) -> the same links with `live` filled in, every probe in parallel.
 * A link that points off-box (an ngrok tunnel) is live when it has a URL at all:
 * TCP-probing a public host would only measure the internet.
 */
async function probe(links) {
  const list = normalizeLinks(links);
  return Promise.all(list.map(async (link) => {
    const host = (parseUrl(link.url) || {}).hostname || '127.0.0.1';
    if (!link.port || !isLocalHost(host)) return Object.assign({}, link, { live: !!link.url });
    // Probe 127.0.0.1 rather than the hostname: 'localhost' can try ::1 first and
    // pay DNS latency, and `*.localhost` has no DNS record at all.
    const live = await isListening(link.port, { host: '127.0.0.1' });
    return Object.assign({}, link, { live });
  }));
}

// ---------------------------------------------------------------------------
// ngrok
// ---------------------------------------------------------------------------

/** The live tunnel list, or null when ngrok is not running. */
function ngrokTunnels() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    // Node's fetch reports a dead 4040 as TypeError('fetch failed') and buries the
    // real reason in e.cause.code; http hands us ECONNREFUSED directly.
    const req = http.get(Object.assign({}, NGROK_API), (res) => {
      if (res.statusCode !== 200) { res.resume(); return done(null); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; if (body.length > 1024 * 1024) req.destroy(); });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          done(Array.isArray(data.tunnels) ? data.tunnels : []);
        } catch (e) { done(null); }
      });
      res.on('error', () => done(null));
    });
    req.setTimeout(NGROK_TIMEOUT, () => req.destroy());
    req.on('error', () => done(null));   // ECONNREFUSED: ngrok simply is not running
  });
}

/**
 * ngrokUrl(port) -> the public URL of the tunnel fronting that local port, or null.
 * With no port, the first https tunnel. Never throws; null covers both "ngrok is
 * not running" and "running, but nothing tunnels that port".
 *
 * ngrok 3.x returns ONE tunnel object with proto 'https' (2.x returned an
 * http+https pair — do not assume two). The URL is ephemeral on the free tier, so
 * poll it and never cache it across runs.
 */
async function ngrokUrl(port) {
  const tunnels = await ngrokTunnels();
  if (!tunnels || !tunnels.length) return null;
  const want = Number(port);
  const mine = Number.isInteger(want)
    ? tunnels.filter((t) => portOf((t && t.config && t.config.addr) || '') === want)
    : tunnels.slice();
  if (!mine.length) return null;
  const pick = mine.find((t) => t && t.proto === 'https') || mine[0];
  return (pick && pick.public_url) || null;
}

// ---------------------------------------------------------------------------
// PID attribution (lsof)
// ---------------------------------------------------------------------------

/** Every TCP listener on the machine: [{ pid, command, port }]. */
async function listeners() {
  let stdout = '';
  try {
    // Deliberately NO -iTCP:<port> filters: with several of them lsof exits 1 if
    // ANY one matched nothing, while still printing valid rows for the others.
    // Unfiltered, it exits 0 and we filter ports in JS.
    const r = await pexec(LSOF, ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], { maxBuffer: 4 * 1024 * 1024 });
    stdout = r.stdout;
  } catch (e) {
    if (e && e.code === 1 && !e.stdout) return [];
    stdout = (e && e.stdout) || '';
  }
  const out = [];
  let pid = null;
  let command = null;
  for (const line of stdout.split('\n')) {
    const tag = line[0];
    const val = line.slice(1);
    // p and c appear ONCE per process; the f/n pairs that follow belong to it.
    if (tag === 'p') { pid = Number(val); command = null; }
    else if (tag === 'c') { command = val; }
    else if (tag === 'n') {
      const m = val.match(/:(\d+)$/);   // '*:3015' | '127.0.0.1:5450' | '[::1]:18789'
      if (m && pid) out.push({ pid, command, port: Number(m[1]) });
    }
  }
  return out;
}

/** The working directory of a PID. No sudo needed for the user's own processes. */
async function cwdOfPid(pid) {
  const p = Number(pid);
  if (!Number.isInteger(p)) return null;
  try {
    const r = await pexec(LSOF, ['-a', '-p', String(p), '-d', 'cwd', '-Fn']);
    const line = r.stdout.split('\n').find((l) => l.startsWith('n'));
    return line ? line.slice(1) : null;
  } catch (e) { return null; }
}

/** The working directories of many PIDs in one lsof call: Map pid -> cwd. */
async function cwdOfPids(pids) {
  const list = [];
  for (const n of (Array.isArray(pids) ? pids : [])) {
    const p = Number(n);
    if (Number.isInteger(p) && list.indexOf(p) === -1) list.push(p);
  }
  const out = new Map();
  if (!list.length) return out;
  let stdout = '';
  try {
    // lsof takes a comma-separated pid list. It exits 1 when some of them are
    // already gone, but still prints the ones that are not.
    const r = await pexec(LSOF, ['-a', '-p', list.join(','), '-d', 'cwd', '-Fn'], { maxBuffer: 4 * 1024 * 1024 });
    stdout = r.stdout;
  } catch (e) {
    stdout = (e && e.stdout) || '';
    if (!stdout) return out;
  }
  let pid = null;
  for (const line of stdout.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid) out.set(pid, line.slice(1));
  }
  return out;
}

/** ownerOfPort(port) -> { pid, command, cwd } for whatever is listening, or null. */
async function ownerOfPort(port) {
  const p = Number(port);
  if (!Number.isInteger(p)) return null;
  let stdout = '';
  try {
    const r = await pexec(LSOF, ['-nP', '-iTCP:' + p, '-sTCP:LISTEN', '-Fpc']);
    stdout = r.stdout;
  } catch (e) {
    if (e && e.code === 1) return null;   // one -i filter: exit 1 really does mean free
    stdout = (e && e.stdout) || '';
    if (!stdout) return null;
  }
  let pid = null;
  let command = null;
  for (const line of stdout.split('\n')) {
    if (line[0] === 'p' && pid === null) pid = Number(line.slice(1));
    else if (line[0] === 'c' && command === null) command = line.slice(1);
  }
  if (!pid) return null;
  return { pid, command, cwd: await cwdOfPid(pid) };
}

/**
 * The listener on `port` ONLY if it really belongs to this workspace.
 *
 * Both signals are required: the port must be one the workspace declares AND the
 * process's cwd must sit inside the workspace tree. cwd alone produced a real
 * false positive during recon — an mcp-remote server on 127.0.0.1:5450 started
 * from example-1 looked exactly like a workspace service. Port alone cannot
 * tell sample-1 from sample-4 (copies share ports), nor demo's Metro from
 * sample's (both 8081), which is why the stop path must never kill on port alone.
 *
 * NOT SUFFICIENT TO KILL ON. Both signals are circumstantial: they describe where
 * a process is running, not who started it, and the user's own `npm run dev` in
 * the same repo matches both perfectly. A caller that intends to signal this pid
 * must add proof of ownership of its own — runner.js requires the holder to be
 * absent from the pid baseline taken before Start and to descend from the session
 * (see Session.ownsPid). This function answers "could this plausibly be the
 * workspace's?", never "is this ours?".
 */
async function ownerInWorkspace(port, ws) {
  const p = Number(port);
  const dir = ws && ws.dir;
  const declared = (ws && Array.isArray(ws.ports) ? ws.ports : []).map(Number);
  if (!dir || !Number.isInteger(p) || declared.indexOf(p) === -1) return null;
  const owner = await ownerOfPort(p);
  if (!owner || !owner.cwd) return null;
  const root = String(dir).replace(/\/+$/, '');
  if (owner.cwd !== root && owner.cwd.indexOf(root + '/') !== 0) return null;
  return owner;
}

// ---------------------------------------------------------------------------
// The poller the runner drives
// ---------------------------------------------------------------------------

/**
 * createPoller({ links, onUpdate, mode }) — every 2 s while a workspace is
 * starting, every 10 s once it is running. onUpdate fires only when something
 * actually changed (a port came up, a tunnel appeared), so the renderer is not
 * woken six times a minute to redraw identical chips.
 */
function createPoller(opts) {
  const o = opts || {};
  const startingMs = Number(o.startingMs) || 2000;
  const runningMs = Number(o.runningMs) || 10000;
  const onUpdate = typeof o.onUpdate === 'function' ? o.onUpdate : null;
  let links = normalizeLinks(o.links);
  let mode = o.mode === 'running' ? 'running' : 'starting';
  let timer = null;
  let stopped = true;
  let inFlight = null;

  const snapshot = () => links.map((l) => Object.assign({}, l));
  const signature = (ls) => ls.map((l) => l.label + ' ' + (l.url || '') + ' ' + (l.live ? 1 : 0)).join('\n');

  function tick() {
    if (inFlight) return inFlight;
    const run = (async () => {
      const before = signature(links);
      const next = links.map((l) => Object.assign({}, l));
      for (const link of next) {
        if (link.kind === 'ngrok') link.url = await ngrokUrl(link.port);
      }
      links = await probe(next);
      if (onUpdate && signature(links) !== before) onUpdate(snapshot());
      return snapshot();
    })().catch(() => snapshot());
    inFlight = run;
    run.then(() => { if (inFlight === run) inFlight = null; });
    return run;
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      await tick();
      if (!stopped) schedule();
    }, mode === 'starting' ? startingMs : runningMs);
    if (timer.unref) timer.unref();
  }

  return {
    /** Polls immediately, then on the interval for the current mode. */
    start(m) {
      if (m) mode = m === 'running' ? 'running' : 'starting';
      stopped = false;
      schedule();
      return tick();
    },
    setMode(m) {
      const next = m === 'running' ? 'running' : 'starting';
      if (next === mode) return;
      mode = next;
      if (!stopped) schedule();   // re-arm at the new interval instead of waiting out the old one
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    poll: tick,
    links: snapshot,
    mode: () => mode,
  };
}

// ---------------------------------------------------------------------------
// Expo
// ---------------------------------------------------------------------------

/**
 * The LAN address Expo prints for a phone. It moves with the network — resolve it
 * at runtime, never bake it into config.
 */
function lanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i && i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

function expoDeviceUrl(port) {
  return 'exp://' + lanIp() + ':' + (Number(port) || 8081);
}

module.exports = {
  probe,
  ngrokUrl,
  ownerOfPort,
  ownerInWorkspace,
  createPoller,
  isListening,
  sweep,
  listeners,
  cwdOfPid,
  cwdOfPids,
  portsOf,
  portOf,
  labelFor,
  isLocalHost,
  normalizeLink,
  normalizeLinks,
  lanIp,
  expoDeviceUrl,
  PROBE_TIMEOUT,
};
