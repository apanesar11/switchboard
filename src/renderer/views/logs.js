// SB.views.logs — the Logs tab (mock-up 03): the workspace header with Logs
// selected, and a real xterm filling the pane.
//
// ONE Terminal per PROCESS, kept in `panes`, because a view is rebuilt whenever
// something visible changes and a fresh Terminal would throw the scrollback away.
// Each render moves the same host element into the new `.bd.pane`; xterm is
// re-parented, not re-opened.
//
// Per process, not per workspace: demo runs demo-nextjs and demo-native
// into one session, and two pty streams sharing one xterm fight over the cursor —
// Metro's \r spinner overwrites Next's lines and its clear-screen wipes them. So a
// multi-process workspace gets a small picker above the terminal, in the same
// segmented-control language as Changes | Logs, and each process keeps its own
// pane, its own scrollback and its own keyboard. A single-process workspace
// (sample, example) shows no picker at all and looks exactly as approved.
//
// `.bd` takes the `pane` modifier (overflow:hidden) so the page never scrolls —
// xterm scrolls inside itself and the `.exit` footer stays put at the bottom.
//
// The app's own workspace has no dev process; its Publish build (main/publisher.js)
// arrives here as a run with one process named `publish`, so it gets the same
// pane, replay and exit footer — with Publish again in place of Restart.
window.SB = window.SB || {};

(function (SB) {
  'use strict';

  var D = SB.dom;
  var h = D.h;

  var panes = new Map();              // wsId \0 procName -> pane
  var picked = Object.create(null);   // wsId -> the process the user is watching
  var MAX_TEXT = 1024 * 1024;         // what Copy log can hold; main's ring buffer is the same size

  // A shutdown a process was asked to take, as opposed to one that killed it.
  var STOP_SIGNALS = { SIGTERM: 1, SIGINT: 1, SIGHUP: 1 };

  // node-pty's onExit reports the signal as a NUMBER alongside an exitCode of 0;
  // child_process reports the name alongside a null code. Either way the signal is
  // how the process ended, so it wins over the code when both are there.
  var SIGNAL_NAMES = {
    1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 6: 'SIGABRT',
    9: 'SIGKILL', 11: 'SIGSEGV', 13: 'SIGPIPE', 15: 'SIGTERM',
  };

  // Logs shares the Terminal tab's palette (term-theme.js) and follows it: the two
  // panes are the same slab in the same window, and a light Terminal beside a dark
  // Logs would read as a bug rather than a choice.
  SB.termTheme.onChange(function (_name, palette) {
    panes.forEach(function (pane) {
      if (pane.disposed) return;
      try {
        pane.term.options.theme = palette;
      } catch (err) {
        console.error('[switchboard] logs: theme:', err);
      }
    });
  });

  // ── which process ─────────────────────────────────────────────────────────

  function keyOf(wsId, procName) {
    return wsId + '\u0000' + (procName || '');
  }

  // The names main reports in the run state, in start order; procs[0] is what
  // main's own logs()/sendInput() default to when no name is given.
  function procNames(run) {
    var list = (run && run.procs) || [];
    var out = [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].name) out.push(list[i].name);
    return out;
  }

  function openNames(wsId) {
    var out = [];
    panes.forEach(function (pane) { if (pane.wsId === wsId) out.push(pane.procName); });
    return out;
  }

  function procState(run, name) {
    var list = (run && run.procs) || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].name === name) return list[i];
    return null;
  }

  // `demo-nextjs` in the workspace `demo` reads as `nextjs` on screen — the
  // same trimming §2 uses for repo display names, and the segmented control this
  // picker borrows its look from has one-word labels.
  function procLabel(ws, name) {
    var n = String(name || '');
    var prefixes = [ws && ws.project, ws && ws.id];
    for (var i = 0; i < prefixes.length; i++) {
      var p = prefixes[i];
      if (p && n.length > p.length + 1 && n.slice(0, p.length + 1) === p + '-') return n.slice(p.length + 1);
    }
    return n;
  }

  // ── pane lifecycle ────────────────────────────────────────────────────────

  function createPane(wsId, procName) {
    var pane = {
      wsId: wsId,
      procName: procName || null,     // the process this pane shows and types into
      host: h('div.term'),
      term: new window.Terminal({
        allowProposedApi: true,
        cursorBlink: false,
        scrollback: 10000,
        fontFamily: '"SF Mono", Menlo, Consolas, monospace',
        fontSize: 12.5,
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
    };

    pane.term.loadAddon(pane.fit);
    // Same Unicode 11 width table the Terminal tab registers, for the same reason: with
    // xterm's built-in Unicode 6 table an emoji measures one cell instead of two, and
    // Next, Vite and Expo all print them in their start-up banners.
    if (window.Unicode11Addon && window.Unicode11Addon.Unicode11Addon) {
      try {
        pane.term.loadAddon(new window.Unicode11Addon.Unicode11Addon());
        pane.term.unicode.activeVersion = '11';
      } catch (err) {
        // Say so rather than swallowing it: the failure mode is a terminal that looks
        // right until an emoji drifts a column, which is exactly the kind of thing
        // nobody traces back to a silent catch.
        console.warn('[switchboard] %s: unicode 11 did not register:', 'logs', err);
      }
    }
    // Addons are NAMESPACED on the UMD global: new WebLinksAddon.WebLinksAddon(), not new WebLinksAddon().
    pane.term.loadAddon(new window.WebLinksAddon.WebLinksAddon(function (_event, uri) {
      Promise.resolve(window.sb.openExternal(uri))['catch'](function () {});
    }));

    // Expo and Metro read single keypresses (i, r, w), so the terminal has to be a
    // real input — and the keys have to reach the process on screen, not whichever
    // one main happens to list first. A workspace that is not running rejects the
    // write; that is not an error worth showing — the keystroke had nowhere to go.
    pane.term.onData(function (data) {
      Promise.resolve(window.sb.sendInput(wsId, data, pane.procName))['catch'](function () {});
    });

    panes.set(keyOf(wsId, procName), pane);
    replay(pane);
    return pane;
  }

  function refit(pane) {
    if (pane.disposed || !pane.opened || !pane.host.isConnected) return;
    // The rail is mid-slide. Every frame of it fires the ResizeObserver, and acting
    // on them would hand the pty a new size twenty times in a fifth of a second.
    // app.js calls relayout() below when the layout has settled, and one fit there
    // is worth the twenty skipped here.
    if (SB.layout && SB.layout.busy()) return;
    var box = pane.host.getBoundingClientRect();
    if (!box.width || !box.height) return;   // mid-layout; the ResizeObserver refits
    try { pane.fit.fit(); } catch (_) { /* nothing measurable yet; the next fit gets it */ }
    // The pty was spawned at main's default 120x30 and stays there unless it is
    // told otherwise, so a dev server wraps its output — Expo's menu, Metro's
    // progress bar, any full-screen repaint — for a terminal that is not on
    // screen. Deliberately not memoised on the last size sent: a Restart spawns a
    // brand-new pty behind the same pane at 120x30 with cols/rows unchanged, and a
    // memo would never correct it. Resizing a pty to the size it already has costs
    // one ioctl and sends no SIGWINCH.
    var api = window.sb;
    if (api && typeof api.resize === 'function' && pane.term.cols && pane.term.rows) {
      Promise.resolve(api.resize(pane.wsId, pane.term.cols, pane.term.rows, pane.procName))['catch'](function () {});
    }
    // Nothing may be written before this point. A Terminal opens at xterm's default
    // 80x24, so replaying a 23-line buffer into it pushes the opening lines into
    // scrollback — and a pane that is really 26 rows tall then starts mid-log.
    pane.ready = true;
    drain(pane);
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

  // ── output ────────────────────────────────────────────────────────────────

  // `text` is the whole log, for Copy log. `queue` is the part xterm has not been
  // given yet — it only ever holds anything before the first fit.
  function push(pane, chunk) {
    pane.text += chunk;
    if (pane.text.length > MAX_TEXT) pane.text = pane.text.slice(pane.text.length - MAX_TEXT);
    pane.queue += chunk;
    drain(pane);
  }

  function drain(pane) {
    if (pane.disposed || !pane.ready || !pane.queue) return;
    var out = pane.queue;
    pane.queue = '';
    pane.term.write(out);
  }

  // main keeps one ring buffer PER PROCESS and, given no name, answers with the
  // first one — which is how demo-native's start-up banner (the exp:// URL,
  // 'press i to open iOS simulator') used to vanish. Ask for this pane's own.
  function replay(pane) {
    Promise.resolve(window.sb.logs(pane.wsId, pane.procName)).then(function (r) {
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
    var overlap = Math.min(tail.length, pane.text.length, 65536);
    while (overlap > 0 && pane.text.slice(pane.text.length - overlap) !== tail.slice(0, overlap)) overlap--;
    var fresh = tail.slice(overlap);
    if (fresh) push(pane, fresh);
  }

  function paneFor(wsId, procName) {
    var pane = panes.get(keyOf(wsId, procName));
    if (pane) return pane;
    // An untagged chunk — an older main, or one that never named its process — is
    // unambiguous only while this workspace has a single pane. With two open, a
    // guess would interleave the very streams the panes exist to separate.
    if (procName) return null;
    var only = null;
    var n = 0;
    panes.forEach(function (p) { if (p.wsId === wsId) { only = p; n++; } });
    return n === 1 ? only : null;
  }

  function write(wsId, chunk, procName) {
    var pane = paneFor(wsId, procName);
    if (!pane || pane.disposed || typeof chunk !== 'string' || !chunk) return;
    if (!pane.replayed) { pane.pending.push(chunk); return; }
    push(pane, chunk);
  }

  // Every pane of the workspace: app.js retires the panes of workspaces that are
  // neither on screen nor producing output, and a multi-process workspace holds
  // one Terminal (10 000-line scrollback) and one ResizeObserver per process.
  function dispose(wsId) {
    var keys = [];
    panes.forEach(function (pane, key) { if (pane.wsId === wsId) keys.push(key); });
    keys.forEach(function (key) {
      var pane = panes.get(key);
      panes['delete'](key);
      pane.disposed = true;
      if (pane.observer) { try { pane.observer.disconnect(); } catch (_) { /* already gone */ } }
      if (pane.host.parentNode) pane.host.parentNode.removeChild(pane.host);
      try { pane.term.dispose(); } catch (_) { /* already gone */ }
    });
  }

  // ── footer ────────────────────────────────────────────────────────────────

  function copyLog(pane) {
    var text = pane ? pane.text : '';
    var write2 = navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText(text)
      : Promise.reject();
    return Promise.resolve(write2)['catch'](function () {
      var box = document.createElement('textarea');
      box.value = text;
      box.setAttribute('readonly', '');
      box.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(box);
      box.select();
      try { document.execCommand('copy'); } catch (_) { /* nothing else to try */ }
      document.body.removeChild(box);
    });
  }

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

  // The design's `exited 1 · 4s` — the same vocabulary as the header's live span,
  // never "exited with code 0". Three readings, because three things happened:
  // `exited 0 · 4s` finished cleanly, `exited 1 · 4s` crashed, and
  // `exited on SIGTERM · 4s` was killed. Only a zero code or a shutdown signal
  // gets the calm bar; a non-zero code, SIGKILL or SIGSEGV stays red.
  function exitInfo(run, proc) {
    var src = proc || run;
    var code = typeof src.exitCode === 'number' ? src.exitCode : null;
    var signal = signalName(proc && proc.signal);
    var label = signal ? 'exited on ' + signal : (code !== null ? 'exited ' + code : 'exited');
    var startedAt = (proc && proc.startedAt) || run.startedAt || 0;
    var exitedAt = (proc && proc.exitedAt) || run.exitedAt || 0;
    var ran = startedAt && exitedAt ? exitedAt - startedAt : 0;
    if (ran > 0) label += ' · ' + dur(ran);
    return { label: label, clean: signal ? !!STOP_SIGNALS[signal] : code === 0 };
  }

  // The app's own workspace publishes instead of starting (§4.13), so its footer
  // offers Publish again — except while a verified update is waiting for quit,
  // when the header's Publish is disabled for the same reason and a second build
  // would only be thrown away.
  function again(ws, wsId, state) {
    if (!ws.self) {
      return h('button.btn.sm', {
        type: 'button',
        onClick: function () { Promise.resolve(window.sb.start(wsId))['catch'](function () {}); },
      }, 'Restart');
    }
    var pub = (state && state.publish) || {};
    if (pub.status === 'ready' || pub.status === 'publishing') return null;
    return h('button.btn.sm', {
      type: 'button',
      onClick: function () { if (typeof SB.publish === 'function') SB.publish(wsId); },
    }, 'Publish again');
  }

  function footer(ws, wsId, run, pane, procName, state) {
    if (!run) return null;
    if (run.status === 'starting') {
      return h('div.exit.ok', null, h('span', null, 'starting…'), h('span.sp'));
    }
    if (run.status !== 'exited') return null;

    var info = exitInfo(run, procState(run, procName));
    var foot = h('div.exit' + (info.clean ? '.ok' : ''), null,
      h('span', null, info.label),
      h('span.sp'),
      h('button.btn.sm', { type: 'button', onClick: function () { copyLog(pane); } }, 'Copy log'));
    var more = again(ws, wsId, state);
    if (more) foot.appendChild(more);
    return foot;
  }

  // ── render ────────────────────────────────────────────────────────────────

  function blank(message) {
    return h('div.term.blank', null, message);
  }

  function hasEverRun(run) {
    if (!run) return false;
    return run.status === 'starting' || run.status === 'running' || run.status === 'exited' || !!run.startedAt;
  }

  // Only a workspace with more than one dev process gets one, so sample and
  // example keep the bare terminal the mock-up shows. `.seg` is inline-flex and
  // `.bd.pane` is a flex column, so it has to be told not to stretch; that is the
  // whole reason for the inline style (styles.css is not this file's to edit).
  function picker(ws, wsId, names, active) {
    var box = h('div.seg.procs', { style: 'flex:none;align-self:flex-start;margin:0 0 2px' });
    names.forEach(function (name) {
      box.appendChild(h('button' + (name === active ? '.on' : ''), {
        type: 'button',
        title: name,
        'aria-pressed': name === active ? 'true' : 'false',
        onClick: function () {
          if (name === active) return;
          picked[wsId] = name;
          if (typeof SB.render === 'function') SB.render();
        },
      }, procLabel(ws, name)));
    });
    return box;
  }

  function idle(ws) {
    return ws.self ? 'nothing has been published yet — press Publish' : 'nothing has run yet — press Start';
  }

  function body(ws, wsId, run, state) {
    var bd = h('div.bd.pane');

    if (!window.Terminal || !window.FitAddon || !window.WebLinksAddon) {
      bd.appendChild(blank('the terminal did not load'));
      return bd;
    }

    var names = procNames(run);
    var open = openNames(wsId);
    if (!names.length && !open.length) {
      // Either nothing has ever run, or Start is still in flight and main has not
      // said which processes it spawned yet. Nothing is lost by waiting: every
      // chunk is in main's ring buffer and arrives with the pane's first replay.
      bd.appendChild(blank(hasEverRun(run) ? 'starting…' : idle(ws)));
      return bd;
    }
    if (!names.length) names = open;

    var active = names.indexOf(picked[wsId]) === -1 ? names[0] : picked[wsId];
    var pane = panes.get(keyOf(wsId, active)) || createPane(wsId, active);

    if (names.length > 1) bd.appendChild(picker(ws, wsId, names, active));
    bd.appendChild(pane.host);
    activate(pane, 200);

    var foot = footer(ws, wsId, run, pane, active, state);
    if (foot) bd.appendChild(foot);
    return bd;
  }

  function render(state) {
    var route = state.route || {};
    var wsId = route.wsId;
    // byId holds the scanned workspace; before the first scan the id is all we know.
    var ws = (state.byId || {})[wsId] || { id: wsId };
    var run = (state.run || {})[wsId] || null;

    return D.frag(SB.views.workspace.header(ws, state), body(ws, wsId, run, state));
  }

  SB.views = SB.views || {};
  // app.js, once the rail has finished moving. Every pane, not just the one on
  // screen: a background workspace's shell is still a live pty at the old width,
  // and it is the one that would come back wrapped.
  function relayout() {
    panes.forEach(function (pane) { queueFit(pane); });
  }

  SB.views.logs = { render: render, write: write, dispose: dispose, relayout: relayout };
})(window.SB);
