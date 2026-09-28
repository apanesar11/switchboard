// SB.noteEditor — the Notes tab's writing surface (§4.15, R14): a block editor over
// markdown, the way Notion works. Typing `### ` at the start of a line turns the line
// into a heading and the `### ` disappears; `- ` makes a bullet; `**bold**` becomes bold
// as the second `*` is typed. There is no source view and no preview toggle, because
// what is on screen IS the document — and the file on disk is ordinary markdown that
// any other editor can read.
//
//   SB.noteEditor.create(opts) -> { el, setText, getText, focus, hasFocus, isEmpty,
//                                   editAction, onKey, flush, destroy }
//   opts.onChange   called after every edit; views/notes.js debounces the save
//   opts.placeholder the line shown while the note is empty
//
// ── the tree ────────────────────────────────────────────────────────────────
//
// The root is ONE contenteditable div whose direct children are blocks:
//
//   <div class="nb" data-t="p">   <div class="nbc">…</div></div>
//   <div class="nb" data-t="h2">  <div class="nbc">…</div></div>
//   <div class="nb" data-t="ul" data-i="1"><div class="nbc">…</div></div>
//   <div class="nb" data-t="ol" data-n="3"><div class="nbc">…</div></div>
//   <div class="nb" data-t="todo" data-ck="x"><div class="nbc">…</div></div>
//   <div class="nb" data-t="code"><div class="nbc lit">raw text</div></div>
//   <div class="nb" data-t="hr" contenteditable="false"><hr></div>
//
// A bullet, a number and a checkbox are drawn by CSS — `.nb::before` — and are NOT
// nodes. That is deliberate and it is load-bearing: an inline contenteditable="false"
// span has a caret position on either side of it, and Chromium will happily put the
// caret BEFORE the bullet, where a typed character lands outside `.nbc` and is lost at
// save time, and where Backspace deletes the marker instead of the block. With no node
// there is no such position. The checkbox is hit-tested by where the click landed.
//
// Inside `.nbc` the only elements are <strong>, <em>, <code>, <del>, <a href> and the
// single trailing <br> that gives an empty block a caret. Everything else Chromium can
// put there — a <span style> from a paste, a <b> from its own editing commands, a <div>
// from a merge across blocks — is swept up by normalize(), which runs after every edit
// and is what makes this safe to build on contenteditable at all.
//
// Inline formatting is a MODEL, not a tree shape: a `.nbc`'s content is {text, marks},
// marks being character ranges {s, e, t:'strong'|'em'|'code'|'del'|'link', href}. The
// input rules, ⌘B, the serializer and the parser all work in it, which is why toggling
// bold over a selection that already has italic inside it is arithmetic rather than DOM
// surgery. readInline() reads the model out of the DOM (and says when the DOM held
// something it had to drop); renderInline() writes it back.
//
// ── the file ────────────────────────────────────────────────────────────────
//
// ONE LINE PER BLOCK, with no blank line inserted between them, so a blank line in the
// file is an empty paragraph on screen and comes back as one. (A fenced code block is
// the one block that spans lines.) That makes the round trip an identity, which matters
// more here than markdown pedantry: the file is re-read every time the window comes
// back, and a note that quietly lost its spacing each time would be worse than no
// editor. It also matches this app's own renderer, which reads a single newline as a
// line break (markdown.js, `breaks`).
//
// Opening a note and saving it must not change a byte of it. Two things make that true:
//   * every block keeps the SOURCE FORM it was read in — the literal indent, which
//     bullet character, an ordered item's own number and whether it used `.` or `)`,
//     `[ ]` versus `[X]`, which fence, which rule characters;
//   * a line this editor has no block for becomes a RAW one — the source text, shown as
//     source and saved as source. Two things send it there. Markdown it cannot DRAW: a
//     table, an image, `[ref]: url`, `[^1]: …`, a line of HTML, a setext `===` — drawing
//     an image as the sentence `!alt text` would be a lie, so it is not drawn at all.
//     And any line whose own re-serialisation would differ from the source, which
//     parse() catches by writing every block back out and comparing — an unclosed fence,
//     `** bold **`, a task with a double gap. What it cannot draw but CAN read as prose
//     (a four-space code block, a footnote reference, a pipe in a sentence) stays a
//     paragraph of its literal text, and is saved back unchanged.
//
// ── the Edit menu ───────────────────────────────────────────────────────────
//
// Undo / Redo / Cut / Copy / Paste / Select All are menu ITEMS in this app, not roles
// (§4.7), so ⌘Z and ⌘V never arrive as keystrokes. editAction() implements all six:
// undo and redo from a snapshot stack of this editor's own, copy and cut as MARKDOWN
// for the selection — so text copied out of a note and pasted back keeps its bold —
// and paste by parsing the clipboard as markdown. Chromium's own undo stack is never
// used: `historyUndo` is refused in beforeinput, because it would rewrite the DOM
// behind the model's back and the next autosave would persist the mismatch.
window.SB = window.SB || {};

(function (SB) {
  'use strict';

  var D = SB.dom;
  var h = D.h;

  var COMMIT_MS = 500;            // typing settles this long before it becomes one undo step
  var UNDO_MAX = 200;             // entries…
  var UNDO_BYTES = 4 * 1024 * 1024; // …and a ceiling on what they hold together
  var MAX_INDENT = 6;             // how deep a list is DRAWN; the file keeps its own indent

  var TYPES = {
    p: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1,
    ul: 1, ol: 1, todo: 1, quote: 1, code: 1, raw: 1, hr: 1,
  };
  var LISTS = { ul: 1, ol: 1, todo: 1 };
  var LITERAL = { code: 1, raw: 1 };          // text as typed; no marks, no rules
  var VOID = { hr: 1 };                       // nothing to put a caret in

  // Which inline element stands for which mark. B/I/S/U are Chromium's spellings —
  // from a paste, or from an editing command that slipped through — read as the mark
  // they mean and written back as ours.
  var TAG_MARK = {
    STRONG: 'strong', B: 'strong',
    EM: 'em', I: 'em',
    CODE: 'code',
    DEL: 'del', S: 'del', STRIKE: 'del',
    A: 'link',
  };
  var MARK_TAG = { strong: 'strong', em: 'em', code: 'code', del: 'del', link: 'a' };
  // Outermost first. `code` is last because its text is literal: a run that is code
  // carries no other mark, so it is always the innermost box.
  var ORDER = ['link', 'strong', 'em', 'del', 'code'];

  // ── tiny helpers ──────────────────────────────────────────────────────────

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function repeat(s, n) {
    var out = '';
    for (var i = 0; i < n; i++) out += s;
    return out;
  }

  function isBlock(el) {
    return !!el && el.nodeType === 1 && el.classList && el.classList.contains('nb');
  }

  function typeOf(block) {
    var t = block && block.getAttribute ? block.getAttribute('data-t') : null;
    return TYPES[t] ? t : 'p';
  }

  function attr(el, name, fallback) {
    var v = el && el.getAttribute ? el.getAttribute(name) : null;
    return v === null || v === undefined ? fallback : v;
  }

  function contentOf(block) {
    return block ? block.querySelector('.nbc') : null;
  }

  // Chromium puts U+00A0 where a space would collapse — the second of two, and one at
  // the end of a text node. `.nbc` is `white-space: pre-wrap`, so it mostly has no
  // reason to; this is for what reaches the tree another way (a paste, a drop, an
  // editing command). Left alone one reaches the file as an invisible byte that breaks
  // `# `, breaks grep, and never comes out again.
  //
  // Only the ones Chromium makes, though. A non-breaking space the AUTHOR put in the
  // file — `prix : 10`, French typography, an aligned list — is a byte they chose,
  // and rewriting it would break the one promise this editor makes about the file.
  // Every Chromium one sits beside an ordinary space or at the end of the text; a lone
  // one between two non-spaces is the author's.
  var NBSP_NOISE = / (?= )|(?<= ) | +$/g;

  function plainSpaces(s) {
    var out = String(s);
    if (out.indexOf(' ') === -1) return out;
    return out.replace(NBSP_NOISE, function (run) { return new Array(run.length + 1).join(' '); });
  }

  // ── the inline model: {text, marks} ───────────────────────────────────────

  function sameMark(a, b) {
    return a.t === b.t && (a.t !== 'link' || (a.href || '') === (b.href || ''));
  }

  /** Sorted, clipped, touching runs of the same mark joined. Everything assumes this. */
  function tidyMarks(marks, len) {
    var list = [];
    var top = typeof len === 'number' && isFinite(len) ? len : Infinity;
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      var s = clamp(Math.round(m.s), 0, top);
      var e = clamp(Math.round(m.e), 0, top);
      if (e <= s || !MARK_TAG[m.t]) continue;
      list.push({ s: s, e: e, t: m.t, href: m.t === 'link' ? String(m.href || '') : null });
    }
    list.sort(function (a, b) {
      return a.s - b.s || a.e - b.e || (ORDER.indexOf(a.t) - ORDER.indexOf(b.t));
    });
    var out = [];
    for (i = 0; i < list.length; i++) {
      var last = out[out.length - 1];
      if (last && sameMark(last, list[i]) && list[i].s <= last.e) {
        last.e = Math.max(last.e, list[i].e);
        continue;
      }
      out.push(list[i]);
    }
    return out;
  }

  /** The marks over character `at`, outermost first. `code` wins outright. */
  function activeAt(marks, at) {
    var set = [];
    for (var i = 0; i < marks.length; i++) {
      if (marks[i].s <= at && at < marks[i].e) set.push(marks[i]);
    }
    for (i = 0; i < set.length; i++) if (set[i].t === 'code') return [set[i]];
    set.sort(function (a, b) { return ORDER.indexOf(a.t) - ORDER.indexOf(b.t); });
    return set;
  }

  function sameSet(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (!sameMark(a[i], b[i])) return false;
    return true;
  }

  /** {text, marks} → the DOM inside a `.nbc`. */
  function renderInline(host, text, marks, literal) {
    D.clear(host);
    var s = String(text || '');
    host.classList.toggle('nbe', !s);

    if (literal) {
      if (s) host.appendChild(document.createTextNode(s));
      // `pre-wrap` gives no line box to an empty last line, and an empty block has no
      // caret at all without a node in it. A trailing <br> answers both, and readInline
      // knows to ignore one.
      if (!s || s.charAt(s.length - 1) === '\n') host.appendChild(document.createElement('br'));
      return;
    }
    if (!s) { host.appendChild(document.createElement('br')); return; }

    var list = tidyMarks(marks || [], s.length);
    var cuts = [0, s.length];
    for (var i = 0; i < list.length; i++) { cuts.push(list[i].s); cuts.push(list[i].e); }
    cuts.sort(function (a, b) { return a - b; });

    var at = 0;
    var runs = [];
    for (i = 0; i < cuts.length; i++) {
      var to = cuts[i];
      if (to <= at) continue;
      var set = activeAt(list, at);
      var prev = runs[runs.length - 1];
      if (prev && sameSet(prev.set, set)) prev.to = to;
      else runs.push({ from: at, to: to, set: set });
      at = to;
    }

    for (i = 0; i < runs.length; i++) {
      var run = runs[i];
      var node = document.createTextNode(s.slice(run.from, run.to));
      for (var k = run.set.length - 1; k >= 0; k--) {
        var mark = run.set[k];
        var el = document.createElement(MARK_TAG[mark.t]);
        if (mark.t === 'link') {
          el.setAttribute('href', mark.href || '');
          el.setAttribute('title', mark.href || '');
        }
        el.appendChild(node);
        node = el;
      }
      host.appendChild(node);
    }
  }

  /**
   * The DOM inside a `.nbc` → {text, marks, clean}. `clean:false` means the DOM held
   * something this model cannot express, and the caller renders the model back over it.
   */
  function readInline(host, literal) {
    var text = '';
    var marks = [];
    var clean = true;

    function walk(node) {
      for (var c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) { text += c.nodeValue; continue; }
        if (c.nodeType !== 1) { clean = false; continue; }
        if (c.nodeName === 'BR') {
          // The last <br> of the block is a placeholder — Chromium's, or renderInline's
          // padding — and not a line of the note.
          if (c.nextSibling || node !== host) { text += '\n'; if (!literal) clean = false; }
          continue;
        }
        var t = TAG_MARK[c.nodeName];
        if (!t || literal) { clean = false; walk(c); continue; }
        if (MARK_TAG[t] !== c.nodeName.toLowerCase()) clean = false;         // <b> for <strong>
        if (c.attributes.length > (t === 'link' ? 2 : 0)) clean = false;      // a style, a class
        if (t === 'link' && !c.getAttribute('href')) { clean = false; walk(c); continue; }
        var start = text.length;
        walk(c);
        if (text.length > start) marks.push({ s: start, e: text.length, t: t, href: t === 'link' ? c.getAttribute('href') : null });
        else clean = false;                                                   // an empty mark element
      }
    }

    walk(host);
    var flat = plainSpaces(text);
    if (flat !== text) { text = flat; clean = false; }
    if (literal) return { text: text, marks: [], clean: clean };
    if (text.indexOf('\n') !== -1) { text = text.replace(/\n/g, ' '); clean = false; }
    return { text: text, marks: tidyMarks(marks, text.length), clean: clean };
  }

  /** Toggle `type` over [from, to). Covered end to end → off; anything else → on. */
  function toggleMark(marks, from, to, type, href) {
    var list = tidyMarks(marks, Infinity);
    if (to <= from) return list;
    var covered = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].t === type && list[i].s <= from && list[i].e >= to) { covered = true; break; }
    }
    var out = [];
    for (i = 0; i < list.length; i++) {
      var m = list[i];
      if (m.t !== type || m.e <= from || m.s >= to) { out.push(m); continue; }
      if (m.s < from) out.push({ s: m.s, e: from, t: m.t, href: m.href });
      if (m.e > to) out.push({ s: to, e: m.e, t: m.t, href: m.href });
    }
    if (!covered) out.push({ s: from, e: to, t: type, href: href || null });
    return tidyMarks(out, Infinity);
  }

  /** Marks moved for an edit that replaced [from, to) with `grew` characters. */
  function shiftMarks(marks, from, to, grew) {
    var delta = grew - (to - from);
    var out = [];
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      var s = m.s <= from ? m.s : (m.s >= to ? m.s + delta : from);
      var e = m.e <= from ? m.e : (m.e >= to ? m.e + delta : from);
      if (e > s) out.push({ s: s, e: e, t: m.t, href: m.href });
    }
    return tidyMarks(out, Infinity);
  }

  // ── markdown: inline ──────────────────────────────────────────────────────

  var ESCAPABLE = /[\\`*_~\[\]()<>#+\-.!|]/;
  var URL_RE = /^https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]]/;

  /** One line of markdown → {text, marks}. */
  function parseInline(src) {
    var s = String(src === null || src === undefined ? '' : src);
    var text = '';
    var marks = [];
    var i = 0;

    function nest(inner) {
      var got = parseInline(inner);
      var at = text.length;
      text += got.text;
      for (var k = 0; k < got.marks.length; k++) {
        marks.push({ s: got.marks[k].s + at, e: got.marks[k].e + at, t: got.marks[k].t, href: got.marks[k].href });
      }
      return at;
    }

    while (i < s.length) {
      var c = s.charAt(i);
      if (c === '\\' && i + 1 < s.length && ESCAPABLE.test(s.charAt(i + 1))) {
        text += s.charAt(i + 1);
        i += 2;
        continue;
      }
      var rest = s.slice(i);
      var m = null;
      // Code first, and literally: a run of N backticks closes on a run of N, and one
      // space either side of the content is the fence's, not the code's.
      if (c === '`' && (m = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest))) {
        var body = m[2];
        if (body.charAt(0) === ' ' && body.charAt(body.length - 1) === ' ' && body.replace(/ /g, '')) {
          body = body.slice(1, -1);
        }
        var codeAt = text.length;
        text += body;
        marks.push({ s: codeAt, e: text.length, t: 'code', href: null });
        i += m[0].length;
        continue;
      }
      // `***x***` is what ⌘B then ⌘I on the same words writes (inlineToMd opens strong
      // then em). Without a rule for it the line did not reproduce itself and the whole
      // thing — the bold, the italic, and the heading or bullet in front of it — became
      // a raw source block. Before the `**` branch, which would otherwise eat two of
      // the three stars.
      if (c === '*' && s.charAt(i + 1) === '*' && s.charAt(i + 2) === '*' &&
          (m = /^\*\*\*(?!\s)([\s\S]+?)\*\*\*/.exec(rest))) {
        var bothAt = nest(m[1]);
        marks.push({ s: bothAt, e: text.length, t: 'strong', href: null });
        marks.push({ s: bothAt, e: text.length, t: 'em', href: null });
        i += m[0].length;
        continue;
      }
      if (c === '*' && s.charAt(i + 1) === '*' && (m = /^\*\*(?!\s)([\s\S]+?)\*\*/.exec(rest))) {
        var boldAt = nest(m[1]);
        marks.push({ s: boldAt, e: text.length, t: 'strong', href: null });
        i += m[0].length;
        continue;
      }
      if (c === '~' && s.charAt(i + 1) === '~' && (m = /^~~(?!\s)([\s\S]+?)~~/.exec(rest))) {
        var delAt = nest(m[1]);
        marks.push({ s: delAt, e: text.length, t: 'del', href: null });
        i += m[0].length;
        continue;
      }
      if (c === '*' && (m = /^\*(?![\s*])((?:[^*\n]|\*\*)+?)\*(?!\*)/.exec(rest))) {
        var emAt = nest(m[1]);
        marks.push({ s: emAt, e: text.length, t: 'em', href: null });
        i += m[0].length;
        continue;
      }
      // `[text](url)`, and `[text](<url with spaces>)`.
      if (c === '[' && (m = /^\[((?:[^\[\]\n]|\\[\[\]])*)\]\((?:<([^>\n]*)>|([^)\s]*))\)/.exec(rest))) {
        var linkAt = nest(m[1]);
        var href = m[2] !== undefined ? m[2] : (m[3] || '');
        if (text.length > linkAt) marks.push({ s: linkAt, e: text.length, t: 'link', href: href });
        i += m[0].length;
        continue;
      }
      if ((c === 'h' || c === 'H') && (m = URL_RE.exec(rest))) {
        var urlAt = text.length;
        text += m[0];
        marks.push({ s: urlAt, e: text.length, t: 'link', href: m[0] });
        i += m[0].length;
        continue;
      }
      text += c;
      i++;
    }
    return { text: text, marks: tidyMarks(marks, text.length) };
  }

  // What has to carry a backslash so the line reads back as itself. Deliberately not
  // "everything markdown can mean". An UNDERSCORE is never READ as emphasis and never
  // WRITTEN as it: `_italic_` is a spelling markdown readers disagree about, and the
  // alternative is escaping every `snake_case` in the file — so in a file it is plain
  // text, typed text and written text alike: a shortcut for it ate the underscores out
  // of a typed path. `~` is escaped only when doubled, and `[` only when it really does
  // open a link.
  function escapeText(s, inLink) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '\\' || c === '*' || c === '`') { out += '\\' + c; continue; }
      if (c === '~' && s.charAt(i + 1) === '~') { out += '\\~'; continue; }
      // Angle brackets are NOT escaped: nothing here reads HTML, `use <br> here` is a
      // sentence, and a file full of `\<` would be the price of a meaning this editor
      // does not have. (`<` and `>` stay in ESCAPABLE so escapeBlock can still use one
      // to stop a line being read as a quote, and so `\>` from another editor reads.)
      //
      // Brackets only where they mean something. Inside a link's own text BOTH have
      // to carry a backslash, or `[a]b](url)` stops at the first `]`; outside one,
      // `[` is escaped only when it really does open a link and `]` never is —
      // `see [1] in the margin` should not come back full of backslashes.
      if (inLink && (c === '[' || c === ']')) { out += '\\' + c; continue; }
      if (!inLink && c === '[' && /^\[(?:[^\[\]\n]|\\[\[\]])*\]\(/.test(s.slice(i))) { out += '\\['; continue; }
      out += c;
    }
    return out;
  }

  /** The delimiter for a code span: longer than any run of backticks inside it. */
  function codeSpan(body) {
    var longest = 0;
    var runs = String(body).match(/`+/g) || [];
    for (var i = 0; i < runs.length; i++) longest = Math.max(longest, runs[i].length);
    var fence = repeat('`', longest + 1);
    var pad = (body.charAt(0) === '`' || body.charAt(body.length - 1) === '`') ? ' ' : '';
    return fence + pad + body + pad + fence;
  }

  function hrefOut(url) {
    var s = String(url || '');
    return /[\s()<>]/.test(s) ? '<' + s.replace(/[<>]/g, '') + '>' : s;
  }

  var DELIM = { strong: '**', em: '*', del: '~~' };

  /** {text, marks} → one line of markdown. */
  function inlineToMd(text, marks) {
    var s = plainSpaces(String(text || ''));
    if (!s) return '';
    var list = trimMarks(tidyMarks(marks || [], s.length), s);
    var cuts = [0, s.length];
    for (var i = 0; i < list.length; i++) { cuts.push(list[i].s); cuts.push(list[i].e); }
    cuts.sort(function (a, b) { return a - b; });

    var out = '';
    var open = [];
    var at = 0;
    for (i = 0; i < cuts.length; i++) {
      var to = cuts[i];
      if (to <= at) continue;
      var set = activeAt(list, at);
      var chunk = s.slice(at, to);
      if (set.length === 1 && set[0].t === 'code') {
        while (open.length) out += closeOf(open.pop());
        out += codeSpan(chunk);
        at = to;
        continue;
      }
      // Close what is no longer active, innermost first, then open what is new.
      while (open.length && !inSet(set, open[open.length - 1])) out += closeOf(open.pop());
      for (var k = 0; k < set.length; k++) {
        if (inSet(open, set[k])) continue;
        open.push(set[k]);
        out += openOf(set[k]);
      }
      out += escapeText(chunk, hasMark(set, 'link'));
      at = to;
    }
    while (open.length) out += closeOf(open.pop());
    return out;
  }

  function hasMark(set, type) {
    for (var i = 0; i < set.length; i++) if (set[i].t === type) return true;
    return false;
  }

  function inSet(set, mark) {
    for (var i = 0; i < set.length; i++) if (sameMark(set[i], mark)) return true;
    return false;
  }

  function openOf(mark) {
    return mark.t === 'link' ? '[' : DELIM[mark.t];
  }

  function closeOf(mark) {
    return mark.t === 'link' ? '](' + hrefOut(mark.href) + ')' : DELIM[mark.t];
  }

  // `* x *` is not emphasis in any markdown reader, so a mark that starts or ends on a
  // space is pulled in until it does not. A bare URL that is its own link needs no
  // brackets at all, and reads far better without them.
  function trimMarks(list, s) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      var a = m.s;
      var b = m.e;
      while (a < b && /\s/.test(s.charAt(a))) a++;
      while (b > a && /\s/.test(s.charAt(b - 1))) b--;
      if (b <= a) continue;
      if (m.t === 'link' && s.slice(a, b) === String(m.href || '') && URL_RE.test(s.slice(a, b))) continue;
      out.push({ s: a, e: b, t: m.t, href: m.href });
    }
    return tidyMarks(out, s.length);
  }

  // ── markdown: blocks ──────────────────────────────────────────────────────

  var RE_HEAD = /^( {0,3})(#{1,6})([ \t]+)(.*?)$/;
  var RE_HR = /^( {0,3})((?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
  var RE_TODO = /^([ \t]*)([-*+])([ \t]+)\[([ xX])\]([ \t]+)(.*)$/;
  var RE_UL = /^([ \t]*)([-*+])([ \t]+)(.*)$/;
  var RE_OL = /^([ \t]*)(\d{1,9})([.)])([ \t]+)(.*)$/;
  var RE_QUOTE = /^( {0,3})(>)([ \t]?)(.*)$/;
  var RE_FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)[ \t]*$/;

  function indentSteps(lead) {
    var n = String(lead || '').replace(/\t/g, '  ').length;
    return clamp(Math.floor(n / 2), 0, MAX_INDENT);
  }

  function spec(t, extra) {
    var out = {
      t: t, text: '', marks: [], i: 0,
      ind: '',          // the literal leading whitespace, as the file had it
      mk: '-',          // which bullet character
      n: 1,             // an ordered item's own number…
      dl: '.',          // …and whether it used `.` or `)`
      ck: '',           // a todo's box: '', ' ', 'x' or 'X'
      gap: ' ',         // the whitespace between the marker and the text
      fence: '```',
      lang: '',
      src: '---',       // an hr's own characters
    };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
    return out;
  }

  /** One markdown line → a block spec, with every scrap of its source form kept. */
  function lineBlock(line) {
    var m;
    if ((m = RE_HR.exec(line))) return spec('hr', { ind: m[1], src: m[2] });
    if ((m = RE_HEAD.exec(line))) {
      var got = parseInline(m[4]);
      return spec('h' + m[2].length, { ind: m[1], gap: m[3], text: got.text, marks: got.marks });
    }
    if ((m = RE_TODO.exec(line))) {
      var t1 = parseInline(m[6]);
      return spec('todo', { ind: m[1], i: indentSteps(m[1]), mk: m[2], gap: m[3], ck: m[4], text: t1.text, marks: t1.marks });
    }
    if ((m = RE_UL.exec(line))) {
      var t2 = parseInline(m[4]);
      return spec('ul', { ind: m[1], i: indentSteps(m[1]), mk: m[2], gap: m[3], text: t2.text, marks: t2.marks });
    }
    if ((m = RE_OL.exec(line))) {
      var t3 = parseInline(m[5]);
      return spec('ol', { ind: m[1], i: indentSteps(m[1]), n: Number(m[2]), dl: m[3], gap: m[4], text: t3.text, marks: t3.marks });
    }
    if ((m = RE_QUOTE.exec(line))) {
      var t4 = parseInline(m[4]);
      return spec('quote', { ind: m[1], gap: m[3], text: t4.text, marks: t4.marks });
    }
    var t5 = parseInline(line);
    return spec('p', { text: t5.text, marks: t5.marks });
  }

  /**
   * Markdown → block specs, checking its own work.
   *
   * Every block is written straight back out and compared with the lines it came from.
   * A block that does not reproduce them is not a block this editor can hold — a table,
   * an image, `[ref]: url`, a setext underline, an odd indent — so it becomes a RAW
   * block: the source lines, shown as themselves and saved as themselves. Opening a
   * note therefore cannot change a byte of it, whatever is in it.
   */
  // Markdown this editor has no block for. These lines DO survive a round trip as
  // paragraphs — escapeText leaves them alone — but drawing them as prose is a lie: an
  // image would read as the sentence `!alt text` with the alt hyperlinked, and a table
  // as a row of pipes in the body font. They become raw blocks instead, which is what
  // they are: source.
  var RE_IMAGE = /!\[[^\]\n]*\]\(/;
  var RE_TABLE = /^ {0,3}\|/;
  var RE_TABLE_RULE = /^ {0,3}\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
  var RE_DEF = /^ {0,3}\[[^\]\n]+\]:[ \t]*\S/;
  var RE_HTML = /^ {0,3}<\/?[a-zA-Z][^>]*>/;
  var RE_SETEXT = /^ {0,3}=+[ \t]*$/;

  function undrawable(line) {
    return RE_IMAGE.test(line) || RE_TABLE.test(line) || RE_TABLE_RULE.test(line) ||
      RE_DEF.test(line) || RE_HTML.test(line) || RE_SETEXT.test(line);
  }

  function parseBlocks(md) {
    // No plainSpaces() here: what is in the FILE is the author's, non-breaking spaces
    // included. Only what the contenteditable produces is normalised (readInline).
    var s = String(md === null || md === undefined ? '' : md).replace(/\r\n?/g, '\n');
    if (s.charAt(s.length - 1) === '\n') s = s.slice(0, -1);      // the file's own last newline
    var lines = s.split('\n');
    var out = [];
    var i = 0;
    while (i < lines.length) {
      var from = i;
      var made;
      var f = RE_FENCE.exec(lines[i]);
      if (f) {
        var mark = f[2].charAt(0);
        var body = [];
        i++;
        while (i < lines.length) {
          var close = RE_FENCE.exec(lines[i]);
          if (close && close[2].charAt(0) === mark && close[2].length >= f[2].length && !close[3]) { i++; break; }
          body.push(lines[i]);
          i++;
        }
        made = spec('code', { ind: f[1], fence: f[2], lang: f[3] || '', text: body.join('\n') });
      } else if (undrawable(lines[i])) {
        made = spec('raw', { text: lines[i] });
        i++;
      } else {
        made = lineBlock(lines[i]);
        i++;
      }
      var source = lines.slice(from, i).join('\n');
      out.push(blockToMd(made) === source ? made : spec('raw', { text: source }));
    }
    if (!out.length) out.push(spec('p'));
    return out;
  }

  /** A block spec → its markdown line (or lines, for a fence). */
  function blockToMd(b) {
    var t = b.t;
    if (t === 'raw') return b.text;
    if (t === 'hr') return (b.ind || '') + (b.src || '---');
    if (t === 'code') {
      var content = String(b.text || '');
      var fence = b.fence || '```';
      var tick = fence.charAt(0) === '~' ? '~' : '`';
      // Only a line that WOULD CLOSE this fence forces a longer one — a run of the
      // fence's own character, alone on its line. A ``` inside a ~~~ fence closes
      // nothing, and growing the fence for it would rewrite a file that was fine.
      var need = 3;
      var re = new RegExp('^[ \\t]{0,3}(\\' + tick + '{3,})[ \\t]*$', 'gm');
      var m;
      while ((m = re.exec(content))) need = Math.max(need, m[1].length + 1);
      if (fence.length < need) fence = repeat(tick, need);
      var lead = b.ind || '';
      return lead + fence + (b.lang || '') + '\n' + content + '\n' + lead + fence;
    }
    var body = inlineToMd(b.text, b.marks);
    var gap = b.gap || ' ';
    if (t.charAt(0) === 'h' && t.length === 2) return (b.ind || '') + repeat('#', Number(t.charAt(1))) + gap + body;
    if (t === 'quote') return (b.ind || '') + '>' + (b.gap === '' ? '' : ' ') + body;
    if (t === 'ul') return (b.ind || '') + (b.mk || '-') + gap + body;
    if (t === 'todo') return (b.ind || '') + (b.mk || '-') + gap + '[' + (b.ck || ' ') + ']' + gap + body;
    if (t === 'ol') return (b.ind || '') + (b.n || 1) + (b.dl || '.') + gap + body;
    // A paragraph whose text would read back as another kind of block says so. The
    // test IS the parser, so it can never fall behind it, and so is the check that the
    // escape worked.
    if (body && lineBlock(body).t !== 'p') return escapeBlock(body);
    return body;
  }

  /**
   * A backslash placed where it stops the line being read as a block. Usually in front
   * — `\# not a heading` — but not always: `\1. not a list` is not an escape at all,
   * because a digit is not escapable, and the one that works is `1\. not a list`. So
   * every candidate is tried and the answer is the first that both reads back as a
   * paragraph AND reads back as the SAME paragraph.
   */
  function escapeBlock(body) {
    var tries = [];
    if (ESCAPABLE.test(body.charAt(0))) tries.push('\\' + body);
    for (var i = 1; i < Math.min(body.length, 16); i++) {
      if (ESCAPABLE.test(body.charAt(i))) tries.push(body.slice(0, i) + '\\' + body.slice(i));
    }
    for (var k = 0; k < tries.length; k++) {
      var back = lineBlock(tries[k]);
      if (back.t === 'p' && inlineToMd(back.text, back.marks) === body) return tries[k];
    }
    // Nothing available makes it a paragraph. parseBlocks then keeps the line verbatim
    // as a raw block rather than letting it change shape, so the file is still safe.
    return body;
  }

  // ── selection arithmetic ──────────────────────────────────────────────────

  /** The characters a node stands for: its text, plus one per <br> that is not last. */
  function measure(node) {
    var n = 0;
    var trailing = false;
    var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null);
    var cur;
    while ((cur = walker.nextNode())) {
      if (cur.nodeType === 3) { n += cur.nodeValue.length; trailing = false; continue; }
      if (cur.nodeName === 'BR') { n += 1; trailing = true; continue; }
      trailing = false;
    }
    return trailing ? n - 1 : n;
  }

  /** How many characters of `host` come before the DOM position (node, off). */
  function offsetIn(host, node, off) {
    if (!host || !node || !host.contains(node)) return null;
    var range = document.createRange();
    try {
      range.selectNodeContents(host);
      range.setEnd(node, off);
    } catch (_) {
      return null;
    }
    return measure(range.cloneContents());
  }

  /**
   * A caret at the very END of a <strong>/<em>/<code> is ambiguous: the same place on
   * screen is both "inside the mark" and "after it", and Chromium types into whichever
   * node the Range names. Inside is never what is wanted — finishing `**bold**` and
   * carrying on would put the rest of the sentence in bold too, and so would clicking
   * at the end of a bold word. So a position at the end of a mark is moved out to the
   * `.nbc` itself, just after the element.
   */
  function outsideMark(host, node, at) {
    if (!node || node.nodeType !== 3 || at !== node.nodeValue.length) return null;
    var up = node;
    while (up.parentNode && up.parentNode !== host) {
      if (up.parentNode.lastChild !== up) return null;      // there is more inside the mark
      up = up.parentNode;
    }
    if (!up.parentNode || up === node) return null;         // already a child of .nbc
    return [host, Array.prototype.indexOf.call(host.childNodes, up) + 1];
  }

  /** The DOM position `off` characters into `host`, as [node, offset]. */
  function pointIn(host, off) {
    var want = Math.max(0, off);
    var n = 0;
    var walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null);
    var last = null;
    var cur;
    while ((cur = walker.nextNode())) {
      if (cur.nodeType === 3) {
        var len = cur.nodeValue.length;
        if (want <= n + len) return outsideMark(host, cur, want - n) || [cur, want - n];
        n += len;
        last = cur;
        continue;
      }
      if (cur.nodeName === 'BR') {
        if (want <= n) {
          var parent = cur.parentNode;
          return [parent, Array.prototype.indexOf.call(parent.childNodes, cur)];
        }
        n += 1;
        last = cur;
      }
    }
    if (last && last.nodeType === 3) {
      return outsideMark(host, last, last.nodeValue.length) || [last, last.nodeValue.length];
    }
    return [host, host.childNodes.length];
  }

  // ── the editor ────────────────────────────────────────────────────────────

  var live = [];        // every editor alive, for the one document selectionchange listener

  function create(opts) {
    var o = opts || {};
    var ed = {
      root: null,
      onChange: typeof o.onChange === 'function' ? o.onChange : function () {},
      undo: [],
      redo: [],
      bytes: 0,
      base: null,           // the last committed snapshot; see commit()
      timer: null,
      caret: null,          // the last caret seen inside this editor, for focus()
      quiet: false,         // a programmatic change is in flight: ignore our own events
      composing: false,
      skipRule: false,      // an undo just put a marker back: let the next space be a space
      guard: null,          // where a mark just ended and must not grow past; see keepOut()
      dead: false,
    };

    ed.root = h('div.ne', {
      contenteditable: 'true',
      spellcheck: 'true',
      autocorrect: 'off',
      autocapitalize: 'off',
      role: 'textbox',
      'aria-multiline': 'true',
      'aria-label': 'Note',
    });
    // The placeholder reaches CSS as a custom property rather than an attribute:
    // `content: var(--ph)` is the one way to put a caller's own string in front of an
    // empty block without a node in the way of the caret. JSON.stringify is the
    // quoting — a CSS string is a JSON string.
    try {
      ed.root.style.setProperty('--ph', JSON.stringify(String(o.placeholder || 'Write it down…')));
    } catch (_) { /* the stylesheet's own default stands */ }

    wire(ed);
    setText(ed, '');
    live.push(ed);

    return {
      el: ed.root,
      setText: function (md, at) { setText(ed, md, at); },
      getText: function () { return getText(ed); },
      focus: function () { focus(ed); },
      hasFocus: function () { return hasFocus(ed); },
      isEmpty: function () { return isEmpty(ed); },
      caret: function () { return ed.caret; },
      // Put the caret back where caret() said it was. Not focus(): that returns early
      // once something has already focused the root, which is exactly the case after
      // app.js has re-parented and re-focused a Grid square (views/notes.js mount()).
      placeAt: function (at) { place(ed, at); },
      editAction: function (action, text) { return editAction(ed, action, text); },
      onKey: function (e) { return onKey(ed, e); },
      flush: function () { commit(ed); },
      destroy: function () { destroy(ed); },
    };
  }

  // ── building blocks ───────────────────────────────────────────────────────

  var KEEP = ['ind', 'mk', 'n', 'dl', 'ck', 'gap', 'fence', 'lang', 'src'];

  function makeBlock(b) {
    var t = TYPES[b.t] ? b.t : 'p';
    if (t === 'hr') {
      var rule = h('div.nb', { 'data-t': 'hr', contenteditable: 'false' }, h('hr'));
      rule.setAttribute('data-src', b.src || '---');
      if (b.ind) rule.setAttribute('data-ind', b.ind);
      return rule;
    }
    var el = h('div.nb', { 'data-t': t });
    var fresh = spec(t);
    for (var i = 0; i < KEEP.length; i++) {
      var k = KEEP[i];
      var v = b[k];
      // Only a value that IS the default is left off. Not one that is merely empty:
      // `>text` with no space after the marker has gap '', and dropping it made
      // specOf fall back to ' ' and the first autosave write `> text` — a byte the
      // user never typed, in a file this editor promises not to touch (measured).
      if (v === undefined || v === null || v === fresh[k]) continue;
      el.setAttribute('data-' + k, String(v));
    }
    if (LISTS[t]) el.setAttribute('data-i', String(clamp(b.i || 0, 0, MAX_INDENT)));
    if (t === 'todo') el.setAttribute('data-ck', b.ck || ' ');
    if (t === 'ol') el.setAttribute('data-n', String(b.n || 1));
    var literal = !!LITERAL[t];
    var body = h('div.nbc' + (literal ? '.lit' : ''));
    renderInline(body, b.text || '', b.marks || [], literal);
    el.appendChild(body);
    return el;
  }

  /** The DOM back to a spec — the inverse of makeBlock, and what the serializer reads. */
  function specOf(el) {
    var t = typeOf(el);
    var out = spec(t);
    for (var i = 0; i < KEEP.length; i++) {
      var k = KEEP[i];
      var v = el.getAttribute('data-' + k);
      if (v === null) continue;
      out[k] = k === 'n' ? (Number(v) || 1) : v;
    }
    out.i = clamp(Number(el.getAttribute('data-i')) || 0, 0, MAX_INDENT);
    if (t === 'hr') return out;
    var body = contentOf(el);
    var got = body ? readInline(body, !!LITERAL[t]) : { text: '', marks: [] };
    out.text = got.text;
    out.marks = got.marks;
    return out;
  }

  // Ordered lists count within a run at the same indent. Only a STRUCTURAL edit calls
  // this: a note whose author wrote `1.` three times keeps it until they change the
  // shape of the list, which is when a reader would expect the numbers to follow.
  function renumber(ed) {
    var blocks = ed.root.children;
    var counts = [];
    for (var i = 0; i < blocks.length; i++) {
      var el = blocks[i];
      var t = typeOf(el);
      var depth = clamp(Number(el.getAttribute('data-i')) || 0, 0, MAX_INDENT);
      if (t !== 'ol') {
        if (LISTS[t]) counts.length = Math.min(counts.length, depth + 1);
        else counts.length = 0;
        continue;
      }
      counts.length = Math.min(counts.length, depth + 1);
      counts[depth] = (counts[depth] || 0) + 1;
      el.setAttribute('data-n', String(counts[depth]));
    }
  }

  /**
   * Everything that has to be true of the tree after any edit, ours or Chromium's: at
   * least one block, every direct child a block, every block holding exactly one `.nbc`
   * and nothing else, nothing inside `.nbc` the inline model cannot hold, and never a
   * divider as the last block (there would be nowhere left to type). Returns true when
   * it had to change something, which is the cue to put the caret back.
   */
  function normalize(ed) {
    var root = ed.root;
    var changed = false;

    // Anything Chromium dropped at the top level — a bare text node after a select-all
    // delete, a <div> from a merge across blocks — becomes a paragraph of its own.
    var child = root.firstChild;
    while (child) {
      var next = child.nextSibling;
      if (!isBlock(child)) {
        var text = child.nodeType === 3 ? child.nodeValue : (child.textContent || '');
        root.removeChild(child);
        text = plainSpaces(text).replace(/[\r\n]+/g, ' ');
        if (text.replace(/^\s+|\s+$/g, '')) {
          var made = makeBlock(spec('p', { text: text }));
          if (next) root.insertBefore(made, next); else root.appendChild(made);
        }
        changed = true;
      }
      child = next;
    }

    if (!root.firstChild) { root.appendChild(makeBlock(spec('p'))); changed = true; }

    for (var i = 0; i < root.children.length; i++) {
      if (fixBlock(root.children[i])) changed = true;
    }

    var last = root.lastElementChild;
    if (last && VOID[typeOf(last)]) { root.appendChild(makeBlock(spec('p'))); changed = true; }

    root.classList.toggle('ph', isEmpty(ed));
    return changed;
  }

  function fixBlock(el) {
    var t = typeOf(el);
    var changed = false;
    if (el.getAttribute('data-t') !== t) { el.setAttribute('data-t', t); changed = true; }
    if (t === 'hr') {
      if (el.getAttribute('contenteditable') !== 'false') { el.setAttribute('contenteditable', 'false'); changed = true; }
      if (!el.querySelector('hr')) { D.clear(el); el.appendChild(h('hr')); changed = true; }
      return changed;
    }
    if (el.getAttribute('contenteditable') === 'false') { el.removeAttribute('contenteditable'); changed = true; }

    var literal = !!LITERAL[t];
    var body = el.querySelector('.nbc');
    if (!body) {
      // The content div itself was eaten. Whatever text survived is the block's text.
      var kept = plainSpaces(el.textContent || '');
      D.clear(el);
      body = h('div.nbc' + (literal ? '.lit' : ''));
      renderInline(body, kept, [], literal);
      el.appendChild(body);
      return true;
    }
    // One `.nbc`, and nothing else at block level: a second one from a merge Chromium
    // made itself is folded back in rather than losing what was typed in it.
    var kids = el.children;
    for (var i = kids.length - 1; i >= 0; i--) {
      var kid = kids[i];
      if (kid === body) continue;
      if (kid.nodeType === 1 && kid.classList.contains('nbc')) {
        while (kid.firstChild) body.appendChild(kid.firstChild);
      }
      el.removeChild(kid);
      changed = true;
    }
    // A stray text node beside `.nbc` is a character that would be lost at save time.
    var loose = el.firstChild;
    while (loose) {
      var after = loose.nextSibling;
      if (loose !== body && loose.nodeType === 3) {
        if (loose.nodeValue) body.insertBefore(document.createTextNode(loose.nodeValue), body.firstChild);
        el.removeChild(loose);
        changed = true;
      }
      loose = after;
    }

    if (body.classList.contains('lit') !== literal) { body.classList.toggle('lit', literal); changed = true; }
    var got = readInline(body, literal);
    if (!got.clean) { renderInline(body, got.text, got.marks, literal); changed = true; }
    else body.classList.toggle('nbe', !got.text);
    return changed;
  }

  // ── reading and writing the whole note ────────────────────────────────────

  function getText(ed) {
    var lines = [];
    var blocks = ed.root.children;
    for (var i = 0; i < blocks.length; i++) lines.push(blockToMd(specOf(blocks[i])));
    var out = lines.join('\n');
    // A text file ends with a newline, and parseBlocks takes exactly one back off, so
    // the round trip is an identity. An empty note is an empty file.
    return out ? out + '\n' : '';
  }

  function setText(ed, md, at) {
    ed.quiet = true;
    try {
      var specs = parseBlocks(md);
      D.clear(ed.root);
      for (var i = 0; i < specs.length; i++) ed.root.appendChild(makeBlock(specs[i]));
      normalize(ed);
      if (at) place(ed, at);
    } finally {
      ed.quiet = false;
    }
    ed.base = { md: getText(ed), caret: at || ed.caret };
  }

  function isEmpty(ed) {
    var blocks = ed.root.children;
    if (blocks.length !== 1) return blocks.length === 0;
    var only = blocks[0];
    if (typeOf(only) !== 'p') return false;
    var body = contentOf(only);
    return !body || !plainSpaces(body.textContent || '').replace(/\n/g, '');
  }

  // ── caret ─────────────────────────────────────────────────────────────────

  function selection() {
    var sel = window.getSelection ? window.getSelection() : null;
    return sel && sel.rangeCount ? sel : null;
  }

  function blockAt(ed, node) {
    while (node && node !== ed.root) {
      if (isBlock(node)) return node;
      node = node.parentNode;
    }
    return null;
  }

  function indexOfBlock(ed, el) {
    return Array.prototype.indexOf.call(ed.root.children, el);
  }

  /**
   * A range boundary that sits in the ROOT rather than inside a block — which is where
   * place() puts one for a divider, since a divider has no `.nbc` to hold it, and where
   * Chromium puts one after a select-all. `(root, k)` means "before block k": as a
   * START that is block k at offset 0, as an END it is block k-1 at its own end.
   */
  function rootEdge(ed, off, isEnd) {
    var kids = ed.root.children;
    if (!kids.length) return null;
    var k = clamp(off, 0, kids.length);
    if (!isEnd) {
      if (k >= kids.length) k = kids.length - 1;
      return { el: kids[k], at: 0 };
    }
    if (k <= 0) return { el: kids[0], at: 0 };
    var el = kids[k - 1];
    var host = contentOf(el);
    return { el: el, at: host ? measure(host) : 0 };
  }

  /** Where the caret is, as {b, o, bEnd, oEnd, collapsed} in block/char coordinates. */
  function where(ed) {
    var sel = selection();
    if (!sel) return null;
    var range = sel.getRangeAt(0);
    if (!ed.root.contains(range.startContainer) || !ed.root.contains(range.endContainer)) return null;

    var start = range.startContainer === ed.root
      ? rootEdge(ed, range.startOffset, false)
      : { el: blockAt(ed, range.startContainer), at: null };
    var end = range.endContainer === ed.root
      ? rootEdge(ed, range.endOffset, true)
      : { el: blockAt(ed, range.endContainer), at: null };
    if (!start || !end || !start.el || !end.el) return null;

    var oa = start.at;
    if (oa === null) {
      var ha = contentOf(start.el);
      oa = ha ? offsetIn(ha, range.startContainer, range.startOffset) : 0;
    }
    var ob = end.at;
    if (ob === null) {
      var hb = contentOf(end.el);
      ob = hb ? offsetIn(hb, range.endContainer, range.endOffset) : 0;
    }
    return {
      b: indexOfBlock(ed, start.el), o: oa === null ? 0 : oa,
      bEnd: indexOfBlock(ed, end.el), oEnd: ob === null ? 0 : ob,
      collapsed: range.collapsed,
    };
  }

  function place(ed, at) {
    if (!at) return;
    var blocks = ed.root.children;
    if (!blocks.length) return;
    // Focus FIRST. Chromium drops a range added to an editing host that does not have
    // focus, and a caret that is silently nowhere sends the next keystroke to the
    // window's own shortcuts instead of into the note.
    if (!hasFocus(ed) && ed.root.isConnected) {
      try { ed.root.focus({ preventScroll: true }); } catch (_) { ed.root.focus(); }
    }
    var bi = clamp(at.b || 0, 0, blocks.length - 1);
    var range = document.createRange();
    var spans = at.bEnd !== undefined && at.bEnd !== null && (at.bEnd !== at.b || at.oEnd !== at.o);
    if (!spans) {
      // A CARET cannot live in a divider — Chromium paints no rect for a
      // contenteditable="false" block — so it steps to the nearest block that can hold
      // one, which is what it has always done.
      var host = contentOf(blocks[bi]);
      while (!host && bi < blocks.length - 1) { bi++; host = contentOf(blocks[bi]); }
      while (!host && bi > 0) { bi--; host = contentOf(blocks[bi]); }
      if (!host) return;
      var only = pointIn(host, at.o || 0);
      try { range.setStart(only[0], only[1]); } catch (_) { return; }
      range.collapse(true);
    } else {
      // A RANGE end may sit ON a divider, and must: stepping past it left `at.b`
      // naming a block outside the range, so ⌘A could neither copy nor delete a note
      // that begins with one. where()'s rootEdge() reads such a boundary back.
      try {
        var h0 = contentOf(blocks[bi]);
        if (h0) { var s0 = pointIn(h0, at.o || 0); range.setStart(s0[0], s0[1]); }
        else range.setStartBefore(blocks[bi]);
      } catch (_) {
        return;
      }
      var be = clamp(at.bEnd, 0, blocks.length - 1);
      try {
        var h1 = contentOf(blocks[be]);
        if (h1) { var s1 = pointIn(h1, at.oEnd || 0); range.setEnd(s1[0], s1[1]); }
        else range.setEndAfter(blocks[be]);
      } catch (_) {
        range.collapse(true);
      }
    }
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    ed.caret = where(ed);
  }

  function focus(ed) {
    if (!ed.root.isConnected) return;
    var already = hasFocus(ed) && selection() && ed.root.contains(selection().anchorNode);
    try { ed.root.focus({ preventScroll: true }); } catch (_) { ed.root.focus(); }
    if (already) return;
    var at = ed.caret;
    if (!at) {
      var last = ed.root.children.length - 1;
      var host = contentOf(ed.root.children[last]);
      at = { b: last, o: host ? measure(host) : 0 };
    }
    place(ed, at);
  }

  function hasFocus(ed) {
    var el = document.activeElement;
    return !!el && (el === ed.root || ed.root.contains(el));
  }

  // ── change bookkeeping ────────────────────────────────────────────────────

  function changed(ed) {
    if (ed.quiet) return;
    ed.root.classList.toggle('ph', isEmpty(ed));
    if (ed.timer) clearTimeout(ed.timer);
    ed.timer = setTimeout(function () { ed.timer = null; commit(ed); }, COMMIT_MS);
    ed.onChange();
  }

  /** One undo step. The idle timer is always cleared, so no transform leaves a dead one. */
  function commit(ed) {
    if (ed.dead || ed.composing) return;
    if (ed.timer) { clearTimeout(ed.timer); ed.timer = null; }
    var now = getText(ed);
    if (!ed.base) { ed.base = { md: now, caret: ed.caret }; return; }
    if (ed.base.md === now) { ed.base.caret = ed.caret || ed.base.caret; return; }
    ed.undo.push(ed.base);
    ed.bytes += ed.base.md.length;
    while (ed.undo.length > UNDO_MAX || (ed.bytes > UNDO_BYTES && ed.undo.length > 1)) {
      ed.bytes -= ed.undo.shift().md.length;
    }
    ed.redo.length = 0;
    ed.base = { md: now, caret: ed.caret };
  }

  // A structural edit: close the typing step first, so ⌘Z undoes the transform and a
  // second ⌘Z the typing that led to it, rather than both at once.
  function step(ed, fn) {
    commit(ed);
    ed.quiet = true;
    try {
      fn();
      normalize(ed);
      renumber(ed);
    } finally {
      ed.quiet = false;
    }
    ed.caret = where(ed) || ed.caret;
    commit(ed);
    ed.root.classList.toggle('ph', isEmpty(ed));
    ed.onChange();
  }

  function undo(ed) {
    commit(ed);
    if (!ed.undo.length) return true;
    var to = ed.undo.pop();
    ed.bytes -= to.md.length;
    ed.redo.push({ md: getText(ed), caret: ed.caret });
    setText(ed, to.md, to.caret);
    ed.caret = to.caret || null;
    // The block rules eat the space that fires them, so the state undo restores is
    // `#` with the caret after it. Without this the next space fires the rule again
    // and a literal `# ` could never be typed.
    ed.skipRule = true;
    ed.onChange();
    return true;
  }

  function redo(ed) {
    commit(ed);
    if (!ed.redo.length) return true;
    var to = ed.redo.pop();
    var current = getText(ed);
    ed.undo.push({ md: current, caret: ed.caret });
    ed.bytes += current.length;
    setText(ed, to.md, to.caret);
    ed.caret = to.caret || null;
    ed.onChange();
    return true;
  }

  // ── editing operations ────────────────────────────────────────────────────

  // Turning a block into another kind drops the source form of the old one: a bullet
  // that becomes a heading has no bullet character to keep, and holding on to one would
  // write a stale `data-mk` back into the file.
  function retype(ed, el, t, extra) {
    var was = specOf(el);
    var next = spec(t, extra || {});
    next.text = (extra && extra.text !== undefined) ? extra.text : was.text;
    next.marks = (extra && extra.text !== undefined) ? (extra.marks || []) : was.marks;
    if (next.t === was.t) {
      for (var i = 0; i < KEEP.length; i++) {
        var k = KEEP[i];
        if (!extra || extra[k] === undefined) next[k] = was[k];
      }
    }
    if (LISTS[t] && (!extra || extra.i === undefined)) next.i = LISTS[was.t] ? was.i : 0;
    if (LISTS[t]) next.ind = repeat('  ', next.i);
    if (LITERAL[t]) next.marks = [];
    var made = makeBlock(next);
    el.parentNode.replaceChild(made, el);
    return made;
  }

  /**
   * A code or raw block becomes its LINES, one paragraph each. A plain retype to a
   * paragraph would carry the newlines into one, where readInline turns each of them
   * into a space — one keystroke and a whole fence was a single run-on line.
   */
  function unliteral(ed, el) {
    var b = specOf(el);
    var lines = String(b.text || '').split('\n');
    var made = [];
    for (var i = 0; i < lines.length; i++) made.push(makeBlock(spec('p', { text: lines[i], marks: [] })));
    if (!made.length) made.push(makeBlock(spec('p')));
    var parent = el.parentNode;
    for (i = 0; i < made.length; i++) parent.insertBefore(made[i], el);
    parent.removeChild(el);
    return made[0];
  }

  /** Split a block at `off`; the tail becomes a new block of type `t`. */
  function splitBlock(ed, el, off, t) {
    var b = specOf(el);
    var head = spec(b.t, b);
    head.text = b.text.slice(0, off);
    head.marks = shiftMarks(b.marks, off, b.text.length, 0);
    var tail = spec(t || b.t, LISTS[t || b.t] ? { i: b.i, ind: b.ind, mk: b.mk, dl: b.dl, gap: b.gap } : {});
    tail.text = b.text.slice(off);
    tail.marks = shiftMarks(b.marks, 0, off, 0);
    var a = makeBlock(head);
    var z = makeBlock(tail);
    el.parentNode.replaceChild(a, el);
    if (a.nextSibling) a.parentNode.insertBefore(z, a.nextSibling);
    else a.parentNode.appendChild(z);
    return z;
  }

  function mergeInto(ed, prev, el) {
    var a = specOf(prev);
    var b = specOf(el);
    var at = a.text.length;
    for (var i = 0; i < b.marks.length; i++) {
      a.marks.push({ s: b.marks[i].s + at, e: b.marks[i].e + at, t: b.marks[i].t, href: b.marks[i].href });
    }
    a.text += b.text;
    a.marks = tidyMarks(a.marks, a.text.length);
    var made = makeBlock(a);
    prev.parentNode.replaceChild(made, prev);
    el.parentNode.removeChild(el);
    return { el: made, at: at };
  }

  /** Replace [from, to) of a block's text with {text, marks}. */
  function spliceInline(el, from, to, text, marks) {
    var b = specOf(el);
    var lo = clamp(Math.min(from, to), 0, b.text.length);
    var hi = clamp(Math.max(from, to), 0, b.text.length);
    var kept = shiftMarks(b.marks, lo, hi, text.length);
    for (var i = 0; i < (marks || []).length; i++) {
      kept.push({ s: marks[i].s + lo, e: marks[i].e + lo, t: marks[i].t, href: marks[i].href });
    }
    b.text = b.text.slice(0, lo) + text + b.text.slice(hi);
    b.marks = tidyMarks(kept, b.text.length);
    var made = makeBlock(b);
    el.parentNode.replaceChild(made, el);
    return made;
  }

  function sliceSpec(b, from, to) {
    var out = spec(b.t, b);
    out.text = b.text.slice(from, to);
    var marks = [];
    for (var i = 0; i < b.marks.length; i++) {
      var s = clamp(b.marks[i].s - from, 0, out.text.length);
      var e = clamp(b.marks[i].e - from, 0, out.text.length);
      if (e > s) marks.push({ s: s, e: e, t: b.marks[i].t, href: b.marks[i].href });
    }
    out.marks = marks;
    return out;
  }

  function joinSpecs(a, b) {
    var out = spec(a.t, a);
    out.text = a.text;
    out.marks = a.marks.slice();
    var at = out.text.length;
    for (var i = 0; i < (b.marks || []).length; i++) {
      out.marks.push({ s: b.marks[i].s + at, e: b.marks[i].e + at, t: b.marks[i].t, href: b.marks[i].href });
    }
    out.text += b.text || '';
    out.marks = tidyMarks(out.marks, out.text.length);
    return out;
  }

  /** Remove whatever is selected. Returns the block the caret ends up in. */
  function deleteRange(ed, at) {
    var a = Math.min(at.b, at.bEnd);
    var z = Math.max(at.b, at.bEnd);
    var oa = at.b <= at.bEnd ? at.o : at.oEnd;
    var oz = at.b <= at.bEnd ? at.oEnd : at.o;
    if (a === z) {
      var one = spliceInline(ed.root.children[a], Math.min(oa, oz), Math.max(oa, oz), '', []);
      place(ed, { b: indexOfBlock(ed, one), o: Math.min(oa, oz) });
      return one;
    }
    var head = specOf(ed.root.children[a]);
    var tail = specOf(ed.root.children[z]);
    var kept = head.t === 'hr' ? spec('p') : sliceSpec(head, 0, oa);
    var rest = tail.t === 'hr' ? spec('p') : sliceSpec(tail, oz, tail.text.length);
    // What survives takes the HEAD's kind only while the head still has text in it.
    // Otherwise it takes the tail's, and when nothing at all is left it is a plain
    // paragraph — ⌘A then Cut over a list used to leave a stray `- ` behind, so the
    // note could never be emptied. And prose joined onto code, or the other way, stays
    // TWO blocks: folding one into the other silently drops a fence.
    var whole = a === 0 && z === ed.root.children.length - 1;
    var made = [];
    if (kept.text && rest.text && !!LITERAL[kept.t] !== !!LITERAL[rest.t]) {
      made.push(makeBlock(kept), makeBlock(rest));
    } else if (!kept.text && !rest.text) {
      // Nothing survives. The WHOLE note selected means an empty note, which is one
      // empty paragraph — what isEmpty() and the placeholder read. A run of items in
      // the middle of a list keeps the list's own kind instead.
      made.push(makeBlock(whole ? spec('p') : spec(kept.t, kept)));
    } else if (!kept.text) {
      made.push(makeBlock(spec(rest.t, rest)));
    } else {
      made.push(makeBlock(joinSpecs(kept, rest)));
    }
    for (var k = z; k > a; k--) {
      var gone = ed.root.children[k];
      if (gone) gone.parentNode.removeChild(gone);
    }
    var first = ed.root.children[a];
    for (var j = 0; j < made.length; j++) first.parentNode.insertBefore(made[j], first);
    first.parentNode.removeChild(first);
    place(ed, { b: indexOfBlock(ed, made[0]), o: kept.text.length });
    return made[0];
  }

  // ── input rules ───────────────────────────────────────────────────────────

  // What `<marker><space>` at the very start of a block turns it into.
  var PREFIX = [
    { re: /^(#{1,6})$/, t: null },                    // the count decides which heading
    { re: /^[-*+]$/, t: 'ul' },
    { re: /^(\d{1,9})[.)]$/, t: 'ol' },
    // `[]` and `[ ]` are one pattern: the head is matched with its whitespace runs
    // collapsed, so a box with a space in it is reachable at all (it was not).
    { re: /^\[ ?\]$/, t: 'todo', ck: ' ' },
    { re: /^\[[xX]\]$/, t: 'todo', ck: 'x' },
    // The bullet forms are for a head the `- ` rule did not already eat — after an
    // undo, which arms skipRule precisely so the next space stays a space.
    { re: /^[-*+] ?\[ ?\]$/, t: 'todo', ck: ' ' },
    { re: /^[-*+] ?\[[xX]\]$/, t: 'todo', ck: 'x' },
    { re: /^>$/, t: 'quote' },
  ];

  /** The space that turns `## ` into a heading. True when it did. */
  function prefixRule(ed, el, off) {
    if (LITERAL[typeOf(el)]) return false;
    var b = specOf(el);
    if (off <= 0 || off > 12 || off > b.text.length) return false;
    var head = b.text.slice(0, off);
    // Three of the patterns spell a space — `[ ]` is how a task is usually written — so
    // only whitespace at either END rules a head out; every pattern is anchored at both
    // ends, so the anchors reject the rest. A run inside collapses, which makes
    // `-  [ ]` read as `- [ ]`. `off`, never the collapsed string's length, stays the
    // slice point for the text that is left.
    if (/^\s|\s$/.test(head)) return false;
    var key = head.replace(/\s+/g, ' ');
    for (var i = 0; i < PREFIX.length; i++) {
      var m = PREFIX[i].re.exec(key);
      if (!m) continue;
      // A code mark over the marker means the user typed it as code on purpose.
      for (var k = 0; k < b.marks.length; k++) {
        if (b.marks[k].t === 'code' && b.marks[k].s < off) return false;
      }
      var rule = PREFIX[i];
      var t = rule.t || ('h' + Math.min(6, m[1].length));
      var extra = {
        text: b.text.slice(off),
        marks: shiftMarks(b.marks, 0, off, 0),
      };
      if (rule.ck) extra.ck = rule.ck;
      if (t === 'ol' && m[1]) extra.n = Number(m[1]) || 1;
      step(ed, function () {
        var made = retype(ed, el, t, extra);
        place(ed, { b: indexOfBlock(ed, made), o: 0 });
      });
      return true;
    }
    return false;
  }

  // The inline pairs, tried against the text ENDING at the caret.
  var PAIRS = [
    { end: '`', re: /(?:^|[^`])(`)([^`\n]+)`$/, t: 'code' },
    { end: '*', re: /\*\*(?!\s)([^\n]+?)\*\*$/, t: 'strong' },
    { end: '~', re: /~~(?!\s)([^\n]+?)~~$/, t: 'del' },
    { end: '*', re: /(?:^|[^*])\*(?![\s*])([^*\n]+?)\*$/, t: 'em', lead: true },
    { end: ')', re: /\[([^\]\n]+)\]\(([^)\s]+)\)$/, t: 'link' },
  ];

  /** The second `*` that turns `**bold**` into bold. True when it did. */
  function inlineRule(ed, typed) {
    var at = where(ed);
    if (!at || !at.collapsed) return false;
    var el = ed.root.children[at.b];
    if (!el || LITERAL[typeOf(el)]) return false;
    var b = specOf(el);
    var head = b.text.slice(0, at.o);

    for (var i = 0; i < PAIRS.length; i++) {
      var rule = PAIRS[i];
      if (rule.end !== typed) continue;
      var m = rule.re.exec(head);
      if (!m) continue;
      // A `lead` pattern matches one character before the opening delimiter so it
      // cannot fire inside `**`; that character is not part of the match.
      var from = m.index;
      if (rule.lead && !/^[*_]/.test(m[0])) from += 1;
      if (rule.t === 'code' && m[0].charAt(0) !== '`') from += 1;
      var to = at.o;
      var inner = rule.t === 'code' ? m[2] : m[1];
      if (!inner) continue;
      var blocked = false;
      for (var k = 0; k < b.marks.length; k++) {
        if (b.marks[k].t === 'code' && b.marks[k].s < to && b.marks[k].e > from) blocked = true;
      }
      if (blocked) continue;

      var inside = rule.t === 'code' ? { text: inner, marks: [] } : parseInline(inner);
      var mark = { s: 0, e: inside.text.length, t: rule.t, href: rule.t === 'link' ? m[2] : null };
      var target = from + inside.text.length;
      (function (f, t2, bodyIn, mk, caretAt) {
        step(ed, function () {
          var made = spliceInline(el, f, t2, bodyIn.text, bodyIn.marks.concat([mk]));
          place(ed, { b: indexOfBlock(ed, made), o: caretAt });
          ed.guard = { b: indexOfBlock(ed, made), o: caretAt, t: mk.t };
        });
      })(from, to, inside, mark, target);
      return true;
    }
    return false;
  }

  /** The whole-block rules that fire the moment the text is right: ``` and ---. */
  function wholeRule(ed) {
    if (ed.skipRule) return false;
    var at = where(ed);
    if (!at || !at.collapsed) return false;
    var el = ed.root.children[at.b];
    if (!el) return false;
    var t = typeOf(el);
    if (LITERAL[t] || t === 'hr') return false;
    var text = specOf(el).text;
    if (text === '```' || text === '~~~') {
      step(ed, function () {
        var made = retype(ed, el, 'code', { text: '', marks: [], fence: text });
        place(ed, { b: indexOfBlock(ed, made), o: 0 });
      });
      return true;
    }
    if (t === 'p' && (text === '---' || text === '***' || text === '___')) {
      step(ed, function () {
        // `***`, not the `---` that was typed: a `---` on the line under a paragraph is
        // a setext heading to every other markdown reader, this app's own included.
        var made = retype(ed, el, 'hr', { src: '***' });
        var after = makeBlock(spec('p'));
        if (made.nextSibling) made.parentNode.insertBefore(after, made.nextSibling);
        else made.parentNode.appendChild(after);
        place(ed, { b: indexOfBlock(ed, after), o: 0 });
      });
      return true;
    }
    return false;
  }

  /**
   * A URL followed by a space becomes a link, the way it does everywhere else. Unlike
   * the block rules, this one does NOT eat the space that fired it — the space is part
   * of the sentence, not part of the shortcut — so it puts it in itself, outside the
   * link, and leaves the caret after it.
   */
  function linkRule(ed, el, off) {
    if (LITERAL[typeOf(el)]) return false;
    var b = specOf(el);
    var head = b.text.slice(0, off);
    var m = /(^|\s)(https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]])$/.exec(head);
    if (!m) return false;
    var from = off - m[2].length;
    for (var k = 0; k < b.marks.length; k++) {
      if (b.marks[k].s < off && b.marks[k].e > from) return false;   // already marked
    }
    step(ed, function () {
      var made = spliceInline(el, from, off, m[2] + ' ', [{ s: 0, e: m[2].length, t: 'link', href: m[2] }]);
      place(ed, { b: indexOfBlock(ed, made), o: off + 1 });
    });
    return true;
  }

  /**
   * Finishing `**bold**` and carrying on must not bold the rest of the sentence.
   *
   * Placing the caret after the <strong> is not enough on its own: Chromium computes a
   * "typing style" from what is before the caret, so the next character goes inside the
   * element whatever the Range said. So the rule leaves a note of where the mark ended,
   * and the first keystroke past it clips the mark back to there and re-renders — after
   * which the new text really is in a plain node and everything after it follows.
   */
  function keepOut(ed) {
    var g = ed.guard;
    if (!g) return false;
    var at = where(ed);
    if (!at || at.b !== g.b || at.o <= g.o) {
      if (at && (at.b !== g.b || at.o < g.o)) ed.guard = null;
      return false;
    }
    ed.guard = null;
    var el = ed.root.children[g.b];
    if (!el) return false;
    var b = specOf(el);
    var clipped = false;
    for (var i = 0; i < b.marks.length; i++) {
      if (b.marks[i].t === g.t && b.marks[i].s < g.o && b.marks[i].e > g.o) {
        b.marks[i].e = g.o;
        clipped = true;
      }
    }
    if (!clipped) return false;
    b.marks = tidyMarks(b.marks, b.text.length);
    var made = makeBlock(b);
    el.parentNode.replaceChild(made, el);
    place(ed, { b: indexOfBlock(ed, made), o: at.o });
    return true;
  }

  // ── keys ──────────────────────────────────────────────────────────────────

  function onKey(ed, e) {
    if (ed.composing || e.isComposing || e.keyCode === 229) return false;
    if (e.metaKey || e.ctrlKey) return metaKey(ed, e);
    if (e.altKey) return false;
    var used = false;
    if (e.key === ' ') used = spaceKey(ed, e);
    else if (e.key === 'Enter') used = enterKey(ed, e);
    else if (e.key === 'Backspace') used = backspaceKey(ed, e);
    else if (e.key === 'Delete') used = deleteKey(ed, e);
    else if (e.key === 'Tab') used = tabKey(ed, e);
    if (e.key !== 'Shift' && e.key !== 'Meta' && e.key !== 'Control' && e.key !== 'Alt') {
      if (e.key !== ' ') ed.skipRule = false;
    }
    return used;
  }

  function metaKey(ed, e) {
    if (e.altKey) return false;
    var k = String(e.key || '').toLowerCase();
    if (k === 'b' && !e.shiftKey) return mark(ed, 'strong');
    if (k === 'i' && !e.shiftKey) return mark(ed, 'em');
    if (k === 'e' && !e.shiftKey) return mark(ed, 'code');
    // Chromium has a native editing binding for ⌘U in editable content and there is no
    // underline in markdown: swallowed, so it cannot put a <u> in the tree.
    if (k === 'u' && !e.shiftKey) return true;
    if (k === 'x' && e.shiftKey) return mark(ed, 'del');
    // e.code, not e.key: with Shift held a US layout reports '!' '@' '#' ')' for the
    // digit row, so `k >= '1'` never matched and the heading shortcuts did nothing.
    if (e.shiftKey && /^Digit[123]$/.test(String(e.code || ''))) return heading(ed, 'h' + e.code.slice(5));
    if (e.shiftKey && e.code === 'Digit0') return heading(ed, 'p');
    if (k === 'z' && !e.shiftKey) return undo(ed);
    if ((k === 'z' && e.shiftKey) || (k === 'y' && !e.shiftKey)) return redo(ed);
    return false;
  }

  function spaceKey(ed, e) {
    var at = where(ed);
    if (!at || !at.collapsed) return false;
    var el = ed.root.children[at.b];
    if (!el) return false;
    if (ed.skipRule) { ed.skipRule = false; return false; }
    if (prefixRule(ed, el, at.o)) return true;
    if (linkRule(ed, el, at.o)) return true;
    return false;
  }

  function enterKey(ed, e) {
    var at = where(ed);
    if (!at) return false;
    var el = ed.root.children[at.b];
    if (!el) return false;
    var t = typeOf(el);

    if (LITERAL[t] && !e.shiftKey) {
      // A code block is the one block that holds newlines. The browser would put a
      // <div> or a <br> here; a plain \n is what the model and the fence both want.
      step(ed, function () {
        var target = at.collapsed ? el : deleteRange(ed, at);
        var here = where(ed) || { b: indexOfBlock(ed, target), o: at.o };
        var block = ed.root.children[here.b] || target;
        var made = spliceInline(block, here.o, here.o, '\n', []);
        place(ed, { b: indexOfBlock(ed, made), o: here.o + 1 });
      });
      return true;
    }
    if (LITERAL[t]) {
      // ⇧Enter: out of the code block and on with the prose.
      step(ed, function () {
        var after = makeBlock(spec('p'));
        if (el.nextSibling) el.parentNode.insertBefore(after, el.nextSibling);
        else el.parentNode.appendChild(after);
        place(ed, { b: indexOfBlock(ed, after), o: 0 });
      });
      return true;
    }

    var b = specOf(el);
    // Enter on an empty list item or quote steps back out rather than making another
    // empty one — the way every list editor behaves.
    if (at.collapsed && !b.text && (LISTS[t] || t === 'quote')) {
      step(ed, function () {
        var made = (LISTS[t] && b.i > 0)
          ? retype(ed, el, t, { i: b.i - 1 })
          : retype(ed, el, 'p');
        place(ed, { b: indexOfBlock(ed, made), o: 0 });
      });
      return true;
    }

    step(ed, function () {
      var target = at.collapsed ? el : deleteRange(ed, at);
      var here = where(ed) || { b: indexOfBlock(ed, target), o: at.o };
      var block = ed.root.children[here.b] || target;
      var kind = typeOf(block);
      var next = LISTS[kind] || kind === 'quote' ? kind : 'p';
      var made = splitBlock(ed, block, here.o, next);
      // A new todo starts unticked, whatever the one above it was.
      if (next === 'todo') made.setAttribute('data-ck', ' ');
      place(ed, { b: indexOfBlock(ed, made), o: 0 });
    });
    return true;
  }

  function backspaceKey(ed, e) {
    var at = where(ed);
    if (!at) return false;
    if (!at.collapsed) return false;                       // beforeinput owns a range delete
    var el = ed.root.children[at.b];
    if (!el || at.o > 0) return false;
    var t = typeOf(el);
    var b = specOf(el);

    // At the very start of a block, Backspace unwinds what the block IS before it
    // touches what is in it: an indented item outdents, a formatted block goes back to
    // a paragraph, and only a plain paragraph merges into the one above.
    if (LISTS[t] && b.i > 0) {
      step(ed, function () {
        var made = retype(ed, el, t, { i: b.i - 1 });
        place(ed, { b: indexOfBlock(ed, made), o: 0 });
      });
      return true;
    }
    if (t !== 'p') {
      step(ed, function () {
        var made = LITERAL[t] ? unliteral(ed, el) : retype(ed, el, 'p');
        place(ed, { b: indexOfBlock(ed, made), o: 0 });
      });
      return true;
    }
    var prev = el.previousElementSibling;
    if (!prev) return true;                                // the first block; nothing above
    step(ed, function () {
      if (VOID[typeOf(prev)]) {
        prev.parentNode.removeChild(prev);
        place(ed, { b: indexOfBlock(ed, el), o: 0 });
        return;
      }
      if (LITERAL[typeOf(prev)]) {
        // Joining prose onto code would make it code. Step into the code block instead.
        var host = contentOf(prev);
        place(ed, { b: indexOfBlock(ed, prev), o: host ? measure(host) : 0 });
        return;
      }
      var joined = mergeInto(ed, prev, el);
      place(ed, { b: indexOfBlock(ed, joined.el), o: joined.at });
    });
    return true;
  }

  function deleteKey(ed, e) {
    var at = where(ed);
    if (!at || !at.collapsed) return false;
    var el = ed.root.children[at.b];
    if (!el) return false;
    var host = contentOf(el);
    if (!host || at.o < measure(host)) return false;
    var next = el.nextElementSibling;
    if (!next) return true;
    step(ed, function () {
      // A divider is the only neighbour this key removes. A code or raw block is NOT:
      // one keystroke used to delete the whole fence and everything in it, which the
      // autosave then wrote. Step into it instead, as Backspace does the other way.
      if (VOID[typeOf(next)]) {
        next.parentNode.removeChild(next);
        place(ed, { b: indexOfBlock(ed, el), o: at.o });
        return;
      }
      if (LITERAL[typeOf(next)] || LITERAL[typeOf(el)]) {
        place(ed, { b: indexOfBlock(ed, next), o: 0 });
        return;
      }
      var joined = mergeInto(ed, el, next);
      place(ed, { b: indexOfBlock(ed, joined.el), o: joined.at });
    });
    return true;
  }

  function tabKey(ed, e) {
    var at = where(ed);
    if (!at) return false;
    var el = ed.root.children[at.b];
    if (!el) return false;
    var t = typeOf(el);
    if (LITERAL[t]) {
      if (e.shiftKey) return true;
      // `at.oEnd` is an offset in at.bEnd's block, not in this one: splicing with it
      // deleted an arbitrary run of the code's own text and left the selection alone.
      if (!at.collapsed && at.b !== at.bEnd) return true;
      step(ed, function () {
        var to = at.collapsed ? at.o : at.oEnd;
        var made = spliceInline(el, at.o, to, '  ', []);
        place(ed, { b: indexOfBlock(ed, made), o: Math.min(at.o, to) + 2 });
      });
      return true;
    }
    if (!LISTS[t]) return false;                           // Tab still leaves the note
    var b = specOf(el);
    var want = clamp(b.i + (e.shiftKey ? -1 : 1), 0, MAX_INDENT);
    if (want === b.i) return true;
    step(ed, function () {
      var made = retype(ed, el, t, { i: want, ind: repeat('  ', want) });
      place(ed, { b: indexOfBlock(ed, made), o: at.o });
    });
    return true;
  }

  function heading(ed, t) {
    var at = where(ed);
    if (!at) return false;
    var el = ed.root.children[at.b];
    if (!el || typeOf(el) === 'hr') return false;
    var want = typeOf(el) === t ? 'p' : t;
    step(ed, function () {
      var made = LITERAL[typeOf(el)] ? unliteral(ed, el) : retype(ed, el, want);
      if (LITERAL[typeOf(el)] && want !== 'p') made = retype(ed, made, want);
      place(ed, { b: indexOfBlock(ed, made), o: at.o });
    });
    return true;
  }

  /** ⌘B and friends, over whatever is selected. */
  function mark(ed, type) {
    var at = where(ed);
    if (!at || at.collapsed) return true;                  // nothing selected: nothing to do
    var a = Math.min(at.b, at.bEnd);
    var z = Math.max(at.b, at.bEnd);
    var oa = at.b <= at.bEnd ? at.o : at.oEnd;
    var oz = at.b <= at.bEnd ? at.oEnd : at.o;
    step(ed, function () {
      for (var i = a; i <= z; i++) {
        var el = ed.root.children[i];
        if (!el || VOID[typeOf(el)] || LITERAL[typeOf(el)]) continue;
        var b = specOf(el);
        var from = i === a ? Math.min(oa, b.text.length) : 0;
        var to = i === z ? Math.min(oz, b.text.length) : b.text.length;
        if (a === z) { from = Math.min(oa, oz); to = Math.max(oa, oz); }
        if (to <= from) continue;
        b.marks = toggleMark(b.marks, from, to, type, null);
        el.parentNode.replaceChild(makeBlock(b), el);
      }
      place(ed, { b: a, o: a === z ? Math.min(oa, oz) : oa, bEnd: z, oEnd: a === z ? Math.max(oa, oz) : oz });
    });
    return true;
  }

  // ── selection as markdown, and putting markdown back ──────────────────────

  /** The selection, as markdown — so text copied out of a note pastes back as itself. */
  function selectionMd(ed) {
    var at = where(ed);
    if (!at || at.collapsed) return '';
    var a = Math.min(at.b, at.bEnd);
    var z = Math.max(at.b, at.bEnd);
    var oa = at.b <= at.bEnd ? at.o : at.oEnd;
    var oz = at.b <= at.bEnd ? at.oEnd : at.o;
    if (a === z) {
      var only = specOf(ed.root.children[a]);
      var lo = Math.min(oa, oz);
      var hi = Math.max(oa, oz);
      if (only.t === 'hr') return blockToMd(only);
      if (LITERAL[only.t]) return only.text.slice(lo, hi);
      // A partial line is text, not a block: no `- ` and no `## ` in front of it.
      if (lo === 0 && hi >= only.text.length) return blockToMd(only);
      return inlineToMd(only.text.slice(lo, hi), sliceSpec(only, lo, hi).marks);
    }
    var lines = [];
    for (var i = a; i <= z; i++) {
      var b = specOf(ed.root.children[i]);
      if (b.t === 'hr') { lines.push(blockToMd(b)); continue; }
      var from = i === a ? oa : 0;
      var to = i === z ? oz : b.text.length;
      var whole = from === 0 && to >= b.text.length;
      if (LITERAL[b.t]) { lines.push(whole ? blockToMd(b) : b.text.slice(from, to)); continue; }
      if (whole) { lines.push(blockToMd(b)); continue; }
      // A partially selected line is TEXT, not a block: the single-block branch above
      // says so, and this one used to keep the `# ` or `- ` in front of it, so pasting
      // the middle of a heading made a heading. Written as a PARAGRAPH rather than with
      // bare inlineToMd, so it keeps the backslash that stops `- b` pasting back as a
      // bullet.
      var cut = sliceSpec(b, from, to);
      lines.push(blockToMd(spec('p', { text: cut.text, marks: cut.marks })));
    }
    return lines.join('\n');
  }

  /**
   * After a deletion and nothing else: a note left holding one empty block that is not
   * a paragraph is a note that cannot be emptied — ⌘A then Cut over a one-line list
   * wrote `- ` back to the file and isEmpty() stayed false. Not inside deleteRange:
   * Enter and paste come through the same single-block path and must keep the bullet
   * they are splitting.
   */
  function settleEmpty(ed) {
    if (ed.root.children.length !== 1) return;
    var only = ed.root.children[0];
    var t = typeOf(only);
    if (t === 'p' || t === 'hr') return;
    if (specOf(only).text) return;
    var made = LITERAL[t] ? unliteral(ed, only) : retype(ed, only, 'p');
    place(ed, { b: indexOfBlock(ed, made), o: 0 });
  }

  /** Put markdown in at the caret, replacing whatever is selected. */
  function insertMd(ed, md) {
    var text = plainSpaces(String(md === null || md === undefined ? '' : md)).replace(/\r\n?/g, '\n');
    if (!text) return true;
    step(ed, function () {
      var at = where(ed);
      if (!at) return;
      var target = at.collapsed ? ed.root.children[at.b] : deleteRange(ed, at);
      var here = where(ed) || { b: indexOfBlock(ed, target), o: 0 };
      var el = ed.root.children[here.b];
      if (!el) return;

      // Inside a code block, and for a paste with no line break in it, the text goes in
      // AS TEXT: a shell snippet pasted into a fence must not sprout headings, and a
      // pasted word must not split the paragraph it lands in.
      if (LITERAL[typeOf(el)] || text.indexOf('\n') === -1) {
        var plain = LITERAL[typeOf(el)] ? { text: text, marks: [] } : parseInline(text);
        var one = spliceInline(el, here.o, here.o, plain.text, plain.marks);
        place(ed, { b: indexOfBlock(ed, one), o: here.o + plain.text.length });
        return;
      }

      var specs = parseBlocks(text.charAt(text.length - 1) === '\n' ? text : text + '\n');
      var b = specOf(el);
      var headSpec = sliceSpec(b, 0, here.o);
      var tailSpec = sliceSpec(b, here.o, b.text.length);
      var made = [];
      var first = specs[0];
      // The first pasted block joins the text before the caret, and the last one the
      // text after it, the way pasting into a paragraph works everywhere.
      if (!LITERAL[first.t] && first.t !== 'hr' && !VOID[first.t] && headSpec.text) {
        specs[0] = joinSpecs(headSpec, first);
      } else if (headSpec.text || specs.length === 0) {
        made.push(makeBlock(headSpec));
      }
      var last = specs[specs.length - 1];
      var caretAt = String(last.text || '').length;
      if (tailSpec.text) {
        if (!LITERAL[last.t] && last.t !== 'hr') specs[specs.length - 1] = joinSpecs(last, tailSpec);
      }
      for (var i = 0; i < specs.length; i++) made.push(makeBlock(specs[i]));
      if (tailSpec.text && (LITERAL[last.t] || last.t === 'hr')) {
        made.push(makeBlock(tailSpec));
        caretAt = 0;
      }
      var caretBlock = made[made.length - 1];
      var parent = el.parentNode;
      for (i = 0; i < made.length; i++) parent.insertBefore(made[i], el);
      parent.removeChild(el);
      place(ed, { b: indexOfBlock(ed, caretBlock), o: caretAt });
    });
    return true;
  }

  // ── the Edit menu ─────────────────────────────────────────────────────────

  function toClipboard(text) {
    var api = window.sb;
    if (api && typeof api.writeClipboard === 'function') {
      Promise.resolve(api.writeClipboard(String(text)))['catch'](function () {});
    }
  }

  function editAction(ed, action, text) {
    if (!hasFocus(ed)) return false;
    if (action === 'undo') return undo(ed);
    if (action === 'redo') return redo(ed);
    if (action === 'selectAll') {
      var last = ed.root.children.length - 1;
      var host = contentOf(ed.root.children[last]);
      place(ed, { b: 0, o: 0, bEnd: last, oEnd: host ? measure(host) : 0 });
      return true;
    }
    if (action === 'copy' || action === 'cut') {
      // A collapsed selection is not a cut. execCommand('delete') would take the
      // character before the caret instead, which is a silent edit nobody asked for.
      var md = selectionMd(ed);
      if (!md) return true;
      toClipboard(md);
      if (action === 'cut') {
        step(ed, function () {
          var at = where(ed);
          if (at && !at.collapsed) deleteRange(ed, at);
          settleEmpty(ed);
        });
      }
      return true;
    }
    if (action === 'paste') return insertMd(ed, typeof text === 'string' ? text : '');
    return false;
  }

  // ── wiring ────────────────────────────────────────────────────────────────

  // The input types that rewrite more than the text inside one block, or that would
  // run the browser's own history over a DOM the model owns.
  var OWN = {
    historyUndo: 1, historyRedo: 1,
    formatBold: 1, formatItalic: 1, formatUnderline: 1, formatStrikeThrough: 1,
    insertFromPaste: 1, insertFromDrop: 1, insertFromPasteAsQuotation: 1,
    insertOrderedList: 1, insertUnorderedList: 1, formatBlock: 1,
  };

  function wire(ed) {
    ed.root.addEventListener('compositionstart', function () { ed.composing = true; });
    ed.root.addEventListener('compositionend', function () {
      ed.composing = false;
      var at = where(ed);
      if (normalize(ed) && at) place(ed, at);
      ed.caret = where(ed);
      changed(ed);
    });

    ed.root.addEventListener('keydown', function (e) {
      if (onKey(ed, e)) { e.preventDefault(); e.stopPropagation(); }
    });

    // Chromium's own editing is allowed to run only INSIDE one block. Anything that
    // would reach across two — typing over a selection, Option+Delete at a boundary, a
    // paste, a drop — is done here instead, because its merge moves the tail's nodes
    // into the head's `.nb` rather than its `.nbc`, and text outside `.nbc` is text the
    // save silently loses.
    ed.root.addEventListener('beforeinput', function (e) {
      if (ed.quiet || ed.composing) return;
      var type = String(e.inputType || '');
      if (OWN[type]) {
        e.preventDefault();
        if (type === 'historyUndo') undo(ed);
        else if (type === 'historyRedo') redo(ed);
        return;
      }
      var at = where(ed);
      if (!at || at.b === at.bEnd) return;
      e.preventDefault();
      var typed = typeof e.data === 'string' ? e.data : '';
      step(ed, function () {
        var made = deleteRange(ed, at);
        if (!typed) { settleEmpty(ed); return; }
        var here = where(ed) || { b: indexOfBlock(ed, made), o: 0 };
        var block = ed.root.children[here.b] || made;
        var body = LITERAL[typeOf(block)] ? { text: typed, marks: [] } : parseInline(typed);
        var next = spliceInline(block, here.o, here.o, body.text, body.marks);
        place(ed, { b: indexOfBlock(ed, next), o: here.o + body.text.length });
      });
    });

    ed.root.addEventListener('input', function (e) {
      if (ed.quiet || ed.composing) return;
      var at = where(ed);
      if (normalize(ed) && at) place(ed, at);
      keepOut(ed);
      var type = String(e.inputType || '');
      if (type === 'insertText' && typeof e.data === 'string' && e.data.length === 1 && !ed.skipRule) {
        if (inlineRule(ed, e.data)) return;
      }
      if (type.slice(0, 6) === 'insert' && wholeRule(ed)) return;
      ed.caret = where(ed);
      changed(ed);
    });

    // A real paste can still arrive — the right-click menu, a middle click — and the
    // browser's own would drop a page of HTML into the note.
    ed.root.addEventListener('paste', function (e) {
      e.preventDefault();
      var data = e.clipboardData;
      insertMd(ed, data ? data.getData('text/plain') : '');
    });

    // Chromium's own drag of a selection moves the HTML — `.nb` divs and all — into
    // the middle of a `.nbc`. Nothing here drags.
    ed.root.addEventListener('dragstart', function (e) { e.preventDefault(); });
    ed.root.addEventListener('dragover', function (e) {
      var types = e.dataTransfer && e.dataTransfer.types;
      var files = !!types && Array.prototype.indexOf.call(types, 'Files') !== -1;
      e.preventDefault();
      e.dataTransfer.dropEffect = files ? 'none' : 'copy';
    });
    ed.root.addEventListener('drop', function (e) {
      e.preventDefault();
      var data = e.dataTransfer;
      var text = data ? data.getData('text/plain') : '';
      if (!text) return;
      // Where it was dropped, not where the caret happened to be.
      if (document.caretRangeFromPoint) {
        var range = document.caretRangeFromPoint(e.clientX, e.clientY);
        if (range && ed.root.contains(range.startContainer)) {
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
      insertMd(ed, text);
    });

    ed.root.addEventListener('mousedown', function (e) {
      // The checkbox is drawn by CSS in the block's left gutter, so a click on it is a
      // click on the block left of its text. Taken on mousedown, before the caret moves.
      var el = e.target && e.target.closest ? e.target.closest('.nb') : null;
      if (!el || typeOf(el) !== 'todo' || !ed.root.contains(el)) return;
      var box = el.getBoundingClientRect();
      var body = contentOf(el);
      var edge = body ? body.getBoundingClientRect().left : box.left;
      if (e.clientX >= edge - 2) return;
      e.preventDefault();
      var on = el.getAttribute('data-ck') !== ' ';
      step(ed, function () {
        var made = retype(ed, el, 'todo', { ck: on ? ' ' : 'x' });
        place(ed, { b: indexOfBlock(ed, made), o: 0 });
      });
    });

    ed.root.addEventListener('click', function (e) {
      // A link in a note is a link: ⌘-click opens it, a plain click puts the caret in
      // it, which is what a click inside text one is editing has to do.
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a || !ed.root.contains(a)) return;
      e.preventDefault();
      if (!e.metaKey && !e.ctrlKey) return;
      var url = a.getAttribute('href') || '';
      if (/^https?:\/\//i.test(url) && window.sb && typeof window.sb.openExternal === 'function') {
        Promise.resolve(window.sb.openExternal(url))['catch'](function () {});
      }
    });

    ed.root.addEventListener('blur', function () { commit(ed); });
  }

  // One listener for every editor: which block the caret is in decides where the
  // "type # for a heading" hint shows, and the caret is what focus() comes back to.
  document.addEventListener('selectionchange', function () {
    for (var i = 0; i < live.length; i++) {
      var ed = live[i];
      if (ed.dead || !ed.root.isConnected) continue;
      if (!hasFocus(ed)) { hint(ed, null); continue; }
      var at = where(ed);
      if (at) ed.caret = at;
      hint(ed, at ? ed.root.children[at.b] : null);
    }
  });

  function hint(ed, block) {
    var on = ed.root.querySelector('.nb.on');
    if (on && on !== block) on.classList.remove('on');
    if (block && block !== on) block.classList.add('on');
  }

  function destroy(ed) {
    commit(ed);
    ed.dead = true;
    if (ed.timer) { clearTimeout(ed.timer); ed.timer = null; }
    var i = live.indexOf(ed);
    if (i !== -1) live.splice(i, 1);
    if (ed.root.parentNode) ed.root.parentNode.removeChild(ed.root);
  }

  SB.noteEditor = {
    create: create,
    // The markdown half on its own, for the tests and for anything that wants to read a
    // note without an editor around it.
    parseBlocks: parseBlocks,
    blockToMd: blockToMd,
    parseInline: parseInline,
    inlineToMd: inlineToMd,
  };
})(window.SB);
