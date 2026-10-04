// SB.views.diagrams — the Diagrams tab (§4.17, R15): a workspace's flow diagrams, in
// the admin's Flow editor, with ✦ Answer asking Claude Code, Codex, the Claude API or
// the OpenAI API (§4.18).
//
//   SB.views.diagrams.render(state)   the whole <main> column for {tab:'diagrams'}
//   SB.views.diagrams.shown(route)    app.js, on every render: is the tab on screen?
//   SB.views.diagrams.onKey / editAction / refresh / flushAll
//
// The editor itself is the React bundle (src/diagrams, built into diagrams/diagrams.js
// by scripts/build-diagrams.js), which sets window.SBDiagrams. This file is the seam:
// it gives the bundle a slab to live in, tells it which workspace is on screen and
// whether it is showing at all, and hands it what reaches the app rather than the page
// — Edit ▸ Undo / Redo / Paste, Esc's first say, the quit flush.
//
// Like the Editor and Notes (§6 R13, R14), render() hands back the SAME root element
// every time and rebuilds only the header: app.js re-renders the column for a run
// state, a bell or a usage poll, and a rebuilt column would tear a live React Flow
// canvas out of the page mid-drag. ONE root for every workspace — the bundle keys its
// page by workspace, so switching workspaces opens that workspace's diagrams, and the
// editor being left writes what it holds as it goes.
window.SB = window.SB || {};
SB.views = SB.views || {};

(function (SB) {
  'use strict';

  var D = SB.dom;
  var h = D.h;

  var view = null;          // { root, hd, body, slab, mounted, wsId }
  var told = 0;             // the dirty count main last heard

  function route() {
    return (SB.state && SB.state.route) || {};
  }

  function onTab(r) {
    return !!r && r.view === 'workspace' && r.tab === 'diagrams' && !!r.wsId && String(r.wsId).charAt(0) !== '/';
  }

  function bundle() {
    return window.SBDiagrams || null;
  }

  function reportDirty(count) {
    var n = count > 0 ? 1 : 0;
    if (n === told) return;
    told = n;
    var api = window.sb;
    if (api && typeof api.diagramsDirty === 'function') {
      try { Promise.resolve(api.diagramsDirty(n))['catch'](function () {}); } catch (e) { /* bridge gone */ }
    }
  }

  function build() {
    var slab = h('div.dgslab');
    var body = h('div.bd.pane.dgbd', null, slab);
    var root = h('div.view.dgview', {
      style: 'display:flex;flex-direction:column;flex:1;min-width:0;min-height:0',
    }, body);
    view = { root: root, hd: null, body: body, slab: slab, mounted: false, wsId: null };
    return view;
  }

  // The bundle is mounted once, on the first visit, and lives for the window's life.
  function ensureMounted(v, ws) {
    if (v.mounted) return true;
    var b = bundle();
    if (!b) {
      if (!v.slab.firstChild) {
        v.slab.classList.add('blank');
        v.slab.appendChild(D.empty('run npm run build:diagrams in the switchboard checkout, then reopen it.',
          { title: 'the diagram editor is not built' }));
      }
      return false;
    }
    v.mounted = true;
    v.wsId = ws.id;
    try {
      b.mount(v.slab, {
        wsId: ws.id,
        wsName: ws.id,
        active: true,
        onOpenSettings: function () { if (typeof SB.go === 'function') SB.go({ view: 'settings' }); },
        onOpenTerminal: function (wsId) {
          if (typeof SB.go === 'function') SB.go({ view: 'workspace', wsId: wsId, tab: 'terminal' });
        },
        onDirty: reportDirty,
      });
    } catch (err) {
      console.error('[switchboard] diagrams: mount:', err);
      v.mounted = false;
      return false;
    }
    return true;
  }

  // ── header ────────────────────────────────────────────────────────────────

  function pathTo(root, el) {
    if (!el || el === root || !root.contains(el)) return null;
    var path = [];
    while (el && el !== root) {
      var parent = el.parentNode;
      if (!parent || !parent.children) return null;
      path.unshift(Array.prototype.indexOf.call(parent.children, el));
      el = parent;
    }
    return path;
  }

  function swapHeader(v, ws, state) {
    var hd;
    try {
      hd = SB.views.workspace.header(ws, state);
    } catch (err) {
      console.error('[switchboard] diagrams: header:', err);
      hd = h('div.hd');
    }
    var path = null;
    if (v.hd && v.hd.parentNode === v.root) {
      path = pathTo(v.hd, document.activeElement);
      v.root.replaceChild(hd, v.hd);
    } else {
      v.root.insertBefore(hd, v.root.firstChild);
    }
    v.hd = hd;
    if (!path) return;
    var el = hd;
    for (var i = 0; i < path.length && el; i++) el = el.children[path[i]];
    if (el && el !== hd && typeof el.focus === 'function') {
      try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    }
  }

  // ── render ────────────────────────────────────────────────────────────────

  function render(state) {
    var r = (state && state.route) || {};
    var wsId = r.wsId;
    if (!onTab(r)) {
      return h('div.view', { style: 'display:flex;flex-direction:column;flex:1;min-width:0;min-height:0' },
        h('div.hd'), h('div.bd', null, D.empty('pick one on the left.', { title: 'no workspace selected' })));
    }
    var ws = (state.byId || {})[wsId] || { id: wsId };
    var v = view || build();
    swapHeader(v, ws, state);
    if (ensureMounted(v, ws) && v.wsId !== ws.id) {
      v.wsId = ws.id;
    }
    shown(r);
    return v.root;
  }

  /**
   * app.js calls this from renderMain() on every render, wherever it lands: the bundle
   * has to know the moment its tab is no longer the screen, because its tree stays
   * mounted behind whatever is — and a key meant for the Terminal must never reach a
   * canvas nobody can see (Backspace deleting the boxes selected there, for one).
   */
  function shown(r) {
    var b = bundle();
    if (!view || !view.mounted || !b) return;
    var on = onTab(r || route());
    try {
      if (on) b.update({ wsId: r.wsId, wsName: r.wsId, active: true });
      else b.update({ active: false });
    } catch (err) {
      console.error('[switchboard] diagrams: update:', err);
    }
  }

  // ── what the rest of the app asks ─────────────────────────────────────────

  function onScreen() {
    return !!view && view.mounted && view.root.isConnected && onTab(route());
  }

  /**
   * app.js's window keydown, before its own Esc (back) and ⌘↵ (Start). Esc leaves a
   * full-screen diagram first; ⌘↵ on the canvas is ✦ Answer, which the editor's own
   * listener takes — so here it only has to keep Start from having it too.
   */
  function onKey(e) {
    if (!onScreen()) return false;
    var b = bundle();
    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (b && b.fullscreen()) { b.leaveFullscreen(); return true; }
      return false;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      var t = e.target;
      return t === document.body || (!!t && view.slab.contains(t));
    }
    return false;
  }

  /** app.js's handleEdit, after the terminal's turn: the Edit menu over the canvas. */
  function editAction(action, text, image) {
    if (!onScreen()) return false;
    var b = bundle();
    if (!b) return false;
    var active = document.activeElement;
    // Only while the canvas has the keyboard: the slab, or nowhere in particular.
    if (active && active !== document.body && !view.slab.contains(active)) return false;
    try {
      var out = b.editAction(action, !!image);
      return !!out;
    } catch (err) {
      console.error('[switchboard] diagrams: edit:', err);
      return false;
    }
  }

  /** handleFocus: a CLI may have been installed, or signed in to, while we were away. */
  function refresh() {
    var b = bundle();
    if (b && view && view.mounted) {
      try { b.refreshAnswers(false); } catch (err) { /* the menu asks again when it opens */ }
    }
  }

  /** The window losing focus, and main's quit flush (views/notes.js onFlush). */
  function flushAll() {
    var b = bundle();
    if (!b || !view || !view.mounted) return Promise.resolve();
    try { return Promise.resolve(b.flush()); } catch (err) { return Promise.resolve(); }
  }

  window.addEventListener('blur', function () { flushAll(); });

  SB.views.diagrams = {
    render: render,
    shown: shown,
    onKey: onKey,
    editAction: editAction,
    refresh: refresh,
    flushAll: flushAll,
  };
})(window.SB);
