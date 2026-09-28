// SB.views.grid — the Grid screen: four terminals side by side, in views the user
// makes. "Sample" is sample-1 to sample-4 in the four squares; "Everything else"
// is whatever is left. It is the two iTerm2 windows of four panes each that the
// Terminal tab replaced one at a time, brought back as one screen.
//
// A square IS that workspace's Terminal. views/terminal.js keeps one xterm and one
// shell per workspace and mount() moves the same host here, so the pane you open
// in a square is the pane that workspace's own Terminal tab shows, scrollback and
// all — nothing is duplicated and nothing is restarted by looking at it from here.
//
// The data (views, which one is showing) belongs to app.js — SB.grid — because
// views never write state. What lives here is only what a rebuild would otherwise
// lose: the name being typed, the square that is choosing, the Delete that has
// been clicked once, the view whose terminals are being edited. Every render is a
// fresh tree, as everywhere else in the app.
window.SB = window.SB || {};

(function (SB) {
  'use strict';

  var D = SB.dom;
  var h = D.h;

  var CELLS = 4;
  var NOTE_KEY = 'switchboard.grid.notes';     // the squares showing a note, by workspace id

  var editing = null;     // null | { mode: 'new' | 'rename', id, text, fresh }
  var picking = null;     // null | { viewId, index } — the square that is choosing
  var armed = null;       // the view whose Delete has been clicked once
  var menu = null;        // the view whose ⋯ menu is open
  var menuFresh = false;  // the menu was just opened: its first item gets focus, once
  var wanted = null;      // the workspace just put in a square: its terminal gets focus
  var arranging = null;   // the view whose terminals are being edited: the × shows, Add does not
  var arrangeFresh = false; // the edit was just entered: Done gets focus, once
  var choosing = false;   // the folder sheet is up: a second click must not raise a second one
  // Which squares are showing their workspace's note instead of its terminal, by
  // workspace id rather than by square: the same workspace can sit in two views, and a
  // scratch pad is about the workspace, not about where it happens to be on screen.
  // Remembered across launches the way the shown view is — it is a choice, not a mode.
  var noted = readNoted();

  function readNoted() {
    try {
      var got = JSON.parse(window.localStorage.getItem(NOTE_KEY) || '{}');
      return got && typeof got === 'object' && !Array.isArray(got) ? got : {};
    } catch (e) {
      return {};
    }
  }

  function saveNoted() {
    try { window.localStorage.setItem(NOTE_KEY, JSON.stringify(noted)); } catch (e) { /* storage off */ }
  }

  function showingNote(wsId) {
    return !!noted[wsId];
  }

  // The switch in a square's top-right corner. A square is EITHER the terminal or the
  // note, never both: four panes in a window is already the most it can hold, and the
  // point of the note is somewhere to look while the terminal is busy, not beside it.
  function noteToggle(wsId) {
    var on = showingNote(wsId);
    var has = SB.views.notes && typeof SB.views.notes.has === 'function' && SB.views.notes.has(wsId);
    return h('button.ib.nbtn' + (on ? '.on' : '') + (!on && has ? '.has' : ''), {
      type: 'button',
      title: on ? 'Show the terminal' : 'Show the note for ' + folderOrWs(wsId),
      'aria-label': on ? 'Show the terminal' : 'Show the note',
      'aria-pressed': on ? 'true' : 'false',
      onClick: function () { toggleNote(wsId); }
    }, D.icon(on ? 'term' : 'note'));
  }

  function folderOrWs(wsId) {
    return isFolder(wsId) ? folderName(wsId) : wsId;
  }

  function toggleNote(wsId) {
    if (noted[wsId]) delete noted[wsId];
    else noted[wsId] = true;
    saveNoted();
    // NOT `wanted`: that flag is consumed by landFocus, which bails — leaving it armed
    // — whenever a name is being typed, a square is choosing or the terminals are being
    // edited, and an arbitrary later render then pulls the keyboard into this square.
    // The click was on the switch, so this focuses what came up itself.
    SB.render();
    setTimeout(function () {
      if (noted[wsId]) {
        var notes = SB.views.notes;
        if (notes && typeof notes.focus === 'function') notes.focus(wsId);
      } else {
        var term = SB.views.terminal;
        if (term && typeof term.focus === 'function') term.focus(wsId);
      }
    }, 0);
  }

  function views() { return SB.grid ? SB.grid.views() : []; }
  function current() { return SB.grid ? SB.grid.current() : null; }
  function viewById(id) {
    var list = views();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  // A square holds a workspace id or, when the string is an absolute path, a FOLDER:
  // any folder on this Mac, chosen through the system's own chooser (§4.10). A folder
  // is a terminal and nothing more — not on the rail, not scanned, not startable — and
  // its path is its id everywhere a workspace id goes: the pane, the shell, the tmux
  // session, the bell. Nothing here has to know the difference except this file, which
  // draws the strip, and main, which opens the shell in the folder itself.
  function isFolder(id) { return typeof id === 'string' && id.charAt(0) === '/'; }

  // '/Users/x/Projects/foo' → 'foo'; the whole path is the strip's tooltip.
  function folderName(dir) {
    var parts = String(dir).replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || '/';
  }

  // ── naming a view ─────────────────────────────────────────────────────────

  function startEdit(mode, view) {
    editing = { mode: mode, id: view ? view.id : null, text: mode === 'rename' ? view.name : '', fresh: true };
    armed = null;
    picking = null;
    menu = null;
    arranging = null;
    SB.render();
  }

  function commitEdit() {
    if (!editing) return;
    var e = editing;
    editing = null;
    if (e.mode === 'new') SB.grid.create(e.text);
    else SB.grid.rename(e.id, e.text);
    SB.render();                      // an empty name creates nothing, and still needs the input gone
  }

  function cancelEdit() {
    editing = null;
    SB.render();
  }

  // The one text field in the app. Its value is kept in `editing` and put back on
  // every rebuild — a bell or a run state arriving mid-word must not eat the word.
  function nameInput() {
    var input = h('input.vname', {
      type: 'text',
      value: editing.text,
      placeholder: editing.mode === 'new' ? 'Name this view' : '',
      'aria-label': editing.mode === 'new' ? 'Name for the new view' : 'New name',
      spellcheck: 'false',
      autocomplete: 'off',
      onInput: function () { if (editing) editing.text = input.value; },
      onKeydown: function (e) {
        if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit(); }
      },
      onBlur: function () {
        // Deferred, and never decided from the event itself: Chromium blurs a focused
        // element BEFORE a rebuild detaches it, so at this moment the old input is
        // still connected and there is no relatedTarget — a bell arriving mid-word
        // would look exactly like the user leaving the field and commit half a name.
        // After the rebuild, focus is back in the new input (app.js restores it by
        // position) or it has really gone somewhere else.
        setTimeout(function () {
          if (!editing) return;
          var now = document.querySelector('.seg input.vname');
          if (now && document.activeElement === now) return;
          if (editing.text.trim()) commitEdit();
          else cancelEdit();
        }, 0);
      }
    });
    return input;
  }

  function focusInput() {
    var el = document.querySelector('.seg input.vname');
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); }
    el.select();
  }

  // ── header ────────────────────────────────────────────────────────────────
  //
  // One row: the views, and a ⋯ beside them for the one showing. No title — the
  // selected segment IS the title — and no "4 of 4 terminals" line: the squares
  // show their own state. Both were cut as wasted space.

  // The views are the tabs — the same control the workspace screen switches
  // Changes / Logs / Terminal with — plus a + that becomes the name field.
  function segment(view) {
    var list = views();
    if (!list.length && !editing) return null;
    var seg = h('div.seg');
    list.forEach(function (v) {
      if (editing && editing.mode === 'rename' && editing.id === v.id) {
        seg.appendChild(nameInput());
        return;
      }
      var on = !!view && v.id === view.id;
      seg.appendChild(h('button' + (on ? '.on' : ''), {
        type: 'button',
        onClick: function () { if (!on) { armed = null; picking = null; menu = null; arranging = null; SB.grid.select(v.id); } }
      }, v.name));
    });
    if (editing && editing.mode === 'new') seg.appendChild(nameInput());
    else {
      seg.appendChild(h('button.add', {
        type: 'button',
        title: 'New view',
        'aria-label': 'New view',
        onClick: function () { startEdit('new', null); }
      }, '+'));
    }
    return seg;
  }

  // Rename, Edit terminals and Delete sit behind the ⋯, and Delete asks once: a
  // view is four clicks to rebuild, but that is still four clicks nobody should lose
  // to a slip. The menu is in-page like the picker — a native popup would need a
  // dialog for the confirm and never shows in a smoke screenshot.
  function openMenu(view) {
    menu = view.id;
    menuFresh = true;
    armed = null;
    picking = null;
    SB.render();
  }

  function closeMenu(back) {
    if (menu === null) return;
    menu = null;
    armed = null;
    SB.render();
    if (back) setTimeout(focusDots, 0);
  }

  function focusDots() {
    var el = document.querySelector('.hd.gridhd .dots');
    if (el) el.focus();
  }

  function focusMenu() {
    var el = document.querySelector('.hd.gridhd .menu .mi');
    if (el) el.focus();
  }

  function menuKeys(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    var items = Array.prototype.slice.call(e.currentTarget.querySelectorAll('.mi'));
    if (!items.length) return;
    var at = items.indexOf(document.activeElement);
    var next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next].focus();
  }

  function menuBox(view) {
    var del = armed === view.id;
    return h('div.menu', {
      role: 'menu',
      onKeydown: menuKeys,
      // A press on the menu's own padding must not move focus out (and so close it).
      onMousedown: function (e) { if (!e.target.closest('.mi')) e.preventDefault(); }
    },
      h('button.mi', {
        type: 'button',
        role: 'menuitem',
        onClick: function () { startEdit('rename', view); }
      }, 'Rename'),
      h('button.mi', {
        type: 'button',
        role: 'menuitem',
        onClick: function () { startArrange(view); }
      }, 'Edit terminals'),
      h('button.mi' + (del ? '.bad' : ''), {
        type: 'button',
        role: 'menuitem',
        onClick: function () {
          if (armed === view.id) { menu = null; armed = null; SB.grid.remove(view.id); }
          else { armed = view.id; SB.render(); }
        }
      }, del ? 'Delete “' + view.name + '”' : 'Delete'));
  }

  // ── editing the terminals ─────────────────────────────────────────────────
  //
  // Taking a workspace out of a square used to be a × on every square, all the time
  // — one slip of the hand away, on a screen the hand is busy in. Now the × exists
  // only while the view is being edited, a mode entered on purpose from the ⋯ and
  // left with Done. In it the squares can lose a workspace and gain nothing: Add is
  // gone from the empty ones, and the terminals do not take the landing focus.
  // Switching view, or leaving the screen, ends it as it ends everything mid-flight.

  function startArrange(view) {
    arranging = view.id;
    arrangeFresh = true;
    menu = null;
    armed = null;
    picking = null;
    SB.render();
  }

  function stopArrange() {
    if (arranging === null) return;
    arranging = null;
    SB.render();
    setTimeout(focusDots, 0);
  }

  function focusDone() {
    var el = document.querySelector('.hd.gridhd .done');
    if (el) el.focus();
  }

  // Where the ⋯ was: what this mode is for, and the one way out of it.
  function doneBar(view) {
    var filled = view.cells.filter(Boolean).length;
    return h('div.more.arr',
      h('span.note', null, filled ? 'Click × to take a workspace out of this view' : 'Nothing to take out of this view'),
      h('button.btn.sm.done', {
        type: 'button',
        title: 'Stop editing the terminals',
        onClick: function () { stopArrange(); }
      }, 'Done'));
  }

  function more(view) {
    var open = menu === view.id;
    var box = h('div.more', {
      // Focus leaving the menu closes it — Tab, or a click on anything focusable.
      // Deferred, like the name field's blur: the ⋯ has focus from the press that
      // opened the menu, the opening render tears the old tree down, and Chromium
      // blurs the old ⋯ while it is still connected — a synchronous check closed
      // the menu in the same render that opened it, and the next render's landing
      // focus put the user in a terminal. Only where focus actually is once the
      // rebuild is over can say whether it left.
      onFocusout: function () {
        setTimeout(function () {
          if (menu !== view.id) return;
          var now = document.querySelector('.hd.gridhd .more');
          if (now && now.contains(document.activeElement)) return;
          closeMenu(false);
        }, 0);
      }
    });
    box.appendChild(h('button.ib.dots' + (open ? '.on' : ''), {
      type: 'button',
      title: 'Rename or delete this view, or edit its terminals',
      'aria-label': 'Options for ' + view.name,
      'aria-haspopup': 'menu',
      'aria-expanded': open ? 'true' : 'false',
      onClick: function () { if (open) closeMenu(false); else openMenu(view); }
    }, D.icon('more')));
    if (open) box.appendChild(menuBox(view));
    return box;
  }

  function header(view) {
    var hd = h('div.hd.gridhd');
    var seg = segment(view);
    if (seg) hd.appendChild(seg);
    // The five-hour Claude gauge, right of the views and left of the ⋯. views/usage.js
    // owns it and rewrites it in place when a poll lands, so this header is never
    // rebuilt for it.
    var usage = SB.views.usage;
    var gauge = usage && typeof usage.gauge === 'function' ? usage.gauge() : null;
    if (gauge) hd.appendChild(gauge);
    if (view && !editing) hd.appendChild(arranging === view.id ? doneBar(view) : more(view));
    return hd;
  }

  // A mousedown anywhere else dismisses the menu, the way a macOS menu does.
  // Capture phase, so it runs before whatever was pressed.
  document.addEventListener('mousedown', function (e) {
    if (menu === null) return;
    var t = e.target;
    if (t && typeof t.closest === 'function' && t.closest('.more')) return;
    closeMenu(false);
  }, true);

  // ── squares ───────────────────────────────────────────────────────────────

  function head(view, index, ws) {
    var dot = typeof SB.dotFor === 'function' ? SB.dotFor(ws) : '';
    return h('div.cellhd',
      // The name is a way into this workspace's Terminal — the same tab as the
      // square, on its own screen — not into whichever tab was looked at last.
      h('button.name', {
        type: 'button',
        title: 'Open the terminal for ' + ws.id,
        onClick: function () { SB.go({ view: 'workspace', wsId: ws.id, tab: 'terminal' }); }
      }, ws.id),
      dot ? h('span.dot.' + dot) : null,
      h('span.sp'),
      noteToggle(ws.id),
      // The × only while the terminals are being edited (see startArrange): a square
      // stays in the mode after losing its workspace, so several can go in one visit.
      arranging === view.id ? h('button.x', {
        type: 'button',
        title: 'Take ' + ws.id + ' out of this view',
        'aria-label': 'Take ' + ws.id + ' out of this view',
        onClick: function () { SB.grid.assign(view.id, index, null); }
      }, '×') : null);
  }

  // What a chosen folder goes into the square as. The workspace that lives in that
  // folder wins when there is one: a second shell in sample-1's folder under a
  // different name would be two terminals for one place, which the one-per-view rule
  // in SB.grid.assign exists to prevent. Otherwise the path itself.
  function folderId(state, dir) {
    var clean = String(dir).replace(/\/+$/, '') || '/';
    for (var i = 0; i < state.workspaces.length; i++) {
      var ws = state.workspaces[i];
      if (ws.dir && String(ws.dir).replace(/\/+$/, '') === clean) return ws.id;
    }
    return clean;
  }

  // Puts `id` in the square that was choosing. Looked up again rather than captured:
  // the sheet can stay up across a save round trip, after which main's copy of the
  // list has replaced the one the click closed over.
  function place(viewId, index, id) {
    var view = viewById(viewId);
    picking = null;
    if (!view) { SB.render(); return; }
    wanted = id;
    // Already in a square of this view: it keeps that square (one per view) and the
    // empty one stays empty — the render just lands focus on the one it is in.
    if (view.cells.indexOf(id) !== -1) { SB.render(); return; }
    SB.grid.assign(view.id, index, id);
  }

  // The system's folder sheet. A cancel leaves the picker up, the way cancelling a
  // sheet leaves you where you were; only a choice closes it.
  function chooseFolder(state, view, index) {
    var api = window.sb;
    if (!api || typeof api.chooseFolder !== 'function' || choosing) return;
    choosing = true;
    Promise.resolve(api.chooseFolder()).then(function (r) {
      choosing = false;
      if (!r || !r.ok || !r.dir) {
        if (r && r.error && typeof SB.notice === 'function') SB.notice({ kind: 'err', wsId: null, message: r.error });
        return;
      }
      place(view.id, index, folderId(state, r.dir));
    }, function () { choosing = false; });
  }

  function picker(state, view, index) {
    var box = h('div.pick');
    box.appendChild(h('div.pt', null, 'Which workspace?'));
    // Any folder at all — the root itself, a repo outside it, anything on this Mac —
    // through the system's own chooser. A terminal there is not a workspace: it is on
    // no rail and has no screen of its own; it is just a shell in that folder. FIRST,
    // above the workspaces: the list already overflows a square, and a row below ten
    // workspaces is a row nobody scrolls down to find.
    box.appendChild(h('div.grp', null, 'Folder'));
    box.appendChild(h('button.it.folder', {
      type: 'button',
      title: 'Open a terminal in any folder on this Mac',
      onClick: function () { chooseFolder(state, view, index); }
    }, h('span', null, 'Choose a folder…')));
    var any = false;
    var section = null;
    state.workspaces.forEach(function (ws) {
      if (view.cells.indexOf(ws.id) !== -1) return;     // already in a square of this view
      any = true;
      if (ws.section !== section) {
        section = ws.section;
        box.appendChild(h('div.grp', null, SB.sectionLabel(section, state.workspaces)));
      }
      box.appendChild(h('button.it', {
        type: 'button',
        title: ws.dir || ws.id,
        onClick: function () { picking = null; wanted = ws.id; SB.grid.assign(view.id, index, ws.id); }
      }, h('span', null, ws.id)));
    });
    if (!any) box.appendChild(h('p.sec', null, 'every workspace is already in this view'));
    box.appendChild(h('button.btn.sm', {
      type: 'button',
      onClick: function () { picking = null; SB.render(); }
    }, 'Cancel'));
    return box;
  }

  function emptyCell(state, view, index) {
    var el = h('div.cell.free');
    if (arranging === view.id) {                         // remove-only: nothing to add here
      el.appendChild(h('span.sec', null, 'empty'));
      return el;
    }
    if (picking && picking.viewId === view.id && picking.index === index) {
      el.appendChild(picker(state, view, index));
      return el;
    }
    el.appendChild(h('button.btn', {
      type: 'button',
      onClick: function () { armed = null; picking = { viewId: view.id, index: index }; SB.render(); }
    }, 'Add workspace'));
    return el;
  }

  // The folder was renamed or removed since the view was made. Main keeps the id on
  // purpose (§4.10); this is where it is explained and let go of.
  function goneCell(view, index, wsId) {
    return h('div.cell.gone', h('div.stack',
      h('span', null, wsId + ' is not under the root any more'),
      h('button.btn.sm', {
        type: 'button',
        onClick: function () { SB.grid.assign(view.id, index, null); }
      }, 'Clear')));
  }

  // A folder's strip: its name, the whole path as the tooltip, no run dot (nothing
  // runs here) and no jump — there is no workspace screen behind a folder. The ×
  // behaves exactly as it does on a workspace's square.
  function folderHead(view, index, dir) {
    var name = folderName(dir);
    return h('div.cellhd',
      h('span.name.folder', { title: dir }, name),
      h('span.sp'),
      noteToggle(dir),
      arranging === view.id ? h('button.x', {
        type: 'button',
        title: 'Take ' + name + ' out of this view',
        'aria-label': 'Take ' + name + ' out of this view',
        onClick: function () { SB.grid.assign(view.id, index, null); }
      }, '×') : null);
  }

  function cell(state, view, index) {
    var wsId = view.cells[index];
    if (!wsId) return emptyCell(state, view, index);
    var ws = state.byId[wsId];
    // A folder square has no workspace to find; the shell's own sentence (main: "that
    // folder is not there any more") is what says so when the folder has gone.
    if (!ws && !isFolder(wsId)) return goneCell(view, index, wsId);

    var el = h('div.cell.filled' + (arranging === view.id ? '.arr' : ''));
    el.appendChild(ws ? head(view, index, ws) : folderHead(view, index, wsId));
    if (showingNote(wsId)) {
      var notes = SB.views.notes;
      // The terminal is NOT disposed while its square shows a note: app.js's
      // retirePanes() keeps every pane whose id is in a Grid square, whichever of the
      // two the square is drawing, so the shell and its scrollback are untouched.
      if (notes && typeof notes.mount === 'function') notes.mount(wsId, el);
      else el.appendChild(h('div.note.blank', null, 'the note editor did not load'));
      return el;
    }
    var term = SB.views.terminal;
    if (term && typeof term.mount === 'function') term.mount(wsId, el);
    else el.appendChild(h('div.term.blank', null, 'the terminal did not load'));
    return el;
  }

  function body(state, view) {
    var bd = h('div.bd.gridbd');
    if (!view) {
      bd.appendChild(D.empty('Four terminals side by side. Make a view, then put a workspace in each square.', {
        title: 'no views yet',
        action: { label: 'New view', onClick: function () { startEdit('new', null); } }
      }));
      return bd;
    }
    var grid = h('div.grid');
    // Read each square's note before drawing: the switch is marked when there is
    // something written down, and the note is then already there when it is clicked.
    var notes = SB.views.notes;
    if (notes && typeof notes.preload === 'function') {
      for (var c = 0; c < CELLS; c++) if (view.cells[c]) notes.preload(view.cells[c]);
    }
    for (var i = 0; i < CELLS; i++) grid.appendChild(cell(state, view, i));
    bd.appendChild(grid);
    return bd;
  }

  // ── focus ─────────────────────────────────────────────────────────────────

  // Landing here is landing on a terminal: the first filled square gets focus, the
  // way the Terminal tab focuses itself. Only when nothing in the main column has it
  // — a square that is being typed into, a button that was just clicked, the name
  // field — keeps it. views/terminal.js's own landing focus is off on this route.
  //
  // The one exception is the square that was just filled: the picker's row is gone
  // with the rebuild, app.js's focus restore lands on whatever now sits at that
  // position, and the thing the user actually wants under their fingers is the new
  // terminal. `wanted` says so, once.
  function landFocus(view) {
    // Cleared before the guard, never after it: a flag left armed by a render that
    // bailed is a keyboard that jumps into a square minutes later.
    var just = wanted;
    wanted = null;
    if (!view || editing || picking || menu !== null || arranging !== null) return;
    setTimeout(function () {
      var term = SB.views.terminal;
      var notes = SB.views.notes;
      function land(id) {
        if (!id) return false;
        if (showingNote(id)) return !!notes && typeof notes.focus === 'function' && notes.focus(id);
        return !!term && typeof term.focus === 'function' && term.focus(id);
      }
      if (just && view.cells.indexOf(just) !== -1 && land(just)) return;
      var main = document.getElementById('main');
      var active = document.activeElement;
      if (!main || (active && active !== document.body && main.contains(active))) return;
      // A terminal first: a square showing a note is a place to read, and landing the
      // keyboard in someone's scratch pad is not what arriving at the Grid means.
      for (var i = 0; i < CELLS; i++) {
        if (view.cells[i] && !showingNote(view.cells[i]) && land(view.cells[i])) return;
      }
    }, 0);
  }

  // ── render ────────────────────────────────────────────────────────────────

  function render(state) {
    var view = current();
    // Coming back from another screen: whatever was mid-flight — a name being typed,
    // a square choosing, an open menu, an armed Delete — is stale. The old tree is
    // still in #main while the new one is built (app.js renderMain), so this asks
    // whether the Grid was the screen before this rebuild.
    if (!document.querySelector('#main .gridhd')) { editing = null; picking = null; armed = null; menu = null; arranging = null; }
    // Whatever was mid-flight for a view that is no longer on screen is stale.
    if (picking && (!view || picking.viewId !== view.id)) picking = null;
    if (armed && (!view || armed !== view.id)) armed = null;
    if (menu && (!view || menu !== view.id)) menu = null;
    if (arranging && (!view || arranging !== view.id)) arranging = null;

    var frag = D.frag(header(view), body(state, view));
    if (editing && editing.fresh) {
      editing.fresh = false;
      setTimeout(focusInput, 0);       // once — a later rebuild must not select-all mid-word
    }
    if (menu !== null && menuFresh) {
      menuFresh = false;
      setTimeout(focusMenu, 0);        // once — a bell mid-menu keeps the item the user is on
    }
    if (arranging !== null && arrangeFresh) {
      arrangeFresh = false;
      setTimeout(focusDone, 0);        // once — the way out is under the fingers, not a terminal
    }
    landFocus(view);
    return frag;
  }

  SB.views = SB.views || {};
  SB.views.grid = { render: render };
})(window.SB);
