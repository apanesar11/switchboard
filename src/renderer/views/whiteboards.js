// SB.views.whiteboards — the Whiteboards screen, an open whiteboard, and the live
// editor canvases behind both (§4.17, R15).
//
//   {view:'whiteboards', folder}  the home: folders on the left (the user's own, plus
//                                 All, Recent, No folder and Archived), one row per board
//                                 on the right. Built fresh on every render, like
//                                 views/prs.js; the data is main's whiteboards store
//                                 through SB.load('wb:index').
//   {view:'whiteboard', board}    one board open: the tab strip and the board's slab,
//                                 edge to edge. A persistent root like the Editor's
//                                 (R13): the same element comes back on every render
//                                 and only its strip is rebuilt, when what it says
//                                 changes, so the canvas, its xterms and focus never see
//                                 a teardown.
//
// Tabs: many boards open at once, one on screen. The strip across the top holds the
// library (the home) as a pinned first tab and one tab per open board, in the order the
// user put them; + opens another, × / middle-click / ⌘W close one, ⌃Tab and ⌘1–9 move
// between them. The open set and the tab last shown outlive a relaunch, and the rail's
// Whiteboards row comes back to that tab (entry()).
//
// Canvases are keyed by BOARD id: one React instance (window.SBDiagrams.create) and one
// slab per board, shown on the board's own screen (or full screen) and parked off it,
// never remounted by a render. At most eight live at once; the least recently shown
// that is off screen, has nothing unsaved and no answer on its way is let go — a board
// whose tab was closed first. A tab whose canvas was let go mounts a fresh one when it
// is shown again. Each canvas has a terminal layer
// (views/wbterminals.js, SB.wbTerminals) for the terminals that float over it or are
// pinned to it; this file wires it to the editor and asks it the questions app.js has
// about bells, retiring panes and ⌘A.
//
// What lives here besides the canvases and the tabs is only what a rebuild would
// otherwise lose: the name being typed into an inline field, the folder whose … menu is
// open, the last write's error, the folder the screen opens on, the strip's open
// picker or menu. Views never write SB.state.
window.SB = window.SB || {};
SB.views = SB.views || {};

(function (SB) {
  'use strict';

  var D = SB.dom;
  var h = D.h;

  var INDEX_KEY = 'wb:index';                     // SB.load key; app.js stales every 'wb:' load on sb:evt:wbChanged
  var FOLDER_KEY = 'switchboard.wb.folder';       // the folder the screen opens on, across launches
  var TABS_KEY = 'switchboard.wb.tabs';           // the open boards and the tab on screen, across launches
  var MAX_CANVASES = 8;
  var RECENT = 12;                                // Recent = the twelve most recently edited
  var DRAG_TYPE = 'application/x-switchboard-whiteboard';
  var TAB_DRAG = 'application/x-switchboard-whiteboard-tab';
  var PICK_RECENT = 6;                            // + lists the six edited last before the folders
  var SPECIAL = { all: 1, recent: 1, archived: 1, none: 1 };

  function noop() {}

  // ── the bridge ────────────────────────────────────────────────────────────

  function message(err) {
    if (err === null || err === undefined) return 'that did not work';
    var s = typeof err === 'string' ? err : (err.error || err.message || String(err));
    return String(s)
      .replace(/^Error invoking remote method '[^']*':\s*/, '')
      .replace(/^(?:Uncaught )?Error:\s*/, '')
      .trim() || 'that did not work';
  }

  // Every main call settles as a value — { ok:true, data } or { ok:false, error } —
  // never a rejection, and a preload without the method is an answer too.
  function call(name) {
    var bridge = window.sb;
    var args = Array.prototype.slice.call(arguments, 1);
    if (!bridge || typeof bridge[name] !== 'function') {
      return Promise.resolve({ ok: false, error: 'this build of Switchboard has no whiteboards' });
    }
    var out;
    try { out = bridge[name].apply(bridge, args); } catch (err) { return Promise.resolve({ ok: false, error: message(err) }); }
    return Promise.resolve(out).then(function (r) {
      return r && typeof r === 'object' ? r : { ok: false, error: 'the app process did not answer' };
    }, function (err) {
      return { ok: false, error: message(err) };
    });
  }

  function bundle() { return window.SBDiagrams || null; }
  function route() { return (SB.state && SB.state.route) || {}; }
  function onHome() { return route().view === 'whiteboards'; }

  // A render only for the screen that shows what changed.
  function repaint() {
    if (onHome() && typeof SB.render === 'function') SB.render();
  }

  function focusEl(el) {
    if (!el || typeof el.focus !== 'function') return;
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
  }

  // ── the index ─────────────────────────────────────────────────────────────

  var lastGood = null;      // the last index main answered: { folders, boards, notice, migration, … }
  var seen = null;          // the SB.load value lastGood was read from
  var indexError = null;    // main's sentence while the last read of it failed

  function tidyIndex(data) {
    var out = Object.assign({}, data);
    out.folders = Array.isArray(data.folders) ? data.folders.slice() : [];
    out.boards = Array.isArray(data.boards) ? data.boards.slice() : [];
    // Main sorts newest first; sorted again here so Recent and the rows never depend on it.
    out.boards.sort(function (a, b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });
    out.folders.sort(function (a, b) {
      return String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' });
    });
    return out;
  }

  function fetchIndex() { return call('whiteboardsList'); }

  // The home's data: SB.load memoises and revalidates it, and keeps the old value on
  // screen while it does, so a refetch never flashes the list.
  function loadIndex() {
    var entry = typeof SB.load === 'function' ? SB.load(INDEX_KEY, fetchIndex) : null;
    var v = entry && entry.value;
    indexError = entry && entry.status === 'error' ? (entry.error || 'could not list the whiteboards') : null;
    if (v !== seen) {
      seen = v;
      if (v && v.ok === true && v.data && typeof v.data === 'object') {
        lastGood = tidyIndex(v.data);
        pruneTabs();
      }
      // An open + picker shows the list as it now is (or why there is none).
      if (finder && finder.mode === 'find') paintFinder();
    }
    return {
      data: lastGood,
      error: indexError,
      running: !!(entry && entry.running)
    };
  }

  function folderById(data, id) {
    if (!data || !id) return null;
    for (var i = 0; i < data.folders.length; i++) if (data.folders[i].id === id) return data.folders[i];
    return null;
  }

  function boardById(data, id) {
    if (!data || !id) return null;
    for (var i = 0; i < data.boards.length; i++) if (data.boards[i].id === id) return data.boards[i];
    return null;
  }

  // Where a board is listed: an archived one under Archived (it keeps its folder, but
  // that is not where it shows), else its folder, else No folder.
  function listedIn(board) {
    if (!board) return 'all';
    if (board.archivedAt) return 'archived';
    return board.folderId || 'none';
  }

  function resolveKey(data, key) {
    if (SPECIAL[key]) return key;
    return folderById(data, key) ? key : 'all';
  }

  function keyLabel(data, key) {
    if (key === 'all') return 'All whiteboards';
    if (key === 'recent') return 'Recent';
    if (key === 'archived') return 'Archived';
    if (key === 'none') return 'No folder';
    var f = folderById(data, key);
    return f ? f.name : 'All whiteboards';
  }

  function live(data) {
    return data.boards.filter(function (b) { return !b.archivedAt; });
  }

  function inNoFolder(data, b) {
    return !b.folderId || !folderById(data, b.folderId);
  }

  function boardsIn(data, key) {
    if (key === 'archived') return data.boards.filter(function (b) { return !!b.archivedAt; });
    var list = live(data);
    if (key === 'recent') return list.slice(0, RECENT);
    if (key === 'none') return list.filter(function (b) { return inNoFolder(data, b); });
    if (key === 'all') return list;
    return list.filter(function (b) { return b.folderId === key; });
  }

  // ── the folder the screen opens on ────────────────────────────────────────

  // One remembered folder, written by whichever happened last: the home showing a folder,
  // or a board being shown (its folder). So Back from a board lands where the board is,
  // and the rail's row comes back to the folder last looked at. app.js asks for it when a
  // route to the home names no folder (normalize()).
  var folderKey = readFolder();

  function readFolder() {
    try { return window.localStorage.getItem(FOLDER_KEY) || 'all'; } catch (e) { return 'all'; }
  }

  function rememberFolder(key) {
    if (!key || key === folderKey) return;
    folderKey = key;
    try { window.localStorage.setItem(FOLDER_KEY, key); } catch (e) { /* storage off */ }
  }

  function lastFolder() { return folderKey || 'all'; }

  // ── words ─────────────────────────────────────────────────────────────────

  // "Edited 2h ago" within the day, "Yesterday", then the date — the mock-up's row meta.
  function edited(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return 'Edited';
    var now = new Date();
    if (now.getTime() - t < 24 * 3600 * 1000) return 'Edited ' + D.fmtAgo(t);
    var day = new Date(t);
    var yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (day.getFullYear() === yesterday.getFullYear() && day.getMonth() === yesterday.getMonth() &&
        day.getDate() === yesterday.getDate()) return 'Yesterday';
    var opts = { month: 'short', day: 'numeric' };
    if (day.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
    try { return day.toLocaleDateString('en-US', opts); } catch (e) { return day.toDateString(); }
  }

  function boxes(n) { return D.plural(Number(n) || 0, 'box', 'boxes'); }

  // ── writes from the home ──────────────────────────────────────────────────

  var ui = {
    newFolder: null,       // { text, sel, fresh } — the New folder field
    newBoard: null,        // { text, sel, fresh } — the New whiteboard field
    rename: null,          // { id, text, sel, fresh } — a folder being renamed in place
    menu: null,            // the folder whose … menu is open
    menuFresh: false,      // its first item gets focus, once
    focusFolder: null,     // a folder just made or renamed from the keyboard: its row gets focus, once
    error: null,           // main's sentence for the last write that failed
    pending: {},           // field kind → true while its write is in flight
    migrating: false,      // Try again is running
    noticeGone: false      // Dismiss was pressed; main's answer may not have landed yet
  };

  function resetUi() {
    ui.newFolder = null;
    ui.newBoard = null;
    ui.rename = null;
    ui.menu = null;
    ui.menuFresh = false;
    ui.focusFolder = null;
    ui.error = null;
  }

  // One write: on success the error bar goes, every 'wb:' load goes stale (main's
  // change event does the same a moment later) and `done` gets main's data; on failure
  // main's sentence stands above the list until the next write that works.
  function write(name, args, done) {
    return call.apply(null, [name].concat(args)).then(function (r) {
      if (!r || r.ok !== true) {
        ui.error = message(r && r.error);
        repaint();
        return null;
      }
      ui.error = null;
      if (typeof done === 'function') {
        try { done(r.data); } catch (err) { console.error('[switchboard] whiteboards:', err); }
      }
      if (typeof SB.invalidate === 'function') SB.invalidate('wb:');
      return r.data;
    });
  }

  function moveBoard(id, folderId) {
    if (!id) return;
    var b = boardById(lastGood, id);
    if (b && (b.folderId || null) === (folderId || null)) return;
    write('whiteboardsMove', [id, folderId || null]);
  }

  function deleteFolder(f) {
    ui.menu = null;
    write('whiteboardsDeleteFolder', [f.id], function () {
      if (route().folder === f.id) SB.go({ view: 'whiteboards', folder: 'all' });
    });
    repaint();
  }

  function dismissNotice() {
    ui.noticeGone = true;
    repaint();
    write('whiteboardsDismissNotice', []);
  }

  function retryMigration() {
    if (ui.migrating) return;
    ui.migrating = true;
    repaint();
    call('whiteboardsMigrate').then(function (r) {
      ui.migrating = false;
      // A failure is main's to describe: list() carries it as migration.error, which is
      // what the warning bar says once the list is read again.
      if (!r || r.ok !== true) console.error('[switchboard] whiteboards migrate:', r && r.error);
      if (typeof SB.invalidate === 'function') SB.invalidate('wb:');
    });
  }

  // ── inline fields ─────────────────────────────────────────────────────────
  //
  // New folder, New whiteboard and a folder's Rename are fields in the page, not
  // dialogs. A render tears the home down and builds it again — a bell, a run state, a
  // window focus — so what is typed lives in `ui`, and each rebuild puts it back, caret
  // and all (views/grid.js's name field, the same machinery).

  var pressing = false;   // a mouse button is down: what it pressed has not been clicked yet
  var released = null;    // what is waiting for that click to land

  // A rebuild between a mousedown and its mouseup detaches what was pressed, and the
  // click never arrives. A field's blur is exactly that moment — the press on Create or a
  // folder row is what took focus out of it — so what the blur decides waits for the
  // press to finish, and runs after the click it became.
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
  // A drag swallows its mouseup; its end lets go instead.
  document.addEventListener('dragend', release, true);
  window.addEventListener('blur', release);

  function boxOf(kind) {
    return kind === 'folder' ? ui.newFolder : kind === 'board' ? ui.newBoard : kind === 'rename' ? ui.rename : null;
  }

  function clearBox(kind) {
    if (kind === 'folder') ui.newFolder = null;
    else if (kind === 'board') ui.newBoard = null;
    else if (kind === 'rename') ui.rename = null;
  }

  function fieldEl(kind) {
    return document.querySelector('#main input[data-wb-field="' + kind + '"]');
  }

  function focusField(kind, selectAll) {
    var el = fieldEl(kind);
    var box = boxOf(kind);
    if (!el || !box) return;
    focusEl(el);
    if (selectAll) { el.select(); return; }
    if (box.sel) { try { el.setSelectionRange(box.sel[0], box.sel[1]); } catch (e) { /* not a text field */ } }
  }

  function focusedField() {
    var el = document.activeElement;
    var main = document.getElementById('main');
    if (!el || !main || !main.contains(el) || el.tagName !== 'INPUT') return null;
    return el.getAttribute('data-wb-field');
  }

  function field(kind, box, opts) {
    function keep() { box.text = input.value; box.sel = [input.selectionStart, input.selectionEnd]; }
    var input = h('input.wbfield', {
      type: 'text',
      value: box.text,
      placeholder: opts.placeholder,
      'aria-label': opts.label,
      maxlength: String(opts.max),
      spellcheck: 'false',
      autocomplete: 'off',
      dataset: { wbField: kind },
      onInput: keep,
      onKeyup: keep,
      onMouseup: keep,
      onKeydown: function (e) {
        if (e.isComposing) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          keep();
          commit(kind, true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cancel(kind, true);
        }
      },
      onBlur: function () {
        // Deferred, and never decided from the event itself: Chromium blurs a focused
        // element BEFORE a rebuild detaches it, so at this moment the old input is still
        // connected — a bell mid-word would look exactly like the user leaving. After the
        // rebuild, focus is back in the new input (render() puts it there) or it has
        // really gone somewhere else.
        setTimeout(function () { whenReleased(function () { settle(kind); }); }, 0);
      }
    });
    if (box.sel) {
      try { input.setSelectionRange(box.sel[0], box.sel[1]); } catch (e) { /* not a text field */ }
    }
    return input;
  }

  // Focus has left a field for good. A rename that changed something is saved, the way
  // Finder saves one; an empty field just goes. A NEW folder or whiteboard is only ever
  // made by Enter or Create — made on a blur, a click on a row would open one board while
  // the field quietly made and opened another — so a typed name stays put, waiting.
  function settle(kind) {
    var box = boxOf(kind);
    if (!box || ui.pending[kind]) return;
    var now = fieldEl(kind);
    if (now && document.activeElement === now) return;
    var text = String(box.text || '').trim();
    if (!text) { cancel(kind, false); return; }
    if (kind === 'rename') {
      var f = folderById(lastGood, box.id);
      if (!f || text === f.name) cancel(kind, false);
      else commit(kind);
    }
  }

  function cancel(kind, fromKey) {
    if (!boxOf(kind)) return;
    var renamed = kind === 'rename' ? ui.rename.id : null;
    clearBox(kind);
    repaint();
    if (!fromKey) return;
    // Esc hands the keyboard back to whatever opened the field.
    setTimeout(function () {
      var sel = kind === 'folder' ? '[data-wb-new-folder]'
        : kind === 'board' ? '[data-wb-new-board]'
          : '.frow[data-wb-folder="' + cssId(renamed) + '"] .fsel';
      focusEl(document.querySelector('#main ' + sel));
    }, 0);
  }

  // Folder ids are main's uuids; quoted for a selector all the same.
  function cssId(id) {
    return String(id || '').replace(/["\\]/g, '\\$&');
  }

  // `fromKey`: Enter made it. The keyboard then goes to the folder's own row (the one
  // now selected, or the one just renamed) rather than wherever app.js's positional
  // restore lands once the field is gone — another folder's …, whose menu the next
  // Enter would open. A rename saved by a blur leaves focus where the user put it.
  function commit(kind, fromKey) {
    var box = boxOf(kind);
    if (!box || ui.pending[kind]) return;
    var name = String(box.text || '').replace(/\s+/g, ' ').trim();
    if (!name) return;
    if (kind === 'folder') {
      ui.pending.folder = true;
      write('whiteboardsCreateFolder', [name], function (folder) {
        ui.newFolder = null;
        if (folder && folder.id) {
          if (fromKey) ui.focusFolder = folder.id;
          SB.go({ view: 'whiteboards', folder: folder.id });
        }
      }).then(function () { ui.pending.folder = false; });
      return;
    }
    if (kind === 'rename') {
      var f = folderById(lastGood, box.id);
      if (f && name === f.name) { cancel('rename', !!fromKey); return; }
      ui.pending.rename = true;
      write('whiteboardsRenameFolder', [box.id, name], function () {
        if (fromKey) ui.focusFolder = box.id;
        ui.rename = null;
      }).then(function () { ui.pending.rename = false; repaint(); });
      return;
    }
    if (kind === 'board') {
      var b = bundle();
      if (!b || typeof b.blankSpec !== 'function') {
        ui.error = 'the whiteboard editor is not built — run npm run build:diagrams, then reopen Switchboard';
        repaint();
        return;
      }
      var spec;
      try { spec = b.blankSpec(); } catch (err) { ui.error = message(err); repaint(); return; }
      // A new board lands in the folder on screen; All, Recent, Archived and No folder
      // are not folders, so there it lands in none. Its workspace is main's to default
      // (the one used last).
      var key = route().folder;
      var folderId = lastGood && folderById(lastGood, key) ? key : null;
      ui.pending.board = true;
      write('whiteboardsCreate', [{ folderId: folderId, name: name, spec: spec }], function (board) {
        ui.newBoard = null;
        if (board && board.id) SB.go({ view: 'whiteboard', board: board.id });
      }).then(function () { ui.pending.board = false; });
    }
  }

  function startNewFolder() {
    ui.menu = null;
    if (!ui.newFolder) ui.newFolder = { text: '', sel: null, fresh: true };
    else ui.newFolder.fresh = true;
    repaint();
  }

  function startNewBoard() {
    ui.menu = null;
    if (!ui.newBoard) ui.newBoard = { text: '', sel: null, fresh: true };
    else ui.newBoard.fresh = true;
    repaint();
  }

  function startRename(f) {
    ui.menu = null;
    ui.rename = { id: f.id, text: f.name, sel: null, fresh: true };
    repaint();
  }

  // ── the folder … menu ─────────────────────────────────────────────────────

  function openMenu(id) {
    ui.menu = id;
    ui.menuFresh = true;
    repaint();
  }

  function closeMenu(back) {
    if (ui.menu === null) return;
    var id = ui.menu;
    ui.menu = null;
    repaint();
    if (back) {
      setTimeout(function () {
        focusEl(document.querySelector('#main .frow[data-wb-folder="' + cssId(id) + '"] .fdots'));
      }, 0);
    }
  }

  // A mousedown anywhere else dismisses the menu, the way a macOS menu does. Capture
  // phase, so it runs before whatever was pressed.
  document.addEventListener('mousedown', function (e) {
    if (ui.menu === null) return;
    var t = e.target;
    if (t && typeof t.closest === 'function' && t.closest('.wbfmenu, .fdots')) return;
    if (!onHome()) { ui.menu = null; return; }
    closeMenu(false);
  }, true);

  function menuKeys(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    var items = Array.prototype.slice.call(e.currentTarget.querySelectorAll('.mi:not([disabled])'));
    if (!items.length) return;
    var at = items.indexOf(document.activeElement);
    var next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    focusEl(items[next]);
  }

  function folderMenu(f) {
    var n = (Number(f.count) || 0) + (Number(f.archived) || 0);
    var why = n ? 'Move its ' + D.plural(n, 'whiteboard') + ' out first' +
      (f.archived ? ' (' + f.archived + ' archived)' : '') : null;
    return h('div.menu.wbfmenu', {
      role: 'menu',
      onKeydown: menuKeys,
      // A press on the menu's own padding must not move focus out (and so close it).
      onMousedown: function (e) { if (!e.target.closest('.mi')) e.preventDefault(); }
    },
      h('button.mi', {
        type: 'button',
        role: 'menuitem',
        onClick: function () { startRename(f); }
      }, D.icon('edit'), h('span', null, 'Rename…')),
      // Only an empty folder goes: its boards would have nowhere to be. aria-disabled
      // rather than disabled, so the item still says why on hover and can be reached.
      h('button.mi.bad', {
        type: 'button',
        role: 'menuitem',
        'aria-disabled': n > 0 ? 'true' : null,
        title: why,
        onClick: function () { if (!n) deleteFolder(f); }
      }, D.icon('trash'), h('span', null, 'Delete')));
  }

  // ── dragging a board onto a folder ────────────────────────────────────────

  var dragging = null;    // the board being dragged — for the classes; the drop reads the drag itself

  // A drag of one of these rows: its own type is on the drag. Only such a drag is taken
  // by a folder row — not a file from Finder, not text — whatever `dragging` says.
  function boardDrag(e) {
    var types = e.dataTransfer && e.dataTransfer.types;
    return !!types && Array.prototype.indexOf.call(types, DRAG_TYPE) !== -1;
  }

  // dragenter is accepted exactly as dragover is. Chromium fires only a dragenter (no
  // dragover yet) as the pointer crosses into the row or one of its children — the icon,
  // the name, the "moved" chip — and an enter left alone resets the drop to "none" until
  // the next dragover. A release in that gap ends the drag with no drop at all: a quick
  // flick onto a folder silently did nothing.
  function dropTarget(el, folderId) {
    function accept(e) {
      if (!boardDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      el.classList.add('drop');
    }
    el.addEventListener('dragenter', accept);
    el.addEventListener('dragover', accept);
    el.addEventListener('dragleave', function (e) {
      if (!el.contains(e.relatedTarget)) el.classList.remove('drop');
    });
    el.addEventListener('drop', function (e) {
      if (!boardDrag(e)) return;
      e.preventDefault();
      // The board this drag carries — never a `dragging` left over from an earlier one.
      var id = e.dataTransfer.getData(DRAG_TYPE) || dragging;
      dragDone();
      moveBoard(id, folderId);
    });
  }

  // Classes, never a render: a rebuild mid-drag would detach the row being dragged.
  function dragStart(e, b) {
    dragging = b.id;
    if (e.dataTransfer) {
      try { e.dataTransfer.setData(DRAG_TYPE, b.id); } catch (err) { /* the id is in `dragging` too */ }
      e.dataTransfer.effectAllowed = 'move';
    }
    var cols = document.querySelector('#main .wbfolders');
    if (cols) cols.classList.add('dragging');
    if (e.currentTarget && e.currentTarget.classList) e.currentTarget.classList.add('lifted');
  }

  // The end of a drag, however it ends. The row's own dragend is not enough: a render
  // mid-drag (a bell, a run state, a parked board's autosave) rebuilds the list, which
  // detaches the row being dragged, and Chromium fires no dragend at a source that has
  // left the document — `dragging` stayed set, and the "No folder" target showed. So any
  // drop or dragend the window sees ends it too and, when a cancelled drag sends neither,
  // the next press or plain mouse move does: no mouse event arrives while a drag is on.
  function dragDone() {
    if (!dragging) return;
    dragging = null;
    var cols = document.querySelector('#main .wbfolders');
    if (cols) cols.classList.remove('dragging');
    Array.prototype.forEach.call(document.querySelectorAll('#main .frow.drop, #main .wbrow.lifted'), function (el) {
      el.classList.remove('drop');
      el.classList.remove('lifted');
    });
  }

  window.addEventListener('drop', dragDone, true);
  window.addEventListener('dragend', dragDone, true);
  document.addEventListener('mousedown', dragDone, true);
  document.addEventListener('mousemove', function (e) { if (dragging && !e.buttons) dragDone(); }, true);

  // ── the home: header ──────────────────────────────────────────────────────

  function homeHeader(data, loading) {
    var sub = '';
    if (data) {
      var all = live(data).length;
      var archived = data.boards.length - all;
      sub = [D.plural(all, 'whiteboard'), D.plural(data.folders.length, 'folder'), archived + ' archived'].join(' · ');
    } else if (loading) {
      sub = 'Reading your whiteboards…';
    }
    return h('div.hd.tight.wbhd',
      h('div.top',
        h('h1', null, 'Whiteboards'),
        h('button.btn', {
          type: 'button',
          dataset: { wbNewFolder: '' },
          onClick: startNewFolder
        }, D.icon('folderPlus'), 'New folder'),
        h('button.btn.pri', {
          type: 'button',
          dataset: { wbNewBoard: '' },
          onClick: startNewBoard
        }, D.icon('plus'), 'New whiteboard')),
      h('div.sub.sec', null, sub));
  }

  // ── the home: bars ────────────────────────────────────────────────────────

  // Where the old Diagrams tree is now, as main writes it: `legacyLabel` is the folder
  // itself with the home directory as ~ — <config folder>/diagrams before the move
  // finished, the renamed diagrams-before-whiteboards[-n] after — so the sentence names
  // the real place even when SWITCHBOARD_CONFIG keeps the store somewhere else. A main
  // without it gets the default location, which is where every installed app keeps it.
  function legacyPath(m) {
    if (m && typeof m.legacyLabel === 'string' && m.legacyLabel.trim()) return m.legacyLabel.trim();
    return '~/.switchboard/' + ((m && m.legacyRoot) || 'diagrams');
  }

  // A bar's Dismiss: quiet grey text at the end of the line (the mock-up's .x), not a
  // button competing with the sentence.
  function dismissButton(onClick) {
    return h('button.wbx', { type: 'button', onClick: onClick }, 'Dismiss');
  }

  // At most one bar here, the "never two bars" rule: a migration that failed outranks
  // the one-time notice, which says what happened to the Diagrams tab.
  function migrationBar(data) {
    var m = data.migration || null;
    if (m && m.error) {
      return h('div.bar.warn.wbbar',
        h('span', null, 'Your diagrams couldn’t all be moved: ' + m.error +
          '. Nothing was deleted — they’re still in ' + legacyPath(m) + '.'),
        h('span.sp'),
        h('button.btn', {
          type: 'button',
          disabled: ui.migrating,
          onClick: retryMigration
        }, ui.migrating ? 'Trying…' : 'Try again'));
    }
    if (ui.noticeGone) return null;
    var notice = data.notice || null;
    var dismissed = !!(notice && notice.dismissed);
    var skipped = m ? Number(m.skipped) || 0 : 0;
    var moved = notice && !dismissed ? Number(notice.boards) || 0 : 0;
    // Unread legacy files are worth a word even when no board moved — once: Dismiss is
    // main's to remember, as it is for the notice itself.
    if (!moved && !(skipped > 0 && !dismissed)) return null;
    var were = skipped === 1 ? 'was' : 'were';
    var line = h('span');
    if (moved) {
      line.appendChild(D.text('Your workspace diagrams moved here. Each project’s diagrams are in a folder of its ' +
        'name. Drag a whiteboard into any folder, or '));
      line.appendChild(h('button.lnk', { type: 'button', onClick: startNewFolder }, 'make new folders'));
      line.appendChild(D.text('.'));
      if (skipped > 0) {
        line.appendChild(D.text(' ' + skipped + ' couldn’t be read and ' + were + ' left in ' + legacyPath(m) + '.'));
      }
    } else {
      line.appendChild(D.text(skipped + ' of your workspace diagrams couldn’t be read and ' + were +
        ' left in ' + legacyPath(m) + '.'));
    }
    return h('div.bar.wbbar',
      D.icon('board'),
      line,
      h('span.sp'),
      dismissButton(dismissNotice));
  }

  function errorBar() {
    if (!ui.error) return null;
    return h('div.bar.warn.wbbar',
      h('span', null, ui.error),
      h('span.sp'),
      h('button.btn', { type: 'button', onClick: function () { ui.error = null; repaint(); } }, 'Dismiss'));
  }

  // ── the home: folders ─────────────────────────────────────────────────────

  function frow(o, key) {
    var on = o.key === key;
    var wrap = h('div.frow' + (on ? '.on' : '') + (o.dim ? '.dim' : '') + (o.nf ? '.nf' : '') +
      (o.folder ? '.has-more' : '') + (o.folder && ui.menu === o.folder.id ? '.menuon' : ''), {
      dataset: { wbFolder: o.key }
    });
    wrap.appendChild(h('button.fsel', {
      type: 'button',
      'aria-current': on ? 'true' : null,
      title: o.title || null,
      onClick: function () { ui.menu = null; SB.go({ view: 'whiteboards', folder: o.key }); }
    },
      D.icon(o.icon),
      h('span.fn', null, o.label),
      o.moved ? h('span.mig', { title: 'Moved here from a workspace’s Diagrams tab' }, 'moved') : null,
      h('span.sp'),
      o.count === undefined || o.count === null ? null : h('span.ct', null, String(o.count))));
    if (o.folder) {
      var open = ui.menu === o.folder.id;
      wrap.appendChild(h('button.ib.fdots' + (open ? '.on' : ''), {
        type: 'button',
        title: 'Rename or delete ' + o.folder.name,
        'aria-label': 'Options for ' + o.folder.name,
        'aria-haspopup': 'menu',
        'aria-expanded': open ? 'true' : 'false',
        onClick: function () { if (open) closeMenu(false); else openMenu(o.folder.id); }
      }, D.icon('more')));
      if (open) wrap.appendChild(folderMenu(o.folder));
      // Focus leaving the row closes its menu. Deferred, as the field's blur is: the
      // render that opened the menu blurs the old … while it is still connected.
      wrap.addEventListener('focusout', function () {
        var id = o.folder.id;
        setTimeout(function () {
          if (ui.menu !== id) return;
          var now = document.querySelector('#main .frow[data-wb-folder="' + cssId(id) + '"]');
          if (now && now.contains(document.activeElement)) return;
          closeMenu(false);
        }, 0);
      });
    }
    if (o.drop) dropTarget(wrap, o.dropTo);
    return wrap;
  }

  function renameRow(f) {
    return h('div.frow.editing', { dataset: { wbFolder: f.id } },
      D.icon('folder'),
      field('rename', ui.rename, { placeholder: 'Folder name', label: 'New name for ' + f.name, max: 60 }));
  }

  function newFolderRow() {
    return h('div.frow.editing',
      D.icon('folderPlus'),
      field('folder', ui.newFolder, { placeholder: 'Name the folder', label: 'Name for the new folder', max: 60 }));
  }

  function foldersColumn(data, key) {
    // .dragging again when a render rebuilds the column mid-drag: No folder stays a target.
    var col = h('nav.wbfolders' + (dragging ? '.dragging' : ''), { 'aria-label': 'Folders' });
    var liveBoards = live(data);
    var none = liveBoards.filter(function (b) { return inNoFolder(data, b); }).length;
    col.appendChild(frow({ key: 'all', icon: 'board', label: 'All whiteboards', count: liveBoards.length }, key));
    col.appendChild(frow({ key: 'recent', icon: 'clock', label: 'Recent', title: 'The ' + RECENT + ' you edited last' }, key));
    col.appendChild(h('div.grp', null, 'Folders'));
    if (ui.newFolder) col.appendChild(newFolderRow());
    if (!data.folders.length && !ui.newFolder) {
      col.appendChild(h('p.wbnone.sec', null, 'No folders yet · ',
        h('button.lnk', { type: 'button', onClick: startNewFolder }, 'New folder')));
    }
    data.folders.forEach(function (f) {
      if (ui.rename && ui.rename.id === f.id) { col.appendChild(renameRow(f)); return; }
      col.appendChild(frow({
        key: f.id, icon: key === f.id ? 'folderOpen' : 'folder', label: f.name, count: Number(f.count) || 0,
        moved: !!f.moved, folder: f, drop: true, dropTo: f.id
      }, key));
    });
    // No folder shows only while something is in it — and while a board is being
    // dragged, as somewhere to drop it (.nf; .wbfolders.dragging reveals it).
    col.appendChild(frow({
      key: 'none', icon: 'folder', label: 'No folder', count: none, nf: !none && key !== 'none',
      drop: true, dropTo: null
    }, key));
    col.appendChild(h('div.grp.gap', { 'aria-hidden': 'true' }));
    col.appendChild(frow({
      key: 'archived', icon: 'archive', label: 'Archived', count: data.boards.length - liveBoards.length, dim: true
    }, key));
    return col;
  }

  // ── the home: rows ────────────────────────────────────────────────────────

  // The mini preview: main's `thumb`, up to fourteen rects already fitted to the 40×30
  // tile. Drawn the mock-up's way: every box an outlined card at least 4px each way
  // (grown about its centre — a 1px border round less than that reads as a grey dash)
  // and inside a 4px margin, so none sits flush against the tile's edge. Main fits the
  // layout into that frame already; this only guards the drawing.
  var THUMB = { w: 40, h: 30, inset: 4, min: 4 };

  function thumbRect(r) {
    var innerW = THUMB.w - 2 * THUMB.inset, innerH = THUMB.h - 2 * THUMB.inset;
    var x = Number(r[0]) || 0, y = Number(r[1]) || 0;
    var w = Math.max(0, Number(r[2]) || 0), ht = Math.max(0, Number(r[3]) || 0);
    var cx = x + w / 2, cy = y + ht / 2;
    w = Math.min(innerW, Math.max(THUMB.min, w));
    ht = Math.min(innerH, Math.max(THUMB.min, ht));
    x = Math.min(THUMB.w - THUMB.inset - w, Math.max(THUMB.inset, cx - w / 2));
    y = Math.min(THUMB.h - THUMB.inset - ht, Math.max(THUMB.inset, cy - ht / 2));
    function px(n) { return Math.round(n * 10) / 10 + 'px'; }
    return { left: px(x), top: px(y), width: px(w), height: px(ht) };
  }

  function thumb(rects) {
    var box = h('span.th', { 'aria-hidden': 'true' });
    (Array.isArray(rects) ? rects : []).slice(0, 14).forEach(function (r) {
      if (!Array.isArray(r) || r.length < 4) return;
      box.appendChild(h('i', { style: thumbRect(r) }));
    });
    return box;
  }

  function openBoard(b) {
    SB.go({ view: 'whiteboard', board: b.id });
  }

  function row(data, b, showFolder) {
    var meta = h('span.meta');
    var bits = [];
    if (showFolder) {
      var f = folderById(data, b.folderId);
      bits.push(f ? f.name : 'No folder');
    }
    bits.push(edited(b.updatedAt));
    bits.push(boxes(b.boxes));
    meta.appendChild(D.text(bits.join(' · ')));
    var reads = Array.isArray(b.reads) ? b.reads : [];
    if (reads.length) {
      meta.appendChild(D.text(' · answers read'));
      reads.forEach(function (ws) { meta.appendChild(h('span.pill', null, ws)); });
    } else {
      meta.appendChild(D.text(' · no answers yet'));
    }
    return h('div.wbrow' + (b.archivedAt ? '.arch' : '') + (dragging === b.id ? '.lifted' : ''), {
      role: 'button',
      tabindex: '0',
      draggable: 'true',
      'aria-label': 'Open ' + b.name,
      dataset: { wbBoard: b.id },
      onClick: function () { openBoard(b); },
      onKeydown: function (e) {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBoard(b); }
      },
      onDragstart: function (e) { dragStart(e, b); },
      onDragend: dragDone
    },
      thumb(b.thumb),
      h('span.nm', null, h('b', null, b.name), meta),
      h('span.act', { 'aria-hidden': 'true' }, 'Open', D.icon('chev')));
  }

  function newBoardRow(data, key) {
    var into = folderById(data, key);
    var create = function () { commit('board'); };
    return h('div.wbrow.new',
      h('span.th.blank', { 'aria-hidden': 'true' }),
      h('span.nm', null,
        field('board', ui.newBoard, { placeholder: 'Name the whiteboard', label: 'Name for the new whiteboard', max: 120 }),
        h('span.meta', null, 'Lands in ' + (into ? into.name : 'No folder') + ' · Enter to create, Esc to cancel')),
      h('button.btn.sm.pri', { type: 'button', disabled: !!ui.pending.board, onClick: create }, 'Create'));
  }

  function emptyList(data, key) {
    var box = h('div.wbempty');
    function say(title, line, action) {
      box.appendChild(h('h2', null, title));
      if (line) box.appendChild(h('p', null, line));
      if (action) box.appendChild(h('button.btn.pri', { type: 'button', onClick: action.onClick }, D.icon('plus'), action.label));
      return box;
    }
    if (!data.boards.length) {
      return say('No whiteboards yet',
        'Flowcharts, notes, documents and pictures. ✦ Answer can read any workspace you point it at.',
        ui.newBoard ? null : { label: 'New whiteboard', onClick: startNewBoard });
    }
    if (key === 'recent') return say('Whiteboards you edit show here');
    if (key === 'archived') return say('Nothing archived');
    if (key === 'none') return say('Nothing outside a folder', 'New whiteboard lands here, or drag one in.');
    if (key === 'all') {
      return say('Every whiteboard is archived', 'They are under Archived.',
        ui.newBoard ? null : { label: 'New whiteboard', onClick: startNewBoard });
    }
    return say('Nothing in ' + keyLabel(data, key) + ' yet', 'New whiteboard lands here, or drag one in.');
  }

  function listColumn(data, key) {
    var rows = boardsIn(data, key);
    var col = h('section.wblist', { 'aria-label': keyLabel(data, key) });
    var err = errorBar();
    if (err) col.appendChild(err);
    col.appendChild(h('div.lhead',
      h('b', null, keyLabel(data, key)),
      h('span', null, D.plural(rows.length, 'whiteboard')),
      h('span.sort', { title: 'Newest first' }, 'Edited', D.icon('chevD'))));
    if (ui.newBoard) col.appendChild(newBoardRow(data, key));
    if (!rows.length) {
      col.appendChild(emptyList(data, key));
      return col;
    }
    var showFolder = key === 'all' || key === 'recent' || key === 'archived';
    rows.forEach(function (b) { col.appendChild(row(data, b, showFolder)); });
    return col;
  }

  function skeleton() {
    var col = h('section.wblist');
    for (var i = 0; i < 3; i++) {
      col.appendChild(h('div.wbrow.sk-row', h('span.th'), h('span.nm', null, h('span.sk.w3'), h('span.sk.w2'))));
    }
    return col;
  }

  // ── the home: render ──────────────────────────────────────────────────────

  function renderHome(state) {
    var r = (state && state.route) || {};
    // Coming from another screen: whatever was mid-flight here — a name being typed, an
    // open menu, the last error — is stale. The old tree is still in #main while the new
    // one is built (app.js renderMain), so this asks whether the home was the screen.
    if (!document.querySelector('#main .wbhd')) resetUi();
    var focused = focusedField();
    var got = loadIndex();
    var data = got.data;
    var key = data ? resolveKey(data, r.folder || 'all') : (r.folder || 'all');
    if (data) {
      rememberFolder(key);
      if (ui.menu && !folderById(data, ui.menu)) ui.menu = null;
      if (ui.rename && !folderById(data, ui.rename.id)) ui.rename = null;
    }

    var bd = h('div.bd.wbhome');
    if (data) {
      var bar = migrationBar(data);
      if (bar) bd.appendChild(bar);
      if (got.error) {
        bd.appendChild(h('div.bar.warn.wbbar', h('span', null, 'couldn’t read the whiteboards again — ' + got.error),
          h('span.sp'),
          h('button.btn', { type: 'button', onClick: function () { SB.invalidate(INDEX_KEY); } }, 'Retry')));
      }
      bd.appendChild(h('div.wbcols', foldersColumn(data, key), listColumn(data, key)));
    } else if (got.error) {
      bd.appendChild(D.errorBox(got.error, { retry: function () { SB.invalidate(INDEX_KEY); } }));
    } else {
      bd.appendChild(h('div.wbcols', h('nav.wbfolders'), skeleton()));
    }

    // Focus: a field just opened takes it once (selected, so typing replaces); a field
    // that had it gets it back after the rebuild — before its own deferred blur looks —
    // whatever else moved around it (a bar appearing above shifts app.js's positional
    // restore). A menu just opened hands it to its first item.
    [['folder', ui.newFolder], ['board', ui.newBoard], ['rename', ui.rename]].forEach(function (pair) {
      if (pair[1] && pair[1].fresh) {
        pair[1].fresh = false;
        setTimeout(function () { focusField(pair[0], true); }, 0);
      }
    });
    if (focused && boxOf(focused)) Promise.resolve().then(function () { focusField(focused, false); });
    // A folder made or renamed with Enter: its row, once main's list has it (the render
    // right after the write still has the old list). Not if the user is already typing
    // somewhere else by then.
    if (ui.focusFolder && data && folderById(data, ui.focusFolder) && !(ui.rename && ui.rename.id === ui.focusFolder)) {
      var made = ui.focusFolder;
      ui.focusFolder = null;
      setTimeout(function () {
        var a = document.activeElement;
        if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
        focusEl(document.querySelector('#main .frow[data-wb-folder="' + cssId(made) + '"] .fsel'));
      }, 0);
    }
    if (ui.menu !== null && ui.menuFresh) {
      ui.menuFresh = false;
      setTimeout(function () { focusEl(document.querySelector('#main .wbfmenu .mi:not([disabled])')); }, 0);
    }
    return D.frag(homeStrip(r), homeHeader(data, !got.error), bd);
  }

  // ── an open board ─────────────────────────────────────────────────────────

  var view = null;          // persistent chrome: { root, hd (the tab strip), hdSig, body }

  function build() {
    var body = h('div.bd.pane.dgbd');
    var root = h('div.view.dgview.wbview', {
      style: 'display:flex;flex-direction:column;flex:1;min-width:0;min-height:0'
    }, body);
    view = { root: root, hd: null, hdSig: null, body: body };
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

  // The strip is rebuilt whenever what it says has changed (putStrip); a focused tab or
  // button keeps the focus across the swap, by position.
  function swapStrip(v, hd) {
    var path = null;
    if (v.hd && v.hd.parentNode === v.root) {
      path = pathTo(v.hd, document.activeElement);
      v.root.replaceChild(hd, v.hd);
    } else v.root.insertBefore(hd, v.root.firstChild);
    v.hd = hd;
    if (!path) return;
    var el = hd;
    for (var i = 0; i < path.length && el; i++) el = el.children[path[i]];
    if (el && el !== hd) focusEl(el);
  }

  function goHome(folder) {
    SB.go({ view: 'whiteboards', folder: folder || 'all' });
  }

  // The strip is swapped only when what it says has changed. The editor reports every
  // write, autosave included, and an app render comes with every bell: a strip rebuilt
  // for each would swap a tab out from under a press — mousedown on the old tab, mouseup
  // on the new one, no click — and a tab being dragged would lose its source. A change
  // that lands mid-drag waits for the drag to end (tabDragDone).
  function putStrip(v, r) {
    var m = stripModel(r);
    var sig = JSON.stringify(m);
    var mounted = !!v.hd && v.hd.parentNode === v.root;
    if (mounted && v.hdSig === sig) return;
    if (mounted && tabDrag) { stripStale = true; return; }
    v.hdSig = sig;
    swapStrip(v, stripEl(m));
  }

  function renderBoard(state) {
    var r = (state && state.route) || {};
    var v = view || build();
    // The tabs' names and folders, for the boards whose canvas hasn't read them.
    loadIndex();
    var item = makeCanvas(r.board);
    putStrip(v, r);
    item.home = v.body;
    if (item.fullscreen) {
      if (v.body.firstChild) v.body.replaceChildren();
    } else {
      // Whatever else is here goes (another board's slab), but never by taking this
      // board's slab out and back: app.js's notice bar (applyNotice) shares this body,
      // above the slab, and a replaceChildren() on every render while it is up detached
      // the slab each time — focus fell out of a terminal or a box's label, and Electron
      // destroys a detached <webview>'s page for good (the Google Images panel went blank).
      Array.prototype.slice.call(v.body.childNodes).forEach(function (n) {
        if (n !== item.slab && !(n.nodeType === 1 && n.hasAttribute('data-sb-notice'))) v.body.removeChild(n);
      });
      if (item.slab.parentNode !== v.body) v.body.appendChild(item.slab);
    }
    return v.root;
  }

  function render(state) {
    var r = (state && state.route) || {};
    noteRoute(r);
    if (r.view === 'whiteboard' && r.board) return renderBoard(state);
    return renderHome(state);
  }

  // ── tabs ──────────────────────────────────────────────────────────────────
  //
  // `tabs.open` is the strip's order, every board open at once; `tabs.active` the tab
  // last on screen — a board's id, or null for the library. Written as either changes,
  // so the rail's Whiteboards row (entry()) and a relaunch come back to the same tab.

  var tabs = readTabs();
  var homeSig = '';           // what the home's strip said when the home was last drawn ('' for none)
  var tabDrag = null;         // the board whose tab is being dragged
  var stripStale = false;     // something changed mid-drag; the strip catches up once it ends
  var carryFull = null;       // ⌃Tab or ⌘1–9 left a full-screen board for this one: it goes full screen too
  var revealed = null;        // the tab last scrolled into view
  var stripScroll = 0;        // how far the tabs were scrolled sideways, kept across rebuilds

  function readTabs() {
    var out = { open: [], active: null };
    var raw = null;
    try { raw = JSON.parse(window.localStorage.getItem(TABS_KEY) || 'null'); } catch (e) { raw = null; }
    if (raw && Array.isArray(raw.open)) {
      raw.open.forEach(function (id) {
        if (typeof id === 'string' && id && out.open.indexOf(id) === -1) out.open.push(id);
      });
    }
    if (raw && typeof raw.active === 'string' && out.open.indexOf(raw.active) !== -1) out.active = raw.active;
    return out;
  }

  function saveTabs() {
    try { window.localStorage.setItem(TABS_KEY, JSON.stringify(tabs)); } catch (e) { /* storage off */ }
  }

  function tabAt(id) { return tabs.open.indexOf(id); }

  // Every render says which tab is on screen. A board's own screen gives it a tab — at
  // the end, unless addTab() already put it beside the board it came from — and the home
  // is the library's. Any other screen leaves both as they were: that is where the
  // rail's row comes back to.
  function noteRoute(r) {
    var active;
    if (r.view === 'whiteboard' && r.board) active = String(r.board);
    else if (r.view === 'whiteboards') active = null;
    else return;
    var changed = false;
    if (active && tabAt(active) === -1) { tabs.open.push(active); changed = true; }
    if (tabs.active !== active) { tabs.active = active; changed = true; }
    if (changed) saveTabs();
  }

  function addTab(id, after) {
    if (!id || tabAt(id) !== -1) return;
    var at = after ? tabAt(after) : -1;
    if (at === -1) tabs.open.push(id);
    else tabs.open.splice(at + 1, 0, id);
    saveTabs();
  }

  // A tab on screen: a board's, or the library's (null) in the folder last looked at.
  function goTab(id) {
    if (id) SB.go({ view: 'whiteboard', board: id });
    else goHome(lastFolder());
  }

  // A board in its tab — the one it has, else a new one after `after`'s (Duplicate)
  // or at the end.
  function openTab(id, after) {
    addTab(id, after);
    goTab(id);
  }

  // ⌃Tab and ⌘1–9. A board left full screen hands full screen on to the board shown next.
  function switchTab(id) {
    var cur = activeCanvas(route());
    carryFull = id && cur && cur.fullscreen && cur.boardId !== id ? id : null;
    goTab(id);
  }

  function cycleTabs(delta) {
    if (!tabs.open.length) return false;
    var r = route();
    var order = [null].concat(tabs.open);
    var at = r.view === 'whiteboard' ? order.indexOf(r.board) : 0;
    if (at === -1) at = 0;
    switchTab(order[(at + delta + order.length) % order.length]);
    return true;
  }

  // ⌘1–8 the board in that place, ⌘9 the last, as a browser's tabs. The library is ⌃Tab's.
  function jumpTab(n) {
    if (!tabs.open.length) return false;
    var id = n === 9 ? tabs.open[tabs.open.length - 1] : tabs.open[n - 1];
    if (id) switchTab(id);
    return true;
  }

  // Closes the tabs of `ids`. Each board's canvas is let go — its editor writes what it
  // holds first, and its terminals' shells live on — and when the board on screen is one
  // of them, the tab to its right comes up, else the one to its left, else the library:
  // in `folder` when given (the list a deleted board was in). No question is asked: a
  // board saves as it goes, so closing a tab loses nothing.
  function closeTabs(ids, folder) {
    ids = (ids || []).filter(function (id) { return !!id && (tabAt(id) !== -1 || !!canvases[id]); });
    if (!ids.length) return;
    var r = route();
    var current = r.view === 'whiteboard' ? r.board : null;
    var leaving = !!current && ids.indexOf(current) !== -1;
    var before = tabs.open.slice();
    tabs.open = tabs.open.filter(function (id) { return ids.indexOf(id) === -1; });
    var next = null;
    if (leaving) {
      var at = before.indexOf(current);
      for (var i = at + 1; next === null && i < before.length; i++) if (tabAt(before[i]) !== -1) next = before[i];
      for (i = at - 1; next === null && i >= 0; i--) if (tabAt(before[i]) !== -1) next = before[i];
    }
    if (tabs.active && tabAt(tabs.active) === -1) tabs.active = next;
    saveTabs();
    // Let go before the next tab is shown: a canvas made for it must not count the one
    // going (still on the page, so never the LRU's pick) and let another tab's go instead.
    ids.forEach(function (id) { if (canvases[id]) forget(canvases[id]); });
    if (leaving) {
      if (next) goTab(next);
      else goHome(folder || lastFolder());
    } else refreshStrip();
  }

  // Close other tabs: from a tab's menu that tab comes up, as in a browser.
  function closeOthers(id) {
    if (!id) return;
    closeTabs(tabs.open.filter(function (x) { return x !== id; }));
    var r = route();
    if (!(r.view === 'whiteboard' && r.board === id)) goTab(id);
  }

  function closeRight(id) {
    var at = tabAt(id);
    if (at !== -1) closeTabs(tabs.open.slice(at + 1));
  }

  function closeAll() { closeTabs(tabs.open.slice()); }

  function moveTab(id, to) {
    var from = tabAt(id);
    if (from === -1) return;
    tabs.open.splice(from, 1);
    if (to > from) to--;
    tabs.open.splice(Math.max(0, Math.min(to, tabs.open.length)), 0, id);
    saveTabs();
  }

  // Where the rail's Whiteboards row and a relaunch go: the tab last on screen — its
  // board while the tab is open (and, once main's list has come in, while it lists the
  // board) — else the library. At launch the list has not come in yet: a board deleted
  // while the window was closed opens on its "no longer exists" page, whose Back closes
  // the tab.
  function entry() {
    var id = tabs.active;
    if (id && tabAt(id) !== -1 && (!lastGood || boardById(lastGood, id))) return { view: 'whiteboard', board: id };
    return { view: 'whiteboards' };
  }

  // A board main no longer lists — deleted from a terminal, or while the window was
  // closed — loses its tab when the list comes in. Never one with a canvas: that page
  // says the board is gone, with Back; and a board made a moment ago may not be listed yet.
  function pruneTabs() {
    if (!lastGood) return;
    var r = route();
    var keep = tabs.open.filter(function (id) {
      return !!canvases[id] || !!boardById(lastGood, id) || (r.view === 'whiteboard' && r.board === id);
    });
    if (keep.length === tabs.open.length) return;
    tabs.open = keep;
    if (tabs.active && tabAt(tabs.active) === -1) tabs.active = null;
    saveTabs();
  }

  // ── the strip ─────────────────────────────────────────────────────────────

  // Where a board is listed, as its tab's second line says it.
  function placeOf(b, folder) {
    var key = listedIn(b);
    if (key === 'archived') return 'Archived';
    if (key === 'none') return 'No folder';
    var f = folder || folderById(lastGood, b.folderId);
    return f ? f.name : (lastGood ? 'No folder' : '');
  }

  // A shell of one of the board's terminals rang and nobody has looked (the rail's bell).
  function rang(item) {
    var bells = (SB.state && SB.state.bell) || {};
    return (item.terminals || []).some(function (t) { return !!t && !!bells[t.wsId]; });
  }

  // A board's tab as plain data, so putStrip() can tell whether it changed: the name and
  // where it is listed — from the canvas once it has read the board, else main's list —
  // and, on a board off screen, one dot: blue while one of its terminals rang unread,
  // violet while ✦ Answer is still drawing on it.
  function tabOf(id, r) {
    var item = canvases[id];
    var b = item && item.summary ? item.summary : (item && item.loaded ? null : boardById(lastGood, id));
    var t = { id: id, on: r.view === 'whiteboard' && r.board === id, name: '…', place: '', dot: '' };
    if (b) {
      t.name = b.name;
      t.place = placeOf(b, item && item.summary ? item.folder : null);
    } else if (item && item.loaded) {
      t.name = 'Unavailable';
      t.place = 'Can’t be shown';
    }
    if (!t.on && item) {
      if (rang(item)) t.dot = 'bell';
      else if (item.answering > 0) t.dot = 'ai';
    }
    return t;
  }

  function stripModel(r) {
    var data = lastGood;
    return {
      home: !(r.view === 'whiteboard' && r.board),
      sub: data ? D.plural(data.folders.length, 'folder') + ' · ' + D.plural(live(data).length, 'whiteboard') : '',
      tabs: tabs.open.map(function (id) { return tabOf(id, r); })
    };
  }

  var DOT_TITLE = { bell: 'A terminal on it rang', ai: '✦ Answer is still drawing on it' };

  function tabEl(t) {
    return h('div.wbtab' + (t.on ? '.on' : '') + (t.dot ? '.has-dot' : ''), {
      role: 'tab',
      tabindex: '0',
      draggable: 'true',
      'aria-selected': t.on ? 'true' : 'false',
      title: t.name + (t.place ? ' · ' + t.place : '') + (t.dot ? ' — ' + DOT_TITLE[t.dot] : ''),
      dataset: { wbTab: t.id }
    },
      h('span.l1', null,
        h('span.nm', null, t.name),
        h('button.wbtx', {
          type: 'button',
          tabindex: '-1',
          title: t.on ? 'Close tab  ⌘W' : 'Close tab',
          'aria-label': 'Close tab ' + t.name
        }, t.dot ? h('span.dot.' + t.dot) : null, D.icon('close'))),
      h('span.pl', null, t.place || ' '));
  }

  // The library: pinned first, never closed, only left.
  function libTab(m) {
    return h('div.wbtab.wblib' + (m.home ? '.on' : ''), {
      role: 'tab',
      tabindex: '0',
      'aria-selected': m.home ? 'true' : 'false',
      title: 'Every whiteboard, in your folders',
      dataset: { wbTab: '' },
      onClick: function () {
        if (!onHome()) goTab(null);
        letFocusGo();
      }
    },
      h('span.l1', null, D.icon('board'), h('span.nm', null, 'Whiteboards')),
      h('span.pl', null, m.sub || ' '));
  }

  function stripEl(m) {
    var list = h('div.wbtl', { role: 'tablist', 'aria-label': 'Open whiteboards' });
    m.tabs.forEach(function (t) { list.appendChild(tabEl(t)); });
    wireTabs(list);
    var strip = h('div.wbstrip' + (m.home ? '.home' : '.board'),
      libTab(m),
      list,
      h('button.wbadd', {
        type: 'button',
        title: 'Open a whiteboard in a new tab',
        'aria-label': 'Open a whiteboard in a new tab',
        'aria-haspopup': 'dialog',
        dataset: { wbAdd: '' },
        onClick: function (e) { togglePicker(e.currentTarget); }
      }, D.icon('plus')),
      h('span.sp'),
      h('button.wbmore', {
        type: 'button',
        title: 'Every open whiteboard',
        'aria-haspopup': 'menu',
        dataset: { wbMore: '' },
        onClick: function (e) { toggleOpenList(e.currentTarget); }
      }, m.tabs.length + ' open', D.icon('chevD')));
    strip.addEventListener('keydown', tabKeys);
    return strip;
  }

  function tabFrom(e) {
    var el = e.target instanceof Element ? e.target.closest('.wbtab[data-wb-tab]') : null;
    var id = el ? el.getAttribute('data-wb-tab') : '';
    return id ? { el: el, id: id } : null;
  }

  function wireTabs(list) {
    list.addEventListener('click', function (e) {
      var t = tabFrom(e);
      if (!t) return;
      if (e.target.closest('.wbtx')) closeTabs([t.id]);
      else {
        var r = route();
        if (!(r.view === 'whiteboard' && r.board === t.id)) goTab(t.id);
      }
      letFocusGo();
    });
    // A middle press would start Chromium's autoscroll; its click closes the tab.
    list.addEventListener('mousedown', function (e) { if (e.button === 1) e.preventDefault(); });
    list.addEventListener('auxclick', function (e) {
      if (e.button !== 1) return;
      var t = tabFrom(e);
      if (!t) return;
      e.preventDefault();
      closeTabs([t.id]);
    });
    list.addEventListener('contextmenu', function (e) {
      var t = tabFrom(e);
      if (!t) return;
      e.preventDefault();
      openTabMenu(t.id, e.clientX, e.clientY, t.el);
    });
    // A vertical wheel scrolls the tabs sideways, as the Editor's do.
    list.addEventListener('wheel', function (e) {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      list.scrollLeft += e.deltaY;
      e.preventDefault();
    }, { passive: false });
    list.addEventListener('scroll', function () { stripScroll = list.scrollLeft; });

    // Dragging a tab along the strip puts it somewhere else; a board's row dragged up
    // from the library opens it in a tab, there. Classes, never a render, while it lasts.
    list.addEventListener('dragstart', function (e) {
      var t = tabFrom(e);
      if (!t || !e.dataTransfer) return;
      closePop(false);
      tabDrag = t.id;
      try { e.dataTransfer.setData(TAB_DRAG, t.id); } catch (err) { /* tabDrag has it */ }
      e.dataTransfer.effectAllowed = 'move';
      t.el.classList.add('lifted');
    });
    function kindOf(e) {
      var types = e.dataTransfer && e.dataTransfer.types;
      if (!types) return null;
      if (Array.prototype.indexOf.call(types, TAB_DRAG) !== -1) return 'tab';
      if (Array.prototype.indexOf.call(types, DRAG_TYPE) !== -1) return 'board';
      return null;
    }
    // Accepted on dragenter as on dragover, for the reason dropTarget() gives.
    function accept(e) {
      if (!kindOf(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      showSlot(list, slotAt(list, e.clientX));
    }
    list.addEventListener('dragenter', accept);
    list.addEventListener('dragover', accept);
    list.addEventListener('dragleave', function (e) {
      if (!list.contains(e.relatedTarget)) hideSlot(list);
    });
    list.addEventListener('drop', function (e) {
      var kind = kindOf(e);
      if (!kind) return;
      e.preventDefault();
      var at = slotAt(list, e.clientX);
      hideSlot(list);
      var id = e.dataTransfer.getData(kind === 'tab' ? TAB_DRAG : DRAG_TYPE) || (kind === 'tab' ? tabDrag : dragging);
      if (kind === 'tab') {
        tabDragDone();
        if (id) moveTab(id, at);
        refreshStrip();
        return;
      }
      dragDone();
      if (!id) return;
      if (tabAt(id) !== -1) moveTab(id, at);
      else { tabs.open.splice(Math.min(at, tabs.open.length), 0, id); saveTabs(); }
      goTab(id);
      letFocusGo();
    });
  }

  // The place a drop at `x` lands: before the first tab whose middle is right of it.
  function slotAt(list, x) {
    var els = list.querySelectorAll('.wbtab[data-wb-tab]');
    for (var i = 0; i < els.length; i++) {
      var b = els[i].getBoundingClientRect();
      if (x < b.left + b.width / 2) return i;
    }
    return els.length;
  }

  function showSlot(list, at) {
    var els = list.querySelectorAll('.wbtab[data-wb-tab]');
    var line = list.querySelector('.wbins') || list.appendChild(h('span.wbins', { 'aria-hidden': 'true' }));
    var x = !els.length ? 0 : at < els.length ? els[at].offsetLeft : els[els.length - 1].offsetLeft + els[els.length - 1].offsetWidth;
    line.style.left = Math.max(0, x - 1) + 'px';
  }

  function hideSlot(list) {
    var line = list && list.querySelector('.wbins');
    if (line) line.remove();
  }

  // The end of a tab's drag, however it ends — the same three ways as a row's (dragDone):
  // a render mid-drag can detach the tab, and Chromium fires no dragend at a source that
  // has left the document.
  function tabDragDone() {
    if (!tabDrag) return;
    tabDrag = null;
    Array.prototype.forEach.call(document.querySelectorAll('#main .wbtab.lifted'), function (el) { el.classList.remove('lifted'); });
    Array.prototype.forEach.call(document.querySelectorAll('#main .wbins'), function (el) { el.remove(); });
    if (stripStale) {
      stripStale = false;
      refreshStrip();
    }
  }

  window.addEventListener('drop', tabDragDone);
  window.addEventListener('dragend', tabDragDone, true);
  document.addEventListener('mousedown', tabDragDone, true);
  document.addEventListener('mousemove', function (e) { if (tabDrag && !e.buttons) tabDragDone(); }, true);

  // The keyboard on the strip: Enter or Space shows the focused tab, ← and → move along.
  function tabKeys(e) {
    var el = e.target instanceof Element ? e.target : null;
    if (!el || !el.classList.contains('wbtab') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      var id = el.getAttribute('data-wb-tab') || null;
      if (el.classList.contains('on')) return;
      goTab(id);
      // The keyboard stays on the tab it chose, in the strip just drawn (a render is
      // synchronous) — the library's and a board's are different strips.
      focusEl(document.querySelector('#main .wbstrip .wbtab[data-wb-tab="' + cssId(id || '') + '"]'));
      return;
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    var strip = el.closest('.wbstrip');
    var all = strip ? Array.prototype.slice.call(strip.querySelectorAll('.wbtab')) : [];
    var next = all[all.indexOf(el) + (e.key === 'ArrowRight' ? 1 : -1)];
    if (!next) return;
    focusEl(next);
    var list = strip.querySelector('.wbtl');
    if (list && list.contains(next)) revealX(list, next);
  }

  // After a click on a tab, or a pick from the strip's picker or list, the keyboard is
  // the board's: a tab left focused would keep ⌘Z, ⌘V and the canvas keys from it.
  function letFocusGo() {
    var a = document.activeElement;
    if (a && a !== document.body && typeof a.closest === 'function' && a.closest('.wbstrip, .wbpop') &&
        typeof a.blur === 'function') a.blur();
  }

  function revealX(list, el) {
    var left = el.offsetLeft, right = left + el.offsetWidth;
    if (left < list.scrollLeft) list.scrollLeft = left;
    else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth;
  }

  // After every render, and whenever the strip changes size: the tabs keep where they
  // were scrolled to, the tab that just came up is scrolled into view, and "N open"
  // shows only while some tabs are out of sight.
  var stripSeen = null;
  var stripWatch = typeof ResizeObserver === 'function' ? new ResizeObserver(function () { fitOverflow(); }) : null;

  function fitOverflow() {
    var strip = document.querySelector('#main .wbstrip');
    var list = strip && strip.querySelector('.wbtl');
    if (!list) return;
    strip.classList.toggle('ovf', list.scrollWidth > list.clientWidth + 1);
  }

  function fitStrip() {
    var strip = document.querySelector('#main .wbstrip');
    var list = strip && strip.querySelector('.wbtl');
    if (stripWatch && strip !== stripSeen) {
      stripWatch.disconnect();
      if (strip) stripWatch.observe(strip);
    }
    stripSeen = strip;
    if (!list) { revealed = null; return; }
    if (list.scrollLeft !== stripScroll) list.scrollLeft = stripScroll;
    fitOverflow();
    var on = list.querySelector('.wbtab.on');
    var id = on ? on.getAttribute('data-wb-tab') : null;
    if (on && id !== revealed) revealX(list, on);
    revealed = id;
    stripScroll = list.scrollLeft;
  }

  // Something a tab says changed outside a render — a write, a terminal, an answer, a
  // tab closed or moved: the board's strip catches up in place; the home is drawn again,
  // and only when its strip would say something else.
  function refreshStrip() {
    var r = route();
    if (r.view === 'whiteboard' && r.board) {
      if (view && view.root.isConnected) {
        putStrip(view, r);
        fitStrip();
      }
      return;
    }
    if (r.view !== 'whiteboards') return;
    var sig = tabs.open.length ? JSON.stringify(stripModel(r)) : '';
    if (sig !== homeSig) repaint();
  }

  // The home's strip, rebuilt with the home on every render; none until a board is open.
  function homeStrip(r) {
    if (!tabs.open.length) { homeSig = ''; return null; }
    var m = stripModel(r);
    homeSig = JSON.stringify(m);
    return stripEl(m);
  }

  // ── the strip's picker and menus ──────────────────────────────────────────
  //
  // On <body>, fixed, outside every render: the home is rebuilt by each bell, and what
  // is open over the strip — a search half typed — must not go with it. One at a time;
  // a press anywhere else, Esc, the window losing focus or the route moving on puts it
  // away.

  var pop = null;           // { kind, el, at, anchor, toggle, route }
  var finder = null;        // the + picker's state while it is open

  function routeSig(r) {
    return String(r.view) + ':' + String((r.view === 'whiteboard' ? r.board : r.folder) || '');
  }

  function closePop(refocus) {
    if (!pop) return;
    var p = pop;
    pop = null;
    finder = null;
    if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
    if (!refocus) return;
    var back = p.anchor && p.anchor.isConnected ? p.anchor
      : (p.toggle ? document.querySelector('#main ' + p.toggle) : null);
    focusEl(back);
  }

  function showPop(kind, el, at, anchor, toggle) {
    closePop(false);
    el.classList.add('wbpop');
    document.body.appendChild(el);
    pop = { kind: kind, el: el, at: at, anchor: anchor || null, toggle: toggle || null, route: routeSig(route()) };
    placePop();
  }

  // Under its button (or at the pointer, for a tab's menu), kept inside the window, and
  // above when there is no room below.
  function placePop() {
    if (!pop) return;
    var el = pop.el, at = pop.at, m = 8;
    var w = el.offsetWidth, ht = el.offsetHeight;
    var x = at.right ? at.x - w : at.x;
    var y = at.y;
    if (y + ht > window.innerHeight - m) {
      y = at.above - ht >= m ? at.above - ht : Math.max(m, window.innerHeight - m - ht);
    }
    x = Math.max(m, Math.min(x, window.innerWidth - m - w));
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
  }

  function under(anchor, right) {
    var b = anchor.getBoundingClientRect();
    return { x: right ? b.right : b.left, y: b.bottom + 6, above: b.top - 6, right: !!right };
  }

  document.addEventListener('mousedown', function (e) {
    if (!pop) return;
    var t = e.target;
    if (t instanceof Node && pop.el.contains(t)) return;
    // Its own button toggles it, on the click.
    if (pop.toggle && t instanceof Element && t.closest(pop.toggle)) return;
    closePop(false);
  }, true);
  // Capture, on the window: ahead of the app's "Esc means back", and of the canvas.
  window.addEventListener('keydown', function (e) {
    if (!pop || e.key !== 'Escape' || e.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    if (finder && finder.mode === 'new' && !finder.pending) { finderMode('find'); return; }
    closePop(true);
  }, true);
  window.addEventListener('blur', function () { closePop(false); });
  window.addEventListener('resize', function () { closePop(false); });

  function popItem(label, run, opts) {
    opts = opts || {};
    return h('button.mi', {
      type: 'button',
      role: 'menuitem',
      disabled: opts.disabled ? true : null,
      onClick: function () { closePop(false); run(); }
    }, h('span.ml', null, label), opts.kbd ? h('span.kbd', null, opts.kbd) : null);
  }

  // ↑ and ↓ through a menu's items.
  function popKeys(e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    var items = Array.prototype.slice.call(e.currentTarget.querySelectorAll('.mi:not([disabled])'));
    if (!items.length) return;
    var at = items.indexOf(document.activeElement);
    focusEl(items[e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length]);
  }

  function showInLibrary(id) {
    var item = canvases[id];
    var b = item && item.summary ? item.summary : boardById(lastGood, id);
    goHome(b ? listedIn(b) : lastFolder());
  }

  // A tab's right-click menu.
  function openTabMenu(id, x, y, anchor) {
    var r = route();
    var on = r.view === 'whiteboard' && r.board === id;
    var right = tabs.open.slice(tabAt(id) + 1);
    var menu = h('div.menu.wbmenu', { role: 'menu', 'aria-label': 'Tab', onKeydown: popKeys },
      popItem('Close tab', function () { closeTabs([id]); }, { kbd: on ? '⌘W' : null }),
      popItem('Close other tabs', function () { closeOthers(id); }, { disabled: tabs.open.length < 2 }),
      popItem('Close tabs to the right', function () { closeTabs(right); }, { disabled: !right.length }),
      h('div.msep'),
      popItem('Show in Whiteboards', function () { showInLibrary(id); }));
    showPop('tab', menu, { x: x, y: y, above: y }, anchor, null);
    focusEl(menu.querySelector('.mi:not([disabled])'));
  }

  // "N open": every tab, with where it is and its dot, then Close other tabs and Close all.
  function toggleOpenList(anchor) {
    if (pop && pop.kind === 'list') { closePop(true); return; }
    var r = route();
    var current = r.view === 'whiteboard' ? r.board : null;
    var menu = h('div.menu.wbmenu.wbopenl', { role: 'menu', 'aria-label': 'Open whiteboards', onKeydown: popKeys });
    tabs.open.forEach(function (id) {
      var t = tabOf(id, r);
      menu.appendChild(h('button.mi' + (t.on ? '.on' : ''), {
        type: 'button',
        role: 'menuitemradio',
        'aria-checked': t.on ? 'true' : 'false',
        onClick: function () {
          closePop(false);
          if (!t.on) goTab(id);
          letFocusGo();
        }
      },
        h('span.ck', null, t.on ? D.icon('check') : null),
        h('span.ml', null, t.name),
        t.dot ? h('span.dot.' + t.dot, { title: DOT_TITLE[t.dot] }) : null,
        h('span.pl', null, t.place)));
    });
    menu.appendChild(h('div.msep'));
    menu.appendChild(popItem('Close other tabs', function () { closeOthers(current); },
      { disabled: !current || tabs.open.length < 2 }));
    menu.appendChild(popItem('Close all tabs', closeAll));
    showPop('list', menu, under(anchor, true), anchor, '[data-wb-more]');
    focusEl(menu.querySelector('.mi.on') || menu.querySelector('.mi'));
  }

  // + : a board to open in a new tab — a search over every board, else the six edited
  // last and the folders to look through — or a new one. A board already open is shown
  // in the tab it has, never opened twice.
  function togglePicker(anchor) {
    if (pop && pop.kind === 'find') { closePop(true); return; }
    // Read again if the last read failed; the picker fills in when main answers.
    if (indexError && typeof SB.invalidate === 'function') SB.invalidate(INDEX_KEY);
    loadIndex();
    var icon = D.icon('search');
    var input = h('input.wbfq', {
      type: 'text',
      placeholder: 'Search whiteboards',
      'aria-label': 'Search whiteboards',
      maxlength: '120',
      spellcheck: 'false',
      autocomplete: 'off',
      onInput: function () {
        if (!finder) return;
        if (finder.mode === 'find') {
          finder.q = input.value;
          finder.hi = 0;
        }
        finder.error = null;
        paintFinder();
      },
      onKeydown: finderKeys
    });
    var list = h('div.wbfl');
    var foot = h('div.wbff',
      h('button', { type: 'button', onClick: function (e) { if (e.detail < 2) finderMode('new'); } },
        D.icon('plus'), 'New whiteboard…'),
      h('span.sp'),
      h('button', {
        type: 'button',
        onClick: function (e) { if (e.detail > 1) return; closePop(false); goTab(null); letFocusGo(); }
      }, 'All whiteboards', D.icon('chev')));
    var el = h('div.menu.wbfind', { role: 'dialog', 'aria-label': 'Open a whiteboard' },
      h('label.wbfh', null, icon, input), list, foot);
    showPop('find', el, under(anchor, false), anchor, '[data-wb-add]');
    finder = {
      el: el, icon: icon, input: input, list: list, foot: foot,
      q: '', drill: null, mode: 'find', hi: 0, rows: [], error: null, pending: false
    };
    paintFinder();
    focusEl(input);
  }

  function finderMode(mode) {
    var f = finder;
    if (!f) return;
    f.mode = mode;
    f.error = null;
    f.hi = 0;
    f.input.value = f.q;
    f.input.placeholder = mode === 'new' ? 'Name the new whiteboard' : 'Search whiteboards';
    f.input.setAttribute('aria-label', mode === 'new' ? 'Name for the new whiteboard' : 'Search whiteboards');
    var icon = D.icon(mode === 'new' ? 'plus' : 'search');
    f.icon.replaceWith(icon);
    f.icon = icon;
    paintFinder();
    focusEl(f.input);
    try { f.input.setSelectionRange(f.input.value.length, f.input.value.length); } catch (e) { /* not a text field */ }
  }

  // Where a whiteboard made here lands: the folder the picker is showing, else the
  // folder of the board on screen, else the one the library shows. All, Recent, No
  // folder and Archived are not folders: none.
  function newFolder() {
    var data = lastGood;
    if (!data) return null;
    var r = route();
    var keys = [finder && finder.drill];
    if (r.view === 'whiteboard') {
      var item = canvases[r.board];
      var b = item && item.summary ? item.summary : boardById(data, r.board);
      keys.push(b && b.folderId);
    } else keys.push(r.folder);
    for (var i = 0; i < keys.length; i++) {
      var f = folderById(data, keys[i]);
      if (f) return f;
    }
    return null;
  }

  function finderRow(f, el, run) {
    var row = { el: el, run: run };
    // A press keeps the keyboard in the search field; the click picks. Only a fresh one:
    // a folder's row redraws the list under the pointer, and a double-click's second
    // click would open whichever board landed there.
    el.addEventListener('mousedown', function (e) { if (e.button === 0) e.preventDefault(); });
    el.addEventListener('click', function (e) { if (e.detail < 2) run(); });
    f.rows.push(row);
    f.list.appendChild(el);
  }

  function boardRow(f, b, where) {
    var open = tabAt(b.id) !== -1;
    finderRow(f, h('button.wbfr', { type: 'button', tabindex: '-1', title: b.name },
      D.icon(b.archivedAt ? 'archive' : 'board'),
      h('span.nm', null, b.name),
      open ? h('span.tag', null, 'open') : null,
      where ? h('span.ct', null, placeOf(b, null)) : null), function () {
      closePop(false);
      openTab(b.id, null);
      letFocusGo();
    });
  }

  function folderRow(f, o) {
    finderRow(f, h('button.wbfr', { type: 'button', tabindex: '-1' },
      D.icon(o.icon),
      h('span.nm', null, o.label),
      h('span.ct', null, String(o.count)),
      D.icon('chev')), function () {
      f.drill = o.key;
      f.hi = 1;          // its first board, past the way back
      paintFinder();
      focusEl(f.input);
    });
  }

  function paintFinder() {
    var f = finder;
    if (!f) return;
    D.clear(f.list);
    f.rows = [];
    f.foot.hidden = f.mode === 'new';
    var data = lastGood;
    if (f.mode === 'new') {
      var into = newFolder();
      f.list.appendChild(h('p.wbfn', null, f.pending ? 'Making it…'
        : 'Lands in ' + (into ? into.name : 'No folder') + ' · Enter to make it · Esc to go back'));
      if (f.error) f.list.appendChild(h('p.wbfn.bad', null, f.error));
      placePop();
      return;
    }
    if (!data) {
      f.list.appendChild(h('p.wbfn' + (indexError ? '.bad' : ''), null,
        indexError ? 'Couldn’t read the whiteboards — ' + indexError : 'Reading your whiteboards…'));
      placePop();
      return;
    }
    var q = f.q.replace(/\s+/g, ' ').trim();
    var lower = q.toLowerCase();
    if (q) {
      var hits = data.boards.filter(function (b) { return String(b.name).toLowerCase().indexOf(lower) !== -1; });
      // Active boards first, newest first within each (main's order, kept: sort is stable).
      hits.sort(function (a, b) { return (a.archivedAt ? 1 : 0) - (b.archivedAt ? 1 : 0); });
      hits.slice(0, 40).forEach(function (b) { boardRow(f, b, true); });
      if (!hits.length) f.list.appendChild(h('p.wbfn', null, 'No whiteboard is called that'));
      var exact = hits.some(function (b) { return String(b.name).toLowerCase() === lower; });
      if (!exact) {
        finderRow(f, h('button.wbfr.mk', { type: 'button', tabindex: '-1' },
          D.icon('plus'), h('span.nm', null, 'New whiteboard “' + q + '”')), function () {
          finderMode('new');
          createBoard(q);
        });
      }
    } else if (f.drill) {
      var key = resolveKey(data, f.drill);
      finderRow(f, h('button.wbfr.up', { type: 'button', tabindex: '-1' },
        D.icon('chevL'), h('span.nm', null, keyLabel(data, key))), function () {
        f.drill = null;
        f.hi = 0;
        paintFinder();
        focusEl(f.input);
      });
      var rows = boardsIn(data, key);
      rows.forEach(function (b) { boardRow(f, b, false); });
      if (!rows.length) f.list.appendChild(h('p.wbfn', null, 'Nothing in ' + keyLabel(data, key) + ' yet'));
    } else {
      var all = live(data);
      var recent = all.slice(0, PICK_RECENT);
      if (recent.length) {
        f.list.appendChild(h('div.wbfg', null, 'Recent'));
        recent.forEach(function (b) { boardRow(f, b, true); });
      }
      var places = data.folders.map(function (x) {
        return { key: x.id, label: x.name, count: Number(x.count) || 0, icon: 'folder' };
      });
      var none = all.filter(function (b) { return inNoFolder(data, b); }).length;
      if (none) places.push({ key: 'none', label: 'No folder', count: none, icon: 'folder' });
      var archived = data.boards.length - all.length;
      if (archived) places.push({ key: 'archived', label: 'Archived', count: archived, icon: 'archive' });
      if (places.length) {
        f.list.appendChild(h('div.wbfg', null, 'Folders'));
        places.forEach(function (o) { folderRow(f, o); });
      }
      if (!data.boards.length) f.list.appendChild(h('p.wbfn', null, 'No whiteboards yet — make one below'));
    }
    if (f.hi >= f.rows.length) f.hi = Math.max(0, f.rows.length - 1);
    markHi(false);
    placePop();
  }

  function markHi(scroll) {
    var f = finder;
    if (!f) return;
    f.rows.forEach(function (row, i) { row.el.classList.toggle('hi', i === f.hi); });
    var el = f.rows[f.hi] && f.rows[f.hi].el;
    if (!scroll || !el) return;
    var list = f.list;
    if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop - 4;
    else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight + 4;
    }
  }

  function finderKeys(e) {
    var f = finder;
    if (!f || e.isComposing) return;
    if (f.mode === 'new') {
      if (e.key === 'Enter') {
        e.preventDefault();
        createBoard(f.input.value);
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!f.rows.length) return;
      f.hi = (f.hi + (e.key === 'ArrowDown' ? 1 : -1) + f.rows.length) % f.rows.length;
      markHi(true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      var row = f.rows[f.hi];
      if (row) row.run();
    } else if (e.key === 'Backspace' && !f.input.value && f.drill) {
      e.preventDefault();
      f.drill = null;
      f.hi = 0;
      paintFinder();
    }
  }

  // New whiteboard…: a blank board in newFolder(), its workspace left to main (the one
  // used last), opened in a new tab at the end of the strip. Main's sentence stays in
  // the picker when it refuses (a name already used in that folder, say).
  function createBoard(raw) {
    var f = finder;
    if (!f || f.pending) return;
    var name = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!name) return;
    var b = bundle();
    var spec = null;
    try { spec = b && typeof b.blankSpec === 'function' ? b.blankSpec() : null; } catch (err) { f.error = message(err); }
    if (!spec) {
      f.error = f.error || 'the whiteboard editor is not built — run npm run build:diagrams, then reopen Switchboard';
      paintFinder();
      return;
    }
    var into = newFolder();
    f.pending = true;
    f.error = null;
    paintFinder();
    call('whiteboardsCreate', { folderId: into ? into.id : null, name: name, spec: spec }).then(function (res) {
      f.pending = false;
      if (!res || res.ok !== true || !res.data || !res.data.id) {
        f.error = message(res && res.error);
        if (finder === f) paintFinder();
        return;
      }
      if (typeof SB.invalidate === 'function') SB.invalidate('wb:');
      if (finder === f) closePop(false);
      openTab(res.data.id, null);
      letFocusGo();
    });
  }

  // ── canvases ──────────────────────────────────────────────────────────────

  var canvases = Object.create(null);   // boardId → item, see makeCanvas
  var clock = 0;                        // the LRU's order: higher was shown more recently
  var told = 0;

  function reportDirty(boardId, count) {
    if (canvases[boardId]) canvases[boardId].dirty = count > 0;
    var n = Object.keys(canvases).some(function (id) { return canvases[id].dirty; }) ? 1 : 0;
    if (n === told) return;
    told = n;
    var bridge = window.sb;
    if (bridge && typeof bridge.diagramsDirty === 'function') {
      try { Promise.resolve(bridge.diagramsDirty(n))['catch'](noop); } catch (e) { /* bridge gone */ }
    }
  }

  // The board's own full screen: the slab leaves its home for <body>, whole, so the
  // editor, its terminals and focus come along. no-drag (.full) because the slab now
  // covers the header's drag region, which Electron still counts underneath it.
  function hostFullscreen(item, open) {
    if (open === item.fullscreen) return;
    item.fullscreen = open;
    if (open) {
      item.home = item.slab.parentNode || item.home;
      document.body.appendChild(item.slab);
      item.slab.classList.add('full');
      Object.assign(item.slab.style, {
        position: 'fixed', inset: '0', zIndex: '1000', margin: '0',
        borderRadius: '0', overflow: 'visible'
      });
      return;
    }
    item.slab.classList.remove('full');
    ['position', 'inset', 'zIndex', 'margin', 'borderRadius', 'overflow'].forEach(function (k) { item.slab.style[k] = ''; });
    // Left by the user, on screen: nothing to come back to.
    if (visible(item, route())) item.resumeFull = false;
    rehome(item);
  }

  // Back where it belongs — unless that place now shows something else (the route moved
  // on while the board was full screen): then it simply parks until it is shown again.
  function rehome(item) {
    var home = item.home;
    var r = route();
    var mine = !!home && home.isConnected && !!view && home === view.body &&
      r.view === 'whiteboard' && r.board === item.boardId;
    if (mine) home.appendChild(item.slab);
    else if (item.slab.parentNode) item.slab.parentNode.removeChild(item.slab);
  }

  // The rail's view of every workspace, for the editor's pinned-terminal headers:
  // the same dot as the rail, and the branch once a scan has said it.
  function workspaceStatus() {
    var out = {};
    var st = SB.state || {};
    (st.workspaces || []).forEach(function (ws) {
      out[ws.id] = {
        dot: typeof SB.dotFor === 'function' ? (SB.dotFor(ws) || '') : '',
        branch: ws.scanned ? (ws.branchSummary || null) : null
      };
    });
    return out;
  }

  function attachLayer(item) {
    if (item.layer) return item.layer;
    // A canvas let go has no layer, and must not grow a new one: its editor is still
    // mounted until forget()'s deferred destroy, and a Delete's own aftermath (the page
    // drawing "missing" reports its pinned slots as []) used to attach a fresh layer to
    // the dead slab here — one that nothing would ever destroy.
    if (item.dead) return null;
    var wbt = SB.wbTerminals;
    if (!wbt || typeof wbt.attach !== 'function') return null;
    try {
      item.layer = wbt.attach({
        boardId: item.boardId,
        slab: item.slab,
        getApi: function () { return item.api; },
        getBoard: function () { return item.summary; },
        onChange: function (list) { if (!item.dead) terminalsChanged(item, list); }
      }) || null;
    } catch (err) {
      console.error('[switchboard] whiteboards: terminals:', err);
      item.layer = null;
    }
    return item.layer;
  }

  // Calls the layer, feature-checked: a build without views/wbterminals.js still draws
  // and edits boards, it just has no terminals over them.
  function layerCall(item, name) {
    var layer = attachLayer(item);
    if (!layer || typeof layer[name] !== 'function') return undefined;
    var args = Array.prototype.slice.call(arguments, 2);
    try { return layer[name].apply(layer, args); } catch (err) {
      console.error('[switchboard] whiteboards: terminals ' + name + ':', err);
      return undefined;
    }
  }

  function terminalsChanged(item, list) {
    var next = Array.isArray(list) ? list : [];
    var sig = JSON.stringify(next);
    if (sig === item.termSig) return;
    item.termSig = sig;
    item.terminals = next;
    if (item.api) {
      try { item.api.update({ terminals: next }); } catch (err) { console.error('[switchboard] whiteboards: update:', err); }
    }
    refreshStrip();
  }

  function boardChanged(item, board, folder) {
    var wasArchived = !!(item.summary && item.summary.archivedAt);
    item.loaded = true;
    item.summary = board || null;
    item.folder = folder || null;
    var r = route();
    if (board && r.view === 'whiteboard' && r.board === item.boardId) rememberFolder(listedIn(board));
    refreshStrip();
    // Archive and Unarchive come through here, and nothing else renders for them: the
    // terminal layer repaints its panels' Pin buttons (disabled exactly while the board
    // is archived) now rather than at whatever render happens next.
    if (item.layer && wasArchived !== !!(board && board.archivedAt)) {
      layerCall(item, 'shown', visible(item, route()));
    }
  }

  // Duplicate: the copy opens in a tab of its own, right after this board's.
  function openFrom(item, id) {
    if (!id || id === item.boardId) return;
    openTab(id, item.boardId);
  }

  // After Delete, or Back on a board that is missing or can't be opened: its tab closes
  // and its canvas is let go. From the board's own screen the next tab comes up, or, with
  // none left, the list the board was in: its folder, No folder, or Archived for an
  // archived one (listedIn). A board that was never read has no list; All, or the folder
  // the editor names. A board that merely couldn't be read — a hand-edited file that is
  // not JSON, a read that failed — opens again from that list once the file is fixed.
  function closedFrom(item, folderId) {
    var back = item.summary ? listedIn(item.summary) : (folderId || 'all');
    closeTabs([item.boardId], back);
    if (canvases[item.boardId] === item) forget(item);
  }

  function makeCanvas(boardId) {
    var have = canvases[boardId];
    if (have) return have;
    evict();
    var slab = h('div.dgslab', { dataset: { wbBoard: boardId } });
    // The editor is mounted in .dgcanvas; the terminal layer puts its panels beside it,
    // in the slab but outside the React/Tailwind scope (.sbdg).
    var canvas = h('div.dgcanvas');
    slab.appendChild(canvas);
    var index = boardById(lastGood, boardId);
    var item = {
      boardId: boardId, slab: slab, canvas: canvas, api: null, layer: null,
      active: false, dirty: false, home: null, fullscreen: false, resumeFull: false, answering: 0,
      summary: null, folder: null, loaded: false,
      lastShown: ++clock,
      terminals: [], termSig: '[]', statusSig: '', dead: false
    };
    if (index) item.folder = folderById(lastGood, index.folderId);
    canvases[boardId] = item;
    var b = bundle();
    if (!b || typeof b.create !== 'function') {
      slab.classList.add('blank');
      slab.appendChild(D.empty('run npm run build:diagrams in the switchboard checkout, then reopen it.',
        { title: 'the whiteboard editor is not built' }));
      return item;
    }
    var status = workspaceStatus();
    item.statusSig = JSON.stringify(status);
    // The editor's calls, silent once the canvas has been let go (forget): the editor
    // stays mounted until the deferred destroy, and what it says in that gap is about a
    // canvas that is gone — a dirty flag, or terminal slots, that would otherwise land on
    // a new canvas for the same board, or attach a layer to the dead one.
    function kept(fn) {
      return function () { if (!item.dead) return fn.apply(null, arguments); };
    }
    try {
      item.api = b.create(canvas, {
        boardId: boardId,
        active: false,
        onOpenSettings: function () { SB.go({ view: 'settings' }); },
        onOpenBoard: kept(function (id) { openFrom(item, id); }),
        onClosed: kept(function (folderId) { closedFrom(item, folderId); }),
        onBoardChange: kept(function (board, folder) { boardChanged(item, board, folder); }),
        onDirty: kept(function (count) { reportDirty(boardId, count); }),
        onFullscreenChange: kept(function (open) { hostFullscreen(item, !!open); }),
        onAnswering: kept(function (count) {
          var n = Number(count) || 0;
          if (n === item.answering) return;
          item.answering = n;
          refreshStrip();
        }),
        terminals: [],
        workspaceStatus: status,
        onOpenTerminal: kept(function (wsId) { layerCall(item, 'open', wsId); }),
        onToggleTerminals: kept(function () { layerCall(item, 'toggleAll'); }),
        onTerminalSlots: kept(function (slots) { layerCall(item, 'slots', slots); }),
        onTerminalFloat: kept(function (wsId) { layerCall(item, 'float', wsId); }),
        onTerminalRemoved: kept(function (wsId, reason, rect) { layerCall(item, 'removed', wsId, reason, rect); })
      }) || null;
    } catch (err) {
      console.error('[switchboard] whiteboards: mount:', err);
      item.api = null;
    }
    attachLayer(item);
    return item;
  }

  // Lets one canvas go: its terminal layer (panels detach; every shell lives on) and
  // its editor (which writes what it has first). The LRU never picks a dirty one; a
  // closed tab, Delete and Back let theirs go whatever it holds, through that write.
  function forget(item) {
    if (canvases[item.boardId] !== item) return;
    item.dead = true;
    delete canvases[item.boardId];
    if (item.slab.parentNode) item.slab.parentNode.removeChild(item.slab);
    var layer = item.layer;
    var bundleApi = item.api;
    item.layer = null;
    item.api = null;
    // After the current task: this is often a callback from inside the editor (Delete),
    // and React must not be unmounted from under its own event.
    setTimeout(function () {
      if (layer && typeof layer.destroy === 'function') {
        try { layer.destroy(); } catch (err) { console.error('[switchboard] whiteboards: terminals destroy:', err); }
      }
      if (!bundleApi) return;
      try {
        if (typeof bundleApi.destroy === 'function') Promise.resolve(bundleApi.destroy())['catch'](noop);
        else if (typeof bundleApi.flush === 'function') Promise.resolve(bundleApi.flush())['catch'](noop);
      } catch (err) { console.error('[switchboard] whiteboards: destroy:', err); }
    }, 0);
    reportDirty(item.boardId, 0);
  }

  // At most MAX_CANVASES. The one let go is off screen, not full screen, has nothing
  // unsaved and no ✦ Answer on its way (letting it go would cancel the answer): a board
  // with no tab before one still in a tab, then the least recently shown. Its tab stays;
  // the canvas is mounted again when the tab is next shown.
  function evict() {
    var ids = Object.keys(canvases);
    var r = route();
    while (ids.length >= MAX_CANVASES) {
      var victim = null;
      for (var i = 0; i < ids.length; i++) {
        var it = canvases[ids[i]];
        if (it.dirty || it.fullscreen || it.answering > 0 || it.slab.isConnected || visible(it, r)) continue;
        if (!victim || sooner(it, victim)) victim = it;
      }
      if (!victim) return;
      forget(victim);
      ids = Object.keys(canvases);
    }
  }

  function sooner(a, b) {
    var inA = tabAt(a.boardId) !== -1, inB = tabAt(b.boardId) !== -1;
    if (inA !== inB) return !inA;
    return a.lastShown < b.lastShown;
  }

  function visible(item, r) {
    if (!item.slab.isConnected) return false;
    if (r.view === 'whiteboard') {
      return item.boardId === r.board && !!view && item.home === view.body && view.root.isConnected;
    }
    return false;
  }

  function activeCanvas(r) {
    if (r.view === 'whiteboard' && r.board) {
      var it = canvases[r.board];
      return it && it.slab.isConnected && view && it.home === view.body && view.root.isConnected ? it : null;
    }
    return null;
  }

  // After every render (app.js renderMain): which canvas owns the keyboard, which are on
  // screen, the pinned-terminal header dots, and the terminal layers' turn to re-place
  // their xterms. The status goes only to canvases on screen, and only when it changed —
  // a parked board catches up the moment it is shown.
  function shown(r) {
    r = r || route();
    if (pop && pop.route !== routeSig(r)) closePop(false);
    var current = activeCanvas(r);
    var status = null;
    var sig = '';
    var away = r.view !== 'whiteboard' && r.view !== 'whiteboards';
    Object.keys(canvases).forEach(function (id) {
      var item = canvases[id];
      var on = visible(item, r);
      // A full-screen board covers the window; once the route has moved on, it goes back.
      // Left for another screen altogether (⌘0 to the Grid, say), it is full screen again
      // when the user comes back to it — the way it was left.
      if (item.fullscreen && !on && item.api && typeof item.api.leaveFullscreen === 'function') {
        if (away) item.resumeFull = true;
        try { item.api.leaveFullscreen(); } catch (err) { /* the editor is gone */ }
      }
      if (on) item.lastShown = ++clock;
      var patch = null;
      var active = item === current;
      if (item.api && item.active !== active) {
        item.active = active;
        patch = { active: active };
      }
      if (item.api && on) {
        if (status === null) { status = workspaceStatus(); sig = JSON.stringify(status); }
        if (item.statusSig !== sig) {
          item.statusSig = sig;
          patch = patch || {};
          patch.workspaceStatus = status;
        }
      }
      if (patch) {
        try { item.api.update(patch); } catch (err) { console.error('[switchboard] whiteboards: update:', err); }
      }
      if (on && item.api && (item.resumeFull || carryFull === id)) {
        item.resumeFull = false;
        if (carryFull === id) carryFull = null;
        if (typeof item.api.enterFullscreen === 'function') {
          try { item.api.enterFullscreen(); } catch (err) { console.error('[switchboard] whiteboards: full screen:', err); }
        }
      }
      if (item.layer || on) layerCall(item, 'shown', on);
    });
    if (carryFull && !(r.view === 'whiteboard' && r.board === carryFull)) carryFull = null;
    if (r.view === 'whiteboard' && r.board && canvases[r.board] && canvases[r.board].summary) {
      rememberFolder(listedIn(canvases[r.board].summary));
    }
    fitStrip();
  }

  // ── terminals, as app.js asks about them ──────────────────────────────────

  // ⌘A: show or hide this board's terminals (views/wbterminals.js decides what that
  // means). The xterms' own helper textareas are part of it; every other text field,
  // menu, dialog and list keeps Select All.
  function toggleTerminalShortcut() {
    var item = activeCanvas(route());
    if (!item || !item.api) return false;
    var active = document.activeElement;
    if (active && active !== document.body) {
      if (!active.closest('[data-wb-terminal]') && (active.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT|WEBVIEW)$/.test(active.tagName) ||
          active.closest('[role="dialog"], [role="menu"], [role="listbox"]'))) return false;
    }
    var layer = attachLayer(item);
    if (!layer || typeof layer.toggleAll !== 'function') return false;
    try { layer.toggleAll(); } catch (err) { console.error('[switchboard] whiteboards: terminals toggleAll:', err); }
    return true;
  }

  // retirePanes(): a pane any board on screen is showing stays alive.
  function terminalShown(wsId) {
    return Object.keys(canvases).some(function (id) {
      var item = canvases[id];
      if (!item.layer || !item.slab.isConnected || typeof item.layer.shows !== 'function') return false;
      try { return !!item.layer.shows(wsId); } catch (err) { return false; }
    });
  }

  // bell(): a ring is read only while the keyboard is in that workspace's terminal on
  // a board — a floating panel or a pinned one, both [data-wb-terminal="<ws>"].
  function terminalFocused(wsId) {
    var el = document.activeElement;
    var host = el && typeof el.closest === 'function' ? el.closest('[data-wb-terminal]') : null;
    if (host && host.getAttribute('data-wb-terminal') === wsId) return true;
    return Object.keys(canvases).some(function (id) {
      var item = canvases[id];
      if (!item.layer || typeof item.layer.focused !== 'function') return false;
      try { return !!item.layer.focused(wsId); } catch (err) { return false; }
    });
  }

  // ── keys and the Edit menu ────────────────────────────────────────────────

  function onKey(e) {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && String(e.key).toLowerCase() === 'a') {
      return toggleTerminalShortcut();
    }
    var r = route();
    if (tabKey(e, r)) return true;
    var item = activeCanvas(r);
    if (!item || !item.api) return false;
    // A terminal on the board is a shell: its keys are its own, Esc above all (wbterminals.js
    // stops them at the panel or pinned overlay; this is for anything that slips past).
    // [data-wb-terminal="<ws>"] is a terminal; the tray carries the attribute with no
    // workspace — it is the board's chrome, its buttons, and Esc there is the board's.
    var shell = e.target instanceof Element ? e.target.closest('[data-wb-terminal]') : null;
    if (shell && shell.getAttribute('data-wb-terminal')) return false;
    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) return escape(e, item);
    if (shell) return false;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      var target = e.target;
      return target === document.body || (!!target && (item.slab.contains(target) || item.api.contains(target)));
    }
    return false;
  }

  // ⌃Tab and ⌃⇧Tab step through the tabs, the library among them; ⌘1–9 pick a board's
  // tab, in place of their workspace meaning, while the Whiteboards screens are up and a
  // board is open. Never from inside a shell on a board: wbterminals.js keeps a shell's
  // keys its own there, as it does ⌘1–9's.
  function tabKey(e, r) {
    if (r.view !== 'whiteboard' && r.view !== 'whiteboards') return false;
    if (e.altKey || e.isComposing) return false;
    var shell = e.target instanceof Element ? e.target.closest('[data-wb-terminal]') : null;
    if (shell && shell.getAttribute('data-wb-terminal')) return false;
    if (e.key === 'Tab' && e.ctrlKey && !e.metaKey) return cycleTabs(e.shiftKey ? -1 : 1);
    if (e.metaKey && !e.ctrlKey && !e.shiftKey && /^[1-9]$/.test(String(e.key))) return jumpTab(Number(e.key));
    return false;
  }

  // A plain Esc with a board on screen. True = it is the board's, and app.js must not
  // also take it as a step back.
  function escape(e, item) {
    var t = e.target;
    // Something on the board already answered it. A Radix dialog or menu closes on this
    // very keydown — its DismissableLayer listens on the document in the capture phase,
    // marks the key handled and unmounts — so by the time it reaches the window its
    // target (the dialog's Cancel, say) is in neither the canvas nor the bundle's portal:
    // it is in no document at all. Either sign means the Esc was spent closing it.
    if (e.defaultPrevented) return true;
    if (t instanceof Node && !t.isConnected) return true;
    // Radix owns Escape inside its pickers, menus and dialogs. Their portal sits
    // outside the canvas, and Switchboard must not navigate back underneath it.
    if (t instanceof Node && item.api.contains(t) && !item.slab.contains(t)) return true;
    if (item.api.fullscreen()) { item.api.leaveFullscreen(); return true; }
    // Inside the board — the canvas, its bar, the terminals' tray, its tab strip — Esc
    // never leaves it: the canvas has already had its turn (a tool, a selection, an answer
    // being waited for), and one Esc too many must not throw the user out of the board.
    // Leaving is the Whiteboards tab, or another tab.
    if (!e.shiftKey && t instanceof Node && (item.slab.contains(t) || item.api.contains(t))) return true;
    if (!e.shiftKey && t instanceof Element && t.closest('.wbstrip')) return true;
    // With the board on screen, nothing else is focused but the page itself.
    if (!e.shiftKey && (t === document.body || t === document.documentElement)) return true;
    return false;
  }

  function editAction(action, text, image) {
    // ⌘W (File ▸ Close) closes the board's tab, wherever the keyboard is on it — a shell
    // on the board included; its shell lives on. On the library it stays the window's.
    if (action === 'close') {
      var r = route();
      if (r.view !== 'whiteboard' || !r.board) return false;
      closeTabs([r.board]);
      return true;
    }
    var item = activeCanvas(route());
    if (!item || !item.api) return false;
    var active = document.activeElement;
    if (active instanceof Element && active.closest('[data-wb-terminal]')) return false;
    if (active && active !== document.body && !item.slab.contains(active)) return false;
    try { return !!item.api.editAction(action, !!image, typeof text === 'string' ? text : ''); }
    catch (err) { console.error('[switchboard] whiteboards: edit:', err); return false; }
  }

  // A window focus: a CLI installed or signed in to while away changes who can answer,
  // and the list may have changed under the home (another window, a sync).
  function refresh() {
    var b = bundle();
    if (b && typeof b.refreshAnswers === 'function' && Object.keys(canvases).length) {
      try { b.refreshAnswers(false); } catch (err) { /* the menu asks again when it opens */ }
    }
    if (onHome() && typeof SB.invalidate === 'function') SB.invalidate(INDEX_KEY);
  }

  // ── saving on the way out ─────────────────────────────────────────────────

  function flushAll() {
    var b = bundle();
    if (!b || typeof b.flush !== 'function') return Promise.resolve();
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
      new Promise(function (done) { setTimeout(done, 1500); })
    ]).then(answer, answer);
  }
  if (window.sb && typeof window.sb.onDiagramsFlush === 'function') {
    try { window.sb.onDiagramsFlush(onFlush); } catch (err) { console.error('[switchboard] whiteboards: flush:', err); }
  }

  SB.views.whiteboards = {
    render: render,
    shown: shown,
    onKey: onKey,
    editAction: editAction,
    refresh: refresh,
    flushAll: flushAll,
    toggleTerminalShortcut: toggleTerminalShortcut,
    terminalShown: terminalShown,
    terminalFocused: terminalFocused,
    // app.js normalize(): the folder a route to the home lands on when it names none.
    lastFolder: lastFolder,
    // app.js: where the rail's Whiteboards row and a relaunch come back to — the tab
    // last on screen.
    entry: entry,
    // The editor handle for a board's live canvas, for the smoke harness and browser
    // tests to drive. Nothing in the app reads it.
    api: function (boardId) { var item = canvases[boardId]; return item ? item.api : null; }
  };
})(window.SB);
