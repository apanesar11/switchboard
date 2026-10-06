'use strict';

// Actual Chromium editing, in an isolated hidden Electron window. This fixture
// never loads Switchboard's main process, user configuration, or diagram files.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const esbuild = require('esbuild');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-rich-text-browser-'));
const source = path.join(__dirname, '..', 'src', 'diagrams');
async function main() {
try {
  await require('./build-diagrams').build();
  const entry = path.join(temp, 'fixture.tsx');
  fs.writeFileSync(entry, `
    import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
    import { createRef } from ${JSON.stringify(require.resolve('react'))};
    import { FlowEditor } from ${JSON.stringify(path.join(source, 'app/dashboard/diagrams/FlowEditor'))};
    import { readRichText, editFlowText, restoreFlowTextSelection } from ${JSON.stringify(path.join(source, 'lib/diagrams/rich-text-dom'))};
    window.readRichText = readRichText;
    window.copied = [];
    window.editText = (action, text = '') => editFlowText(document.activeElement.closest('[data-flow-text]'), action, text, text => window.copied.push(text));
    window.selectFlowText = (start, end, field = 'label') => {
      const element = document.querySelector('[data-flow-text=' + field + ']');
      element.focus(); restoreFlowTextSelection(element, { start, end });
    };
    window.editor = createRef();
    window.saved = [];
    window.initial = { kind: 'flow', nodes: [
      { id: 'box', label: 'Connect multiple systems', align: 'left', position: { x: 20, y: 100 } },
      { id: 'text', label: 'Regular text words', shape: 'text', align: 'left', position: { x: 300, y: 100 } },
      { id: 'legacy', label: 'Previously bold text', bold: true, italic: true, position: { x: 20, y: 250 } }
    ], edges: [] };
    const root = createRoot(document.getElementById('root'));
    window.mount = (spec) => root.render(<FlowEditor key={window.serial = (window.serial || 0) + 1}
      ref={window.editor} spec={spec} onSave={async spec => { window.saved.push(spec); return null; }}
      keyboardEnabled={true} fitKey="fixture" productId="fictional-workspace" />);
    window.mount(window.initial);
  `);
  await esbuild.build({ entryPoints: [entry], outfile: path.join(temp, 'fixture.js'), bundle: true,
    platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.join(__dirname, '..', 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' }, logLevel: 'error',
    plugins: [{ name: 'alias', setup(build) { build.onResolve({ filter: /^@\// }, args =>
      build.resolve('./' + args.path.slice(2), { resolveDir: source, kind: args.kind })); } }] });
  fs.writeFileSync(path.join(temp, 'fixture.html'), `<!doctype html><html><head><link rel="stylesheet" href="${path.join(__dirname, '..', 'src', 'renderer', 'diagrams', 'diagrams.css')}"><style>html,body,#root{height:100%;margin:0}body{font-family:Arial,sans-serif}#root{display:flex;flex:1;min-width:0}</style></head><body class="sbdg"><div id="root"></div><script src="fixture.js"></script></body></html>`);
  fs.copyFileSync(path.join(__dirname, 'rich-text-browser-fixture.cjs'), path.join(temp, 'main.cjs'));
  const output = execFileSync(require('electron'), [path.join(temp, 'main.cjs')], {
    encoding: 'utf8', timeout: 60_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  process.stdout.write(output);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
