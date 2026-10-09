// SB.views.whiteboards — the Whiteboards screen, an open whiteboard, and the live
// editor canvases behind both (§4.17, R15).
//
//   {view:'whiteboards', folder}  the home: folders on the left (the user's own, plus
//                                 All, Recent, No folder and Archived), one row per board
//                                 on the right. Built fresh on every render, like
//                                 views/prs.js; the data is main's whiteboards store
//                                 through SB.load('wb:index').
//   {view:'whiteboard', board}    one board open: a breadcrumb header and the board's
//                                 slab. A persistent root like the Editor's (R13): the
//                                 same element comes back on every render and only its
//                                 header is rebuilt, when what it says changes, so the
//                                 canvas, its xterms and focus never see a teardown.
//
// Canvases are keyed by BOARD id: one React instance (window.SBDiagrams.create) and one
// slab per board, shown on the board's own screen (or full screen) and parked off it,
// never remounted by a render. At most eight live at once; the least recently shown
// that is off screen and has nothing unsaved is let go. Each canvas has a terminal layer
// (views/wbterminals.js, SB.wbTerminals) for the terminals that float over it or are
// pinned to it; this file wires it to the editor and asks it the questions app.js has
// about bells, retiring panes and ⌘A.
//
// What lives here besides the canvases is only what a rebuild would otherwise lose:
// the name being typed into an inline field, the folder whose … menu is open, the last
// write's error, the folder the screen opens on. Views never write SB.state.
window.SB = window.SB || {};
SB.views = SB.views || {};

(function (SB) {
  'use strict';

  var D = SB.dom;
  var h = D.h;

  var INDEX_KEY = 'wb:index';                     // SB.load key; app.js stales every 'wb:' load on sb:evt:wbChanged
  var FOLDER_KEY = 'switchboard.wb.folder';       // the folder the screen opens on, across launches
  var MAX_CANVASES = 8;
  var RECENT = 12;                                // Recent = the twelve most recently edited
  var DRAG_TYPE = 'application/x-switchboard-whiteboard';
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
    if (v !== seen) {
      seen = v;
      if (v && v.ok === true && v.data && typeof v.data === 'object') lastGood = tidyIndex(v.data);
    }
    return {
      data: lastGood,
      error: entry && entry.status === 'error' ? (entry.error || 'could not list the whiteboards') : null,
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

  // ['a'] → 'a', ['a','b'] → 'a and b', ['a','b','c'] → 'a, b and c'.
  function andList(list) {
    if (list.length < 2) return list.join('');
    return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
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
    return D.frag(homeHeader(data, !got.error), bd);
  }

  // ── an open board ─────────────────────────────────────────────────────────

  var view = null;          // persistent chrome: { root, hd, body }

  function build() {
    var body = h('div.bd.pane.dgbd');
    var root = h('div.view.dgview.wbview', {
      style: 'display:flex;flex-direction:column;flex:1;min-width:0;min-height:0'
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

  // The header is rebuilt whenever what it says has changed (putHeader); a focused crumb
  // or caret keeps the focus across the swap, by position.
  function swapHeader(v, hd) {
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

  // Whiteboards › folder › board, the board's name, and one line of state: the mock-up's
  // screen 2. Until the editor has read the board, the list's copy of it stands in. Plain
  // data, so putHeader() can tell whether it differs from what is on screen.
  function headerOf(item) {
    var b = item.summary || (item.loaded ? null : boardById(lastGood, item.boardId));
    var folder = item.folder || (b && b.folderId ? folderById(lastGood, b.folderId) : null);
    // No summary once the editor has looked: the board is gone, or its file can't be
    // read (main's list skips an unreadable file too). The page under this header says
    // which, with Back — and Try again for one that can't be read — so the header stays
    // neutral rather than calling a board that is only unreadable gone.
    if (!b) {
      return {
        board: item.boardId, key: null, mid: null,
        name: item.loaded ? 'Unavailable' : '…',
        title: item.loaded ? "This whiteboard can't be shown" : '\u00a0',
        sub: ''
      };
    }
    var key = listedIn(b);
    var reads = Array.isArray(b.reads) ? b.reads : [];
    var sub = 'Saved locally · ' + boxes(b.boxes) + ' · ' + (reads.length ? 'answers read ' + andList(reads) : 'no answers yet');
    var terms = (item.terminals || []).filter(function (t) { return t && (t.open || t.minimized || t.pinned); }).length;
    if (terms) sub += ' · ' + D.plural(terms, 'terminal');
    if (b.archivedAt) sub += ' · archived';
    return {
      board: item.boardId, key: key,
      mid: key === 'archived' ? 'Archived' : key === 'none' ? 'No folder' : (folder ? folder.name : 'Folder'),
      name: b.name, title: b.name, sub: sub
    };
  }

  function boardHeader(m) {
    var items = [{ label: 'Whiteboards', onClick: function () { goHome('all'); } }];
    if (m.mid !== null) items.push({ label: m.mid, onClick: function () { goHome(m.key); } });
    items.push({ label: m.name });
    return h('div.hd.wbbhd',
      D.crumb(items),
      h('div.top', null, h('h1', null, m.title)),
      h('div.sub.sec', null, m.sub || '\u00a0'));
  }

  // The header is swapped only when what it says has changed. The editor reports every
  // write, autosave included, and an app render comes with every bell: a header rebuilt
  // for each would swap the crumb out from under a press — mousedown on the old span,
  // mouseup on the new one, no click — and a click on Whiteboards right after dragging a
  // box (its autosave landing mid-press) would do nothing.
  function putHeader(v, item) {
    var m = headerOf(item);
    var sig = JSON.stringify(m);
    if (v.hd && v.hd.parentNode === v.root && v.hdSig === sig) return;
    v.hdSig = sig;
    swapHeader(v, boardHeader(m));
  }

  function refreshHeader(item) {
    var r = route();
    if (!view || !view.root.isConnected || r.view !== 'whiteboard' || r.board !== item.boardId) return;
    putHeader(view, item);
  }

  function renderBoard(state) {
    var r = (state && state.route) || {};
    var v = view || build();
    var item = makeCanvas(r.board);
    putHeader(v, item);
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
    if (r.view === 'whiteboard' && r.board) return renderBoard(state);
    return renderHome(state);
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
    refreshHeader(item);
  }

  function boardChanged(item, board, folder) {
    var wasArchived = !!(item.summary && item.summary.archivedAt);
    item.loaded = true;
    item.summary = board || null;
    item.folder = folder || null;
    var r = route();
    if (board && r.view === 'whiteboard' && r.board === item.boardId) rememberFolder(listedIn(board));
    refreshHeader(item);
    // Archive and Unarchive come through here, and nothing else renders for them: the
    // terminal layer repaints its panels' Pin buttons (disabled exactly while the board
    // is archived) now rather than at whatever render happens next.
    if (item.layer && wasArchived !== !!(board && board.archivedAt)) {
      layerCall(item, 'shown', visible(item, route()));
    }
  }

  // The quick switcher, ←/→, New whiteboard and Duplicate: the board opens on its own
  // screen, which changes the route.
  function openFrom(item, id) {
    if (!id || id === item.boardId) return;
    SB.go({ view: 'whiteboard', board: id });
  }

  // After Delete, or Back on a board that is missing or can't be opened. The canvas is
  // let go, and from the board's own screen the list the board was in comes up — the
  // place its breadcrumb and caret lead: its folder, No folder, or Archived for an
  // archived one (listedIn). A board that was never read has no list; All, or the folder
  // the editor names. A board that merely couldn't be read — a hand-edited file that is
  // not JSON, a read that failed — opens again from that list once the file is fixed.
  function closedFrom(item, folderId) {
    var r = route();
    var back = item.summary ? listedIn(item.summary) : (folderId || 'all');
    forget(item);
    if (r.view === 'whiteboard' && r.board === item.boardId) goHome(back);
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
      active: false, dirty: false, home: null, fullscreen: false,
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
  // its editor (which writes what it has first). Never a dirty one.
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

  // At most MAX_CANVASES. The one let go is the least recently shown of those that are
  // off screen, not full screen and have nothing unsaved.
  function evict() {
    var ids = Object.keys(canvases);
    var r = route();
    while (ids.length >= MAX_CANVASES) {
      var victim = null;
      for (var i = 0; i < ids.length; i++) {
        var it = canvases[ids[i]];
        if (it.dirty || it.fullscreen || it.slab.isConnected || visible(it, r)) continue;
        if (!victim || it.lastShown < victim.lastShown) victim = it;
      }
      if (!victim) return;
      forget(victim);
      ids = Object.keys(canvases);
    }
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
    var current = activeCanvas(r);
    var status = null;
    var sig = '';
    Object.keys(canvases).forEach(function (id) {
      var item = canvases[id];
      var on = visible(item, r);
      // A full-screen board covers the window; once the route has moved on, it goes back.
      if (item.fullscreen && !on && item.api && typeof item.api.leaveFullscreen === 'function') {
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
      if (item.layer || on) layerCall(item, 'shown', on);
    });
    if (r.view === 'whiteboard' && r.board && canvases[r.board] && canvases[r.board].summary) {
      rememberFolder(listedIn(canvases[r.board].summary));
    }
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
    // Inside the board — the canvas, its bar, the terminals' tray — Esc never leaves it:
    // the canvas has already had its turn (a tool, a selection, an answer being waited
    // for), and one Esc too many must not throw the user out of the board. Leaving is the
    // breadcrumb, or its caret.
    if (!e.shiftKey && t instanceof Node && (item.slab.contains(t) || item.api.contains(t))) return true;
    // With the board on screen, nothing else is focused but the page itself.
    if (!e.shiftKey && (t === document.body || t === document.documentElement)) return true;
    return false;
  }

  function editAction(action, text, image) {
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
    // The editor handle for a board's live canvas, for the smoke harness and browser
    // tests to drive. Nothing in the app reads it.
    api: function (boardId) { var item = canvases[boardId]; return item ? item.api : null; }
  };
})(window.SB);
