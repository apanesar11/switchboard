// The Diagrams tab and Grid's diagram squares share one live React canvas per
// workspace. A canvas moves between its two hosts; neither an app re-render nor a
// switch between Grid and workspace tabs unmounts it.
window.SB = window.SB || {};
SB.views = SB.views || {};

(function (SB) {
  'use strict';

  var D = SB.dom;
  var h = D.h;
  var view = null;             // persistent workspace-tab chrome
  var canvases = Object.create(null); // wsId -> { slab, api, active, dirty, home, fullscreen }
  var activeGrid = null;       // only one Grid canvas may own window shortcuts
  var told = 0;

  function route() { return (SB.state && SB.state.route) || {}; }
  function onTab(r) {
    return !!r && r.view === 'workspace' && r.tab === 'diagrams' && !!r.wsId && String(r.wsId).charAt(0) !== '/';
  }
  function bundle() { return window.SBDiagrams || null; }

  function reportDirty(wsId, count) {
    if (canvases[wsId]) canvases[wsId].dirty = count > 0;
    var n = Object.keys(canvases).some(function (id) { return canvases[id].dirty; }) ? 1 : 0;
    if (n === told) return;
    told = n;
    var bridge = window.sb;
    if (bridge && typeof bridge.diagramsDirty === 'function') {
      try { Promise.resolve(bridge.diagramsDirty(n))['catch'](function () {}); } catch (e) { /* bridge gone */ }
    }
  }

  function hostFullscreen(item, open) {
    if (open === item.fullscreen) return;
    item.fullscreen = open;
    if (open) {
      item.home = item.slab.parentNode || item.home;
      document.body.appendChild(item.slab);
      Object.assign(item.slab.style, {
        position: 'fixed', inset: '0', zIndex: '1000', margin: '0',
        borderRadius: '0', overflow: 'visible',
      });
    } else {
      item.slab.style.position = '';
      item.slab.style.inset = '';
      item.slab.style.zIndex = '';
      item.slab.style.margin = '';
      item.slab.style.borderRadius = '';
      item.slab.style.overflow = '';
      if (item.home) item.home.appendChild(item.slab);
    }
  }

  function makeCanvas(wsId) {
    if (canvases[wsId]) return canvases[wsId];
    var slab = h('div.dgslab');
    var item = { slab: slab, api: null, active: false, dirty: false, home: null, fullscreen: false };
    canvases[wsId] = item;
    var b = bundle();
    if (!b || typeof b.create !== 'function') {
      slab.classList.add('blank');
      slab.appendChild(D.empty('run npm run build:diagrams in the switchboard checkout, then reopen it.',
        { title: 'the diagram editor is not built' }));
      return item;
    }
    try {
      item.api = b.create(slab, {
        wsId: wsId,
        wsName: wsId,
        active: false,
        onOpenSettings: function () { if (typeof SB.go === 'function') SB.go({ view: 'settings' }); },
        onOpenTerminal: function (id) {
          if (typeof SB.go === 'function') SB.go({ view: 'workspace', wsId: id, tab: 'terminal' });
        },
        onDirty: function (count) { reportDirty(wsId, count); },
        onFullscreenChange: function (open) { hostFullscreen(item, open); },
      });
    } catch (err) {
      console.error('[switchboard] diagrams: mount:', err);
    }
    return item;
  }

  function build() {
    var body = h('div.bd.pane.dgbd');
    var root = h('div.view.dgview', {
      style: 'display:flex;flex-direction:column;flex:1;min-width:0;min-height:0',
    }, body);
    view = { root: root, hd: null, body: body };
    return view;
  }

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
    try { hd = SB.views.workspace.header(ws, state); }
    catch (err) { console.error('[switchboard] diagrams: header:', err); hd = h('div.hd'); }
    var path = null;
    if (v.hd && v.hd.parentNode === v.root) {
      path = pathTo(v.hd, document.activeElement);
      v.root.replaceChild(hd, v.hd);
    } else v.root.insertBefore(hd, v.root.firstChild);
    v.hd = hd;
    if (!path) return;
    var el = hd;
    for (var i = 0; i < path.length && el; i++) el = el.children[path[i]];
    if (el && el !== hd && typeof el.focus === 'function') {
      try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    }
  }

  function render(state) {
    var r = (state && state.route) || {};
    if (!onTab(r)) {
      return h('div.view', { style: 'display:flex;flex-direction:column;flex:1;min-width:0;min-height:0' },
        h('div.hd'), h('div.bd', null, D.empty('pick one on the left.', { title: 'no workspace selected' })));
    }
    var ws = (state.byId || {})[r.wsId] || { id: r.wsId };
    var v = view || build();
    swapHeader(v, ws, state);
    var item = makeCanvas(ws.id);
    item.home = v.body;
    if (item.fullscreen) v.body.replaceChildren();
    else if (item.slab.parentNode !== v.body) v.body.replaceChildren(item.slab);
    return v.root;
  }

  // Grid builds a fresh cell tree on each render. Moving this existing slab into
  // the new cell preserves React Flow's editor and its autosave state.
  function mountGrid(wsId, cell) {
    if (!wsId || !cell || String(wsId).charAt(0) === '/') return false;
    var item = makeCanvas(wsId);
    item.home = cell;
    if (!item.fullscreen) cell.appendChild(item.slab);
    return true;
  }

  function activeCanvas(r) {
    if (onTab(r)) {
      var tab = canvases[r.wsId];
      return tab && tab.slab.isConnected && view && tab.home === view.body && view.root.isConnected ? tab : null;
    }
    if (r.view === 'grid' && activeGrid) {
      var grid = canvases[activeGrid];
      return grid && grid.slab.isConnected && grid.home && grid.home.isConnected &&
        grid.home.closest('.gridbd') ? grid : null;
    }
    return null;
  }

  function shown(r) {
    r = r || route();
    if (r.view !== 'grid') activeGrid = null;
    var current = activeCanvas(r);
    Object.keys(canvases).forEach(function (id) {
      var item = canvases[id];
      var active = item === current;
      if (!item.api || item.active === active) return;
      item.active = active;
      try { item.api.update({ active: active }); }
      catch (err) { console.error('[switchboard] diagrams: update:', err); }
    });
  }

  // In Grid, clicking or focusing a canvas makes that workspace the only one
  // listening for document/window shortcuts. A click into a terminal or Changes
  // pane releases it, including when focus remains on document.body.
  function chooseFrom(event) {
    if (route().view !== 'grid') return;
    var target = event.target;
    var next = null;
    if (target instanceof Node) {
      Object.keys(canvases).some(function (id) {
        var item = canvases[id];
        if (item.slab.isConnected && (item.slab.contains(target) ||
          (item.api && item.api.contains(target)))) { next = id; return true; }
        return false;
      });
    }
    if (next === activeGrid) return;
    activeGrid = next;
    shown(route());
  }
  document.addEventListener('pointerdown', chooseFrom, true);
  document.addEventListener('focusin', chooseFrom, true);

  function onKey(e) {
    var item = activeCanvas(route());
    if (!item || !item.api) return false;
    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Radix owns Escape inside its picker, menus and dialogs. Their portal sits
      // outside the canvas, and Switchboard must not navigate back underneath it.
      if (e.target instanceof Node && item.api.contains(e.target) &&
          !item.slab.contains(e.target)) return true;
      if (item.api.fullscreen()) { item.api.leaveFullscreen(); return true; }
      return false;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      var t = e.target;
      return t === document.body || (!!t && (item.slab.contains(t) || item.api.contains(t)));
    }
    return false;
  }

  function editAction(action, text, image) {
    var item = activeCanvas(route());
    if (!item || !item.api) return false;
    var active = document.activeElement;
    if (active && active !== document.body && !item.slab.contains(active)) return false;
    try { return !!item.api.editAction(action, !!image, typeof text === 'string' ? text : ''); }
    catch (err) { console.error('[switchboard] diagrams: edit:', err); return false; }
  }

  function refresh() {
    var b = bundle();
    if (b && Object.keys(canvases).length) {
      try { b.refreshAnswers(false); } catch (err) { /* the menu asks again when it opens */ }
    }
  }

  function flushAll() {
    var b = bundle();
    if (!b) return Promise.resolve();
    try { return Promise.resolve(b.flush()); } catch (err) { return Promise.resolve(); }
  }

  window.addEventListener('blur', function () { flushAll(); });
  window.addEventListener('pagehide', function () { flushAll(); });

  // Main waits for the last debounced autosave before disposing the renderer.
  function onFlush(id) {
    function answer() {
      var bridge = window.sb;
      if (bridge && typeof bridge.diagramsFlushed === 'function') {
        try { return bridge.diagramsFlushed(id); } catch (err) { /* bridge gone */ }
      }
    }
    return Promise.race([
      flushAll(),
      new Promise(function (done) { setTimeout(done, 1500); }),
    ]).then(answer, answer);
  }
  if (window.sb && typeof window.sb.onDiagramsFlush === 'function') {
    try { window.sb.onDiagramsFlush(onFlush); } catch (err) { console.error('[switchboard] diagrams: flush:', err); }
  }

  SB.views.diagrams = {
    render: render,
    mountGrid: mountGrid,
    shown: shown,
    onKey: onKey,
    editAction: editAction,
    refresh: refresh,
    flushAll: flushAll,
  };
})(window.SB);
