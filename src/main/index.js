'use strict';

// App lifecycle, the BrowserWindow, and the one place every sb:* IPC handler is
// registered.  ARCHITECTURE §4 (the IPC contract) and §5 (the modules below).
// Handlers are thin: they find the repo directory a request is about and hand
// the work to git.js / github.js / runner.js, then shape the result into the
// exact payload §4 promises.  Nothing here throws across IPC.

const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeTheme, net, protocol, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const config = require('./config.js');
const workspaces = require('./workspaces.js');
const databases = require('./databases.js').createDatabases({
  directory: path.join(path.dirname(config.CONFIG_FILE), 'databases'),
  resolveWorkspace: id => workspaces.lookup(id),
  safeStorage,
});
const git = require('./git.js');
const github = require('./github.js');
const runner = require('./runner.js');
const ports = require('./ports.js');
// `shells`, not `shell`: electron's own `shell` (openExternal, showItemInFolder) is
// already bound above, and §5 M6 is a different thing entirely.
const shells = require('./shell.js');
// What a terminal types for a dropped or pasted file — the paste folder, the escaping,
// and the drag-pasteboard rescue of an unsaved screenshot.
const drops = require('./drops.js');
// Claude usage — the token Claude Code keeps in the keychain, asked every five minutes.
const usage = require('./usage.js');
// The Editor tab's file access (§4.14) — the in-app editor. Not sb:editor, which is
// "open this folder in Visual Studio Code" and predates it.
const editor = require('./editor.js');
// The Notes tab's one markdown file per workspace (§4.15) — outside every repo.
const notes = require('./notes.js');
// The Diagrams tab's files (§4.17) — one per diagram, per workspace, outside every repo —
// and ✦ Answer (§4.18): who answers a box's question, a CLI in the workspace or an API.
const diagrams = require('./diagrams.js');
// Google Images beside a diagram (§4.17): the panel's <webview>, its session, and the
// fetch that turns a picture dragged out of it into bytes saveImage() keeps.
const images = require('./images.js');
const answer = require('./answer.js');
const { Publisher } = require('./publisher.js');
const publisher = new Publisher({
  target: app.isPackaged ? path.resolve(process.execPath, '..', '..', '..')
    : path.join(os.homedir(), 'Desktop', 'Switchboard.app'),
  logFile: path.join(app.getPath('userData'), 'publish.log'),
});
publisher.on('state', state => send('sb:evt:publish', state));

const WINDOW = { width: 1180, height: 760, minWidth: 940, minHeight: 560 };
const MAX_DIFF_LINES = 2000;

let mainWindow = null;
let quitting = false;
// How many files the Editor holds with unsaved edits, as the renderer last said
// (sb:code:dirty). Closing the window or quitting asks first while it is not 0 —
// Electron shows nothing for a renderer's beforeunload, so main has to be the one
// that knows. `discardOk` holds a "Discard Changes" for the rest of that one quit, so
// nothing on the way out — the window's own close event included — asks twice; it is
// cleared wherever a failed quit leaves the app running.
let editorDirty = 0;
let discardOk = false;
// The Notes tab writes itself a moment after typing stops, so nothing has to be asked
// about on the way out — but the last few hundred milliseconds would go with the
// window. flushNotes() tells the renderer to write now and waits for it to say it has,
// which a page's beforeunload cannot do (Electron ignores it).
let noteFlush = null;
let noteFlushId = 0;
// How many notes the renderer holds that it could NOT write (sb:notes:dirty). Normally
// 0 — a note saves itself a moment after typing stops — so the only one that ever gets
// here is a note whose file will not take it: a read-only folder, a full disk, a
// conflict waiting on an answer. It joins editorDirty in the one question the app asks
// on the way out, because the alternative is losing what someone typed in silence.
let noteDirty = 0;
// Set once the renderer has been asked to write its notes for a close that is not a
// quit, so the second pass through 'close' lets the window go.
let noteClose = false;
// How many diagrams hold edits the renderer has not written yet (sb:diagrams:dirty) — 0
// or 1, one being open at a time. Unlike noteDirty this is usually just the editor's
// 700 ms autosave in flight, so it is FLUSHED before anything is asked: a close holds
// for the renderer to write it (the same flush the notes use), and only a diagram that
// still could not be written by then joins the question.
let diagramDirty = 0;

process.on('unhandledRejection', reason => {
  console.error('[switchboard] unhandled rejection:', reason);
});

// ---------------------------------------------------------------------------
// PATH
//
// launchd hands a Dock- or Finder-launched app a bare PATH — /usr/bin:/bin:/usr/sbin:/sbin
// — with no /opt/homebrew/bin and no version-manager shims, so `gh`, `ngrok` and a node
// installed by nvm/volta/asdf/mise all vanish and every Pull request screen says
// "gh is not installed".  A terminal launch (`npm start`) inherits the user's real PATH and
// needs nothing.  So: repair it once, here, before the first handler shells out.  github.js
// builds its env per call (github.js:33) precisely so a repair this late still lands.
// ---------------------------------------------------------------------------

function pathList(value) {
  return String(value || '').split(':').filter(Boolean);
}

function mergePaths(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const dir of list) {
      if (dir && !seen.has(dir)) { seen.add(dir); out.push(dir); }
    }
  }
  return out;
}

// Descending: v24.3.0 before v22.5.1 before v9.x.
function newestFirst(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

// nvm is the one manager with no fixed shim directory — the active node lives in a
// per-version bin.  `alias/default` holds what the user's shell would select ("24",
// "v18.20.8", "lts/iron"); anything unmatchable falls back to the newest installed.
function nvmBin() {
  const root = path.join(os.homedir(), '.nvm', 'versions', 'node');
  let versions;
  try { versions = fs.readdirSync(root).filter(v => /^v\d/.test(v)).sort(newestFirst); } catch (_) { return null; }
  if (!versions.length) return null;
  let want = '';
  try { want = fs.readFileSync(path.join(os.homedir(), '.nvm', 'alias', 'default'), 'utf8').trim(); } catch (_) { want = ''; }
  const bare = want.replace(/^v/, '');
  const pick = (bare && versions.find(v => v === want || v === 'v' + bare || v.startsWith('v' + bare + '.'))) || versions[0];
  return path.join(root, pick, 'bin');
}

// Only the ones actually on this machine — a PATH entry that does not exist just slows
// every exec down.
function toolDirs() {
  const home = os.homedir();
  const candidates = [
    // Version managers first — a real shell ends up this way too, because the nvm/mise/asdf
    // hook in .zshrc prepends itself after .zprofile has already run `brew shellenv`.  Get
    // this backwards and Homebrew's own node shadows the version the user actually selected.
    nvmBin(),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.asdf', 'shims'),
    path.join(home, '.local', 'share', 'mise', 'shims'),
    path.join(home, '.bun', 'bin'),
    path.join(home, 'Library', 'pnpm'),
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin', '/opt/homebrew/sbin',      // Homebrew, Apple silicon
    '/usr/local/bin', '/usr/local/sbin',            // Homebrew, Intel
  ];
  return candidates.filter(dir => {
    if (!dir) return false;
    try { return fs.statSync(dir).isDirectory(); } catch (_) { return false; }
  });
}

/**
 * The PATH the user's own terminal would have, or [] when the shell cannot be asked.
 * `-i` matters as much as `-l`: Homebrew's shellenv usually sits in .zprofile (login) but
 * nvm/mise/asdf put their hook in .zshrc (interactive).  The delimiters fence off anything
 * else a chatty rc file prints.  Synchronous on purpose — nothing may shell out before it.
 */
function loginShellPath() {
  const sh = process.env.SHELL || '/bin/zsh';
  try {
    const out = execFileSync(sh, ['-ilc', 'printf "__SB_PATH__%s__SB_END__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: Object.assign({}, process.env, { TERM: 'dumb' }),
    });
    const m = /__SB_PATH__([\s\S]*?)__SB_END__/.exec(out);
    return m ? pathList(m[1]) : [];
  } catch (_) {
    return [];   // no shell, a hung rc file, a shell that refuses -i — fall back below
  }
}

function repairPath() {
  if (process.platform === 'win32') return;              // ':' is not the separator there
  const current = pathList(process.env.PATH);
  const tools = toolDirs();
  // A terminal launch already has them; asking the shell again would cost 200-400 ms.
  if (tools.length && tools.some(dir => current.includes(dir))) return;

  // The login shell is authoritative when it answers: it is exactly the PATH the user's
  // terminal has, including the node THEY selected.  Prepending our own guesses on top of
  // it could shadow that with a stale Homebrew node, so the static list is the fallback only.
  const shellPath = loginShellPath();
  const repaired = mergePaths(shellPath.length ? shellPath : tools, current);
  if (repaired.join(':') === current.join(':')) return;
  process.env.PATH = repaired.join(':');
  console.log(`[switchboard] PATH repaired from ${shellPath.length ? 'the login shell' : 'the installed tool directories'}: ${process.env.PATH}`);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function stateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (Number.isFinite(b.width) && Number.isFinite(b.height)) {
      return {
        x: Number.isFinite(b.x) ? b.x : undefined,
        y: Number.isFinite(b.y) ? b.y : undefined,
        width: Math.max(b.width, WINDOW.minWidth),
        height: Math.max(b.height, WINDOW.minHeight),
      };
    }
  } catch (_) { /* no saved state yet, or it is unreadable — use the defaults */ }
  return { width: WINDOW.width, height: WINDOW.height };
}

function saveBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    // getNormalBounds, not getBounds: getBounds returns the maximised rect and
    // would restore the app maximised forever.
    fs.writeFileSync(stateFile(), JSON.stringify(mainWindow.getNormalBounds()));
  } catch (err) {
    console.error('[switchboard] could not save window bounds:', err.message);
  }
}

function openExternal(url) {
  if (!/^https?:\/\//i.test(String(url))) return false;
  shell.openExternal(url).catch(err => console.error('[switchboard] openExternal:', err.message));
  return true;
}

/**
 * "You have unsaved changes in N files" — true when the user chose Discard Changes.
 * The one native dialog the app puts up on its own: a bar in the page cannot hold a
 * close or a quit open while it waits for an answer, and a sheet on the window is
 * exactly what every Mac editor shows here. Cancel is the default, so a stray Return
 * loses nothing. A smoke run's window is hidden and nobody could answer, so there it
 * says what it would have asked and lets the close go ahead.
 */
function confirmDiscard() {
  const n = editorDirty + noteDirty + diagramDirty;
  if (process.env.SB_SMOKE) {
    console.log(`SMOKE unsaved: ${n}`);
    return true;
  }
  const opts = {
    type: 'warning',
    buttons: ['Discard Changes', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `You have unsaved changes in ${n} file${n === 1 ? '' : 's'}.`,
    detail: 'They will be lost if you close Switchboard now.',
  };
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  return (win ? dialog.showMessageBoxSync(win, opts) : dialog.showMessageBoxSync(opts)) === 0;
}

function createWindow() {
  const bounds = loadBounds();
  mainWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: WINDOW.minWidth,
    minHeight: WINDOW.minHeight,
    show: false,
    backgroundColor: '#ffffff',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // For the Diagrams tab's Google Images panel, and nothing else: 'will-attach-webview'
      // below refuses every <webview> but that one, and strips what it may not have.
      webviewTag: true,
    },
  });

  // A smoke run never shows its window and never takes the Dock: capturePage() paints
  // through `paintWhenInitiallyHidden` (Electron's default), so the screenshot is
  // identical and nothing flashes up in front of whoever is using the machine. The
  // renderer's timers are why this works at all — views/logs.js and views/terminal.js
  // fit on setTimeout rather than requestAnimationFrame precisely because rAF is
  // starved while a window is not on screen.
  if (!process.env.SB_SMOKE) mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('focus', () => { send('sb:evt:focus'); usage.poke(); });
  mainWindow.on('close', event => {
    saveBounds();
    // Once published, the red close button completes the promised close/reopen
    // workflow too. Otherwise retain normal macOS close-without-quitting behaviour.
    if (publisher.hasPending() && !quitting) {
      event.preventDefault();
      app.quit();
      // app.quit() goes through before-quit, which asks about unsaved Editor files
      // itself; asking here as well would put the same question up twice.
      return;
    }
    // Closing WITHOUT quitting — ⌘W, the red button — is the other way the renderer
    // goes away, and notes are written on a 400 ms debounce: whatever sits inside it
    // would die with the WebContents. So the close is held for one round trip while
    // the renderer writes, and the second pass through here lets it go. Before the
    // question below, so a note that saved fine is not asked about at all.
    if (!quitting && !noteClose && (noteDirty + diagramDirty) > 0) {
      event.preventDefault();
      noteClose = true;
      flushNotes().then(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
      }, () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
      });
      return;
    }
    if (!quitting && !discardOk && (editorDirty + noteDirty + diagramDirty) > 0 && !confirmDiscard()) {
      event.preventDefault();
      noteClose = false;               // a cancelled close must flush again next time
      return;
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    // Nobody is left to read an answer still on its way.
    answer.stopAll();
    editorDirty = 0;                      // the renderer, and every buffer in it, is gone
    noteDirty = 0;
    diagramDirty = 0;
    noteClose = false;
  });
  // Likewise when the page itself goes — a reload from DevTools, a crashed renderer: the
  // buffers are gone and the count main holds would ask about files nobody has any more.
  // The page that comes back starts at 0 and reports again from its first edit.
  mainWindow.webContents.on('did-navigate', () => { editorDirty = 0; diagramDirty = 0; });
  mainWindow.webContents.on('render-process-gone', () => { editorDirty = 0; diagramDirty = 0; });

  // Every http(s) link in the app — the ports on a repo row, Open on GitHub —
  // belongs in the user's browser, never in this window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === mainWindow.webContents.getURL()) return;
    event.preventDefault();
    openExternal(url);
  });

  // The Google Images panel (§4.17) is the one <webview> this page may have: the panel's
  // partition, starting on Google, with no preload, no Node and a sandbox whatever its
  // attributes say — images.js decides. Each guest that does attach gets a browser's
  // right-click menu and keeps its popups in the user's browser.
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!images.hardenWebview(webPreferences, params)) {
      event.preventDefault();
      console.error('[switchboard] refused a <webview> for', String((params && params.src) || '').slice(0, 120));
    }
  });
  mainWindow.webContents.on('did-attach-webview', (_event, guest) => {
    images.attachGuest(guest, {
      openExternal,
      // "Add Image to Diagram": the bundle fetches it (sb:diagrams:fetchImage) and puts it
      // in the middle of the view; guestId says which panel it came from.
      offerImage: offer => send('sb:evt:diagramsImageOffer', offer),
      window: () => mainWindow,
    });
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Dev affordance: SB_SMOKE=<png path> loads the app, waits, saves a screenshot
  // of the real window and quits — so a change can be checked without a human
  // watching the screen. SB_SMOKE_WAIT overrides the settle time (ms).
  if (process.env.SB_SMOKE) {
    if (app.dock && typeof app.dock.hide === 'function') app.dock.hide();
    if (process.env.SB_SMOKE_SIZE) {
      const [w, h] = process.env.SB_SMOKE_SIZE.split('x').map(Number);
      if (w && h) mainWindow.setSize(w, h);
    }
    smokeTest(mainWindow);
  }
}

/**
 * SB_SMOKE_KEYS='[{"keyCode":"Enter","modifiers":["shift"]}]' — real key events, sent
 * between SB_SMOKE_ROUTE and SB_SMOKE_AFTER.
 *
 * Not a nicety: a KeyboardEvent built in the renderer with `new KeyboardEvent(...)` does
 * NOT drive xterm at all (verified — a synthetic `x` never echoes), so the Terminal tab's
 * whole keyboard contract, Shift+Enter included, is untestable from a route script.
 * sendInputEvent goes in at the same place a real key press does, which is the only way
 * to prove ⇧⏎ reaches the pty as ESC CR.
 */
async function smokeKeys(win) {
  if (!process.env.SB_SMOKE_KEYS) return;
  let keys;
  try {
    keys = JSON.parse(process.env.SB_SMOKE_KEYS);
  } catch (err) {
    console.log('SMOKE keys: not JSON —', err.message);
    return;
  }
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    if (!key || !key.keyCode) continue;
    const event = { keyCode: key.keyCode, modifiers: key.modifiers || [] };
    win.focus();
    win.webContents.sendInputEvent(Object.assign({ type: 'keyDown' }, event));
    // A printable key also needs its `char` event, or xterm sees the press and no text.
    // This is not only about printable keys: without it Chromium generates no keypress
    // at all, and a handler that swallows keydown without preventDefault() looks correct
    // when it is not.  Enter is exactly such a key — set char:true to test it honestly.
    if (key.char) win.webContents.sendInputEvent(Object.assign({ type: 'char' }, event));
    win.webContents.sendInputEvent(Object.assign({ type: 'keyUp' }, event));
    await new Promise((r) => setTimeout(r, Number(key.delay || 400)));
  }
}

/**
 * SB_SMOKE_CLICKS='[".hd .dots", {"sel":".seg button","delay":0}]' — real mouse clicks,
 * sent between SB_SMOKE_ROUTE and SB_SMOKE_KEYS. Each selector is resolved in the
 * renderer to its centre and gets mouseMove, mouseDown, mouseUp there.
 *
 * `el.click()` from a route script dispatches a click and nothing else: no mousedown,
 * so no focus change, so none of what a real press does to whatever had focus before.
 * sendInputEvent goes through Chromium's own hit test and focus handling — everything
 * a real click does except the native drag-region test, which stays unverifiable
 * headlessly.
 */
async function smokeClicks(win) {
  if (!process.env.SB_SMOKE_CLICKS) return;
  let clicks;
  try {
    clicks = JSON.parse(process.env.SB_SMOKE_CLICKS);
  } catch (err) {
    console.log('SMOKE clicks: not JSON —', err.message);
    return;
  }
  for (const raw of Array.isArray(clicks) ? clicks : [clicks]) {
    const click = typeof raw === 'string' ? { sel: raw } : raw;
    if (!click || !click.sel) continue;
    const at = await win.webContents.executeJavaScript(
      `(function () { var el = document.querySelector(${JSON.stringify(click.sel)}); if (!el) return null;` +
      ' var b = el.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()'
    );
    if (!at) { console.log('SMOKE clicks: nothing matches', click.sel); continue; }
    win.focus();
    win.webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    console.log('SMOKE clicks:', click.sel, 'at', at.x + ',' + at.y);
    await new Promise((r) => setTimeout(r, Number(click.delay === undefined ? 400 : click.delay)));
  }
}

/**
 * SB_SMOKE_MENU='Edit>Copy' — invoke a menu item's click handler by label path.
 *
 * The companion to smokeKeys: sendInputEvent injects BELOW the native menu bar, so a
 * ⌘C sent that way never reaches a menu accelerator (verified — the item's click never
 * ran).  The accelerator binding itself is declarative and identical in form to the
 * ⌘R item that has always worked here; what needs testing is the click handler behind
 * it, and this is how to reach it.
 */
function smokeMenu() {
  if (!process.env.SB_SMOKE_MENU) return;
  const wanted = process.env.SB_SMOKE_MENU.split('>').map((s) => s.trim());
  let items = (Menu.getApplicationMenu() || { items: [] }).items;
  let found = null;
  for (const label of wanted) {
    found = (items || []).find((i) => i.label === label) || null;
    if (!found) break;
    items = found.submenu ? found.submenu.items : [];
  }
  if (!found || typeof found.click !== 'function') {
    console.log('SMOKE menu: no item at', process.env.SB_SMOKE_MENU);
    return;
  }
  try {
    found.click();
    console.log('SMOKE menu: clicked', process.env.SB_SMOKE_MENU);
  } catch (err) {
    console.log('SMOKE menu: click threw —', err && err.message);
  }
}

function smokeTest(win) {
  const log = [];
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    log.push(`[console:${level}] ${message}  (${source}:${line})`);
  });
  win.webContents.on('preload-error', (_e, file, err) => log.push(`[preload-error] ${file}: ${err}`));
  win.webContents.on('render-process-gone', (_e, d) => log.push(`[render-gone] ${JSON.stringify(d)}`));
  win.webContents.on('did-fail-load', (_e, code, desc) => log.push(`[did-fail-load] ${code} ${desc}`));
  win.webContents.once('did-finish-load', () => {
    const wait = Number(process.env.SB_SMOKE_WAIT || 3500);
    setTimeout(async () => {
      try {
        // Page focus, without showing the window. Without it no focus/blur event
        // fires in the renderer at all, and a whole class of bug — a blur handler
        // that runs while a rebuild tears the old tree down — is invisible here.
        win.webContents.focus();
        if (process.env.SB_SMOKE_ROUTE) {
          await win.webContents.executeJavaScript(process.env.SB_SMOKE_ROUTE);
          await new Promise((r) => setTimeout(r, Number(process.env.SB_SMOKE_ROUTE_WAIT || 1200)));
        }
        await smokeClicks(win);
        await smokeKeys(win);
        smokeMenu();
        if (process.env.SB_SMOKE_AFTER) {
          await win.webContents.executeJavaScript(process.env.SB_SMOKE_AFTER);
          await new Promise((r) => setTimeout(r, Number(process.env.SB_SMOKE_AFTER_WAIT || 1200)));
        }
        const image = await win.webContents.capturePage();
        fs.writeFileSync(process.env.SB_SMOKE, image.toPNG());
        console.log('SMOKE screenshot ->', process.env.SB_SMOKE);
      } catch (err) {
        console.log('SMOKE capture failed:', err.message);
      }
      console.log(log.length ? 'SMOKE console:\n' + log.join('\n') : 'SMOKE console: clean');
      // Publish integration checks must exercise the actual quit-time installer.
      if (process.env.SB_SMOKE_QUIT === '1') { app.quit(); return; }
      // app.exit() does NOT fire 'before-quit', so the quit-time teardown has to be run
      // by hand or a smoke run that pressed Start strands its dev tree — reparented to
      // launchd, still holding its ports.  Not only the no-pty fallback: in pty mode any
      // dev script that ignores SIGHUP survives the same way.  Outside the try/catch on
      // purpose: teardown must run even when the capture failed.  stopEverything() never
      // rejects, and app.exit(0) still guarantees a deterministic exit.  flushNotes()
      // is here for the same reason, and BEFORE the teardown while the window is still
      // live: a smoke that typed into a Notes tab would otherwise lose whatever sat
      // inside the 400 ms save debounce, which is most of what a smoke types.
      await flushNotes();
      await stopEverything();
      app.exit(0);
    }, wait);
  });
}

function targetWebContents() {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  return win && !win.isDestroyed() ? win.webContents : null;
}

function send(channel, ...args) {
  const wc = targetWebContents();
  if (wc) wc.send(channel, ...args);
}

// runner.js and ports.js are written in parallel against §5, which names the IPC
// channel each event lands on but not the emitter's own event name.  Bind both
// spellings — a listener for an event nobody emits costs nothing.
function forward(source, names, channel) {
  const emitter = source && typeof source.on === 'function' ? source : source && source.events;
  if (!emitter || typeof emitter.on !== 'function') return;
  for (const name of names) emitter.on(name, (...args) => send(channel, ...args));
}

forward(runner, ['log', 'sb:evt:log'], 'sb:evt:log');
forward(runner, ['run', 'sb:evt:run'], 'sb:evt:run');
forward(runner, ['links', 'sb:evt:links'], 'sb:evt:links');
forward(ports, ['links', 'sb:evt:links'], 'sb:evt:links');
forward(shells, ['data', 'sb:evt:term'], 'sb:evt:term');
forward(shells, ['state', 'sb:evt:termState'], 'sb:evt:termState');
forward(usage, ['usage', 'sb:evt:usage'], 'sb:evt:usage');
// A publish is a run as far as the Logs tab is concerned (§4.13): the build's
// output and its start/exit arrive on the same channels a dev process uses.
forward(publisher, ['log'], 'sb:evt:log');
forward(publisher, ['run'], 'sb:evt:run');

// ---------------------------------------------------------------------------
// Terminal appearance — §4.8
//
// Two consumers, and they need the answer at different moments. The renderer
// repaints its live panes and rewrites the --term-* tokens the instant this
// changes; shell.js needs it BEFORE it spawns, because a shell's environment is
// fixed at fork and COLORFGBG is how a program inside the pty learns which way
// round the terminal is.
// ---------------------------------------------------------------------------

const APPEARANCES = ['light', 'dark', 'system'];

function storedAppearance() {
  const cfg = config.get() || {};
  const want = cfg.terminal && cfg.terminal.appearance;
  // Light is the default, and deliberately not 'system': the rest of the app is
  // light-only, so following a Mac in Dark Mode would leave one dark slab in an
  // otherwise white window — which is the thing this setting exists to fix.
  return APPEARANCES.indexOf(want) === -1 ? 'light' : want;
}

function effectiveAppearance(choice) {
  if (choice === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  return choice;
}

function appearanceState() {
  const choice = storedAppearance();
  return { appearance: choice, effective: effectiveAppearance(choice) };
}

function applyAppearance() {
  const state = appearanceState();
  shells.setAppearance(state.effective);
  send('sb:evt:appearance', state);
  return state;
}

function setAppearance(choice) {
  if (APPEARANCES.indexOf(choice) === -1) return appearanceState();
  config.save({ terminal: { appearance: choice } });
  const state = applyAppearance();
  // The tick lives in the menu, so the menu is the thing that has to be rebuilt.
  buildMenu();
  return state;
}

// ---------------------------------------------------------------------------
// Sidebar visibility
//
// The renderer is what actually hides the rail — it is a class on .win and CSS
// does the rest. This lives here because the View item has to say "Hide Sidebar"
// or "Show Sidebar", and the menu is main's; persisting it means the window opens
// the way it was left.
// ---------------------------------------------------------------------------

function storedSidebar() {
  const cfg = config.get() || {};
  const want = cfg.sidebar && cfg.sidebar.visible;
  return want !== false;                  // anything but an explicit false is "shown"
}

function setSidebar(visible) {
  const want = !!visible;
  config.save({ sidebar: { visible: want } });
  send('sb:evt:sidebar', { visible: want });
  buildMenu();                            // the item's own label is the state
  return { visible: want };
}

// ---------------------------------------------------------------------------
// Grid views — §4.10
//
// A view is { id, name, cells: [wsId|null x4] }. Main is the store and nothing
// more: the renderer decides what goes where, main makes sure only that shape
// reaches the config file. A cell naming a workspace that no longer exists is
// kept — the renderer shows it as gone and offers to clear it, which is better
// than a view silently losing a square when a folder is renamed. A cell may also
// be an absolute path — a folder square (§4.10) — which is why the cap is a path's
// length and not a folder name's.
// ---------------------------------------------------------------------------

const GRID_CELLS = 4;
const GRID_MAX_VIEWS = 20;
const GRID_CELL_CHARS = 1024;

function cleanViews(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const v of list) {
    if (!v || typeof v !== 'object') continue;
    const id = typeof v.id === 'string' ? v.id.trim().slice(0, 64) : '';
    const name = typeof v.name === 'string' ? v.name.trim().slice(0, 60) : '';
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const cells = [];
    for (let i = 0; i < GRID_CELLS; i++) {
      const c = Array.isArray(v.cells) ? v.cells[i] : null;
      const wsId = typeof c === 'string' ? c.trim().slice(0, GRID_CELL_CHARS) : '';
      cells.push(wsId && cells.indexOf(wsId) === -1 ? wsId : null);
    }
    out.push({ id, name, cells });
    if (out.length >= GRID_MAX_VIEWS) break;
  }
  return out;
}

function storedViews() {
  const cfg = config.get() || {};
  return cleanViews(cfg.grid && cfg.grid.views);
}

// ---------------------------------------------------------------------------
// Pasting an image — ⌘V of a screenshot, the way you paste one into Claude Code.
// ---------------------------------------------------------------------------

// The Paste menu item swallows ⌘V before Claude Code can see it, so Claude never
// gets the chance to read the clipboard image itself the way it does in iTerm2. And
// this Electron's main-process clipboard is the async web API — it has read()/has()
// but no readImage/readBuffer — so an image comes back only as a Blob. So do here
// exactly what dragging the file in does (views/terminal.js droppedText): write the
// image to a file and let the terminal type its path, which is the whole of "put an
// image into Claude Code" — Claude reads it from the path. The folder, the escaping
// and the pruning are drops.js's, shared with the drop route.

// Reads a PNG off the clipboard, if there is one, and returns the escaped path of a
// file holding it — the text a Finder drop of that image would have typed, trailing
// space and all. '' when the clipboard holds no image, so the caller falls back to
// the normal text paste.
async function clipboardImagePaste() {
  let hasImage = false;
  try { hasImage = await clipboard.has('image/png'); } catch (_) { hasImage = false; }
  if (!hasImage) return '';
  let png = null;
  try {
    const items = await clipboard.read();
    const item = (items || []).find(it => it && it.types && it.types.includes('image/png'));
    if (item) {
      const blob = await item.getType('image/png');
      png = Buffer.from(await blob.arrayBuffer());
    }
  } catch (_) { png = null; }
  if (!png || !png.length) return '';
  const file = drops.savePaste(png, `pasted-${Date.now()}.png`);
  return file ? drops.shellEscapePath(file) + ' ' : '';
}

// ---------------------------------------------------------------------------
// Menu — deliberately minimal: the app has one window and its own shortcuts.
// ---------------------------------------------------------------------------

/**
 * The Google Images panel's page, when it has the keyboard: run the native editing command
 * (copy, cut, paste, selectAll, undo, redo) there and answer true; false leaves the item
 * to the renderer. images.focusedGuest() says why focus has to be asked the way it is.
 * Never while the DevTools have it: the page keeps its focused frame behind them, and a
 * ⌘V meant for the Console would land in Google's search box.
 */
function guestEdit(action) {
  const host = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  const guest = host && !host.isDevToolsFocused() ? images.focusedGuest(host) : null;
  if (!guest) return false;
  guest[action]();
  return true;
}

/**
 * Undo / Redo / Cut / Close: send sb:evt:edit and let the renderer decide — the Editor
 * takes them when it has focus (§4.14), anything else falls back to what the role did.
 *
 * DevTools are a second webContents the renderer knows nothing about, so while they have
 * focus the item does to them what the role would have — the native editing command on
 * the DevTools contents, and ⌘W closes the DevTools — or ⌘Z in the Console would undo in
 * the page instead. ⌘W while the key window is not a BrowserWindow at all — the About
 * panel, any native panel — is performClose: to that window, exactly what `role: 'close'`
 * did: send() would otherwise hand it to the main page behind the panel
 * (getFocusedWindow() is null, so `|| mainWindow`), which closed an Editor tab or the whole
 * window and left the panel up. Before the crashed test, since the panel is still the key
 * window then. A smoke run's window is never shown, so never key, and File ▸ Close clicked
 * by SB_SMOKE_MENU goes to it as before. And a crashed renderer cannot answer ⌘W with
 * sb.closeWindow(), so a dead page's window is closed from here; ⌘W is the way out of it.
 *
 * The Diagrams tab's Google Images panel (§4.17) is a third webContents of the same
 * kind: a <webview> guest the renderer cannot reach into. While its page has the keyboard
 * Undo, Redo and Cut — and Copy, Paste and Select All, through guestEdit() — run the
 * native command on it, so ⌘V pastes into Google's search box instead of putting copied
 * boxes on the canvas behind it. ⌘W is not the page's: it keeps the path below.
 */
function editItem(action) {
  const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  if (wc && wc.isDevToolsFocused() && wc.devToolsWebContents) {
    if (action === 'close') wc.closeDevTools();
    else wc.devToolsWebContents[action]();
    return;
  }
  if (action !== 'close' && guestEdit(action)) return;
  if (action === 'close' && !BrowserWindow.getFocusedWindow() && !process.env.SB_SMOKE) {
    if (process.platform === 'darwin') Menu.sendActionToFirstResponder('performClose:');
    return;
  }
  if (action === 'close' && wc && wc.isCrashed()) {
    mainWindow.close();
    return;
  }
  send('sb:evt:edit', { action });
}

function buildMenu() {
  const appearance = storedAppearance();
  const sidebarShown = storedSidebar();
  const template = [];
  // The app menu by hand rather than `role: 'appMenu'`, for the one item that role has no
  // room for: Settings… (⌘,), where ✦ Answer's choices and API keys live (§4.18). A menu
  // item rather than a page shortcut, so it works from every screen and the Mac's own
  // place for it has it. Everything else is the role's own list.
  if (process.platform === 'darwin') {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('sb:evt:openSettings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }
  template.push(
    {
      label: 'File',
      submenu: [
        // Not `role: 'close'` any more: ⌘W closes the Editor's active file tab, the way it
        // does in Sublime and VS Code, and closed the whole window instead when it was the
        // role. Anywhere else the renderer answers with sb.closeWindow(), which is
        // win.close() — the old behaviour, `close` handler (bounds, publish, unsaved) and all.
        { label: 'Close', accelerator: 'CmdOrCtrl+W', click: () => editItem('close') },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // Undo / Redo / Cut cannot be roles once there is an editor, for the reason Copy
        // below cannot: the accelerator wins over the renderer's keydown, so Monaco never
        // sees ⌘Z at all. And the role's native command does not reach Monaco's undo stack
        // either — measured with Monaco 0.57 in this Electron: with EditContext nothing
        // happens, with its hidden textarea it undoes one character of the textarea. So
        // these are items too, and the Editor runs its own undo/redo/cut; outside it the
        // renderer falls back to document.execCommand, which is what the role amounted to.
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => editItem('undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => editItem('redo') },
        { type: 'separator' },
        { label: 'Cut', accelerator: 'CmdOrCtrl+X', click: () => editItem('cut') },
        // Copy / Paste / Select All cannot be roles, for the same reason ⌘R is a menu
        // item below: the accelerator wins over the renderer's keydown.  And xterm's
        // selection is not a DOM selection, so `role: 'copy'` copies nothing at all out
        // of the Terminal tab — nor, since, out of Monaco's.  These send sb:evt:edit
        // instead; the renderer gives the focused terminal first refusal, then the
        // Editor, and otherwise reads the document's own selection and hands it back
        // to sb:clipboard:write.
        // Both directions of the clipboard are main's: Chromium refuses
        // document.execCommand('copy') outside a user gesture, and the renderer would
        // otherwise need clipboard-read permission to paste.
        // The Google Images panel's page takes all three natively while it has the
        // keyboard (guestEdit), as it does Undo, Redo and Cut through editItem().
        {
          label: 'Copy',
          accelerator: 'CmdOrCtrl+C',
          click: () => { if (!guestEdit('copy')) send('sb:evt:edit', { action: 'copy' }); },
        },
        {
          label: 'Paste',
          accelerator: 'CmdOrCtrl+V',
          // readText() is ASYNC in this Electron — clipboard exposes the six-method
          // web API (clear/has/read/readText/write/writeText), not the old synchronous
          // module.  Sending its return value straight through put a Promise in the
          // payload, which cannot be structured-cloned, so webContents.send threw inside
          // the menu callback and Paste silently did nothing at all: Copy and Select All
          // arrived, Paste never did.  Await it, and never send a non-string.
          click: async () => {
            if (guestEdit('paste')) return;
            let text = '';
            try { text = await clipboard.readText(); } catch (_) { text = ''; }
            if (typeof text !== 'string') text = '';
            // No text but an image on the clipboard — a pasted screenshot. Type the
            // path to a file holding it, exactly as dragging that file in would.
            // `image` says so: that path is for a terminal (Claude Code reads the image
            // from it), and typed into a source file or a text field it is junk.
            let image = false;
            if (!text) {
              let img = '';
              try { img = await clipboardImagePaste(); } catch (_) { img = ''; }
              if (img) { text = img; image = true; }
            }
            send('sb:evt:edit', { action: 'paste', text, image });
          },
        },
        {
          label: 'Select All',
          accelerator: 'CmdOrCtrl+A',
          click: () => { if (!guestEdit('selectAll')) send('sb:evt:edit', { action: 'selectAll' }); },
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: sidebarShown ? 'Hide Sidebar' : 'Show Sidebar',
          // macOS's own shortcut for this item, in Finder, Mail, Notes and Xcode.
          accelerator: process.platform === 'darwin' ? 'Control+Command+S' : 'Ctrl+Shift+S',
          // storedSidebar() again rather than the captured value: this click can
          // arrive against a menu that was built before the rail last moved.
          click: () => setSidebar(!storedSidebar()),
        },
        { type: 'separator' },
        // A menu accelerator wins over the renderer's keydown, so ⌘R has to be
        // wired here; sb:evt:focus is the contract's "refresh now" signal.
        { label: 'Refresh', accelerator: 'CmdOrCtrl+R', click: () => send('sb:evt:focus', { fetch: true }) },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        {
          label: 'Terminal appearance',
          // No separator between the three: Electron ends a radio GROUP at one, and a
          // split group means two independent ticks instead of one choice.
          submenu: [
            { label: 'Light', type: 'radio', checked: appearance === 'light', click: () => setAppearance('light') },
            { label: 'Dark', type: 'radio', checked: appearance === 'dark', click: () => setAppearance('dark') },
            { label: 'Match system', type: 'radio', checked: appearance === 'system', click: () => setAppearance('system') },
          ],
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' }
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// IPC helpers
// ---------------------------------------------------------------------------

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
}

async function scan(id) {
  const ws = await workspaces.scan(id, { fetch: false });
  // workspaces.scan reports an unknown id as a value, not a throw.
  if (!ws) throw new Error(`no workspace called ${id}`);
  if (ws.error && !(ws.repos || []).length) throw new Error(ws.error);
  return ws;
}

async function findRepo(id, repoName) {
  const ws = await scan(id);
  const repo = (ws.repos || []).find(r => r && r.name === repoName);
  if (!repo) throw new Error(`${repoName} is not a repo in ${id}`);
  return repo;
}

// §4.3: `patch` is the unified diff BODY — hunk headers and lines, with the
// diff --git / index / --- / +++ preamble dropped — capped at 2000 lines.
function diffBody(raw) {
  const lines = String(raw == null ? '' : raw).split('\n');
  let start = 0;
  while (start < lines.length && lines[start].slice(0, 2) !== '@@') start++;
  if (start >= lines.length) return { text: '', truncated: false };   // binary, or nothing to show
  const body = lines.slice(start);
  if (body.length > MAX_DIFF_LINES) {
    return { text: body.slice(0, MAX_DIFF_LINES).join('\n'), truncated: true };
  }
  return { text: body.join('\n'), truncated: false };
}

function patchOf(result) {
  if (!result) return '';
  if (result.patch != null) return result.patch;
  if (result.diff != null) return result.diff;
  return '';
}

// git.pullMain already writes the sentence the row shows; the reason map is the
// fallback for a result that carries only a machine-readable reason.
function pullMessage(result) {
  if (!result) return { ok: false, message: 'git pull returned nothing' };
  if (result.message) return { ok: result.ok !== false, message: result.message };
  if (result.ok !== false) {
    if (result.alreadyUpToDate) return { ok: true, message: 'Already up to date.' };
    if (result.from && result.to) return { ok: true, message: `Fast-forwarded ${result.from}..${result.to}.` };
    return { ok: true, message: 'Pulled.' };
  }
  const reasons = {
    diverged: 'Skipped — diverged from origin/main, cannot fast-forward.',
    dirty: 'Skipped — uncommitted changes would be overwritten.',
    'wrong-branch': 'Skipped — not on main.',
    detached: 'Skipped — HEAD is detached.',
  };
  return { ok: false, message: reasons[result.reason] || result.error || result.reason || 'Pull failed.' };
}

// github.js does NOT use the `{ ok }` envelope the other §5 modules use: a failure there is
// a plain value carrying the sentence in `error`.  prForBranch answers
// `{ number: null, state: null, error }` — which reads exactly like "no PR" unless `error`
// is tested — and prDetail answers a bare `{ error }`.  Testing `ok` alone would drop every
// sentence §4.4 promises the renderer (`gh is not installed`, `gh is not signed in`).
function ghFailure(value) {
  return !!(value && typeof value === 'object' && (value.ok === false || value.error));
}

// The cheap { number, state } for a row's branch pill. A failure has no usable number, so
// it collapses to null here and the sentence is left to sb:pr:get — §4.4 makes the summary
// a map of `{ number, state } | null` with nowhere to put an error.
function prRef(value) {
  if (ghFailure(value)) return null;
  const pr = value && value.pr ? value.pr : value;
  if (!pr || typeof pr.number !== 'number') return null;
  return { number: pr.number, state: pr.state || (pr.isDraft ? 'DRAFT' : 'OPEN') };
}

// GraphQL reviewThreads are the only source of isResolved; their
// comments.nodes[].databaseId is the same id REST puts on a review comment.
function resolvedIds(threads) {
  const out = new Set();
  const list = Array.isArray(threads) ? threads : (threads && (threads.threads || threads.nodes)) || [];
  for (const thread of list) {
    if (typeof thread === 'number') { out.add(thread); continue; }
    if (!thread || (!thread.isResolved && !thread.resolved)) continue;
    const nodes = (thread.comments && (thread.comments.nodes || thread.comments)) || thread.commentIds || [];
    for (const node of Array.isArray(nodes) ? nodes : []) {
      const id = typeof node === 'number' ? node : (node && (node.databaseId != null ? node.databaseId : node.id));
      if (id != null) out.add(id);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// §4.1 Workspaces
// ---------------------------------------------------------------------------

handle('sb:ws:list', () => workspaces.discover());

// Database browsing (§4.19): secrets and drivers stay in the main process.
handle('sb:db:list', id => databases.list(id));
handle('sb:db:add', (id, connection) => databases.add(id, connection));
handle('sb:db:remove', (id, connectionId) => databases.remove(id, connectionId));
handle('sb:db:entities', (id, connectionId) => databases.entities(id, connectionId));
handle('sb:db:records', (id, connectionId, entityId) => databases.records(id, connectionId, entityId));

handle('sb:publish:state', () => publisher.state());
handle('sb:publish:start', async id => {
  if (quitting) return { ok: false, error: 'Switchboard is closing. Reopen it before publishing.' };
  const ws = (await workspaces.discover()).find(item => item.id === id);
  return publisher.publish(ws);
});

handle('sb:ws:scan', (id, opts) => workspaces.scan(id, { fetch: !!(opts && opts.fetch) }));

handle('sb:ws:pullMain', async (id, repoName) => {
  const ws = await scan(id);
  const repos = (ws.repos || []).filter(r => (repoName ? r.name === repoName : r.onMain));
  if (!repos.length) {
    return {
      ok: false,
      error: repoName ? `${repoName} is not a repo in ${id}` : `nothing in ${id} is sitting on main`,
      results: [],
    };
  }
  const results = await Promise.all(repos.map(async repo => {
    try {
      const outcome = pullMessage(await git.pullMain(repo.dir));
      return { repo: repo.name, ok: outcome.ok, message: outcome.message };
    } catch (err) {
      return { repo: repo.name, ok: false, message: String((err && err.message) || err) };
    }
  }));
  return { ok: results.every(r => r.ok), results };
});

// ---------------------------------------------------------------------------
// §4.2 Running
// ---------------------------------------------------------------------------

handle('sb:run:start', async id => {
  const result = await runner.start(id);
  return result == null ? { ok: true } : result;
});

handle('sb:run:stop', async id => {
  const result = await runner.stop(id);
  return result == null ? { ok: true } : result;
});

// The self workspace never has a runner session — its button is Publish, not
// Start — so its last publish takes the slot, and a reloaded renderer adopts it
// like any other run.
handle('sb:run:states', () => {
  const states = runner.states();
  const published = publisher.runState();
  if (published && !states[published.wsId]) states[published.wsId] = published;
  return states;
});

// runner.logs also reports which process the text came from, and the other
// processes in a multi-process workspace, so the Logs tab can offer a picker.
handle('sb:run:logs', async (id, procName) => {
  // A workspace the runner has never started may still have published.
  const result = (!runner.state(id) && publisher.logs(id)) || await runner.logs(id, procName);
  if (typeof result === 'string') return { text: result };
  return result && typeof result.text === 'string' ? result : { text: '' };
});

handle('sb:run:input', async (id, data, procName) => {
  const result = await runner.write(id, data, procName);
  return result == null ? { ok: true } : result;
});

// The terminal tells the pty how wide it actually is, so vite and expo wrap their
// output to the window instead of to a fixed 120 columns.
handle('sb:run:resize', async (id, cols, rows, procName) => {
  const result = await runner.resize(id, cols, rows, procName);
  return result == null ? { ok: true } : result;
});

// ---------------------------------------------------------------------------
// §4.6 Terminal
//
// The user's own login shell, not a dev process — sits next to §4.2 because it is
// the other thing this app spawns, but `Stop` never touches it and it outlives
// every navigation.  shell.js owns the pty; these handlers only shape its answers
// into the payloads §4.6 promises.
// ---------------------------------------------------------------------------

handle('sb:term:open', async (id, cols, rows) => {
  const result = await shells.open(id, { cols, rows });
  return result == null ? { ok: true } : result;
});

handle('sb:term:input', async (id, data) => {
  const result = await shells.write(id, data);
  return result == null ? { ok: true } : result;
});

handle('sb:term:resize', async (id, cols, rows) => {
  const result = await shells.resize(id, cols, rows);
  return result == null ? { ok: true } : result;
});

// Replayed straight into a fresh xterm, so `text` is a string however the call went:
// a workspace whose shell was never opened has nothing to replay, which is not an
// error, and the renderer should not need a guard to find that out.
handle('sb:term:buffer', async id => {
  const result = await shells.buffer(id);
  if (typeof result === 'string') return { ok: true, text: result };
  const text = result && typeof result.text === 'string' ? result.text : '';
  return Object.assign({ ok: true }, result, { text });
});

handle('sb:term:close', async id => {
  const result = await shells.close(id);
  return result == null ? { ok: true } : result;
});

handle('sb:term:states', () => shells.states());

// A drag has entered a terminal pane: main snapshots the macOS drag pasteboard now,
// while the drag is live — drops.js says why. Answered when the read is done; the
// renderer does not wait for it, the drop does.
handle('sb:term:drag', async () => { await drops.dragBegan(); return { ok: true }; });

// A drop's Files, answered as the text the terminal types — drops.js.
handle('sb:term:drop', async entries => ({ ok: true, text: await drops.droppedFiles(entries) }));

// Asked once at boot, because a window that has just loaded is painted in the
// stylesheet's default and has no other way to learn better; sb:evt:appearance
// carries every change after that.
handle('sb:term:appearance', () => appearanceState());
handle('sb:term:setAppearance', choice => setAppearance(String(choice)));

handle('sb:ui:sidebar', () => ({ visible: storedSidebar() }));
handle('sb:ui:setSidebar', visible => setSidebar(visible));

handle('sb:grid:list', () => ({ views: storedViews() }));
handle('sb:grid:save', views => {
  config.save({ grid: { views: cleanViews(views) } });
  return { views: storedViews() };
});

// §4.10: a folder for a Grid square — any folder on this Mac, through the system's
// own chooser, as a sheet on the window. Answers { ok:true, dir } or
// { ok:false, canceled:true }, which is not an error: the renderer leaves its picker
// up. A smoke run has nobody to click a sheet, so SB_SMOKE_FOLDER stands in for the
// choice there and SB_SMOKE without it is a cancel.
handle('sb:dialog:folder', async () => {
  if (process.env.SB_SMOKE) {
    const picked = process.env.SB_SMOKE_FOLDER || '';
    return picked ? { ok: true, dir: path.resolve(picked) } : { ok: false, canceled: true };
  }
  const cfg = config.get() || {};
  const opts = {
    message: 'Choose a folder to open a terminal in',
    buttonLabel: 'Open terminal',
    defaultPath: cfg.root || os.homedir(),
    properties: ['openDirectory', 'createDirectory'],
  };
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const result = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  const dir = result && !result.canceled && Array.isArray(result.filePaths) ? result.filePaths[0] : '';
  if (!dir) return { ok: false, canceled: true };
  let isDir = false;
  try { isDir = fs.statSync(dir).isDirectory(); } catch (_) { isDir = false; }
  if (!isDir) return { ok: false, error: 'that is not a folder: ' + dir };
  return { ok: true, dir: path.resolve(dir) };
});

// §4.11 Claude usage.  usage.js never rejects: a missing sign-in or an unreachable
// endpoint is an `{ ok:false, error }` Usage, and the renderer shows the sentence.
// The token it reads is never in either answer.
handle('sb:usage:get', () => usage.get());
handle('sb:usage:refresh', () => usage.refresh(true));

// ---------------------------------------------------------------------------
// §4.3 Diffs
// ---------------------------------------------------------------------------

handle('sb:diff:file', async (id, repoName, filePath) => {
  const repo = await findRepo(id, repoName);
  const change = (repo.files || []).find(f => f && f.path === filePath) || null;
  const result = await git.fileDiff(repo.dir, filePath, {
    untracked: !!change && change.status === '?',
    // A rename needs BOTH paths or git renders the whole file as a new addition.
    oldPath: change ? change.oldPath || null : null,
  });
  if (result && result.ok === false) return result;
  const body = diffBody(patchOf(result));
  return {
    ok: true,
    patch: body.text,
    binary: !!(result && result.binary),
    truncated: body.truncated || !!(result && result.truncated),
  };
});

handle('sb:diff:all', async (id, repoName) => {
  const ws = await scan(id);
  const repos = (ws.repos || []).filter(r => !repoName || r.name === repoName);
  if (repoName && !repos.length) throw new Error(`${repoName} is not a repo in ${id}`);

  const files = [];
  const errors = [];
  for (const repo of repos) {
    let result;
    try {
      result = await git.allDiffs(repo.dir, { exclude: repo.nested });
    } catch (err) {
      errors.push({ repo: repo.name, error: String((err && err.message) || err) });
      continue;
    }
    if (result && result.ok === false) {
      errors.push({ repo: repo.name, error: result.error || 'could not read the diff' });
      continue;
    }
    const list = Array.isArray(result) ? result : (result && result.files) || [];
    for (const file of list) {
      if (!file) continue;
      const body = diffBody(patchOf(file));
      files.push({
        repo: repo.name,
        path: file.path,
        add: file.add || 0,
        del: file.del || 0,
        patch: body.text,
        binary: !!file.binary,
        truncated: body.truncated || !!file.truncated,
      });
    }
  }
  return { ok: true, files, errors };
});

// ---------------------------------------------------------------------------
// §4.14 Editor
//
// The Editor tab's file access. editor.js resolves (id, repoName, path) itself, through
// the path guard, and never through findRepo(): a scan is several git commands per repo,
// and sb:code:stat runs every few seconds while the Editor is on screen. These handlers
// pass the arguments through untouched — editor.js checks every one of them.
// ---------------------------------------------------------------------------

handle('sb:code:tree', id => editor.tree(id));
handle('sb:code:read', (id, repoName, filePath) => editor.read(id, repoName, filePath));
handle('sb:code:write', (id, repoName, filePath, text, opts) => editor.write(id, repoName, filePath, text, opts));
handle('sb:code:base', (id, repoName, filePath, oldPath) => editor.base(id, repoName, filePath, oldPath));
handle('sb:code:stat', (id, files) => editor.stat(id, files));
handle('sb:code:search', (id, query, opts) => editor.search(id, query, opts));

// The renderer says how many open files have unsaved edits whenever that number changes;
// the window's `close` and the app's `before-quit` ask before they throw those away.
handle('sb:code:dirty', count => {
  const n = Number(count);
  const next = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  // A quit still waiting (a publish build, dev servers stopping) keeps the window usable.
  // "Discard Changes" was about the files unsaved THEN; a new one since must be asked
  // about again, which the re-check after stopEverything() does once this is cleared.
  if (quitting && next > editorDirty) discardOk = false;
  editorDirty = next;
  return { ok: true };
});

// The Editor tree's three writes (§4.16). Delete goes to the TRASH — shell.trashItem,
// passed in rather than required by editor.js, which never loads Electron so its tests
// can run under plain node. A file the Trash refuses falls back to an unlink; a FOLDER
// never does, because a recursive delete nobody can undo is not something to do behind
// a failure. All three re-list the tree in the renderer; none of them runs git.
handle('sb:code:create', (id, repoName, filePath, opts) => editor.create(id, repoName, filePath, opts));
handle('sb:code:rename', (id, repoName, from, to) => editor.rename(id, repoName, from, to));
handle('sb:code:delete', (id, repoName, filePath) =>
  editor.remove(id, repoName, filePath, { trash: target => shell.trashItem(target) }));

// ---------------------------------------------------------------------------
// §4.15 Notes
//
// One markdown scratch pad per workspace, in <config dir>/notes/. notes.js resolves the
// id to a file itself — a workspace id or a Grid square's folder path, always hashed —
// so these handlers pass their arguments through untouched.
// ---------------------------------------------------------------------------

handle('sb:notes:read', id => notes.read(id));
handle('sb:notes:write', (id, text, opts) => notes.write(id, text, opts));
handle('sb:notes:reveal', async id => {
  const file = notes.fileFor(id);
  if (!file) return { ok: false, error: `no workspace called ${id}` };
  // showItemInFolder on a file that is not there opens nothing at all; the folder is
  // the honest answer for a note that has never been written.
  try {
    await fs.promises.stat(file);
    shell.showItemInFolder(file);
  } catch (_) {
    await fs.promises.mkdir(notes.notesDir(), { recursive: true }).catch(() => {});
    shell.openPath(notes.notesDir());
  }
  return { ok: true };
});

// How many notes the renderer could not write, whenever that number moves. Read by
// confirmDiscard() alongside editorDirty; the Notes tab's own bar says the same thing
// in the page, and this is only so the way OUT of the app cannot lose it in silence.
handle('sb:notes:dirty', count => {
  const n = Number(count);
  const next = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (quitting && next > noteDirty) discardOk = false;
  noteDirty = next;
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Diagrams (§4.17)
// The Diagrams tab's flow diagrams, in <config dir>/diagrams/<workspace>/. diagrams.js
// hashes the workspace id into its folder name, as notes.js does, so these pass their
// arguments through; the bundle has validated a spec before it asks for a write.
// ---------------------------------------------------------------------------

handle('sb:diagrams:list', id => diagrams.list(id));
handle('sb:diagrams:get', (id, diagramId) => diagrams.get(id, diagramId));
handle('sb:diagrams:create', (id, name, spec) => diagrams.create(id, name, spec));
handle('sb:diagrams:update', (id, diagramId, name, spec) => diagrams.update(id, diagramId, name, spec));
handle('sb:diagrams:archive', (id, diagramId, archived) => diagrams.setArchived(id, diagramId, archived));
handle('sb:diagrams:delete', (id, diagramId) => diagrams.remove(id, diagramId));
handle('sb:diagrams:saveImage', (bytes, type) => diagrams.saveImage(bytes, type));

// The clipboard's picture, for Edit ▸ Paste over a canvas. The same read as
// clipboardImagePaste() below, handing back the bytes rather than a file path.
handle('sb:diagrams:clipboardImage', async () => {
  let hasImage = false;
  try { hasImage = await clipboard.has('image/png'); } catch (_) { hasImage = false; }
  if (!hasImage) return { ok: false, error: 'there is no picture on the clipboard' };
  try {
    const items = await clipboard.read();
    const item = (items || []).find(it => it && it.types && it.types.includes('image/png'));
    if (!item) return { ok: false, error: 'there is no picture on the clipboard' };
    const blob = await item.getType('image/png');
    return { ok: true, bytes: new Uint8Array(await blob.arrayBuffer()), type: 'image/png' };
  } catch (err) {
    return { ok: false, error: 'could not read the clipboard: ' + err.message };
  }
});

// A picture from the Google Images panel, by its address — a drag out of a <webview>
// carries no File, and "Add Image to Diagram" only the image's URL. Fetched through the
// panel's session and answered as { ok, bytes, type, name } in a type saveImage() keeps,
// which the bundle then saves like a dropped file. images.js says what it accepts.
handle('sb:diagrams:fetchImage', (url, referrer) => images.fetchImage(url, referrer));

// 0 or 1 — see `diagramDirty`. Like sb:notes:dirty, a count that rises during a quit
// takes back a Discard given for the smaller one.
handle('sb:diagrams:dirty', count => {
  const n = Number(count);
  const next = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (quitting && next > diagramDirty) discardOk = false;
  diagramDirty = next;
  return { ok: true };
});

// ---------------------------------------------------------------------------
// ✦ Answer (§4.18)
// Who answers a box's question, and the asking. answer.js owns the four providers,
// the stored choice and the keys; a CLI runs in the workspace's folder, which is
// resolved HERE from the workspace id — never a path the page hands over.
// ---------------------------------------------------------------------------

/** After any change, every window hears the new status: the menu and Settings agree. */
function broadcastAnswer(status) {
  if (status && status.ok) send('sb:evt:answerStatus', status);
  return status;
}

handle('sb:answer:status', opts => answer.status(opts || {}));
handle('sb:answer:setSettings', async patch => broadcastAnswer(await answer.setSettings(patch)));
handle('sb:answer:setKey', async (provider, key) => broadcastAnswer(await answer.setKey(provider, key)));
handle('sb:answer:removeKey', async provider => broadcastAnswer(await answer.removeKey(provider)));
handle('sb:answer:start', async (id, req) => {
  const r = req && typeof req === 'object' ? req : {};
  const dir = r.wsId ? await workspaces.dirOf(r.wsId) : null;
  if ((r.provider === 'claude-code' || r.provider === 'codex') && !dir) {
    return { ok: false, error: `could not find the folder for ${r.wsId || 'this workspace'}` };
  }
  return answer.start(id, Object.assign({}, r, { dir }), step => send('sb:evt:answerStep', id, step));
});
handle('sb:answer:stop', id => answer.stop(id));

// The renderer answering flushNotes(). Resolving a promise, not returning a value: the
// quit is waiting on it. The generation matters: a quit can be CANCELLED (an unsaved
// Editor buffer, a failed applyOnQuit) after this one has timed out, and without the id
// the late answer to that flush would satisfy the next quit's flush instantly — which
// would then not wait for any note at all.
handle('sb:notes:flushed', id => {
  if (noteFlush && Number(id) === noteFlushId) noteFlush();
  return { ok: true };
});

/** Ask the renderer to write every unsaved note, and wait — but never for long. */
function flushNotes() {
  const win = mainWindow;
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return Promise.all([notes.settle(), diagrams.settle()]);
  const id = ++noteFlushId;
  return new Promise(resolve => {
    const done = () => { noteFlush = null; clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, 2000);
    noteFlush = done;
    try {
      win.webContents.send('sb:evt:notesFlush', id);
    } catch (_) {
      done();
    }
  }).then(() => Promise.all([notes.settle(), diagrams.settle()]));
}

// ⌘W anywhere the Editor does not want it (File ▸ Close is an item now — buildMenu says
// why). close(), never destroy(): the window's `close` handler still runs, so the bounds
// are saved, a pending publish still turns the close into a quit, and unsaved Editor
// files in another workspace still get their question.
handle('sb:ui:closeWindow', () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (win && !win.isDestroyed()) win.close();
  return { ok: true };
});

// ---------------------------------------------------------------------------
// §4.4 Pull requests
// ---------------------------------------------------------------------------

handle('sb:pr:summary', async id => {
  const ws = await scan(id);
  const summary = {};
  await Promise.all((ws.repos || []).map(async repo => {
    summary[repo.name] = null;
    if (!repo.branch || repo.detached) return;
    try {
      summary[repo.name] = prRef(await github.prForBranch(repo.dir, repo.branch));
    } catch (_) {
      summary[repo.name] = null;   // the detail call is where gh's error sentence is shown
    }
  }));
  return summary;
});

// Every guard below tests `error`, not `ok` — see ghFailure(). That is the only reason
// views/pr.js's `brew install gh` and `gh auth login` bars can ever appear.
handle('sb:pr:get', async (id, repoName, opts) => {
  const repo = await findRepo(id, repoName);
  if (!repo.branch || repo.detached) return { ok: false, error: `${repoName} is not on a branch` };
  // ⌘R on the screen: past github.js's 60 s cache, so a comment that just landed shows.
  if (opts && opts.fresh) github.invalidate(repo.dir);
  // workspaces.js already read origin.  Without one, prForBranch resolves to a plain `null`
  // (github.js:339) that reads as "no PR", so gh's own sentence has to be said here.
  if (!repo.remote && !repo.error) return { ok: false, error: 'this repo has no GitHub remote' };

  const found = await github.prForBranch(repo.dir, repo.branch);
  if (ghFailure(found)) return { ok: false, error: found.error || 'gh could not look up the pull request' };
  const head = prRef(found);
  if (!head) return { ok: false, error: `no pull request for ${repo.branch} yet` };

  const detail = await github.prDetail(repo.dir, head.number);
  if (!detail || ghFailure(detail)) {
    return { ok: false, error: (detail && detail.error) || 'gh could not read the pull request' };
  }
  const pr = detail.pr || detail;
  // The house test for "this is not really a PR", same as prRef() above.
  if (!pr || typeof pr.number !== 'number') return { ok: false, error: `could not read pull request #${head.number}` };

  let comments = [];
  try {
    const reviewed = await github.reviewComments(repo.dir, head.number);
    comments = Array.isArray(reviewed) ? reviewed : (reviewed && reviewed.comments) || [];
  } catch (_) { comments = []; }
  if (!comments.length && Array.isArray(pr.comments)) comments = pr.comments;

  let resolved = new Set();
  try {
    resolved = resolvedIds(await github.resolvedThreads(repo.dir, head.number));
  } catch (_) { resolved = new Set(); }

  const merged = comments.map(c => Object.assign({}, c, {
    resolved: resolved.size ? resolved.has(c.id) : !!c.resolved,
  }));

  return {
    ok: true,
    pr: Object.assign({}, pr, {
      number: head.number,
      state: pr.state || head.state,
      comments: merged,
      commentCount: typeof pr.commentCount === 'number' ? pr.commentCount : merged.length,
    }),
  };
});

// The same screen for a pull request named by owner/repo/number — how the "My pull
// requests" list opens one, in whatever repository it lives, cloned here or not.
// prDetail already carries the resolved flags (they come from the same review-thread
// query), so there is nothing to merge.
handle('sb:pr:byNumber', async (owner, repo, number, opts) => {
  const o = opts || {};
  const detail = await github.prDetailByRemote({ owner, repo, host: o.host || null }, number, { fresh: !!o.fresh });
  if (!detail || ghFailure(detail)) {
    return { ok: false, error: (detail && detail.error) || 'gh could not read the pull request' };
  }
  if (typeof detail.number !== 'number') return { ok: false, error: `could not read pull request #${number}` };
  return { ok: true, pr: detail };
});

// The screen's one action: squash the branch's commits into one and merge it into the
// base branch — on GitHub, through gh, never in the checkout (§0). `ref` names the pull
// request the way the screen was reached: { wsId, repoName } for a branch pill, so the
// repo's own remote is the one asked, or { owner, repo, host } for a row of the Pull
// requests list; `ref.number` says which, `opts.headSha` what the screen showed.
handle('sb:pr:merge', async (ref, opts) => {
  const r = ref || {};
  const o = opts || {};
  const number = Number(r.number);
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: 'no pull request number' };
  const options = { headSha: o.headSha ? String(o.headSha) : null };
  let result;
  if (r.wsId) {
    const repo = await findRepo(r.wsId, r.repoName);
    if (!repo.remote && !repo.error) return { ok: false, error: 'this repo has no GitHub remote' };
    result = await github.mergePr(repo.dir, number, options);
  } else {
    result = await github.mergePrByRemote({ owner: r.owner, repo: r.repo, host: r.host || null }, number, options);
  }
  if (!result || ghFailure(result)) {
    return { ok: false, error: (result && result.error) || 'gh could not merge the pull request' };
  }
  return Object.assign({ ok: true }, result);
});

// §4.12 Every open pull request the signed-in user authored, in any repository.
handle('sb:prs:mine', async opts => {
  const result = await github.myPullRequests({ fresh: !!(opts && opts.fresh) });
  if (!result || ghFailure(result)) {
    return { ok: false, error: (result && result.error) || 'gh could not list your pull requests' };
  }
  return Object.assign({ ok: true }, result);
});

// ---------------------------------------------------------------------------
// §4.5 Misc
// ---------------------------------------------------------------------------

handle('sb:open', url => {
  if (!openExternal(url)) return { ok: false, error: 'only http and https links open in the browser' };
  return { ok: true };
});

handle('sb:reveal', dir => {
  if (!dir) return { ok: false, error: 'nothing to reveal' };
  shell.showItemInFolder(dir);
  return { ok: true };
});

// Every copy in the app goes through here, and it has to.  document.execCommand('copy')
// is refused by Chromium without a user gesture, and an sb:evt:edit handler is not one —
// so routing ⌘C through the renderer silently copied NOTHING out of a diff (verified: a
// 337-character selection, ⌘C, clipboard unchanged).  Main has no such restriction.
// navigator.clipboard.writeText does work here, but only while the window has focus,
// which a `/copy` from a background workspace's shell cannot promise.
handle('sb:clipboard:write', async text => {
  const value = String(text === null || text === undefined ? '' : text);
  // A smoke run says what it would have copied instead of copying it: the harness
  // runs on the user's Mac, and a test string must not replace what they have copied.
  if (process.env.SB_SMOKE) { console.log('SMOKE clipboard:', JSON.stringify(value)); return { ok: true }; }
  // Awaited because writeText is async here too; unawaited it happens to land, but a
  // failure would be an unhandled rejection instead of an error the caller can see.
  await clipboard.writeText(value);
  return { ok: true };
});

handle('sb:editor', dir => new Promise(resolve => {
  if (!dir) return resolve({ ok: false, error: 'nothing to open' });
  execFile('open', ['-a', 'Visual Studio Code', dir], err => {
    resolve(err ? { ok: false, error: 'could not open Visual Studio Code' } : { ok: true });
  });
}));

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Two independent teardowns, run at the same time and caught separately: a dev tree
// that takes its full SIGTERM→SIGKILL grace must not hold the shells' SIGHUP back,
// and neither must be skipped because the other threw.
async function stopEverything() {
  const closeDatabases = databases.close();
  // A CLI still answering a diagram's box is a process of ours, with children of its
  // own: it goes with the app, on every way out (§4.18).
  answer.stopAll();
  const stopSessions = (async () => {
    try {
      const result = await runner.stopAll();
      if (result && result.ok === false) {
        for (const r of result.results || []) {
          if (!r.ok) console.error(`[switchboard] could not stop ${r.wsId}:`, r.error);
        }
      }
    } catch (err) {
      console.error('[switchboard] could not stop every session:', err.message);
    }
  })();

  // §5 M6: a shell inside tmux is detached, not hung up — it is still there, Claude
  // mid-turn and all, when the app next opens.  Only a shell without tmux is hung up
  // the way closing an iTerm2 window would; `claude --continue` resumes those.
  const closeShells = (async () => {
    try {
      await shells.closeAll();
    } catch (err) {
      console.error('[switchboard] could not hang up every shell:', err.message);
    }
  })();

  await Promise.all([stopSessions, closeShells, closeDatabases]);
}

// sbimg://image/<file> — a picture on a diagram, kept on this Mac (diagrams.js). A
// standard, secure scheme so the page can show it like any image; registered before
// `ready`, as Electron requires, and served from the images folder and nowhere else.
protocol.registerSchemesAsPrivileged([
  { scheme: 'sbimg', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function serveDiagramImage(request) {
  let file = null;
  try {
    const url = new URL(request.url);
    if (url.host === 'image') file = diagrams.imagePath(decodeURIComponent(url.pathname.replace(/^\/+/, '')));
  } catch (_) { file = null; }
  if (!file) return new Response('not found', { status: 404 });
  return net.fetch(pathToFileURL(file).toString()).catch(() => new Response('not found', { status: 404 }));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // First, before config.load(), the first scan or any gh call: give this process the PATH
  // the user's terminal has.  A Dock launch does not get one.
  repairPath();

  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    const cfg = config.load();
    if (cfg.configError) console.error('[switchboard] starting with the default config');
    // Before the window and before any shell: shells.js reads this at spawn, and the
    // first Terminal can be opened before the renderer has asked us anything.
    shells.setAppearance(effectiveAppearance(storedAppearance()));
    // Only 'system' cares — the other two already ARE the answer — but the listener
    // is registered unconditionally because the choice can change while the app runs.
    nativeTheme.on('updated', () => {
      if (storedAppearance() === 'system') applyAppearance();
    });
    buildMenu();
    protocol.handle('sbimg', serveDiagramImage);
    // Before the window, so the panel's first page already goes out as Chrome would ask
    // for it, with no permission to grant and nowhere to download to.
    images.setupImagesSession();
    // Before the window: the first answer is usually in hand by the time the renderer
    // asks, so the Grid's gauge is there on the first paint rather than a beat later.
    usage.start();
    createWindow();
  });

  // macOS: closing the window does not quit the app; the dock icon reopens it.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Never leave a dev server behind.  Quit is deferred until every session is
  // torn down, whether or not anything was running.
  app.on('before-quit', event => {
    // First, before anything is torn down: a Cancel here must leave every dev server,
    // shell and pending publish exactly as it was.
    if (!quitting && !discardOk && (editorDirty + noteDirty) > 0) {
      if (!confirmDiscard()) {
        event.preventDefault();
        return;
      }
      discardOk = true;
    }
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    (async () => {
      // A quit during publishing waits for the build, so it cannot leave a
      // half-prepared update behind. Build failure keeps the installed app intact.
      await publisher.wait();
      await stopEverything();
      // The notes last, not first: a publish build can take a minute and the window
      // stays live through it, so a flush at the top would miss whatever was typed
      // while it ran. The renderer is still there at this point; it is only after
      // applyOnQuit() that it is not.
      await flushNotes();
      // Again, now: that wait can be a whole publish build, and the window stayed live
      // through it — an edit made meanwhile was never asked about, and neither the second
      // before-quit (`quitting`) nor the window's close would ask. Before applyOnQuit(),
      // so a Cancel keeps the prepared update for the next quit, along with the buffers;
      // the dev servers and shells are already stopped, which a cancelled quit can live with.
      // A diagram counts only here, after the flush has written it: before it, its count
      // is the editor's autosave in flight, not something to ask about.
      if (!discardOk && (editorDirty + noteDirty + diagramDirty) > 0 && !confirmDiscard()) {
        quitting = false;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
        return;
      }
      const installed = publisher.applyOnQuit();
      if (!installed.ok) {
        quitting = false;
        discardOk = false;                // the window stays, and so do its unsaved files
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
        return;
      }
      app.quit();
    })().catch(err => {
      console.error('[switchboard] could not finish quitting:', err);
      quitting = false;
      discardOk = false;
    });
  });
}
