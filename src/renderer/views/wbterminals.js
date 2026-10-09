// SB.wbTerminals — the terminals on an open whiteboard (mock-up screen 4): floating
// panels over the canvas, any number at once and one per workspace; the tray of every
// terminal the board has open, minimized or pinned; and the overlays that carry a
// PINNED terminal's live xterm over its node on the canvas.
//
// Each is still the workspace's own shell — the same pane views/terminal.js keeps for
// the Terminal tab and the Grid, moved here with place(), never a second xterm (a
// second one would steal the tmux client and repaint garbage, §6 R8). place() yields:
// a board takes the host only when nothing else on screen holds it, so a Grid square
// and a board panel for one workspace never bounce it between them on every render;
// the panel that lost shows a stand-in instead.
//
// A layer belongs to one board's slab (views/whiteboards.js creates it beside the
// canvas). Its three layers are siblings of .dgcanvas, never inside the React tree:
// Tailwind's reset stays off xterm and FlowEditor's onCanvas() stays false for keys
// typed into a terminal. Every element a terminal lives in is marked
// [data-wb-terminal], which is how the shell's ⌘A, Esc and Edit-menu guards know to
// leave it alone.
//
// A pinned terminal is board content: the node, its place and size live in the board
// file and the bundle reports where it is on screen (slots). The overlay follows that
// rectangle with plain left/top/width/height — NO transform on any ancestor of the
// xterm, which would blur the text and break xterm's mouse coordinates — and the font
// follows the zoom while cols/rows stay fixed, so zooming never resizes the pty.
// Whatever the canvas draws over the node (its tool rail, undo strip and zoom
// controls, or a pinned node stacked above it) is cut out of the overlay with a
// clip-path, so it stays visible and clickable as it is over any other node.
//
// Floating panels are this Mac's arrangement, not the board's: their places live in
// localStorage per board. Closing a panel never closes the shell; the tmux session
// lives on, exactly as leaving the Terminal tab does.
window.SB = window.SB || {};

(function (SB) {
  'use strict';

  var D = SB.dom;
  var h = D.h;

  var BASE_FONT = 12.5;
  var MIN_W = 300;
  var MIN_H = 180;
  var NEW_W = 560;
  var NEW_H = 420;
  var CASCADE = 28;            // each new panel's offset from the last one opened
  var EDGE = 16;               // the gap a new or tiled panel keeps from the slab's edge
  var TOP = 64;                // below the canvas bar
  var FULL_TOP = 56;           // full screen: clear of the traffic lights
  var TRAY_H = 40;
  var TRAY_MIN = 96;           // the tray's own buttons, when the canvas leaves it no more room
  var GAP = 8;
  var HOLE_PAD = 5;            // a pinned node's selection ring and resize handles, outside its box
  var BAR_PAD = 9;             // the canvas bar's padding under its buttons
  var CONTROLS_LIFT = 64;      // wbterminals.css: the zoom controls' bottom margin while the tray shows
  var STORE = 'switchboard.wb.terms.';
  var OPEN_TITLE = 'Open a terminal in';
  var OPEN_FOOTER = 'The same shell as the workspace’s Terminal tab. One already open comes to the front.';

  var DOT_TITLES = { run: 'Running', bell: 'Claude finished a turn', fail: 'Failed', chg: 'Has changes' };

  // ── workspace choices (dirLabel, gone workspaces) ─────────────────────────

  // The renderer has no home directory, so the "~/Projects/sample-2" a header shows
  // comes from main (whiteboardsWorkspaces), once per session and again whenever a
  // workspace it has not heard of is opened. Every layer repaints its headers when a
  // newer answer lands.
  var choices = null;               // { workspaces: [{id, project, dirLabel}], recent, last }
  var asking = null;
  // Every attached layer: `repaint` for a fresh answer from main, `lost` for a
  // terminal another layer has just taken with Show here.
  var layers = new Set();

  function unwrap(r) {
    if (r && r.ok === true && r.data && Array.isArray(r.data.workspaces)) return r.data;
    if (r && Array.isArray(r.workspaces)) return r;
    return null;
  }

  function loadChoices(force) {
    if (asking && !force) return asking;
    var api = window.sb;
    if (!api || typeof api.whiteboardsWorkspaces !== 'function') return Promise.resolve(choices);
    var ask = Promise.resolve()
      .then(function () { return api.whiteboardsWorkspaces(); })
      .then(function (r) {
        var data = unwrap(r);
        if (data) {
          choices = data;
          layers.forEach(function (layer) {
            try { layer.repaint(); } catch (err) { console.error('[switchboard] wbterminals: repaint:', err); }
          });
        }
        return choices;
      }, function () { return choices; });
    asking = ask;
    return ask;
  }

  // true / false once main has answered; null while nobody knows yet. A workspace
  // that is not in the answer has left the rail.
  function known(wsId) {
    if (!choices) return null;
    return choices.workspaces.some(function (w) { return !!w && w.id === wsId; });
  }

  // known(), asking main again first when the list this session has does not name
  // wsId: that list can be from before the workspace was added to the rail (it is
  // fetched once and refreshed only for a workspace with no folder yet, or a picker).
  // Resolves true / false, or null when main never answered.
  function knownFresh(wsId) {
    if (known(wsId) !== false) return Promise.resolve(known(wsId));
    return loadChoices(true).then(function () { return known(wsId); });
  }

  function dirLabelOf(wsId) {
    if (!choices) return '';
    for (var i = 0; i < choices.workspaces.length; i++) {
      var w = choices.workspaces[i];
      if (w && w.id === wsId) return typeof w.dirLabel === 'string' ? w.dirLabel : '';
    }
    return '';
  }

  // ── small helpers ─────────────────────────────────────────────────────────

  // The same rule main applies to a board's workspace: a rail id, never a path.
  function cleanWs(wsId) {
    if (typeof wsId !== 'string') return null;
    var id = wsId.trim();
    if (!id || id.length > 200 || /[\/\\\r\n]/.test(id) || id.charAt(0) === '.') return null;
    return id;
  }

  // Quarter-pixel font steps: smooth enough to follow a zoom, coarse enough that a
  // pan (same zoom, new place) never asks xterm to re-measure.
  function round4(px) {
    var n = Number(px);
    return isFinite(n) && n > 0 ? Math.round(n * 4) / 4 : 0;
  }

  function term() { return SB.views && SB.views.terminal ? SB.views.terminal : null; }

  function shellOf(wsId) {
    var shells = (SB.state && SB.state.shell) || {};
    return shells[wsId] || null;
  }

  function wsOf(wsId) {
    var ws = typeof SB.ws === 'function' ? SB.ws(wsId) : null;
    return ws && ws.id === wsId ? ws : null;
  }

  function dotOf(ws) {
    if (typeof SB.dotFor !== 'function') return '';
    try { return SB.dotFor(ws) || ''; } catch (_) { return ''; }
  }

  // A header's branch is only worth showing once the workspace has been scanned:
  // before that blankWorkspace() says `main` for every workspace, which is a guess.
  function ensureScanned(wsId) {
    if (typeof SB.ensureScanned === 'function') {
      try { SB.ensureScanned(wsId); } catch (_) { /* the header just waits for a scan */ }
      return;
    }
    var ws = wsOf(wsId);
    if (ws && !ws.scanned && !ws.scanning && typeof SB.refresh === 'function') {
      Promise.resolve(SB.refresh(wsId))['catch'](function () {});
    }
  }

  function noteWorkspace(wsId) {
    var api = window.sb;
    if (!api || typeof api.whiteboardsNoteWorkspace !== 'function') return;
    try { Promise.resolve(api.whiteboardsNoteWorkspace(wsId))['catch'](function () {}); }
    catch (_) { /* the Recent list is a convenience */ }
  }

  // An icon from icons.js, or the word when this build has no such glyph: a header
  // button with nothing in it is worse than one with a letter.
  function iconOr(name, fallback) {
    if (SB.icons && SB.icons[name]) return D.icon(name);
    return h('span.ic.txt', { 'aria-hidden': 'true' }, fallback || '');
  }

  function plainRect(r) {
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  // The status every picker row shows, from the rail's own state.
  function statusMap() {
    var out = {};
    var list = (SB.state && SB.state.workspaces) || [];
    list.forEach(function (ws) {
      if (!ws || !ws.id) return;
      out[ws.id] = { dot: dotOf(ws), branch: ws.scanned ? (ws.branchSummary || null) : null };
    });
    return out;
  }

  // The slab's own keydown rule, shared by panels and pinned overlays: the whiteboard
  // view sees the key first (⌘A shows or hides the terminals from inside one), and
  // then it stops — ⌘1–9, Esc-to-go-back and the canvas shortcuts must not fire while
  // the user is typing into a shell. This is what the old single panel did.
  function keyRule(e) {
    var wb = SB.views && SB.views.whiteboards;
    var used = false;
    if (wb && typeof wb.onKey === 'function') {
      try { used = !!wb.onKey(e); } catch (err) { console.error('[switchboard] wbterminals: key:', err); }
    }
    if (used) e.preventDefault();
    e.stopPropagation();
  }

  // The tray's version of the same rule. Its chips and buttons are not a shell, so the
  // app's own shortcuts (⌘1–9, ⌘R) still reach the window from there — but Esc stops
  // here: the shell's back() would otherwise take a press meant for the tray (focus
  // stays on Tile or + after a click) as "leave the board", which §7.3.4 forbids.
  function trayKeyRule(e) {
    var wb = SB.views && SB.views.whiteboards;
    var used = false;
    if (wb && typeof wb.onKey === 'function') {
      try { used = !!wb.onKey(e); } catch (err) { console.error('[switchboard] wbterminals: key:', err); }
    }
    if (used) { e.preventDefault(); e.stopPropagation(); return; }
    if (e.key === 'Escape') e.stopPropagation();
  }

  function readStore(boardId) {
    var raw = null;
    try { raw = window.localStorage.getItem(STORE + boardId); } catch (_) { return null; }
    if (!raw) return null;
    var data = null;
    try { data = JSON.parse(raw); } catch (_) { return null; }
    if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return null;
    var items = [];
    data.items.forEach(function (it) {
      var ws = it && cleanWs(it.wsId);
      var r = it && it.rect;
      if (!ws || !r || ![r.x, r.y, r.w, r.h].every(function (n) { return typeof n === 'number' && isFinite(n); })) return;
      if (items.some(function (x) { return x.wsId === ws; })) return;
      items.push({ wsId: ws, minimized: !!it.minimized, rect: { x: r.x, y: r.y, w: r.w, h: r.h } });
    });
    var grids = Object.create(null);
    if (data.grids && typeof data.grids === 'object') {
      Object.keys(data.grids).forEach(function (key) {
        var ws = cleanWs(key);
        var g = data.grids[key];
        if (!ws || !g || ![g.cols, g.rows, g.w, g.h, g.font].every(function (n) { return typeof n === 'number' && isFinite(n) && n > 0; })) return;
        grids[ws] = { cols: Math.floor(g.cols), rows: Math.floor(g.rows), w: g.w, h: g.h, font: g.font };
      });
    }
    return { hidden: !!data.hidden, items: items, grids: grids };
  }

  // ── a board's layer ───────────────────────────────────────────────────────

  function attach(opts) {
    var o = opts || {};
    var boardId = String(o.boardId || '');
    var slab = o.slab;
    var owner = 'wb:' + boardId;
    var getApi = typeof o.getApi === 'function' ? o.getApi : function () { return null; };
    var getBoard = typeof o.getBoard === 'function' ? o.getBoard : function () { return null; };
    var onChange = typeof o.onChange === 'function' ? o.onChange : function () {};

    var termsEl = h('div.wbterms');
    var pinsEl = h('div.wbpins');
    var trayEl = h('div.wbtray', { 'data-wb-terminal': '', role: 'toolbar', 'aria-label': 'Terminals', hidden: true });
    trayEl.addEventListener('keydown', trayKeyRule);

    var terms = new Map();            // wsId -> T, in the order the tray lists them
    var floating = new Map();         // wsId -> timer: float() is moving it off the canvas
    var hidden = false;               // ⌘A: floating panels and the tray are put away
    var visible = false;              // the slab is on screen (shown())
    var destroyed = false;
    var zTop = 0;
    var lastOpened = null;
    var deciding = false;             // toggleAll() is asking main whether the board's workspace is still there
    var picking = null;               // this layer's open picker: the promise pick() returned
    var pickClosedAt = -Infinity;     // when it last closed without a pick (performance.now())
    var addPress = null;              // the pointerdown on the tray's + that its next click belongs to
    var told = null;                  // the last list onChange() heard
    var observer = null;
    var stripObserver = null;         // the canvas's bottom-centre strip, which the tray keeps clear of
    var strip = null;
    var refitTimer = null;            // refitSoon(): waiting for the canvas bar to be drawn
    var refitTries = 0;

    function api() {
      try { return getApi() || null; } catch (_) { return null; }
    }

    function board() {
      try { return getBoard() || null; } catch (_) { return null; }
    }

    // T: one terminal on this board. `body` is the ONE element place() is ever given
    // for it; pinning and floating move that element between the panel and the
    // overlay, so the xterm inside goes along without being re-placed or re-fitted.
    function entry(wsId, mode) {
      var t = {
        wsId: wsId, mode: mode || 'float', minimized: false, rect: null, z: 0,
        panel: null, head: null, els: null, pin: null,
        body: h('div.wbterm-body'),
        shell: undefined,             // the Shell object the body was last placed with
        fixed: null, font: BASE_FONT, size: null, live: false, resizing: false,
        nodeFont: null,               // a pinned node's font in canvas units (slot.font / slot.zoom)
        pinning: null,                // the timer waiting for a pin's first slot
        refocus: false,               // Pin to board was pressed while focus was in this panel
        gesture: null,                // ends the drag or edge resize under way (track)
        clipped: '',                  // the overlay's clip-path, as last written
      };
      terms.set(wsId, t);
      return t;
    }

    function floats() {
      var out = [];
      terms.forEach(function (t) { if (t.mode === 'float') out.push(t); });
      return out;
    }

    function openFloats() {
      return floats().filter(function (t) { return !t.minimized; });
    }

    // ── geometry ────────────────────────────────────────────────────────────

    // views/whiteboards.js moves the whole slab onto <body> for full screen, where the
    // traffic lights sit over its top-left corner.
    function fullscreen() {
      return !!slab && (slab.classList.contains('full') || slab.parentNode === document.body);
    }

    // The bottom of the canvas bar (switcher, New whiteboard, Full screen, Actions), in
    // slab pixels: the top of the React Flow canvas, else (no canvas drawn yet) just
    // under the Actions button — the bar wraps onto a second line in a narrow Grid
    // square, and Actions is on its last. Null while neither is on the page: the
    // board is still loading.
    function barBottom() {
      if (!slab) return null;
      var at = slab.getBoundingClientRect();
      var canvas = slab.querySelector('.react-flow');
      var r = canvas ? canvas.getBoundingClientRect() : null;
      if (r && r.height) return Math.max(0, Math.round(r.top - at.top));
      var actions = slab.querySelector('[data-whiteboard-actions]');
      r = actions ? actions.getBoundingClientRect() : null;
      if (r && r.height) return Math.max(0, Math.round(r.bottom - at.top + BAR_PAD));
      return null;
    }

    // A panel never goes above the canvas bar — dragged there it would cover Actions,
    // the one way back to Open terminal… — nor, in full screen, into the traffic lights.
    function limits() {
      var w = slab ? slab.clientWidth : 0;
      var hh = slab ? slab.clientHeight : 0;
      var bar = barBottom();
      var top = Math.max(fullscreen() ? FULL_TOP : 0, bar || 0);
      return { w: w, h: hh, top: top, ok: w > 0 && hh > 0, bar: bar !== null };
    }

    // A panel put on a slab whose bar is not drawn yet (a board restored with its
    // terminals while it loads, often in a Grid square) is fitted again once it is.
    function refitSoon() {
      if (refitTimer || destroyed) return;
      refitTimer = setTimeout(function () {
        refitTimer = null;
        if (destroyed) return;
        if (!limits().bar) {
          if (++refitTries < 40) refitSoon();
          return;
        }
        refitTries = 0;
        floats().forEach(function (t) { if (t.panel && t.panel.isConnected) applyRect(t); });
      }, 150);
    }

    // The React Flow zoom controls, in slab pixels, or null. wbterminals.css lifts them
    // above the tray while it shows; tile() keeps the panels above them.
    function controlsRect() {
      var el = slab ? slab.querySelector('.react-flow__controls') : null;
      if (!el) return null;
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      var at = slab.getBoundingClientRect();
      return { x: r.left - at.left, y: r.top - at.top, w: r.width, h: r.height };
    }

    // Inside the slab, shrunk only when the slab itself is smaller than the panel.
    function fit(r) {
      var b = limits();
      if (!b.ok) return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
      var w = Math.min(Math.max(r.w, MIN_W), b.w);
      var hh = Math.min(Math.max(r.h, MIN_H), Math.max(b.h - b.top, 0));
      var x = Math.min(Math.max(r.x, 0), b.w - w);
      var y = Math.max(Math.min(Math.max(r.y, b.top), b.h - hh), b.top);
      return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(hh) };
    }

    function toSlab(rect) {
      if (!rect || !slab) return null;
      var at = slab.getBoundingClientRect();
      var r = { x: rect.left - at.left, y: rect.top - at.top, w: rect.width, h: rect.height };
      if (![r.x, r.y, r.w, r.h].every(function (n) { return typeof n === 'number' && isFinite(n); })) return null;
      return r;
    }

    // The first panel lands against the right edge, below the bar; each next one 28px
    // down and LEFT of the last one opened — the first is already against the right
    // edge, so stepping right would only pile them up there — keeping the slab's 16px
    // margin and every earlier header in reach. A last panel the user dragged to the
    // left edge cascades right instead. Off the bottom, the next column starts again
    // under the bar, one more step to the left; off both edges, back to the first place.
    function nextRect() {
      var b = limits();
      var w = Math.max(MIN_W, Math.min(NEW_W, (b.ok ? b.w : NEW_W + 2 * EDGE) - 2 * EDGE));
      var hh = Math.max(MIN_H, Math.min(NEW_H, (b.ok ? b.h : NEW_H + 120) - 120));
      var y0 = Math.max(TOP, b.top);
      // The first place is against the right edge, above the zoom controls where the
      // tray will have lifted them (it shows from the first terminal on): on a short
      // slab the panel is shorter rather than over them. Every later one steps left,
      // clear of them.
      var ctl = controlsRect();
      if (b.ok && ctl) hh = Math.max(MIN_H, Math.min(hh, b.h - CONTROLS_LIFT - ctl.h - GAP - y0));
      var base = fit({ x: (b.ok ? b.w : NEW_W + EDGE) - EDGE - w, y: y0, w: w, h: hh });
      var last = lastOpened && terms.get(lastOpened);
      if (!last || last.mode !== 'float' || last.minimized || !last.rect) return base;
      if (!b.ok) return base;
      var from = fit(last.rect);
      var right = b.w - EDGE - w;
      var x = from.x - CASCADE;
      if (x < EDGE) x = from.x + CASCADE <= right ? from.x + CASCADE : null;
      var y = from.y + CASCADE;
      if (x !== null && y + hh > b.h - EDGE) {
        y = base.y;
        x = from.x - CASCADE >= EDGE ? from.x - CASCADE : null;
      }
      if (x === null) return base;
      var next = fit({ x: x, y: y, w: w, h: hh });
      if (next.x === from.x && next.y === from.y) return base;
      return next;
    }

    function applyRect(t) {
      if (!t.panel || !t.rect) return;
      var r = fit(t.rect);
      var s = t.panel.style;
      if (s.left !== r.x + 'px') s.left = r.x + 'px';
      if (s.top !== r.y + 'px') s.top = r.y + 'px';
      if (s.width !== r.w + 'px') s.width = r.w + 'px';
      if (s.height !== r.h + 'px') s.height = r.h + 'px';
      if (!limits().bar) refitSoon();
    }

    function shownRect(t) { return fit(t.rect || nextRect()); }

    // ── DOM layers ──────────────────────────────────────────────────────────

    function ensureLayers() {
      if (!slab || destroyed) return;
      if (pinsEl.parentNode !== slab) slab.appendChild(pinsEl);
      if (termsEl.parentNode !== slab) slab.appendChild(termsEl);
      if (trayEl.parentNode !== slab) slab.appendChild(trayEl);
    }

    function front(t) {
      if (!t.panel) return;
      if (t.z !== zTop || !t.z) {
        t.z = ++zTop;
        t.panel.style.zIndex = String(t.z);
      }
      var top = null;
      floats().forEach(function (x) {
        if (x.panel && x.panel.isConnected && (!top || x.z > top.z)) top = x;
      });
      floats().forEach(function (x) { if (x.panel) x.panel.classList.toggle('front', x === top); });
    }

    // ── a floating panel ────────────────────────────────────────────────────

    function ctl(icon, fallback, label, onClick) {
      return h('button.wbterm-btn', {
        type: 'button', title: label, 'aria-label': label,
        onClick: function (e) { e.stopPropagation(); onClick(); },
      }, iconOr(icon, fallback));
    }

    function buildPanel(t) {
      var ws = t.wsId;
      var dot = h('span.dot', { hidden: true });
      // The folder and the branch are two spans: a long folder (one outside the home
      // directory has no ~ to shorten it) gives way from its start, and the branch
      // after it stays readable.
      var path = h('span.wbterm-path');
      var branch = h('span.wbterm-branch', { hidden: true });
      var pinBtn = ctl('pin', 'Pin', 'Pin ' + ws + ' to the whiteboard', function () { pin(t); });
      var head = h('header.wbterm-hd', null,
        iconOr('term', ''),
        h('b.wbterm-ws', { title: ws }, ws),
        h('span.wbterm-where', null, path, branch),
        dot,
        h('span.sp'),
        h('span.wbterm-ctl', null,
          pinBtn,
          ctl('minus', '–', 'Minimize ' + ws, function () { minimize(t); }),
          ctl('close', '×', 'Close ' + ws, function () { close(t); })));
      var panel = h('section.wbterm', {
        role: 'group', 'aria-label': ws + ' terminal', 'data-wb-terminal': ws,
      }, head, t.body);
      ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].forEach(function (edge) {
        var grip = h('div.wbterm-rz', { 'data-edge': edge, 'aria-hidden': 'true' });
        grip.addEventListener('pointerdown', function (e) { resizeFrom(t, edge, grip, e); });
        panel.appendChild(grip);
      });
      panel.appendChild(h('span.wbterm-grip', { 'aria-hidden': 'true' }));

      // Clicking anywhere in a panel brings it to the front, before whatever was
      // pressed acts — a drag that starts on a panel behind must move that one.
      panel.addEventListener('pointerdown', function () { front(t); }, true);
      panel.addEventListener('keydown', keyRule);
      // The terminal scrolls its own scrollback; nothing outside should see the wheel.
      panel.addEventListener('wheel', function (e) { e.stopPropagation(); });
      // A ring counts as read only once the user is in that terminal — a panel merely
      // being visible keeps its dot, the way the mock-up shows a blue one on an open
      // panel nobody is looking at.
      panel.addEventListener('focusin', function () {
        front(t);
        if (typeof SB.bell === 'function') SB.bell(ws, false);
      });
      head.addEventListener('pointerdown', function (e) { dragFrom(t, head, e); });

      t.panel = panel;
      t.head = head;
      t.els = { dot: dot, path: path, branch: branch, pin: pinBtn };
      paintHead(t);
      return panel;
    }

    function ensurePanel(t) {
      if (!t.panel) buildPanel(t);
      if (t.body.parentNode !== t.panel) t.panel.insertBefore(t.body, t.head.nextSibling);
      return t.panel;
    }

    // Puts a panel on the slab (DOM only — place() is a separate, later step).
    function mountPanel(t) {
      ensurePanel(t);
      if (!t.rect) t.rect = nextRect();
      applyRect(t);
      if (t.panel.parentNode !== termsEl) termsEl.appendChild(t.panel);
    }

    function unmountPanel(t) {
      endGesture(t);
      if (t.panel && t.panel.parentNode) t.panel.parentNode.removeChild(t.panel);
    }

    // Runs on every render, so it writes only what changed.
    function paintHead(t) {
      if (!t.els) return;
      var ws = wsOf(t.wsId);
      paintDot(t.els.dot, t.wsId);
      var branch = ws && ws.scanned ? (ws.branchSummary || '') : '';
      var dir = dirLabelOf(t.wsId);
      // Left-to-right marks: the span runs right-to-left so its ellipsis falls at the
      // START of a long path, and these keep the path's own slashes in reading order.
      var shown = dir ? '\u200e' + dir + '\u200e' : '';
      if (t.els.path.textContent !== shown) {
        t.els.path.textContent = shown;
        t.els.path.hidden = !dir;
      }
      var full = [dir, branch].filter(Boolean).join(' · ');
      if (t.els.path.title !== full) t.els.path.title = full;
      var tail = branch ? (dir ? '· ' : '') + branch : '';
      if (t.els.branch.textContent !== tail) {
        t.els.branch.textContent = tail;
        t.els.branch.hidden = !branch;
        t.els.branch.title = full;
      }
      var b = board();
      var archived = !!(b && b.archivedAt);
      if (t.els.pin.disabled !== archived || !t.els.pin.hasAttribute('data-painted')) {
        var label = archived ? 'Unarchive the whiteboard to pin' : 'Pin ' + t.wsId + ' to the whiteboard';
        t.els.pin.disabled = archived;
        t.els.pin.title = label;
        t.els.pin.setAttribute('aria-label', label);
        t.els.pin.setAttribute('data-painted', '');
      }
    }

    // One drag or edge resize of a panel, from its pointerdown on `el` to its end. The
    // end is listened for on the window, not on `el`: a panel hidden (⌘A), minimized
    // or closed mid-drag leaves the document holding the capture, and Chromium then
    // sends lostpointercapture to the document and the pointerup to whatever is under
    // the pointer — `el` hears neither, so its pointermove listener would outlive the
    // gesture and move or resize the panel the next time the pointer merely passed
    // over it. unmountPanel() also ends it at once (t.gesture), so a hidden panel
    // never keeps a hold or a 'moving' class until the button comes up.
    function track(t, el, e, onMove, onEnd) {
      endGesture(t);
      var id = e.pointerId;
      try { el.setPointerCapture(id); } catch (_) { /* a synthetic press */ }
      var ended = false;
      function move(ev) {
        if (ev.pointerId === id) onMove(ev);
      }
      // A lostpointercapture is this gesture's only when it is el's own or, with el
      // gone from the document, the document's: a touch's implicit capture moving from
      // the pressed child to el must not end the drag it starts.
      function end(ev) {
        if (ev.pointerId !== id) return;
        if (ev.type === 'lostpointercapture' && ev.target !== el && ev.target !== document && el.isConnected) return;
        done();
      }
      function done() {
        if (ended) return;
        ended = true;
        el.removeEventListener('pointermove', move);
        ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (type) {
          window.removeEventListener(type, end, true);
        });
        if (t.gesture === done) t.gesture = null;
        try { if (el.hasPointerCapture(id)) el.releasePointerCapture(id); } catch (_) { /* already released */ }
        onEnd();
      }
      el.addEventListener('pointermove', move);
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (type) {
        window.addEventListener(type, end, true);
      });
      t.gesture = done;
    }

    function endGesture(t) {
      if (t.gesture) t.gesture();
    }

    // Moving a panel needs no fit: its size does not change. preventDefault keeps the
    // press from taking focus out of the terminal the user was typing into.
    function dragFrom(t, head, e) {
      if (e.button !== 0 || !t.panel) return;
      if (e.target instanceof Element && e.target.closest('button')) return;
      e.preventDefault();
      endGesture(t);
      var from = shownRect(t);
      var x0 = e.clientX, y0 = e.clientY;
      t.panel.classList.add('moving');
      track(t, head, e, function (ev) {
        t.rect = fit({ x: from.x + ev.clientX - x0, y: from.y + ev.clientY - y0, w: from.w, h: from.h });
        applyRect(t);
      }, function () {
        if (t.panel) t.panel.classList.remove('moving');
        persist();
      });
    }

    // Any edge or corner. The pane is held for the whole drag and fitted once on
    // release: a fit per pointermove would send the pty a new size per pixel, and a
    // full-screen TUI redraws on every one of them.
    function resizeFrom(t, edge, grip, e) {
      if (e.button !== 0 || !t.panel) return;
      e.preventDefault();
      e.stopPropagation();
      endGesture(t);
      var from = shownRect(t);
      var x0 = e.clientX, y0 = e.clientY;
      var tm = term();
      if (tm && typeof tm.hold === 'function') tm.hold(t.wsId, true, owner);
      t.panel.classList.add('sizing');
      track(t, grip, e, function (ev) {
        var b = limits();
        var dx = ev.clientX - x0, dy = ev.clientY - y0;
        var left = from.x, top = from.y, right = from.x + from.w, bottom = from.y + from.h;
        if (edge.indexOf('w') !== -1) left = Math.min(Math.max(left + dx, 0), right - MIN_W);
        if (edge.indexOf('e') !== -1) right = Math.max(Math.min(right + dx, b.ok ? b.w : right + dx), left + MIN_W);
        if (edge.indexOf('n') !== -1) top = Math.min(Math.max(top + dy, b.top), bottom - MIN_H);
        if (edge.indexOf('s') !== -1) bottom = Math.max(Math.min(bottom + dy, b.ok ? b.h : bottom + dy), top + MIN_H);
        t.rect = { x: Math.round(left), y: Math.round(top), w: Math.round(right - left), h: Math.round(bottom - top) };
        applyRect(t);
      }, function () {
        if (t.panel) t.panel.classList.remove('sizing');
        var tm2 = term();
        if (tm2 && typeof tm2.hold === 'function') tm2.hold(t.wsId, false, owner);
        persist();
      });
    }

    // ── placing the terminal ────────────────────────────────────────────────

    function holds(t) { return !!t.body.querySelector('.xterm'); }

    // Today's mountTerminal guard: a body is placed again only when its shell changed
    // (a new generation, an exit, a failure) or it no longer has the xterm — the Grid
    // or another board took it, or the pane was retired and is coming back.
    function needsPlace(t) {
      return t.body.isConnected && (!holds(t) || t.shell !== shellOf(t.wsId));
    }

    function placeT(t, force) {
      var tm = term();
      if (!tm || typeof tm.place !== 'function' || destroyed) return false;
      if (!t.body.isConnected) return false;
      var pinned = t.mode === 'pin';
      var ok = tm.place(t.wsId, t.body, {
        owner: owner,
        fixed: pinned ? t.fixed : null,
        fontSize: pinned ? t.font : BASE_FONT,
        force: !!force,
      });
      t.shell = shellOf(t.wsId);
      if (!ok) { standIn(t); return false; }
      if (pinned) {
        // A sentence in a pinned overlay (the shell failed, xterm did not load) has no
        // grid to keep; the terminal that replaces it fits its box and fixes from there.
        if (!holds(t)) t.fixed = null;
        else if (!t.fixed) settleFixed(t, 0);
        // place() sets the font; this is the quarter-pixel step-down that keeps the
        // fixed grid's last row inside the overlay.
        else tm.setFontSize(t.wsId, t.font, owner);
      }
      return true;
    }

    // Where the terminal would be, while something else on screen has it. Another
    // board's panel can be taken back here; a Grid square or the Terminal tab cannot,
    // since their next render would only take it again.
    function standIn(t) {
      var tm = term();
      var other = tm && typeof tm.owner === 'function' ? tm.owner(t.wsId) : null;
      var kind = other ? 'board' : 'route';
      var only = t.body.children.length === 1 ? t.body.firstElementChild : null;
      if (only && only.classList.contains('wbterm-standin') && only.getAttribute('data-kind') === kind) return;
      if (t.mode === 'pin') t.fixed = null;
      t.body.replaceChildren(h('div.wbterm-standin', { 'data-kind': kind },
        h('div.stack', null,
          h('span', null, 'Showing in another place'),
          other ? h('button.btn.sm', {
            type: 'button',
            onClick: function () { showHere(t); },
          }, 'Show here') : null)));
    }

    // The stand-in's Show here: take the terminal from the board that has it, and tell
    // that board straight away so it draws the stand-in where the terminal was — not
    // at the next render, which may be a long way off when nothing else changes.
    function showHere(t) {
      if (!placeT(t, true)) return;
      focusSoon(t);
      layers.forEach(function (other) {
        if (other === self) return;
        try { other.lost(t.wsId); } catch (err) { console.error('[switchboard] wbterminals: lost:', err); }
      });
    }

    // Another layer just took wsId's terminal. If it was on show here, this layer
    // yields with a stand-in (place() never takes it back without a Show here).
    function lost(wsId) {
      if (destroyed || !visible) return;
      var t = terms.get(wsId);
      if (!t || !t.body.isConnected || holds(t)) return;
      placeT(t);
    }

    // A pinned terminal with no grid yet (restored with its board, or back from a
    // stand-in) fits its box once at the slot's font, then keeps those cols/rows.
    function settleFixed(t, tries) {
      setTimeout(function () {
        if (destroyed || t.mode !== 'pin' || t.fixed || !t.body.isConnected || !holds(t)) return;
        var tm = term();
        var p = tm && typeof tm.propose === 'function' ? tm.propose(t.wsId) : null;
        if (p && tm.setFixed(t.wsId, p, owner)) {
          t.fixed = p;
          tm.setFontSize(t.wsId, t.font, owner);
          persist();
          return;
        }
        if (tries < 20) settleFixed(t, tries + 1);
      }, tries ? 50 : 0);
    }

    // A new xterm opens after its host has layout, and focus has to wait for that
    // same timer — as the old panel did.
    function focusSoon(t) {
      setTimeout(function () {
        if (destroyed || !t.body.isConnected || !holds(t)) return;
        var tm = term();
        if (tm && typeof tm.focus === 'function') tm.focus(t.wsId);
      }, 0);
    }

    // After a Minimize or Close: the next panel up, else the Actions button, so
    // keyboard focus never falls out of the board onto <body>.
    function focusNext(except) {
      var next = null;
      openFloats().forEach(function (t) {
        if (t !== except && !hidden && t.panel && t.panel.isConnected && (!next || t.z > next.z)) next = t;
      });
      if (next && holds(next)) { focusSoon(next); return; }
      var target = slab ? slab.querySelector('[data-whiteboard-actions]') : null;
      if (target && typeof target.focus === 'function') {
        try { target.focus({ preventScroll: true }); } catch (_) { target.focus(); }
      }
    }

    function hadFocus(el) {
      var a = document.activeElement;
      return !!el && !!a && el.contains(a);
    }

    // ── open / minimize / close ─────────────────────────────────────────────

    function reveal(wsId) {
      var a = api();
      if (!a || typeof a.revealTerminal !== 'function') return false;
      try { return !!a.revealTerminal(wsId); } catch (err) {
        console.error('[switchboard] wbterminals: reveal:', err);
        return false;
      }
    }

    function open(wsId) {
      var ws = cleanWs(wsId);
      if (!ws || destroyed) return false;
      noteWorkspace(ws);
      ensureScanned(ws);
      if (!dirLabelOf(ws)) loadChoices(true);
      var t = terms.get(ws);
      if (t && t.mode === 'pin') { reveal(ws); return true; }
      if (hidden) setHidden(false);
      if (!t) {
        t = entry(ws, 'float');
        t.rect = nextRect();
      }
      t.minimized = false;
      lastOpened = ws;
      mountPanel(t);
      front(t);
      if (visible) placeT(t);
      focusSoon(t);
      changed();
      return true;
    }

    function restore(t) {
      if (hidden) setHidden(false);
      t.minimized = false;
      ensureScanned(t.wsId);
      mountPanel(t);
      front(t);
      if (visible) placeT(t);
      focusSoon(t);
      changed();
    }

    // Folds into the tray. Detached, not hidden, so the host is free for the Grid or
    // another board while it sits there.
    function minimize(t) {
      var had = hadFocus(t.panel);
      t.minimized = true;
      unmountPanel(t);
      if (had) focusNext(t);
      changed();
    }

    // Leaves the board and the tray. The shell keeps running — this is the panel
    // going away, not the session (never closeShell).
    function close(t) {
      var had = hadFocus(t.panel);
      forget(t);
      if (had) focusNext(t);
      changed();
    }

    function forget(t) {
      if (t.resizing) holdOff(t);
      if (t.pinning) { clearTimeout(t.pinning); t.pinning = null; }
      unmountPanel(t);
      if (t.body.parentNode) t.body.parentNode.removeChild(t.body);
      if (t.pin && t.pin.parentNode) t.pin.parentNode.removeChild(t.pin);
      if (terms.get(t.wsId) === t) terms['delete'](t.wsId);
      if (lastOpened === t.wsId) lastOpened = null;
    }

    function setHidden(on) {
      on = !!on;
      if (on === hidden) return;
      hidden = on;
      if (on) {
        var had = openFloats().some(function (t) { return hadFocus(t.panel); });
        openFloats().forEach(unmountPanel);
        if (had) focusNext(null);
      } else {
        var top = null;
        openFloats().forEach(function (t) {
          mountPanel(t);
          if (visible) placeT(t);
          if (!top || t.z > top.z) top = t;
        });
        if (top) { front(top); focusSoon(top); }
      }
      changed();
    }

    // ⌘A: the floating terminals and the tray, all at once. Pinned terminals are board
    // content and stay where they are. With nothing floating yet it opens the board's
    // workspace, or asks which one when the board has none (or one that left the rail).
    function toggleAll() {
      if (destroyed) return false;
      if (hidden) { setHidden(false); return true; }
      if (openFloats().length) { setHidden(true); return true; }
      var mins = floats().filter(function (t) { return t.minimized; });
      if (mins.length) {
        mins.forEach(function (t) { t.minimized = false; mountPanel(t); if (visible) placeT(t); });
        var top = mins.reduce(function (a, b) { return b.z > a.z ? b : a; });
        front(top);
        focusSoon(top);
        changed();
        return true;
      }
      var b = board();
      var ws = b && cleanWs(b.workspace);
      if (!ws) { pick(); return true; }
      if (known(ws) !== false) { open(ws); return true; }
      // Not in the list this session has, which may only be older than the workspace:
      // gone means the picker, but only once main has said so again.
      if (deciding) return true;
      deciding = true;
      knownFresh(ws).then(function (k) {
        deciding = false;
        if (destroyed) return;
        if (k === false) pick();
        else open(ws);
      }, function () { deciding = false; });
      return true;
    }

    // ── tile ────────────────────────────────────────────────────────────────

    // Side by side along the right edge, from under the bar to above the tray and the
    // canvas's zoom controls (which the tray has lifted over itself), in the
    // left-to-right order they already had.
    function tile() {
      var list = openFloats().filter(function (t) { return t.panel && t.panel.isConnected; });
      if (!list.length) return;
      var b = limits();
      if (!b.ok) return;
      list.sort(function (a, c) { return shownRect(a).x - shownRect(c).x; });
      var n = list.length;
      var w = Math.round(Math.max(MIN_W, Math.min(NEW_W, b.w * 0.62 / n)));
      var top = Math.max(TOP, b.top);
      var bottom = b.h - EDGE - TRAY_H;
      var ctl = controlsRect();
      if (ctl && ctl.y > top) bottom = Math.min(bottom, ctl.y);
      var hh = Math.max(MIN_H, Math.round(bottom - GAP - top));
      var x = b.w - EDGE - w;
      for (var i = n - 1; i >= 0; i--) {
        list[i].rect = { x: Math.max(0, x), y: top, w: w, h: hh };
        applyRect(list[i]);
        x -= w + GAP;
      }
      persist();
    }

    // ── pick ────────────────────────────────────────────────────────────────

    function rectOf(el) {
      return el && el.isConnected ? plainRect(el.getBoundingClientRect()) : null;
    }

    function defaultAnchor() {
      if (!hidden && !trayEl.hidden && trayEl.isConnected) {
        var add = rectOf(trayEl.querySelector('.wbtray-add'));
        if (add) return add;
      }
      var actions = rectOf(slab ? slab.querySelector('[data-whiteboard-actions]') : null);
      if (actions) return actions;
      var r = slab ? slab.getBoundingClientRect() : { right: window.innerWidth, top: 0 };
      return { left: r.right - EDGE, top: r.top + EDGE, width: 0, height: 0 };
    }

    // The same picker as Actions ▸ Open terminal…, from the tray's + or ⌘A on a board
    // with nothing to show. Resolves the workspace opened, or null.
    //
    // One at a time: while this layer's picker is open, asking again (+ from the
    // keyboard, ⌘A with focus outside it) leaves that one as it is — the bundle would
    // otherwise close it and open a fresh one in its place, losing what was typed.
    function pick(anchor) {
      if (picking) return picking;
      var a = api();
      if (!a || typeof a.pickWorkspace !== 'function' || destroyed) return Promise.resolve(null);
      var b = board();
      var at = anchor && typeof anchor === 'object' ? plainRect(anchor) : defaultAnchor();
      // The picker reads its own list; this keeps the headers' folders as fresh as it.
      loadChoices(true);
      var asked;
      try {
        asked = a.pickWorkspace(at, {
          title: OPEN_TITLE,
          footer: OPEN_FOOTER,
          current: (b && cleanWs(b.workspace)) || null,
          currentLabel: 'This board’s workspace',
          status: statusMap(),
        });
      } catch (err) {
        console.error('[switchboard] wbterminals: pick:', err);
        return Promise.resolve(null);
      }
      var mine = Promise.resolve(asked).then(function (wsId) {
        if (picking === mine) picking = null;
        var ws = cleanWs(wsId);
        if (!ws) pickClosedAt = now();
        if (!ws || destroyed) return null;
        open(ws);
        return ws;
      }, function () {
        if (picking === mine) picking = null;
        pickClosedAt = now();
        return null;
      });
      picking = mine;
      return mine;
    }

    function now() {
      return window.performance && typeof performance.now === 'function' ? performance.now() : Date.now();
    }

    // The tray's +, pressed while its picker is open: a toggle. The picker closes on
    // any press outside it, this one included, so by the click the picker is gone and
    // the + would open a fresh one — it could never be put away from its own button,
    // only flicker. (The bundle also swallows a press on the rectangle it was anchored
    // to; this covers a + that is not exactly there any more.) A click whose own
    // pointerdown closed the picker opens nothing. Keyboard clicks have no pointerdown
    // and always open (pick() keeps an open picker as it is).
    function addPressed(e) {
      addPress = { at: e.timeStamp };
    }

    function addClicked(e, add) {
      var press = addPress;
      addPress = null;
      if (press && e.detail > 0 && pickClosedAt >= press.at) return;
      pick(plainRect(add.getBoundingClientRect()));
    }

    // ── pin / float ─────────────────────────────────────────────────────────

    // Drops the panel onto the board where it is on screen. The editor answers with a
    // slot for the new node a frame later, and that is when the body moves (handoff).
    // It is told where the terminal's body is as well as the panel: the node is laid
    // out so its slot's body is exactly that rectangle, and the overlay's inset is the
    // panel's (wbterminals.css), so pinning moves no text and changes no cols/rows.
    function pin(t) {
      var b = board();
      if (b && b.archivedAt) return;
      var a = api();
      if (!a || typeof a.pinTerminal !== 'function' || !t.panel || !t.panel.isConnected) return;
      // Pin to board is pressed in the panel the user is working in; the terminal
      // keeps the keyboard once it lands on the board (the button goes with the panel).
      var refocus = hadFocus(t.panel);
      t.refocus = refocus;
      var ok = false;
      try {
        ok = !!a.pinTerminal(t.wsId, plainRect(t.panel.getBoundingClientRect()),
          plainRect(t.body.getBoundingClientRect()));
      } catch (err) { console.error('[switchboard] wbterminals: pin:', err); }
      if (!ok) { t.refocus = false; return; }    // already on the board: the editor showed that node instead
      if (t.pinning) clearTimeout(t.pinning);
      // A slot that never comes (no editor) leaves the panel floating, which is
      // where it was.
      t.pinning = setTimeout(function () { t.pinning = null; t.refocus = false; }, 2000);
      var slotsNow = typeof a.terminalSlots === 'function' ? safeSlots(a) : null;
      if (slotsNow && slotsNow.some(function (s) { return s && s.wsId === t.wsId; })) slots(slotsNow);
    }

    function safeSlots(a) {
      try { return a.terminalSlots(); } catch (_) { return null; }
    }

    // A slot for a terminal that is floating here: the user pinned it, or an undo put
    // its node back. Either way the node wins and the SAME body moves into the
    // overlay — no remount, no clear, no reconnect.
    //
    // Only this layer's own Pin to board keeps the cols/rows the panel has: pin() had
    // the node laid out so its body is the panel's body, at the font the panel has, so
    // that grid fits it exactly and the pty is not resized. A node that comes back any
    // other way — an undo or redo of a Float or a Pin, or a slot for a workspace open()
    // has just floated — brings its own size and font, which the panel's grid was never
    // fitted to (the panel was refitted at the base font at another zoom, or resized):
    // kept, its last rows and right columns would be cut off. That one gets the grid
    // this Mac last fixed for the node (savedGrid), else one fitted once at the slot's
    // font (settleFixed), as a terminal restored with its board does.
    function handoff(t, s) {
      var had = hadFocus(t.body) || !!t.refocus;
      var own = !!t.pinning;
      t.refocus = false;
      if (t.pinning) { clearTimeout(t.pinning); t.pinning = null; }
      var tm = term();
      var x = tm && typeof tm.xterm === 'function' ? tm.xterm(t.wsId) : null;
      t.fixed = own && holds(t) && x ? { cols: x.cols, rows: x.rows } : null;
      t.mode = 'pin';
      t.minimized = false;
      t.font = round4(s.font) || BASE_FONT;
      t.size = null;
      unmountPanel(t);
      layoutPin(t, s, true);
      if (had && t.live) focusSoon(t);
    }

    // The node's Float button: lift it out at the same spot. The wsId is marked first,
    // so the slot list that arrives without it (the editor's answer to unpinTerminal)
    // is not taken for a removal, and a stale one that still has it does not pin the
    // panel straight back.
    function float(wsId) {
      var ws = cleanWs(wsId);
      if (!ws || destroyed) return false;
      markFloating(ws);
      var t = terms.get(ws);
      // Float is pressed in the node's header: the keyboard was with this terminal,
      // and the button is about to leave with the node, so it follows the terminal.
      var refocus = (!!t && hadFocus(t.body)) || nodeFocused(ws);
      // Where the terminal's text sits on the board right now. The node's outer rect is
      // the body plus the node's own header and insets — not a panel's — so a panel put
      // at that rect would shift the text and grow by a column on every Pin → Float. The
      // panel is lined up on this body instead (toFloat), the exact inverse of pin().
      var want = t ? bodyOnBoard(t) : null;
      var a = api();
      var rect = null;
      try { rect = a && typeof a.unpinTerminal === 'function' ? a.unpinTerminal(ws) : null; }
      catch (err) { console.error('[switchboard] wbterminals: float:', err); }
      var at = rect ? toSlab(rect) : null;
      if (!at && t && t.pin && t.pin.isConnected) at = toSlab(t.pin.getBoundingClientRect());
      if (!t) t = entry(ws, 'float');
      toFloat(t, at, refocus, want);
      return true;
    }

    // Where a pinned terminal's text is on screen right now (client px): its body in
    // the overlay, which sits on the node's body. Null while the node shows its own
    // card (not live), when there is no body on the board to line a panel up on.
    function bodyOnBoard(t) {
      return t.pin && t.body.parentNode === t.pin && t.body.isConnected
        ? plainRect(t.body.getBoundingClientRect()) : null;
    }

    // Focus is on this board's pinned node for wsId — its header's Float button.
    function nodeFocused(wsId) {
      var a = document.activeElement;
      var node = a && slab && slab.contains(a) && typeof a.closest === 'function' ? a.closest('[data-terminal-node]') : null;
      return !!node && node.getAttribute('data-terminal-node') === wsId;
    }

    function markFloating(ws) {
      if (floating.has(ws)) clearTimeout(floating.get(ws));
      floating.set(ws, setTimeout(function () { floating['delete'](ws); }, 1500));
    }

    function toFloat(t, at, refocus, want) {
      var had = hadFocus(t.body) || !!refocus;
      if (t.resizing) holdOff(t);
      if (t.pinning) { clearTimeout(t.pinning); t.pinning = null; }
      t.mode = 'float';
      t.fixed = null;
      t.font = BASE_FONT;
      t.size = null;
      t.live = false;
      t.minimized = false;
      t.rect = at ? fit(at) : nextRect();
      if (hidden) setHidden(false);
      lastOpened = t.wsId;
      mountPanel(t);
      if (t.pin && t.pin.parentNode) t.pin.parentNode.removeChild(t.pin);
      alignBody(t, want);
      front(t);
      // Back to the base font, fitted to the panel: the one pty resize floating costs.
      if (visible) placeT(t);
      if (had) focusSoon(t);
      changed();
    }

    // Move and size a just-floated panel so its body covers `want` (client px), the
    // rect the terminal's text had on the board. Measured rather than computed from the
    // CSS, so the header's height and the body's borders never have to be repeated here.
    // One correction pass, then the usual clamp to the slab.
    function alignBody(t, want) {
      if (!want || !t.panel || !t.panel.isConnected || t.body.parentNode !== t.panel) return;
      var got = t.body.getBoundingClientRect();
      if (!got.width || !got.height || !t.rect) return;
      t.rect = fit({
        x: t.rect.x + (want.left - got.left),
        y: t.rect.y + (want.top - got.top),
        w: t.rect.w + (want.width - got.width),
        h: t.rect.h + (want.height - got.height),
      });
      applyRect(t);
    }

    // ── pinned overlays ─────────────────────────────────────────────────────

    function holdOff(t) {
      t.resizing = false;
      var tm = term();
      if (tm && typeof tm.hold === 'function') tm.hold(t.wsId, false, owner);
    }

    function buildPin(t) {
      var ws = t.wsId;
      var el = h('div.wbpin', { role: 'group', 'aria-label': ws + ' terminal', 'data-wb-terminal': ws });
      el.addEventListener('keydown', keyRule);
      // A pinch (ctrl+wheel) is the canvas's, so zooming works wherever the pointer is:
      // it is handed to the React Flow pane underneath, as if the overlay were not
      // there. Caught on the way down, so xterm never scrolls its scrollback on a pinch
      // first. A plain wheel goes on to xterm, which scrolls, and stops on the way back
      // up, like a floating panel's.
      el.addEventListener('wheel', function (e) {
        if (!e.ctrlKey) return;
        e.preventDefault();
        e.stopPropagation();
        forwardWheel(e);
      }, { capture: true, passive: false });
      el.addEventListener('wheel', function (e) { e.stopPropagation(); });
      el.addEventListener('focusin', function () {
        if (typeof SB.bell === 'function') SB.bell(ws, false);
      });
      t.pin = el;
      return el;
    }

    function paneAt(x, y) {
      var stack = typeof document.elementsFromPoint === 'function' ? document.elementsFromPoint(x, y) : [];
      for (var i = 0; i < stack.length; i++) {
        var el = stack[i];
        if (el.classList && el.classList.contains('react-flow__pane') && slab && slab.contains(el)) return el;
      }
      return slab ? slab.querySelector('.react-flow__pane') : null;
    }

    function forwardWheel(e) {
      var pane = paneAt(e.clientX, e.clientY);
      if (!pane) return;
      try {
        pane.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true, composed: true,
          clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
          deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ, deltaMode: e.deltaMode,
          ctrlKey: true, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey,
        }));
      } catch (err) { console.error('[switchboard] wbterminals: wheel:', err); }
    }

    // Every pinned overlay is clipped to the React Flow pane — the layer itself sits
    // on the pane's rectangle with overflow hidden — so a node half off the canvas
    // never draws its terminal over the bar or the slab's edge.
    function placeLayer(clip, at) {
      if (!clip || !slab || !at) { pinsEl.style.display = 'none'; return; }
      var s = pinsEl.style;
      s.display = '';
      s.left = Math.round(clip.left - at.left) + 'px';
      s.top = Math.round(clip.top - at.top) + 'px';
      s.width = Math.max(0, Math.round(clip.right - clip.left)) + 'px';
      s.height = Math.max(0, Math.round(clip.bottom - clip.top)) + 'px';
    }

    function sameSize(a, b) {
      return !!a && !!b && a.width === b.width && a.height === b.height;
    }

    // The node's committed size, from a slot that is not refitting it now (live
    // resizes have their own path in layoutPin). A grid is fixed for the size the node
    // had; a different one — a resize finished while the node could not show its
    // terminal (below the font floor, folded, minimized), or an undo or redo of one —
    // means that grid no longer fits the box. It is dropped, so the way back works out
    // the one for the new box (savedGrid, else settleFixed) instead of clipping the
    // old one into it, and persist() never files the old grid under the new size.
    function takeSize(t, s) {
      if (s.size && t.size && t.fixed && !sameSize(s.size, t.size)) t.fixed = null;
      t.size = s.size ? { width: s.size.width, height: s.size.height } : null;
    }

    // One slot: where the node's body is on screen right now. Integer left/top/
    // width/height, no transform; the font follows the zoom; cols/rows are fixed and
    // change only when the node's committed size does (resize end).
    function layoutPin(t, s, placing) {
      if (!t.pin) buildPin(t);
      var el = t.pin;
      var font = round4(s.font) || BASE_FONT;
      // The node's own font, in canvas units: what a saved grid is matched against.
      var zoom = Number(s.zoom);
      if (zoom > 0 && Number(s.font) > 0) t.nodeFont = Math.round(Number(s.font) / zoom * 1000) / 1000;
      var st = el.style;
      st.left = Math.round(s.body.left - s.clip.left) + 'px';
      st.top = Math.round(s.body.top - s.clip.top) + 'px';
      st.width = Math.max(0, Math.round(s.body.width)) + 'px';
      st.height = Math.max(0, Math.round(s.body.height)) + 'px';
      st.setProperty('--wbz', String(font / BASE_FONT));
      // A toolbar, menu or document panel of the canvas is over this terminal: hide
      // it for that long rather than detach it — nothing is refitted for a menu.
      st.visibility = s.covered ? 'hidden' : '';
      el.classList.toggle('sel', !!s.selected);

      if (!s.live) {
        // Folded, minimized, below the font floor, or a workspace that left the rail:
        // the node draws its own card, and the host is free for anyone else.
        if (t.resizing) holdOff(t);
        if (t.body.parentNode) t.body.parentNode.removeChild(t.body);
        if (el.parentNode) el.parentNode.removeChild(el);
        t.live = false;
        if (s.size) takeSize(t, s);
        return;
      }

      var tm = term();
      var back = !t.live || el.parentNode !== pinsEl || t.body.parentNode !== el;
      if (el.parentNode !== pinsEl) pinsEl.appendChild(el);
      if (t.body.parentNode !== el) el.appendChild(t.body);
      t.live = true;

      if (back || placing) {
        t.font = font;
        takeSize(t, s);
        t.resizing = !!s.resizing;
        // A terminal restored with its board (or back from a stand-in) takes the grid
        // it had at this size before, if it has one, rather than one fitted at today's
        // zoom: the tmux session still has that grid, so nothing is resized.
        if (!t.fixed) t.fixed = savedGrid(t);
        // Back on screen (or just pinned): the overlay is a host again. place() sets
        // the mode whole, the font and grid included — and yields, with a stand-in,
        // when the Grid or another board took the terminal while this one was away.
        if (visible && slab && slab.isConnected) placeT(t);
        if (t.resizing && tm) tm.hold(t.wsId, true, owner);
        if (t.fixed) persist();
        return;
      }

      if (font !== t.font) {
        t.font = font;
        if (tm) tm.setFontSize(t.wsId, font, owner);
      }
      var wasResizing = t.resizing;
      t.resizing = !!s.resizing;
      if (t.resizing && !wasResizing && tm) tm.hold(t.wsId, true, owner);
      var resized = !!s.size && !sameSize(s.size, t.size);
      t.size = s.size ? { width: s.size.width, height: s.size.height } : t.size;
      if (!t.resizing && (wasResizing || resized) && tm && holds(t)) {
        // The node's size was committed: a new grid for the new box, at this font.
        var p = tm.propose(t.wsId);
        if (p && tm.setFixed(t.wsId, p, owner)) {
          t.fixed = p;
          tm.setFontSize(t.wsId, font, owner);
          persist();
        }
      }
      if (!t.resizing && wasResizing && tm) tm.hold(t.wsId, false, owner);
      if (visible && needsPlace(t)) placeT(t);
    }

    // ── what is drawn over a pinned terminal ────────────────────────────────

    // The overlays sit above the whole canvas, so whatever the canvas draws over a
    // pinned node has to be cut out of its overlay to be seen and clicked: the canvas's
    // own chrome (slot.holes — the tool rail, the undo strip, the zoom controls), and
    // any pinned node stacked above this one (React Flow lifts the selected node). The
    // overlays themselves are ordered the way their nodes are, so where two overlap the
    // node drawn on top owns the keyboard and the pointer.
    function stack(arr, at) {
      if (!at) return;
      var ranks = null;
      var outers = null;
      if (arr.length > 1) {
        // The nodes' own order on the canvas: React Flow's z (the selected one is
        // raised) and then document order, which is the order nodes are drawn in. The
        // slot's `selected` is read first, as it can be a frame ahead of the DOM.
        var byId = Object.create(null);
        var nodes = slab.querySelectorAll('.react-flow__node');
        for (var i = 0; i < nodes.length; i++) byId[nodes[i].getAttribute('data-id')] = { el: nodes[i], i: i };
        var order = arr.map(function (s, k) {
          var n = byId[s.nodeId];
          return {
            s: s, el: n ? n.el : null,
            key: [s.selected ? 1 : 0, n ? (parseFloat(n.el.style.zIndex) || 0) : 0, n ? n.i : nodes.length + k],
          };
        });
        order.sort(function (a, b) {
          for (var j = 0; j < 3; j++) if (a.key[j] !== b.key[j]) return a.key[j] - b.key[j];
          return 0;
        });
        ranks = Object.create(null);
        outers = [];
        order.forEach(function (o, k) {
          ranks[o.s.nodeId] = k;
          outers.push(outerOf(o.s, o.el));
        });
      }
      arr.forEach(function (s) {
        var t = terms.get(cleanWs(s.wsId));
        if (!t || t.mode !== 'pin' || !t.pin || !t.live || t.pin.parentNode !== pinsEl) return;
        var holes = Array.isArray(s.holes) ? s.holes.slice() : [];
        var z = '';
        if (ranks && s.nodeId in ranks) {
          var mine = ranks[s.nodeId];
          for (var k = mine + 1; k < outers.length; k++) if (outers[k]) holes.push(outers[k]);
          z = String(mine + 1);
        }
        if (t.pin.style.zIndex !== z) t.pin.style.zIndex = z;
        clipPin(t, s, at, holes);
      });
    }

    // A pinned node's whole box on screen with its selection ring and resize handles,
    // from the node itself, else worked out from its slot (the body sits under the
    // header and a few pixels in from the other three edges).
    function outerOf(s, el) {
      var r = el ? el.getBoundingClientRect() : null;
      if (r && r.width && r.height) {
        return { left: r.left - HOLE_PAD, top: r.top - HOLE_PAD, right: r.right + HOLE_PAD, bottom: r.bottom + HOLE_PAD };
      }
      var z = Number(s.zoom) || 1;
      var inset = 5, header = 30 * z;       // FlowEditor's TERMINAL_BODY_INSET and TERMINAL_HEADER
      return {
        left: s.body.left - inset - HOLE_PAD, top: s.body.top - header - HOLE_PAD,
        right: s.body.left + s.body.width + inset + HOLE_PAD, bottom: s.body.top + s.body.height + inset + HOLE_PAD,
      };
    }

    // clip-path: path(evenodd, '<overlay> <holes>') in the overlay's own integer
    // pixels — a clip, never a transform, so the text stays crisp; and a clipped-out
    // area takes no pointer either, so the chrome under it is clickable.
    function clipPin(t, s, at, holes) {
      var ox = at.left + Math.round(s.clip.left - at.left) + Math.round(s.body.left - s.clip.left);
      var oy = at.top + Math.round(s.clip.top - at.top) + Math.round(s.body.top - s.clip.top);
      var w = Math.max(0, Math.round(s.body.width));
      var hh = Math.max(0, Math.round(s.body.height));
      var cut = [];
      holes.forEach(function (r) {
        if (!r || ![r.left, r.top, r.right, r.bottom].every(function (n) { return typeof n === 'number' && isFinite(n); })) return;
        var x1 = Math.min(Math.max(Math.floor(r.left - ox), 0), w);
        var x2 = Math.min(Math.max(Math.ceil(r.right - ox), 0), w);
        var y1 = Math.min(Math.max(Math.floor(r.top - oy), 0), hh);
        var y2 = Math.min(Math.max(Math.ceil(r.bottom - oy), 0), hh);
        if (x2 > x1 && y2 > y1) cut.push({ x1: x1, y1: y1, x2: x2, y2: y2 });
      });
      var value = '';
      if (cut.length) {
        var d = 'M0 0H' + w + 'V' + hh + 'H0Z';
        disjoint(cut).forEach(function (r) {
          d += 'M' + r.x1 + ' ' + r.y1 + 'H' + r.x2 + 'V' + r.y2 + 'H' + r.x1 + 'Z';
        });
        value = "path(evenodd, '" + d + "')";
      }
      if (t.clipped === value) return;
      t.clipped = value;
      t.pin.style.clipPath = value;
    }

    // Under evenodd two holes that overlap would cancel out where they do, drawing the
    // terminal again there; holes that overlap are cut on a grid of their own edges
    // into pieces that do not.
    function disjoint(rects) {
      var overlap = false;
      for (var i = 0; i < rects.length && !overlap; i++) {
        for (var j = i + 1; j < rects.length; j++) {
          var a = rects[i], b = rects[j];
          if (a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2) { overlap = true; break; }
        }
      }
      if (!overlap) return rects;
      function edges(k1, k2) {
        var out = [];
        rects.forEach(function (r) { out.push(r[k1], r[k2]); });
        return out.sort(function (p, q) { return p - q; }).filter(function (v, n, all) { return !n || all[n - 1] !== v; });
      }
      var xs = edges('x1', 'x2');
      var ys = edges('y1', 'y2');
      var pieces = [];
      for (var yi = 0; yi < ys.length - 1; yi++) {
        var run = null;
        for (var xi = 0; xi < xs.length - 1; xi++) {
          var cx = (xs[xi] + xs[xi + 1]) / 2, cy = (ys[yi] + ys[yi + 1]) / 2;
          var inside = rects.some(function (r) { return cx > r.x1 && cx < r.x2 && cy > r.y1 && cy < r.y2; });
          if (!inside) { run = null; continue; }
          if (run && run.x2 === xs[xi]) { run.x2 = xs[xi + 1]; continue; }
          run = { x1: xs[xi], y1: ys[yi], x2: xs[xi + 1], y2: ys[yi + 1] };
          pieces.push(run);
        }
      }
      return pieces;
    }

    function validSlot(s) {
      return !!s && typeof s === 'object' && !!cleanWs(s.wsId) && !!s.body && !!s.clip &&
        ['left', 'top', 'width', 'height'].every(function (k) { return isFinite(Number(s.body[k])); }) &&
        ['left', 'top', 'right', 'bottom'].every(function (k) { return isFinite(Number(s.clip[k])); });
    }

    // From the bundle, at most once a frame: the pinned terminals on this board's
    // canvas and where they are. Builds and positions DOM; it places a terminal only
    // when the slab is on screen (a board parked in the cache must never pull the host
    // into a slab that is not in the document).
    function slots(list) {
      if (destroyed) return;
      var arr = Array.isArray(list) ? list.filter(validSlot) : [];
      var seen = Object.create(null);
      var structural = false;
      var at = slab ? slab.getBoundingClientRect() : null;
      placeLayer(arr.length ? arr[0].clip : null, at);
      arr.forEach(function (s) {
        var ws = cleanWs(s.wsId);
        if (floating.has(ws) || seen[ws]) return;
        seen[ws] = true;
        var t = terms.get(ws);
        if (!t) {
          t = entry(ws, 'pin');
          t.font = round4(s.font) || BASE_FONT;
          ensureScanned(ws);
          structural = true;
          layoutPin(t, s, true);
          return;
        }
        if (t.mode === 'float') {
          structural = true;
          handoff(t, s);
          return;
        }
        layoutPin(t, s, false);
      });
      stack(arr, at);
      // The editor's answer to float(): once a list no longer has the node, the mark
      // has done its job.
      floating.forEach(function (timer, ws) {
        if (!arr.some(function (s) { return s.wsId === ws; })) {
          clearTimeout(timer);
          floating['delete'](ws);
        }
      });
      // A node that left with no removal event — the editor unmounted (archived,
      // missing or unreadable board) — just lets go of its terminal. It is still in
      // the board file and comes back with the editor's next list.
      terms.forEach(function (t) {
        if (t.mode !== 'pin' || seen[t.wsId]) return;
        forget(t);
        structural = true;
      });
      if (structural) changed();
    }

    // FlowEditor's onTerminalRemoved, passed through by the host: a pinned node left
    // the canvas some other way than Float. An undo puts the terminal back where it
    // floated from; Delete, Cut and the node's Close close it (the shell lives on).
    function removed(wsId, reason, rect) {
      var ws = cleanWs(wsId);
      if (!ws || destroyed || floating.has(ws)) return;
      var t = terms.get(ws);
      if (reason === 'undo') {
        if (t && t.mode === 'float') return;
        // `rect` is the node's outer rect: its body plus the node's header and insets,
        // not a panel's. Put there as it is, the panel would shift the text and refit
        // the pty to a new grid. It is lined up on the body instead, as float() does —
        // read now, while the overlay is still over the node (the editor reports this
        // from inside its undo, before the next slots).
        var want = t ? bodyOnBoard(t) : null;
        if (!t) t = entry(ws, 'float');
        toFloat(t, rect ? toSlab(rect) : null, false, want);
        return;
      }
      if (t && t.mode === 'pin') {
        var had = hadFocus(t.body);
        forget(t);
        if (had) focusNext(null);
        changed();
      }
    }

    // ── the tray ────────────────────────────────────────────────────────────

    function chip(t) {
      var ws = t.wsId;
      var kind = t.mode === 'pin' ? 'pin' : (t.minimized ? 'min' : 'on');
      var label = ws + (kind === 'min' ? ', minimized' : (kind === 'pin' ? ', pinned' : ''));
      var title = kind === 'min' ? 'Restore ' + ws : (kind === 'pin' ? 'Show ' + ws + ' on the whiteboard' : 'Bring ' + ws + ' to the front');
      var dot = h('span.dot', { hidden: true });
      var el = h('button.wbchip.' + kind, {
        type: 'button', 'aria-label': label, title: title, 'data-ws': ws,
        onClick: function () { chipClick(ws); },
      }, dot, h('span.wbchip-ws', null, ws),
        kind === 'min' ? iconOr('chevU', '') : null,
        kind === 'pin' ? iconOr('pin', '') : null);
      paintDot(dot, ws);
      return el;
    }

    // The rail's dot for that workspace (SB.dotFor), with a word for a screen reader
    // and the pointer. Nothing is drawn while the rail would draw nothing.
    function paintDot(el, wsId) {
      var dot = dotOf(wsOf(wsId) || { id: wsId });
      var cls = 'dot' + (dot ? ' ' + dot : '');
      if (el.className === cls && el.hidden === !dot) return;
      el.className = cls;
      el.hidden = !dot;
      if (dot && DOT_TITLES[dot]) el.title = DOT_TITLES[dot];
      else el.removeAttribute('title');
    }

    function chipClick(wsId) {
      var t = terms.get(wsId);
      if (!t) return;
      if (t.mode === 'pin') { reveal(wsId); return; }
      if (t.minimized || hidden || !t.panel || !t.panel.isConnected) { restore(t); return; }
      front(t);
      focusSoon(t);
    }

    // The tray shares the slab's bottom edge with two pieces of the canvas: the zoom
    // controls in the corner, which wbterminals.css lifts above the tray while it
    // shows, and the undo/redo/Saved strip in the middle, which it must never run
    // under. Its width is capped at the room right of whatever of that strip sits in
    // the tray's row (the strip grows while an answer is on its way), and its chips
    // scroll inside; when even that is too narrow the word "Terminals" goes first.
    function fitTray() {
      if (destroyed || !slab || trayEl.hidden || !trayEl.isConnected) return;
      var at = slab.getBoundingClientRect();
      if (!at.width || !at.height) return;
      var room = at.width - 2 * EDGE;
      watchStrip(slab.querySelector('.react-flow__panel.bottom.center'));
      if (strip) {
        var row = at.bottom - EDGE - TRAY_H - GAP;
        Array.prototype.forEach.call(strip.children, function (c) {
          var r = c.getBoundingClientRect();
          if (r.width && r.height && r.bottom > row) room = Math.min(room, at.right - EDGE - GAP - r.right);
        });
      }
      var w = Math.max(TRAY_MIN, Math.floor(room)) + 'px';
      if (trayEl.style.maxWidth !== w) trayEl.style.maxWidth = w;
      var chips = trayEl.querySelector('.wbtray-chips');
      var over = function () { return !!chips && chips.scrollWidth > chips.clientWidth + 1; };
      trayEl.classList.remove('tight', 'scrolls');
      if (over()) trayEl.classList.add('tight');
      if (over()) trayEl.classList.add('scrolls');
    }

    // The strip is the editor's, and comes and goes with it (an archived board has
    // none): whichever one is on the canvas now is the one watched.
    function watchStrip(el) {
      if (el === strip) return;
      if (stripObserver && strip) { try { stripObserver.unobserve(strip); } catch (_) { /* gone */ } }
      strip = el || null;
      if (stripObserver && strip) stripObserver.observe(strip);
    }

    function renderTray() {
      var list = Array.from(terms.values());
      if (!list.length || hidden) {
        trayEl.hidden = true;
        trayEl.replaceChildren();
        return;
      }
      // Rebuilt on every structural change, so keep focus on the chip (or button)
      // that had it — a keyboard user restoring a terminal from the tray stays there.
      var active = trayEl.contains(document.activeElement) ? document.activeElement : null;
      var keep = active ? (active.getAttribute('data-ws') || (active.classList.contains('wbtray-add') ? '+' :
        (active.classList.contains('wbtray-tile') ? 'tile' : null))) : null;
      var add = h('button.ib.wbtray-add', {
        type: 'button', title: 'Open another terminal', 'aria-label': 'Open another terminal',
        onClick: function (e) { addClicked(e, add); },
      }, iconOr('plus', '+'));
      add.addEventListener('pointerdown', addPressed);
      var tileBtn = h('button.ib.wbtray-tile', {
        type: 'button', title: 'Tile the open terminals', 'aria-label': 'Tile the open terminals',
        disabled: !openFloats().length,
        onClick: tile,
      }, iconOr('tile', 'Tile'));
      trayEl.replaceChildren(D.frag(
        h('span.wbtray-lbl', null, iconOr('termStack', ''), h('span.wbtray-word', null, 'Terminals')),
        // Only the chips scroll: Tile and + stay in reach however many there are.
        h('span.wbtray-chips', null, list.map(chip)),
        tileBtn,
        add));
      trayEl.hidden = false;
      fitTray();
      if (keep) {
        var back = keep === '+' ? add : (keep === 'tile' ? tileBtn : null);
        if (!back) {
          Array.prototype.some.call(trayEl.querySelectorAll('.wbchip'), function (c) {
            if (c.getAttribute('data-ws') === keep) { back = c; return true; }
            return false;
          });
        }
        if (back && !back.disabled) { try { back.focus({ preventScroll: true }); } catch (_) { back.focus(); } }
      }
    }

    // ── state out: the host, the board's Actions menu, localStorage ─────────

    function list() {
      var out = [];
      terms.forEach(function (t) {
        out.push({
          wsId: t.wsId,
          open: t.mode === 'float' && !t.minimized,
          minimized: t.mode === 'float' && t.minimized,
          pinned: t.mode === 'pin',
        });
      });
      return out;
    }

    // Floating terminals only, front-most last; pinned ones live in the board file.
    // Closed ones are not kept: a closed terminal has left the tray.
    //
    // Beside them, `grids`: the cols/rows each pinned terminal was fixed at, with the
    // node size and font they were worked out for. The node is in the board file; its
    // grid is this Mac's (it depends on the font's metrics) and is what the tmux
    // session still has. Reopened at another zoom, a pinned terminal keeps it — as a
    // zoom never resizes the pty, nor does quitting and coming back. A pin that is not
    // on the canvas right now (an archived board) keeps its entry for when it is.
    function persist() {
      if (!boardId || destroyed) return;
      var items = floats().slice().sort(function (a, b) { return a.z - b.z; }).map(function (t) {
        var r = t.rect || nextRect();
        return { wsId: t.wsId, minimized: !!t.minimized, open: !t.minimized,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) } };
      });
      var old = readStore(boardId);
      var grids = {};
      if (old) {
        Object.keys(old.grids).forEach(function (ws) {
          var t = terms.get(ws);
          if (!t || t.mode === 'pin') grids[ws] = old.grids[ws];
        });
      }
      terms.forEach(function (t) {
        if (t.mode !== 'pin' || !t.fixed || !t.size || !t.nodeFont) return;
        grids[t.wsId] = { cols: t.fixed.cols, rows: t.fixed.rows, w: t.size.width, h: t.size.height, font: t.nodeFont };
      });
      var keep = Object.keys(grids).length > 0;
      try {
        if (!items.length && !hidden && !keep) window.localStorage.removeItem(STORE + boardId);
        else {
          var data = { hidden: hidden, items: items };
          if (keep) data.grids = grids;
          window.localStorage.setItem(STORE + boardId, JSON.stringify(data));
        }
      } catch (_) { /* a full or blocked store costs the arrangement, not the terminals */ }
    }

    // The grid this pinned terminal had when its node was last this size at this font.
    function savedGrid(t) {
      if (!t.size || !t.nodeFont) return null;
      var saved = readStore(boardId);
      var g = saved && saved.grids[t.wsId];
      if (!g || g.w !== t.size.width || g.h !== t.size.height || Math.abs(g.font - t.nodeFont) > 0.02) return null;
      return { cols: g.cols, rows: g.rows };
    }

    function changed() {
      if (destroyed) return;
      ensureLayers();
      renderTray();
      persist();
      var next = list();
      var sig = JSON.stringify(next);
      if (sig === told) return;
      told = sig;
      try { onChange(next); } catch (err) { console.error('[switchboard] wbterminals: change:', err); }
    }

    // Headers, chips and the pin button's archived state, in place, after every
    // render: cheap, and it is how a bell or a scan reaches an open panel.
    function repaint() {
      if (destroyed) return;
      terms.forEach(function (t) { if (t.els) paintHead(t); });
      Array.prototype.forEach.call(trayEl.querySelectorAll('.wbchip'), function (c) {
        var d = c.querySelector('.dot');
        if (d) paintDot(d, c.getAttribute('data-ws'));
      });
    }

    // ── shown ───────────────────────────────────────────────────────────────

    // After every render, with whether this slab is on screen. On screen: take the
    // host back into whichever panels and overlays need it (yielding to anyone who has
    // it), repaint headers, keep panels inside a slab that may have changed size, and
    // ask the editor for its slots when the board has just come back into view. Off
    // screen: nothing moves — the host stays wherever it is.
    function shown(on) {
      if (destroyed) return;
      var was = visible;
      visible = !!on;
      if (!visible) return;
      ensureLayers();
      repaint();
      fitTray();
      if (!was) {
        // The slab may have changed size while it was away (the slab's observer
        // keeps panels inside it while it is here).
        floats().forEach(function (t) { if (t.panel && t.panel.isConnected) applyRect(t); });
        var a = api();
        if (a && typeof a.terminalSlots === 'function') {
          var now = safeSlots(a);
          if (Array.isArray(now)) slots(now);
        }
      }
      terms.forEach(function (t) {
        if (t.mode === 'float' && (t.minimized || hidden || !t.panel || !t.panel.isConnected)) return;
        if (t.mode === 'pin' && (!t.live || !t.pin || !t.pin.isConnected)) return;
        if (needsPlace(t)) placeT(t);
      });
    }

    function shows(wsId) {
      var t = terms.get(wsId);
      return !!t && visible && t.body.isConnected && holds(t);
    }

    function focused(wsId) {
      var t = terms.get(wsId);
      return !!t && t.body.isConnected && hadFocus(t.body);
    }

    function contains(el) {
      if (!(el instanceof Node)) return false;
      return termsEl.contains(el) || pinsEl.contains(el) || trayEl.contains(el);
    }

    function destroy() {
      if (destroyed) return;
      terms.forEach(function (t) {
        endGesture(t);
        if (t.resizing) holdOff(t);
        if (t.pinning) clearTimeout(t.pinning);
        if (t.body.parentNode) t.body.parentNode.removeChild(t.body);
      });
      floating.forEach(function (timer) { clearTimeout(timer); });
      floating.clear();
      if (refitTimer) { clearTimeout(refitTimer); refitTimer = null; }
      destroyed = true;
      terms.clear();
      if (observer) { try { observer.disconnect(); } catch (_) { /* already gone */ } }
      [termsEl, pinsEl, trayEl].forEach(function (el) { if (el.parentNode) el.parentNode.removeChild(el); });
      if (stripObserver) { try { stripObserver.disconnect(); } catch (_) { /* already gone */ } }
      strip = null;
      layers['delete'](self);
    }

    // ── restore ─────────────────────────────────────────────────────────────

    // The arrangement this board's floating terminals had, once main has said which
    // workspaces are still in the rail (a terminal for one that left would only fail
    // to open). DOM only: the next shown(true) places them.
    function restoreSaved() {
      var saved = readStore(boardId);
      if (!saved || !saved.items.length) return;
      function apply() {
        if (destroyed) return;
        var any = false;
        saved.items.forEach(function (it) {
          if (terms.has(it.wsId) || known(it.wsId) === false) return;
          var t = entry(it.wsId, 'float');
          t.rect = it.rect;
          t.minimized = it.minimized;
          t.z = ++zTop;
          ensureScanned(it.wsId);
          ensurePanel(t);
          t.panel.style.zIndex = String(t.z);
          if (!t.minimized) lastOpened = it.wsId;
          any = true;
        });
        hidden = !!saved.hidden && openFloats().length > 0;
        if (!hidden) openFloats().forEach(mountPanel);
        var top = null;
        openFloats().forEach(function (t) { if (!top || t.z > top.z) top = t; });
        if (top) front(top);
        if (any || saved.hidden !== hidden) changed();
        if (visible) {
          visible = false;      // so shown() treats this as coming into view
          shown(true);
        }
      }
      // A terminal for a workspace this session's list does not have may be one added
      // to the rail since that list was fetched: ask once more before dropping it.
      loadChoices(false).then(function () {
        var stale = saved.items.some(function (it) { return known(it.wsId) === false; });
        return stale ? loadChoices(true) : null;
      }).then(apply, apply);
    }

    if (slab) {
      ensureLayers();
      if (typeof ResizeObserver === 'function') {
        // The window, the Grid square or full screen changed the slab: keep every
        // panel inside it. DOM only; the panel's own observer refits its terminal.
        observer = new ResizeObserver(function () {
          if (destroyed) return;
          floats().forEach(function (t) { if (t.panel && t.panel.isConnected) applyRect(t); });
          fitTray();
        });
        observer.observe(slab);
        stripObserver = new ResizeObserver(function () { if (!destroyed) fitTray(); });
      }
    }
    var self = { repaint: repaint, lost: lost };
    layers.add(self);
    loadChoices(false);
    restoreSaved();

    return {
      boardId: boardId,
      owner: owner,
      open: open,
      toggleAll: toggleAll,
      pick: pick,
      slots: slots,
      float: float,
      removed: removed,
      shown: shown,
      shows: shows,
      focused: focused,
      contains: contains,
      list: list,
      tile: tile,
      destroy: destroy,
    };
  }

  SB.wbTerminals = { attach: attach };
})(window.SB);
