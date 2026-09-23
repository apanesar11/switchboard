// SB.views.files — the Files screen (mock-up 04) and its All diffs tab (06).
//
//   Files      breadcrumb, `6 files changed · +131 −24`, Files|All diffs, then the
//              changed files grouped under a repo heading. A row opens the Diff screen.
//   All diffs  the same header, then one .dfile card per changed file in the whole
//              workspace — repo prefix in the header, the diff from SB.diffview.
//
// The rows are painted from SB.state the moment the screen opens; the patches for
// All diffs arrive later through SB.load and fill the cards in.
window.SB = window.SB || {};

(function (SB) {
  'use strict';

  var D = SB.dom;
  var h = D.h;

  var CARD_LIMIT = 200;      // a stray build directory must not freeze the renderer
  var LINE_BUDGET = 20000;   // diff lines built per render; the rest of the cards start folded

  // ── talking to the main process ───────────────────────────────────────────
  // app.js owns the memo table behind SB.load; everything here does is normalise
  // what comes back — a result, a wrapper, a promise, or nothing yet — into either
  // null (still in flight) or an IPC result value, and make sure no rejection ever
  // escapes. Main answers { ok:false, error } instead of throwing, so an exception
  // on this side means the bridge itself is missing.

  var adopted = {};   // key -> true once we have attached to a promise
  var answers = {};   // key -> result, for a SB.load that keeps handing back the promise
  var bumps = {};     // base key -> Retry counter, so a retry asks a fresh key
  var folded = {};    // card id -> the user's own fold choice; absent means "the default"

  function message(e) {
    if (!e) return 'something went wrong.';
    if (typeof e === 'string') return e;
    return String(e.message || e);
  }

  function guarded(fn) {
    return function () {
      var p;
      try { p = fn(); } catch (e) { return Promise.resolve({ ok: false, error: message(e) }); }
      return Promise.resolve(p).then(
        function (r) {
          return r && typeof r === 'object' ? r : { ok: false, error: 'the main process sent no answer.' };
        },
        function (e) { return { ok: false, error: message(e) }; }
      );
    };
  }

  // app.js hands back a load entry: { status:'loading'|'ok'|'error', value, error }.
  // An entry revalidating on top of good data goes back to 'loading' while KEEPING
  // its value — show that rather than flash a spinner over a diff already on screen.
  function unwrap(v) {
    if (v === null || v === undefined || typeof v !== 'object') return null;
    if (typeof v.then === 'function') return null;
    if ('ok' in v) return v;
    var st = v.status || v.state;
    if (st === 'error') return { ok: false, error: message(v.error || (v.value && v.value.error)) };
    if (st === 'loading' || st === 'pending' || v.pending === true || v.loading === true) {
      return v.value ? unwrap(v.value) : null;
    }
    if ('value' in v) return unwrap(v.value);
    if ('data' in v) return unwrap(v.data);
    if ('result' in v) return unwrap(v.result);
    if (v.error) return { ok: false, error: message(v.error) };
    return null;
  }

  function repaint() {
    if (typeof SB.render === 'function') { try { SB.render(); } catch (e) { /* app.js repaints */ } }
  }

  function adopt(key, p) {
    if (adopted[key]) return;
    adopted[key] = true;
    p.then(function (r) {
      answers[key] = unwrap(r) || { ok: false, error: 'the diff could not be read.' };
      repaint();
    }, function (e) {
      answers[key] = { ok: false, error: message(e) };
      repaint();
    });
  }

  // null means "still coming"; anything else is an IPC result.
  function load(base, fn) {
    var key = base + '#' + (bumps[base] || 0);
    if (answers[key]) return answers[key];
    var v = null;
    if (typeof SB.load === 'function') {
      try { v = SB.load(key, guarded(fn)); } catch (e) { return { ok: false, error: message(e) }; }
    } else if (!adopted[key]) {
      v = guarded(fn)();
    }
    if (v && typeof v.then === 'function') { adopt(key, v); return null; }
    return unwrap(v);
  }

  // SB.invalidate marks the entry stale so the next render re-runs the same key.
  // The counter is the fallback for an app.js without it: a new key is a new load.
  function retry(base) {
    return function () {
      if (typeof SB.invalidate === 'function') SB.invalidate(base);
      else bumps[base] = (bumps[base] || 0) + 1;
      repaint();
    };
  }

  // app.js owns the busy/error plumbing for actions; fall back to the bridge when it
  // is not there. Either way the promise is swallowed — errors are values.
  function act(label, fn) {
    var f = guarded(fn);
    if (typeof SB.act === 'function') {
      try { return SB.act.length >= 2 ? SB.act(label, f) : SB.act(f); } catch (e) { /* fall through */ }
    }
    f();
  }

  function go(route) {
    if (typeof SB.go === 'function') SB.go(route);
  }

  // ── little shapes ────────────────────────────────────────────────────────

  function num(v) { var n = Number(v); return isFinite(n) && n > 0 ? Math.round(n) : 0; }

  function commas(n) { return String(num(n)).replace(/\B(?=(\d{3})+$)/g, ','); }

  function lineCount(patch) {
    var s = String(patch || '');
    if (!s) return 0;
    var n = s.split('\n').length;
    return s.charAt(s.length - 1) === '\n' ? n - 1 : n;
  }

  function ckey(repo, path) { return String(repo) + '\u0000' + String(path); }

  // app.js swaps ONE child into #main, but the stylesheet needs .hd and .bd to sit in
  // a column that fills the window (.bd is the only scroller). So the view's root has
  // to BE that column; these are exactly the declarations `main` itself carries.
  function column(hd, bd) {
    return h('div.view', { style: 'display:flex;flex-direction:column;flex:1;min-width:0;min-height:0' }, hd, bd);
  }

  var STATUS = {
    M: { letter: 'M', cls: 'M', hint: 'modified' },
    A: { letter: 'A', cls: 'A', hint: 'added' },
    D: { letter: 'D', cls: 'D', hint: 'deleted' },
    R: { letter: 'R', cls: 'R', hint: 'renamed' },
    // ARCHITECTURE §2: untracked carries status '?' and RENDERS as 'A' — it is a
    // whole-file add. The hint is where the distinction stays available.
    '?': { letter: 'A', cls: 'A', hint: 'untracked' }
  };

  function badge(f) {
    var s = STATUS[f.status];
    if (!s) s = { letter: String(f.status || '?').charAt(0) || '?', cls: 'Q', hint: 'changed' };
    return h('span.st.' + s.cls, { title: s.hint }, s.letter);
  }

  function pathTitle(f) {
    return f.oldPath ? f.oldPath + ' → ' + f.path : String(f.path || '');
  }

  // <span class="p mono">[repo / ]<span class="dir">src/services/</span><span class="base">pricing.ts</span></span>
  // The directory half ellipsises, the filename never does. `.p` is a flex box, which
  // TRIMS a trailing space inside a flex item — so the gap after the repo prefix has
  // to be a non-breaking space or "sample-api /prisma/schema.prisma" is what renders.
  function pathSpan(path, prefix) {
    var p = D.elide(path);
    return h('span.p.mono', null,
      prefix ? h('span.rp', null, prefix + ' /\u00a0') : null,
      h('span.dir', null, p.dir),
      h('span.base', null, p.base));
  }

  function branchPill(repo) {
    var label = repo.branch || (repo.detached ? 'detached' : 'no branch');
    // The Files-screen pill carries the branch only — never the #PR number.
    return D.pill(label, { warn: !!repo.detached, title: repo.detached ? 'detached head' : null });
  }

  function editorAction(repo) {
    if (!repo || !repo.dir) return null;
    return {
      label: 'Open in editor',
      onClick: function () { act('Open in editor', function () { return window.sb.openInEditor(repo.dir); }); }
    };
  }

  // A .note row inside a .diff, which is how a card says "binary", "too large" or why
  // it is empty without breaking out of the diff card's shape.
  function note(glyph, text, actions) {
    var row = h('div.note', null, glyph, text);
    var list = (actions || []).filter(Boolean);
    if (list.length) row.appendChild(h('span.sp'));
    list.forEach(function (a) {
      row.appendChild(h('button.btn.sm', { type: 'button', onClick: a.onClick }, a.label));
    });
    return h('div.diff', null, row);
  }

  // SB.diffview owns the diff body, including the "diff truncated" footer for a patch
  // main capped at 2000 lines — the lines it did send are still worth reading, so they
  // are rendered rather than hidden behind a button.
  function diffNode(patch, truncated) {
    var node = null;
    try {
      if (SB.diffview && typeof SB.diffview.render === 'function') {
        node = SB.diffview.render(patch, { truncated: !!truncated });
      }
    } catch (e) { node = null; }
    if (!node) return note(null, 'this diff could not be rendered.');
    if (node.nodeType === 1 && node.classList && node.classList.contains('diff')) return node;
    return h('div.diff', null, node);   // a fragment, or a bare run of line divs
  }

  // info is the per-file IPC payload ({patch, binary, truncated} or {ok:false, error}),
  // or null while it is still on its way.
  function diffBody(info, repo, base) {
    if (info === null) return note(D.spinner(), 'reading the diff…');
    if (info.ok === false) {
      return note(null, info.error || 'the diff could not be read.',
        [{ label: 'Retry', onClick: retry(base) }, editorAction(repo)]);
    }
    if (info.binary) return note(null, 'binary file', [editorAction(repo)]);
    var patch = typeof info.patch === 'string' ? info.patch : '';
    if (!patch) return note(null, 'no changes left in this file', [editorAction(repo)]);
    return diffNode(patch, info.truncated);
  }

  // ── the file list ────────────────────────────────────────────────────────

  function changedFiles(repo) {
    var list = (repo && repo.files) || [];
    return list.slice().sort(function (a, b) {
      return String(a.path).localeCompare(String(b.path));
    });
  }

  function totals(ws) {
    if (ws && ws.scanned) {
      var t = { files: 0, add: 0, del: 0, known: true };
      ws.repos.forEach(function (repo) {
        changedFiles(repo).forEach(function (f) {
          t.files++; t.add += num(f.add); t.del += num(f.del);
        });
      });
      return t;
    }
    if (ws && typeof ws.files === 'number') {
      return { files: num(ws.files), add: num(ws.add), del: num(ws.del), known: true };
    }
    return { files: 0, add: 0, del: 0, known: false };
  }

  function subline(t) {
    if (!t.known) return 'scanning…';
    if (!t.files) return 'no files changed';
    return [D.plural(t.files, 'file') + ' changed · ', D.pm(t.add, t.del)];
  }

  function tab(route) { return route.tab === 'all' ? 'all' : 'files'; }

  function header(route, t) {
    var wsId = route.wsId;
    var current = tab(route);
    function segButton(label, name) {
      return h('button' + (current === name ? '.on' : ''), {
        type: 'button',
        onClick: function () { go({ view: 'files', wsId: wsId, tab: name }); }
      }, label);
    }
    return h('div.hd', null,
      D.crumb([
        { label: wsId || 'workspace', onClick: function () { go({ view: 'workspace', wsId: wsId, tab: 'terminal' }); } },
        { label: 'Files' }
      ]),
      h('div.sub.sec', null, subline(t)),
      h('div.seg', null, segButton('Files', 'files'), segButton('All diffs', 'all'))
    );
  }

  function groupHeading(repo) {
    return h('div.fsec', null, h('span.rn', null, repo.name || repo.dirName || 'repo'), branchPill(repo));
  }

  function fileRow(wsId, repo, f) {
    return h('button.fr', {
      type: 'button',
      title: pathTitle(f),
      onClick: function () { go({ view: 'diff', wsId: wsId, repo: repo.name || repo.dirName, path: f.path }); }
    },
      badge(f),
      pathSpan(f.path, null),
      f.binary ? h('span.n.mono.sec', null, 'binary') : h('span.n.mono', null, D.pm(f.add, f.del)),
      D.blocks(f.binary ? 0 : f.add, f.binary ? 0 : f.del),
      h('span.cv', null, D.icon('chev'))
    );
  }

  function nothingChanged(wsId) {
    return D.empty('every repo in ' + (wsId || 'this workspace') + ' matches its last commit.',
      { title: 'nothing changed here yet' });
  }

  function filesBody(route, ws) {
    var bd = h('div.bd');
    if (!ws || !ws.scanned) return bd;          // the header already reads "scanning…"
    var any = false;
    ws.repos.forEach(function (repo) {
      var files = changedFiles(repo);
      if (!files.length && !repo.error) return;
      any = true;
      bd.appendChild(groupHeading(repo));
      if (repo.error) bd.appendChild(D.errorBox(repo.error));
      files.forEach(function (f) { bd.appendChild(fileRow(route.wsId, repo, f)); });
    });
    if (!any) bd.appendChild(nothingChanged(route.wsId));
    return bd;
  }

  // ── All diffs ────────────────────────────────────────────────────────────

  // `foldByDefault` is the screen's opinion (the render budget is spent, or the whole
  // fetch failed); folded[id] is the user's, and the user's always wins — otherwise a
  // card the budget folded could never be opened.
  function card(wsId, repo, repoName, f, info, base, foldByDefault) {
    var id = wsId + '|' + repoName + '|' + f.path;
    var open = folded[id] === undefined ? !foldByDefault : !folded[id];
    var binary = !!(f.binary || (info && info.binary));
    var add = f.add !== undefined ? f.add : (info && info.add);
    var del = f.del !== undefined ? f.del : (info && info.del);
    // A <button> still shrink-to-fits with width:auto even when it is display:flex, so
    // the 40px header band would stop after the counts instead of spanning the card.
    var head = h('button.fh', {
      type: 'button',
      style: 'width:100%',
      title: pathTitle(f),
      onClick: function () { folded[id] = open; repaint(); }
    },
      h('span.cv', null, D.icon('chev')),
      pathSpan(f.path, repoName),
      binary ? h('span.mono.sec', null, 'binary') : h('span.mono', null, D.pm(add, del))
    );
    // A folded card does not build its diff at all; unfolding re-renders and builds it.
    return h('div.dfile' + (open ? '' : '.folded'), null, head,
      open ? diffBody(info, repo, base) : h('div.diff'));
  }

  function repoByName(ws, name) {
    var found = null;
    ((ws && ws.scanned && ws.repos) || []).forEach(function (r) {
      if (!found && (r.name === name || r.dirName === name)) found = r;
    });
    return found;
  }

  function allBody(route, ws) {
    var bd = h('div.bd');
    var wsId = route.wsId;
    // app.js marks every load key containing the workspace id stale after a re-scan,
    // so the key stays stable and the old diff stays on screen while it revalidates.
    var base = 'diff:all:' + wsId;
    var res = load(base, function () { return window.sb.allDiffs(wsId); });

    var patches = {};
    if (res && res.ok && Array.isArray(res.files)) {
      res.files.forEach(function (f) { patches[ckey(f.repo, f.path)] = f; });
    }
    if (res && res.ok === false) {
      bd.appendChild(D.errorBox(res.error || 'the diffs could not be read.', { retry: retry(base) }));
    }

    // sb:diff:all answers ok:true with a per-repo `errors` list when only some repos
    // failed. Without this a repo git could not read would show every one of its files
    // as "no changes left" — a lie. Its cards carry the sentence instead.
    var repoErrors = {};
    if (res && res.ok && Array.isArray(res.errors)) {
      res.errors.forEach(function (e) {
        if (e && e.repo) repoErrors[e.repo] = e.error || 'the diff could not be read.';
      });
    }

    // When the whole fetch failed the bar above says so once; the cards below stay
    // folded to their 40px headers rather than repeating the sentence per file.
    var failed = !!(res && res.ok === false);

    // Two reasons a card starts folded on this screen. A file main had to truncate is
    // thousands of lines that would bury every other file on the page — the header
    // still says +4182 −0, and one click opens it. And building every line of a
    // workspace-wide diff can be tens of thousands of nodes, so once the budget is
    // spent the rest of the list costs one 40px header each until it is opened.
    var budget = LINE_BUDGET;
    function spend(info) {
      if (failed) return true;
      if (info && info.truncated) return true;
      if (budget <= 0) return true;
      if (info && typeof info.patch === 'string') budget -= lineCount(info.patch);
      return false;
    }

    var cards = [], seen = {};
    ((ws && ws.scanned && ws.repos) || []).forEach(function (repo) {
      var name = repo.name || repo.dirName;
      var trouble = repo.error || repoErrors[name] || null;
      if (trouble) cards.push([groupHeading(repo), D.errorBox(trouble)]);
      changedFiles(repo).forEach(function (f) {
        seen[ckey(name, f.path)] = true;
        var info = patches[ckey(name, f.path)] || null;
        if (!info && trouble) info = { ok: false, error: trouble };
        // In the answer but not in this file: it was reverted since the scan.
        else if (!info && res && res.ok) info = { ok: true, patch: '' };
        else if (!info && failed) info = res;
        cards.push([card(wsId, repo, name, f, info, base, trouble ? true : spend(info))]);
      });
    });
    // Anything the response knows about that the last scan did not — the patches are
    // the newer truth, so show those files rather than pretend they are not there.
    if (res && res.ok && Array.isArray(res.files)) {
      res.files.forEach(function (f) {
        if (seen[ckey(f.repo, f.path)]) return;
        cards.push([card(wsId, repoByName(ws, f.repo), f.repo, f, f, base, spend(f))]);
      });
    }

    var extra = cards.length - CARD_LIMIT;
    cards.slice(0, CARD_LIMIT).forEach(function (group) {
      group.forEach(function (node) { bd.appendChild(node); });
    });
    if (extra > 0) {
      bd.appendChild(h('div.bar', null, h('span', null,
        'showing the first ' + commas(CARD_LIMIT) + ' files · ' + commas(extra) + ' more not shown')));
    }
    if (!cards.length && ((ws && ws.scanned) || (res && res.ok))) bd.appendChild(nothingChanged(wsId));
    return bd;
  }

  // ── screen ───────────────────────────────────────────────────────────────

  function render(state) {
    var route = (state && state.route) || {};
    var ws = (state && state.byId && state.byId[route.wsId]) || null;
    var t = totals(ws);
    var bd = tab(route) === 'all' ? allBody(route, ws) : filesBody(route, ws);
    return column(header(route, t), bd);
  }

  SB.views = SB.views || {};
  SB.views.files = { render: render };
})(window.SB);
