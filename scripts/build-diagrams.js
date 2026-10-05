'use strict';

// npm run build:diagrams — the Diagrams tab's bundle, and the one build step in the
// app (ARCHITECTURE §0 says why there is one at all).
//
//   src/diagrams/index.tsx  → src/renderer/diagrams/diagrams.js   (esbuild, one IIFE)
//   src/diagrams/styles.css → src/renderer/diagrams/diagrams.css  (Tailwind + React Flow)
//
// Both outputs are generated, ignored by git, and rebuilt by `npm start` (prestart)
// and by scripts/package.js before every desktop build, so neither can go stale.
//
// The stylesheet is the part that needs care. It is the admin's Tailwind, and loaded
// as it comes it would restyle the whole app — its preflight resets every heading,
// button and image, and a utility such as `.grid` collides with Switchboard's own
// class of that name. So every rule is scoped to `.sbdg`, the element the editor is
// mounted in, behind :where() so the scope adds no specificity. And the cascade
// layers go: Switchboard's styles.css is unlayered, and an unlayered rule beats a
// layered one whatever its specificity — `*{padding:0}` would beat every `p-2`.
// Flattened in their own order (theme, base, components, utilities, then React Flow),
// they keep the precedence they had in the admin among themselves.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const SRC = path.join(root, 'src', 'diagrams');
const OUT = path.join(root, 'src', 'renderer', 'diagrams');
const SCOPE = ':where(.sbdg)';

// Appended after the scoped sheet, as written. Global on purpose: --brand-primary is
// read where the admin's theme defines --color-brand (on :root); the rest dresses the
// root element itself, which the scoped rules (all descendant selectors) never reach.
const EXTRA = `
/* Switchboard: the admin's per-product brand colour is the app's link blue here. */
:root{--brand-primary:#0969da}
.sbdg{position:relative;display:flex;flex:1;min-width:0;min-height:0;
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif;
  line-height:1.5;color:#111827;-webkit-font-smoothing:antialiased}
.sbdg>.sbdg-app{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
/* Radix and toasts live here, outside Grid's clipped cells. Zero-sized so the
   host itself never covers the app; its positioned children remain interactive. */
.sbdg.sbdg-portal-root{position:fixed;top:0;left:0;z-index:1500;display:block;
  width:0;height:0;min-width:0;min-height:0;flex:none;overflow:visible}
[data-term-theme="dark"] .sbdg{color:#f9fafb;color-scheme:dark}
`;

/** The `@/x` imports the copied admin files use, resolved against src/diagrams. */
const atAlias = {
  name: 'at-alias',
  setup(build) {
    build.onResolve({ filter: /^@\// }, args =>
      build.resolve('./' + args.path.slice(2), { resolveDir: SRC, kind: args.kind }));
  },
};

async function buildJs() {
  const esbuild = require('esbuild');
  await esbuild.build({
    entryPoints: [path.join(SRC, 'index.tsx')],
    outfile: path.join(OUT, 'diagrams.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    // Electron 44's Chromium. Nothing older ever loads this.
    target: ['chrome130'],
    jsx: 'automatic',
    minify: true,
    sourcemap: true,
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    // The stylesheet is built below, scoped; a CSS import in a component (React
    // Flow's, as the admin's DiagramCanvas has) only says it is needed.
    loader: { '.css': 'empty' },
    plugins: [atAlias],
    logLevel: 'warning',
  });
}

function insideKeyframes(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'atrule' && /keyframes$/i.test(p.name)) return true;
  }
  return false;
}

function insideRule(node) {
  for (let p = node.parent; p; p = p.parent) if (p.type === 'rule') return true;
  return false;
}

/** One selector, scoped: the document's own roots become the element, the rest move inside it. */
function scopeSelector(selector) {
  const s = selector.trim();
  if (!s) return s;
  // Tailwind's theme variables stay global: harmless names (--color-*, --spacing…)
  // that the root element and Radix's portalled content both need to inherit.
  if (s === ':root') return s;
  const m = /^(html|body|:host|:root)(?![\w-])/.exec(s);
  if (m) return SCOPE + s.slice(m[1].length);
  return SCOPE + ' ' + s;
}

function scope() {
  return {
    postcssPlugin: 'sbdg-scope',
    OnceExit(css) {
      // Layers out, contents in place: `@layer a, b;` statements go, blocks unwrap.
      css.walkAtRules('layer', at => {
        if (at.nodes && at.nodes.length) at.replaceWith(at.nodes);
        else at.remove();
      });
      css.walkRules(rule => {
        if (insideKeyframes(rule) || insideRule(rule)) return;
        rule.selectors = rule.selectors.map(scopeSelector);
      });
    },
  };
}
scope.postcss = true;

async function buildCss() {
  const postcss = require('postcss');
  const tailwind = require('@tailwindcss/postcss');
  const input = path.join(SRC, 'styles.css');
  const result = await postcss([
    // optimize: lightningcss lowers Tailwind's nested output to flat rules, which is
    // what lets every top-level rule be scoped on its own.
    tailwind({ base: SRC, optimize: { minify: false } }),
    scope(),
  ]).process(fs.readFileSync(input, 'utf8'), { from: input });
  const banner = '/* Generated by scripts/build-diagrams.js from src/diagrams/styles.css — do not edit. */\n';
  fs.writeFileSync(path.join(OUT, 'diagrams.css'), banner + result.css + EXTRA);
}

async function build() {
  fs.mkdirSync(OUT, { recursive: true });
  await Promise.all([buildJs(), buildCss()]);
}

module.exports = { build, scopeSelector };

if (require.main === module) {
  const started = Date.now();
  build().then(() => {
    const size = f => (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0) + ' KB';
    console.log(`diagrams: built diagrams.js (${size('diagrams.js')}) and diagrams.css (${size('diagrams.css')}) in ${Date.now() - started} ms`);
  }, err => {
    console.error('diagrams: the build failed:', err && err.message ? err.message : err);
    process.exitCode = 1;
  });
}
