// SB.views.editor — the Editor tab (§4.14, R13): the workspace header with Editor
// selected, and Monaco (VS Code's editor, nothing more of VS Code) over the
// workspace's repos — a file tree, tabs, Save, Go to file, Find in files, the
// modified-line bars against HEAD and a full-screen button. Sublime-light on purpose:
// no language servers, no extensions, no settings.
//
// ONE editor per WORKSPACE, kept in `eds`, for the reason views/terminal.js keeps one
// pane: a render happens on every window focus, run state, bell and notice, and a
// rebuilt editor would throw away unsaved text, the undo stack and the cursor. Unlike
// the Terminal this view does not re-parent a host into a fresh body — render() hands
// back the SAME root element every time, which sends renderMain() down its reuse path
// (§6 R2): no d.clear(main), so Monaco's textarea is never blurred and refocused, and
// an open suggest widget or IME composition survives a bell. Only the header is
// rebuilt, swapped in place. The price is that this file owns what renderMain would
// otherwise do for it — focus in the swapped header, layout and focus on re-attach.
//
// Monaco itself is NOT a <script> in index.html: its AMD loader.js installs a global
// `define` with `define.amd`, which the xterm UMD bundles test BEFORE their global
// branch, so loaded first it would leave window.Terminal undefined. It is injected
// on the first Editor open instead — after xterm has run, and never for a user who
// does not open the Editor at all.
//
// Nothing here writes to a repo but Save, and Save writes the one file the user edited
// (§0). Files on disk are the truth: open tabs are stat-polled while this tab is on
// screen and re-checked on every window focus, a clean buffer follows the disk, and a
// buffer with edits in it is never overwritten without the user saying so.
window.SB = window.SB || {};

(function (SB) {
  'use strict';

  var D = SB.dom;
  var h = D.h;

  // Relative to src/renderer/index.html, the same road xterm's bundles take.
  var VS = '../../node_modules/monaco-editor/min/vs';
  var TABS_KEY = 'switchboard.editor.tabs.';       // + wsId → [{repo, path, active?}]
  var WIDTH_KEY = 'switchboard.editor.treeWidth';
  var TREE_MIN = 160;
  var TREE_MAX = 480;
  var TREE_WIDTH = 216;                              // the mock-up's
  var SAVED_TABS = 30;
  var FOLDER_CAP = 2000;         // children drawn per folder; a stray build dir must not freeze the tree
  var PALETTE_ROWS = 50;
  var RECENT = 50;
  var POLL_MS = 3000;
  var DIFF_MS = 250;
  var SEARCH_MS = 300;
  var REFRESH_MS = 400;
  var STAT_MAX = 200;            // main reads no more than this per sb:code:stat
  var DIFF_SPAN = 5000;          // a middle this long either side is "all modified"
  var DIFF_D = 2000;             // …and so is one that needs this many edits

  var eds = new Map();           // wsId -> ed
  var serial = 0;                // tells two editors' row ids apart
  var loading = null;            // the memoised loadMonaco() promise
  var M = null;                  // window.monaco, once it has loaded
  var told = 0;                  // the dirty count main last heard
  var poll = null;               // the stat interval, alive only while an Editor is on screen
  var lineCopy = null;           // what the last whole-line ⌘C put on the clipboard
  var names = null;              // language id -> display name, for the status bar
  var width = readWidth();
  var collator = typeof Intl === 'object' && Intl.Collator
    ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
    : null;

  // Monaco's theme is global to every editor, so one listener serves them all. It is
  // registered at load because term-theme.js tells every listener on every set() and
  // one that registers later is never told about the last one; a Monaco created after
  // that reads SB.termTheme.current() instead (see create()).
  SB.termTheme.onChange(function (name) {
    if (!M) return;
    try {
      M.editor.setTheme(themeName(name));
    } catch (err) {
      console.error('[switchboard] editor: theme:', err);
    }
  });

  // ── small things ──────────────────────────────────────────────────────────

  function noop() {}

  // Electron wraps a handler's rejection as "Error invoking remote method 'sb:…':
  // Error: …", which is noise in a one-line bar; the same stripping app.js does.
  function message(err) {
    if (err === null || err === undefined) return 'that did not work';
    var s = typeof err === 'string' ? err : (err.error || err.message || String(err));
    return String(s)
      .replace(/^Error invoking remote method '[^']*':\s*/, '')
      .replace(/^(?:Uncaught )?Error:\s*/, '')
      .trim() || 'that did not work';
  }

  // Every bridge call goes through here: feature-checked (a preload from before the
  // Editor existed has none of these), and settled as a value, never a rejection,
  // exactly as main answers (§0 — errors are values across IPC).
  function call(name) {
    var api = window.sb;
    var args = Array.prototype.slice.call(arguments, 1);
    if (!api || typeof api[name] !== 'function') {
      return Promise.resolve({ ok: false, error: 'this build of Switchboard cannot open files' });
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

  // Main writes the clipboard, never this window: navigator.clipboard wants focus and
  // execCommand('copy') wants a user gesture, and a menu item over IPC is neither.
  function toClipboard(text) {
    call('writeClipboard', String(text));
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function baseName(path) {
    var s = String(path || '');
    var i = s.lastIndexOf('/');
    return i < 0 ? s : s.slice(i + 1);
  }

  function dirName(path) {
    var s = String(path || '');
    var i = s.lastIndexOf('/');
    return i < 0 ? '' : s.slice(0, i);
  }

  function fileKey(repo, path) {
    return repo + '\u0000' + path;
  }

  function size(bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) return D.plural(n, 'byte');
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (Math.round(n / 104857.6) / 10) + ' MB';
  }

  // 2000 → "2 000", the way the rest of the app's sentences write a count.
  function num(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }

  function compare(a, b) {
    var c = collator ? collator.compare(a, b) : a.toLowerCase().localeCompare(b.toLowerCase());
    return c || (a < b ? -1 : a > b ? 1 : 0);
  }

  // app.js's `typing()` rule: the fields where a key is text, not a shortcut.
  function isField(el) {
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  }

  // Scrolls a row of our own into view by hand. scrollIntoView() would do it too — and
  // then walk up and scroll every overflow:hidden ancestor as well, .bd included, which
  // slides the whole slab out from under the header.
  function reveal(scroller, el, padTop) {
    if (!scroller || !el) return;
    var top = el.offsetTop - (padTop || 0);
    var bottom = el.offsetTop + el.offsetHeight;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight;
  }

  function revealX(scroller, el) {
    if (!scroller || !el) return;
    var left = el.offsetLeft;
    var right = left + el.offsetWidth;
    if (left < scroller.scrollLeft) scroller.scrollLeft = left;
    else if (right > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = right - scroller.clientWidth;
  }

  function readWidth() {
    var n = TREE_WIDTH;
    try { n = Number(window.localStorage.getItem(WIDTH_KEY)) || TREE_WIDTH; } catch (e) { n = TREE_WIDTH; }
    return clamp(Math.round(n), TREE_MIN, TREE_MAX);
  }

  function saveWidth() {
    try { window.localStorage.setItem(WIDTH_KEY, String(width)); } catch (e) { /* storage off */ }
  }

  function readTabs(wsId) {
    try {
      var list = JSON.parse(window.localStorage.getItem(TABS_KEY + wsId) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function saveTabs(ed) {
    var list = [];
    ed.tabs.forEach(function (tab) {
      if (tab.kind === 'find' || list.length >= SAVED_TABS) return;
      var item = { repo: tab.repo, path: tab.path };
      if (tab.key === ed.active || (ed.active === FIND && tab.key === ed.lastFile)) item.active = true;
      list.push(item);
    });
    try { window.localStorage.setItem(TABS_KEY + ed.wsId, JSON.stringify(list)); } catch (e) { /* storage off */ }
  }

  function route() {
    return (SB.state && SB.state.route) || {};
  }

  function onScreen(ed) {
    var r = route();
    return r.view === 'workspace' && r.tab === 'editor' && r.wsId === ed.wsId && ed.root.isConnected;
  }

  function shownEditor() {
    var r = route();
    if (r.view !== 'workspace' || r.tab !== 'editor') return null;
    var ed = eds.get(r.wsId);
    return ed && ed.root.isConnected ? ed : null;
  }

  function workspace(ed) {
    return (typeof SB.ws === 'function' ? SB.ws(ed.wsId) : null) || null;
  }

  // The scan's Repo for a repo of the tree — the branch for the status bar, a rename's
  // old path for the markers. Nothing here runs git for what the scan already knows.
  function scanned(ed, repoName) {
    var ws = workspace(ed);
    var repos = ws && ws.scanned && Array.isArray(ws.repos) ? ws.repos : [];
    for (var i = 0; i < repos.length; i++) if (repos[i] && repos[i].name === repoName) return repos[i];
    return null;
  }

  // ── Monaco ────────────────────────────────────────────────────────────────

  function themeName(name) {
    return name === 'light' ? 'sb-light' : 'sb-dark';
  }

  // Monaco's theme colours are hex only; the palette writes its selections as rgba().
  function hex(css) {
    var s = String(css || '').trim();
    if (s.charAt(0) === '#') return s;
    var m = /^rgba?\(([^)]+)\)$/.exec(s);
    if (!m) return s;
    var p = m[1].split(',').map(function (x) { return parseFloat(x); });
    function two(n) { var v = clamp(Math.round(n), 0, 255).toString(16); return v.length < 2 ? '0' + v : v; }
    return '#' + two(p[0]) + two(p[1]) + two(p[2]) + (p.length > 3 ? two(p[3] * 255) : '');
  }

  // The mock-ups' code colours are the terminal palette's own slots (term-theme.js),
  // so a file and a shell on the same slab speak one language: keywords magenta,
  // strings green, numbers yellow, types cyan, tags blue, comments dim italic.
  // Identifiers, functions and punctuation stay the plain foreground, as drawn.
  function rules(p, dim) {
    return [
      { token: '', foreground: p.foreground.slice(1), background: p.background.slice(1) },
      { token: 'comment', foreground: dim, fontStyle: 'italic' },
      { token: 'keyword', foreground: p.magenta.slice(1) },
      { token: 'string', foreground: p.green.slice(1) },
      { token: 'string.escape', foreground: p.cyan.slice(1) },
      { token: 'string.key.json', foreground: p.blue.slice(1) },
      { token: 'number', foreground: p.yellow.slice(1) },
      { token: 'regexp', foreground: p.red.slice(1) },
      { token: 'type', foreground: p.cyan.slice(1) },
      { token: 'identifier', foreground: p.foreground.slice(1) },
      { token: 'delimiter', foreground: p.foreground.slice(1) },
      { token: 'operator', foreground: p.foreground.slice(1) },
      { token: 'tag', foreground: p.blue.slice(1) },
      { token: 'metatag', foreground: p.magenta.slice(1) },
      { token: 'attribute.name', foreground: p.yellow.slice(1) },
      { token: 'attribute.value', foreground: p.green.slice(1) },
      { token: 'annotation', foreground: p.cyan.slice(1) },
      { token: 'predefined', foreground: p.blue.slice(1) },
      { token: 'invalid', foreground: p.red.slice(1) },
      { token: 'emphasis', fontStyle: 'italic' },
      { token: 'strong', fontStyle: 'bold' },
    ];
  }

  function defineThemes(monaco) {
    var dark = SB.termTheme.palette('dark');
    var light = SB.termTheme.palette('light');
    monaco.editor.defineTheme('sb-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: rules(dark, '76767c'),
      colors: {
        'editor.background': dark.background,
        'editor.foreground': dark.foreground,
        'editorGutter.background': dark.background,
        'editorLineNumber.foreground': '#5a5a60',
        'editorLineNumber.activeForeground': '#b4b4ba',
        'editor.lineHighlightBackground': '#ffffff0a',
        'editor.lineHighlightBorder': '#00000000',
        'editor.selectionBackground': hex(dark.selectionBackground),
        'editor.inactiveSelectionBackground': '#ffffff1f',
        'editor.selectionHighlightBackground': '#ffffff12',
        'editor.wordHighlightBackground': '#ffffff12',
        'editor.findMatchBackground': '#f0c67466',
        'editor.findMatchHighlightBackground': '#f0c67433',
        'editorCursor.foreground': dark.cursor,
        'editorIndentGuide.background1': '#ffffff12',
        'editorIndentGuide.activeBackground1': '#ffffff2e',
        'editorWhitespace.foreground': '#ffffff24',
        'editorBracketMatch.background': '#ffffff14',
        'editorBracketMatch.border': '#ffffff38',
        'editorLink.activeForeground': dark.blue,
        'editorWidget.background': '#2a2a2e',
        'editorWidget.border': '#ffffff1f',
        'editorSuggestWidget.background': '#2a2a2e',
        'editorSuggestWidget.border': '#ffffff1f',
        'editorSuggestWidget.selectedBackground': '#ffffff17',
        'input.background': '#ffffff12',
        'input.border': '#ffffff1f',
        'focusBorder': '#7cb7ff99',
        'widget.shadow': '#00000080',
        // The right-click menu, in the palette's colours rather than VS Code's grey.
        'menu.background': '#2a2a2e',
        'menu.foreground': dark.foreground,
        'menu.selectionBackground': '#ffffff17',
        'menu.selectionForeground': dark.brightWhite,
        'menu.separatorBackground': '#ffffff1f',
        'menu.border': '#ffffff1f',
        'scrollbar.shadow': '#00000000',
        'scrollbarSlider.background': '#ffffff26',
        'scrollbarSlider.hoverBackground': '#ffffff38',
        'scrollbarSlider.activeBackground': '#ffffff4d',
        'editorOverviewRuler.border': '#00000000',
      },
    });
    monaco.editor.defineTheme('sb-light', {
      base: 'vs',
      inherit: true,
      rules: rules(light, '5a5a5f'),
      colors: {
        'editor.background': light.background,
        'editor.foreground': light.foreground,
        'editorGutter.background': light.background,
        'editorLineNumber.foreground': '#9a9aa0',
        'editorLineNumber.activeForeground': '#3a3a3c',
        'editor.lineHighlightBackground': '#00000009',
        'editor.lineHighlightBorder': '#00000000',
        'editor.selectionBackground': hex(light.selectionBackground),
        'editor.inactiveSelectionBackground': '#00000014',
        'editor.selectionHighlightBackground': '#0000000f',
        'editor.wordHighlightBackground': '#0000000f',
        'editor.findMatchBackground': '#f0a02059',
        'editor.findMatchHighlightBackground': '#f0a0202e',
        'editorCursor.foreground': light.cursor,
        'editorIndentGuide.background1': '#0000000f',
        'editorIndentGuide.activeBackground1': '#00000026',
        'editorWhitespace.foreground': '#00000026',
        'editorBracketMatch.background': '#0000000f',
        'editorBracketMatch.border': '#00000033',
        'editorLink.activeForeground': light.blue,
        'editorWidget.background': '#ffffff',
        'editorWidget.border': '#00000021',
        'editorSuggestWidget.background': '#ffffff',
        'editorSuggestWidget.border': '#00000021',
        'editorSuggestWidget.selectedBackground': '#0000000f',
        'input.background': '#ffffff',
        'input.border': '#00000021',
        'focusBorder': '#0969da99',
        'widget.shadow': '#00000029',
        'menu.background': '#ffffff',
        'menu.foreground': light.foreground,
        'menu.selectionBackground': '#0000000f',
        'menu.selectionForeground': light.foreground,
        'menu.separatorBackground': '#00000014',
        'menu.border': '#00000021',
        'scrollbar.shadow': '#00000000',
        'scrollbarSlider.background': '#00000026',
        'scrollbarSlider.hoverBackground': '#00000038',
        'scrollbarSlider.activeBackground': '#0000004d',
        'editorOverviewRuler.border': '#00000000',
      },
    });
  }

  // With no project around a file, the language services have nothing true to say:
  // TypeScript's worker paints "cannot find module" under every import. So everything
  // but colouring goes off, and no TS/JSON/CSS/HTML worker ever starts (measured).
  // Word suggestions and link detection are the editor worker's, not these.
  var OFF = {
    completionItems: false, hovers: false, documentSymbols: false, definitions: false,
    references: false, documentHighlights: false, rename: false, diagnostics: false,
    documentRangeFormattingEdits: false, signatureHelp: false, onTypeFormattingEdits: false,
    codeActions: false, inlayHints: false, colors: false, foldingRanges: false,
    selectionRanges: false, links: false, documentFormattingEdits: false,
  };

  function quiet(monaco) {
    function off(defaults, extra) {
      // Each on its own: a namespace a later Monaco drops must not cost the others.
      try {
        if (defaults && typeof defaults.setModeConfiguration === 'function') {
          defaults.setModeConfiguration(extra ? Object.assign({}, OFF, extra) : OFF);
        }
      } catch (err) {
        console.warn('[switchboard] editor: a language service stayed on:', err);
      }
    }
    var ts = monaco.typescript || {};
    var css = monaco.css || {};
    off(ts.typescriptDefaults);
    off(ts.javascriptDefaults);
    // tokens stays ON for JSON: its colouring comes from the json mode's own tokenizer
    // (main thread, no worker). TypeScript, JavaScript, CSS and HTML colour through the
    // Monarch grammars in basic-languages whatever this says.
    off((monaco.json || {}).jsonDefaults, { tokens: true });
    off(css.cssDefaults);
    off(css.scssDefaults);
    off(css.lessDefaults);
    off((monaco.html || {}).htmlDefaults);
  }

  // Once per window. editor.main injects its own <link> to editor.main.css — after
  // styles.css, so Monaco wins a specificity tie and our overrides are scoped
  // `.ed .monaco-editor …` — and points MonacoEnvironment.getWorker at Blob workers
  // that importScripts the assets/ bundles, which works in this sandboxed window.
  function loadMonaco() {
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      if (window.monaco && window.monaco.editor) { resolve(window.monaco); return; }
      function boot() {
        try {
          window.require.config({ paths: { vs: VS } });
          window.require(['vs/editor/editor.main'], function () { resolve(window.monaco); }, reject);
        } catch (err) {
          reject(err);
        }
      }
      if (typeof window.require === 'function' && typeof window.require.config === 'function') { boot(); return; }
      var script = document.createElement('script');
      script.src = VS + '/loader.js';
      script.onload = boot;
      script.onerror = function () { reject(new Error('the editor did not load')); };
      document.head.appendChild(script);
    }).then(function (monaco) {
      if (!monaco || !monaco.editor) throw new Error('the editor did not load');
      if (!M) {
        defineThemes(monaco);
        quiet(monaco);
        M = monaco;
        M.editor.setTheme(themeName(SB.termTheme.current()));
      }
      return monaco;
    });
    return loading;
  }

  function ensureMonaco(ed) {
    if (ed.monaco) return;
    loadMonaco().then(function () {
      ed.failed = false;
      create(ed);
    }, function (err) {
      console.error('[switchboard] editor: Monaco did not load:', err);
      ed.failed = true;
      showActive(ed);
    });
  }

  // Try again: forget the failed load and ask every editor to have another go.
  function retryMonaco() {
    if (M) return;
    loading = null;
    eds.forEach(function (ed) { ed.failed = false; showActive(ed); ensureMonaco(ed); });
  }

  function create(ed) {
    if (ed.monaco || !M) return;
    ed.monaco = M.editor.create(ed.codeHost, {
      model: null,
      theme: themeName(SB.termTheme.current()),
      // Its own ResizeObserver: the rail's slide and the full-screen switch both resize
      // the host, and Monaco relayouts itself; relayout() is for settle() regardless.
      automaticLayout: true,
      // REQUIRED. 0.57 defaults to the EditContext API, whose focus target is a DIV:
      // app.js's typing() only knows INPUT/TEXTAREA/contentEditable, so Esc inside the
      // editor would run back(), and renderMain's refocus expects the textarea. Measured.
      editContext: false,
      minimap: { enabled: false },
      fontFamily: '"SF Mono", Menlo, Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.65,
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      fixedOverflowWidgets: true,
      contextmenu: true,
      wordBasedSuggestions: 'currentDocument',
      padding: { top: 10 },
      smoothScrolling: false,
      mouseWheelZoom: false,
      links: true,
      stickyScroll: { enabled: false },
      bracketPairColorization: { enabled: false },   // the mock-up's brackets are plain
      guides: { indentation: true },
      glyphMargin: false,
      folding: true,
      lineNumbersMinChars: 3,
      lineDecorationsWidth: 10,                        // room for the 3px change bars
    });
    ed.monaco.onDidChangeCursorSelection(function () { paintStatus(ed); });
    ed.tabs.forEach(function (tab) { if (tab.kind === 'text' && !tab.model) makeModel(ed, tab); });
    showActive(ed);
    focusIfShown(ed);
  }

  // The language comes from the file name (the URI's last segment), as VS Code infers
  // it. The workspace is the path's FIRST segment, which keeps two workspaces' copies of
  // the same repo path apart — never the authority: Monaco lowercases that, so `Demo`
  // and `demo` would share every model and opening a file in one would dispose the
  // other's live, possibly dirty, buffer as stale (makeModel).
  function uriOf(ed, tab) {
    return M.Uri.from({
      scheme: 'sb',
      authority: 'ws',
      path: '/' + encodeURIComponent(ed.wsId) + '/' + tab.repo + '/' + tab.path,
    });
  }

  function makeModel(ed, tab) {
    if (!M || tab.model || typeof tab.text !== 'string') return;
    var uri = uriOf(ed, tab);
    var stale = M.editor.getModel(uri);
    if (stale) stale.dispose();                      // a closed tab's, never a live one
    // Monaco makes every line end the same way here (the majority's), so a file that
    // mixes them would be rewritten on Save beyond the lines the user touched: save()
    // asks first. Only what is on disk can say so — the model never mixes.
    tab.mixedEol = mixedEol(tab.text);
    tab.eolOk = false;
    tab.model = M.editor.createModel(tab.text, undefined, uri);
    tab.text = null;
    // Dirty is "not the version last read or saved", by the ALTERNATIVE version id:
    // undoing back to the saved text makes the buffer clean again, as in VS Code.
    tab.savedAlt = tab.model.getAlternativeVersionId();
    // The mock-up's brackets are plain. Bracket-pair colouring is a MODEL option in this
    // Monaco: the editor's bracketPairColorization never reaches a model made here.
    tab.model.updateOptions({ bracketColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false } });
    tab.model.onDidChangeContent(function () { edited(ed, tab); });
    fetchBase(ed, tab);
  }

  // More than one kind of line terminator, or any bare CR (which Monaco reads as a line
  // break of its own and writes back as the model's EOL).
  function mixedEol(text) {
    var s = String(text || '');
    if (/\r(?!\n)/.test(s)) return true;
    return /\r\n/.test(s) && /(^|[^\r])\n/.test(s);
  }

  function languageName(model) {
    if (!M || !model) return '';
    if (!names) {
      names = Object.create(null);
      M.languages.getLanguages().forEach(function (l) {
        names[l.id] = (l.aliases && l.aliases[0]) || l.id;
      });
    }
    var id = model.getLanguageId();
    return names[id] || id;
  }

  // ── the persistent root ───────────────────────────────────────────────────

  var FIND = '\u0000find';                           // the Find results pseudo-tab's key

  function fullButton(ed, inBand) {
    return h('button.ib.edfull', {
      type: 'button',
      title: inBand ? 'Exit full screen  esc' : 'Full screen editor',
      'aria-label': inBand ? 'Exit full screen' : 'Full screen editor',
      'aria-pressed': inBand ? 'true' : 'false',
      onClick: function () { toggleFull(ed); },
    }, D.icon(inBand ? 'collapse' : 'expand'));
  }

  function build(wsId) {
    var ed = {
      wsId: wsId,
      id: ++serial,
      monaco: null,
      failed: false,
      tabs: [],
      active: null,               // the tab on screen (FIND for the Find results tab)
      lastFile: null,             // the file tab Esc in the find field goes back to
      recent: [],                 // file keys, most recently opened first (⌘P's empty list)
      repos: null,                // the tree, per repo: {name, root, count, truncated, error}
      index: [],                  // every file, for ⌘P
      byKey: null,                // the same, by file key
      listing: false,
      relist: false,
      treeError: null,
      expanded: Object.create(null),
      decided: false,             // the first-show expansion has been chosen
      rows: [],
      cursor: null,               // the tree's keyboard row, by key
      changes: { sig: null, letters: Object.create(null), dirs: Object.create(null) },
      notice: null,               // what the Editor's own bar is saying, see showBar()
      statting: false,
      refreshTimer: null,
      shown: false,
    };

    ed.bandText = h('span.edbt');
    ed.bell = h('span.edbell', { title: 'a terminal in another workspace rang' });
    ed.band = h('div.edband', null, h('span.edgap'), ed.bandText, ed.bell, h('span.sp'), fullButton(ed, true));

    ed.tree = h('div.edtree', { role: 'tree', tabindex: '0', 'aria-label': 'Files' });
    ed.sash = h('div.edsash', { 'aria-hidden': 'true', title: 'Drag to resize' });

    ed.tabList = h('div.edtl', { role: 'tablist' });
    // The tab list itself is the strip's flexible part (styles.css): a separate spacer
    // beside it was measured to shrink it by a pixel per tab, and it scrolled with room
    // to spare.
    ed.tabsEl = h('div.edtabs', null, ed.tabList, fullButton(ed, false));
    ed.bar = h('div.edbar.hide', { role: 'status' });
    // `monaco-component` is Monaco's own class, borrowed for one reason: the theme's
    // colours are CSS variables declared on `.monaco-editor, .monaco-diff-editor,
    // .monaco-component`, and the right-click menu is a shadow root Monaco hangs off
    // this container — outside the editor's own element, where no variable reaches.
    // Without the class the menu painted with no background at all (measured, 0.57).
    ed.codeHost = h('div.edmonaco.monaco-component');
    ed.ph = h('div.edph');
    ed.host = h('div.edhost.blank', null, ed.codeHost, ed.ph);
    ed.find = buildFind(ed);
    ed.statusL = h('span.edsl');
    ed.statusR = h('span.edsr');
    ed.status = h('div.edstatus', null, ed.statusL, ed.statusR);
    ed.code = h('div.edcode', null, ed.tabsEl, ed.bar, ed.host, ed.find.el, ed.status);
    ed.main = h('div.edmain', null, ed.tree, ed.sash, ed.code);
    ed.pal = buildPalette(ed);
    ed.slab = h('div.ed', null, ed.band, ed.main, ed.pal.el);
    ed.body = h('div.bd.pane.edbd', null, ed.slab);
    // The column the design depends on (fit() would add it, but only on a fresh mount).
    ed.root = h('div.view.edview', {
      style: 'display:flex;flex-direction:column;flex:1;min-width:0;min-height:0',
    }, ed.body);

    wireTree(ed);
    wireSash(ed);
    wireTabs(ed);
    wireDrops(ed);

    eds.set(wsId, ed);
    return ed;
  }

  // A Finder file dropped on the slab must not navigate the window to its file:// URL
  // (Chromium's default, which main's will-navigate then cancels): refused here, in the
  // capture phase, before Monaco's own drop handling would type the file's path into
  // the buffer. Importing files is not something this editor does. A text drag is left
  // to Monaco.
  function wireDrops(ed) {
    function files(e) {
      var types = e.dataTransfer && e.dataTransfer.types;
      return !!types && Array.prototype.indexOf.call(types, 'Files') !== -1;
    }
    ed.slab.addEventListener('dragover', function (e) {
      if (!files(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'none';
    }, true);
    ed.slab.addEventListener('drop', function (e) {
      if (!files(e)) return;
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }

  // Only the header is rebuilt: it is the part of this screen that reads run state,
  // scan results and busy keys. Its buttons are new elements every time, so a focused
  // one is found again by position, the way renderMain's refocus() would have.
  function swapHeader(ed, ws, state) {
    var hd;
    try {
      hd = SB.views.workspace.header(ws, state);
    } catch (err) {
      console.error('[switchboard] editor: header:', err);
      hd = h('div.hd');
    }
    var old = ed.hd;
    var path = null;
    if (old && old.parentNode === ed.root) {
      path = pathTo(old, document.activeElement);
      ed.root.replaceChild(hd, old);
    } else {
      ed.root.insertBefore(hd, ed.root.firstChild);
    }
    ed.hd = hd;
    if (path) {
      var el = hd;
      for (var i = 0; i < path.length && el; i++) el = el.children[path[i]];
      if (el && typeof el.focus === 'function' && el !== hd) {
        try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
      }
    }
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

  // The full-screen band's line: which workspace this is, its branches, and a blue dot
  // when a terminal elsewhere rang — with the rail and the header both hidden, that dot
  // is the only place a bell could still show. render() is already what a bell schedules.
  function paintBand(ed, ws, state) {
    var text = ws.id;
    if (ws.scanned && (ws.repos || []).length && ws.branchSummary) text += ' · ' + ws.branchSummary;
    if (ed.bandText.textContent !== text) ed.bandText.textContent = text;
    var bells = (state && state.bell) || {};
    var rang = false;
    for (var id in bells) {
      if (Object.prototype.hasOwnProperty.call(bells, id) && id !== ed.wsId && bells[id]) { rang = true; break; }
    }
    ed.bell.classList.toggle('on', rang);
  }

  function render(state) {
    var r = (state && state.route) || {};
    var wsId = r.wsId;
    // A Grid folder square (an absolute path) has no workspace screen and no Editor.
    if (!wsId || String(wsId).charAt(0) === '/') {
      return h('div.view', { style: 'display:flex;flex-direction:column;flex:1;min-width:0;min-height:0' },
        h('div.hd'), h('div.bd', null, D.empty('pick one on the left.', { title: 'no workspace selected' })));
    }
    // byId holds the scanned workspace; before the first scan the id is all we know.
    var ws = (state.byId || {})[wsId] || { id: wsId };
    var ed = eds.get(wsId) || build(wsId);
    var attached = ed.root.isConnected;

    swapHeader(ed, ws, state);
    ed.tree.style.width = width + 'px';
    paintBand(ed, ws, state);
    paintChanges(ed, ws);
    paintStatus(ed);

    if (!ed.shown) {
      ed.shown = true;
      loadTree(ed);
      restoreTabs(ed);
      ensureMonaco(ed);
      paintTree(ed);
      showActive(ed);
    }
    // Just (re)attached — the first open, or back from another tab or workspace. The
    // rest waits a task for the root to be in the document; a timer, never rAF, which
    // is starved while the window is hidden or occluded.
    if (!attached) {
      closePalette(ed, false);
      setTimeout(function () { attach(ed); }, 0);
    }
    return ed.root;
  }

  function attach(ed) {
    if (!ed.root.isConnected) return;
    if (ed.monaco) { try { ed.monaco.layout(); } catch (_) { /* measured again by its observer */ } }
    statTabs(ed);
    // HEAD may have moved while another tab was on screen — a commit or a checkout in
    // the in-app Terminal fires no window focus, so refresh() never heard of it — and
    // the change bars must be drawn against the HEAD there is now.
    ed.tabs.forEach(function (tab) { if (tab.model) fetchBase(ed, tab); });
    ensurePoll();
    focusIfShown(ed);
  }

  // Landing on the Editor means typing in it, as landing on the Terminal does. Only
  // when this is the screen on show, and never from inside the slab — taking focus
  // back from the tree or the palette would fight the user. The header is fair game:
  // it is where the click that brought us here happened.
  function focusIfShown(ed) {
    if (!onScreen(ed)) return;
    if (ed.slab.contains(document.activeElement)) return;
    var tab = activeTab(ed);
    // A file still being read, or waiting on Monaco: it takes the keyboard when it
    // lands (showActive), unless the user has gone to the tree or the palette since.
    if (tab && !ed.failed && (tab.kind === 'loading' || (tab.kind === 'text' && !(tab.model && ed.monaco)))) {
      if (!tab.focus) tab.focus = 'soft';
      return;
    }
    focusEditor(ed);
  }

  function focusEditor(ed) {
    var tab = activeTab(ed);
    if (tab && tab.kind === 'find') { ed.find.input.focus(); return; }
    if (tab && tab.model && ed.monaco) { ed.monaco.focus(); return; }
    try { ed.tree.focus({ preventScroll: true }); } catch (e) { ed.tree.focus(); }
  }

  // ── full screen ───────────────────────────────────────────────────────────

  // app.js owns the `.edfull` class on .win (SB.layout, §6 R2) and every rule it
  // switches is CSS. The button that was clicked is display:none the moment the class
  // flips, so focus goes back to where the user was working — a task later, once it has.
  function toggleFull(ed) {
    var L = SB.layout;
    if (!L || typeof L.setFull !== 'function') return;
    var on = typeof L.full === 'function' ? !!L.full() : false;
    L.setFull(!on);
    setTimeout(function () { if (onScreen(ed)) focusEditor(ed); }, 0);
  }

  function isFull() {
    var L = SB.layout;
    return !!L && typeof L.full === 'function' && !!L.full();
  }

  // ── the Editor's own bar ──────────────────────────────────────────────────

  // One line inside the slab, for what only this screen can say: a file changed on
  // disk, a save refused, "save changes?". Never app.js's .bar — that one belongs to
  // the column, and its "never two bars" rule must not see this one. A confirmation
  // outranks a report: a poll must not replace the question the user is answering.
  function showBar(ed, spec) {
    var cur = ed.notice;
    if (cur && cur.rank > (spec.rank || 0) && cur.id !== spec.id) return false;
    ed.notice = spec;
    D.clear(ed.bar);
    ed.bar.className = 'edbar' + (spec.tone ? ' ' + spec.tone : '');
    ed.bar.appendChild(h('span.edbm', null, spec.text));
    ed.bar.appendChild(h('span.sp'));
    var first = null;
    (spec.actions || []).forEach(function (a) {
      var b = h('button.edbtn' + (a.pri ? '.pri' : ''), {
        type: 'button',
        onClick: function () { clearBar(ed, spec.id); a.onClick(); },
      }, a.label);
      if (!first) first = b;
      ed.bar.appendChild(b);
    });
    if (spec.dismiss !== false) {
      ed.bar.appendChild(h('button.edx', {
        type: 'button',
        title: 'Dismiss',
        'aria-label': 'Dismiss',
        onClick: function () { clearBar(ed, spec.id); if (spec.onDismiss) spec.onDismiss(); },
      }, D.icon('close')));
    }
    if (spec.focus && first) first.focus();
    return true;
  }

  function clearBar(ed, id) {
    if (!ed.notice || (id && ed.notice.id !== id)) return;
    var hadFocus = ed.bar.contains(document.activeElement);
    ed.notice = null;
    D.clear(ed.bar);
    ed.bar.className = 'edbar hide';
    if (hadFocus && onScreen(ed)) focusEditor(ed);
  }

  // ── tabs ──────────────────────────────────────────────────────────────────

  function activeTab(ed) {
    return tabOf(ed, ed.active);
  }

  function tabOf(ed, key) {
    for (var i = 0; i < ed.tabs.length; i++) if (ed.tabs[i].key === key) return ed.tabs[i];
    return null;
  }

  function isDirty(tab) {
    return !!tab && !!tab.model && !tab.model.isDisposed() && tab.model.getAlternativeVersionId() !== tab.savedAlt;
  }

  function dirtyCount() {
    var n = 0;
    eds.forEach(function (ed) { ed.tabs.forEach(function (tab) { if (isDirty(tab)) n++; }); });
    return n;
  }

  // main asks before a close or quit loses these (§4.14). beforeunload would not do:
  // Electron shows no dialog for it. Told only when the number moves.
  function reportDirty() {
    var n = dirtyCount();
    if (n === told) return;
    told = n;
    call('codeDirty', n);
  }

  function newTab(repo, path) {
    return {
      key: fileKey(repo, path),
      kind: 'loading',            // loading | text | binary | tooLarge | find
      repo: repo,
      path: path,
      name: baseName(path),
      model: null,
      text: null,                 // read before Monaco was there to take it
      view: null,
      mtimeMs: null,
      size: 0,
      bom: false,
      mixedEol: false,            // the file on disk mixes line endings (see makeModel)
      eolOk: false,               // …and the user said Save anyway to that
      savedAlt: null,
      deleted: false,
      warned: null,               // the disk change the bar has already reported
      base: undefined,            // HEAD's lines; null = not in HEAD; undefined = not asked
      skip: false,
      baseSeq: 0,
      decos: [],
      diffTimer: null,
      saving: false,
      goto: null,
      focus: false,               // true: take the keyboard once shown; 'soft': unless the user is elsewhere in the slab
      closed: false,
      el: null,
    };
  }

  // Opening a file: the same one again just comes forward; a new one reads first and
  // becomes a model when Monaco is there. opts: {line, col, len, focus, quiet}.
  function openFile(ed, repo, path, opts) {
    var o = opts || {};
    var tab = tabOf(ed, fileKey(repo, path));
    if (!tab) {
      tab = newTab(repo, path);
      ed.tabs.push(tab);
      readInto(ed, tab, o);
    }
    if (o.line) tab.goto = { line: o.line, col: o.col || 1, len: o.len || 0 };
    tab.focus = !!o.focus;
    activate(ed, tab.key, { reveal: true });
    return tab;
  }

  function readInto(ed, tab, o) {
    call('codeRead', ed.wsId, tab.repo, tab.path).then(function (r) {
      if (tab.closed) return;
      if (r && r.ok && (r.binary || r.tooLarge || typeof r.text === 'string')) {
        tab.mtimeMs = r.mtimeMs;
        tab.size = r.size || 0;
        if (r.binary) tab.kind = 'binary';
        else if (r.tooLarge) tab.kind = 'tooLarge';
        else {
          tab.kind = 'text';
          tab.bom = !!r.bom;
          tab.text = r.text;
          makeModel(ed, tab);
        }
        if (tab.key === ed.active) showActive(ed);
        else paintTabs(ed);
        return;
      }
      // Gone, a folder (a submodule's gitlink looks like a file to ls-files), or a
      // refusal. A restored tab simply is not restored; one the user asked for says why.
      dropTab(ed, tab);
      if (!o.quiet) {
        showBar(ed, {
          id: 'open', tone: 'warn', rank: 1,
          text: r && r.missing ? tab.name + ' is not there any more' : message(r && r.error),
        });
        if (r && r.missing) loadTree(ed);
      }
    });
  }

  function activate(ed, key, opts) {
    var o = opts || {};
    var cur = activeTab(ed);
    if (cur && cur.model && ed.monaco && ed.monaco.getModel() === cur.model) {
      cur.view = ed.monaco.saveViewState();
    }
    var tab = tabOf(ed, key);
    ed.active = tab ? tab.key : null;
    if (tab && tab.kind !== 'find') {
      ed.lastFile = tab.key;
      ed.recent = [tab.key].concat(ed.recent.filter(function (k) { return k !== tab.key; })).slice(0, RECENT);
      if (o.reveal) revealInTree(ed, tab.repo, tab.path);
    }
    showActive(ed);
    saveTabs(ed);
  }

  // What the host shows for the active tab: the model, or one quiet sentence where it
  // would be. The Find results tab keeps Monaco's model as it was, just out of sight.
  function showActive(ed) {
    var tab = activeTab(ed);
    var finding = !!tab && tab.kind === 'find';
    ed.code.classList.toggle('findon', finding);
    var live = !!tab && tab.kind === 'text' && !!tab.model && !!ed.monaco;
    if (ed.monaco && !finding) {
      if (live && ed.monaco.getModel() !== tab.model) {
        ed.monaco.setModel(tab.model);
        if (tab.view) ed.monaco.restoreViewState(tab.view);
      } else if (!live && ed.monaco.getModel()) {
        ed.monaco.setModel(null);
      }
    }
    if (live && tab.goto) jump(ed, tab);
    ed.host.classList.toggle('blank', !live);
    placeholder(ed, tab);
    paintTabs(ed);
    paintTreeActive(ed);
    paintStatus(ed);
    if (live && tab.focus && onScreen(ed)) {
      var take = tab.focus === true || !ed.slab.contains(document.activeElement);
      tab.focus = false;
      if (take) ed.monaco.focus();
    }
  }

  function placeholder(ed, tab) {
    D.clear(ed.ph);
    if (ed.failed) {
      ed.ph.appendChild(h('div.stack', null,
        h('span', null, 'the editor did not load'),
        h('button.btn.sm', { type: 'button', onClick: retryMonaco }, 'Try again')));
      return;
    }
    var text = '';
    if (!tab) text = 'open a file from the tree, or press ⌘P';
    else if (tab.kind === 'binary') text = 'binary file · ' + size(tab.size) + ' — not shown';
    else if (tab.kind === 'tooLarge') text = 'too large to edit here · ' + size(tab.size) + ' — not shown';
    if (text) ed.ph.appendChild(h('span', null, text));
  }

  function jump(ed, tab) {
    var g = tab.goto;
    tab.goto = null;
    var model = tab.model;
    var line = clamp(g.line || 1, 1, model.getLineCount());
    var col = clamp(g.col || 1, 1, model.getLineMaxColumn(line));
    var end = clamp(col + (g.len || 0), col, model.getLineMaxColumn(line));
    ed.monaco.setSelection(new M.Selection(line, col, line, end));
    ed.monaco.revealLineInCenter(line);
  }

  function dropTab(ed, tab) {
    var i = ed.tabs.indexOf(tab);
    if (i === -1) return;
    ed.tabs.splice(i, 1);
    tab.closed = true;
    if (tab.diffTimer) clearTimeout(tab.diffTimer);
    if (ed.active === tab.key) {
      // Closing Find results goes back to the file it was opened from. Closing a file
      // goes to its neighbour on the right, as a browser does, or on the left at the end
      // — a file either way, while there is one.
      var next = tab.kind === 'find' ? tabOf(ed, ed.lastFile) : null;
      for (var j = i; !next && j < ed.tabs.length; j++) if (ed.tabs[j].kind !== 'find') next = ed.tabs[j];
      for (j = i - 1; !next && j >= 0; j--) if (ed.tabs[j].kind !== 'find') next = ed.tabs[j];
      activate(ed, next ? next.key : (ed.tabs[0] ? ed.tabs[0].key : null));
    } else {
      paintTabs(ed);
      saveTabs(ed);
    }
    if (ed.lastFile === tab.key) ed.lastFile = null;
    if (tab.model) {
      try { tab.model.dispose(); } catch (_) { /* already gone */ }
      tab.model = null;
    }
    if (ed.notice && ed.notice.tab === tab.key) clearBar(ed);
    reportDirty();
  }

  // ⌘W, the ×, a middle click. An unsaved buffer asks first, in the bar, with Save as
  // the button Enter presses — never a dialog, and never silently.
  function closeTab(ed, tab) {
    if (!tab) return false;
    if (tab.kind === 'find') { dropTab(ed, tab); return true; }
    if (!isDirty(tab)) { dropTab(ed, tab); return true; }
    if (ed.active !== tab.key) activate(ed, tab.key);
    showBar(ed, {
      id: 'close', tab: tab.key, rank: 3, focus: true, dismiss: false,
      text: 'save changes to ' + tab.name + '?',
      actions: [
        { label: 'Save', pri: true, onClick: function () {
          save(ed, tab, false, true).then(function (ok) { if (ok) dropTab(ed, tab); });
        } },
        { label: 'Don’t save', onClick: function () { dropTab(ed, tab); } },
        { label: 'Cancel', onClick: function () { if (onScreen(ed)) focusEditor(ed); } },
      ],
    });
    return true;
  }

  // Two tabs called index.ts say which folder each is from; one alone needs nothing.
  function suffixes(ed) {
    var groups = Object.create(null);
    var out = Object.create(null);
    ed.tabs.forEach(function (t) {
      if (t.kind === 'find') return;
      (groups[t.name] = groups[t.name] || []).push(t);
    });
    Object.keys(groups).forEach(function (name) {
      var list = groups[name];
      if (list.length < 2) return;
      var short = list.map(function (t) { return baseName(dirName(t.path)) || t.repo; });
      list.forEach(function (t, i) {
        var clash = short.filter(function (s) { return s === short[i]; }).length > 1;
        out[t.key] = clash ? t.repo + (dirName(t.path) ? '/' + dirName(t.path) : '') : short[i];
      });
    });
    return out;
  }

  function paintTabs(ed) {
    D.clear(ed.tabList);
    var sfx = suffixes(ed);
    var on = null;
    ed.tabs.forEach(function (tab, i) {
      var finding = tab.kind === 'find';
      var cls = 'div.edtab' + (tab.key === ed.active ? '.on' : '') + (isDirty(tab) ? '.dirty' : '') +
        (tab.deleted ? '.gone' : '');
      var el = h(cls, {
        role: 'tab',
        'aria-selected': tab.key === ed.active ? 'true' : 'false',
        title: finding ? 'Find in files' : tab.repo + '/' + tab.path + (tab.deleted ? ' — deleted on disk' : ''),
        dataset: { i: i },
      },
      finding ? D.icon('search') : null,
      h('span.nm', null, finding ? 'Find results' : tab.name),
      sfx[tab.key] ? h('span.sfx', null, '— ' + sfx[tab.key]) : null,
      h('button.edx', {
        type: 'button',
        tabindex: '-1',
        title: 'Close  ⌘W',
        'aria-label': 'Close ' + (finding ? 'Find results' : tab.name),
      }, h('span.dd'), D.icon('close')));
      tab.el = el;
      if (tab.key === ed.active) on = el;
      ed.tabList.appendChild(el);
    });
    if (on) revealX(ed.tabList, on);
  }

  function wireTabs(ed) {
    function tabAt(e) {
      var el = e.target && e.target.closest ? e.target.closest('.edtab') : null;
      return el && ed.tabList.contains(el) ? ed.tabs[Number(el.dataset.i)] || null : null;
    }
    ed.tabList.addEventListener('click', function (e) {
      var tab = tabAt(e);
      if (!tab) return;
      if (e.target.closest('.edx')) {
        closeTab(ed, tab);
        if (!ed.notice || ed.notice.id !== 'close') focusEditor(ed);
        return;
      }
      if (tab.key !== ed.active) activate(ed, tab.key, { reveal: tab.kind !== 'find' });
      focusEditor(ed);
    });
    // A middle click closes, as in every tabbed editor; its mousedown would otherwise
    // start Chromium's autoscroll.
    ed.tabList.addEventListener('mousedown', function (e) { if (e.button === 1) e.preventDefault(); });
    ed.tabList.addEventListener('auxclick', function (e) {
      if (e.button !== 1) return;
      var tab = tabAt(e);
      if (tab) { e.preventDefault(); closeTab(ed, tab); }
    });
    // The strip scrolls sideways under a mouse wheel too; it has no scrollbar of its own.
    ed.tabList.addEventListener('wheel', function (e) {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      ed.tabList.scrollLeft += e.deltaY;
      e.preventDefault();
    }, { passive: false });
  }

  // Once per workspace, the first time its Editor shows: the tabs it had open, read
  // afresh. A file that no longer reads fine is simply not brought back.
  function restoreTabs(ed) {
    var want = null;
    readTabs(ed.wsId).slice(0, SAVED_TABS).forEach(function (s) {
      if (!s || typeof s.repo !== 'string' || typeof s.path !== 'string' || !s.path) return;
      if (tabOf(ed, fileKey(s.repo, s.path))) return;
      var tab = newTab(s.repo, s.path);
      ed.tabs.push(tab);
      if (s.active) want = tab.key;
      readInto(ed, tab, { quiet: true });
    });
    if (!ed.tabs.length) return;
    var tab = tabOf(ed, want) || ed.tabs[0];
    ed.active = tab.key;
    ed.lastFile = tab.key;
    ed.recent = ed.tabs.map(function (t) { return t.key; });
    revealInTree(ed, tab.repo, tab.path);
  }

  // ── editing, saving, dirty ────────────────────────────────────────────────

  function edited(ed, tab) {
    if (tab.el) tab.el.classList.toggle('dirty', isDirty(tab));
    reportDirty();
    if (tab.diffTimer) clearTimeout(tab.diffTimer);
    tab.diffTimer = setTimeout(function () { tab.diffTimer = null; markers(tab); }, DIFF_MS);
  }

  function settled(ed, tab) {
    if (tab.el) tab.el.classList.toggle('dirty', isDirty(tab));
    reportDirty();
  }

  // Save writes this one file, in place, with the text on screen (§0). What was on disk
  // is checked first by main: a file someone else changed since it was read comes back
  // as a conflict, never as a silent overwrite of their change. Resolves true on success
  // — and at once for a clean buffer, which has nothing to write: ⌘S is a key pressed
  // out of habit, and rewriting a file nobody edited is what §0 rules out. A forced
  // save (Overwrite, Save again) and a deleted file's still write.
  function save(ed, tab, force, ask) {
    if (!tab || tab.kind !== 'text' || !tab.model || tab.saving) return Promise.resolve(false);
    if (!force && !tab.deleted && !isDirty(tab)) return Promise.resolve(true);
    if (tab.mixedEol && !tab.eolOk) return askEol(ed, tab, force, ask);
    tab.saving = true;
    // What is saved ends an undo step: without it the typing either side of the save is
    // one step, and the ⌘Z after a save took back text that was saved too (measured).
    tab.model.pushStackElement();
    var alt = tab.model.getAlternativeVersionId();
    var text = tab.model.getValue();
    return call('codeWrite', ed.wsId, tab.repo, tab.path, text, {
      mtimeMs: typeof tab.mtimeMs === 'number' ? tab.mtimeMs : null,
      bom: !!tab.bom,
      force: !!force,
    }).then(function (r) {
      tab.saving = false;
      if (tab.closed) return false;
      if (r && r.ok) {
        tab.mtimeMs = r.mtimeMs;
        tab.savedAlt = alt;        // what was typed WHILE saving stays dirty, as it should
        tab.deleted = false;
        tab.warned = null;
        tab.mixedEol = false;      // every line on disk now ends the model's way
        tab.eolOk = false;
        if (ed.notice && ed.notice.tab === tab.key && ed.notice.id !== 'close') clearBar(ed);
        settled(ed, tab);
        paintTabs(ed);
        markers(tab);
        afterSave(ed);
        return true;
      }
      if (r && r.conflict) {
        if (r.missing) deletedBar(ed, tab);
        else {
          tab.warned = 'changed:' + r.mtimeMs;
          showBar(ed, {
            id: 'conflict', tab: tab.key, tone: 'warn', rank: 2,
            text: tab.name + ' changed on disk since you opened it',
            actions: [
              { label: 'Overwrite', pri: true, onClick: function () { save(ed, tab, true); } },
              { label: 'Reload', onClick: function () { reload(ed, tab); } },
            ],
          });
        }
        return false;
      }
      showBar(ed, { id: 'save', tab: tab.key, tone: 'err', rank: 2, text: message(r && r.error) });
      return false;
    });
  }

  // The first save of a file that mixes line endings says what it will do to them and
  // writes only on Save anyway (§0: nothing but the user's edit). Resolves with that
  // save's answer, or false on Cancel — so the close question's Save still closes after
  // it. Not focused after ⌘S, which is typed mid-sentence — a focused button would take
  // the next Space. Focused when it follows the close question's Save (`focus`): that
  // question had the keyboard, and handing it back to Monaco in between would let the
  // next Enter type a newline that "Save anyway" then writes. The yes lasts until a save lands (then the disk
  // no longer mixes) or the file is read again, so an Overwrite after a conflict does
  // not ask twice.
  function askEol(ed, tab, force, focus) {
    var eol = tab.model.getEOL() === '\r\n' ? 'CRLF' : 'LF';
    return new Promise(function (resolve) {
      var shown = showBar(ed, {
        id: 'eol', tab: tab.key, tone: 'warn', rank: 3, dismiss: false, focus: !!focus,
        text: tab.name + ' mixes line endings — saving makes them all ' + eol,
        onDismiss: function () { resolve(false); },
        actions: [
          { label: 'Save anyway', pri: true, onClick: function () { tab.eolOk = true; resolve(save(ed, tab, force)); } },
          { label: 'Cancel', onClick: function () { resolve(false); } },
        ],
      });
      if (!shown) resolve(false);
    });
  }

  // The header's change count, the tree's letters and the Changes tab all come from the
  // scan, so a save is followed by one — debounced, because ⌘S is a key people hold.
  function afterSave(ed) {
    if (ed.refreshTimer) clearTimeout(ed.refreshTimer);
    ed.refreshTimer = setTimeout(function () {
      ed.refreshTimer = null;
      if (typeof SB.refresh === 'function') SB.refresh(ed.wsId);
      loadTree(ed);
    }, REFRESH_MS);
  }

  // A binary or oversized file has no buffer to save back, so it is offered Close alone.
  // The tab is struck through either way; the bar is remembered as said only once it
  // has actually been shown — a question on screen outranks it (showBar), and the next
  // poll must still get to say it then.
  function deletedBar(ed, tab) {
    tab.deleted = true;
    paintTabs(ed);
    var actions = [{ label: 'Close', onClick: function () { dropTab(ed, tab); } }];
    if (tab.kind === 'text' && tab.model) {
      actions.push({ label: 'Save again', pri: true, onClick: function () { save(ed, tab, true); } });
    }
    var shown = showBar(ed, { id: 'deleted', tab: tab.key, tone: 'warn', rank: 2, text: tab.name + ' was deleted on disk', actions: actions });
    if (shown) tab.warned = 'deleted';
    return shown;
  }

  // ── the disk moving underneath ────────────────────────────────────────────

  // No watcher (§4.14): the open tabs are stat-polled while this screen is on show and
  // the window has focus, and on every focus through refresh(). Cheaper than watching a
  // repo, and blind to the inode swap an atomic save makes.
  function ensurePoll() {
    if (poll) return;
    poll = setInterval(function () {
      var ed = shownEditor();
      if (!ed) { clearInterval(poll); poll = null; return; }
      if (document.hasFocus()) statTabs(ed);
    }, POLL_MS);
  }

  function statTabs(ed) {
    if (ed.statting) return;
    var tabs = ed.tabs.filter(function (t) {
      return (t.kind === 'text' || t.kind === 'binary' || t.kind === 'tooLarge') && typeof t.mtimeMs === 'number';
    }).slice(0, STAT_MAX);
    if (!tabs.length) return;
    ed.statting = true;
    call('codeStat', ed.wsId, tabs.map(function (t) { return { repo: t.repo, path: t.path }; })).then(function (r) {
      ed.statting = false;
      if (!r || !r.ok || !Array.isArray(r.stats)) return;
      tabs.forEach(function (tab, i) {
        var st = r.stats[i];
        // In order, one per file asked; a refused path may come back without its names.
        if (tab.closed || !st || (st.repo !== undefined && (st.repo !== tab.repo || st.path !== tab.path))) return;
        disk(ed, tab, st);
      });
    });
  }

  function disk(ed, tab, st) {
    if (!st.exists) {
      if (tab.deleted && tab.warned === 'deleted') return;
      deletedBar(ed, tab);
      return;
    }
    var moved = typeof st.mtimeMs === 'number' && Math.abs(st.mtimeMs - tab.mtimeMs) > 0.5;
    if (tab.deleted) {
      // Back again — restored by git, or saved by something else.
      tab.deleted = false;
      if (ed.notice && ed.notice.id === 'deleted' && ed.notice.tab === tab.key) clearBar(ed);
      paintTabs(ed);
    }
    if (!moved) return;
    if (tab.kind !== 'text' || !isDirty(tab)) { reload(ed, tab, true); return; }
    var mark = 'changed:' + st.mtimeMs;
    if (tab.warned === mark) return;
    var shown = showBar(ed, {
      id: 'changed', tab: tab.key, tone: 'warn', rank: 2,
      text: tab.name + ' changed on disk',
      actions: [
        { label: 'Reload', onClick: function () { reload(ed, tab); } },
        // Keep mine adopts the new mtime, so the next ⌘S overwrites on purpose rather
        // than bouncing off the conflict check it has just been told about — and stops
        // counting the text read earlier as saved (no alternative version id is -1), so an
        // undo back to it still reads dirty and ⌘S still writes over the disk's version.
        { label: 'Keep mine', pri: true, onClick: function () { tab.mtimeMs = st.mtimeMs; tab.savedAlt = -1; settled(ed, tab); } },
      ],
    });
    if (shown) tab.warned = mark;
  }

  // Re-read and take what is on disk. Into a text buffer that is ONE edit over the part
  // that differs, so the cursor, the scroll and the undo stack all stay where they were.
  // `auto` is disk()'s reload of a buffer that was clean when the stat answered — and
  // may not be by the time the read does: whatever was typed in between is the user's,
  // so it is asked about like any other dirty buffer (disk() again, with the mtime just
  // read and tab.mtimeMs not yet moved, raises "changed on disk") rather than replaced
  // and marked clean. The bar's Reload is the user saying discard mine; it just does.
  function reload(ed, tab, auto) {
    var asked = tab.model && !tab.model.isDisposed() ? tab.model.getAlternativeVersionId() : null;
    call('codeRead', ed.wsId, tab.repo, tab.path).then(function (r) {
      if (tab.closed) return;
      if (!r || !r.ok) {
        if (r && r.missing) deletedBar(ed, tab);
        return;
      }
      if (auto && tab.kind === 'text' && tab.model && !tab.model.isDisposed() &&
        (isDirty(tab) || tab.model.getAlternativeVersionId() !== asked)) {
        disk(ed, tab, { exists: true, mtimeMs: r.mtimeMs });
        return;
      }
      tab.mtimeMs = r.mtimeMs;
      tab.size = r.size || 0;
      tab.warned = null;
      if (ed.notice && ed.notice.tab === tab.key && ed.notice.id !== 'close') clearBar(ed);
      if (r.binary || r.tooLarge || typeof r.text !== 'string') {
        var kind = r.binary ? 'binary' : 'tooLarge';
        if (tab.kind !== kind) {
          if (tab.model) { try { tab.model.dispose(); } catch (_) { /* gone */ } tab.model = null; }
          tab.kind = kind;
          if (tab.key === ed.active) showActive(ed);
          reportDirty();
        }
        return;
      }
      tab.bom = !!r.bom;
      if (tab.kind !== 'text' || !tab.model) {
        tab.kind = 'text';
        tab.text = r.text;
        makeModel(ed, tab);
        if (tab.key === ed.active) showActive(ed);
        return;
      }
      tab.mixedEol = mixedEol(r.text);
      tab.eolOk = false;
      replaceText(tab.model, r.text);
      tab.savedAlt = tab.model.getAlternativeVersionId();
      settled(ed, tab);
      // A file that changed on disk is when HEAD may have moved too: a checkout, a pull,
      // a reset. The bars follow both.
      fetchBase(ed, tab);
    });
  }

  // The disk's text into the model as one undo step of its own — stops either side, so
  // a ⌘Z never takes back the outside change together with the user's typing.
  function replaceText(model, text) {
    // The line ending by Monaco's own rule at createModel — CR and CRLF together against
    // the rest, CRLF only as the majority — not "any CRLF": one stray line must not
    // turn a mostly-LF file into CRLF on the next save. No breaks at all keeps the model's.
    var breaks = text.match(/\r\n|\r|\n/g) || [];
    var crs = 0;
    for (var i = 0; i < breaks.length; i++) if (breaks[i] !== '\n') crs++;
    var want = !breaks.length ? model.getEOL() : (crs > breaks.length / 2 ? '\r\n' : '\n');
    if (want !== model.getEOL() && M) {
      model.setEOL(want === '\r\n' ? M.editor.EndOfLineSequence.CRLF : M.editor.EndOfLineSequence.LF);
    }
    var eol = model.getEOL();
    var next = text.replace(/\r\n|\r|\n/g, eol);
    var old = model.getValue();
    if (old === next) return;
    var max = Math.min(old.length, next.length);
    var pre = 0;
    while (pre < max && old.charCodeAt(pre) === next.charCodeAt(pre)) pre++;
    var suf = 0;
    while (suf < max - pre && old.charCodeAt(old.length - 1 - suf) === next.charCodeAt(next.length - 1 - suf)) suf++;
    // Never split a CRLF or a surrogate pair: back each cut off onto a whole character.
    while (pre > 0 && (old.charAt(pre - 1) === '\r' || isHigh(old.charCodeAt(pre - 1)))) pre--;
    while (suf > 0 && ((old.charAt(old.length - suf) === '\n' && old.charAt(old.length - suf - 1) === '\r') ||
      isLow(old.charCodeAt(old.length - suf)))) suf--;
    var start = model.getPositionAt(pre);
    var end = model.getPositionAt(old.length - suf);
    model.pushStackElement();
    model.pushEditOperations([], [{
      range: new M.Range(start.lineNumber, start.column, end.lineNumber, end.column),
      text: next.slice(pre, next.length - suf),
    }], function () { return null; });
    model.pushStackElement();
  }

  function isHigh(c) { return c >= 0xd800 && c <= 0xdbff; }
  function isLow(c) { return c >= 0xdc00 && c <= 0xdfff; }

  // ── modified-line markers ─────────────────────────────────────────────────

  // HEAD's side of `git diff HEAD`, once per open file and again on refresh(). A
  // rename's old path is what HEAD knows the file by — the scan already has it.
  function fetchBase(ed, tab) {
    if (!tab.model) return;
    var n = ++tab.baseSeq;
    var repo = scanned(ed, tab.repo);
    var oldPath = null;
    ((repo && repo.files) || []).forEach(function (f) {
      if (f && f.path === tab.path && f.oldPath) oldPath = f.oldPath;
    });
    call('codeBase', ed.wsId, tab.repo, tab.path, oldPath).then(function (r) {
      if (tab.closed || n !== tab.baseSeq) return;
      if (!r || !r.ok) { tab.base = undefined; tab.skip = true; }
      else {
        tab.skip = !!r.skip;
        // Split on \r?\n both sides, or every line of a CRLF file reads as modified.
        tab.base = typeof r.text === 'string' ? r.text.split(/\r?\n/) : null;
      }
      markers(tab);
    });
  }

  function markers(tab) {
    if (!M || !tab.model || tab.model.isDisposed()) return;
    var list = [];
    if (!tab.skip && tab.base !== undefined) {
      var lines = tab.model.getLinesContent();
      var hunks = tab.base === null ? [{ start: 0, count: lines.length, kind: 'a' }] : lineDiff(tab.base, lines);
      var last = tab.model.getLineCount();
      hunks.forEach(function (hk) {
        if (hk.kind === 'd') {
          var at = clamp(hk.start + 1, 1, last);
          list.push(deco(at, at, 'edmk edmk-d', '#e5534b'));
        } else if (hk.count > 0) {
          list.push(deco(hk.start + 1, Math.min(last, hk.start + hk.count), hk.kind === 'a' ? 'edmk edmk-a' : 'edmk edmk-m',
            hk.kind === 'a' ? '#2da44e' : '#f0a020'));
        }
      });
    }
    tab.decos = tab.model.deltaDecorations(tab.decos || [], list);
  }

  function deco(from, to, cls, color) {
    return {
      range: new M.Range(from, 1, to, 1),
      options: {
        isWholeLine: true,
        linesDecorationsClassName: cls,
        overviewRuler: { color: color, position: M.editor.OverviewRulerLane.Left },
      },
    };
  }

  // Lines of HEAD against lines on screen → hunks {start, count, kind} in the screen's
  // 0-based lines: kind a(dded), m(odified), d(eleted — count 0, marked on the line
  // after). Common ends are trimmed first; the middle goes to Myers' O(ND) diff, and a
  // middle too big for that is simply called modified — a marker, not a patch.
  function lineDiff(a, b) {
    var n = a.length;
    var m = b.length;
    var pre = 0;
    while (pre < n && pre < m && a[pre] === b[pre]) pre++;
    var suf = 0;
    while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
    var A = a.slice(pre, n - suf);
    var B = b.slice(pre, m - suf);
    if (!A.length && !B.length) return [];
    if (!A.length) return [{ start: pre, count: B.length, kind: 'a' }];
    if (!B.length) return [{ start: pre, count: 0, kind: 'd' }];
    if (A.length > DIFF_SPAN || B.length > DIFF_SPAN) return [{ start: pre, count: B.length, kind: 'm' }];
    var ops = myers(A, B, DIFF_D);
    if (!ops) return [{ start: pre, count: B.length, kind: 'm' }];
    var hunks = [];
    var cur = null;
    ops.forEach(function (op) {
      if (cur && op.x === cur.ax && op.y === cur.by) {
        if (op.ins) { cur.ins++; cur.by++; } else { cur.del++; cur.ax++; }
        return;
      }
      cur = { from: op.y, ins: op.ins ? 1 : 0, del: op.ins ? 0 : 1, ax: op.x + (op.ins ? 0 : 1), by: op.y + (op.ins ? 1 : 0) };
      hunks.push(cur);
    });
    return hunks.map(function (hk) {
      return { start: pre + hk.from, count: hk.ins, kind: !hk.ins ? 'd' : (hk.del ? 'm' : 'a') };
    });
  }

  // Myers 1986. Returns the edit script as [{ins, x, y}] in order — an insertion of B[y]
  // at A's x, or a deletion of A[x] at B's y — or null past maxD edits. V is kept per
  // round (2d+1 entries each) for the walk back, so memory is O(D²), never O(D·(N+M)).
  function myers(A, B, maxD) {
    var N = A.length;
    var M2 = B.length;
    var off = N + M2 + 1;
    var V = new Int32Array(2 * off + 1);
    var trace = [];
    var found = -1;
    for (var d = 0; d <= maxD && found < 0; d++) {
      for (var k = -d; k <= d; k += 2) {
        var x = (k === -d || (k !== d && V[off + k - 1] < V[off + k + 1])) ? V[off + k + 1] : V[off + k - 1] + 1;
        var y = x - k;
        while (x < N && y < M2 && A[x] === B[y]) { x++; y++; }
        V[off + k] = x;
        if (x >= N && y >= M2) { found = d; break; }
      }
      trace.push(V.slice(off - d, off + d + 1));
    }
    if (found < 0) return null;
    var ops = [];
    var cx = N;
    var cy = M2;
    for (var e = found; e > 0; e--) {
      var prev = trace[e - 1];                        // indexed k + (e - 1)
      var ck = cx - cy;
      var down = ck === -e || (ck !== e && prev[ck - 1 + e - 1] < prev[ck + 1 + e - 1]);
      var pk = down ? ck + 1 : ck - 1;
      var px = prev[pk + e - 1];
      var py = px - pk;
      ops.push({ ins: down, x: px, y: py });
      cx = px;
      cy = py;
    }
    ops.reverse();
    return ops;
  }

  // ── the file tree ─────────────────────────────────────────────────────────

  // Every file git would show, per repo (sb:code:tree). The same call serves ⌘P.
  function loadTree(ed) {
    if (ed.listing) { ed.relist = true; return; }
    ed.listing = true;
    call('codeTree', ed.wsId).then(function (r) {
      ed.listing = false;
      if (r && r.ok !== false && Array.isArray(r.repos)) {
        adoptTree(ed, r.repos);
        ed.treeError = null;
      } else if (!ed.repos) {
        ed.treeError = message(r && r.error);
      }
      decide(ed);
      paintTree(ed);
      if (ed.pal.open) paintPalette(ed);
      if (ed.relist) { ed.relist = false; loadTree(ed); }
    });
  }

  function adoptTree(ed, repos) {
    var index = [];
    ed.repos = repos.filter(function (r) { return r && typeof r.name === 'string'; }).map(function (r) {
      var root = { dirs: Object.create(null), files: [], list: null };
      var files = Array.isArray(r.files) ? r.files : [];
      files.forEach(function (p) {
        if (typeof p !== 'string' || !p) return;
        var segs = p.split('/');
        var node = root;
        for (var i = 0; i < segs.length - 1; i++) {
          node = node.dirs[segs[i]] || (node.dirs[segs[i]] = { dirs: Object.create(null), files: [], list: null });
        }
        node.files.push(segs[segs.length - 1]);
        var full = r.name + '/' + p;
        index.push({ repo: r.name, path: p, full: full, low: full.toLowerCase(), at: full.lastIndexOf('/') + 1 });
      });
      return { name: r.name, root: root, count: files.length, truncated: !!r.truncated, error: r.error || null };
    });
    ed.index = index;
    ed.byKey = Object.create(null);
    index.forEach(function (e) { ed.byKey[fileKey(e.repo, e.path)] = e; });
  }

  // Folders first, then files, each in Finder's order (case-insensitive, numeric).
  function children(node) {
    if (node.list) return node.list;
    var dirs = Object.keys(node.dirs).sort(compare).map(function (n) { return { name: n, node: node.dirs[n] }; });
    var files = node.files.slice().sort(compare).map(function (n) { return { name: n, node: null }; });
    node.list = dirs.concat(files);
    return node.list;
  }

  // One repo opens itself; of several, the one with the most changes does and the rest
  // stay shut — the scan decides which, so this waits for it (and is decided once).
  function decide(ed) {
    if (ed.decided || !ed.repos) return;
    if (ed.repos.length === 1) {
      ed.expanded[fileKey(ed.repos[0].name, '')] = true;
      ed.decided = true;
      return;
    }
    var ws = workspace(ed);
    if (!ws || !ws.scanned) return;
    var best = null;
    var most = 0;
    (ws.repos || []).forEach(function (r) {
      var n = (r.files || []).length;
      if (n > most) { most = n; best = r.name; }
    });
    if (best) ed.expanded[fileKey(best, '')] = true;
    ed.decided = true;
  }

  // The git letters come from the scan the app already refreshes on focus and ⌘R —
  // the same Repo.files the Changes tab lists — so the tree runs no git of its own.
  function paintChanges(ed, ws) {
    var repos = ws && ws.scanned && Array.isArray(ws.repos) ? ws.repos : [];
    var parts = [];
    repos.forEach(function (r) {
      var files = (r && r.files) || [];
      parts.push((r && r.name) + ':' + (r && r.branch) + ':' + files.map(function (f) { return f.status + f.path; }).join('/'));
    });
    var sig = (ws && ws.scanned ? '1' : '0') + parts.join('|');
    if (sig === ed.changes.sig) return;
    var letters = Object.create(null);
    var dirs = Object.create(null);
    repos.forEach(function (r) {
      ((r && r.files) || []).forEach(function (f) {
        if (!f || !f.path) return;
        letters[fileKey(r.name, f.path)] = f.status;
        dirs[fileKey(r.name, '')] = true;
        var segs = f.path.split('/');
        for (var i = 1; i < segs.length; i++) dirs[fileKey(r.name, segs.slice(0, i).join('/'))] = true;
      });
    });
    ed.changes = { sig: sig, letters: letters, dirs: dirs };
    decide(ed);
    paintTree(ed);
  }

  var LETTER = { M: 'M', A: 'A', '?': 'A', D: 'D', R: 'R' };

  function rowKey(row) {
    if (row.kind === 'note') return null;             // a sentence, not a place the cursor goes
    return (row.kind === 'file' ? 'f' : 'd') + fileKey(row.repo, row.path);
  }

  function visibleRows(ed) {
    var rows = [];
    function walk(node, repo, dir, depth) {
      var list = children(node);
      var cap = Math.min(list.length, FOLDER_CAP);
      for (var i = 0; i < cap; i++) {
        var c = list[i];
        var p = dir ? dir + '/' + c.name : c.name;
        if (c.node) {
          rows.push({ kind: 'dir', repo: repo, path: p, name: c.name, depth: depth });
          if (ed.expanded[fileKey(repo, p)]) walk(c.node, repo, p, depth + 1);
        } else {
          rows.push({ kind: 'file', repo: repo, path: p, name: c.name, depth: depth });
        }
      }
      if (list.length > cap) {
        rows.push({ kind: 'note', depth: depth, name: (list.length - cap) + ' more — ⌘P to find them' });
      }
    }
    (ed.repos || []).forEach(function (repo) {
      rows.push({ kind: 'dir', repo: repo.name, path: '', name: repo.name, depth: 0, top: true });
      if (!ed.expanded[fileKey(repo.name, '')]) return;
      if (repo.error) rows.push({ kind: 'note', depth: 1, name: repo.error });
      else if (!repo.count) rows.push({ kind: 'note', depth: 1, name: 'no files' });
      else walk(repo.root, repo.name, '', 1);
      if (repo.truncated) rows.push({ kind: 'note', depth: 1, name: 'only the first ' + num(repo.count) + ' files are listed' });
    });
    return rows;
  }

  function paintTree(ed) {
    var keep = ed.tree.scrollTop;
    D.clear(ed.tree);
    ed.tree.appendChild(h('div.edth', { 'aria-hidden': 'true' }, 'Files'));
    ed.rows = [];
    var ws = workspace(ed);
    if (!ed.repos) {
      ed.tree.appendChild(h('div.edrow.note', null, h('span.nm', null, ed.treeError || 'listing files…')));
      if (ed.treeError) {
        ed.tree.appendChild(h('div.edtry', null, h('button.btn.sm', { type: 'button', onClick: function () { ed.treeError = null; paintTree(ed); loadTree(ed); } }, 'Try again')));
      }
      ed.tree.removeAttribute('aria-activedescendant');
      return;
    }
    if (!ed.repos.length) {
      // Gated on the scan, never on the answer alone: before git has run for the
      // header, "not a git repo" would flash on every launch (§6 R4).
      var sentence = ws && ws.scanned ? 'nothing inside ' + ed.wsId + ' is a git repo' : 'scanning…';
      ed.tree.appendChild(h('div.edrow.note', null, h('span.nm', null, sentence)));
      ed.tree.removeAttribute('aria-activedescendant');
      return;
    }
    var rows = visibleRows(ed);
    ed.rows = rows;
    var active = activeTab(ed);
    var activeKey = active && active.kind !== 'find' ? 'f' + active.key : null;
    var keys = rows.map(rowKey);
    if (!ed.cursor || keys.indexOf(ed.cursor) === -1) ed.cursor = activeKey && keys.indexOf(activeKey) !== -1 ? activeKey : keys[0];
    var frag = document.createDocumentFragment();
    rows.forEach(function (row, i) {
      frag.appendChild(rowEl(ed, row, i, keys[i], activeKey));
    });
    ed.tree.appendChild(frag);
    ed.tree.scrollTop = keep;
    cursorTo(ed, ed.cursor, false);
  }

  function rowEl(ed, row, i, key, activeKey) {
    if (row.kind === 'note') {
      return h('div.edrow.note', { style: 'padding-left:' + indent(row.depth) + 'px', dataset: { i: i } },
        h('span.cv'), h('span.nm', null, row.name));
    }
    var dir = row.kind === 'dir';
    var open = dir && !!ed.expanded[fileKey(row.repo, row.path)];
    var mark = null;
    if (dir) {
      if (ed.changes.dirs[fileKey(row.repo, row.path)]) mark = h('span.mk.dot', { title: 'has changes' });
    } else {
      var st = ed.changes.letters[fileKey(row.repo, row.path)];
      if (st) mark = h('span.mk.' + (LETTER[st] || 'M'), null, LETTER[st] || st);
    }
    return h('div.edrow' + (dir ? '.d' : '') + (row.top ? '.top' : '') + (key === activeKey ? '.on' : ''), {
      id: 'ed' + ed.id + 'r' + i,
      role: 'treeitem',
      'aria-level': String(row.depth + 1),
      'aria-expanded': dir ? (open ? 'true' : 'false') : null,
      'aria-selected': key === activeKey ? 'true' : 'false',
      title: row.top ? row.name : row.repo + '/' + row.path,
      style: 'padding-left:' + indent(row.depth) + 'px',
      dataset: { i: i },
    }, h('span.cv', null, dir ? D.icon(open ? 'chevD' : 'chev') : null), h('span.nm', null, row.name), mark);
  }

  function indent(depth) {
    return 14 + 16 * depth;          // the mock-up's steps: a child's chevron under its parent's name
  }

  function paintTreeActive(ed) {
    var active = activeTab(ed);
    var want = active && active.kind !== 'find' ? 'f' + active.key : null;
    var els = ed.tree.querySelectorAll('.edrow[data-i]');
    for (var i = 0; i < els.length; i++) {
      var row = ed.rows[Number(els[i].dataset.i)];
      var on = !!row && row.kind === 'file' && rowKey(row) === want;
      els[i].classList.toggle('on', on);
      if (row && row.kind !== 'note') els[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }

  function cursorTo(ed, key, scroll) {
    ed.cursor = key;
    var cur = ed.tree.querySelector('.edrow.cur');
    if (cur) cur.classList.remove('cur');
    var i = ed.rows.map(rowKey).indexOf(key);
    var el = i === -1 ? null : ed.tree.querySelector('#ed' + ed.id + 'r' + i);
    if (!el) { ed.tree.removeAttribute('aria-activedescendant'); return; }
    el.classList.add('cur');
    ed.tree.setAttribute('aria-activedescendant', el.id);
    if (scroll) reveal(ed.tree, el, 36);             // clear of the sticky "Files" heading
  }

  // Opening a file shows it in the tree: its repo and folders open, its row in view.
  function revealInTree(ed, repo, path) {
    ed.expanded[fileKey(repo, '')] = true;
    var segs = path.split('/');
    for (var i = 1; i < segs.length; i++) ed.expanded[fileKey(repo, segs.slice(0, i).join('/'))] = true;
    ed.cursor = 'f' + fileKey(repo, path);
    if (!ed.repos) return;
    paintTree(ed);
    cursorTo(ed, ed.cursor, true);
  }

  function toggleDir(ed, row, want) {
    var key = fileKey(row.repo, row.path);
    var open = want === undefined ? !ed.expanded[key] : want;
    if (open) ed.expanded[key] = true;
    else delete ed.expanded[key];
    ed.cursor = rowKey(row);
    paintTree(ed);
    cursorTo(ed, ed.cursor, true);
  }

  // One focusable element with a roving row, not a button per row: a repo can hold
  // tens of thousands of files and Tab must not walk through them.
  function wireTree(ed) {
    ed.tree.addEventListener('mousedown', function () { ed.tree.classList.remove('kbd'); });
    ed.tree.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('.edrow[data-i]') : null;
      var row = el ? ed.rows[Number(el.dataset.i)] : null;
      if (!row || row.kind === 'note') return;
      if (row.kind === 'dir') { toggleDir(ed, row); return; }
      ed.cursor = rowKey(row);
      openFile(ed, row.repo, row.path, { focus: true });
    });
    ed.tree.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var keys = ed.rows.map(rowKey);
      var i = keys.indexOf(ed.cursor);
      var row = ed.rows[i];
      var nav = [];
      keys.forEach(function (k, n) { if (k) nav.push(n); });
      var at = nav.indexOf(i);
      var handled = true;
      ed.tree.classList.add('kbd');                  // the ring is for the keyboard only
      function to(p) {
        if (!nav.length) return;
        cursorTo(ed, keys[nav[clamp(p, 0, nav.length - 1)]], true);
      }
      if (e.key === 'ArrowDown') to(at + 1);
      else if (e.key === 'ArrowUp') to(at === -1 ? 0 : at - 1);
      else if (e.key === 'Home') to(0);
      else if (e.key === 'End') to(nav.length - 1);
      else if (e.key === 'ArrowRight') {
        if (row && row.kind === 'dir') {
          if (!ed.expanded[fileKey(row.repo, row.path)]) toggleDir(ed, row, true);
          else if (ed.rows[i + 1] && keys[i + 1] && ed.rows[i + 1].depth > row.depth) to(at + 1);
        }
      } else if (e.key === 'ArrowLeft') {
        if (row && row.kind === 'dir' && ed.expanded[fileKey(row.repo, row.path)]) toggleDir(ed, row, false);
        else if (row) {
          for (var j = i - 1; j >= 0; j--) {
            if (ed.rows[j].kind === 'dir' && ed.rows[j].depth < row.depth) { cursorTo(ed, keys[j], true); break; }
          }
        }
      } else if ((e.key === 'Enter' || e.key === ' ') && row) {
        if (row.kind === 'dir') toggleDir(ed, row);
        // Enter goes to the file, Space only shows it — the tree keeps the keyboard.
        else openFile(ed, row.repo, row.path, { focus: e.key === 'Enter' });
      } else handled = false;
      if (handled) e.preventDefault();
    });
  }

  function wireSash(ed) {
    ed.sash.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      var x0 = e.clientX;
      var w0 = ed.tree.getBoundingClientRect().width;
      try { ed.sash.setPointerCapture(e.pointerId); } catch (_) { /* a synthetic pointer */ }
      ed.slab.classList.add('sizing');
      function move(ev) {
        width = clamp(Math.round(w0 + ev.clientX - x0), TREE_MIN, TREE_MAX);
        ed.tree.style.width = width + 'px';
      }
      // Whichever way the drag ends — released, cancelled, or the capture lost to a
      // window switch mid-drag — the slab must not stay in its col-resize state.
      function up() {
        ed.sash.removeEventListener('pointermove', move);
        ed.sash.removeEventListener('pointerup', up);
        ed.sash.removeEventListener('pointercancel', up);
        ed.sash.removeEventListener('lostpointercapture', up);
        ed.slab.classList.remove('sizing');
        saveWidth();
      }
      ed.sash.addEventListener('pointermove', move);
      ed.sash.addEventListener('pointerup', up);
      ed.sash.addEventListener('pointercancel', up);
      ed.sash.addEventListener('lostpointercapture', up);
    });
    ed.sash.addEventListener('dblclick', function () {
      width = TREE_WIDTH;
      ed.tree.style.width = width + 'px';
      saveWidth();
    });
  }

  // ── the status bar ────────────────────────────────────────────────────────

  function paintStatus(ed) {
    var tab = activeTab(ed);
    var left = [];
    var right = '';
    if (tab && tab.kind === 'find') {
      var res = ed.find.result;
      if (res) {
        left.push(D.plural(totalHits(res), 'match', 'matches'), D.plural(res.files, 'file'));
        if ((ed.repos || []).length > 1) left.push(D.plural(ed.repos.length, 'repo') + ' searched');
      }
      var back = tabOf(ed, ed.lastFile);
      right = '↩ opens the line' + (back ? ' · esc back to ' + back.name : '');
    } else if (tab) {
      if (tab.model && ed.monaco && ed.monaco.getModel() === tab.model) {
        var sel = ed.monaco.getSelection();
        var pos = sel ? sel.getPosition() : { lineNumber: 1, column: 1 };
        var picked = sel && !sel.isEmpty() ? tab.model.getValueInRange(sel).length : 0;
        left.push('Ln ' + pos.lineNumber + ', Col ' + pos.column + (picked ? ' (' + picked + ' selected)' : ''));
        var opt = tab.model.getOptions();
        left.push(opt.insertSpaces ? 'Spaces: ' + opt.indentSize : 'Tab Size: ' + opt.tabSize);
        left.push(languageName(tab.model));
      } else if (tab.kind === 'binary' || tab.kind === 'tooLarge') {
        left.push(size(tab.size));
      }
      var repo = scanned(ed, tab.repo);
      right = tab.repo;
      if (repo) {
        var branch = repo.detached ? String(repo.head || 'HEAD').slice(0, 7) : repo.branch;
        if (branch) right += ' · ⎇ ' + branch;
      }
    }
    var sig = left.join('\u0000') + '\u0001' + right;
    if (ed.statusSig === sig) return;
    ed.statusSig = sig;
    D.clear(ed.statusL);
    left.forEach(function (s) { ed.statusL.appendChild(h('span', null, s)); });
    ed.statusR.textContent = right;
  }

  // ── Go to file (⌘P) ───────────────────────────────────────────────────────

  function kb(s) { return h('span.kb', null, s); }

  // An overlay of the slab's own, mounted once and shown with a class — never through
  // SB.render(), which would rebuild what it floats over (the header, at least).
  function buildPalette(ed) {
    var p = { open: false, items: [], sel: 0 };
    p.input = h('input', {
      type: 'text',
      spellcheck: 'false',
      autocomplete: 'off',
      placeholder: 'Go to file',
      'aria-label': 'Go to file',
      onInput: function () { p.sel = 0; paintPalette(ed); },
      onKeydown: function (e) { paletteKey(ed, e); },
    });
    p.list = h('div.edpl', {
      role: 'listbox',
      // The input keeps focus through a click on a row.
      onMousedown: function (e) { e.preventDefault(); },
      onClick: function (e) {
        var el = e.target && e.target.closest ? e.target.closest('.edpr') : null;
        if (el) pick(ed, Number(el.dataset.i));
      },
    });
    p.count = h('span.r');
    p.el = h('div.edpal.hide', { role: 'dialog', 'aria-label': 'Go to file' },
      h('div.edpin', null, D.icon('search'), p.input),
      p.list,
      h('div.edpft', null,
        h('span', null, kb('↑'), kb('↓'), 'navigate'),
        h('span', null, kb('↩'), 'open'),
        h('span', null, kb('esc'), 'close'),
        p.count));
    return p;
  }

  function openPalette(ed) {
    var p = ed.pal;
    if (!p.open) {
      p.open = true;
      p.input.value = '';
      p.sel = 0;
      p.el.classList.remove('hide');
    }
    paintPalette(ed);
    p.input.focus();
    p.input.select();
    if (!ed.repos && !ed.listing) loadTree(ed);
  }

  function closePalette(ed, refocus) {
    var p = ed.pal;
    if (!p.open) return;
    p.open = false;
    p.el.classList.add('hide');
    if (refocus && onScreen(ed)) focusEditor(ed);
  }

  function paletteKey(ed, e) {
    var p = ed.pal;
    var n = p.items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) { p.sel = (p.sel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n; paintSel(ed); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();                           // ⌘Enter too: it opens, it does not Start
      pick(ed, p.sel);
    } else if (e.key === 'Escape') {
      // Here, not in onKey(): app.js must never see this Esc.
      e.preventDefault();
      e.stopPropagation();
      closePalette(ed, true);
    }
  }

  function pick(ed, i) {
    var p = ed.pal;
    var it = p.items[i];
    if (!it) return;
    var line = p.line;
    closePalette(ed, false);
    openFile(ed, it.repo, it.path, { focus: true, line: line || 0 });
  }

  // `name:42` opens at line 42.
  function parseQuery(raw) {
    var s = String(raw || '').trim();
    var line = 0;
    var m = /^(.*?):(\d+)$/.exec(s);
    if (m) { s = m[1]; line = Number(m[2]) || 0; }
    return { q: s.replace(/\s+/g, '').toLowerCase(), line: line };
  }

  // A name starts after these; an extension's dot counts for little, or `filt` would
  // rather match "fil…" plus the t of ".ts" than the four letters in a row.
  var BOUNDARY = /[\/\-_ ]/;

  // Case-insensitive subsequence over repo/path. Of the ways the letters can line up,
  // the better of a left-to-right and a right-to-left greedy match is kept, scored so
  // consecutive runs, the starts of segments and camelCase humps, and above all the
  // file's own name, win. Shorter paths break ties in the sort.
  function fuzzy(e, q) {
    var s = e.low;
    var j = 0;
    for (var i = 0; i < s.length && j < q.length; i++) if (s.charCodeAt(i) === q.charCodeAt(j)) j++;
    if (j < q.length) return null;
    var fwd = [];
    j = 0;
    for (i = 0; i < s.length && j < q.length; i++) if (s.charCodeAt(i) === q.charCodeAt(j)) { fwd.push(i); j++; }
    var back = [];
    j = q.length - 1;
    for (i = s.length - 1; i >= 0 && j >= 0; i--) if (s.charCodeAt(i) === q.charCodeAt(j)) { back.unshift(i); j--; }
    var a = score(e, fwd, q);
    var b = score(e, back, q);
    return a >= b ? { score: a, at: fwd } : { score: b, at: back };
  }

  function score(e, at, q) {
    var s = e.full;
    var sc = 0;
    for (var k = 0; k < at.length; k++) {
      var p = at[k];
      sc += 1;
      if (k && p === at[k - 1] + 1) sc += 6;
      if (p === 0 || BOUNDARY.test(s.charAt(p - 1))) sc += 8;
      else if (s.charAt(p - 1) === '.') sc += 2;
      else if (s.charAt(p) !== s.charAt(p).toLowerCase() && s.charAt(p - 1) === s.charAt(p - 1).toLowerCase()) sc += 6;
      if (p >= e.at) sc += 4;
      if (p === e.at) sc += 6;
    }
    if (at.length) sc -= (at[at.length - 1] - at[0] - at.length + 1) * 0.5;
    var name = e.low.slice(e.at);
    if (name === q) sc += 40;
    else if (name.indexOf(q) === 0) sc += 20;
    return sc;
  }

  function rank(ed, q) {
    var list = ed.index || [];
    if (!q) {
      // Recently opened first, then everything else in path order.
      var seen = Object.create(null);
      var out = [];
      ed.recent.forEach(function (k) {
        var e = ed.byKey && ed.byKey[k];
        if (e) { out.push({ e: e, at: [] }); seen[k] = true; }
      });
      for (var i = 0; i < list.length && out.length < PALETTE_ROWS; i++) {
        if (!seen[fileKey(list[i].repo, list[i].path)]) out.push({ e: list[i], at: [] });
      }
      return out.slice(0, PALETTE_ROWS);
    }
    // Only the best 50 are ever shown, so they are kept as they are found rather than
    // sorting every hit: with 100 000 files a one-letter query matches nearly all of
    // them, and a full sort per keystroke was most of the time spent (measured).
    var top = [];
    for (var j = 0; j < list.length; j++) {
      var m = fuzzy(list[j], q);
      if (!m) continue;
      var hit = { e: list[j], at: m.at, score: m.score };
      if (top.length === PALETTE_ROWS && order(hit, top[top.length - 1]) >= 0) continue;
      var k = top.length;
      while (k > 0 && order(hit, top[k - 1]) < 0) k--;
      top.splice(k, 0, hit);
      if (top.length > PALETTE_ROWS) top.pop();
    }
    return top;
  }

  function order(a, b) {
    return (b.score - a.score) || (a.e.full.length - b.e.full.length) || compare(a.e.full, b.e.full);
  }

  function paintPalette(ed) {
    var p = ed.pal;
    var parsed = parseQuery(p.input.value);
    p.line = parsed.line;
    var hits = rank(ed, parsed.q);
    var multi = (ed.repos || []).length > 1;
    p.items = hits.map(function (x) { return x.e; });
    if (p.sel >= p.items.length) p.sel = 0;
    D.clear(p.list);
    if (!ed.repos) p.list.appendChild(h('div.edpn', null, ed.treeError || 'listing files…'));
    else if (!hits.length) p.list.appendChild(h('div.edpn', null, 'no file matches'));
    hits.forEach(function (x, i) {
      var e = x.e;
      var name = e.full.slice(e.at);
      var nm = h('span.nm');
      var bold = Object.create(null);
      x.at.forEach(function (pos) { if (pos >= e.at) bold[pos - e.at] = true; });
      var run = '';
      var runBold = false;
      function flush() {
        if (!run) return;
        nm.appendChild(runBold ? h('b', null, run) : D.text(run));
        run = '';
      }
      for (var c = 0; c < name.length; c++) {
        var b = !!bold[c];
        if (b !== runBold) { flush(); runBold = b; }
        run += name.charAt(c);
      }
      flush();
      var dir = dirName(e.path);
      var where = (multi ? e.repo + '/' : '') + (dir ? dir + '/' : '');
      p.list.appendChild(h('div.edpr' + (i === p.sel ? '.on' : ''), {
        role: 'option',
        'aria-selected': i === p.sel ? 'true' : 'false',
        title: e.repo + '/' + e.path,
        dataset: { i: i },
        onMousemove: function () { if (p.sel !== i) { p.sel = i; paintSel(ed); } },
      }, nm, h('span.dr', null, where)));
    });
    var total = (ed.index || []).length;
    p.count.textContent = hits.length + ' of ' + D.plural(total, 'file') +
      (multi ? ' · ' + D.plural(ed.repos.length, 'repo') : '');
    paintSel(ed);
  }

  function paintSel(ed) {
    var p = ed.pal;
    var rows = p.list.querySelectorAll('.edpr');
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('on', i === p.sel);
      rows[i].setAttribute('aria-selected', i === p.sel ? 'true' : 'false');
    }
    if (rows[p.sel]) reveal(p.list, rows[p.sel], 6);
  }

  // A click anywhere but the palette closes it, the way a macOS popover does.
  document.addEventListener('mousedown', function (e) {
    eds.forEach(function (ed) {
      if (ed.pal.open && !ed.pal.el.contains(e.target)) closePalette(ed, false);
    });
  }, true);

  // ── Find in files (⇧⌘F) ───────────────────────────────────────────────────

  function buildFind(ed) {
    var f = { seq: 0, cs: false, re: false, last: null, result: null, cur: -1, timer: null, rows: [] };
    f.input = h('input', {
      type: 'text',
      spellcheck: 'false',
      autocomplete: 'off',
      placeholder: 'Find in files',
      'aria-label': 'Find in files',
      // Main searches with git grep, which reads the files on disk.
      title: 'Searches the files on disk — edits you have not saved are not searched',
      onInput: function () {
        if (f.timer) clearTimeout(f.timer);
        var q = f.input.value;
        if (q.trim().length < 2) return;
        f.timer = setTimeout(function () { f.timer = null; search(ed); }, SEARCH_MS);
      },
      onKeydown: function (e) { findKey(ed, e); },
    });
    function toggle(label, name, key) {
      var b = h('button.edtg', {
        type: 'button',
        title: name,
        'aria-label': name,
        'aria-pressed': 'false',
        onClick: function () {
          f[key] = !f[key];
          b.classList.toggle('on', f[key]);
          b.setAttribute('aria-pressed', f[key] ? 'true' : 'false');
          if (f.input.value.trim()) search(ed);
          f.input.focus();
        },
      }, label);
      return b;
    }
    f.csBtn = toggle('Aa', 'Match case', 'cs');
    f.reBtn = toggle('.*', 'Regular expression', 're');
    f.cnt = h('span.edcnt');
    f.res = h('div.edres', {
      onMousedown: function (e) { if (e.target.closest('.edrl,.edfh')) e.preventDefault(); },
      onClick: function (e) {
        var el = e.target && e.target.closest ? e.target.closest('[data-m]') : null;
        if (el) openMatch(ed, Number(el.dataset.m));
      },
    });
    f.el = h('div.edfind', null,
      h('div.edfrow', null,
        h('label.edfld', null, D.icon('search'), f.input),
        f.csBtn, f.reBtn, f.cnt,
        h('button.edx', {
          type: 'button',
          title: 'Close',
          'aria-label': 'Close find',
          onClick: function () { var t = tabOf(ed, FIND); if (t) dropTab(ed, t); focusEditor(ed); },
        }, D.icon('close'))),
      f.res);
    return f;
  }

  function openFind(ed) {
    var seed = '';
    var cur = activeTab(ed);
    if (cur && cur.model && ed.monaco && ed.monaco.getModel() === cur.model) {
      var sel = ed.monaco.getSelection();
      if (sel && !sel.isEmpty() && sel.startLineNumber === sel.endLineNumber) {
        seed = cur.model.getValueInRange(sel);
        if (seed.length > 200) seed = '';
      }
    }
    if (!tabOf(ed, FIND)) {
      var tab = newTab('', '');
      tab.key = FIND;
      tab.kind = 'find';
      tab.name = 'Find results';
      ed.tabs.push(tab);
    }
    activate(ed, FIND);
    var f = ed.find;
    if (seed) f.input.value = seed;
    f.input.focus();
    f.input.select();
    if (seed) search(ed);
  }

  function findKey(ed, e) {
    var f = ed.find;
    var n = f.rows.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) { f.cur = clamp(f.cur + (e.key === 'ArrowDown' ? 1 : -1), 0, n - 1); paintFindCursor(ed, true); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      var q = f.input.value;
      var same = f.last && f.last.q === q && f.last.cs === f.cs && f.last.re === f.re;
      // Enter searches; Enter again on the same query opens the line under the cursor.
      if (same && f.result && f.rows.length) openMatch(ed, f.rows[Math.max(0, f.cur)]);
      else search(ed);
    }
  }

  function search(ed) {
    var f = ed.find;
    var q = f.input.value;
    if (f.timer) { clearTimeout(f.timer); f.timer = null; }
    if (!q.trim()) return;
    var n = ++f.seq;
    var ask = { q: q, cs: f.cs, re: f.re };
    f.cnt.textContent = 'searching…';
    call('codeSearch', ed.wsId, q, { caseSensitive: f.cs, regex: f.re }).then(function (r) {
      if (n !== f.seq) return;                       // a newer search owns the panel
      f.last = ask;
      if (!r || !r.ok) {
        f.result = null;
        f.rows = [];
        D.clear(f.res);
        f.cnt.textContent = message(r && r.error);
        paintStatus(ed);
        return;
      }
      f.result = { matches: Array.isArray(r.matches) ? r.matches : [], files: r.files || 0, truncated: !!r.truncated, errors: r.errors || [] };
      paintResults(ed);
    });
  }

  // Where a result's matches are in its `text`: main's `ranges` (§4.14), found there in
  // a vm under a deadline. The user's pattern never runs in this window: a JS RegExp
  // over it can backtrack for hours (`(h+)+b` on a line of h's) and nothing here could
  // stop it. So a line main ran out of time on, or a main from before `ranges`, shows
  // unhighlighted. Spans are trusted only as far as they make sense: in order, not
  // overlapping, inside the text.
  function spans(m) {
    var text = String(m.text || '');
    var list = Array.isArray(m.ranges) ? m.ranges : [];
    var out = [];
    var at = 0;
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r || typeof r[0] !== 'number' || typeof r[1] !== 'number') continue;
      var s = Math.floor(r[0]);
      var e = Math.min(Math.floor(r[1]), text.length);
      if (!(s >= at) || !(e > s)) continue;
      out.push([s, e]);
      at = e;
    }
    return out;
  }

  // git answers per LINE; a line can hold the query more than once, and the mock-up's
  // count is of matches, not lines. A line main could not span (it ran out of time, or
  // predates `ranges`) still matched at least once, so it counts as one.
  function hitCount(m) {
    return Math.max(1, spans(m).length);
  }

  function totalHits(res) {
    var n = 0;
    for (var i = 0; i < res.matches.length; i++) n += hitCount(res.matches[i]);
    return n;
  }

  function paintResults(ed) {
    var f = ed.find;
    var res = f.result;
    D.clear(f.res);
    f.rows = [];
    f.cur = res.matches.length ? 0 : -1;
    var n = totalHits(res);
    var line = n ? D.plural(n, 'match', 'matches') + ' in ' + D.plural(res.files, 'file') : 'no matches';
    // The cap is main's, and it counts lines.
    if (res.truncated) line = 'showing the first ' + num(res.matches.length) + ' matching lines';
    if (res.errors.length) line += ' · ' + D.plural(res.errors.length, 'repo') + ' could not be searched';
    f.cnt.textContent = line;
    f.cnt.title = res.errors.map(function (x) { return x.repo + ' — ' + x.error; }).join('\n');
    var frag = document.createDocumentFragment();
    var group = null;
    var count = null;
    res.matches.forEach(function (m, i) {
      var key = fileKey(m.repo, m.path);
      if (key !== group) {
        group = key;
        var dir = dirName(m.path);
        count = h('span.n');
        frag.appendChild(h('div.edfh', { dataset: { m: i }, title: m.repo + '/' + m.path },
          h('span.dir', null, m.repo + '/' + (dir ? dir + '/' : '')),
          h('span.base', null, baseName(m.path)), count));
        count.textContent = '0';
      }
      m.hits = spans(m);
      count.textContent = String(Number(count.textContent) + Math.max(1, m.hits.length));
      var t = h('span.t');
      var text = String(m.text || '');
      if (m.offset > 0) t.appendChild(D.text('…'));
      var at = 0;
      m.hits.forEach(function (hit) {
        if (hit[0] > at) t.appendChild(D.text(text.slice(at, hit[0])));
        t.appendChild(h('span.hl', null, text.slice(hit[0], hit[1])));
        at = hit[1];
      });
      if (at < text.length) t.appendChild(D.text(text.slice(at)));
      frag.appendChild(h('div.edrl', { dataset: { m: i } }, h('span.g', null, String(m.line)), t));
      f.rows.push(i);
    });
    f.res.appendChild(frag);
    f.res.scrollTop = 0;
    paintFindCursor(ed, false);
    paintStatus(ed);
  }

  function paintFindCursor(ed, scroll) {
    var f = ed.find;
    var old = f.res.querySelector('.edrl.cur');
    if (old) old.classList.remove('cur');
    var i = f.rows[f.cur];
    var el = i === undefined ? null : f.res.querySelector('.edrl[data-m="' + i + '"]');
    if (!el) return;
    el.classList.add('cur');
    if (scroll) reveal(f.res, el, 30);
  }

  // A result opens its file with the line in the middle of the screen and the first
  // match on it selected — its span moved from the window main cut to the whole line by
  // `offset`. With no span, the cursor goes to the start of the line.
  function openMatch(ed, i) {
    var f = ed.find;
    var m = f.result && f.result.matches[i];
    if (!m) return;
    var j = f.rows.indexOf(i);
    if (j !== -1) { f.cur = j; paintFindCursor(ed, false); }
    var hit = (m.hits || spans(m))[0];
    openFile(ed, m.repo, m.path, {
      focus: true,
      line: m.line,
      col: hit ? (Number(m.offset) || 0) + hit[0] + 1 : 1,
      len: hit ? hit[1] - hit[0] : 0,
    });
  }

  // ── keyboard ──────────────────────────────────────────────────────────────

  // app.js asks here FIRST in its window keydown listener; true means used (it then
  // preventDefault()s and stops). Only while this workspace's Editor is the screen.
  function onKey(e) {
    var ed = shownEditor();
    if (!ed) return false;
    if (e.key === 'Escape') {
      // Monaco's textarea preventDefault()s EVERY Esc, used or not, and stops the ones a
      // keybinding of its own used (closing the find or suggest widget, cancelling a
      // selection, dropping extra cursors) from propagating at all. So an Esc that
      // reaches the window from that textarea is one Monaco did nothing with, whatever
      // defaultPrevented says — the second Esc, which is the one that leaves full
      // screen. Measured with 0.57 in Electron 44.
      var mine = !!ed.monaco && !!e.target && ed.host.contains(e.target) &&
        !!e.target.classList && e.target.classList.contains('inputarea');
      if (e.defaultPrevented && !mine) return false;
      if (ed.pal.open) { closePalette(ed, true); return true; }
      var tab = activeTab(ed);
      if (tab && tab.kind === 'find' && document.activeElement === ed.find.input) {
        var back = tabOf(ed, ed.lastFile);
        if (back) activate(ed, back.key); else dropTab(ed, tab);
        focusEditor(ed);
        return true;
      }
      if (ed.notice && ed.bar.contains(document.activeElement)) {
        var n = ed.notice;
        clearBar(ed);
        if (n.onDismiss) n.onDismiss();
        return true;
      }
      if (isFull()) { SB.layout.setFull(false); return true; }
      return false;
    }
    if (!e.metaKey || e.ctrlKey || e.altKey) return false;
    var k = String(e.key || '').toLowerCase();
    if (k === 's' && !e.shiftKey) { save(ed, activeTab(ed), false); return true; }
    if (k === 'p' && !e.shiftKey) { openPalette(ed); return true; }
    if (k === 'f' && e.shiftKey) { openFind(ed); return true; }
    return false;
  }

  // ── the Edit menu ─────────────────────────────────────────────────────────

  function owner() {
    var active = document.activeElement;
    var found = null;
    if (active && active !== document.body) {
      eds.forEach(function (ed) { if (!found && ed.root.contains(active)) found = ed; });
    }
    return found;
  }

  // Menu Edit items arrive as sb:evt:edit (§4.7): an accelerator wins over any keydown,
  // so Monaco never sees ⌘C/⌘V/⌘A/⌘X/⌘Z/⇧⌘Z, and its selection is not a DOM selection
  // the document fallback could read. `true` means this Editor consumed the action.
  function editAction(action, text) {
    var ed = owner();
    var active = document.activeElement;
    if (!ed) {
      // ⌘W with nothing focused still means the tab on screen, not the window.
      var shown = shownEditor();
      if (action === 'close' && shown && (!active || active === document.body) && activeTab(shown)) {
        return closeTab(shown, activeTab(shown));
      }
      return false;
    }
    if (action === 'close') {
      if (ed.pal.open) { closePalette(ed, true); return true; }
      var tab = activeTab(ed);
      return tab ? closeTab(ed, tab) : false;
    }
    if (ed.monaco && ed.monaco.hasTextFocus()) return monacoEdit(ed, action, text);
    if (isField(active)) return fieldEdit(active, action, text);
    if (ed.tree.contains(active) && action === 'copy') {
      var row = ed.rows[ed.rows.map(rowKey).indexOf(ed.cursor)];
      if (row && row.kind !== 'note') { toClipboard(row.path ? row.repo + '/' + row.path : row.repo); return true; }
    }
    return false;
  }

  function monacoEdit(ed, action, text) {
    var editor = ed.monaco;
    var model = editor.getModel();
    if (!model) return false;
    if (action === 'undo' || action === 'redo') { editor.trigger('menu', action, null); return true; }
    if (action === 'selectAll') { editor.setSelection(model.getFullModelRange()); return true; }
    if (action === 'paste') {
      var s = typeof text === 'string' ? text : '';
      editor.trigger('keyboard', 'paste', { text: s, pasteOnNewLine: lineCopy !== null && s === lineCopy, multicursorText: null, mode: null });
      return true;
    }
    if (action === 'copy' || action === 'cut') {
      var sels = editor.getSelections() || [];
      var eol = model.getEOL();
      var whole = sels.every(function (sel) { return sel.isEmpty(); });
      var lines = [];
      var copied;
      if (whole) {
        // Nothing selected copies the line(s) the cursors are on, EOL included —
        // Sublime's and VS Code's ⌘C — and a paste of exactly that lands on a new line.
        sels.forEach(function (sel) { if (lines.indexOf(sel.positionLineNumber) === -1) lines.push(sel.positionLineNumber); });
        lines.sort(function (a, b) { return a - b; });
        copied = lines.map(function (n) { return model.getLineContent(n) + eol; }).join('');
        lineCopy = copied;
      } else {
        copied = sels.filter(function (sel) { return !sel.isEmpty(); })
          .map(function (sel) { return model.getValueInRange(sel); }).join(eol);
        lineCopy = null;
      }
      toClipboard(copied);
      if (action === 'cut') {
        // Not trigger('cut'): Monaco's cut goes through the document's clipboard, which
        // is refused outside a user gesture. The text is already with main; delete it.
        // The last line has no EOL of its own, so it takes the one before it — unless
        // the line before is being cut too, whose range already ends there: two ranges
        // over one EOL overlap, and Monaco then refuses the whole edit (its own cut's
        // rule, cursorDeleteOperations). An empty range (a lone empty line) is dropped.
        var last = model.getLineCount();
        var ranges = whole ? lines.map(function (n) {
          if (n < last) return new M.Range(n, 1, n + 1, 1);
          if (n > 1 && lines.indexOf(n - 1) === -1) return new M.Range(n - 1, model.getLineMaxColumn(n - 1), n, model.getLineMaxColumn(n));
          return new M.Range(n, 1, n, model.getLineMaxColumn(n));
        }) : sels.filter(function (sel) { return !sel.isEmpty(); });
        ranges = ranges.filter(function (r) { return !r.isEmpty(); });
        if (!ranges.length) return true;
        editor.pushUndoStop();
        editor.executeEdits('cut', ranges.map(function (r) { return { range: r, text: '' }; }));
        editor.pushUndoStop();
      }
      return true;
    }
    return false;
  }

  // The palette, the find field and Monaco's own find widget: plain text fields. Paste
  // goes in as typing would (undoable, and it fires `input`, which Monaco's find box and
  // our own handlers listen to).
  function fieldEdit(el, action, text) {
    var start = el.selectionStart;
    var end = el.selectionEnd;
    var picked = typeof start === 'number' && typeof end === 'number' ? el.value.slice(start, end) : '';
    try {
      if (action === 'copy') { if (picked) toClipboard(picked); return true; }
      if (action === 'cut') {
        if (picked) { toClipboard(picked); document.execCommand('delete'); }
        return true;
      }
      if (action === 'selectAll') { el.select(); return true; }
      if (action === 'undo' || action === 'redo') { document.execCommand(action); return true; }
      if (action === 'paste') {
        var s = typeof text === 'string' ? text : '';
        if (el.tagName === 'INPUT') s = s.replace(/[\r\n]+/g, ' ');
        if (!document.execCommand('insertText', false, s) && typeof el.setRangeText === 'function') {
          el.setRangeText(s, el.selectionStart, el.selectionEnd, 'end');
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
      }
    } catch (err) {
      console.error('[switchboard] editor: edit:', err);
      return true;
    }
    return false;
  }

  // ── what app.js calls ─────────────────────────────────────────────────────

  // handleFocus, while this screen is up (it inherits the 1200 ms storm guard): list the
  // tree again, check the open files against the disk and HEAD again.
  function refresh() {
    var ed = shownEditor();
    if (!ed) return;
    loadTree(ed);
    statTabs(ed);
    ed.tabs.forEach(function (tab) { if (tab.model) fetchBase(ed, tab); });
    ensurePoll();
  }

  // settle(), once the rail has stopped moving. automaticLayout has usually got there
  // already; this is the final frame's guarantee.
  function relayout() {
    eds.forEach(function (ed) {
      if (!ed.monaco || !ed.root.isConnected) return;
      try { ed.monaco.layout(); } catch (_) { /* measured again by its observer */ }
    });
  }

  SB.views = SB.views || {};
  SB.views.editor = {
    render: render,
    editAction: editAction,
    onKey: onKey,
    refresh: refresh,
    relayout: relayout,
    dirtyCount: dirtyCount,
  };
})(window.SB);
