// SB.views.notes — the Notes tab (§4.15, R14), and the note a Grid square can show in
// place of its terminal. One scratch pad per workspace: a single markdown file, written
// in the block editor SB.noteEditor draws, saved a moment after typing stops.
//
//   SB.views.notes.render(state)      the whole <main> column for {tab:'notes'}
//   SB.views.notes.mount(wsId, into)  the same note, inside a Grid square
//   SB.views.notes.has(wsId)          is there anything written down? (the Grid's dot)
//   SB.views.notes.focus(wsId)        the Grid's landing focus
//   SB.views.notes.editAction / onKey / refresh / flushAll / ids / dispose
//
// ONE note per WORKSPACE, kept in `panes`, for the reason views/terminal.js keeps one
// xterm: the Notes tab and a Grid square are two places to look at the same thing, and
// a second copy of the editor would be a second unsaved buffer over one file. mount()
// moves the same slab, so whichever screen is showing it, it is the same text, the same
// undo history and the same caret.
//
// Like the Editor (§6 R13) render() hands back the SAME root element every time, and
// only its header is rebuilt. That is not a nicety here: app.js re-renders the main
// column for a run state, a shell spawn, a bell or a usage poll — several times a
// minute while anything is running — and a rebuilt column would detach a focused
// contenteditable, which in Chromium drops the selection and puts the caret back at the
// top of the note mid-word.
//
// Files on disk are the truth, as in the Editor: a clean note follows the file (re-read
// on every window focus), and one with unsaved edits is never overwritten by it without
// the user saying so.
window.SB = window.SB || {};
SB.views = SB.views || {};

(function (SB) {
  'use strict';

  var D = SB.dom;
  var h = D.h;

  var SAVE_MS = 400;             // typing settles this long before the note is written
  var SAVED_MS = 1600;           // …and "saved" says so for this long afterwards
  var RETRY_MS = 4000;           // a failed save is tried again this often, silently
  var FLUSH_MS = 1500;           // this view's own cap on flushAll(), kept under main's 2 s

  var panes = new Map();         // wsId -> pane
  var flushing = null;

  // ── small things ──────────────────────────────────────────────────────────

  function message(err) {
    if (err === null || err === undefined) return 'that did not work';
    var s = typeof err === 'string' ? err : (err.error || err.message || String(err));
    return String(s)
      .replace(/^Error invoking remote method '[^']*':\s*/, '')
      .replace(/^(?:Uncaught )?Error:\s*/, '')
      .trim() || 'that did not work';
  }

  // Every bridge call: feature-checked (a preload from before Notes existed has none of
  // these) and settled as a value, never a rejection, exactly as main answers.
  function call(name) {
    var api = window.sb;
    var args = Array.prototype.slice.call(arguments, 1);
    if (!api || typeof api[name] !== 'function') {
      return Promise.resolve({ ok: false, error: 'this build of Switchboard has no notes' });
    }
    var out;
    try {
      out = api[name].apply(api, args);
    } catch (err) {
      return Promise.resolve({ ok: false, error: message(err) });
    }
    return Promise.resolve(out).then(function (r) {
      return r && typeof r === 'object' ? r : { ok: false, error: 'the app process did not answer' };
    }, function (err) {
      return { ok: false, error: message(err) };
    });
  }

  function route() {
    return (SB.state && SB.state.route) || {};
  }

  function repaint() {
    if (typeof SB.render === 'function') SB.render();
  }

  // ── the pane ──────────────────────────────────────────────────────────────

  function paneFor(wsId) {
    return panes.get(wsId) || build(wsId);
  }

  function build(wsId) {
    var pane = {
      wsId: wsId,
      editor: null,
      loaded: false,             // the first read has landed: nothing may be saved before it
      tooLarge: false,
      text: '',                  // what is on disk, as far as we know
      mtimeMs: null,
      dirty: false,
      saving: false,
      again: false,              // an edit arrived while a save was in flight
      timer: null,
      statTimer: null,
      notice: null,              // the bar's current spec, see showBar()
      status: '',
    };

    pane.bar = h('div.nebar.hide', { role: 'status' });
    pane.stat = h('div.nestat');
    pane.wrap = h('div.newrap');
    pane.slab = h('div.note', null, pane.bar, pane.wrap, pane.stat);
    pane.body = h('div.bd.pane.notebd', null, pane.slab);
    pane.root = h('div.view.noteview', {
      style: 'display:flex;flex-direction:column;flex:1;min-width:0;min-height:0',
    }, pane.body);

    panes.set(wsId, pane);
    load(pane);
    return pane;
  }

  // The editor itself is only built once something is going to look at it: the Grid
  // preloads every square's note to know whether to mark its button, and four block
  // editors nobody has opened would be four contenteditable trees for nothing.
  function ensureEditor(pane) {
    if (pane.editor || !SB.noteEditor) return;
    pane.editor = SB.noteEditor.create({
      placeholder: 'Write it down…',
      onChange: function () { edited(pane); },
    });
    pane.wrap.appendChild(pane.editor.el);
    if (pane.loaded && !pane.tooLarge) pane.editor.setText(pane.text);
    editable(pane);
    paintStatus(pane);
  }

  // Nothing may be typed into a note that has not loaded. Not a nicety: no save path
  // runs before the first read has landed `ok` (an empty buffer must never go over a
  // note that is merely unreadable this second), so an editable surface before then is
  // one that silently throws away what is typed into it — and then has it wiped by the
  // read when that does arrive.
  function editable(pane) {
    if (!pane.editor) return;
    var on = pane.loaded && !pane.tooLarge;
    pane.editor.el.setAttribute('contenteditable', on ? 'true' : 'false');
    pane.slab.classList.toggle('shut', !on);
  }

  function load(pane) {
    var was = has(pane.wsId);
    call('notesRead', pane.wsId).then(function (r) {
      if (r && r.ok) {
        pane.tooLarge = !!r.tooLarge;
        pane.text = pane.tooLarge ? '' : String(r.text || '');
        pane.mtimeMs = r.mtimeMs === undefined ? null : r.mtimeMs;
        pane.loaded = !pane.tooLarge;
        if (pane.editor && !pane.tooLarge) pane.editor.setText(pane.text);
        if (!pane.tooLarge) clearBar(pane, 'big');
        if (pane.tooLarge) {
          showBar(pane, {
            id: 'big', tone: 'warn', rank: 2, dismiss: false,
            text: 'this note is larger than 2 MB — open it in the Finder instead',
            actions: [{ label: 'Reveal', onClick: function () { reveal(pane); } }],
          });
        }
      } else {
        // Not loaded means not saved: an empty buffer must never be written over a
        // note that is merely unreadable this second.
        pane.loaded = false;
        showBar(pane, { id: 'read', tone: 'err', rank: 2, text: message(r && r.error), actions: [
          { label: 'Try again', onClick: function () { clearBar(pane, 'read'); load(pane); } },
        ] });
      }
      editable(pane);
      paintStatus(pane);
      // Only when a view would draw something different. The Grid preloads every
      // filled square as it paints, and a repaint per read meant four extra rebuilds
      // of the whole column — each one re-mounting four xterm hosts.
      if (was !== has(pane.wsId) || pane.notice) repaint();
    });
  }

  function reveal(pane) {
    var api = window.sb;
    if (api && typeof api.notesReveal === 'function') Promise.resolve(api.notesReveal(pane.wsId))['catch'](function () {});
  }

  // ── saving ────────────────────────────────────────────────────────────────

  function edited(pane) {
    if (!pane.loaded) return;
    pane.dirty = pane.editor ? pane.editor.getText() !== pane.text : false;
    if (!pane.dirty) { paintStatus(pane); reportDirty(); return; }
    setStatus(pane, '');
    reportDirty();
    if (pane.timer) clearTimeout(pane.timer);
    pane.timer = setTimeout(function () { pane.timer = null; save(pane); }, SAVE_MS);
  }

  function save(pane, opts) {
    var o = opts || {};
    if (pane.timer) { clearTimeout(pane.timer); pane.timer = null; }
    if (!pane.loaded || pane.tooLarge || !pane.editor) return Promise.resolve(false);
    if (pane.saving) { pane.again = true; return Promise.resolve(false); }
    pane.editor.flush();
    var text = pane.editor.getText();
    if (text === pane.text && !o.force) { pane.dirty = false; paintStatus(pane); return Promise.resolve(true); }

    pane.saving = true;
    setStatus(pane, 'saving…');
    return call('notesWrite', pane.wsId, text, { mtimeMs: pane.mtimeMs, force: !!o.force })
      .then(function (r) {
        pane.saving = false;
        if (r && r.ok) {
          pane.text = text;
          pane.mtimeMs = r.mtimeMs === undefined ? null : r.mtimeMs;
          clearBar(pane, 'save');
          clearBar(pane, 'conflict');
          pane.dirty = pane.editor.getText() !== pane.text;
          reportDirty();
          setStatus(pane, pane.dirty ? '' : 'saved');
          if (pane.again) { pane.again = false; save(pane); }
          return true;
        }
        if (r && r.conflict) { conflict(pane, r); return false; }
        // A failed save is the one failure that loses what was typed, so it is said
        // out loud and tried again on its own.
        showBar(pane, { id: 'save', tone: 'err', rank: 1, dismiss: false, text: 'not saved — ' + message(r && r.error), actions: [
          { label: 'Try again', onClick: function () { save(pane, { force: false }); } },
        ] });
        setStatus(pane, '');
        if (!pane.timer) pane.timer = setTimeout(function () { pane.timer = null; save(pane); }, RETRY_MS);
        return false;
      });
  }

  // The file moved underneath us. A note is a scratch pad and this is rare — an editor
  // elsewhere, a sync client — so it asks rather than guessing, the way the Editor's
  // Save does.
  function conflict(pane, r) {
    pane.again = false;
    showBar(pane, {
      id: 'conflict', tone: 'warn', rank: 3, dismiss: false,
      text: message(r.error),
      actions: [
        { label: 'Keep mine', pri: true, onClick: function () { pane.mtimeMs = r.mtimeMs === undefined ? null : r.mtimeMs; save(pane, { force: true }); } },
        { label: 'Reload', onClick: function () { clearBar(pane, 'conflict'); pane.dirty = false; load(pane); } },
      ],
    });
    setStatus(pane, '');
  }

  function setStatus(pane, text) {
    pane.status = text;
    paintStatus(pane);
    if (text !== 'saved') return;
    if (pane.statTimer) clearTimeout(pane.statTimer);
    pane.statTimer = setTimeout(function () {
      pane.statTimer = null;
      if (pane.status === 'saved') { pane.status = ''; paintStatus(pane); }
    }, SAVED_MS);
  }

  function paintStatus(pane) {
    var text = pane.status;
    if (pane.stat.textContent !== text) pane.stat.textContent = text;
    pane.stat.classList.toggle('on', !!text);
  }

  // ── the slab's own bar ────────────────────────────────────────────────────

  function showBar(pane, spec) {
    var cur = pane.notice;
    if (cur && cur.rank > (spec.rank || 0) && cur.id !== spec.id) return;
    pane.notice = spec;
    D.clear(pane.bar);
    pane.bar.className = 'nebar' + (spec.tone ? ' ' + spec.tone : '');
    pane.bar.appendChild(h('span.nebm', null, spec.text));
    pane.bar.appendChild(h('span.sp'));
    (spec.actions || []).forEach(function (a) {
      pane.bar.appendChild(h('button.edbtn' + (a.pri ? '.pri' : ''), {
        type: 'button',
        onClick: function () { a.onClick(); },
      }, a.label));
    });
    if (spec.dismiss !== false) {
      pane.bar.appendChild(h('button.edx', {
        type: 'button', title: 'Dismiss', 'aria-label': 'Dismiss',
        onClick: function () { clearBar(pane, spec.id); },
      }, D.icon('close')));
    }
  }

  function clearBar(pane, id) {
    if (!pane.notice || (id && pane.notice.id !== id)) return;
    pane.notice = null;
    D.clear(pane.bar);
    pane.bar.className = 'nebar hide';
  }

  // ── what the rest of the app asks ─────────────────────────────────────────

  /** Is there anything written down for this workspace? The Grid's button reads it. */
  function has(wsId) {
    var pane = panes.get(wsId);
    return !!pane && pane.loaded && !!pane.text.replace(/\s+/g, '');
  }

  /** Read a workspace's note without building an editor for it — the Grid's squares. */
  function preload(wsId) {
    if (!wsId) return;
    paneFor(wsId);
  }

  function focus(wsId) {
    var pane = panes.get(wsId);
    if (!pane || !pane.editor || !pane.slab.isConnected) return false;
    pane.editor.focus();
    return true;
  }

  /** app.js's handleEdit, between the terminal's turn and the document fallback. */
  function editAction(action, text) {
    var found = null;
    panes.forEach(function (pane) {
      if (!found && pane.editor && pane.slab.isConnected && pane.editor.hasFocus()) found = pane;
    });
    if (!found) return false;
    return found.editor.editAction(action, text);
  }

  /** app.js's window keydown, after the Editor's turn. ⌘S writes the note now. */
  function onKey(e) {
    if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
    if (String(e.key || '').toLowerCase() !== 's') return false;
    var found = null;
    panes.forEach(function (pane) {
      if (!found && pane.editor && pane.slab.isConnected && pane.editor.hasFocus()) found = pane;
    });
    if (!found) return false;
    save(found);
    return true;
  }

  /**
   * handleFocus: the window came back, so the file may have moved. A note with unsaved
   * edits is left exactly as it is — the save will find the conflict and ask — and a
   * clean one follows the disk, which is the Editor's rule for a clean buffer.
   */
  function refresh() {
    panes.forEach(function (pane) {
      if (pane.saving || pane.dirty) return;
      if (pane.editor && pane.editor.hasFocus()) return;
      // A note that was too large, or whose read failed, goes back through load(): it
      // has state to unwind — the bar, `tooLarge`, whether the surface is editable at
      // all — and a hand-rolled adopt left it editable but unsavable once the file on
      // disk had shrunk back under the limit.
      if (pane.tooLarge || !pane.loaded) { load(pane); return; }
      call('notesRead', pane.wsId).then(function (r) {
        if (!r || !r.ok) return;
        if (pane.saving || pane.dirty) return;
        if (pane.editor && pane.editor.hasFocus()) return;
        if (r.tooLarge) { load(pane); return; }
        var text = String(r.text || '');
        pane.mtimeMs = r.mtimeMs === undefined ? null : r.mtimeMs;
        pane.loaded = true;
        editable(pane);
        if (text === pane.text) return;
        pane.text = text;
        if (pane.editor) pane.editor.setText(text);
        repaint();
      });
    });
  }

  /** Everything unsaved, now. The window losing focus, and main's quit flush. */
  function flushAll() {
    var waits = [];
    panes.forEach(function (pane) {
      if (pane.loaded && pane.dirty) waits.push(save(pane));
    });
    return Promise.all(waits);
  }

  function dirty() {
    var n = 0;
    panes.forEach(function (pane) { if (pane.loaded && pane.dirty) n++; });
    return n;
  }

  // Main asks before a close or a quit throws these away, exactly as it does for the
  // Editor's buffers (§4.14). Normally the number is 0 — a note writes itself a moment
  // after typing stops — so the only note that ever raises the question is one that
  // CANNOT be written: a read-only notes folder, a full disk, a conflict waiting on an
  // answer. Told only when the number moves.
  var told = 0;

  function reportDirty() {
    var n = dirty();
    if (n === told) return;
    told = n;
    call('notesDirty', n);
  }

  /** Every workspace (or folder) this view holds a pane for — app.js's retirePanes. */
  function ids() {
    var out = [];
    panes.forEach(function (pane, id) { out.push(id); });
    return out;
  }

  function dispose(wsId) {
    var pane = panes.get(wsId);
    if (!pane) return;
    if (pane.slab.isConnected) return;               // on screen somewhere; not ours to drop
    if (pane.saving) return;                         // the answer still has to land
    if (pane.dirty) {
      // Never thrown away unsaved — and never retried into a loop either: only a save
      // that ACTUALLY landed tries the disposal again. A conflict, a read-only folder
      // or a note too large all resolve false, and a pane that cannot be written just
      // stays; recursing on those spun sb:notes:write forever, and the too-large case
      // does not even reach IPC, so it froze the window in microtasks.
      save(pane).then(function (ok) { if (ok) dispose(wsId); }, function () {});
      return;
    }
    panes['delete'](wsId);
    reportDirty();
    if (pane.timer) clearTimeout(pane.timer);
    if (pane.statTimer) clearTimeout(pane.statTimer);
    if (pane.editor) pane.editor.destroy();
    if (pane.slab.parentNode) pane.slab.parentNode.removeChild(pane.slab);
  }

  // ── mounting ──────────────────────────────────────────────────────────────

  /**
   * The workspace's note, inside `into` — a Grid square. The SAME slab the Notes tab
   * shows: only one screen is on at a time, so the element simply moves.
   */
  function mount(wsId, into) {
    if (!SB.noteEditor) {
      into.appendChild(h('div.note.blank', null, 'the note editor did not load'));
      return into;
    }
    var pane = paneFor(wsId);
    ensureEditor(pane);
    pane.slab.classList.add('sm');
    // The Grid hands back a fresh tree on every render (R10), so app.js clears the
    // column and this slab is re-parented into a new cell — which blurs the
    // contenteditable and makes Chromium discard the selection. app.js's own refocus
    // puts focus back but not the caret, so it collapses to the top of the note
    // mid-word. Carry the caret across by hand; the Notes tab needs none of this,
    // because there the root is never detached at all.
    var held = pane.slab.contains(document.activeElement) && pane.editor ? pane.editor.caret() : null;
    into.appendChild(pane.slab);
    if (held) {
      setTimeout(function () {
        if (pane.slab.isConnected && pane.editor) pane.editor.placeAt(held);
      }, 0);
    }
    return into;
  }

  // ── render ────────────────────────────────────────────────────────────────

  // Only the header is rebuilt — it is the part of this screen that reads run state and
  // the scan. Its buttons are new elements every time, so a focused one is found again
  // by position: app.js's own refocus() only runs when it rebuilt the column, and this
  // view hands back the same root so that it does not (R14).
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

  function swapHeader(pane, ws, state) {
    var hd;
    try {
      hd = SB.views.workspace.header(ws, state);
    } catch (err) {
      console.error('[switchboard] notes: header:', err);
      hd = h('div.hd');
    }
    var path = null;
    if (pane.hd && pane.hd.parentNode === pane.root) {
      path = pathTo(pane.hd, document.activeElement);
      pane.root.replaceChild(hd, pane.hd);
    } else {
      pane.root.insertBefore(hd, pane.root.firstChild);
    }
    pane.hd = hd;
    if (!path) return;
    var el = hd;
    for (var i = 0; i < path.length && el; i++) el = el.children[path[i]];
    if (el && el !== hd && typeof el.focus === 'function') {
      try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    }
  }

  function render(state) {
    var r = (state && state.route) || {};
    var wsId = r.wsId;
    if (!wsId || String(wsId).charAt(0) === '/') {
      return h('div.view', { style: 'display:flex;flex-direction:column;flex:1;min-width:0;min-height:0' },
        h('div.hd'), h('div.bd', null, D.empty('pick one on the left.', { title: 'no workspace selected' })));
    }
    var ws = (state.byId || {})[wsId] || { id: wsId };
    var pane = paneFor(wsId);
    var attached = pane.root.isConnected;

    swapHeader(pane, ws, state);
    if (SB.noteEditor) {
      ensureEditor(pane);
      pane.slab.classList.remove('sm');
      if (pane.slab.parentNode !== pane.body) pane.body.appendChild(pane.slab);
    } else if (!pane.slab.firstChild) {
      pane.slab.appendChild(h('div.note.blank', null, 'the note editor did not load'));
    }

    // Landing on Notes is landing in the note, the way landing on the Terminal is
    // landing in the shell. Never from inside the slab: taking focus back from a
    // click the user just made would fight them.
    if (!attached) {
      setTimeout(function () {
        if (!pane.slab.isConnected || !pane.editor) return;
        if (route().tab !== 'notes' || route().wsId !== pane.wsId) return;
        if (pane.slab.contains(document.activeElement)) return;
        pane.editor.focus();
      }, 0);
    }
    return pane.root;
  }

  // ── the window going away ─────────────────────────────────────────────────

  // A note saves itself a moment after typing stops, so the only text at risk is the
  // last few hundred milliseconds of it. Both of these close that window: the blur
  // that comes with ⌘-Tab or a click elsewhere, and main asking on its way out of a
  // quit (§4.15) — which waits for the answer, unlike a page's beforeunload, which
  // Electron ignores.
  window.addEventListener('blur', function () { flushAll(); });
  window.addEventListener('pagehide', function () { flushAll(); });

  function onFlush(id) {
    if (flushing) return flushing;
    function answer() {
      flushing = null;
      return call('notesFlushed', id);
    }
    flushing = Promise.race([
      flushAll(),
      new Promise(function (done) { setTimeout(done, FLUSH_MS); }),
    ]).then(answer, answer);
    return flushing;
  }

  if (window.sb && typeof window.sb.onNotesFlush === 'function') {
    try { window.sb.onNotesFlush(onFlush); } catch (e) { console.error('[switchboard] notes: flush:', e); }
  }

  SB.views.notes = {
    render: render,
    mount: mount,
    focus: focus,
    has: has,
    preload: preload,
    editAction: editAction,
    onKey: onKey,
    refresh: refresh,
    flushAll: flushAll,
    dirty: dirty,
    ids: ids,
    dispose: dispose,
    // The live editor for a workspace, for the smoke harness to look at (its markdown,
    // its blocks). Nothing in the app reads it — views/terminal.js exposes its xterm
    // the same way and for the same reason.
    editor: function (wsId) { var pane = panes.get(wsId); return pane ? pane.editor : null; },
  };
})(window.SB);
