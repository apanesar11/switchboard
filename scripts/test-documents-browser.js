'use strict';

// The production Diagrams bundle and Markdown renderer, with the real file APIs,
// in an isolated hidden Chromium window. No personal config or diagrams are read.
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
      window.diagram = SBDiagrams.create(document.getElementById('root'), { wsId: 'fictional-documents', wsName: 'Example workspace', active: true, onOpenSettings() {}, onOpenTerminal() {}, onDirty(count) { window.dirty = count; } });
    </script></body></html>`);
    fs.writeFileSync(path.join(temp, 'preload.cjs'), `const { contextBridge, ipcRenderer } = require('electron');
      const api = {};
      for (const name of ['List','Get','Create','Update','Archive','Delete','CreateDocument','GetDocument','SaveDocument']) api['diagrams'+name] = (...args) => ipcRenderer.invoke('diagram:'+name, ...args);
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
