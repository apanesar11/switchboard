'use strict';

// The window.sb bridge — ARCHITECTURE §4.  This file runs in a SANDBOXED
// preload, which cannot require any node module (not even 'fs'); everything it
// does is ipcRenderer.invoke/on.  It must stay CommonJS: an ESM preload fails
// under the default sandbox with "Cannot use import statement outside a module"
// and window.sb silently never appears.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Each subscribe helper strips the IpcRendererEvent so the renderer callback
// sees only the payload, and returns its own unsubscribe function.
function subscribe(channel, callback) {
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('sb', {
  // Workspaces
  listWorkspaces: () => ipcRenderer.invoke('sb:ws:list'),
  publish: id => ipcRenderer.invoke('sb:publish:start', id),
  publishState: () => ipcRenderer.invoke('sb:publish:state'),
  onPublish: cb => subscribe('sb:evt:publish', cb),
  scanWorkspace: (id, opts) => ipcRenderer.invoke('sb:ws:scan', id, opts || {}),
  pullMain: (id, repoName) => ipcRenderer.invoke('sb:ws:pullMain', id, repoName || null),

  // Running
  start: id => ipcRenderer.invoke('sb:run:start', id),
  stop: id => ipcRenderer.invoke('sb:run:stop', id),
  runStates: () => ipcRenderer.invoke('sb:run:states'),
  // procName is optional: a workspace with one dev process (all of them except
  // demo) never needs it, and omitting it means "the first process".
  logs: (id, procName) => ipcRenderer.invoke('sb:run:logs', id, procName || null),
  sendInput: (id, data, procName) => ipcRenderer.invoke('sb:run:input', id, data, procName || null),
  resize: (id, cols, rows, procName) => ipcRenderer.invoke('sb:run:resize', id, cols, rows, procName || null),

  // Diffs
  fileDiff: (id, repoName, path) => ipcRenderer.invoke('sb:diff:file', id, repoName, path),
  allDiffs: (id, repoName) => ipcRenderer.invoke('sb:diff:all', id, repoName || null),

  // Editor (§4.14) — the Editor tab's files. A file is (id, repoName, path) as for
  // fileDiff: `repoName` is Repo.name, `path` repo-relative with '/'. Main resolves it and
  // refuses anything outside the repo or inside .git; none of these ever runs a git write.
  // codeTree: { ok, repos: [{ name, files, truncated, error }] } — git ls-files, per repo.
  codeTree: id => ipcRenderer.invoke('sb:code:tree', id),
  // { ok, text, mtimeMs, size, bom }, or binary / tooLarge / missing instead of text.
  codeRead: (id, repoName, path) => ipcRenderer.invoke('sb:code:read', id, repoName, path),
  // Save, in place. `opts`: { mtimeMs, bom, force } — the mtime the file was read at makes
  // a change on disk since then a { conflict } answer rather than an overwrite; `force`
  // is the user's Overwrite.
  codeWrite: (id, repoName, path, text, opts) => ipcRenderer.invoke('sb:code:write', id, repoName, path, text, opts || {}),
  // The HEAD version the modified-line markers diff against; `oldPath` for a rename.
  codeBase: (id, repoName, path, oldPath) => ipcRenderer.invoke('sb:code:base', id, repoName, path, oldPath || null),
  // `files`: [{ repo, path }], at most 200 — how open tabs notice a change on disk.
  codeStat: (id, files) => ipcRenderer.invoke('sb:code:stat', id, files || []),
  // Find in files over what is on disk. `opts`: { caseSensitive, regex }.
  codeSearch: (id, query, opts) => ipcRenderer.invoke('sb:code:search', id, query, opts || {}),
  // How many open files have unsaved edits, whenever that changes: main asks before a
  // close or a quit would throw them away (Electron ignores a page's beforeunload).
  codeDirty: count => ipcRenderer.invoke('sb:code:dirty', count),
  // The Editor tree's three writes (§4.16). Same (id, repoName, path) key as the rest of
  // sb:code:*, and the same guard in front of them: nothing here can name a file Save
  // could not. codeCreate makes an empty file, or a folder with `opts.dir`; codeRename
  // moves within one repo (a path with slashes in it moves the file); codeDelete puts
  // the file in the Trash, so a slip is one ⌘Z in Finder away from being undone.
  codeCreate: (id, repoName, path, opts) => ipcRenderer.invoke('sb:code:create', id, repoName, path, opts || {}),
  codeRename: (id, repoName, from, to) => ipcRenderer.invoke('sb:code:rename', id, repoName, from, to),
  codeDelete: (id, repoName, path) => ipcRenderer.invoke('sb:code:delete', id, repoName, path),

  // Notes (§4.15) — one markdown scratch pad per workspace, kept outside every repo.
  // `id` is a workspace id, or a Grid square's folder path. notesRead answers
  // { ok, text, mtimeMs, missing } — a note never written is an empty one, not an error
  // — or { ok, tooLarge } for a file past 2 MB, which is shown rather than opened.
  notesRead: id => ipcRenderer.invoke('sb:notes:read', id),
  // Save. `opts.mtimeMs` is what the renderer last read or wrote, so a note something
  // else has touched since comes back { ok:false, conflict:true } instead of overwritten;
  // `opts.force` is the user's Keep mine.
  notesWrite: (id, text, opts) => ipcRenderer.invoke('sb:notes:write', id, text, opts || {}),
  // The file in Finder, or the folder when there is none yet — the way out of a note
  // too large to open.
  notesReveal: id => ipcRenderer.invoke('sb:notes:reveal', id),
  // How many notes hold text that could NOT be written, whenever that changes: main
  // asks before a close or a quit would throw them away, as it does for the Editor's
  // buffers. Normally 0 — a note saves itself.
  notesDirty: count => ipcRenderer.invoke('sb:notes:dirty', count),
  // The quit flush. Main asks on its way out and WAITS for notesFlushed, because a
  // page's beforeunload is ignored and the last few hundred ms of typing would go with
  // the window otherwise.
  // `id` is the flush's generation; hand it straight back so main can tell a late
  // answer to a flush it has given up on from an answer to the one it is waiting for.
  onNotesFlush: cb => subscribe('sb:evt:notesFlush', cb),
  notesFlushed: id => ipcRenderer.invoke('sb:notes:flushed', id),

  // Diagrams (§4.17) — the Diagrams tab's flow diagrams, one file each, kept per
  // workspace beside the config and never in a repo. Every answer is { ok, data } or
  // { ok:false, error }; a diagram is the admin's row: { id, name, kind, createdAt,
  // updatedAt, archivedAt } plus `spec` where the whole diagram is asked for. The
  // bundle (src/diagrams) validates a spec before it asks for a write.
  diagramsList: id => ipcRenderer.invoke('sb:diagrams:list', id),
  diagramsGet: (id, diagramId) => ipcRenderer.invoke('sb:diagrams:get', id, diagramId),
  diagramsCreate: (id, name, spec) => ipcRenderer.invoke('sb:diagrams:create', id, name, spec),
  diagramsUpdate: (id, diagramId, name, spec) => ipcRenderer.invoke('sb:diagrams:update', id, diagramId, name, spec),
  diagramsArchive: (id, diagramId, archived) => ipcRenderer.invoke('sb:diagrams:archive', id, diagramId, !!archived),
  diagramsDelete: (id, diagramId) => ipcRenderer.invoke('sb:diagrams:delete', id, diagramId),
  // A picture for a canvas: its bytes and MIME type in, { ok, src } out — the
  // sbimg://image/<file> address main serves it from.
  diagramsSaveImage: (bytes, type) => ipcRenderer.invoke('sb:diagrams:saveImage', bytes, type),
  // The clipboard's picture as { ok, bytes, type } — Edit ▸ Paste over the canvas,
  // which a menu item delivers instead of a paste event.
  diagramsClipboardImage: () => ipcRenderer.invoke('sb:diagrams:clipboardImage'),
  // How many diagrams hold edits not yet written (0 or 1), whenever that changes:
  // main has the page write them before a close or a quit, as it does for notes.
  diagramsDirty: count => ipcRenderer.invoke('sb:diagrams:dirty', count),

  // ✦ Answer (§4.18) — who answers a box's question on this Mac, and the asking.
  // answerStatus: { ok, settings, providers, keysSafe }; `opts.fresh` looks for the
  // CLIs again. The setters answer the same, and main also pushes it to every
  // window as sb:evt:answerStatus, so the menu and the Settings screen agree.
  answerStatus: opts => ipcRenderer.invoke('sb:answer:status', opts || {}),
  answerSetSettings: patch => ipcRenderer.invoke('sb:answer:setSettings', patch || {}),
  // The key is checked with its provider, then encrypted with the Keychain; it never
  // comes back — only whether there is one and its last four characters.
  answerSetKey: (provider, key) => ipcRenderer.invoke('sb:answer:setKey', provider, key),
  answerRemoveKey: provider => ipcRenderer.invoke('sb:answer:removeKey', provider),
  // Ask. `req`: { provider, wsId, system, user, schema }. Resolves { ok, text, files? }
  // — the answer's JSON — or { ok:false, error, code }; a CLI's steps arrive meanwhile
  // as sb:evt:answerStep (id, step). answerStop ends it, CLI process and all.
  answerStart: (id, req) => ipcRenderer.invoke('sb:answer:start', id, req),
  answerStop: id => ipcRenderer.invoke('sb:answer:stop', id),
  onAnswerStep: cb => subscribe('sb:evt:answerStep', cb),
  onAnswerStatus: cb => subscribe('sb:evt:answerStatus', cb),
  // App ▸ Settings… (⌘,), a menu item, so the shortcut reaches the page as this.
  onOpenSettings: cb => subscribe('sb:evt:openSettings', cb),

  // Pull requests
  prSummary: id => ipcRenderer.invoke('sb:pr:summary', id),
  // `opts.fresh` skips main's 60 s cache — ⌘R on the screen.
  pr: (id, repoName, opts) => ipcRenderer.invoke('sb:pr:get', id, repoName, opts || {}),
  // The same screen for a PR named by owner/repo/number alone — how the "My pull
  // requests" list opens one, whether or not that repo is cloned under the root.
  // `opts`: { host, fresh }.
  prByNumber: (owner, repo, number, opts) => ipcRenderer.invoke('sb:pr:byNumber', owner, repo, number, opts || {}),
  // Every open pull request the signed-in user authored, in any repository. `fresh`
  // skips main's 60 s cache — ⌘R and the screen's ↻.
  myPrs: opts => ipcRenderer.invoke('sb:prs:mine', opts || {}),
  // Squash and merge — the Pull request screen's one action, done on GitHub and never
  // in the checkout. `ref` names the pull request the way the screen was reached,
  // { wsId, repoName, number } or { owner, repo, host, number }; `opts.headSha` is the
  // head the screen showed, so a branch that moved since is refused, not merged unseen.
  mergePr: (ref, opts) => ipcRenderer.invoke('sb:pr:merge', ref, opts || {}),

  // Misc
  openExternal: url => ipcRenderer.invoke('sb:open', url),
  revealInFinder: dir => ipcRenderer.invoke('sb:reveal', dir),
  openInEditor: dir => ipcRenderer.invoke('sb:editor', dir),
  // Main owns the clipboard: Chromium refuses document.execCommand('copy') without a
  // user gesture, and navigator.clipboard.writeText needs the window focused.
  writeClipboard: text => ipcRenderer.invoke('sb:clipboard:write', text),
  // The absolute path of a File that a Finder drop handed the renderer, '' when it
  // has none (a File built in memory). Answered here, not over IPC: a sandboxed
  // renderer's File carries no path since Electron 32, and webUtils is the one
  // module a sandboxed preload may ask. The File crosses the bridge as itself.
  pathForFile: file => {
    try { return webUtils.getPathForFile(file) || ''; } catch (_) { return ''; }
  },
  // The Terminal's drops, both halves (R8, §4.6). dragBegan: a drag has entered a pane,
  // and main snapshots the macOS drag pasteboard while the drag is live. dropFiles: the
  // drop's Files as [{ path, name, type, bytes? }], answered { ok, text } — the text the
  // terminal types. An unsaved screenshot dragged off its thumbnail is a file only the
  // pasteboard has; main/drops.js explains.
  dragBegan: () => ipcRenderer.invoke('sb:term:drag'),
  dropFiles: entries => ipcRenderer.invoke('sb:term:drop', entries),

  // Terminal — one login shell per workspace, opened lazily by the Terminal tab.
  // openShell is idempotent: it answers with the live shell when there is one.
  openShell: (id, cols, rows) => ipcRenderer.invoke('sb:term:open', id, cols, rows),
  shellInput: (id, data) => ipcRenderer.invoke('sb:term:input', id, data),
  shellResize: (id, cols, rows) => ipcRenderer.invoke('sb:term:resize', id, cols, rows),
  shellBuffer: id => ipcRenderer.invoke('sb:term:buffer', id),
  closeShell: id => ipcRenderer.invoke('sb:term:close', id),
  shellStates: () => ipcRenderer.invoke('sb:term:states'),
  // Terminal appearance. Both answer { appearance, effective }: `appearance` is the
  // choice ('light' | 'dark' | 'system'), `effective` is the one to paint with.
  termAppearance: () => ipcRenderer.invoke('sb:term:appearance'),
  setTermAppearance: choice => ipcRenderer.invoke('sb:term:setAppearance', choice),

  // The sidebar. Main owns whether it is open for one reason: the View menu item has
  // to read "Hide Sidebar" or "Show Sidebar", and the menu is main's. Both answer
  // { visible }.
  sidebar: () => ipcRenderer.invoke('sb:ui:sidebar'),
  setSidebar: visible => ipcRenderer.invoke('sb:ui:setSidebar', !!visible),
  // What File ▸ Close did when it was the role: close the window. ⌘W now reaches the
  // renderer first (sb:evt:edit `close`) so the Editor can close a file tab with it;
  // everywhere else the renderer answers with this.
  closeWindow: () => ipcRenderer.invoke('sb:ui:closeWindow'),

  // The Grid's views — named 2x2 arrangements of workspaces. Both answer { views },
  // and save hands back what main actually kept after cleaning the list.
  gridViews: () => ipcRenderer.invoke('sb:grid:list'),
  saveGridViews: views => ipcRenderer.invoke('sb:grid:save', views),
  // Any folder on this Mac for a Grid square, through the system's own chooser (§4.10).
  // Answers { ok, dir } — or { ok:false, canceled:true } when the sheet was dismissed,
  // which is not an error. The folder's absolute path then IS the square's id.
  chooseFolder: () => ipcRenderer.invoke('sb:dialog:folder'),

  // Claude usage — the limits claude.ai's "Your usage" page shows, read through Claude
  // Code's own sign-in. Both answer a Usage (§2); refreshUsage asks Anthropic again now.
  usage: () => ipcRenderer.invoke('sb:usage:get'),
  refreshUsage: () => ipcRenderer.invoke('sb:usage:refresh'),

  // Push events (main → renderer); each returns an unsubscribe function
  onLog: cb => subscribe('sb:evt:log', cb),
  onRunState: cb => subscribe('sb:evt:run', cb),
  onLinks: cb => subscribe('sb:evt:links', cb),
  onFocus: cb => subscribe('sb:evt:focus', cb),
  onTermData: cb => subscribe('sb:evt:term', cb),
  onTermState: cb => subscribe('sb:evt:termState', cb),
  // The Edit menu's Undo / Redo / Cut / Copy / Paste / Select All and File ▸ Close,
  // which have to be menu items rather than roles: { action: 'undo' | 'redo' | 'cut' |
  // 'copy' | 'paste' | 'selectAll' | 'close', text?, image? }. `paste` arrives with the
  // clipboard text already read in main; `image: true` when there was no text, only an
  // image, and `text` is the escaped path of a file main saved it to — for a terminal to
  // type (Claude Code reads the image from it), and for nothing else to insert.
  onEdit: cb => subscribe('sb:evt:edit', cb),
  // The View menu's Terminal appearance, and a macOS appearance change while the
  // choice is "Match system".
  onAppearance: cb => subscribe('sb:evt:appearance', cb),
  // The View menu's Hide / Show Sidebar. The renderer's own button applies the class
  // first and this echo lands on the state it is already in.
  onSidebar: cb => subscribe('sb:evt:sidebar', cb),
  // A fresh Usage: every five minutes, and after a window focus when the last is old.
  onUsage: cb => subscribe('sb:evt:usage', cb),
});
