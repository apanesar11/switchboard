'use strict';

// Claude usage — the three bars claude.ai's "Your usage" page shows, read from the
// same place Claude Code reads its own.  ARCHITECTURE §4.11 and §5 M7.
//
// There is no CLI for this: `claude` has no usage subcommand, and /usage is a screen
// inside its TUI.  What there is: the OAuth token Claude Code keeps in the macOS
// keychain (the "Claude Code-credentials" item, written by /usr/bin/security and so
// readable by it without a prompt), and the endpoint that /usage screen asks with it.
// So this module reads that token and asks the same question, every five minutes.
//
// The token is a credential.  It is read for one request, held only on the stack,
// sent to api.anthropic.com and nowhere else, and never logged, never put in an IPC
// payload, never written anywhere.  Nothing here refreshes it: Claude Code rotates
// its own token, and a second refresher racing it would invalidate the session the
// user is typing into next door.  An expired token is reported as a sentence and
// the next poll simply tries again — Claude Code will have renewed it by then.

const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const SERVICE = 'Claude Code-credentials';
// Gentle on purpose. The five-hour and weekly windows move slowly, and the endpoint
// is shared with every Claude Code the user is running — each polls it for its own
// status line — so a tight loop here is what earns a 429. Five minutes, plus a fetch
// when the window is brought to the front, plus the manual refresh, is plenty.
const INTERVAL_MS = 5 * 60 * 1000;
const FRESH_MS = 60 * 1000;        // a window focus re-asks only past this age
const TIMEOUT_MS = 15 * 1000;
const COOLDOWN_MAX_MS = 30 * 60 * 1000;

const events = new EventEmitter();

let timer = null;
let inflight = null;
let last = null;                   // the last Usage answered, ok or not
let ticks = 0;                     // completed fetches — the fixture list is indexed by it
let misses = 0;                    // consecutive failures — the backoff exponent
let cooldownUntil = 0;             // no automatic fetch before this; a manual one may

// ---------------------------------------------------------------------------
// The credential
// ---------------------------------------------------------------------------

function readKeychain() {
  return new Promise(resolve => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-w'],
      { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      (err, out) => resolve(err ? null : String(out || '').trim()));
  });
}

// Where Claude Code keeps it when the keychain is not available to it.
function readCredentialFile() {
  try { return fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'); } catch (_) { return null; }
}

// "max" + "default_claude_max_5x" → "Max 5x"; "pro" → "Pro".
function planName(subscription, tier) {
  const s = String(subscription || '').toLowerCase();
  if (!s) return null;
  const named = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise', free: 'Free' };
  const base = named[s] || s.charAt(0).toUpperCase() + s.slice(1);
  const mult = /_(\d+)x\b/.exec(String(tier || '').toLowerCase());
  return mult ? `${base} ${mult[1]}x` : base;
}

async function credential() {
  const raw = (process.platform === 'darwin' ? await readKeychain() : null) || readCredentialFile();
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { return null; }
  const o = parsed && parsed.claudeAiOauth;
  if (!o || typeof o.accessToken !== 'string' || !o.accessToken) return null;
  return {
    token: o.accessToken,
    expiresAt: Number(o.expiresAt) || null,
    plan: planName(o.subscriptionType, o.rateLimitTier),
  };
}

// ---------------------------------------------------------------------------
// The answer, shaped — §2 Usage
// ---------------------------------------------------------------------------

function pct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// Anthropic's own severity when it says one; otherwise the thresholds claude.ai
// paints with (red from 90).
function severityOf(percent, given) {
  if (given === 'normal' || given === 'warning' || given === 'critical') return given;
  if (percent === null) return 'normal';
  return percent >= 90 ? 'critical' : percent >= 75 ? 'warning' : 'normal';
}

function limit(name, percent, resetsAt, severity) {
  const p = pct(percent);
  return {
    name,
    percent: p === null ? 0 : p,
    resetsAt: typeof resetsAt === 'string' && resetsAt ? resetsAt : null,
    severity: severityOf(p, severity),
  };
}

// Two shapes live in one body.  `limits[]` (kind / percent / severity / scope) is the
// newer one and the only one that names a per-model weekly ceiling ("Fable");
// `five_hour` / `seven_day` / `seven_day_<model>` are the older windows, still
// present, and the fallback when `limits` is missing.
function normalize(body, plan) {
  const b = body && typeof body === 'object' ? body : {};
  const limits = Array.isArray(b.limits) ? b.limits.filter(l => l && typeof l === 'object') : [];
  const find = kind => limits.find(l => l.kind === kind) || null;

  let session = null;
  const s = find('session');
  if (s) session = limit('Session', s.percent, s.resets_at, s.severity);
  else if (b.five_hour) session = limit('Session', b.five_hour.utilization, b.five_hour.resets_at);

  let weekly = null;
  const w = find('weekly_all');
  if (w) weekly = limit('This week', w.percent, w.resets_at, w.severity);
  else if (b.seven_day) weekly = limit('This week', b.seven_day.utilization, b.seven_day.resets_at);

  const scoped = limits.filter(l => l.kind === 'weekly_scoped').map(l => {
    const scope = l.scope || {};
    const who = (scope.model && scope.model.display_name) || scope.surface || 'Model';
    return limit(`${who} this week`, l.percent, l.resets_at, l.severity);
  });
  if (!limits.length) {
    if (b.seven_day_opus) scoped.push(limit('Opus this week', b.seven_day_opus.utilization, b.seven_day_opus.resets_at));
    if (b.seven_day_sonnet) scoped.push(limit('Sonnet this week', b.seven_day_sonnet.utilization, b.seven_day_sonnet.resets_at));
  }

  if (!session && !weekly) throw new Error('the usage answer had no limits in it');
  return { ok: true, configured: true, plan: plan || null, session, weekly, scoped, fetchedAt: Date.now() };
}

function failure(reason, error, configured = reason !== 'no-login') {
  return { ok: false, configured, reason, error, fetchedAt: Date.now() };
}

function statusFailure(status, cred) {
  if (status === 401 || status === 403) {
    const stale = cred && cred.expiresAt && cred.expiresAt < Date.now();
    return failure('expired', stale
      ? "Claude Code's sign-in has expired; it renews itself the next time claude runs."
      : "Anthropic did not accept Claude Code's sign-in.");
  }
  if (status === 429) return failure('slow', 'Anthropic is rate-limiting usage checks; the numbers above are the last it gave.');
  return failure('http', `Anthropic answered ${status}.`);
}

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

async function ask(token) {
  const res = await fetch(ENDPOINT, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let body = null;
  try { body = await res.json(); } catch (_) { body = null; }
  return { status: res.status, body };
}

// SB_USAGE_FIXTURE=<a.json>[,<b.json>…] — the smoke harness's stand-in for the network.
// Each poll reads the next file (the last one repeats) as if the endpoint had answered
// it.  A file may add `_credential` ({subscriptionType, rateLimitTier}) for the plan
// name, `_status` to play a bad HTTP answer (with `_expired` for a stale token), or
// `_nologin` for a Mac with no Claude Code sign-in.
function fixture() {
  const list = String(process.env.SB_USAGE_FIXTURE || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return null;
  const file = list[Math.min(ticks, list.length - 1)];
  let f;
  try { f = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { return failure('http', `fixture ${file}: ${err.message}`, false); }
  if (f._nologin) return failure('no-login', 'Claude Code is not signed in on this Mac — run claude in a terminal and sign in.');
  if (f._status && f._status !== 200) return statusFailure(f._status, { expiresAt: f._expired ? 1 : null });
  const c = f._credential || {};
  try { return normalize(f, planName(c.subscriptionType, c.rateLimitTier)); } catch (err) { return failure('shape', err.message); }
}

async function fetchUsage() {
  const fake = fixture();
  if (fake) return fake;

  let cred = null;
  try { cred = await credential(); } catch (_) { cred = null; }
  if (!cred) return failure('no-login', 'Claude Code is not signed in on this Mac — run claude in a terminal and sign in.');

  let answer;
  try {
    answer = await ask(cred.token);
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return failure('offline', timedOut ? 'Anthropic did not answer in time.' : 'could not reach Anthropic.');
  }
  if (answer.status !== 200) return statusFailure(answer.status, cred);
  if (!answer.body) return failure('shape', 'Anthropic answered with something that was not JSON.');
  try { return normalize(answer.body, cred.plan); } catch (err) { return failure('shape', err.message); }
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

// How long to wait after a failure before the next AUTOMATIC fetch. A rate-limit
// (429) backs off hard — five minutes doubling to thirty — because hammering it is
// what caused it; a network blip backs off gently. A manual refresh ignores this.
function backoffMs(reason) {
  const base = reason === 'slow' ? 5 * 60 * 1000 : 60 * 1000;
  return Math.min(base * Math.pow(2, Math.max(0, misses - 1)), COOLDOWN_MAX_MS);
}

// force=true is a person clicking Refresh: it fetches even inside a cooldown. The
// automatic timer and a window focus pass nothing and are held off until the
// cooldown a failure set has passed — so a 429 does not become a retry storm.
function refresh(force) {
  if (inflight) return inflight;
  if (!force && Date.now() < cooldownUntil) return Promise.resolve(last);
  inflight = fetchUsage()
    .then(u => u, err => failure('http', String((err && err.message) || err), false))
    .then(u => {
      inflight = null;
      ticks++;
      last = u;
      if (u && u.ok) { misses = 0; cooldownUntil = 0; }
      else { misses++; cooldownUntil = Date.now() + backoffMs(u && u.reason); }
      events.emit('usage', u);
      return u;
    });
  return inflight;
}

// The renderer's boot question: whatever was last answered, or the answer in flight.
function get() {
  return last ? Promise.resolve(last) : refresh(false);
}

// A window focus: worth a fresh answer only if the last one is old, and never during
// a cooldown a failure set.
function poke() {
  if (Date.now() < cooldownUntil) return;
  if (!last || Date.now() - (last.fetchedAt || 0) > FRESH_MS) refresh(false);
}

function interval() {
  const n = Number(process.env.SB_USAGE_INTERVAL);
  return n > 0 ? n : INTERVAL_MS;
}

function start() {
  if (timer) return;
  refresh(false);
  timer = setInterval(() => refresh(false), interval());
  if (typeof timer.unref === 'function') timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  events,
  on: events.on.bind(events),
  get,
  refresh,
  poke,
  start,
  stop,
  // exposed for tests
  normalize,
  planName,
};
