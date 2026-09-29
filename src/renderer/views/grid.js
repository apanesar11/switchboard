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
// been clicked once, the view that is being edited. Every render is a fresh tree,
// as everywhere else in the app.
window.SB = window.SB || {};

(function (SB) {
  'use strict';

  var D = SB.dom;
  var h = D.h;

  var CELLS = 4;
  var NOTE_KEY = 'switchboard.grid.notes';     // the squares showing a note, by workspace id

  var editing = null;     // null | { text, fresh } — the view being made, its name as typed
  var picking = null;     // null | { viewId, index } — the square that is choosing
  var armed = null;       // the view whose Delete has been clicked once
  var menu = null;        // the view whose ⋯ menu is open
  var menuFresh = false;  // the menu was just opened: its first item gets focus, once
  var wanted = null;      // the workspace just put in a square: its terminal gets focus
  var arranging = null;   // null | { id, text, fresh } — the view being edited, its name as typed
  var choosing = false;   // the folder sheet is up: a second click must not raise a second one
  var pressing = false;   // a mouse button is down: what it pressed has not been clicked yet
  var released = null;    // what is waiting for that click to land
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
    // — whenever a name is being typed, a square is choosing or the view is being
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

  function startNew() {
    saveName();                       // a view that was being edited keeps what was typed
    arranging = null;
    editing = { text: '', fresh: true };
    armed = null;
    picking = null;
    menu = null;
    SB.render();
  }

  function commitEdit() {
    if (!editing) return;
    var e = editing;
    editing = null;
    SB.grid.create(e.text);
    SB.render();                      // an empty name creates nothing, and still needs the input gone
  }

  function cancelEdit() {
    editing = null;
    SB.render();
  }

  // A rebuild between a mousedown and its mouseup detaches what was pressed, and the
  // click never arrives. The name field's blur is exactly that moment — the press on a
  // ×, a ‹ or Done is what took focus out of the field — so what the blur decides
  // waits for the press to finish, and runs after the click it became.
  function whenReleased(fn) {
    if (pressing) released = fn;
    else fn();
  }

  function release() {
    pressing = false;
    var fn = released;
    released = null;
    if (fn) setTimeout(fn, 0);
  }

  document.addEventListener('mousedown', function () { pressing = true; }, true);
  document.addEventListener('mouseup', release, true);
  window.addEventListener('blur', release);      // let go of outside the window

  // The name field: the + turned into one for a new view, or the selected segment
  // while its view is being edited. Its value is kept in `editing` / `arranging` and
  // put back on every rebuild, caret and all — a bell or a run state arriving mid-word
  // must not eat the word.
  function nameInput() {
    var box = editing || arranging;
    var fresh = box === editing;
    function keep() { box.text = input.value; box.sel = [input.selectionStart, input.selectionEnd]; }
    var input = h('input.vname', {
      type: 'text',
      value: box.text,
      placeholder: fresh ? 'Name this view' : '',
      'aria-label': fresh ? 'Name for the new view' : 'Name of this view',
      maxlength: '60',
      spellcheck: 'false',
      autocomplete: 'off',
      onInput: keep,
      onKeyup: keep,
      onMouseup: keep,
      onKeydown: function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (editing) commitEdit();
          else { saveName(); setTimeout(focusDone, 0); }   // named; Done is the way out
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (editing) cancelEdit();
          else cancelArrange();
        }
      },
      onBlur: function () {
        // Deferred, and never decided from the event itself: Chromium blurs a focused
        // element BEFORE a rebuild detaches it, so at this moment the old input is
        // still connected and there is no relatedTarget — a bell arriving mid-word
        // would look exactly like the user leaving the field and commit half a name.
        // After the rebuild, focus is back in the new input (app.js restores it by
        // position) or it has really gone somewhere else.
        setTimeout(function () { whenReleased(settle); }, 0);
      }
    });
    if (box.sel) {
      try { input.setSelectionRange(box.sel[0], box.sel[1]); } catch (_) { /* not a text field */ }
    }
    return input;
  }

  // Focus has left the name field, for good: what it says is the name.
  function settle() {
    if (!editing && !arranging) return;
    var now = document.querySelector('.seg input.vname');
    if (now && document.activeElement === now) return;
    if (arranging) saveName();
    else if (editing.text.trim()) commitEdit();
    else cancelEdit();
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
  // Changes / Logs / Terminal with — plus a + that becomes the name field. While a
  // view is being edited its own segment is the name field, with a ‹ › either side.
  function segment(view) {
    var list = views();
    if (!list.length && !editing) return null;
    var seg = h('div.seg');
    list.forEach(function (v, i) {
      var on = !!view && v.id === view.id;
      if (on && arranging) {
        seg.appendChild(nameBox(v, i, list.length));
        return;
      }
      seg.appendChild(h('button' + (on ? '.on' : ''), {
        type: 'button',
        onClick: function () { if (!on) show(v); }
      }, v.name));
    });
    if (editing) seg.appendChild(nameInput());
    else {
      seg.appendChild(h('button.add', {
        type: 'button',
        title: 'New view',
        'aria-label': 'New view',
        onClick: function () { startNew(); }
      }, '+'));
    }
    return seg;
  }

  // Another view's segment was clicked. The edit follows the selection: the view now
  // showing is the one the name field, the ‹ › and the × belong to, so several views
  // can be put in order in one visit.
  function show(v) {
    armed = null;
    picking = null;
    menu = null;
    if (arranging) {
      saveName();
      arranging = { id: v.id, text: v.name, fresh: true };
    }
    SB.grid.select(v.id);
  }

  // Edit and Delete sit behind the ⋯, and Delete asks once: a
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
        onClick: function () { startArrange(view); }
      }, 'Edit'),
      h('button.mi' + (del ? '.bad' : ''), {
        type: 'button',
        role: 'menuitem',
        onClick: function () {
          if (armed === view.id) { menu = null; armed = null; SB.grid.remove(view.id); }
          else { armed = view.id; SB.render(); }
        }
      }, del ? 'Delete “' + view.name + '”' : 'Delete'));
  }

  // ── editing a view ────────────────────────────────────────────────────────
  //
  // Edit is the one mode for everything about a view that can change: its name, its
  // place in the row, and what is in its squares. Rename and Edit terminals used to be
  // two items and two modes; they are one, entered on purpose from the ⋯ and left with
  // Done.
  //
  // Taking a workspace out of a square used to be a × on every square, all the time
  // — one slip of the hand away, on a screen the hand is busy in. The × still exists
  // only in here. An empty square offers Add as it always does, so a square can be
  // emptied and filled again in the same visit, and the terminals do not take the
  // landing focus. Leaving the screen ends it as it ends everything mid-flight;
  // switching view carries it to the view switched to (see show).

  function editingView(view) {
    return !!arranging && !!view && arranging.id === view.id;
  }

  function startArrange(view) {
    arranging = { id: view.id, text: view.name, fresh: true };
    menu = null;
    armed = null;
    picking = null;
    SB.render();
  }

  // What the field says becomes the view's name. An empty field is not a name: the
  // view keeps the one it had, and the field goes back to saying it.
  function saveName() {
    var view = arranging ? viewById(arranging.id) : null;
    if (!view) return;
    var typed = arranging.text;
    var name = typed.trim().slice(0, 60) || view.name;
    arranging.text = name;
    if (name !== view.name) SB.grid.rename(view.id, name);
    else if (name !== typed) SB.render();
  }

  function stopArrange() {
    if (!arranging) return;
    saveName();
    arranging = null;
    SB.render();
    setTimeout(focusDots, 0);
  }

  // Escape in the name field: what was typed is dropped, and so is the mode. What was
  // taken out of a square or moved along the row has already happened and stays.
  function cancelArrange() {
    if (!arranging) return;
    arranging = null;
    SB.render();
    setTimeout(focusDots, 0);
  }

  function focusDone() {
    var el = document.querySelector('.hd.gridhd .done');
    if (el) el.focus();
  }

  // One place along the row. The button pressed keeps the focus so it can be pressed
  // again — it has moved with its segment, where app.js's restore by position would
  // not find it — and at the end of the row, where it goes dead, the other one takes it.
  function moveBy(view, by) {
    var list = views();
    var at = -1;
    for (var i = 0; i < list.length; i++) if (list[i].id === view.id) at = i;
    if (at === -1) return;
    SB.grid.move(view.id, at + by);
    setTimeout(function () {
      var el = document.querySelector('.seg .vedit .mv.' + (by < 0 ? 'l' : 'r'));
      if (!el || el.disabled) el = document.querySelector('.seg .vedit .mv:not([disabled])');
      if (el) el.focus();
    }, 0);
  }

  // The selected segment, opened up: its name as a field, and a ‹ › either side that
  // moves it along the row. A view on its own has nowhere to go and gets no arrows.
  function nameBox(view, at, count) {
    function mv(by) {
      var label = by < 0 ? 'Move left' : 'Move right';
      return h('button.mv.' + (by < 0 ? 'l' : 'r'), {
        type: 'button',
        title: label,
        'aria-label': label,
        disabled: at + by < 0 || at + by >= count,
        onClick: function () { moveBy(view, by); }
      }, by < 0 ? '‹' : '›');
    }
    return h('div.vedit',
      count > 1 ? mv(-1) : null,
      nameInput(),
      count > 1 ? mv(1) : null);
  }

  // Where the ⋯ was: what this mode is for, and the one way out of it.
  function doneBar() {
    return h('div.more.arr',
      h('span.hint', null, 'Rename or move this view, add or take out its terminals'),
      h('button.btn.sm.done', {
        type: 'button',
        title: 'Finish editing this view',
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
      title: 'Edit or delete this view',
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
    if (view && !editing) hd.appendChild(editingView(view) ? doneBar() : more(view));
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
      // The × only while the view is being edited (see startArrange): a square
      // stays in the mode after losing its workspace, so several can go in one visit.
      editingView(view) ? h('button.x', {
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
      editingView(view) ? h('button.x', {
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

    var el = h('div.cell.filled' + (editingView(view) ? '.arr' : ''));
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
        action: { label: 'New view', onClick: function () { startNew(); } }
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
    if (!view || editing || picking || menu !== null) return;
    // Being edited, the terminals take no focus at all. A square that was just filled
    // hands it to Done: the picker's row is gone, and restoring by position would put
    // the keyboard on whatever sits there now — the new square's ×, as likely as not.
    if (arranging) {
      if (just) setTimeout(focusDone, 0);
      return;
    }
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
    if (arranging && (!view || arranging.id !== view.id)) arranging = null;

    var frag = D.frag(header(view), body(state, view));
    if (editing && editing.fresh) {
      editing.fresh = false;
      setTimeout(focusInput, 0);       // once — a later rebuild must not select-all mid-word
    }
    if (menu !== null && menuFresh) {
      menuFresh = false;
      setTimeout(focusMenu, 0);        // once — a bell mid-menu keeps the item the user is on
    }
    if (arranging && arranging.fresh) {
      arranging.fresh = false;
      setTimeout(focusInput, 0);       // once — the name, selected: typing renames it
    }
    landFocus(view);
    return frag;
  }

  SB.views = SB.views || {};
  SB.views.grid = { render: render };
})(window.SB);
