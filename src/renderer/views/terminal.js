// SB.views.terminal — the Terminal tab (mock-up 08): the workspace header with
// Terminal selected, and a real interactive login shell filling the pane. This is
// the thing the user runs `claude` in instead of iTerm2.
//
// ONE Terminal per WORKSPACE, kept in `panes`, for the reason views/logs.js keeps
// one per process: a view is rebuilt whenever anything visible changes and a fresh
// Terminal would throw the scrollback away. Each render re-parents the same host
// element into the new `.bd.pane`; xterm is re-parented, never re-opened. Here that
// matters twice over — replaying a full-screen TUI's ring buffer into a new xterm
// paints garbage, so a pane whose shell is alive is never disposed (§6 R8).
//
// Unlike Logs there is no process picker and no Copy log button: one shell per
// workspace, it is not a dev process, and `Stop` can never reach it (§5 M6).
//
// The keyboard is the one `claude /terminal-setup` installs elsewhere: Shift+Enter
// and — via macOptionIsMeta — Option+Enter send ESC CR, ⌘K clears, and OSC 52 (how
// `/copy` gets out of a pty) reaches the system clipboard.
window.SB = window.SB || {};

(function (SB) {
  'use strict';

  var D = SB.dom;
  var h = D.h;

  var panes = new Map();              // wsId -> pane
  var opening = new Set();            // wsId -> an openShell() is already in flight
  var failed = Object.create(null);   // wsId -> the sentence open() answered with

  // How far back the overlap trim below can look. Nothing else ever reads the
  // replayed text — there is no Copy log here and the shell's real scrollback is
  // the Terminal's own — so it is dropped again the moment the replay is reconciled.
  var MAX_TAIL = 65536;

  // A shutdown the shell was asked to take, as opposed to one that killed it.
  // SIGHUP belongs here: hanging the group up is exactly how M6 closes a shell and
  // how quitting the app closes all of them, the same as shutting an iTerm2 window.
  var STOP_SIGNALS = { SIGTERM: 1, SIGINT: 1, SIGHUP: 1 };

  // The font every route host shows. A pinned whiteboard terminal is the one place it
  // changes: it follows the canvas zoom (place() and setFontSize() below).
  var BASE_FONT = 12.5;

  // node-pty's onExit reports the signal as a NUMBER alongside an exitCode of 0;
  // child_process reports the name alongside a null code. Either way the signal is
  // how the process ended, so it wins over the code when both are there.
  var SIGNAL_NAMES = {
    1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 6: 'SIGABRT',
    9: 'SIGKILL', 11: 'SIGSEGV', 13: 'SIGPIPE', 15: 'SIGTERM',
  };

  // The palette lives in term-theme.js, which styles.css reads too. `theme` is a live
  // xterm option — it registers onSpecificOptionChange('theme') and repaints — so a
  // pane never has to be rebuilt to change colour, and a full-screen TUI mid-frame is
  // simply redrawn in the new palette rather than losing its scrollback.
  SB.termTheme.onChange(function (_name, palette) {
    panes.forEach(function (pane) {
      if (pane.disposed) return;
      try {
        pane.term.options.theme = palette;
      } catch (err) {
        console.error('[switchboard] terminal: theme:', err);
      }
    });
  });

  // ── clipboard ─────────────────────────────────────────────────────────────

  // xterm's selection is not a DOM selection and a pty program's `/copy` is a
  // control sequence, so both roads to the clipboard end here.
  // Main writes the clipboard, not this window. navigator.clipboard.writeText works
  // only while the window has focus, and an OSC 52 from a background workspace's shell
  // — Claude Code's `/copy` finishing in a tab you are not looking at — is exactly the
  // case that has none. The old execCommand fallback is worse still: Chromium refuses
  // it outside a user gesture. Electron's main-process clipboard has neither limit.
  function toClipboard(text) {
    var api = window.sb;
    if (api && typeof api.writeClipboard === 'function') {
      return Promise.resolve(api.writeClipboard(text))['catch'](function () {});
    }
    var written = navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText(text)
      : Promise.reject();
    return Promise.resolve(written)['catch'](function () {
      var focused = document.activeElement;
      var box = document.createElement('textarea');
      box.value = text;
      box.setAttribute('readonly', '');
      box.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(box);
      box.select();
      try { document.execCommand('copy'); } catch (_) { /* nothing else to try */ }
      document.body.removeChild(box);
      // The textarea had to take focus to be copied out of, and the terminal is
      // what it took it from — a `/copy` that leaves the user unable to type is
      // worse than a copy that failed.
      if (focused && typeof focused.focus === 'function') focused.focus();
    });
  }

  // OSC 52 — `ESC ] 52 ; c ; <base64> BEL` — is the only way a program inside a pty
  // can reach the system clipboard, and it is how Claude Code's `/copy` works.
  // xterm has no handler of its own, so without this the sequence is swallowed and
  // `/copy` silently does nothing.
  function osc52(data) {
    try {
      var s = String(data === null || data === undefined ? '' : data);
      // The part before the first ';' names the selection (`c`, `p`, or empty).
      // Which one it asks for does not matter on macOS: there is one clipboard.
      var cut = s.indexOf(';');
      var payload = cut < 0 ? s : s.slice(cut + 1);
      // `?` is a READ request. Answering it would hand whatever is on the user's
      // clipboard back to any program that asks, including one they did not start.
      if (!payload || payload === '?') return true;
      var raw = window.atob(payload);
      var out = raw;
      // atob yields a BINARY string — one character per byte — so anything outside
      // ASCII comes back mojibake'd. escape/decodeURIComponent is the round trip
      // that undoes that without a TextDecoder, and it throws on bytes that are not
      // valid UTF-8, which is the signal to keep what we already have.
      try { out = decodeURIComponent(escape(raw)); } catch (_) { out = raw; }
      toClipboard(out);
    } catch (_) { /* truncated, or not base64 at all; a bad paste is not fatal */ }
    // Always handled. Returning false hands the sequence to xterm's fallback, and a
    // payload this terminal could not decode is still a payload nothing else wants.
    return true;
  }

  // ── pane lifecycle ────────────────────────────────────────────────────────

  function send(wsId, data) {
    Promise.resolve(window.sb.shellInput(wsId, data))['catch'](function () {});
  }

  // What a drop puts at the cursor, answered by main (sb.dropFiles, §4.5): every
  // file's escaped path, space-separated, a space after the last so the user can go on
  // typing; '' for a drop with no file. The path has to be asked of the preload (§4.5):
  // in a sandboxed renderer a File carries none. A File with no path at all (an image
  // dragged out of a browser) goes over as its bytes for main to write down; a path
  // that does not exist on disk — an unsaved screenshot dragged off its floating
  // thumbnail — main swaps for the file it rescued off the drag pasteboard when the
  // drag entered the pane (main/drops.js). The Files are taken from the DataTransfer
  // now, synchronously: a DataTransfer is emptied once the drop event returns, while
  // the File objects stay readable.
  function droppedFiles(dt) {
    var api = window.sb;
    var files = dt && dt.files ? Array.prototype.slice.call(dt.files) : [];
    if (!files.length || !api || typeof api.dropFiles !== 'function') return Promise.resolve('');
    return Promise.all(files.map(function (file) {
      var p = '';
      try {
        p = typeof api.pathForFile === 'function' ? api.pathForFile(file) : '';
      } catch (_) { p = ''; }
      var entry = { path: p || '', name: file.name || '', type: file.type || '' };
      if (p) return entry;
      return Promise.resolve(file.arrayBuffer()).then(function (buf) {
        entry.bytes = new Uint8Array(buf);
        return entry;
      }, function () { return entry; });
    })).then(function (entries) {
      return Promise.resolve(api.dropFiles(entries)).then(function (r) {
        return r && r.ok && typeof r.text === 'string' ? r.text : '';
      });
    })['catch'](function () { return ''; });
  }

  function createPane(wsId) {
    var pane = {
      wsId: wsId,
      host: h('div.term'),
      term: new window.Terminal({
        allowProposedApi: true,
        // A shell has a live cursor and a user waiting at it — the one place this
        // view differs from Logs, where nothing ever types into a dev server.
        cursorBlink: true,
        // What `claude /terminal-setup` sets as `useOptionAsMetaKey` in Terminal.app:
        // it is what makes Option+Enter send ESC CR and Option+B/F walk by word.
        macOptionIsMeta: true,
        scrollback: 10000,
        fontFamily: '"SF Mono", Menlo, Consolas, monospace',
        fontSize: BASE_FONT,
        // xterm multiplies the MEASURED character box, not the font size, and ceils
        // the result: SF Mono at 12.5px measures 15px, so 1.4 gives a 21px row — the
        // closest whole pixel to the mock-up's `12.5px/1.65` = 20.625px line box.
        // Passing 1.65 straight through would give 25px rows, a third too airy.
        lineHeight: 1.4,
        drawBoldTextInBrightColors: false,
        theme: SB.termTheme.palette(SB.termTheme.current()),
      }),
      fit: new window.FitAddon.FitAddon(),
      text: '',
      queue: '',
      replayed: false,
      ready: false,
      pending: [],
      opened: false,
      observer: null,
      queuedFit: false,
      disposed: false,
      live: true,                     // no exit seen yet; a shell is about to be opened
      startedAt: null,                // the shell generation this pane last saw
      // Who holds the host (see place() below): null for a route host — the Terminal
      // tab or a Grid square, which take it with mount() — or a whiteboard layer's
      // token ('wb:<boardId>'). `home` is the element it was last put into.
      owner: null,
      home: null,
      fontSize: BASE_FONT,
      // A pinned terminal's cols/rows. Set, a fit sizes the Terminal to exactly this
      // instead of to its box: zooming a board changes the box every frame, and a pty
      // that followed it would get a SIGWINCH per frame and redraw a TUI mid-frame.
      fixed: null,
      sent: null,                     // 'colsxrows' the pty was last told, for fixed mode only
      held: false,                    // an edge drag is in progress: no fits until it ends
    };

    pane.term.loadAddon(pane.fit);
    // Addons are NAMESPACED on the UMD global: new WebLinksAddon.WebLinksAddon(),
    // not new WebLinksAddon().
    pane.term.loadAddon(new window.WebLinksAddon.WebLinksAddon(function (_event, uri) {
      Promise.resolve(window.sb.openExternal(uri))['catch'](function () {});
    }));

    pane.term.onData(function (data) { send(wsId, data); });

    // Finder drops. What iTerm2 does with a file dropped on it is type the file's
    // escaped path at the cursor and a space after it — nothing more — and that is
    // the whole of "drag an image into Claude Code": Claude reads the image from the
    // path. xterm has no drop handling of its own, and without these two listeners
    // Chromium's answer to a dropped file is to navigate the window to its file://
    // URL, which main's will-navigate cancels and openExternal then refuses (http(s)
    // only) — so the drop vanished without a trace. dragover MUST preventDefault or
    // drop never fires at all; that is the DOM's rule, not xterm's.
    pane.host.addEventListener('dragenter', function () {
      // Main snapshots the macOS drag pasteboard now, while the drag is live: an
      // unsaved screenshot's bytes are there and nowhere else (main/drops.js).
      Promise.resolve(window.sb.dragBegan())['catch'](function () {});
    });
    pane.host.addEventListener('dragover', function (e) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    pane.host.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var dt = e.dataTransfer;
      // The drop's text — a URL or a selection dragged out of a browser, which iTerm2
      // pastes too — is what a drop with no file types. Read here, not later: the
      // DataTransfer is emptied once this handler returns.
      var plain = '';
      try { plain = (dt && dt.getData('text/plain')) || ''; } catch (_) { plain = ''; }
      droppedFiles(dt).then(function (text) {
        text = text || plain;
        if (!text) return;
        // Through paste(), never send(): paste() wraps the text in the bracketed-paste
        // markers when the program asked for them, and that is what keeps Claude Code's
        // composer from reading a dropped path as text-then-Enter. Same route as ⌘V.
        pane.term.paste(text);
        pane.term.focus();
      });
    });

    pane.term.attachCustomKeyEventHandler(function (e) {
      // The handler sees keydown, keypress AND keyup for one press of a key, so
      // anything that sends bytes has to say which of the three it acts on or it
      // sends them three times.
      if (e.type !== 'keydown') return true;
      if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // ESC CR, taken verbatim from what Claude Code's own Alacritty and VS Code
        // installers bind: the sequence it reads as "newline, do not submit".
        //
        // preventDefault() is NOT optional and returning false does not imply it.
        // xterm 6's _keyDown calls this handler and, on false, returns BEFORE its own
        // cancel(event) — so without this line the keydown is never cancelled, the
        // browser goes on to deliver keypress with charCode 13, and _keyPress sends a
        // second, bare CR down the pty. One key press, two line-accepting writes: in
        // Claude Code's composer the ESC CR inserts the newline and the stray CR then
        // submits the turn, which is precisely what Shift+Enter exists to prevent.
        e.preventDefault();
        send(wsId, '\u001b\r');
        return false;
      }
      if (e.metaKey && String(e.key).toLowerCase() === 'k' && !e.ctrlKey && !e.altKey) {
        // Harmless today — macOS emits no char event for ⌘-letter — but the same rule
        // applies, and relying on that is how the bug above happened.
        e.preventDefault();
        pane.term.clear();
        return false;
      }
      return true;
    });

    // xterm 6 ships ONLY the Unicode 6 width table, in which every emoji measures one
    // cell instead of two — so a line containing one drifts by a column, and editing
    // over it (Claude Code's composer, any zsh line edit) smears the row. iTerm2 gets
    // this right, so without the addon the Terminal tab would be a visible step down
    // from the thing it replaces. Guarded: a missing addon must not cost the shell.
    if (window.Unicode11Addon && window.Unicode11Addon.Unicode11Addon) {
      try {
        pane.term.loadAddon(new window.Unicode11Addon.Unicode11Addon());
        pane.term.unicode.activeVersion = '11';
      } catch (err) {
        // Say so rather than swallowing it: the failure mode is a terminal that looks
        // right until an emoji drifts a column, which is exactly the kind of thing
        // nobody traces back to a silent catch.
        console.warn('[switchboard] %s: unicode 11 did not register:', 'terminal', err);
      }
    }

    pane.term.parser.registerOscHandler(52, osc52);

    // A bell out of a shell is Claude Code saying it finished a turn. app.js turns
    // the workspace's one sidebar dot blue; it owns the route, so it decides what a
    // bell from the workspace already on screen is worth.
    pane.term.onBell(function () {
      if (typeof SB.bell === 'function') SB.bell(wsId, true);
    });

    panes.set(wsId, pane);
    replay(pane);
    return pane;
  }

  function sendResize(pane) {
    var api = window.sb;
    if (!api || typeof api.shellResize !== 'function') return;
    if (!pane.term.cols || !pane.term.rows) return;
    // Deliberately not memoised on the last size sent, for the reason views/logs.js
    // gives: a brand-new pty behind the same pane starts at main's default with
    // cols/rows unchanged, and a memo would never correct it. Resizing a pty to the
    // size it already has costs one ioctl and sends no SIGWINCH. The size IS recorded,
    // for fixed mode alone (refit below), which has a reason of its own to skip one.
    pane.sent = pane.term.cols + 'x' + pane.term.rows;
    var sent = api.shellResize(pane.wsId, pane.term.cols, pane.term.rows);
    Promise.resolve(sent)['catch'](function () {});
  }

  function liveShell(wsId) {
    var shells = (SB.state && SB.state.shell) || null;
    var shell = shells ? shells[wsId] : null;
    return !!shell && shell.status === 'running';
  }

  // node-pty is either there or it is not, and it is not coming back this session,
  // so the pane and its Terminal have nothing left to show. The next render puts the
  // sentence where the terminal was.
  // The pane and its Terminal go, because whatever we show instead takes their place.
  // What must NOT go with them is the ability to try again: openShell() is called once,
  // after a pane's first fit, and the only other caller is the footer's New shell button
  // — which lives inside a pane that no longer exists. So a single transient refusal
  // (main still resolving the workspace, a directory missing for a moment) used to brick
  // that workspace's Terminal for the rest of the session with no way back. The sentence
  // now comes with a Try again beside it, and that is the way back.
  function fail(wsId, sentence) {
    failed[wsId] = sentence;
    dispose(wsId);
    if (typeof SB.render === 'function') SB.render();
  }

  function retry(wsId) {
    delete failed[wsId];
    opening['delete'](wsId);
    if (typeof SB.render === 'function') SB.render();
  }

  // Spawned only once the pane has been measured, and at that size: a pty born at
  // xterm's 80x24 lays zsh's prompt and Claude Code's whole TUI out for a terminal
  // that is not the one on screen, and every repaint until the first resize is a
  // wrapped mess. Idempotent in main, but a re-render must not even ask twice.
  function openShell(pane) {
    var wsId = pane.wsId;
    var api = window.sb;
    if (!api || typeof api.openShell !== 'function') return;
    if (opening.has(wsId)) return;
    // Adopted after a renderer reload: main already has the shell, but it is still
    // at the size main spawned it with and only a resize will tell it otherwise.
    if (liveShell(wsId)) { sendResize(pane); return; }
    opening.add(wsId);
    pane.sent = (pane.term.cols || 80) + 'x' + (pane.term.rows || 24);
    Promise.resolve(api.openShell(wsId, pane.term.cols || 80, pane.term.rows || 24)).then(
      function (r) {
        opening['delete'](wsId);
        var sentence = r && r.ok === false
          ? (r.error || 'the shell did not start')
          : ((r && r.state && r.state.error) || null);
        if (sentence) fail(wsId, sentence);
      },
      function () {
        opening['delete'](wsId);
        fail(wsId, 'the shell did not start');
      }
    );
  }

  function refit(pane) {
    if (pane.disposed || !pane.opened || !pane.host.isConnected) return;
    // A whiteboard panel's edge is being dragged (hold() below): the same reasoning as
    // the rail, for one pane. Its release asks for the one fit that matters.
    if (pane.held) return;
    // The rail is mid-slide. Every frame of it fires the ResizeObserver, and acting
    // on them would hand the pty a new size twenty times in a fifth of a second.
    // app.js calls relayout() below when the layout has settled, and one fit there
    // is worth the twenty skipped here.
    if (SB.layout && SB.layout.busy()) return;
    var box = pane.host.getBoundingClientRect();
    if (!box.width || !box.height) return;   // mid-layout; the ResizeObserver refits
    var fixed = pane.fixed;
    if (fixed) {
      // A pinned terminal: its box follows the canvas zoom, its grid does not. The
      // first-fit path below still runs, so a pinned terminal restored after a
      // relaunch opens its shell at exactly these cols/rows.
      if (pane.term.cols !== fixed.cols || pane.term.rows !== fixed.rows) {
        try { pane.term.resize(fixed.cols, fixed.rows); } catch (_) { /* the next fit gets it */ }
      }
    } else {
      try { pane.fit.fit(); } catch (_) { /* nothing measurable yet; the next fit gets it */ }
    }

    var first = !pane.ready;
    // Nothing may be written before this point. A Terminal opens at xterm's default
    // 80x24, so replaying a 23-line buffer into it pushes the opening lines into
    // scrollback — and a pane that is really 26 rows tall then starts mid-session.
    pane.ready = true;
    drain(pane);

    if (first) openShell(pane);
    // Fixed mode is the one place a resize is memoised: its box changes on every zoom
    // frame while its size does not, and the ResizeObserver would otherwise put an
    // ioctl on the IPC channel per frame. A new shell generation still gets one
    // (onState), so the memo can never strand a fresh pty at main's default size.
    else if (!fixed || pane.sent !== fixed.cols + 'x' + fixed.rows) sendResize(pane);
    focusIfShown(pane);
  }

  // Timers, not requestAnimationFrame: rAF is starved while the window is occluded
  // (and never fires at all in a headless render), which would leave the terminal
  // unmounted. Layout is available to a timer callback just the same.
  function queueFit(pane) {
    if (pane.queuedFit) return;
    pane.queuedFit = true;
    setTimeout(function () {
      pane.queuedFit = false;
      refit(pane);
    }, 0);
  }

  // term.open() measures the host, so it can only run once the fragment this view
  // returns has actually been put in the document.
  function activate(pane, tries) {
    if (pane.disposed) return;
    if (!pane.host.isConnected) {
      if (tries > 0) setTimeout(function () { activate(pane, tries - 1); }, 0);
      return;
    }
    if (!pane.opened) {
      pane.term.open(pane.host);
      pane.opened = true;
      if (typeof ResizeObserver === 'function') {
        pane.observer = new ResizeObserver(function () { queueFit(pane); });
        pane.observer.observe(pane.host);
      }
    }
    queueFit(pane);
  }

  // This tab exists to be typed into: landing on it and having to click the black
  // rectangle first would be a bug. Only when it is the tab actually on screen, and
  // only when focus is not already inside this pane — taking it back on every fit
  // would fight the user the moment they click a header button.
  function focusIfShown(pane) {
    if (pane.disposed || !pane.opened || !pane.host.isConnected) return;
    var route = (SB.state && SB.state.route) || {};
    if (route.tab !== 'terminal' || route.wsId !== pane.wsId) return;
    if (pane.host.contains(document.activeElement)) return;
    try { pane.term.focus(); } catch (_) { /* not measurable yet; the next fit retries */ }
  }

  // ── output ────────────────────────────────────────────────────────────────

  // `queue` is the part xterm has not been given yet — it only ever holds anything
  // before the first fit. `text` is the replayed buffer, kept only until the overlap
  // below has been trimmed against it; after that the Terminal is the scrollback.
  function push(pane, chunk) {
    if (!pane.replayed) {
      pane.text += chunk;
      if (pane.text.length > MAX_TAIL) pane.text = pane.text.slice(pane.text.length - MAX_TAIL);
    }
    pane.queue += chunk;
    drain(pane);
  }

  function drain(pane) {
    if (pane.disposed || !pane.ready || !pane.queue) return;
    var out = pane.queue;
    pane.queue = '';
    pane.term.write(out);
  }

  function replay(pane) {
    Promise.resolve(window.sb.shellBuffer(pane.wsId)).then(function (r) {
      if (pane.disposed) return;
      var text = r && typeof r.text === 'string' ? r.text : '';
      if (text) push(pane, text);
      pane.replayed = true;
      flushPending(pane);
    }, function () {
      if (pane.disposed) return;
      pane.replayed = true;
      flushPending(pane);
    });
  }

  // The ring-buffer snapshot and the live stream overlap: a chunk emitted just
  // before the snapshot was taken is in BOTH, so writing the queue verbatim would
  // print it twice. Drop the longest prefix of the queue that the replayed text
  // already ends with.
  function flushPending(pane) {
    var tail = pane.pending.join('');
    pane.pending.length = 0;
    if (!tail) return;
    var overlap = Math.min(tail.length, pane.text.length, MAX_TAIL);
    while (overlap > 0 &&
           pane.text.slice(pane.text.length - overlap) !== tail.slice(0, overlap)) overlap--;
    var fresh = tail.slice(overlap);
    if (fresh) push(pane, fresh);
  }

  // A workspace with a live shell and NO pane. It happens exactly once: close the
  // window on macOS (the app stays running, the shells with it) and open it again —
  // app.js adopts the shells into state.shell, but no pane exists until you visit that
  // Terminal, and term.onBell is the only thing that ever rings SB.bell. So Claude
  // could finish a turn in the background and the sidebar would stay silent.
  //
  // xterm's parser is the authority on where a BEL is a bell, and the one case that
  // matters is OSC: `ESC ] … BEL` is how a title change and Claude's own `/copy`
  // terminate, and counting those would ring the bell on every clipboard write. So
  // track just that state, across chunks, and only for workspaces with no pane — a
  // pane's own onBell keeps doing the job everywhere else.
  var osc = Object.create(null);     // wsId -> mid-OSC when the last chunk ended

  function sniffBell(wsId, chunk) {
    var inOsc = !!osc[wsId];
    var rang = false;
    for (var i = 0; i < chunk.length; i++) {
      var c = chunk.charCodeAt(i);
      if (inOsc) {
        // BEL and ESC \ (ST) both end an OSC string; neither is a bell.
        if (c === 7) inOsc = false;
        else if (c === 27 && chunk.charCodeAt(i + 1) === 92) { inOsc = false; i++; }
        continue;
      }
      if (c === 27 && chunk.charCodeAt(i + 1) === 93) { inOsc = true; i++; continue; }
      if (c === 7) rang = true;
    }
    osc[wsId] = inOsc;
    if (rang && typeof SB.bell === 'function') SB.bell(wsId, true);
  }

  function write(wsId, chunk) {
    if (typeof chunk !== 'string' || !chunk) return;
    var pane = panes.get(wsId);
    if (!pane || pane.disposed) { sniffBell(wsId, chunk); return; }
    if (!pane.replayed) { pane.pending.push(chunk); return; }
    push(pane, chunk);
  }

  // Every sb:evt:termState, straight from app.js. A shell that has been replaced —
  // New shell, or the user's own `exec` — comes back with a new startedAt behind the
  // same wsId. Keep writing into the SAME Terminal: clearing would throw away the
  // scrollback the user is still reading, and there is nothing to replay because a
  // brand-new shell's ring buffer is empty. The new prompt simply prints under the
  // old session's last line, which is what `exec zsh` looks like in any terminal.
  function onState(shell) {
    if (!shell || !shell.wsId) return;
    if (shell.status === 'running') delete failed[shell.wsId];
    var pane = panes.get(shell.wsId);
    if (!pane) return;
    pane.live = shell.status !== 'exited';
    if (shell.startedAt && shell.startedAt !== pane.startedAt) {
      pane.startedAt = shell.startedAt;
      // A generation this pane did not open — adopted, or restarted from elsewhere —
      // is running at main's default size until something tells it otherwise, and no
      // fit is coming while the pane's box has not changed.
      if (pane.ready) sendResize(pane);
    }
  }

  // app.js retires the panes of workspaces that are off screen, and a pane holds a
  // Terminal, a ResizeObserver and up to 10 000 lines of scrollback. It asks first,
  // because a shell that is still alive must keep its pane: its ring buffer is a
  // half-painted TUI, and replaying that into a fresh xterm is garbage (§6 R8).
  function hasLivePane(wsId) {
    var pane = panes.get(wsId);
    return !!pane && !pane.disposed && pane.live !== false;
  }

  function dispose(wsId) {
    var pane = panes.get(wsId);
    if (!pane) return;
    panes['delete'](wsId);
    pane.disposed = true;
    if (pane.observer) { try { pane.observer.disconnect(); } catch (_) { /* already gone */ } }
    if (pane.host.parentNode) pane.host.parentNode.removeChild(pane.host);
    try { pane.term.dispose(); } catch (_) { /* already gone */ }
  }

  // ── the Edit menu ─────────────────────────────────────────────────────────

  function focusedPane() {
    var active = document.activeElement;
    if (!active) return null;
    // Text that is edited in place (a contenteditable) keeps its own edit commands,
    // wherever it sits: ⌘V there must never type the clipboard into a shell.
    if (active.isContentEditable === true) return null;
    var found = null;
    panes.forEach(function (pane) {
      if (!found && !pane.disposed && pane.host.contains(active)) found = pane;
    });
    return found;
  }

  // A menu accelerator wins over the renderer's keydown and xterm's selection is not
  // a DOM selection, so ⌘C/⌘V/⌘A arrive here as sb:evt:edit (§4.7). `true` means this
  // terminal consumed the action; `false` sends app.js to its document fallback,
  // which is the right answer when the user meant a diff on another screen.
  function editAction(action, text) {
    var pane = focusedPane();
    if (!pane) return false;
    if (action === 'copy') {
      if (!pane.term.hasSelection()) return false;
      toClipboard(pane.term.getSelection());
      return true;
    }
    if (action === 'paste') {
      // term.paste() wraps the text in the bracketed-paste markers when the program
      // has asked for them — writing it straight to the pty would not, and Claude
      // Code's composer would read a pasted newline as Enter.
      pane.term.paste(typeof text === 'string' ? text : '');
      return true;
    }
    if (action === 'selectAll') {
      pane.term.selectAll();
      return true;
    }
    return false;
  }

  // ── footer ────────────────────────────────────────────────────────────────

  // views/workspace.js owns the duration format the header already prints; fall
  // back to the same rule when it is not exported, so the two never disagree.
  function dur(ms) {
    var f = SB.views.workspace && SB.views.workspace.dur;
    if (typeof f === 'function') return f(ms);
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm';
    var hours = Math.floor(m / 60);
    var rest = m % 60;
    return rest ? hours + 'h ' + rest + 'm' : hours + 'h';
  }

  function signalName(signal) {
    if (!signal) return null;
    if (typeof signal === 'number') return SIGNAL_NAMES[signal] || ('signal ' + signal);
    return String(signal);
  }

  // The design's `exited 1 · 4s` — the same vocabulary the Logs footer and the
  // header's live span use. `exited 0 · 4s` is a shell the user typed `exit` into,
  // `exited on SIGHUP · 4s` is one the app hung up, and `exited 1 · 4s` is one that
  // fell over. §2's Shell carries no exit timestamp; app.js stamps one when it sees
  // the flip, exactly as it does for a RunState, and without it the duration is
  // simply left off.
  function exitInfo(shell) {
    var code = typeof shell.exitCode === 'number' ? shell.exitCode : null;
    var signal = signalName(shell.signal);
    // A shell Switchboard hung up is a stop, whatever number zsh chose to exit with —
    // and it chooses 1 after SIGHUP, so reading the code here would paint the red bar
    // over a shell the user asked to close. `closed` is main saying it did this.
    var label = shell.closed
      ? 'closed'
      : (signal ? 'exited on ' + signal : (code !== null ? 'exited ' + code : 'exited'));
    var ran = shell.startedAt && shell.exitedAt ? shell.exitedAt - shell.startedAt : 0;
    if (ran > 0) label += ' · ' + dur(ran);
    if (shell.closed) return { label: label, clean: true };
    return { label: label, clean: signal ? !!STOP_SIGNALS[signal] : code === 0 };
  }

  function footer(shell, pane) {
    if (!shell || shell.status !== 'exited') return null;
    var info = exitInfo(shell);
    return h('div.exit' + (info.clean ? '.ok' : ''), null,
      h('span', null, info.label),
      h('span.sp'),
      h('button.btn.sm', {
        type: 'button',
        onClick: function () { openShell(pane); },
      }, 'New shell'));
  }

  // ── render ────────────────────────────────────────────────────────────────

  // One line of state and one action, the way every other row in this app reads. The
  // button is offered only where retrying could help — a workspace that failed to open —
  // and never for "the terminal did not load", which no amount of trying will fix.
  function blank(message, wsId) {
    // data-msg lets place() keep a sentence that is already showing rather than
    // rebuild it (and the focused Try again with it) on every whiteboard render.
    if (!wsId) return h('div.term.blank', { 'data-msg': message }, message);
    return h('div.term.blank', { 'data-msg': message }, h('div.stack', null,
      h('span', null, message),
      h('button.btn.sm', {
        type: 'button',
        onClick: function () { retry(wsId); }
      }, 'Try again')));
  }

  // The sentence open() answered with wins: it is the concrete reason (node-pty
  // failed to load, the spawn failed) and it outlives the Shell it came with.
  function errorOf(wsId, shell) {
    if (failed[wsId]) return failed[wsId];
    if (shell && shell.error && shell.status !== 'running') return shell.error;
    return null;
  }

  function loaded() {
    return !!(window.Terminal && window.FitAddon && window.WebLinksAddon);
  }

  // A pane's mode: fit (fixed null, the base font) everywhere but a pinned whiteboard
  // terminal, which passes its own grid and zoomed font. A mode left over from one
  // host must never leak into the next — the Terminal tab showing a pinned terminal's
  // 7px text at its pinned cols/rows would be a bug — so every mount sets it whole.
  function cleanSize(size) {
    if (!size || typeof size !== 'object') return null;
    var cols = Math.floor(Number(size.cols));
    var rows = Math.floor(Number(size.rows));
    if (!isFinite(cols) || !isFinite(rows) || cols < 2 || rows < 1) return null;
    return { cols: cols, rows: rows };
  }

  function applyFont(pane, px) {
    var size = Number(px);
    if (!isFinite(size) || size <= 0) size = BASE_FONT;
    if (pane.fontSize === size) return;
    pane.fontSize = size;
    // A live option: xterm re-measures the cell and repaints at the same cols/rows,
    // so nothing reaches the pty until a fit says otherwise.
    try { pane.term.options.fontSize = size; } catch (_) { /* a disposed Terminal */ }
    syncScroll(pane);
  }

  // xterm 6's viewport works out its scroll range (rows × cell height) only when the
  // buffer resizes or scrolls — not when the cell changes size with the font. A pinned
  // terminal changes font on every zoom at fixed cols/rows, so its range stayed at the
  // old cell height and the wheel could no longer scroll the scrollback until new
  // output arrived. This asks the viewport to measure again. It is xterm's internal
  // API (there is no public one); without it nothing breaks that was not already.
  function syncScroll(pane) {
    try {
      var core = pane.term && pane.term._core;
      var viewport = core && core._viewport;
      if (viewport && typeof viewport.queueSync === 'function') viewport.queueSync();
    } catch (_) { /* a disposed or unopened Terminal: its first fit syncs it */ }
  }

  function setMode(pane, fixed, fontSize) {
    pane.fixed = cleanSize(fixed);
    applyFont(pane, fontSize);
  }

  // Puts a workspace's terminal — the pane, or the sentence standing in for it, and
  // the exit footer when there is one — into `into`. The Terminal tab, Grid and the
  // whiteboards' terminals get the SAME pane: one xterm and one shell per workspace,
  // whichever screen is showing it, so the host moves between them. The route hosts
  // (the Terminal tab and a Grid square) take it with mount() unconditionally, as the
  // only screen on show; a whiteboard takes it with place() below, which yields to
  // whoever holds it on screen — two hosts that both took it on every render would
  // bounce it between them, refitting and resizing the pty each time. That is the whole
  // reason the Grid and the whiteboards can exist without a second copy of everything
  // in this file.
  function mount(wsId, shell, into) {
    if (!loaded()) {
      into.appendChild(blank('the terminal did not load'));
      return into;
    }

    var problem = errorOf(wsId, shell);
    if (problem) {
      into.appendChild(blank(problem, wsId));
      return into;
    }

    var pane = panes.get(wsId) || createPane(wsId);
    // A route host owns the pane outright, in fit mode at the base font, and releases
    // any hold a whiteboard left behind.
    pane.owner = null;
    pane.home = into;
    pane.held = false;
    setMode(pane, null, BASE_FONT);
    into.appendChild(pane.host);
    activate(pane, 200);

    var foot = footer(shell, pane);
    if (foot) into.appendChild(foot);
    return into;
  }

  // The sentence standing in for a terminal, kept as it is when it already says this:
  // a whiteboard re-places on every render while it shows one.
  function showBlank(into, el) {
    var only = into.children.length === 1 ? into.firstElementChild : null;
    if (only && only.classList.contains('blank') &&
        only.getAttribute('data-msg') === el.getAttribute('data-msg')) return;
    into.replaceChildren(el);
  }

  // A whiteboard's YIELDING mount. `into` takes the host only when nothing on screen
  // has it, when it is already in `into`, when the same owner put it somewhere else
  // (a pinned terminal floating back out), or when `force` says the user asked for it
  // here (the stand-in's Show here). Returns whether `into` now holds it; on false the
  // caller draws its own stand-in and `into` is left as it is. A failed or unloaded
  // terminal gets the sentence mount() shows, and counts as held.
  //   opts = { owner: 'wb:<boardId>', fixed?: {cols, rows} | null, fontSize?: px, force?: bool }
  function place(wsId, into, opts) {
    var o = opts || {};
    if (!wsId || !into || !into.isConnected) return false;
    var shell = ((SB.state || {}).shell || {})[wsId] || null;
    if (!loaded()) {
      showBlank(into, blank('the terminal did not load'));
      return true;
    }
    var problem = errorOf(wsId, shell);
    if (problem) {
      showBlank(into, blank(problem, wsId));
      return true;
    }

    var owner = o.owner === null || o.owner === undefined ? null : String(o.owner);
    var pane = panes.get(wsId);
    if (pane && pane.disposed) pane = null;
    if (pane && !into.contains(pane.host) && pane.host.isConnected &&
        pane.owner !== owner && !o.force) return false;

    if (!pane) pane = createPane(wsId);
    // A placement ends any hold: a drag cut short (its panel hidden or minimized
    // mid-drag never sees its pointerup) must not leave the pane unable to fit.
    pane.held = false;
    pane.owner = owner;
    pane.home = into;
    setMode(pane, o.fixed, o.fontSize);
    // Whatever stood in for the terminal goes: a stand-in, an old sentence, the last
    // exit footer (drawn again below if the shell is still exited).
    Array.prototype.slice.call(into.childNodes).forEach(function (child) {
      if (child !== pane.host && !child.contains(pane.host)) into.removeChild(child);
    });
    if (!into.contains(pane.host)) into.appendChild(pane.host);
    var foot = footer(shell, pane);
    if (foot) into.appendChild(foot);
    activate(pane, 200);
    return true;
  }

  // The pane `owner` is holding, on screen in the element it placed it into — or null.
  // Every whiteboard call below goes through this, so a layer that lost its terminal to
  // the Grid cannot reach across and shrink the Grid's font or pin its size.
  function ownedPane(wsId, owner) {
    var pane = panes.get(wsId);
    if (!pane || pane.disposed || !pane.opened) return null;
    if (owner === null || owner === undefined || pane.owner !== String(owner)) return null;
    if (!pane.home || !pane.home.isConnected || !pane.home.contains(pane.host)) return null;
    return pane;
  }

  // What a fit would make of the pane's box at its current font, without resizing
  // anything. Null until the Terminal has been opened and measured.
  function proposeOf(pane) {
    var dims = null;
    try { dims = pane.fit.proposeDimensions(); } catch (_) { dims = null; }
    return cleanSize(dims);
  }

  function propose(wsId) {
    var pane = panes.get(wsId);
    if (!pane || pane.disposed || !pane.opened) return null;
    return proposeOf(pane);
  }

  // A pinned terminal's font follows the zoom. Cell sizes are measured, rounded and
  // ceil'd by xterm, so a font that is exactly proportional to the box can still need
  // a pixel more than it has, and the prompt line is the one that gets clipped: step
  // down a quarter pixel at a time, three times at most, until the fixed grid fits.
  function setFontSize(wsId, px, owner) {
    var pane = ownedPane(wsId, owner);
    if (!pane) return false;
    applyFont(pane, px);
    if (pane.fixed) {
      for (var i = 0; i < 3; i++) {
        var p = proposeOf(pane);
        if (!p || (p.cols >= pane.fixed.cols && p.rows >= pane.fixed.rows)) break;
        applyFont(pane, pane.fontSize - 0.25);
      }
    }
    return true;
  }

  // A pinned terminal whose node changed its own type size (Smaller text, Larger
  // text): the new font first, then the grid its box holds at that font, fixed — the
  // one pty resize a type size costs. The grid is measured at the font itself, not at
  // a step-down setFontSize took to squeeze the old grid in. Returns the new grid, or
  // null when the pane is not this owner's or can't be measured yet.
  function refont(wsId, px, owner) {
    var pane = ownedPane(wsId, owner);
    if (!pane) return null;
    applyFont(pane, px);
    var p = proposeOf(pane);
    if (!p) return null;
    pane.fixed = p;
    queueFit(pane);
    setFontSize(wsId, px, owner);
    return p;
  }

  // Fixed (a pinned terminal) or fit (null). The fit that follows applies it; a new
  // fixed size is the one time a pinned terminal's pty is told anything.
  function setFixed(wsId, size, owner) {
    var pane = ownedPane(wsId, owner);
    if (!pane) return false;
    pane.fixed = cleanSize(size);
    queueFit(pane);
    return true;
  }

  // Suspends fits while a whiteboard panel's edge is dragged; the release fits once.
  function hold(wsId, on, owner) {
    var pane = ownedPane(wsId, owner);
    if (!pane) return false;
    var was = pane.held;
    pane.held = !!on;
    if (was && !pane.held) queueFit(pane);
    return true;
  }

  // Who holds the pane: a whiteboard layer's token, or null for a route host or for
  // no host at all. A layer reads it to word its stand-in — another board's terminal
  // can be taken back with Show here; a Grid square or the Terminal tab cannot, since
  // their next render would only take it again.
  function ownerOf(wsId) {
    var pane = panes.get(wsId);
    if (!pane || pane.disposed || !pane.host.isConnected) return null;
    return pane.owner;
  }

  function body(wsId, shell) {
    return mount(wsId, shell, h('div.bd.pane'));
  }

  // The Grid's landing focus. Nothing else: which pane deserves it is the Grid's
  // call, and it never takes focus from a pane that already has it.
  function focus(wsId) {
    var pane = panes.get(wsId);
    if (!pane || pane.disposed || !pane.opened) return false;
    try { pane.term.focus(); } catch (_) { return false; }
    return true;
  }

  function render(state) {
    var route = state.route || {};
    var wsId = route.wsId;
    // byId holds the scanned workspace; before the first scan the id is all we know.
    var ws = (state.byId || {})[wsId] || { id: wsId };
    var shell = (state.shell || {})[wsId] || null;

    return D.frag(SB.views.workspace.header(ws, state), body(wsId, shell));
  }

  // app.js, once the rail has finished moving. Every pane, not just the one on
  // screen: a background workspace's shell is still a live pty at the old width,
  // and it is the one that would come back wrapped.
  function relayout() {
    panes.forEach(function (pane) { queueFit(pane); });
  }

  SB.views = SB.views || {};
  SB.views.terminal = {
    render: render,
    relayout: relayout,
    mount: function (wsId, into) { return mount(wsId, ((SB.state || {}).shell || {})[wsId] || null, into); },
    // The whiteboards' side of the same pane (views/wbterminals.js): a yielding mount,
    // and the zoomed font, text size, fixed grid and drag hold of a pinned or floating
    // terminal.
    place: place,
    setFontSize: setFontSize,
    refont: refont,
    propose: propose,
    setFixed: setFixed,
    hold: hold,
    owner: ownerOf,
    focus: focus,
    write: write,
    onState: onState,
    dispose: dispose,
    hasLivePane: hasLivePane,
    editAction: editAction,
    // The live xterm for a workspace, for the smoke harness to look at (buffer type,
    // scrollback length). Nothing in the app reads it.
    xterm: function (wsId) { var pane = panes.get(wsId); return pane && !pane.disposed ? pane.term : null; },
  };
})(window.SB);
