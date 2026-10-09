// SB.views.workspace — the Changes tab, and the header the other tabs share.
//
//   SB.views.workspace.render(state) -> the whole <main> column for
//     {view:'workspace', wsId, tab:'changes'}
//   SB.views.workspace.header(ws, state) -> the fixed .hd block; views/logs.js,
//     views/terminal.js, views/editor.js and views/databases.js call this so every tab
//     carries exactly the same title, sub line, buttons and
//     Changes | Logs | Terminal | Editor | Databases. Whiteboards are not a tab: they
//     belong to no workspace and have their own screen in the rail (views/whiteboards.js).
//   SB.views.workspace.changesBody(ws, state) -> the Changes content for a Grid cell.
//
// One repo is ONE row: name, branch pill, a refresh when it sits on main, and
// then EITHER the summary button OR one short state phrase — never both. When the
// workspace is running each row also carries the address it serves, right-aligned.
// Everything else (the file list, the diffs, the pull request) is a tap away.
window.SB = window.SB || {};
SB.views = SB.views || {};

(function (SB) {
  'use strict';

  var dom = SB.dom;
  var h = dom.h;

  // The one piece of per-workspace view state: the notice bar the last action on
  // this screen left behind. app.js expects it (see applyNotice) and holds back
  // its own bar while this one is showing, so there is never a stack of two.
  // In-flight state is NOT kept here — SB.busy(key) already knows.
  var ui = {};

  function uiFor(wsId) {
    return ui[wsId] || (ui[wsId] = { notice: null });
  }

  // Setting our bar retires app.js's, so answering ours cannot uncover a second one.
  function setNotice(wsId, notice) {
    uiFor(wsId).notice = notice;
    if (typeof SB.dismiss === 'function') SB.dismiss();
    repaint();
  }

  // app.js's in-flight keys for the two pulls this screen starts.
  function busy(key) {
    return typeof SB.busy === 'function' && SB.busy(key);
  }

  function pullKey(wsId, repoName) {
    return repoName ? 'pull:' + wsId + ':' + repoName : 'pull:' + wsId;
  }

  function message(err) {
    return String((err && err.message) || err || 'that did not work');
  }

  function repaint() {
    if (typeof SB.render === 'function') SB.render();
  }

  function refresh(wsId) {
    if (typeof SB.refresh === 'function') SB.refresh(wsId);
    else repaint();
  }

  function go(route) {
    if (typeof SB.go === 'function') SB.go(route);
  }

  // SB.pullMain / SB.start / SB.stop / SB.open are app.js's wrappers around the
  // bridge — they own the optimistic run state, the in-flight keys and the
  // re-scan. SB.act(key, fn) is for the one call app.js does not wrap.
  function act(key, fn) {
    var out;
    try { out = SB.act(key, fn); } catch (e) { return Promise.reject(e); }
    return (out && typeof out.then === 'function') ? out : Promise.resolve(out);
  }

  // ── state ─────────────────────────────────────────────────────────────────

  function current(state) {
    var id = state && state.route && state.route.wsId;
    if (!id) return null;
    var ws = state.byId && state.byId[id];
    if (ws) return ws;
    var list = (state && state.workspaces) || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }

  function runOf(state, wsId) {
    return (state && state.run && state.run[wsId]) || { wsId: wsId, status: 'idle', links: [] };
  }

  function scanned(ws) {
    // NOT Array.isArray(ws.repos): repos is [] from the first frame, so the array
    // test reports "scanned" before any git has run and the screen flashes
    // "nothing inside <ws> is a git repo" on every launch.
    return !!ws.scanned;
  }

  // Pull-request numbers are already on the repo: app.js asks sb.prSummary once
  // per scan and folds the answer into repo.pr. Asking again from here would be a
  // second `gh` round trip — the slowest call in the app — for what is already here.
  // When gh is unavailable the numbers are simply absent and the pills go inert;
  // gh's own sentence belongs on the Pull request screen, which is what runs it.
  function prMap(ws) {
    var map = {};
    var repos = scanned(ws) ? ws.repos : [];
    for (var i = 0; i < repos.length; i++) if (repos[i] && repos[i].pr) map[repos[i].name] = repos[i].pr;
    return map;
  }

  // ── header ────────────────────────────────────────────────────────────────

  // "4s", "12m", "1h 5m". No longer shown in the header, but exported below for the
  // Logs and Terminal footers ("exited 1 · 4s"), which read SB.views.workspace.dur.
  function dur(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm';
    var hours = Math.floor(m / 60);
    var rest = m % 60;
    return rest ? hours + 'h ' + rest + 'm' : hours + 'h';
  }

  // No sub line under the name: the user cut "main · clean" (2026-10-04) because it
  // only cost height above the segment. Nothing in it was the header's alone —
  // running and failed are the rail's dot and the Stop button, changes and behind
  // are the Changes tab, a missing dev script is the Changes tab's notice and the
  // greyed Start, and Publish names its own progress. A failed Publish is the one
  // thing said nowhere else, so that alone still gets a line.
  function publishError(ws, state) {
    if (!ws.self || !state.publish || state.publish.status !== 'error' || !state.publish.message) return null;
    return h('div.sub.sec', { role: 'status', 'aria-live': 'polite' }, state.publish.message);
  }

  function pullButton(ws) {
    var pulling = busy(pullKey(ws.id, null));
    var repos = scanned(ws) ? ws.repos : [];
    var mains = 0;
    for (var i = 0; i < repos.length; i++) if (repos[i].onMain && !repos[i].error) mains++;
    var off = pulling || !mains;

    return h('button.btn' + (off ? '.off' : ''), {
      type: 'button',
      disabled: off || null,
      title: mains ? 'Fast-forward every repo sitting on main' : 'nothing is sitting on main',
      onClick: function () { pull(ws, null); }
    }, pulling ? dom.spinner() : dom.icon('sync'), 'Pull main');
  }

  // Stop is deliberately NOT a primary button — the mock-up drops `pri` the moment
  // the workspace is running, and getting that backwards makes running look idle.
  function runButton(ws, run, state) {
    if (ws.self) {
      var publishing = state.publish && state.publish.status === 'publishing';
      var ready = state.publish && state.publish.status === 'ready';
      return h('button.btn.pri', {
        type: 'button',
        disabled: publishing || ready || null,
        title: ready ? 'Close Switchboard and reopen it to use the update' : 'Publish the latest changes to the desktop app',
        onClick: function () { SB.publish(ws.id); }
      }, publishing ? dom.spinner() : dom.icon('publish'), publishing ? 'Publishing…' : ready ? 'Published' : 'Publish');
    }
    if (run.status === 'running' || run.status === 'starting') {
      return h('button.btn', {
        type: 'button',
        title: 'Stop ' + ws.id,
        onClick: function () { stop(ws); }
      }, dom.icon('stop'), 'Stop');
    }
    var blocked = !startable(ws);
    return h('button.btn.pri' + (blocked ? '.off' : ''), {
      type: 'button',
      disabled: blocked || null,
      title: blocked ? 'no dev script in ' + ws.id : 'Start ' + ws.id,
      onClick: function () { start(ws); }
    }, dom.icon('play'), 'Start');
  }

  function segmented(items, active, onPick) {
    var box = h('div.seg');
    items.forEach(function (item) {
      box.appendChild(h('button' + (item.key === active ? '.on' : ''), {
        type: 'button',
        onClick: function () { if (item.key !== active) onPick(item.key); }
      }, item.label));
    });
    return box;
  }

  // The tabs that compose themselves from this header — views/logs.js,
  // views/terminal.js, views/editor.js and views/databases.js each borrow it and own
  // what is below it. A whitelist rather than a logs/else test: with more than two
  // tabs an else would print `Changes` selected while the Terminal is on screen.
  var HEADER_TABS = { changes: 1, logs: 1, terminal: 1, editor: 1, databases: 1 };

  function header(ws, state) {
    var run = runOf(state, ws.id);
    var want = state && state.route && state.route.tab;
    var tab = HEADER_TABS[want] ? want : 'changes';

    // The title is a shortcut to this workspace's Terminal — the tab the user lives in.
    // A button-like h1, no-drag so a click does not move the window (the region-order
    // trap from the rail toggle), and only worth showing as a link when not already
    // on that tab.
    var title = h('h1.jump', {
      title: 'Open the terminal for ' + ws.id,
      onClick: function () { go({ view: 'workspace', wsId: ws.id, tab: 'terminal' }); }
    }, ws.id);

    return h('div.hd',
      h('div.top', title, pullButton(ws), runButton(ws, run, state)),
      publishError(ws, state),
      segmented(
        [{ key: 'changes', label: 'Changes' }, { key: 'logs', label: 'Logs' },
          { key: 'terminal', label: 'Terminal' }, { key: 'editor', label: 'Editor' },
          { key: 'databases', label: 'Databases' }],
        tab,
        function (key) { go({ view: 'workspace', wsId: ws.id, tab: key }); }
      ));
  }

  // ── notices ───────────────────────────────────────────────────────────────

  // One full-width bar, one line, at most two actions — never a modal, never a
  // toast stack. `lead` is the workspace that owns the problem and navigates to it.
  function bar(n) {
    var el = h('div.bar' + (n.tone ? '.' + n.tone : ''));
    var line = h('span');
    if (n.lead) {
      // Underlined because it is the fastest way to go and look at the offender —
      // the same affordance app.js gives the workspace name in its own bars.
      line.appendChild(h('b', {
        style: 'text-decoration:underline',
        title: 'Open ' + n.lead.wsId,
        onClick: function () {
          if (typeof SB.select === 'function') SB.select(n.lead.wsId);
          else go({ view: 'workspace', wsId: n.lead.wsId, tab: 'changes' });
        }
      }, n.lead.label));
    }
    if (n.text) line.appendChild(dom.text(n.text));
    if (n.code) line.appendChild(h('code', null, n.code));
    if (n.tail) line.appendChild(dom.text(n.tail));
    el.appendChild(line);

    if (n.actions && n.actions.length) {
      el.appendChild(h('span.sp'));
      n.actions.forEach(function (a) {
        el.appendChild(h('button.btn', { type: 'button', onClick: a.onClick }, a.label));
      });
    }
    return el;
  }

  // A workspace is startable when it has a root dev script OR the config gives
  // it explicit processes (demo has no root package.json).
  function startable(ws) {
    return !!(ws.devCommand || (ws.processes && ws.processes.length));
  }

  function devScriptNotice(ws) {
    return {
      tone: 'err',
      text: 'no dev script in ' + ws.id,
      actions: [{
        label: 'Open folder',
        onClick: function () {
          act('editor:' + ws.id, function () { return window.sb.openInEditor(ws.dir); })
            .catch(function () { /* best effort, per §4.5 */ });
        }
      }]
    };
  }

  // ── actions ───────────────────────────────────────────────────────────────

  // A success bar has said what it had to say after a few seconds.
  function expire(wsId, notice) {
    setTimeout(function () {
      var u = uiFor(wsId);
      if (u.notice === notice) { u.notice = null; repaint(); }
    }, 6000);
  }

  function pull(ws, repoName) {
    if (busy(pullKey(ws.id, repoName))) return;
    setNotice(ws.id, null);
    SB.pullMain(ws.id, repoName || null)
      .then(function (res) { pulled(ws, repoName, res); })
      .catch(function (err) { pulled(ws, repoName, { ok: false, error: message(err), results: [] }); });
  }

  // git.js hands back one ready-to-read sentence per repo. A row cannot hold a
  // sentence, so the row shows the new state and the bar reports what happened.
  function pulled(ws, repoName, res) {
    var results = (res && res.results) || [];
    var failed = results.filter(function (r) { return !r.ok; });
    var again = { label: 'Retry', onClick: function () { pull(ws, repoName); } };
    var notice = null;

    if (failed.length) {
      notice = {
        tone: 'err',
        text: failed[0].repo + ' — ' + failed[0].message + (failed.length > 1 ? ' · ' + (failed.length - 1) + ' more failed' : ''),
        actions: [again]
      };
    } else if (res && res.ok === false) {
      notice = { tone: 'err', text: res.error || 'Pull main did not run.', actions: [again] };
    } else if (results.length === 1) {
      notice = { tone: 'ok', text: results[0].repo + ' — ' + results[0].message };
    } else if (results.length) {
      notice = { tone: 'ok', text: dom.plural(results.length, 'repo') + ' on main are up to date.' };
    }

    setNotice(ws.id, notice);
    if (notice && notice.tone === 'ok') expire(ws.id, notice);
  }

  function start(ws) {
    setNotice(ws.id, null);
    SB.start(ws.id)
      .then(function (res) { started(ws, res); })
      .catch(function (err) { setNotice(ws.id, { tone: 'err', text: message(err) }); });
  }

  // A conflict is an answer, not a failure: another copy of this project holds the
  // ports. Main never stops it implicitly — the two actions sit in the bar.
  function started(ws, res) {
    if (!res || res.ok !== false) return;
    var other = res.conflict && res.conflict.wsId;
    if (!other) {
      setNotice(ws.id, { tone: 'err', text: res.error || 'could not start ' + ws.id });
      return;
    }
    setNotice(ws.id, {
      tone: 'warn',
      lead: { label: other, wsId: other },
      text: ' is running — stop it and start this?',
      actions: [
        { label: 'Stop it and start here', onClick: function () { stopThenStart(other, ws); } },
        { label: 'Cancel', onClick: function () { setNotice(ws.id, null); } }
      ]
    });
  }

  function stopThenStart(other, ws) {
    setNotice(ws.id, null);
    SB.stop(other)
      .then(function (res) {
        if (res && res.ok === false) {
          setNotice(ws.id, { tone: 'err', text: 'could not stop ' + other + ' — ' + (res.error || 'it is still running') });
          return;
        }
        start(ws);
      })
      .catch(function (err) {
        setNotice(ws.id, { tone: 'err', text: 'could not stop ' + other + ' — ' + message(err) });
      });
  }

  function stop(ws) {
    SB.stop(ws.id).catch(function (err) { setNotice(ws.id, { tone: 'err', text: message(err) }); });
  }

  // ── repo row ──────────────────────────────────────────────────────────────

  function shortSha(sha) {
    return /^[0-9a-f]{7,}$/i.test(String(sha || '')) ? String(sha).slice(0, 7) : null;
  }

  function branchPill(ws, repo, prs) {
    if (repo.detached) {
      // The design's detached pill is the 7-char sha, so the row still says WHICH
      // commit. Repo.head carries it; 'HEAD' is the honest fallback when it does not.
      var sha = shortSha(repo.head);
      return dom.pill(sha || 'HEAD', {
        warn: true,
        title: sha ? 'HEAD is detached at ' + sha : 'HEAD is detached'
      });
    }
    var pr = prs[repo.name];
    // A long branch now ellipsises inside the pill (styles.css, .repo .pill .lbl),
    // so every pill carries the full branch in its title — that is where the
    // truncated half is recoverable.
    if (pr && pr.number) {
      return dom.pill(repo.branch, {
        number: pr.number,
        title: (repo.branch ? repo.branch + ' · ' : '') + 'pull request #' + pr.number,
        onClick: function () { go({ view: 'pr', wsId: ws.id, repo: repo.name, tab: 'overview' }); }
      });
    }
    return dom.pill(repo.branch || 'unknown', { title: repo.branch || repo.error || null });
  }

  function refreshButton(ws, repo, checking) {
    return h('button.ib' + (checking ? '.busy' : ''), {
      type: 'button',
      title: 'Pull main in ' + repo.name,
      'aria-label': 'Pull main in ' + repo.name,
      onClick: function () { pull(ws, repo.name); }
    }, dom.icon('sync'));
  }

  function summaryButton(ws, repo) {
    var n = (repo.files && repo.files.length) || 0;
    if (!n) return null;
    return h('button.sumb', {
      type: 'button',
      title: 'Files changed in ' + repo.name,
      onClick: function () { go({ view: 'files', wsId: ws.id, tab: 'files' }); }
    }, dom.plural(n, 'file') + ' ', dom.pm(repo.add, repo.del), h('span.cv', null, dom.icon('chev')));
  }

  // At most three words, lowercase — and only when the row has no summary button.
  function statePhrase(repo, checking) {
    if (checking) return h('span.sec', null, 'checking…');
    if (repo.error) return h('span.bad', { title: repo.error }, 'git failed');
    // The commit is named ONCE per row, by the amber pill beside this phrase
    // (design spec: pill `a41f3c9`, state slot `detached head`). Repeating the sha
    // here would print it twice on a row the user's rule keeps to one fact each.
    if (repo.detached) return h('span.warned', null, 'detached head');

    if (repo.onMain) {
      // behind === null means "no origin to compare against". 0 would read as
      // "in sync", which would be a lie.
      if (repo.behind === null || repo.behind === undefined) return h('span.sec', null, 'no origin');
      return h('span.sec', null, repo.behind > 0 ? repo.behind + ' behind' : 'up to date');
    }
    var bits = ['clean'];
    if (repo.ahead > 0) bits.push(repo.ahead + ' ahead');
    return h('span.sec', null, bits.join(' · '));
  }

  function linkButton(link) {
    return h('button.lk', {
      type: 'button',
      title: link.url,
      onClick: function () {
        SB.open(link.url).catch(function () { /* the browser refused; nothing to say in a row */ });
      }
      // .lbl so a long served host ellipsises inside the chip rather than pushing
      // itself past the window edge, where .bd{overflow-x:hidden} clips it away.
    }, h('span.lbl', null, link.label || link.url), dom.icon('ext'));
  }

  function linksFor(ws, run, repo, first) {
    var all = (run && Array.isArray(run.links) ? run.links : []).filter(function (l) { return l && l.url && l.live; });
    if (!all.length) return [];

    var mine = all.filter(function (l) { return l.repo === repo.name; });
    if (!first) return mine;

    // A link the config never pinned to a repo is the workspace's own address and
    // would otherwise be unreachable; it rides on the first row.
    var known = {};
    (ws.repos || []).forEach(function (r) { known[r.name] = true; });
    return mine.concat(all.filter(function (l) { return !l.repo || !known[l.repo]; }));
  }

  function repoRow(ws, repo, run, prs, first) {
    var checking = busy(pullKey(ws.id, repo.name));
    var row = h('div.repo' + (checking ? '.busy' : ''));

    // The workspace folder, when it is a repo too, is a row like the repos inside it; only
    // its tooltip says which one it is.
    var folder = repo.dirName || repo.name;
    row.appendChild(h('span.rn', { title: repo.root ? folder + ' — the workspace folder itself' : folder }, repo.name));
    row.appendChild(branchPill(ws, repo, prs));
    if (repo.onMain && !repo.error) row.appendChild(refreshButton(ws, repo, checking));

    var summary = summaryButton(ws, repo);
    if (summary) row.appendChild(summary);
    else {
      var phrase = statePhrase(repo, checking);
      if (phrase) row.appendChild(phrase);
    }

    var links = linksFor(ws, run, repo, first);
    if (links.length) {
      row.appendChild(h('span.sp'));
      links.forEach(function (link) { row.appendChild(linkButton(link)); });
    }
    return row;
  }

  // The folder names are not known before git is, so the scan shows rows of the
  // right shape with skeletons where the answers go; nothing jumps when they land.
  function skeletonRows(bd) {
    for (var i = 0; i < 3; i++) {
      bd.appendChild(h('div.repo',
        h('span.rn', null, h('span.sk.w3')),
        h('span.pill', null, dom.icon('branch'), h('span.sk.w2')),
        h('span.sk.w1')));
    }
  }

  // ── body ──────────────────────────────────────────────────────────────────

  function body(ws, state) {
    var bd = h('div.bd');
    var u = uiFor(ws.id);

    if (u.notice) bd.appendChild(bar(u.notice));
    // The bar asks for a dev script; the app itself is not meant to have one.
    if (scanned(ws) && !ws.self && !startable(ws)) bd.appendChild(bar(devScriptNotice(ws)));

    if (!scanned(ws)) { skeletonRows(bd); return bd; }

    if (ws.error && !ws.repos.length) {
      bd.appendChild(dom.errorBox(ws.error, { retry: function () { refresh(ws.id); } }));
      return bd;
    }
    if (!ws.repos.length) {
      // True of both shapes: a folder of repos with none, and a lone folder that is
      // not under git itself (Switchboard before its first `git init`).
      bd.appendChild(dom.empty('neither ' + ws.id + ' nor anything inside it is a git repo.', { title: 'no repos here' }));
      return bd;
    }

    var run = runOf(state, ws.id);
    var prs = prMap(ws);
    // The name column is 150px in the design, which fits every sample repo but
    // clips `example-customer-portal`. Widen it to the longest name in THIS
    // workspace so the branch pills still line up with each other.
    bd.style.setProperty('--repo-name', nameColumn(ws.repos) + 'px');
    ws.repos.forEach(function (repo, i) { bd.appendChild(repoRow(ws, repo, run, prs, i === 0)); });
    return bd;
  }

  var ruler = null;
  function nameColumn(repos) {
    if (!ruler) {
      ruler = document.createElement('canvas').getContext('2d');
      ruler.font = '600 13px -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif';
    }
    var widest = 0;
    for (var i = 0; i < repos.length; i++) {
      widest = Math.max(widest, ruler.measureText(repos[i].name || '').width);
    }
    return Math.min(260, Math.max(150, Math.ceil(widest) + 14));
  }

  function render(state) {
    // main is the flex column the design depends on; this wrapper is that column,
    // so .hd stays put and .bd is the only thing that scrolls.
    var view = h('div.view', { style: 'display:flex;flex-direction:column;flex:1;min-width:0;min-height:0' });
    var ws = current(state);

    if (!ws) {
      view.appendChild(h('div.hd'));
      view.appendChild(h('div.bd', dom.empty('pick one on the left.', { title: 'no workspace selected' })));
      return view;
    }

    view.appendChild(header(ws, state));
    view.appendChild(body(ws, state));
    return view;
  }

  SB.views.workspace = { render: render, header: header, changesBody: body, dur: dur };
})(window.SB);
