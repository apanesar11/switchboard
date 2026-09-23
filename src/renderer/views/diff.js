// SB.views.diff — one file's diff (mock-up 05).
//
//   breadcrumb  ‹ sample-2 › Files › src/services/pricing.ts
//   sub line    sample-api · TASK-352 · +9 −2
//   body        the unified diff inside a .diffwrap
//
// There is no segmented control on this screen: the header is .hd.tight and the body
// .bd.flush, exactly as the mock-up's inline styles specify. Esc and the breadcrumb
// are the way back.
window.SB = window.SB || {};

(function (SB) {
  'use strict';

  var D = SB.dom;
  var h = D.h;

  // ── talking to the main process ───────────────────────────────────────────
  // The same normalising as views/files.js, deliberately duplicated: a view exports
  // its render and nothing else, so neither file may reach into the other.

  var adopted = {};   // key -> true once we have attached to a promise
  var answers = {};   // key -> result, for a SB.load that keeps handing back the promise
  var bumps = {};     // base key -> Retry counter, so a retry asks a fresh key

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

  // app.js swaps ONE child into #main, but the stylesheet needs .hd and .bd to sit in
  // a column that fills the window (.bd is the only scroller). So the view's root has
  // to BE that column; these are exactly the declarations `main` itself carries.
  function column(hd, bd) {
    return h('div.view', { style: 'display:flex;flex-direction:column;flex:1;min-width:0;min-height:0' }, hd, bd);
  }

  function editorAction(repo) {
    if (!repo || !repo.dir) return null;
    return {
      label: 'Open in editor',
      onClick: function () { act('Open in editor', function () { return window.sb.openInEditor(repo.dir); }); }
    };
  }

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

  // ── screen ───────────────────────────────────────────────────────────────

  function findRepo(ws, name) {
    var found = null;
    ((ws && ws.repos) || []).forEach(function (r) {
      if (!found && (r.name === name || r.dirName === name)) found = r;
    });
    return found;
  }

  function findFile(repo, path) {
    var found = null;
    ((repo && repo.files) || []).forEach(function (f) { if (!found && f.path === path) found = f; });
    return found;
  }

  // 'sample-api · TASK-352 · +9 −2'. A file that is no longer in the scan (reverted
  // while it was open) simply drops its counts rather than claiming +0 −0.
  function subline(route, repo, file) {
    var parts = [];
    var name = (repo && repo.name) || route.repo;
    if (name) parts.push(name);
    var branch = repo && (repo.branch || (repo.detached ? 'detached' : null));
    if (branch) parts.push(branch);
    var out = [];
    if (parts.length) out.push(parts.join(' · '));
    if (file && file.binary) out.push((out.length ? ' · ' : '') + 'binary');
    else if (file) {
      if (out.length) out.push(' · ');
      out.push(D.pm(file.add, file.del));
    }
    return out;
  }

  function header(route, repo, file) {
    var wsId = route.wsId;
    return h('div.hd.tight', null,
      D.crumb([
        { label: wsId || 'workspace', onClick: function () { go({ view: 'workspace', wsId: wsId, tab: 'terminal' }); } },
        { label: 'Files', onClick: function () { go({ view: 'files', wsId: wsId, tab: 'files' }); } },
        { label: route.path || '', mono: true }
      ]),
      h('div.sub.sec', null, subline(route, repo, file))
    );
  }

  function render(state) {
    var route = (state && state.route) || {};
    var ws = (state && state.byId && state.byId[route.wsId]) || null;
    var repo = findRepo(ws, route.repo);
    var file = findFile(repo, route.path);
    var bd = h('div.bd.flush');

    if (!route.path || !route.repo) {
      bd.appendChild(D.empty('pick a file on the Files screen to see its diff.', { title: 'no file to show' }));
      return column(header(route, repo, file), bd);
    }

    // app.js marks every load key containing the workspace id stale after a re-scan,
    // so the key stays stable and the old diff stays on screen while it revalidates.
    var base = 'diff:file:' + route.wsId + '|' + route.repo + '|' + route.path;

    // A repo git could not read has no diff worth asking for — the reason goes in the
    // bar at the top, once, and the card says why it is empty.
    var body;
    if (repo && repo.error) {
      bd.appendChild(D.errorBox(repo.error));
      body = note(null, 'no diff while this repo cannot be read', [editorAction(repo)]);
    } else {
      body = diffBody(load(base, function () {
        return window.sb.fileDiff(route.wsId, route.repo, route.path);
      }), repo, base);
    }

    bd.appendChild(h('div.diffwrap', null, body));
    return column(header(route, repo, file), bd);
  }

  SB.views = SB.views || {};
  SB.views.diff = { render: render };
})(window.SB);
