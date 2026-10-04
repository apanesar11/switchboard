// app.js — the only mutable state in the renderer, the router, the data loader
// and the sidebar. ARCHITECTURE §6 R2.
//
// Everything a view needs from the outside world comes through here:
//
//   SB.state                     the single mutable object; views read it, never write it
//   SB.go(route)                 navigate (partial routes are filled in from the current one)
//   SB.back()                    pop one level — the breadcrumb caret and Esc
//   SB.render()                  sidebar + the routed view, scroll preserved per route
//   SB.refresh(wsId, {fetch})    re-scan a workspace and re-fold its PR summaries
//   SB.load(key, fn)             memoised async → {status:'loading'|'ok'|'error', value, error}
//   SB.invalidate(prefix)        mark loads stale so the next render revalidates them
//   SB.ws(id?)                   the current (or named) workspace object
//   SB.act(work, opts)           run an action, show it in flight, surface failure as a .bar
//   SB.bell(wsId, on)            views/terminal.js rings it; the sidebar dot turns blue
//
// Views are `(state) => Node`. Returning a DocumentFragment of `.hd` + `.bd` is the
// shape styles.css is written for; a single wrapper element is adapted in fit().
//
// Every view builds a fresh node on every call, so a render tears #main down and
// puts it back: hover, text selection and keyboard focus all live on nodes that
// are about to be thrown away. So render() is called ONLY when something visible
// changed — there is no periodic re-render, and "running 14s" ticks its own text
// node in views/workspace.js. The logs terminal survives because views/logs.js
// keeps its live xterm hosts in its own Map and re-parents them into each new
// body; renderMain() carries the focused element across with them. The Editor
// goes one step further (§6 R13): it hands back the very SAME root element on
// every call and rebuilds only its header inside it, and renderMain() leaves an
// element it already mounted exactly where it is — no teardown, no re-parent, so
// Monaco never sees the blur a move costs (an open suggest widget, an IME
// composition and the cursor all survive a bell or a window focus).
window.SB = window.SB || {};

(function (SB) {
  'use strict';

  var d = SB.dom;
  var h = d.h;

  SB.views = SB.views || {};

  // window.sb is created by the preload. Read it fresh every time rather than
  // capturing it at load: if the preload ever fails to run, the app still boots
  // and says so instead of throwing on the first line.
  function api() {
    return window.sb || null;
  }

  var LAST_KEY = 'switchboard.lastWorkspace';
  var SCREEN_KEY = 'switchboard.lastScreen';           // 'grid' when that is where you were
  var GRID_KEY = 'switchboard.gridView';               // the view the Grid last showed

  // 'grid', 'usage' and 'prs' are the screens that belong to no workspace: four
  // terminals side by side in the views the user makes, the Claude usage limits, and
  // the user's open pull requests in every repository. Their routes carry no wsId on
  // purpose — and nor does a pull request opened FROM that list, which is named by
  // owner/repo/number instead (views/pr.js) since its repo may be cloned nowhere here.
  // 'settings' is the fourth: this Mac's settings (§4.18) — today, who answers ✦ Answer
  // on the Diagrams tab and the API keys for it.
  var VIEWS = { workspace: 1, files: 1, diff: 1, pr: 1, grid: 1, usage: 1, prs: 1, settings: 1 };
  var TABS = {
    workspace: ['changes', 'logs', 'terminal', 'editor', 'notes', 'diagrams'],
    files: ['files', 'all'], pr: ['overview', 'files', 'all'], diff: [], grid: [], usage: [], prs: [], settings: []
  };
  var FREE = { grid: 1, usage: 1, prs: 1, settings: 1 };

  // Tabs of the workspace route that live in their own file and compose the whole
  // screen themselves — Logs, Terminal and the Editor each borrow the shared header
  // and own everything below it; see buildView(). Anything not listed is
  // views/workspace.js. A new tab needs both lines: one missing from TABS.workspace
  // is rewritten by normalize() to the remembered tab before it is ever looked up.
  var TAB_VIEWS = { logs: 'logs', terminal: 'terminal', editor: 'editor', notes: 'notes', diagrams: 'diagrams' };

  var PARENT = { diff: 'files', files: 'workspace', pr: 'workspace', workspace: null, grid: null, usage: null, prs: null, settings: null };

  // A route that needs no workspace on screen: the three free screens, and a pull
  // request from the list.
  function standalone(route) {
    return !!route && (!!FREE[route.view] || (route.view === 'pr' && !route.wsId && !!route.number));
  }

  // Which screen sits above this one — the back caret and Esc. A pull request from
  // the list goes back to the list, not to a workspace it never belonged to.
  function parentOf(route) {
    return route.view === 'pr' && !route.wsId ? 'prs' : PARENT[route.view];
  }

  // ── state ─────────────────────────────────────────────────────────────────

  var state = {
    workspaces: [],                                     // Workspace[] in sidebar order
    byId: {},                                           // same objects, keyed by id
    route: { view: 'workspace', wsId: null, tab: 'changes' },
    run: {},                                            // wsId → RunState
    shell: {},                                          // wsId → Shell, the Terminal's login shell
    bell: {},                                           // wsId → true while a bell goes unread
    grid: { views: [], current: null, loaded: false },  // the Grid's views; §4.10
    usage: null,                                        // the last GOOD Usage, or null; §4.11
    usageConfigured: null,                              // null while checking; hidden until a sign-in is found
    usageError: null,                                   // a sentence when the latest fetch failed
    publish: { status: 'idle', wsId: null, message: '' },
    booted: false,
    loading: true,
    notice: null,                                       // the one inline .bar, see act()
    busy: {},                                           // action key → in-flight count
    tabs: {},                                           // wsId → { workspace:'logs', files:'all', … }
    stack: [],                                          // back stack of routes
    scroll: {}                                          // routeKey → scrollTop
  };
  SB.state = state;

  var loads = {};        // load key → { status, value, error, stale, running }
  var scans = {};        // wsId → in-flight refresh promise
  var mounted = { key: null, node: null, want: null };
  var frame = 0;
  var lastFocusRefresh = 0;

  function noop() {}

  // Electron wraps every handler rejection as "Error invoking remote method
  // 'sb:ws:scan': Error: …", which is noise in a one-line .bar. Strip both layers.
  function message(err) {
    if (err === null || err === undefined) return 'that did not work';
    var s = typeof err === 'string' ? err : (err.error || err.message || String(err));
    return String(s)
      .replace(/^Error invoking remote method '[^']*':\s*/, '')
      .replace(/^(?:Uncaught )?Error:\s*/, '')
      .trim() || 'that did not work';
  }

  function projectLabel(project) {
    var key = String(project || '');
    return key ? key.charAt(0).toUpperCase() + key.slice(1) : 'Workspaces';
  }
  SB.projectLabel = projectLabel;

  // A section is a rail heading: a project's own name, or 'other' for the projects
  // with one workspace each (demo, switchboard). When EVERY project has one there
  // is nothing for 'Other' to be other than, so the lone heading says what it is.
  function sectionLabel(section, list) {
    if (section !== 'other') return projectLabel(section);
    for (var i = 0; i < list.length; i++) if (list[i].section !== 'other') return 'Other';
    return 'Workspaces';
  }
  SB.sectionLabel = sectionLabel;

  // ── render scheduling ─────────────────────────────────────────────────────

  function schedule() {
    if (frame) return;
    frame = window.requestAnimationFrame(function () {
      frame = 0;
      render();
    });
  }

  // ── routing ───────────────────────────────────────────────────────────────

  function tabFor(wsId, view) {
    var list = TABS[view] || [];
    if (!list.length) return null;
    var remembered = (state.tabs[wsId] || {})[view];
    return list.indexOf(remembered) !== -1 ? remembered : list[0];
  }

  function rememberTab(route) {
    if (!route.wsId || !route.tab) return;
    var byWs = state.tabs[route.wsId] || (state.tabs[route.wsId] = {});
    byWs[route.view] = route.tab;
  }

  // A partial route inherits from the current one, so a segmented control can
  // call SB.go({tab:'logs'}) and a file row SB.go({view:'diff', repo, path}).
  function normalize(route) {
    var r = route || {};
    var cur = state.route || {};
    var view = VIEWS[r.view] ? r.view : (VIEWS[cur.view] ? cur.view : 'workspace');
    if (view === 'usage' && state.usageConfigured === false) view = 'grid';
    var wsId = r.wsId || cur.wsId || null;
    var same = cur.view === view;
    // A pull request named by number (from the Pull requests list) carries no
    // workspace; a partial route from that screen — a tab click — inherits the number
    // and stays free. A branch pill always names its workspace, so it never does.
    var number = view === 'pr' ? (r.number || (same && !r.wsId ? cur.number : null) || null) : null;
    // No workspace is "current" on the Grid, Usage or Pull requests: the rail lights
    // their own rows instead, and dotFor() must not go quiet for whichever workspace
    // was looked at last.
    if (FREE[view] || number) wsId = null;
    var list = TABS[view] || [];

    var out = { view: view, wsId: wsId, tab: null, repo: null, path: null, owner: null, number: null };
    if (list.length) out.tab = list.indexOf(r.tab) !== -1 ? r.tab : tabFor(wsId, view);
    if (view === 'diff' || view === 'pr') out.repo = r.repo || (same ? cur.repo : null) || null;
    if (view === 'diff') out.path = r.path || (same ? cur.path : null) || null;
    if (number) {
      out.number = number;
      out.owner = r.owner || (same ? cur.owner : null) || null;
    }
    return out;
  }

  function sameRoute(a, b) {
    return !!a && !!b && a.view === b.view && a.wsId === b.wsId && a.tab === b.tab &&
      (a.repo || null) === (b.repo || null) && (a.path || null) === (b.path || null) &&
      (a.owner || null) === (b.owner || null) && (a.number || null) === (b.number || null);
  }

  function routeKey(r) {
    return [r.view, r.wsId, r.tab, r.repo, r.path, r.owner, r.number].join('|');
  }
  SB.routeKey = routeKey;

  function pushStack(route) {
    state.stack.push(route);
    if (state.stack.length > 40) state.stack.shift();
  }

  // PARENT says which screen sits above which. Walking UP — a breadcrumb part, the
  // back caret — must not push the screen being left, or Esc walks straight back
  // down into it.
  function isAbove(view, of) {
    for (var v = PARENT[of]; v; v = PARENT[v]) if (v === view) return true;
    return false;
  }

  function go(route) {
    var prev = state.route;
    var next = normalize(route);
    if (sameRoute(prev, next)) {
      rememberTab(next);
      render();
      return next;
    }
    var changedWorkspace = prev.wsId !== next.wsId;
    if (prev.wsId && !changedWorkspace && prev.view !== next.view) {
      if (isAbove(next.view, prev.view)) {
        // Going up: drop every entry for the level we are landing on (and below
        // it), so the stack keeps walking up instead of ping-ponging.
        while (state.stack.length && !isAbove(state.stack[state.stack.length - 1].view, next.view)) state.stack.pop();
      } else {
        pushStack(prev);
      }
    }
    if (changedWorkspace) {
      // A different workspace is a different context: no back into the old one,
      // and the old one's error bar does not belong here.
      state.stack.length = 0;
      state.notice = null;
    }
    state.route = next;
    rememberTab(next);
    if (next.wsId) {
      remember(next.wsId);
      ensureScanned(next.wsId);
    }
    rememberScreen(next);
    render();
    return next;
  }
  SB.go = go;

  function back() {
    while (state.stack.length) {
      var prev = state.stack.pop();
      if (prev && prev.wsId && state.byId[prev.wsId] && !sameRoute(prev, state.route)) {
        state.route = normalize(prev);
        rememberTab(state.route);
        render();
        return true;
      }
    }
    var up = parentOf(state.route);
    if (!up) return false;
    state.route = normalize({ view: up, wsId: state.route.wsId });
    rememberScreen(state.route);
    render();
    return true;
  }
  SB.back = back;

  function select(wsId) {
    if (!state.byId[wsId]) return;
    // The sidebar always lands on the workspace screen — its remembered tab, but
    // never still inside a Diff or a Pull request belonging to another workspace.
    go({ view: 'workspace', wsId: wsId, tab: tabFor(wsId, 'workspace') });
  }
  SB.select = select;

  function remember(wsId) {
    try { window.localStorage.setItem(LAST_KEY, wsId); } catch (e) { /* private mode, or storage off */ }
  }

  function lastUsed() {
    try { return window.localStorage.getItem(LAST_KEY); } catch (e) { return null; }
  }

  // A pull request from the list counts as the list: the window comes back to it.
  function rememberScreen(route) {
    // Settings is visited, not worked in: the window comes back to wherever it was before.
    if (route.view === 'settings') return;
    var screen = standalone(route) ? (route.view === 'pr' ? 'prs' : route.view) : 'workspace';
    try { window.localStorage.setItem(SCREEN_KEY, screen); } catch (e) { /* storage off */ }
  }

  function lastScreen() {
    try { return window.localStorage.getItem(SCREEN_KEY); } catch (e) { return null; }
  }

  // ── memoised loading ──────────────────────────────────────────────────────

  // status is the contract; `loading` is the same fact as a boolean, because the
  // views normalise a load result by reading whichever of the two they find.
  function settleStatus(entry, status) {
    entry.status = status;
    entry.loading = status === 'loading';
  }

  function beginLoad(entry, key, fn) {
    entry.running = true;
    if (entry.status !== 'ok') settleStatus(entry, 'loading');   // keep old data visible while revalidating
    var started;
    try {
      started = typeof fn === 'function' ? fn() : fn;
    } catch (err) {
      started = Promise.reject(err);
    }
    Promise.resolve(started).then(function (value) {
      if (loads[key] !== entry) return;
      entry.running = false;
      entry.value = value;
      if (value && value.ok === false) {
        settleStatus(entry, 'error');
        entry.error = value.error || 'that did not work';
      } else {
        settleStatus(entry, 'ok');
        entry.error = null;
      }
      schedule();
    }, function (err) {
      if (loads[key] !== entry) return;
      entry.running = false;
      settleStatus(entry, 'error');
      entry.error = message(err);
      schedule();
    });
  }

  function load(key, fn) {
    key = String(key);
    var entry = loads[key];
    if (!entry) {
      entry = loads[key] = { status: 'loading', loading: true, value: null, error: null, stale: false, running: false };
      beginLoad(entry, key, fn);
      return entry;
    }
    if (entry.running) return entry;                       // dedupe: one call in flight per key
    if (entry.stale) { entry.stale = false; beginLoad(entry, key, fn); }
    return entry;
  }
  SB.load = load;

  // Invalidation marks entries stale instead of deleting them, so a revalidating
  // screen keeps showing the data it already has rather than flashing a spinner.
  function invalidate(prefix) {
    var keys = Object.keys(loads);
    for (var i = 0; i < keys.length; i++) {
      if (prefix === undefined || prefix === null || keys[i].indexOf(String(prefix)) === 0) loads[keys[i]].stale = true;
    }
    schedule();
  }
  SB.invalidate = invalidate;

  // Views key their loads however they like, but a key must mention the workspace
  // it is about to stay unique — so a re-scan stales anything carrying the id.
  function staleForWorkspace(wsId) {
    var keys = Object.keys(loads);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf(wsId) !== -1) loads[keys[i]].stale = true;
    }
  }

  // ── workspaces ────────────────────────────────────────────────────────────

  function blankWorkspace(entry) {
    var project = entry.project || String(entry.id).replace(/-\d+$/, '');
    return {
      id: entry.id,
      project: project,
      section: entry.section || project,      // the rail heading it sits under
      dir: entry.dir || null,
      self: !!entry.self,                    // the workspace that IS this app — never startable
      devCommand: entry.devCommand === undefined ? null : entry.devCommand,
      processes: entry.processes || [],
      repos: [],
      branchSummary: 'main',
      files: 0, add: 0, del: 0, behindRepos: 0,
      scanned: false, scanning: false, scanError: null, error: null
    };
  }

  function adoptWorkspaces(list) {
    if (!Array.isArray(list)) {
      throw new Error(list && list.error ? message(list.error) : 'could not list the workspaces');
    }
    var next = [];
    var byId = {};
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      if (!entry || !entry.id) continue;
      var existing = state.byId[entry.id];
      var ws = existing || blankWorkspace(entry);
      ws.project = entry.project || ws.project;
      ws.section = entry.section || ws.section || ws.project;
      ws.dir = entry.dir || ws.dir;
      ws.self = entry.self === undefined ? !!ws.self : !!entry.self;
      ws.devCommand = entry.devCommand === undefined ? ws.devCommand : entry.devCommand;
      ws.processes = entry.processes || ws.processes || [];
      next.push(ws);
      byId[ws.id] = ws;
    }
    state.workspaces = next;
    state.byId = byId;
  }

  function applyScan(wsId, res) {
    var ws = state.byId[wsId];
    if (!ws) return;
    ws.scanning = false;
    ws.scanned = true;
    if (!res || typeof res !== 'object' || res.ok === false) {
      ws.scanError = message(res && res.error) || 'the scan came back empty';
      return;
    }
    // PR numbers come from the summary call, which lands after the scan. Carry the
    // ones we already have across so the branch pills do not lose their #218.
    var prev = {};
    (ws.repos || []).forEach(function (r) { if (r && r.pr) prev[r.name] = r.pr; });
    var repos = (res.repos || []).map(function (r) {
      if (r && !r.pr && prev[r.name]) r.pr = prev[r.name];
      return r;
    });

    ws.repos = repos;
    ws.dir = res.dir || ws.dir;
    ws.self = res.self === undefined ? !!ws.self : !!res.self;
    ws.project = res.project || ws.project;
    ws.section = res.section || ws.section;
    ws.devCommand = res.devCommand === undefined ? ws.devCommand : res.devCommand;
    ws.processes = res.processes || ws.processes || [];
    ws.branchSummary = res.branchSummary || 'main';
    ws.files = res.files || 0;
    ws.add = res.add || 0;
    ws.del = res.del || 0;
    ws.behindRepos = res.behindRepos || 0;
    ws.scanError = res.error || null;
    ws.error = res.error || null;
  }

  function refreshPrSummary(wsId) {
    var a = api();
    if (!a) return Promise.resolve(null);
    return Promise.resolve(a.prSummary(wsId)).then(function (map) {
      var ws = state.byId[wsId];
      // gh being unavailable is not an error here — the PR screen is where its
      // sentence belongs. Here it just means no #number on the pills.
      if (!ws || !map || typeof map !== 'object' || map.ok === false) return null;
      (ws.repos || []).forEach(function (r) {
        if (r && Object.prototype.hasOwnProperty.call(map, r.name)) r.pr = map[r.name] || null;
      });
      schedule();
      return map;
    }, function () { return null; });
  }

  function refresh(wsId, opts) {
    wsId = wsId || state.route.wsId;
    if (!wsId || !state.byId[wsId]) return Promise.resolve(null);
    var doFetch = !!(opts && opts.fetch);
    // A plain re-scan joins whatever is already running; a fetching one only
    // joins another fetch, because it is asking a strictly bigger question.
    if (scans[wsId] && (!doFetch || scans[wsId].fetching)) return scans[wsId];

    var ws = state.byId[wsId];
    ws.scanning = true;
    // No view reads `scanning`, and `scanned` does not move here — so on a re-scan
    // this frame is identical to the one already on screen, and rendering it would
    // tear the main column (live terminal included) down for nothing. Every window
    // focus and every ⌘R comes through here.
    if (!ws.scanned) schedule();

    var p = Promise.resolve()
      .then(function () {
        var a = api();
        if (!a) throw new Error('the app process is not reachable');
        return a.scanWorkspace(wsId, { fetch: doFetch });
      })
      .then(function (res) { applyScan(wsId, res); }, function (err) {
        var w = state.byId[wsId];
        if (w) { w.scanning = false; w.scanned = true; w.scanError = message(err); }
      })
      .then(function () {
        if (scans[wsId] === p) delete scans[wsId];
        staleForWorkspace(wsId);      // diffs and PRs are derived from the tree we just re-read
        schedule();
        return refreshPrSummary(wsId);
      });

    p.fetching = doFetch;
    scans[wsId] = p;
    return p;
  }
  SB.refresh = refresh;

  function ensureScanned(wsId) {
    var ws = state.byId[wsId];
    if (ws && !ws.scanned && !scans[wsId]) refresh(wsId);
  }

  function currentWorkspace(id) {
    return state.byId[id || state.route.wsId] || null;
  }
  SB.ws = currentWorkspace;

  function runStateOf(wsId) {
    return state.run[wsId || state.route.wsId] || null;
  }
  SB.run = runStateOf;

  function isLive(run) {
    return !!run && (run.status === 'running' || run.status === 'starting');
  }
  SB.isLive = isLive;

  // ── notices: the one inline .bar at the top of .bd ────────────────────────

  function notice(spec) {
    if (!spec) { state.notice = null; schedule(); return null; }
    var n = {
      kind: spec.kind || 'err',
      message: spec.message || '',
      code: spec.code || null,
      actions: spec.actions || null,
      wsId: spec.wsId === undefined ? state.route.wsId : spec.wsId,
      sticky: !!spec.sticky,
      name: spec.name || null,
      token: {}
    };
    state.notice = n;
    if (spec.ttl) {
      window.setTimeout(function () {
        if (state.notice === n) { state.notice = null; schedule(); }
      }, spec.ttl);
    }
    schedule();
    return n;
  }
  SB.notice = notice;

  function dismiss() {
    state.notice = null;
    schedule();
  }
  SB.dismiss = dismiss;

  function noticeNode(n) {
    var bar = h('div.bar' + (n.kind ? '.' + n.kind : ''), { dataset: { sbNotice: '1' } });
    var line = h('span');
    if (n.name) {
      // The offending workspace is the fastest way to go look at it.
      line.appendChild(h('b', {
        style: 'text-decoration:underline',
        onClick: function () { dismiss(); select(n.name); }
      }, n.name));
      line.appendChild(d.text(' '));
    }
    line.appendChild(d.text(n.message));
    if (n.code) { line.appendChild(d.text(' ')); line.appendChild(h('code', null, n.code)); }
    bar.appendChild(line);
    bar.appendChild(h('span.sp'));

    var actions = (n.actions || []).filter(function (a) { return a && a.label; });
    if (!actions.length && n.kind === 'err') actions = [{ label: 'Dismiss', onClick: dismiss }];
    actions.forEach(function (a) {
      bar.appendChild(h('button.btn', { type: 'button', onClick: a.onClick || dismiss }, a.label));
    });
    return bar;
  }

  // ── actions ───────────────────────────────────────────────────────────────

  function busy(key) {
    return !!state.busy[key];
  }
  SB.busy = busy;

  function handlePublish(value) {
    if (!value || !value.status) return;
    state.publish = value;
    schedule();
  }

  SB.publish = function (wsId) {
    if (state.publish.status === 'publishing' || state.publish.status === 'ready') return;
    handlePublish({ status: 'publishing', wsId: wsId, message: 'Publishing the latest changes…' });
    Promise.resolve(api().publish(wsId)).then(function (result) {
      if (result && result.status) handlePublish(result);
      else handlePublish({ status: 'error', wsId: wsId, message: message(result && result.error) });
    }, function (err) {
      handlePublish({ status: 'error', wsId: wsId, message: 'Publish failed: ' + message(err) });
    });
  };

  function mark(key, delta) {
    if (!key) return;
    var n = (state.busy[key] || 0) + delta;
    if (n > 0) state.busy[key] = n; else delete state.busy[key];
  }

  /**
   * act(work, opts) — run one action and never reject.
   *
   *   work        a promise, or a function returning one
   *   opts.key    an in-flight key views can read with SB.busy(key)
   *   opts.optimistic  a function run immediately; if it returns a function that
   *                    is the rollback, called when the action fails
   *   opts.check  (res) => error sentence | null, overriding the default `ok:false`
   *   opts.wsId   the workspace the notice belongs to (defaults to the route's)
   *   opts.retry  a function offered as "Retry" on the error bar
   *   opts.onDone (res) => void, on success only
   */
  function act(work, opts) {
    // views/files.js probes SB.act.length and, finding 2, calls act(label, fn).
    // Accept that spelling as well as the documented act(work, {optimistic, …}).
    if (typeof work === 'string' && typeof opts === 'function') {
      var fn = opts;
      opts = { key: work };
      work = fn;
    }
    opts = opts || {};
    var key = opts.key || null;
    var undo = null;
    if (typeof opts.optimistic === 'function') {
      try { undo = opts.optimistic(); } catch (e) { undo = null; }
    }
    mark(key, 1);
    schedule();

    var started;
    try {
      started = typeof work === 'function' ? work() : work;
    } catch (err) {
      started = Promise.reject(err);
    }

    function finish(res, err) {
      mark(key, -1);
      var failure = err ? message(err)
        : (typeof opts.check === 'function' ? opts.check(res)
          : (res && res.ok === false && !res.conflict ? message(res.error) : null));
      var conflict = res && res.conflict ? res.conflict : null;

      if (failure || conflict) {
        if (typeof undo === 'function') { try { undo(); } catch (e) { /* rollback is best effort */ } }
        if (conflict) {
          var here = opts.wsId || state.route.wsId;
          notice({
            kind: 'warn', wsId: here, sticky: true,
            name: conflict.wsId, message: 'is already running this project',
            actions: [
              { label: 'Stop it and start here', onClick: function () { dismiss(); stopThenStart(conflict.wsId, here); } },
              { label: 'Cancel', onClick: dismiss }
            ]
          });
        } else {
          notice({
            kind: 'err', wsId: opts.wsId || state.route.wsId, message: failure,
            actions: typeof opts.retry === 'function'
              ? [{ label: 'Retry', onClick: function () { dismiss(); opts.retry(); } }]
              : null
          });
        }
      } else {
        if (state.notice && !state.notice.sticky) state.notice = null;
        if (typeof opts.onDone === 'function') { try { opts.onDone(res); } catch (e) { console.error(e); } }
      }
      schedule();
      return err ? { ok: false, error: failure } : res;
    }

    return Promise.resolve(started).then(function (res) { return finish(res, null); },
      function (err) { return finish(null, err); });
  }
  SB.act = act;

  function start(wsId) {
    wsId = wsId || state.route.wsId;
    if (!wsId) return Promise.resolve({ ok: false, error: 'no workspace selected' });
    return act(function () { return api().start(wsId); }, {
      key: 'start:' + wsId,
      wsId: wsId,
      optimistic: function () {
        var prev = state.run[wsId];
        state.run[wsId] = {
          wsId: wsId, status: 'starting', pid: null, startedAt: Date.now(),
          exitCode: null, links: (prev && prev.links) || []
        };
        return function () { if (prev) state.run[wsId] = prev; else delete state.run[wsId]; };
      }
    });
  }
  SB.start = start;

  function stop(wsId) {
    wsId = wsId || state.route.wsId;
    if (!wsId) return Promise.resolve({ ok: false, error: 'no workspace selected' });
    return act(function () { return api().stop(wsId); }, { key: 'stop:' + wsId, wsId: wsId });
  }
  SB.stop = stop;

  function stopThenStart(otherId, wsId) {
    return act(function () {
      return Promise.resolve(api().stop(otherId)).then(function (res) {
        if (res && res.ok === false) return res;
        return api().start(wsId);
      });
    }, { key: 'start:' + wsId, wsId: wsId });
  }

  function pullMain(wsId, repoName) {
    wsId = wsId || state.route.wsId;
    if (!wsId) return Promise.resolve({ ok: false, error: 'no workspace selected' });
    return act(function () { return api().pullMain(wsId, repoName || null); }, {
      key: repoName ? 'pull:' + wsId + ':' + repoName : 'pull:' + wsId,
      wsId: wsId,
      // A per-repo failure is not a failed action — it is a result to report, so
      // only a pull that never ran at all becomes an error bar.
      check: function (res) {
        if (!res) return 'git pull returned nothing';
        if (res.ok === false && !(res.results || []).length) return message(res.error) || 'nothing is sitting on main';
        return null;
      },
      onDone: function (res) {
        var results = res.results || [];
        var failed = results.filter(function (r) { return !r.ok; });
        if (failed.length) {
          notice({
            kind: 'warn', wsId: wsId,
            message: failed.map(function (r) { return r.repo + ': ' + r.message; }).join(' · ')
          });
        } else {
          notice({ kind: 'ok', wsId: wsId, message: 'pulled ' + d.plural(results.length, 'repo'), ttl: 4000 });
        }
        refresh(wsId);
      }
    });
  }
  SB.pullMain = pullMain;

  // Squash and merge, the Pull request screen's one action (views/pr.js). `ref` names
  // the pull request the way the screen was reached — { wsId, repoName } or { owner,
  // repo, host } — plus its number; `opts.headSha` is the head the screen showed, which
  // GitHub checks before merging so a branch that moved since is refused rather than
  // merged unseen. Afterwards the screen asks GitHub again (the pill reads Merged and
  // the button goes), the workspace re-scans so the row's pill follows, and the Pull
  // requests list is staled so the merged one is gone the next time it is looked at.
  // No Retry on the error bar: the button is still there, and the one failure worth a
  // second try — the branch moved — wants a look at what moved first.
  function mergeKey(ref) {
    var who = ref.wsId ? ref.wsId + '\0' + ref.repoName : ref.owner + '/' + ref.repo;
    return 'merge:' + who + '#' + ref.number;
  }
  SB.mergeKey = mergeKey;

  // The one line the bar says after a merge. The branch's fate rides along — GitHub's
  // Delete branch button was the click always made after a merge, so main makes it — and
  // when that part failed the bar says so as a warning, never as a failed merge.
  function mergeOutcome(ref, opts, res) {
    var label = '#' + ref.number;
    if (res && res.queued) {
      return { kind: 'ok', message: label + ' is in the merge queue — GitHub merges it once its checks pass', ttl: 8000 };
    }
    var head = 'squashed and merged ' + label + ' into ' + ((opts && opts.baseRef) || 'main');
    var b = res && res.branch;
    if (!b || !b.name) return { kind: 'ok', message: head, ttl: 6000 };
    if (b.deleted) return { kind: 'ok', message: head + ' · deleted ' + b.name + ' on GitHub', ttl: 6000 };
    if (b.skipped) return { kind: 'ok', message: head + ' · ' + b.name + ' left on GitHub — ' + b.skipped, ttl: 8000 };
    return { kind: 'warn', message: head + ', but ' + b.name + ' is still on GitHub — ' + (b.error || 'it could not be deleted') };
  }
  SB.mergeOutcome = mergeOutcome;

  function mergePr(ref, opts) {
    ref = ref || {};
    opts = opts || {};
    var wsId = ref.wsId || null;
    return act(function () { return api().mergePr(ref, { headSha: opts.headSha || null }); }, {
      key: mergeKey(ref),
      wsId: wsId,
      onDone: function (res) {
        var o = mergeOutcome(ref, opts, res);
        notice({
          kind: o.kind, wsId: wsId, message: o.message, ttl: o.ttl || null,
          actions: o.kind === 'warn' ? [{ label: 'Dismiss' }] : null
        });
        var view = SB.views && SB.views.pr;
        if (view && typeof view.refresh === 'function') view.refresh(true);
        if (wsId) refresh(wsId);
        invalidate('prs:');
      }
    });
  }
  SB.mergePr = mergePr;

  function open(url) {
    var a = api();
    if (!a || !url) return Promise.resolve({ ok: false, error: 'nothing to open' });
    return act(function () { return a.openExternal(url); }, { key: 'open' });
  }
  SB.open = open;

  // ── sidebar ───────────────────────────────────────────────────────────────

  // gen.mjs: running beats changes and the dot never doubles up. A process that
  // exited non-zero takes precedence over both — that is the one thing the user
  // has to notice from the rail.
  function dotFor(ws) {
    // A shell that rang while you were looking somewhere else — Claude finishing a
    // turn — is the one thing the rail cannot tell you any other way, so it
    // outranks running, changed and failed until its Terminal is looked at. Still
    // ONE dot: the row does not grow a second one, the bell just takes the slot.
    if (state.bell[ws.id] && ws.id !== state.route.wsId) return 'bell';
    var run = state.run[ws.id];
    if (run) {
      if (run.status === 'running' || run.status === 'starting') return 'run';
      if (run.status === 'exited' && typeof run.exitCode === 'number' && run.exitCode !== 0) return 'fail';
    }
    if (ws.scanned && ws.files > 0) return 'chg';
    return '';                                   // never guess during the first scan
  }

  // views/terminal.js rings this from term.onBell. Only a real change schedules a
  // frame: a shell that rings three times in a row (Claude, a failed command, a
  // prompt) must not rebuild the main column three times for a dot that is
  // already blue. sidebarSignature() folds dotFor() in, so the rail repaints itself.
  function bell(wsId, on) {
    if (!wsId) return;
    var want = !!on;
    // The Grid is the other place a terminal is on screen. A bell from a square you
    // are looking at has already been read, exactly as on that workspace's own
    // Terminal tab (renderMain clears the same set on every navigation).
    if (want && gridShows(wsId)) return;
    if (!!state.bell[wsId] === want) return;
    if (want) state.bell[wsId] = true;
    else delete state.bell[wsId];
    schedule();
  }
  SB.bell = bell;
  SB.dotFor = dotFor;

  function onPrs() {
    return state.route.view === 'prs' || (state.route.view === 'pr' && !state.route.wsId);
  }

  function sidebarSignature() {
    var parts = [state.route.wsId || '', state.route.view === 'grid' ? 'G' : onPrs() ? 'P' : '', state.booted ? '1' : '0'];
    for (var i = 0; i < state.workspaces.length; i++) {
      var ws = state.workspaces[i];
      parts.push(ws.section + '/' + ws.id + '/' + dotFor(ws));
    }
    return parts.join(',');
  }

  function renderSidebar() {
    var side = document.getElementById('side');
    if (!side) return;
    var nav = side.querySelector('.ws');
    if (!nav) { nav = h('nav.ws'); side.appendChild(nav); }

    var sig = sidebarSignature();
    if (nav.getAttribute('data-sig') === sig) return;     // nothing visible changed
    var hadFocus = nav.contains(document.activeElement);
    nav.setAttribute('data-sig', sig);
    d.clear(nav);

    if (!state.workspaces.length) {
      nav.appendChild(d.empty(state.booted ? 'no workspaces' : 'looking…'));
      return;
    }

    // Above the groups, the way Notes keeps Quick Notes above the folders: the one
    // screen that is not a workspace. No dot — its squares are on screen when it is.
    var onGrid = state.route.view === 'grid';
    nav.appendChild(h('button.it.top' + (onGrid ? '.on' : ''), {
      type: 'button',
      title: 'Four terminals side by side  \u2318' + '0',
      'aria-current': onGrid ? 'true' : null,
      onClick: function () { go({ view: 'grid' }); }
    }, d.icon('grid'), h('span', null, 'Grid'), h('span.sp')));

    // The other screen that is not a workspace: your open pull requests, in every
    // repository. Lit while one of them is open, too — that screen is this row's.
    var prs = onPrs();
    nav.appendChild(h('button.it.top' + (prs ? '.on' : ''), {
      type: 'button',
      title: 'Your open pull requests, in every repository',
      'aria-current': prs ? 'true' : null,
      onClick: function () { go({ view: 'prs' }); }
    }, d.icon('pr'), h('span', null, 'Pull requests'), h('span.sp')));

    var section = null;
    state.workspaces.forEach(function (ws) {
      if (ws.section !== section) {
        section = ws.section;
        nav.appendChild(h('div.grp', null, sectionLabel(section, state.workspaces)));
      }
      var on = ws.id === state.route.wsId;
      var dot = dotFor(ws);
      nav.appendChild(h('button.it' + (on ? '.on' : ''), {
        type: 'button',
        title: ws.dir || ws.id,
        'aria-current': on ? 'true' : null,
        dataset: { ws: ws.id },
        onClick: function () { select(ws.id); }
      }, h('span', null, ws.id), h('span.sp'), dot ? h('span.dot.' + dot) : null));
    });

    if (hadFocus) {
      var sel = nav.querySelector('.it.on');
      if (sel) { try { sel.focus({ preventScroll: true }); } catch (e) { sel.focus(); } }
    }
  }

  // ── Claude usage ──────────────────────────────────────────────────────────

  // The rail's Usage row carries a dot only when the five-hour window is nearly
  // spent — the one moment the rail has something to say about Claude. Red, as a
  // failed process is: it is the thing about to stop you.
  function usageDot() {
    var u = state.usage;
    return u && u.session && u.session.severity === 'critical' ? 'fail' : '';
  }

  // The rail's last rows, pinned under the groups: Usage, while there is a Claude sign-in
  // to read it from, and Settings (§4.18), always. Their own signature, like the nav's,
  // so a poll that changed nothing visible leaves them alone.
  function renderFoot() {
    var side = document.getElementById('side');
    var foot = side ? side.querySelector('.foot') : null;
    if (!foot) return;
    var onUsage = state.route.view === 'usage';
    var onSettings = state.route.view === 'settings';
    var dot = usageDot();
    var sig = state.usageConfigured + '/' + (onUsage ? 'on' : 'off') + '/' + dot + '/' + (onSettings ? 'S' : '');
    if (foot.getAttribute('data-sig') === sig) return;
    var hadFocus = foot.contains(document.activeElement);
    var focusedSettings = hadFocus && document.activeElement && document.activeElement.getAttribute('data-foot') === 'settings';
    foot.setAttribute('data-sig', sig);
    d.clear(foot);
    foot.hidden = false;
    var usageBtn = null;
    if (state.usageConfigured) {
      usageBtn = h('button.it' + (onUsage ? '.on' : ''), {
        type: 'button',
        title: 'How much of your Claude plan is used',
        'aria-current': onUsage ? 'true' : null,
        onClick: function () { go({ view: 'usage' }); }
      }, d.icon('gauge'), h('span', null, 'Usage'), h('span.sp'), dot ? h('span.dot.' + dot) : null);
      foot.appendChild(usageBtn);
    }
    var settingsBtn = h('button.it' + (onSettings ? '.on' : ''), {
      type: 'button',
      title: 'Settings  \u2318,',
      'aria-current': onSettings ? 'true' : null,
      dataset: { foot: 'settings' },
      onClick: function () { go({ view: 'settings' }); }
    }, d.icon('sliders'), h('span', null, 'Settings'), h('span.sp'));
    foot.appendChild(settingsBtn);
    if (hadFocus) {
      var back = focusedSettings || !usageBtn ? settingsBtn : usageBtn;
      try { back.focus({ preventScroll: true }); } catch (e) { back.focus(); }
    }
  }

  function usageSignature(u) {
    if (!u) return 'none';
    var parts = [u.plan || ''];
    [u.session, u.weekly].concat(u.scoped || []).forEach(function (l) {
      if (l) parts.push(l.name + ':' + l.percent + ':' + l.severity + ':' + (l.resetsAt || ''));
    });
    return parts.join('|');
  }

  // A poll lands every five minutes, and usually nothing it says has changed.
  // When something has, the rail's row and the Grid's gauge are rewritten in place
  // (views/usage.js refresh()); only the Usage screen itself is rebuilt, being the
  // one screen with no terminal on it. Rendering the Grid for a bar that moved two
  // percent would re-parent four live shells and drop whichever one had focus.
  // A failed poll keeps the last GOOD numbers on screen — a transient rate-limit must
  // not blank the whole screen and drop the gauge, the way it did before. state.usage
  // is only ever the last ok answer; a failure sets state.usageError beside it. The
  // full-screen error is then only for a configured sign-in that has NEVER had an
  // answer. Removing the sign-in clears stale numbers and hides all Claude UI.
  function handleUsage(u) {
    if (!u || typeof u !== 'object') return;
    var before = state.usageConfigured + '|' + usageSignature(state.usage) + '|' + (state.usageError || '');
    state.usageConfigured = !!u.configured;
    if (!state.usageConfigured) { state.usage = null; state.usageError = null; }
    else if (u.ok) { state.usage = u; state.usageError = null; }
    else { state.usageError = u.error || 'that did not work'; }
    if (state.usageConfigured + '|' + usageSignature(state.usage) + '|' + (state.usageError || '') === before) return;
    renderFoot();
    if (!state.usageConfigured && state.route.view === 'usage') {
      state.route = normalize({ view: 'grid' });
      rememberScreen(state.route);
      schedule();
      return;
    }
    if (state.route.view === 'usage') { schedule(); return; }
    var view = SB.views.usage;
    var settled = view && typeof view.refresh === 'function' ? view.refresh() : true;
    if (!settled) schedule();                          // the gauge has to appear, or go
  }

  // The Usage screen's refresh button, its "Try again", and ⌘R on that screen. Through
  // act() for the button's spinner (SB.busy('usage')) and nothing else: an { ok:false }
  // Usage is a sentence the screen shows itself, not an error bar, so check() never
  // calls one a failure. The answer also arrives as sb:evt:usage, and whichever
  // delivery comes second is a no-op by signature.
  function refreshUsage() {
    var a = api();
    if (!a || typeof a.refreshUsage !== 'function') return Promise.resolve(null);
    return act(function () { return a.refreshUsage(); }, {
      key: 'usage',
      wsId: null,
      check: function () { return null; },
      onDone: handleUsage
    });
  }
  SB.refreshUsage = refreshUsage;

  // ── the grid's views ──────────────────────────────────────────────────────

  // Views live in the config (§4.10) so they survive a relaunch; which one the
  // Grid is showing lives in localStorage, the way the last workspace does. Every
  // change is applied here first and written after — a click must not wait on the
  // round trip — and whatever main kept replaces the list when it answers.

  function uid() {
    return 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function viewById(id) {
    var list = state.grid.views;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function currentView() {
    var want = state.grid.current;
    if (want === null) { try { want = window.localStorage.getItem(GRID_KEY); } catch (e) { want = null; } }
    return viewById(want) || state.grid.views[0] || null;
  }

  function adoptViews(res) {
    if (!res || !Array.isArray(res.views)) return;
    state.grid.views = res.views;
    state.grid.loaded = true;
    schedule();
  }

  // Only the answer to the LAST save is adopted. Two changes a moment apart — a name
  // typed and then a ‹ pressed — are two saves, and the first one's answer is the list
  // as it was before the second change: adopting it would put the view back where it
  // came from until the second answer arrived.
  var saves = 0;

  function persistViews() {
    var a = api();
    if (!a || typeof a.saveGridViews !== 'function') return;
    var mine = ++saves;
    Promise.resolve(a.saveGridViews(state.grid.views)).then(function (res) {
      if (mine === saves) adoptViews(res);
    }, noop);
  }

  function selectView(id) {
    state.grid.current = id;
    try { window.localStorage.setItem(GRID_KEY, id); } catch (e) { /* storage off */ }
    render();
  }

  // The squares of the view on screen — empty when the Grid is not.
  function gridCells() {
    if (state.route.view !== 'grid') return [];
    var view = currentView();
    return view ? view.cells : [];
  }

  function gridShows(wsId) {
    return gridCells().indexOf(wsId) !== -1;
  }

  SB.grid = {
    current: currentView,
    views: function () { return state.grid.views; },
    select: selectView,
    create: function (name) {
      var clean = String(name || '').trim().slice(0, 60);
      if (!clean) return null;
      var view = { id: uid(), name: clean, cells: [null, null, null, null] };
      state.grid.views.push(view);
      persistViews();
      selectView(view.id);
      return view;
    },
    rename: function (id, name) {
      var view = viewById(id);
      var clean = String(name || '').trim().slice(0, 60);
      if (!view || !clean || clean === view.name) return;
      view.name = clean;
      persistViews();
      render();
    },
    // Where a view stands in the row: `to` is the place it ends up in.
    move: function (id, to) {
      var list = state.grid.views;
      var from = list.indexOf(viewById(id));
      var at = Math.max(0, Math.min(list.length - 1, Number(to) || 0));
      if (from === -1 || at === from) return;
      list.splice(at, 0, list.splice(from, 1)[0]);
      persistViews();
      render();
    },
    remove: function (id) {
      var list = state.grid.views;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id !== id) continue;
        list.splice(i, 1);
        var next = list[Math.min(i, list.length - 1)];
        persistViews();
        selectView(next ? next.id : null);
        return;
      }
    },
    // One workspace per square and per view: putting sample-1 in a second square
    // would be two xterms for one shell, which is a bug, not a layout.
    assign: function (id, index, wsId) {
      var view = viewById(id);
      if (!view || index < 0 || index > 3) return;
      var want = wsId || null;
      if (want && view.cells.indexOf(want) !== -1 && view.cells[index] !== want) return;
      if (view.cells[index] === want) return;
      view.cells[index] = want;
      persistViews();
      render();
    }
  };

  // ── hiding the rail ───────────────────────────────────────────────────────

  // Closing the sidebar is a layout change, not a render: no view reads it, so it
  // is one class on .win and CSS does the rest — which is also why a toggle never
  // touches the terminal's scrollback or focus. What it does need is a settling
  // period; see SB.layout.
  var RAIL_MS = 260;                        // --rail-ms (220ms) plus a frame either side
  var railVisible = true;
  var railTimer = null;

  // views/terminal.js and views/logs.js ask this before every fit. The rail's slide
  // fires their ResizeObserver on every frame of it, and acting on those would send
  // the pty twenty resizes in a fifth of a second — twenty SIGWINCHs into a TUI that
  // is redrawing itself between each one. They hold, and relayout() fits them once
  // when the layout has stopped moving.
  SB.layout = {
    busy: function () { return railTimer !== null; }
  };

  // The Editor rides along without holding: Monaco's automaticLayout follows the
  // slide frame by frame (a Monaco layout is cheap and has no pty behind it), so
  // its relayout() here is only belt and braces for the slide's last frame.
  function settle() {
    railTimer = null;
    ['terminal', 'logs', 'editor'].forEach(relayoutView);
  }

  function relayoutView(name) {
    var view = SB.views[name];
    if (!view || typeof view.relayout !== 'function') return;
    try { view.relayout(); } catch (err) { console.error('[switchboard] relayout:', err); }
  }

  function railLabel() {
    var btn = document.getElementById('rail');
    if (!btn) return;
    btn.setAttribute('aria-expanded', railVisible ? 'true' : 'false');
    btn.setAttribute('aria-label', railVisible ? 'Hide Sidebar' : 'Show Sidebar');
    btn.title = (railVisible ? 'Hide Sidebar' : 'Show Sidebar') + '  \u2303\u2318S';
  }

  function applyRail(visible) {
    var want = visible !== false;
    var win = document.querySelector('.win');
    if (!win || want === railVisible) return;
    railVisible = want;
    win.classList.toggle('norail', !want);
    railLabel();

    // Focus cannot stay on a row that is no longer there — visibility:hidden takes
    // the rail out of the tab order. It goes to the button, which is where the eye
    // already is, rather than to the body, where Tab would start again from the top.
    var side = document.getElementById('side');
    if (!want && side && side.contains(document.activeElement)) {
      var btn = document.getElementById('rail');
      if (btn) { try { btn.focus({ preventScroll: true }); } catch (e) { btn.focus(); } }
    }

    // A timer rather than transitionend: under prefers-reduced-motion there is no
    // transition at all, so the event never arrives — and every terminal would then
    // stay frozen for good at the size it had before the toggle.
    if (railTimer) clearTimeout(railTimer);
    railTimer = setTimeout(settle, RAIL_MS);
  }

  function toggleRail() {
    if (editorFull) applyFull(false);                  // see handleSidebar
    var next = !railVisible;
    applyRail(next);                                   // the click has to feel instant
    var a = api();
    if (a && typeof a.setSidebar === 'function') {
      // Main persists it and flips the menu item's label. The sb:evt:sidebar it
      // broadcasts back lands on the state this window is already in, and applyRail
      // returns early on it.
      Promise.resolve(a.setSidebar(next))['catch'](noop);
    }
  }

  // ⌃⌘S is main's menu item, so it arrives here. With the Editor full screen the
  // rail is hidden whichever way .norail says, and flipping only the stored value
  // would be a keystroke that visibly does nothing — so it leaves full screen and
  // then applies the new choice. Only a real change does: the echo of a click this
  // window already applied lands on railVisible and must not end a full screen
  // entered in the round trip since.
  function handleSidebar(st) {
    if (!st || typeof st.visible !== 'boolean') return;
    if (editorFull && st.visible !== railVisible) applyFull(false);
    applyRail(st.visible);
  }

  // The rail's dots are the only place a background workspace's bell shows, so with
  // the rail closed the button carries one instead. Called from render(), which is
  // already what a bell schedules.
  function railBell() {
    var btn = document.getElementById('rail');
    if (!btn) return;
    var rang = false;
    for (var i = 0; i < state.workspaces.length; i++) {
      if (dotFor(state.workspaces[i]) === 'bell') { rang = true; break; }
    }
    btn.classList.toggle('rang', rang);
  }

  function initRail() {
    var btn = document.getElementById('rail');
    if (!btn) return;
    btn.appendChild(d.icon('sidebar'));
    btn.addEventListener('click', toggleRail);
    railLabel();
  }

  // Applied once at boot, then the transitions are turned back on. Both callbacks
  // on purpose: a preload without sb.sidebar(), or a main that answers with an
  // error, must still end up with a window that animates.
  function railReady(st) {
    handleSidebar(st);
    var win = document.querySelector('.win');
    if (!win) return;
    // Read a layout property to force the style recalculation NOW, while noanim is
    // still on: that is what commits the rail's position without a transition. Drop
    // it in the same task and the browser can fold both changes into one recalc,
    // whose after-change style has the transition back — and the rail animates shut
    // at boot after all. Measured: it does.
    void win.offsetWidth;
    setTimeout(function () { win.classList.remove('noanim'); }, 0);
  }

  // ── the Editor's full screen ──────────────────────────────────────────────

  // The button at the Editor's top-right corner (§4.9, §6 R13): the rail and the
  // header go and the editor has the whole window; the same button, or Esc, brings
  // them back. Like hiding the rail it is a layout change, not a render — one class
  // on .win, and the stylesheet slides the rail out, hides the header, the .drag
  // strip and the rail button, and shows the editor's own title band in their place
  // — so the buffers, the undo stack, the cursor and focus all stay where they are.
  // A class of its OWN rather than .norail: .norail is the user's stored choice and
  // owns the View menu's label, and a full screen is neither — leaving it has to put
  // back exactly the rail the user had, open or closed.
  //
  // Never persisted and never part of the route: it belongs to the Editor on screen,
  // so renderMain() drops it the moment anything else is (⌘1–9 and ⌘0 still work
  // with the rail gone, and back() moves state.route without passing through go()).
  // SB.layout.busy() is deliberately left alone: no terminal is on screen while the
  // Editor is, and Monaco laying itself out on every frame of the slide costs
  // nothing — there is no pty at the other end of it to resize.
  var editorFull = false;
  var fullTimer = null;

  function onEditor() {
    return state.route.view === 'workspace' && state.route.tab === 'editor' && !!state.route.wsId;
  }

  // `snap` is for renderMain() alone. Leaving full screen because the user went
  // somewhere else lands on a screen that may hold a terminal — a Terminal tab, the
  // Grid's four — and sliding the rail back in over it would fire their
  // ResizeObservers on every frame of the slide with no busy() to hold them: the
  // storm §4.9 measured, seven SIGWINCHs into a redrawing TUI. The whole column is
  // being replaced anyway, so the rail simply snaps back, committed under .noanim
  // the way railReady() commits the stored state at boot.
  function applyFull(on, snap) {
    var want = !!on;
    var win = document.querySelector('.win');
    if (!win || want === editorFull) return;
    if (want && !onEditor()) return;                   // only ever the Editor's
    editorFull = want;
    var quiet = !!snap && !win.classList.contains('noanim');
    if (quiet) win.classList.add('noanim');
    win.classList.toggle('edfull', want);
    if (quiet) {
      void win.offsetWidth;
      setTimeout(function () { win.classList.remove('noanim'); }, 0);
    }

    // Focus cannot stay on a rail that is sliding out of the tab order, nor on a rail
    // button that is display:none. It goes into the editor — Monaco's textarea when a
    // file is open — and otherwise nowhere, so the Editor's own landing focus decides.
    // A click on the Editor's button needs none of this: the Editor puts focus back
    // itself once the button it came from has disappeared (R13).
    if (want) {
      var el = document.activeElement;
      var side = document.getElementById('side');
      if (el && el !== document.body && ((side && side.contains(el)) || el.id === 'rail')) {
        var main = document.getElementById('main');
        var into = main && (main.querySelector('.edhost textarea.inputarea') || main.querySelector('.edhost textarea'));
        if (into) { try { into.focus({ preventScroll: true }); } catch (e) { into.focus(); } }
        else if (typeof el.blur === 'function') el.blur();
      }
    }

    // Monaco's automaticLayout follows the slide on its own; one relayout() when it
    // is over is belt and braces for its last frame. Its own timer, not railTimer.
    if (fullTimer) clearTimeout(fullTimer);
    fullTimer = setTimeout(function () { fullTimer = null; relayoutView('editor'); }, RAIL_MS);
  }

  // views/editor.js's button and its Esc go through these; nothing else does.
  SB.layout.full = function () { return editorFull; };
  SB.layout.setFull = function (on) { applyFull(!!on); };

  // ── main column ───────────────────────────────────────────────────────────

  function screen(body) {
    return d.frag(h('div.hd'), h('div.bd', null, body));
  }

  function bootScreen() {
    return screen(h('div.empty'));
  }

  function noWorkspacesScreen() {
    return screen(d.empty(
      'Add your folders to ~/.switchboard/config.json. The README includes an example and a Codex workspace setup skill.',
      { title: 'set up your workspaces' }
    ));
  }

  function noBridgeScreen() {
    return screen(d.empty(
      'the window could not reach the app process. quit switchboard and open it again.',
      { title: 'not connected' }
    ));
  }

  function missingScreen(view) {
    return screen(d.empty('the ' + view + ' screen is not available in this build.', { title: 'nothing to show' }));
  }

  function crashScreen(view, err) {
    return screen(d.empty(message(err), {
      title: 'the ' + view + ' screen failed',
      action: { label: 'Back', onClick: function () { if (!back()) render(); } }
    }));
  }

  function buildView() {
    if (!api()) return noBridgeScreen();
    if (!state.booted && !state.workspaces.length) return bootScreen();
    var name = state.route.view;
    // A saved Usage route may arrive before the local sign-in check finishes.
    // Show the Grid until a credential is confirmed, with no Claude setup prompt.
    if (name === 'usage' && !state.usageConfigured) name = 'grid';
    // Usage is about this Mac's Claude sign-in and Pull requests about its GitHub
    // sign-in, not a workspace: both show with none, as does a PR opened from the list.
    var free = name === 'usage' || name === 'prs' || name === 'settings' || (name === 'pr' && !state.route.wsId && !!state.route.number);
    if (!free && !state.workspaces.length) return noWorkspacesScreen();
    if (!free && name !== 'grid' && !currentWorkspace()) return noWorkspacesScreen();

    var view = SB.views[name];
    // Logs is a TAB of the workspace route but lives in its own file, and it
    // composes the whole screen itself — it borrows the shared header from
    // SB.views.workspace.header(ws, state) and owns the .bd.pane below it. So the
    // logs tab routes straight to logs.js, never to workspace.js. Terminal and the
    // Editor work exactly the same way, which is why this is a lookup and not ifs.
    if (name === 'workspace') {
      var own = SB.views[TAB_VIEWS[state.route.tab]];
      if (own && typeof own.render === 'function') view = own;
    }
    if (!view || typeof view.render !== 'function') return missingScreen(name);

    try {
      var node = view.render(state);
      if (node && node.nodeType) return node;
      return missingScreen(name);
    } catch (err) {
      console.error('[switchboard] the ' + name + ' view threw:', err);
      return crashScreen(name, err);
    }
  }

  function scroller() {
    var main = document.getElementById('main');
    return main ? main.querySelector('.bd') : null;
  }

  function onScrolled() {
    var bd = scroller();
    if (!bd || !mounted.key) return;
    state.scroll[mounted.key] = bd.scrollTop;
    mounted.want = null;
  }

  function saveScroll() {
    if (!mounted.key) return;
    // mounted.want survives when a restore could not land because the body had
    // not filled in yet; keep it rather than recording the clamped 0.
    if (mounted.want !== null) { state.scroll[mounted.key] = mounted.want; return; }
    var bd = scroller();
    if (bd) state.scroll[mounted.key] = bd.scrollTop;
  }

  function restoreScroll(key) {
    var bd = scroller();
    mounted.want = null;
    if (!bd) return;
    var want = state.scroll[key] || 0;
    if (!want) return;
    bd.scrollTop = want;
    if (bd.scrollTop !== want) mounted.want = want;       // retry after the content lands
  }

  // A view may hand back a fragment — its .hd / .bd become direct children of
  // <main>, which is exactly what styles.css lays out — or a single wrapper
  // element, which has no class in the stylesheet. Give a wrapper the column
  // layout inline, or .bd cannot claim the remaining height and stops scrolling.
  function fit(main) {
    if (main.childElementCount !== 1) return;
    var only = main.firstElementChild;
    if (!only || only.classList.contains('hd') || only.classList.contains('bd')) return;
    var s = only.style;
    s.display = 'flex';
    s.flexDirection = 'column';
    s.flex = '1';
    s.minWidth = '0';
    s.minHeight = '0';
  }

  function focusPath(root) {
    var el = document.activeElement;
    if (!el || el === document.body || !root.contains(el)) return null;
    var path = [];
    while (el && el !== root) {
      var parent = el.parentNode;
      if (!parent || !parent.children) return null;
      path.unshift(Array.prototype.indexOf.call(parent.children, el));
      el = parent;
    }
    return path;
  }

  function refocus(root, path) {
    if (!path) return;
    var el = root;
    for (var i = 0; i < path.length; i++) {
      el = el && el.children ? el.children[path[i]] : null;
      if (!el) return;
    }
    if (!el || typeof el.focus !== 'function') return;
    if (el.tabIndex < 0 && !/^(BUTTON|A|INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
  }

  function applyNotice(main) {
    var old = main.querySelector('[data-sb-notice]');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var n = state.notice;
    if (!n || !n.message) return;
    if (n.wsId && n.wsId !== state.route.wsId) return;
    var host = main.querySelector('.bd') || main;
    // Never two bars. views/workspace.js keeps its own notice for the actions it
    // starts (Start's conflict, a failed Pull main), and the standing rule is one
    // full-width notice with one fix — so if the screen already shows one, the
    // app-level notice waits rather than stacking underneath it.
    if (host.firstElementChild && host.firstElementChild.classList.contains('bar')) return;
    host.insertBefore(noticeNode(n), host.firstChild);
  }

  function renderMain() {
    var main = document.getElementById('main');
    if (!main) return;

    // Full screen is the Editor's alone, and this is where it is dropped for the
    // same reason the bell below is cleared here: every navigation passes through
    // (⌘1–9 and ⌘0 still work with the rail gone; back() skips go()). Snapped, not
    // slid — see applyFull().
    if (editorFull && !onEditor()) applyFull(false, true);

    saveScroll();
    // Standing in front of a workspace's Terminal IS reading its bell. Cleared
    // here rather than in go() because renderMain is the one choke point every
    // navigation passes through — back() sets state.route directly — and cleared
    // in place rather than through bell(), since we are already inside a render
    // and dotFor() never rings the row you are standing on anyway.
    if (state.route.view === 'workspace' && state.route.tab === 'terminal' && state.route.wsId) {
      delete state.bell[state.route.wsId];
    }
    gridCells().forEach(function (id) { if (id) delete state.bell[id]; });
    // Captured BEFORE buildView(): views/logs.js builds its body by moving the
    // LIVE terminal host — which owns the focused textarea — into the node it is
    // returning, so by the time buildView() comes back focus has already left
    // #main and focusPath() would see nothing.
    var active = document.activeElement;
    var path = focusPath(main);
    var key = routeKey(state.route);
    var node = buildView();
    // An Editor route that did not come back as the Editor — its view crashed, the
    // workspace went — must not keep the rail and header hidden over whatever did.
    // Every one of those stand-ins is screen()'s fragment; the Editor's root never is.
    if (editorFull && (!node || node.nodeType !== 1)) applyFull(false, true);
    // views/editor.js returns the element that is already mounted (§6 R13). Leaving
    // it in place is the whole point: no d.clear(), so nothing inside it is detached,
    // blurred and refocused, and Monaco keeps its widgets, its composition and focus.
    var reuse = !!node && node === mounted.node && node.parentNode === main;

    if (!reuse) {
      var bd = scroller();
      if (bd) bd.removeEventListener('scroll', onScrolled);
      d.clear(main);
      if (node) main.appendChild(node);
      mounted.node = node;
      fit(main);
      // The element itself may have been carried into the new tree; prefer it,
      // and fall back to the positional path for a view rebuilt from scratch.
      if (active && main.contains(active) && typeof active.focus === 'function') {
        try { active.focus({ preventScroll: true }); } catch (e) { active.focus(); }
      } else {
        refocus(main, path);
      }
    }

    mounted.key = key;
    applyNotice(main);

    // The Diagrams tab's editor stays mounted behind every other screen; it has to know
    // the moment it is not the one showing, or it would answer keys meant for that one.
    var dg = SB.views.diagrams;
    if (dg && typeof dg.shown === 'function') {
      try { dg.shown(state.route); } catch (err) { console.error('[switchboard] diagrams shown:', err); }
    }

    if (!reuse) {
      restoreScroll(key);
      var fresh = scroller();
      if (fresh) fresh.addEventListener('scroll', onScrolled, { passive: true });
    }

    retirePanes();
  }

  // A Logs pane holds a live Terminal, a ResizeObserver and up to a 10 000-line
  // scrollback, and nothing else ever frees them — views/logs.js exports dispose()
  // and has had no caller. Keep the pane on screen and the ones still producing
  // output; a finished workspace's pane is rebuilt from main's ring buffer the
  // next time its Logs tab is opened. renderMain is the one choke point every
  // navigation passes through (go() is not: back() sets state.route directly).
  //
  // A Terminal pane goes by a DIFFERENT rule, and the difference is the whole
  // point. A Logs pane is safe to drop because main's ring buffer rebuilds it
  // faithfully — it is append-only output. A live shell is not: replaying a
  // full-screen TUI's ring buffer into a fresh xterm paints garbage, because the
  // cursor moves and repaints that made sense against the old screen are now
  // being run against a blank one. So a terminal pane whose shell is STILL ALIVE
  // is never dropped, however far off screen it is. Only an exited shell's pane
  // is worth the memory back.
  function retirePanes() {
    var logs = SB.views.logs;
    var term = SB.views.terminal;
    var notes = SB.views.notes;
    var canLogs = !!logs && typeof logs.dispose === 'function';
    var canTerm = !!term && typeof term.dispose === 'function';
    var canNotes = !!notes && typeof notes.dispose === 'function';
    if (!canLogs && !canTerm && !canNotes) return;

    var here = state.route.view === 'workspace' ? state.route.wsId : null;
    var onLogs = state.route.tab === 'logs' ? here : null;
    var onTerm = state.route.tab === 'terminal' ? here : null;
    var onGrid = gridCells();

    // Every id a pane may exist for: the rail's workspaces, and the folders the Grid's
    // squares hold or held (§4.10) — a folder is on no rail, so its shell's record is
    // the only place its id is still written down once it has left its square.
    var ids = [];
    var seen = {};
    for (var w = 0; w < state.workspaces.length; w++) { ids.push(state.workspaces[w].id); seen[state.workspaces[w].id] = true; }
    Object.keys(state.shell).forEach(function (sid) { if (!seen[sid]) { ids.push(sid); seen[sid] = true; } });

    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var run = state.run[id] || {};
      var shell = state.shell[id] || {};
      if (canLogs && id !== onLogs && run.status !== 'starting' && run.status !== 'running') {
        logs.dispose(id);
      }
      // Two conditions, not one. state.shell is main's last word and lags a spawn by a
      // round trip, so a shell opened a moment ago still reads as absent — navigate away
      // inside that window and the pane its output is about to arrive in gets thrown out
      // from under it. hasLivePane() is the view's own answer to the same question and is
      // true from the instant the pane exists. This is the caller it was written for.
      if (canTerm && id !== onTerm && onGrid.indexOf(id) === -1 && shell.status !== 'running') {
        var paneAlive = typeof term.hasLivePane === 'function' && term.hasLivePane(id);
        if (!paneAlive) term.dispose(id);
      }
      // A note pane is cheap to rebuild — one read — but it holds a whole
      // contenteditable block tree, it costs a read on every window focus while it
      // exists, and it is one more editor for noteedit's selectionchange listener to
      // walk on every caret move. The workspace on screen keeps its pane whatever tab
      // is showing (switching tabs inside one workspace must not throw it away), and so
      // does every Grid square; dispose() itself declines to drop an unsaved one.
      if (canNotes && id !== here && onGrid.indexOf(id) === -1) notes.dispose(id);
    }
    // A folder square's note lives under an absolute-path id, which is on no rail and
    // in state.shell only while its shell is alive: ask the view for the rest.
    if (canNotes && typeof notes.ids === 'function') {
      notes.ids().forEach(function (id) {
        if (id !== here && onGrid.indexOf(id) === -1 && !seen[id]) notes.dispose(id);
      });
    }
  }

  function render() {
    try {
      renderSidebar();
      renderFoot();
      railBell();
    } catch (err) {
      console.error('[switchboard] the sidebar failed to render:', err);
    }
    try {
      renderMain();
    } catch (err) {
      console.error('[switchboard] the main column failed to render:', err);
    }
  }
  SB.render = render;

  // ── push events ───────────────────────────────────────────────────────────

  function handleLog(wsId, chunk, procName) {
    var logs = SB.views.logs;
    if (!logs) return;
    if (typeof logs.onLog === 'function') logs.onLog(wsId, chunk, procName);
    else if (typeof logs.write === 'function') logs.write(wsId, chunk, procName);
  }

  // The Logs footer reads "exited 1 · 4s", and main sends no exit timestamp — only
  // a status that has flipped to 'exited'. Stamp the moment we SEE the flip, and
  // carry the stamp forward across later states of the same exit. A state that is
  // already 'exited' the first time we see it is left unstamped on purpose: we do
  // not know when it happened, and the footer then simply omits the duration.
  function stampExit(rs) {
    var prev = state.run[rs.wsId] || null;
    if (rs.status === 'exited' && !rs.exitedAt) {
      if (prev && prev.exitedAt) rs.exitedAt = prev.exitedAt;
      else if (prev && prev.status !== 'exited') rs.exitedAt = Date.now();
    }
    if (!Array.isArray(rs.procs)) return;
    var was = {};
    ((prev && prev.procs) || []).forEach(function (p) { if (p && p.name) was[p.name] = p; });
    rs.procs.forEach(function (p) {
      if (!p || !p.name || p.status !== 'exited' || p.exitedAt) return;
      var before = was[p.name];
      if (!before) return;
      if (before.exitedAt) p.exitedAt = before.exitedAt;
      else if (before.status !== 'exited') p.exitedAt = Date.now();
    });
  }

  function adoptRunStates(states) {
    if (!states || typeof states !== 'object' || states.ok === false) return;
    Object.keys(states).forEach(function (id) {
      if (!states[id]) return;
      states[id].wsId = states[id].wsId || id;
      stampExit(states[id]);
      state.run[id] = states[id];
    });
    schedule();
  }

  // Shells outlive the renderer: a devtools reload throws this window away while
  // main keeps every pty running. Without adopting them the new renderer would
  // think the workspace had no shell and sb.openShell would hand back the live one
  // anyway — with a ring buffer the pane never knew to replay.
  function adoptShellStates(states) {
    if (!states || typeof states !== 'object' || states.ok === false) return;
    Object.keys(states).forEach(function (id) {
      if (!states[id]) return;
      states[id].wsId = states[id].wsId || id;
      state.shell[id] = states[id];
    });
    schedule();
  }

  function handleRunState(rs) {
    if (!rs || !rs.wsId) return;
    stampExit(rs);
    state.run[rs.wsId] = rs;
    if (typeof SB.views.logs === 'object' && SB.views.logs && typeof SB.views.logs.onRunState === 'function') {
      try { SB.views.logs.onRunState(rs); } catch (e) { console.error(e); }
    }
    schedule();
  }

  // Straight into the live xterm and deliberately NO re-render, exactly as
  // handleLog does: shell output arrives a chunk at a time and rebuilding the main
  // column per chunk would throw away the terminal's keyboard focus and selection
  // dozens of times a second.
  function handleTermData(wsId, chunk) {
    var term = SB.views.terminal;
    if (!wsId || !term) return;
    if (typeof term.write === 'function') term.write(wsId, chunk);
  }

  // A shell spawning or exiting IS visible — the header's tab, the `.exit` footer,
  // whether the pane may be retired — so this one does re-render, through
  // schedule() so a spawn and its first state land in one frame.
  function handleTermState(shell) {
    if (!shell || !shell.wsId) return;
    state.shell[shell.wsId] = shell;
    var term = SB.views.terminal;
    if (term && typeof term.onState === 'function') {
      try { term.onState(shell); } catch (e) { console.error(e); }
    }
    schedule();
  }

  // The Edit menu's Copy / Paste / Select All are custom items rather than roles,
  // because an accelerator wins over the renderer's keydown and xterm's selection
  // is not a DOM selection (ARCHITECTURE §4.7). Undo / Redo / Cut joined them with
  // the Editor, and File ▸ Close (⌘W) with them: the native roles run Chromium's
  // editing command on the focused element, which Monaco ignores — measured, ⌘Z
  // did nothing at all, or undid one character of its hidden textarea rather than
  // Monaco's own undo stack — and role:'close' shut the whole window on the ⌘W
  // Sublime's muscle memory sends to close a tab. First refusal goes to the focused
  // terminal, then to the Editor, and everything else falls through to the document.
  //
  // That fallback is a real behaviour change for the WHOLE app, not just the
  // Terminal tab: ⌘C over a diff now goes through document.execCommand('copy')
  // instead of the menu's built-in copy role. It works — the diff is an ordinary
  // DOM selection — but this is the path it takes now.
  function handleEdit(e) {
    if (!e || !e.action) return;
    var term = SB.views.terminal;
    var done = term && typeof term.editAction === 'function'
      ? term.editAction(e.action, e.text) : false;
    if (done) return;
    // The Diagrams canvas: Undo and Redo are its own, and a pasted screenshot goes onto
    // it as a picture — before the line below throws an image paste away. Only while
    // the canvas has the keyboard; a box's text field gets the document's fallback.
    var dg = SB.views.diagrams;
    if (dg && typeof dg.editAction === 'function') {
      try {
        if (dg.editAction(e.action, e.text, e.image)) return;
      } catch (err) { console.error('[switchboard] diagrams edit:', err); }
    }
    // A pasted screenshot arrives as the escaped path of a PNG main saved it to (§4.7):
    // that is for a terminal, whose Claude Code reads the image from it. Typed into a
    // source file, the Editor's ⌘P / ⇧⌘F fields or the Grid's name field it is only junk,
    // so once the terminal has declined it nothing else gets the chance.
    if (e.action === 'paste' && e.image) return;
    // The Notes tab and a Grid square showing a note are the app's only contenteditable,
    // and the document fallback below cannot serve one: fieldIn() matches INPUT and
    // TEXTAREA alone, so Cut and Paste would do nothing at all, and Undo would run
    // Chromium's own history over a DOM the note's model owns.
    var notes = SB.views.notes;
    if (notes && typeof notes.editAction === 'function') {
      try {
        if (notes.editAction(e.action, e.text)) return;
      } catch (err) { console.error('[switchboard] notes edit:', err); }
    }
    // A throw is a refusal: the document fallback below still gets its turn, so a
    // broken Editor cannot take ⌘C and ⌘V away from the rest of the app.
    var ed = SB.views.editor;
    if (ed && typeof ed.editAction === 'function') {
      try {
        if (ed.editAction(e.action, e.text)) return;
      } catch (err) { console.error('[switchboard] editor edit:', err); }
    }
    if (editableFocused() && e.action !== 'close') return;
    try {
      // NOT document.execCommand('copy'): Chromium refuses it without a user gesture,
      // and arriving here from an IPC event is not one. It failed SILENTLY — a 337-
      // character diff selection, ⌘C, and the clipboard untouched. Main writes it.
      // Only .diff, .term, .cmt .cb and the file-row paths are selectable at all
      // (styles.css line 92 sets user-select:none on everything else), so an empty
      // selection is the ordinary case here and must not wipe the clipboard.
      if (e.action === 'copy') {
        var text = String(window.getSelection() || '');
        if (text) Promise.resolve(window.sb.writeClipboard(text))['catch'](function () {});
      } else if (e.action === 'selectAll') {
        document.execCommand('selectAll');
      } else if (e.action === 'undo' || e.action === 'redo') {
        // What the roles did, and the one thing they were good at: a text field's own
        // undo — the Grid's name field. Anywhere else it is a no-op, as it was.
        document.execCommand(e.action);
      } else if (e.action === 'cut') {
        // Copy the selected part of a field through main (the same gesture problem
        // as Copy), then delete it as an edit, so the field's undo can bring it back.
        var field = fieldIn(document.activeElement);
        if (field && typeof field.selectionStart === 'number' && field.selectionEnd > field.selectionStart) {
          var cut = field.value.slice(field.selectionStart, field.selectionEnd);
          Promise.resolve(window.sb.writeClipboard(cut))['catch'](function () {});
          document.execCommand('delete');
        }
      } else if (e.action === 'paste') {
        // There ARE text inputs now — the Grid's name field, and the Editor's own
        // fields when it declines — and the menu's ⌘V never lets a keystroke reach
        // them. Chromium refuses document.execCommand('paste'), but main has already
        // read the clipboard into e.text, and insertText types it at the caret as an
        // edit: the field's input event fires and its undo can take it back.
        if (fieldIn(document.activeElement) && typeof e.text === 'string' && e.text) {
          document.execCommand('insertText', false, e.text);
        }
      } else if (e.action === 'close') {
        // ⌘W anywhere the Editor did not take it closes the window, exactly as the old
        // File ▸ Close role did — through win.close(), so the bounds are saved, a
        // pending publish installs, and unsaved Editor buffers are asked about (§4.14).
        var a = api();
        if (a && typeof a.closeWindow === 'function') Promise.resolve(a.closeWindow())['catch'](noop);
      }
    } catch (err) { /* the document refused; there is nothing else to try */ }
  }

  function fieldIn(el) {
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? el : null;
  }

  // A note is the app's one contenteditable, and two things have to step around it: the
  // last line of the Edit-menu chain, whose commands are all the browser's own and know
  // nothing of the note's block model, and the window shortcuts that would otherwise
  // read a keystroke meant for the text.
  function editableFocused() {
    var el = document.activeElement;
    return !!el && el.isContentEditable === true;
  }

  function handleLinks(wsId, links) {
    if (!wsId) return;
    var rs = state.run[wsId];
    if (!rs) {
      rs = state.run[wsId] = {
        wsId: wsId, status: 'starting', pid: null, startedAt: Date.now(), exitCode: null, links: []
      };
    }
    rs.links = Array.isArray(links) ? links : [];
    schedule();
  }

  // The window regaining focus is also how ⌘R arrives: main's View ▸ Refresh
  // accelerator sends sb:evt:focus, because a menu accelerator wins over any
  // keydown the renderer would otherwise see.
  function handleFocus(opt) {
    var wantFetch = !!(opt && opt.fetch);
    var now = Date.now();
    // The guard is for the focus storm alt-tabbing makes. An explicit ⌘R is never
    // dropped by it: a fetch is the only thing that unfreezes `behind`, which is
    // read from refs frozen at the last git fetch.
    if (!wantFetch && now - lastFocusRefresh < 1200) return;
    lastFocusRefresh = now;
    if (state.route.wsId) refresh(state.route.wsId, { fetch: wantFetch });
    // ⌘R on the Usage screen asks Anthropic again. A plain focus does not: main
    // already re-asks on focus when the last answer is old (§4.11).
    if (wantFetch && state.route.view === 'usage') refreshUsage();
    // The GitHub screens revalidate themselves: a focus lets main's 60 s cache answer,
    // ⌘R asks GitHub again now. A workspace's own pull request is already covered by
    // the re-scan above on a focus; ⌘R still has to reach past the cache for it.
    var prs = SB.views.prs;
    if (state.route.view === 'prs' && prs && typeof prs.refresh === 'function') prs.refresh(wantFetch);
    var pr = SB.views.pr;
    if (state.route.view === 'pr' && pr && typeof pr.refresh === 'function' && (wantFetch || !state.route.wsId)) pr.refresh(wantFetch);
    // The Editor has no watcher (§4.14): coming back to the window is when a file
    // changed behind its back — a formatter, a `git checkout`, Claude — so it re-lists
    // the tree, re-stats its open tabs and re-reads their HEAD versions now. In place,
    // never through a render, and behind the same storm guard as everything above.
    var ed = SB.views.editor;
    if (onEditor() && ed && typeof ed.refresh === 'function') {
      try { ed.refresh(wantFetch); } catch (err) { console.error('[switchboard] editor refresh:', err); }
    }
    // A note has no watcher either (§4.15). A clean one follows the file — it may have
    // been edited in another app, or synced — and one with unsaved text is left alone;
    // its next save finds the conflict and asks.
    var notes = SB.views.notes;
    if (notes && typeof notes.refresh === 'function') {
      try { notes.refresh(); } catch (err) { console.error('[switchboard] notes refresh:', err); }
    }
    // A CLI installed or signed in to while the window was away changes who can answer.
    var dgv = SB.views.diagrams;
    if (dgv && typeof dgv.refresh === 'function') {
      try { dgv.refresh(); } catch (err) { console.error('[switchboard] diagrams refresh:', err); }
    }
    var a = api();
    if (a) Promise.resolve(a.runStates()).then(adoptRunStates, noop);
  }

  function subscribe() {
    var a = api();
    if (!a) return;
    try { a.onLog(handleLog); } catch (e) { console.error('[switchboard] onLog:', e); }
    try { a.onRunState(handleRunState); } catch (e) { console.error('[switchboard] onRunState:', e); }
    try { a.onLinks(handleLinks); } catch (e) { console.error('[switchboard] onLinks:', e); }
    try { a.onFocus(handleFocus); } catch (e) { console.error('[switchboard] onFocus:', e); }
    try { a.onTermData(handleTermData); } catch (e) { console.error('[switchboard] onTermData:', e); }
    try { a.onTermState(handleTermState); } catch (e) { console.error('[switchboard] onTermState:', e); }
    try { a.onEdit(handleEdit); } catch (e) { console.error('[switchboard] onEdit:', e); }
    try { a.onAppearance(handleAppearance); } catch (e) { console.error('[switchboard] onAppearance:', e); }
    try { a.onSidebar(handleSidebar); } catch (e) { console.error('[switchboard] onSidebar:', e); }
    try { a.onUsage(handleUsage); } catch (e) { console.error('[switchboard] onUsage:', e); }
    try { a.onPublish(handlePublish); } catch (e) { console.error('[switchboard] onPublish:', e); }
    if (typeof a.onOpenSettings === 'function') {
      try { a.onOpenSettings(function () { go({ view: 'settings' }); }); } catch (e) { console.error('[switchboard] onOpenSettings:', e); }
    }
  }

  // No render() — term-theme.js rewrites the :root tokens and hands the new palette
  // straight to the live xterms. Rebuilding the view would throw away the terminal's
  // keyboard focus and the user's selection to repaint colours that have already
  // changed underneath it.
  function handleAppearance(state) {
    if (state && state.effective) SB.termTheme.set(state.effective);
  }

  // ── keyboard ──────────────────────────────────────────────────────────────

  function typing(el) {
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true);
  }

  function shortcuts() {
    window.addEventListener('keydown', function (e) {
      // The Editor first, before Esc means back: ⌘S, ⌘P and ⇧⌘F are its own (no
      // menu accelerator takes them and Monaco binds none, so they bubble here), and
      // its Esc closes the palette or leaves full screen before it is ever a step
      // back. It answers false for everything else, and off its own tab for all of it.
      var ed = SB.views.editor;
      if (ed && typeof ed.onKey === 'function') {
        var used = false;
        try { used = ed.onKey(e); } catch (err) { console.error('[switchboard] editor key:', err); }
        if (used) { e.preventDefault(); return; }
      }
      // ⌘S in a note writes it now, the way ⌘S does in the Editor. Nothing else here
      // is the note's; its own keys are bound on its root and never reach the window.
      var nv = SB.views.notes;
      if (nv && typeof nv.onKey === 'function') {
        var took = false;
        try { took = nv.onKey(e); } catch (err) { console.error('[switchboard] notes key:', err); }
        if (took) { e.preventDefault(); return; }
      }
      // The Diagrams tab: Esc leaves a full-screen diagram before it means back, and ⌘↵
      // over the canvas is ✦ Answer (the editor's own listener), never Start.
      var dv = SB.views.diagrams;
      if (dv && typeof dv.onKey === 'function') {
        var kept = false;
        try { kept = dv.onKey(e); } catch (err) { console.error('[switchboard] diagrams key:', err); }
        if (kept) { e.preventDefault(); return; }
      }
      if (e.key === 'Escape') {
        // The composer, the terminal and Monaco (a textarea too) keep Esc.
        if (typing(e.target)) return;
        if (back()) e.preventDefault();
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;

      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        refresh(state.route.wsId, { fetch: e.shiftKey });
        return;
      }
      // Start and Stop step aside for a NOTE and nothing else. Not typing(): xterm's
      // helper textarea and Monaco's inputarea are both TEXTAREAs and hold the focus by
      // default on their tabs, so guarding on that killed ⌘. and ⌘Enter exactly where
      // §6 R2 says they keep their app-wide meaning. A note is prose — ⌘Enter there is
      // a keystroke in the text, and no keyboard should be able to start a dev server
      // by accident — and it is the app's one contenteditable.
      if (e.key === '.') {
        if (editableFocused()) return;
        e.preventDefault();
        if (isLive(runStateOf(state.route.wsId))) stop(state.route.wsId);
        return;
      }
      if (e.key === 'Enter') {
        if (editableFocused()) return;
        e.preventDefault();
        if (!isLive(runStateOf(state.route.wsId))) start(state.route.wsId);
        return;
      }
      if (e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        var ws = state.workspaces[Number(e.key) - 1];      // flat index across the groups
        if (ws) select(ws.id);
        return;
      }
      if (e.key === '0') {                                  // the row above the groups
        e.preventDefault();
        if (state.workspaces.length) go({ view: 'grid' });
      }
    });
  }

  // ── boot ──────────────────────────────────────────────────────────────────

  function pickInitial() {
    var last = lastUsed();
    if (last && state.byId[last]) return last;
    return state.workspaces.length ? state.workspaces[0].id : null;
  }

  // There is deliberately no uptime ticker here: views/workspace.js's liveSpan
  // already rewrites the "running 14s" text node in place once a second and clears
  // its own interval when the node leaves the document. Calling render() for it
  // would rebuild the whole main column every second, which throws away the logs
  // terminal's keyboard focus, the hovered row and any selection. Everything that
  // must genuinely redraw (Start→Stop, links coming up, an exit code) already
  // arrives through handleRunState / handleLinks, which schedule for themselves.

  function boot() {
    render();                                              // the rail and an empty column, immediately
    initRail();

    var a = api();
    if (!a) {
      railReady(null);
      state.loading = false;
      state.booted = true;
      render();
      return;
    }

    subscribe();
    shortcuts();

    // Before the workspace list, and not chained to it: the palette has nothing to do
    // with what git says, and a Terminal opened while a slow first scan is still
    // running must not be built in the wrong colours and repainted a second later.
    if (typeof a.termAppearance === 'function') {
      Promise.resolve(a.termAppearance()).then(handleAppearance, noop);
    }

    // Same reasoning, and the same place in the order: whether the rail is open is
    // a property of the window, not of anything git has to say about it.
    if (typeof a.sidebar === 'function') Promise.resolve(a.sidebar()).then(railReady, railReady);
    else railReady(null);

    if (typeof a.gridViews === 'function') Promise.resolve(a.gridViews()).then(adoptViews, noop);
    // Likewise: what Anthropic says about the plan has nothing to do with the repos.
    if (typeof a.usage === 'function') Promise.resolve(a.usage()).then(handleUsage, noop);

    function failed(err) {
      state.loading = false;
      state.booted = true;
      notice({ kind: 'err', wsId: null, message: message(err) });
      render();
    }

    Promise.resolve(a.listWorkspaces()).then(function (list) {
      try {
        adoptWorkspaces(list);
      } catch (err) {
        failed(err);
        return;
      }
      var wanted = pickInitial();
      // Back to the Grid or to Usage if that is where the window was closed; the last
      // workspace is still remembered and scanned, so the rail's dots are right either way.
      var screen = lastScreen();
      state.route = normalize({ view: FREE[screen] ? screen : 'workspace', wsId: wanted });
      state.loading = false;
      state.booted = true;
      render();                                            // first paint: no git has run yet
      if (wanted) { remember(wanted); refresh(wanted); }
    }, failed).then(function () {
      Promise.resolve(a.runStates()).then(adoptRunStates, noop);
      if (typeof a.publishState === 'function') Promise.resolve(a.publishState()).then(handlePublish, noop);
      // Only at boot, and only here: unlike run states, which handleFocus re-reads
      // on every window focus, a shell's state only ever changes through
      // sb:evt:termState — so one adoption is enough, and it is the reload that
      // needs it.
      if (typeof a.shellStates === 'function') {
        Promise.resolve(a.shellStates()).then(adoptShellStates, noop);
      }
    }, noop);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})(window.SB);
