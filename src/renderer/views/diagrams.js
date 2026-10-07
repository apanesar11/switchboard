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
    // Keep xterm outside the React/Tailwind scope, exactly as in Grid.
    var canvas = h('div.dgcanvas');
    slab.appendChild(canvas);
    var item = { wsId: wsId, slab: slab, api: null, active: false, dirty: false, home: null, fullscreen: false,
      terminalOpen: false, terminalPanel: null, terminalBody: null, returnFocus: null };
    canvases[wsId] = item;
    var b = bundle();
    if (!b || typeof b.create !== 'function') {
      slab.classList.add('blank');
      slab.appendChild(D.empty('run npm run build:diagrams in the switchboard checkout, then reopen it.',
        { title: 'the diagram editor is not built' }));
      return item;
    }
    try {
      item.api = b.create(canvas, {
        wsId: wsId,
        wsName: wsId,
        active: false,
        onOpenSettings: function () { if (typeof SB.go === 'function') SB.go({ view: 'settings' }); },
        onOpenTerminal: function (id) {
          if (typeof SB.go === 'function') SB.go({ view: 'workspace', wsId: id, tab: 'terminal' });
        },
        onDirty: function (count) { reportDirty(wsId, count); },
        onFullscreenChange: function (open) { hostFullscreen(item, open); },
        onToggleTerminal: function () { toggleTerminal(item); },
      });
    } catch (err) {
      console.error('[switchboard] diagrams: mount:', err);
    }
    return item;
  }

  function mountTerminal(item, force) {
    var term = SB.views.terminal;
    if (!term || !item.terminalBody) return;
    var shell = ((SB.state || {}).shell || {})[item.wsId] || null;
    if (!force && item.terminalShell === shell && item.terminalBody.querySelector('.xterm')) return;
    var focused = item.terminalBody.contains(document.activeElement);
    item.terminalBody.replaceChildren();
    term.mount(item.wsId, item.terminalBody);
    item.terminalShell = shell;
    if (focused) term.focus(item.wsId);
  }

  function toggleTerminal(item) {
    item.terminalOpen = !item.terminalOpen;
    if (item.terminalOpen) {
      item.returnFocus = document.activeElement;
      if (!item.terminalPanel) {
        item.terminalBody = h('div.dgterminal-body');
        var resize = h('div.dgterminal-resize', { title: 'Resize AI terminal' });
        item.terminalPanel = h('section.dgterminal', { role: 'region', 'aria-label': 'AI terminal for ' + item.wsId },
          resize,
          h('header.dgterminal-header', null,
            h('span.dgterminal-title', null, D.icon('term'), 'AI terminal', h('span.dgterminal-workspace', null, item.wsId)),
            h('button.ib', { type: 'button', title: 'Close AI terminal · ⌘A', 'aria-label': 'Close AI terminal',
              onClick: function () { toggleTerminal(item); } }, '×')),
          item.terminalBody);
        // Terminal keys and wheel input stay in the existing terminal. ⌘A is
        // handled by the native Edit menu, or by onKey before bubbling stops.
        item.terminalPanel.addEventListener('keydown', function (e) {
          if (onKey(e)) e.preventDefault();
          e.stopPropagation();
        });
        item.terminalPanel.addEventListener('wheel', function (e) { e.stopPropagation(); });
        resize.addEventListener('pointerdown', function (e) {
          e.preventDefault();
          var start = e.clientX, width = item.terminalPanel.getBoundingClientRect().width;
          resize.setPointerCapture(e.pointerId);
          function move(event) { item.terminalPanel.style.width = Math.max(340, Math.min(900, width + start - event.clientX)) + 'px'; }
          function done() { resize.removeEventListener('pointermove', move); resize.removeEventListener('pointerup', done); resize.removeEventListener('pointercancel', done); }
          resize.addEventListener('pointermove', move);
          resize.addEventListener('pointerup', done);
          resize.addEventListener('pointercancel', done);
        });
      }
      item.slab.appendChild(item.terminalPanel);
      mountTerminal(item, true);
      if (typeof SB.bell === 'function') SB.bell(item.wsId, false);
      // A new xterm opens after its host has layout; focus after that same timer.
      setTimeout(function () {
        if (item.terminalOpen && terminalVisible(item.wsId)) SB.views.terminal.focus(item.wsId);
      }, 0);
    } else {
      item.terminalPanel.remove();
      var previous = item.returnFocus;
      var target = previous && previous.isConnected && !item.terminalPanel.contains(previous)
        ? previous : item.slab.querySelector('[data-diagram-terminal-toggle]');
      if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
    }
    if (item.api) item.api.update({ terminalOpen: item.terminalOpen });
  }

  function terminalVisible(wsId) {
    var item = canvases[wsId], r = route();
    if (!item || !item.terminalOpen || !item.terminalPanel || !item.terminalPanel.isConnected) return false;
    return onTab(r) ? r.wsId === wsId : r.view === 'grid' && !!item.home && !!item.home.closest('.gridbd');
  }

  function toggleTerminalShortcut() {
    // Reparenting a focused xterm between Grid and its floating panel need not
    // emit focusin. Resolve its canvas from the actual focus before toggling.
    if (route().view === 'grid' && document.activeElement !== document.body) {
      chooseFrom({ target: document.activeElement });
    }
    var item = activeCanvas(route());
    if (!item || !item.api) return false;
    var active = document.activeElement;
    if (active && active !== document.body) {
      if (!item.slab.contains(active) && !onTab(route())) return false;
      // The terminal's helper textarea is part of the toggle. Every other text
      // editor keeps Select All, including Markdown and inline rich text.
      if (!active.closest('.dgterminal') && (active.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT|WEBVIEW)$/.test(active.tagName) ||
          active.closest('[role="dialog"], [role="menu"], [role="listbox"]'))) return false;
    }
    toggleTerminal(item);
    return true;
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
      if (terminalVisible(id)) {
        mountTerminal(item);
        if (typeof SB.bell === 'function') SB.bell(id, false);
      }
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
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && String(e.key).toLowerCase() === 'a') {
      return toggleTerminalShortcut();
    }
    var item = activeCanvas(route());
    if (!item || !item.api) return false;
    if (e.target instanceof Element && e.target.closest('.dgterminal')) return false;
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
    if (active instanceof Element && active.closest('.dgterminal')) return false;
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
    toggleTerminalShortcut: toggleTerminalShortcut,
    terminalVisible: terminalVisible,
  };
})(window.SB);
