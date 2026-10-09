'use strict';

// The production whiteboard bundle and Markdown renderer, with the real store
// (src/main/whiteboards.js) behind a temporary SWITCHBOARD_CONFIG, in an isolated
// hidden Chromium window. No personal config or whiteboards are read.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-documents-browser-'));
const repo = path.join(__dirname, '..');
async function main() {
  try {
    await require('./build-diagrams').build();
    fs.writeFileSync(path.join(temp, 'fixture.html'), `<!doctype html><html><head><link rel="stylesheet" href="${path.join(repo, 'src/renderer/styles.css')}"><link rel="stylesheet" href="${path.join(repo, 'src/renderer/diagrams/diagrams.css')}"><style>html,body,#root{height:100%;margin:0}body{font-family:Arial,sans-serif}#root{display:flex;min-width:0}</style></head><body><div id="root"></div><script src="${path.join(repo, 'src/renderer/dom.js')}"></script><script src="${path.join(repo, 'src/renderer/markdown.js')}"></script><script src="${path.join(repo, 'src/renderer/diagrams/diagrams.js')}"></script><script>
      // Board-centric props (ARCHITECTURE §4.17): the fixture's main writes the board
      // first and hands its id over in the query string.
      const boardId = new URLSearchParams(location.search).get('board');
      window.closed = [];
      window.diagram = SBDiagrams.create(document.getElementById('root'), {
        boardId, active: true, terminals: [], workspaceStatus: {},
        onOpenSettings() {}, onOpenBoard(id) { window.opened = id; }, onClosed(folderId) { window.closed.push(folderId); },
        onBoardChange(board) { window.board = board; }, onDirty(count) { window.dirty = count; },
        onOpenTerminal() {}, onToggleTerminals() {}, onTerminalSlots() {}, onTerminalFloat() {}, onTerminalRemoved() {},
      });
    </script></body></html>`);
    fs.writeFileSync(path.join(temp, 'preload.cjs'), `const { contextBridge, ipcRenderer } = require('electron');
      const api = {};
      for (const name of ['List','Get','Create','SaveSpec','Rename','SetWorkspace','Move','Duplicate','Archive','Delete','CreateFolder','RenameFolder','DeleteFolder','DismissNotice','NoteWorkspace','Workspaces','CreateDocument','GetDocument','SaveDocument','Migrate']) api['whiteboards'+name] = (...args) => ipcRenderer.invoke('wb:'+name, ...args);
      api.onWhiteboardsChanged = callback => { const listener = (_event, change) => callback(change); ipcRenderer.on('wb:changed', listener); return () => ipcRenderer.removeListener('wb:changed', listener); };
      api.diagramsGetImagePath = src => ipcRenderer.invoke('wb:GetImagePath', src);
      api.writeClipboard = text => ipcRenderer.invoke('clipboard:write', text);
      contextBridge.exposeInMainWorld('sb', api);
    `);
    fs.copyFileSync(path.join(__dirname, 'documents-browser-fixture.cjs'), path.join(temp, 'main.cjs'));
    const output = execFileSync(require('electron'), [path.join(temp, 'main.cjs')], {
      encoding: 'utf8', timeout: 60_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '', SWITCHBOARD_CONFIG: path.join(temp, 'config.json'), SWITCHBOARD_DOCUMENT_TEST_REPO: repo },
    });
    process.stdout.write(output);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
