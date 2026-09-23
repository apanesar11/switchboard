// SB.dom — the DOM helpers every view is built from.
//
//   h(sel, attrs, ...children)   sel is 'div.repo.on' / 'button.btn.pri' / '.empty'
//   esc(s) frag(...) clear(el) text(s) on(el, ev, fn)
//   pm(add, del)                 '+84 −3'  (U+2212 MINUS SIGN, not a hyphen)
//   blocks(add, del)             the five-block change bar
//   crumb(items)                 items are {label, onClick, mono?}; the last is current
//   pill(text, {number})         the branch pill
//   icon(name)                   a span carrying SB.icons[name]
//   fmtAgo(msOrIso) plural(n, word) elide(path) -> {dir, base}
//   spinner() empty(message) errorBox(message, {retry})
//
// Only `h`'s `html:` attr writes raw markup, and it exists for SB.icons alone.
// Every other string reaches the document as a text node, which cannot inject.
window.SB = window.SB || {};

(function (SB) {
  'use strict';

  // Deletion counts are U+2212 MINUS SIGN throughout the mock-up. A hyphen-minus
  // renders visibly shorter and breaks the optical alignment of the 84px count column.
  var MINUS = '−';

  // ── core ──────────────────────────────────────────────────────────────────

  function element(sel) {
    var parts = String(sel == null ? 'div' : sel).split(/(?=[.#])/);
    var tag = 'div';
    if (parts.length && parts[0] && parts[0][0] !== '.' && parts[0][0] !== '#') tag = parts.shift();
    var el = document.createElement(tag);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.length < 2) continue;
      if (p[0] === '.') el.classList.add(p.slice(1));
      else el.id = p.slice(1);
    }
    return el;
  }

  // A plain options object, as opposed to a child (node / string / number / array).
  function isAttrs(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v) && !v.nodeType;
  }

  function style(el, v) {
    if (typeof v === 'string') { el.style.cssText = v; return; }
    for (var k in v) {
      var sv = v[k];
      if (sv === null || sv === undefined || sv === false) continue;
      if (k.slice(0, 2) === '--') el.style.setProperty(k, String(sv));
      else el.style[k] = sv;
    }
  }

  function append(parent, child) {
    if (child === null || child === undefined || child === false || child === true) return;
    if (Array.isArray(child)) {
      for (var i = 0; i < child.length; i++) append(parent, child[i]);
      return;
    }
    if (child.nodeType) { parent.appendChild(child); return; }
    parent.appendChild(document.createTextNode(String(child)));
  }

  function h(sel, attrs) {
    var el = element(sel);
    var first = 2;
    if (!isAttrs(attrs)) { first = (arguments.length > 1 && attrs !== null && attrs !== undefined) ? 1 : 2; attrs = null; }

    for (var key in attrs) {
      var v = attrs[key];
      if (v === null || v === undefined || v === false) continue;
      if (key === 'html') { el.innerHTML = v; continue; }           // trusted markup: icons only
      if (key === 'style') { style(el, v); continue; }
      if (key === 'dataset') {
        for (var d in v) if (v[d] !== null && v[d] !== undefined) el.dataset[d] = String(v[d]);
        continue;
      }
      if (key === 'class' || key === 'className') {
        String(v).split(/\s+/).forEach(function (c) { if (c) el.classList.add(c); });
        continue;
      }
      if (key.length > 2 && key[0] === 'o' && key[1] === 'n' && key[2] >= 'A' && key[2] <= 'Z') {
        if (typeof v === 'function') el.addEventListener(key.slice(2).toLowerCase(), v);
        continue;
      }
      if (key === 'value' && 'value' in el) { el.value = v; continue; }
      if (v === true) { el.setAttribute(key, ''); continue; }
      el.setAttribute(key, String(v));
    }

    for (var i = first; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }

  function frag() {
    var f = document.createDocumentFragment();
    for (var i = 0; i < arguments.length; i++) append(f, arguments[i]);
    return f;
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function clear(el) {
    if (!el) return el;
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  }

  function text(s) {
    return document.createTextNode(s === null || s === undefined ? '' : String(s));
  }

  function on(el, ev, fn) {
    if (!el) return function () {};
    el.addEventListener(ev, fn);
    return function () { el.removeEventListener(ev, fn); };
  }

  // ── counts ────────────────────────────────────────────────────────────────

  function count(n) {
    n = Number(n);
    return isFinite(n) && n > 0 ? Math.round(n) : 0;
  }

  // '+84 −3' as the mock-up writes it: two spans with a real space between them,
  // and no wrapper, so .sumb's flex gap and .fr .n's inline layout both behave.
  function pm(add, del) {
    return frag(
      h('span.add', null, '+' + count(add)),
      ' ',
      h('span.del', null, MINUS + count(del))
    );
  }

  // The five-block change bar, gen.mjs lines 36-37 verbatim. Green is rounded first
  // and red is clamped to the remainder, so green+red is always exactly 5 for any
  // non-zero file — grey appears ONLY for +0 −0. Math.round is half-UP, so a 50/50
  // file (+1 −1, +5 −5) is 3 green / 2 red, not 2/3. The bar is a ratio, never a
  // magnitude: a 1204-line lockfile and a 10-line schema change both show five green.
  function blocks(add, del) {
    var a = count(add), d = count(del);
    var t = a + d || 1;
    var g = Math.round(5 * a / t);
    var r = Math.min(5 - g, Math.round(5 * d / t));
    var bar = h('span.blocks');
    var i;
    for (i = 0; i < g; i++) bar.appendChild(h('i.g'));
    for (i = 0; i < r; i++) bar.appendChild(h('i.r'));
    for (i = 0; i < 5 - g - r; i++) bar.appendChild(h('i'));
    return bar;
  }

  // ── components ────────────────────────────────────────────────────────────

  function icon(name) {
    return h('span.ic', { html: (SB.icons && SB.icons[name]) || '', 'aria-hidden': 'true' });
  }

  function spinner() {
    return h('span.ic.spin', { html: (SB.icons && SB.icons.sync) || '', 'aria-hidden': 'true' });
  }

  // Splits a path so the directory half can ellipsise while the filename never does.
  // A direction:rtl ellipsis was tried and truncates the wrong end — it eats the
  // filename, which is the one part the user is reading.
  function elide(path) {
    var s = String(path === null || path === undefined ? '' : path);
    var i = s.lastIndexOf('/');
    return i < 0 ? { dir: '', base: s } : { dir: s.slice(0, i + 1), base: s.slice(i + 1) };
  }

  function pathSpans(path) {
    var p = elide(path);
    return [h('span.dir', null, p.dir), h('span.base', null, p.base)];
  }

  // items: [{label, onClick, mono}] — every part but the last navigates; the last is
  // the current page. The back caret pops exactly one level (the second-to-last item).
  function crumb(items) {
    var list = (items || []).filter(Boolean);
    var box = h('div.crumb');
    if (list.length > 1) {
      var prev = list[list.length - 2];
      box.appendChild(h('button.back', {
        type: 'button',
        onClick: prev.onClick,
        'aria-label': 'Back'
      }, icon('caret')));
    }
    list.forEach(function (item, i) {
      if (i) box.appendChild(h('span', null, '›'));
      if (i === list.length - 1) {
        box.appendChild(item.mono
          ? h('span.cur.mono', { title: item.label }, pathSpans(item.label))
          : h('span.cur', null, item.label));
      } else {
        box.appendChild(h('span', { dataset: { nav: '' }, onClick: item.onClick }, item.label));
      }
    });
    return box;
  }

  // The branch pill. A bare `main` pill is inert; one that can open a pull request is
  // a real button so it can be tabbed to and shows the focus ring.
  function pill(label, opts) {
    var o = opts || {};
    var clickable = typeof o.onClick === 'function';
    var sel = (clickable ? 'button' : 'span') + '.pill';
    if (clickable || o.link) sel += '.link';
    if (o.warn) sel += '.warn';
    var el = h(sel, {
      type: clickable ? 'button' : null,
      onClick: clickable ? o.onClick : null,
      title: o.title || null
      // .lbl is what lets a long branch name ellipsise inside the pill instead of
      // pushing the rest of the repo row off the window: a bare text node is an
      // anonymous flex item and text-overflow cannot reach it.
    }, icon('branch'), h('span.lbl', null, label === null || label === undefined ? '' : String(label)));
    if (o.number !== null && o.number !== undefined && o.number !== false) {
      el.appendChild(h('span.prn', null, '#' + o.number));
    }
    return el;
  }

  function empty(message, opts) {
    var o = opts || {};
    var box = h('div.empty');
    if (o.title) box.appendChild(h('h2', null, o.title));
    if (message !== null && message !== undefined && message !== '') box.appendChild(h('p', null, message));
    if (o.action && o.action.label) {
      box.appendChild(h('button.btn.pri', { type: 'button', onClick: o.action.onClick }, o.action.label));
    }
    return box;
  }

  // One full-width notice with at most one fix, per the design rule: never a stack
  // trace in a list, never a toast stack, never a modal.
  function errorBox(message, opts) {
    var o = opts || {};
    var box = h('div.bar.err');
    var line = h('span', null, message);
    if (o.code) { line.appendChild(text(' ')); line.appendChild(h('code', null, o.code)); }
    box.appendChild(line);
    if (typeof o.retry === 'function') {
      box.appendChild(h('span.sp'));
      box.appendChild(h('button.btn', { type: 'button', onClick: o.retry }, o.retryLabel || 'Retry'));
    }
    return box;
  }

  // ── formatting ────────────────────────────────────────────────────────────

  function toMs(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var t = Date.parse(v);
    return isNaN(t) ? null : t;
  }

  function fmtAgo(msOrIso) {
    var t = toMs(msOrIso);
    if (t === null) return '';
    var s = Math.round((Date.now() - t) / 1000);
    if (s < 0) s = 0;
    if (s < 10) return 'just now';
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    var hr = Math.floor(m / 60);
    if (hr < 24) return hr + 'h ago';
    var d = Math.floor(hr / 24);
    if (d < 7) return d + 'd ago';
    if (d < 30) return Math.floor(d / 7) + 'w ago';
    if (d < 365) return Math.floor(d / 30) + 'mo ago';
    return Math.floor(d / 365) + 'y ago';
  }

  function plural(n, word, many) {
    var k = Number(n);
    if (!isFinite(k)) k = 0;
    return k + ' ' + (Math.abs(k) === 1 ? word : (many || word + 's'));
  }

  SB.dom = {
    h: h,
    esc: esc,
    frag: frag,
    clear: clear,
    text: text,
    on: on,
    pm: pm,
    blocks: blocks,
    crumb: crumb,
    pill: pill,
    icon: icon,
    spinner: spinner,
    empty: empty,
    errorBox: errorBox,
    elide: elide,
    fmtAgo: fmtAgo,
    plural: plural,
    MINUS: MINUS
  };
})(window.SB);
