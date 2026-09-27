// SB.markdown — GitHub-flavoured markdown → DOM, for the text people write on a pull
// request — the description, the conversation, the reviews and the inline comments —
// and for the Editor's preview of a markdown file (a README).
//
//   SB.markdown.render(text, opts) -> DocumentFragment of block elements (p, h1–h6,
//                                ul/ol, pre, blockquote, table, hr, details); every
//                                string from GitHub reaches the document as a text node
//   SB.markdown.inline(text)  -> [Node|string] for one line's worth of inline markup
//   SB.markdown.parse(text)   -> the block tree, for tests
//
// No markdown engine and no innerHTML: a comment must never be able to smuggle markup
// in, so this walks the text and builds nodes for what the text on a pull request
// actually uses. Raw HTML is read for the handful of tags that carry meaning — a link,
// a line break, <details> — and every other tag is stripped to its text (Codex wraps
// its severity badge in <sub>, the Linear bot writes <p><a href>).
//
// opts.breaks — what a single newline inside a paragraph means. true (the default, a
// comment): a line break, which is how GitHub renders what is typed into a comment box.
// false (a file): the soft break of a document, folded into a space, as GitHub renders
// a README; a line that ends in two spaces or a backslash is still a hard break.
window.SB = window.SB || {};

(function (SB) {
  'use strict';

  var dom = SB.dom;
  var h = dom.h;

  // The reference-style link definitions of the text being rendered (`[name]: url`),
  // lowercased label -> url, for `[text][name]`, `[text][]` and `[name]` in it. Set by
  // render() for its duration: inline() is reached from every block and carries no
  // context of its own. A comment rarely has any; a README's badges are nothing else.
  var defs = null;

  // ── inline ────────────────────────────────────────────────────────────────

  var ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

  function unescapeHtml(s) {
    return String(s).replace(/&(amp|lt|gt|quot|#39|nbsp);/g, function (_, k) { return ENTITY[k]; });
  }

  function openLink(url) {
    return function (e) {
      e.preventDefault();
      if (window.sb && typeof window.sb.openExternal === 'function') {
        Promise.resolve(window.sb.openExternal(url))['catch'](function () {});
      }
    };
  }

  function link(label, href) {
    return h('a', { href: href, title: href, onClick: openLink(href) }, label);
  }

  function alt(text, src) {
    return text ? [h('span.imgalt', { title: src || null }, text)] : [];
  }

  // Each rule is tried at the current position (the sticky flag) in this order, and the
  // first that matches hands back the nodes it stands for. `starts` is the character a
  // token can begin with, so most positions try nothing at all. `word` rules do not
  // fire mid-word: some_identifier_name is not emphasis.
  var RULES = [
    { starts: '`', re: /(`+)([\s\S]*?[^`])\1(?!`)/y,
      make: function (m) { return [h('code', null, m[2].replace(/\n/g, ' '))]; } },
    { starts: '*', re: /\*\*(?=\S)([\s\S]+?\S)\*\*/y,
      make: function (m) { return [h('strong', null, inline(m[1]))]; } },
    { starts: '_', re: /__(?=\S)([\s\S]+?\S)__(?![A-Za-z0-9])/y, word: true,
      make: function (m) { return [h('strong', null, inline(m[1]))]; } },
    { starts: '~', re: /~~(?=\S)([\s\S]+?\S)~~/y,
      make: function (m) { return [h('del', null, inline(m[1]))]; } },
    { starts: '*', re: /\*(?=[^\s*])([^*\n]+?)\*(?!\*)/y,
      make: function (m) { return [h('em', null, inline(m[1]))]; } },
    { starts: '_', re: /_(?=[^\s_])([^_\n]+?)_(?![A-Za-z0-9_])/y, word: true,
      make: function (m) { return [h('em', null, inline(m[1]))]; } },
    // An image has nothing to show inline; its alt text is what it meant.
    { starts: '!', re: /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/y,
      make: function (m) { return alt(m[1], m[2]); } },
    // A link's text may hold one level of brackets of its own — a badge is an image
    // inside a link, `[![Build](img)](url)`, on the first line of most READMEs.
    { starts: '[', re: /\[((?:[^\[\]\n]|\[[^\[\]\n]*\])*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/y,
      make: function (m) { return [link(inline(m[1]), m[2])]; } },
    // Reference style, by a definition seen anywhere in the text: `![alt][ref]`,
    // `[text][ref]`, `[text][]` and `[text]` alone. Without a definition the brackets
    // are plain text, as they always were — `[ ]` in a sentence, `[x]` in a task.
    { starts: '!', re: /!\[([^\]\n]*)\](?:\[([^\]\n]*)\])?/y,
      make: function (m) { var u = def(m[2] || m[1]); return u === null ? null : alt(m[1], u); } },
    { starts: '[', re: /\[((?:[^\[\]\n]|\[[^\[\]\n]*\])+)\](?:\[([^\]\n]*)\])?/y,
      make: function (m) { var u = def(m[2] || m[1]); return u === null ? null : [link(inline(m[1]), u)]; } },
    { starts: '<', re: /<(https?:\/\/[^>\s]+)>/y,
      make: function (m) { return [link(m[1], m[1])]; } },
    // A bare address. Trailing punctuation belongs to the sentence, not the link.
    { starts: 'h', re: /https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]]/y,
      make: function (m) { return [link(m[0], m[0])]; } },
    { starts: '<', re: /<!--[\s\S]*?-->/y, make: function () { return []; } },
    { starts: '<', re: /<a\s+[^>]*?href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/iy,
      make: function (m) { return [link(inline(m[2]), m[1])]; } },
    { starts: '<', re: /<(code|kbd)\b[^>]*>([\s\S]*?)<\/\1>/iy,
      make: function (m) { return [h('code', null, unescapeHtml(m[2]))]; } },
    { starts: '<', re: /<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/iy,
      make: function (m) { return [h('strong', null, inline(m[2]))]; } },
    { starts: '<', re: /<(i|em)\b[^>]*>([\s\S]*?)<\/\1>/iy,
      make: function (m) { return [h('em', null, inline(m[2]))]; } },
    { starts: '<', re: /<(del|s|strike)\b[^>]*>([\s\S]*?)<\/\1>/iy,
      make: function (m) { return [h('del', null, inline(m[2]))]; } },
    { starts: '<', re: /<br\s*\/?>/iy, make: function () { return [h('br')]; } },
    { starts: '<', re: /<img\b[^>]*?alt\s*=\s*"([^"]*)"[^>]*>/iy,
      make: function (m) { return alt(m[1], null); } },
    // Any other tag — <sub>, <p>, <img> without alt — is dropped and its text kept.
    { starts: '<', re: /<\/?[a-zA-Z][^<>]*>/y, make: function () { return []; } },
    { starts: '&', re: /&(amp|lt|gt|quot|#39|nbsp);/y,
      make: function (m) { return [ENTITY[m[1]]]; } }
  ];

  var ESCAPABLE = /[\\`*_{}\[\]()#+\-.!~<>|]/;

  function wordChar(c) { return /[A-Za-z0-9]/.test(c); }

  // The url a reference label stands for, or null when the text defined none.
  function def(label) {
    if (!defs) return null;
    var key = String(label || '').trim().toLowerCase();
    return key && Object.prototype.hasOwnProperty.call(defs, key) ? defs[key] : null;
  }

  // -> [Node | string]
  function inline(text) {
    var s = String(text === null || text === undefined ? '' : text);
    var out = [];
    var buf = '';
    var i = 0;
    while (i < s.length) {
      var c = s.charAt(i);
      if (c === '\\' && i + 1 < s.length && ESCAPABLE.test(s.charAt(i + 1))) {
        buf += s.charAt(i + 1);
        i += 2;
        continue;
      }
      var hit = null;
      for (var r = 0; r < RULES.length; r++) {
        var rule = RULES[r];
        if (rule.starts !== c) continue;
        if (rule.word && i > 0 && wordChar(s.charAt(i - 1))) continue;
        rule.re.lastIndex = i;
        var m = rule.re.exec(s);
        if (!m) continue;
        // The end is read BEFORE make(): make() recurses into inline() for the text
        // inside, which runs these same sticky regexes and moves their lastIndex.
        var end = rule.re.lastIndex;
        var nodes = rule.make(m);
        if (nodes === null) continue;               // matched the shape, but not this text: next rule
        hit = { end: end, nodes: nodes };
        break;
      }
      if (!hit) { buf += c; i++; continue; }
      if (buf) { out.push(buf); buf = ''; }
      for (var n = 0; n < hit.nodes.length; n++) out.push(hit.nodes[n]);
      i = hit.end;
    }
    if (buf) out.push(buf);
    return out;
  }

  // ── blocks ────────────────────────────────────────────────────────────────

  var FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
  var HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  // The underline that makes the paragraph above it a heading: `===` an h1, `---` an h2.
  var SETEXT = /^ {0,3}(=+|-+)\s*$/;
  // `[name]: url "title"` on a line of its own, defining a reference for inline().
  var DEF = /^ {0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;
  // Two trailing spaces or a backslash: a hard line break inside a paragraph.
  var HARD = /(?: {2,}|\\)$/;
  var HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
  var QUOTE = /^ {0,3}>\s?(.*)$/;
  var ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  var TASK = /^\[([ xX])\]\s+(.*)$/;
  var TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
  var DETAILS_OPEN = /^\s*<details\b[^>]*>(.*)$/i;
  var SUMMARY = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i;
  var TAG_ALONE = /^\s*<\/?(p|div|br|hr)\b[^>]*\/?>\s*$/i;
  var COMMENT_ONLY = /^\s*(?:<!--[\s\S]*?-->\s*)+$/;
  var BLANK = /^\s*$/;

  function closes(line, fence) {
    var c = fence.charAt(0);
    var s = line.replace(/^ {0,3}/, '');
    var n = 0;
    while (n < s.length && s.charAt(n) === c) n++;
    return n >= fence.length && BLANK.test(s.slice(n));
  }

  function indentOf(line) {
    return line.length - line.replace(/^ +/, '').length;
  }

  function stripIndent(line, n) {
    var k = 0;
    while (k < n && k < line.length && line.charAt(k) === ' ') k++;
    return line.slice(k);
  }

  function isBlockStart(line) {
    return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) ||
      ITEM.test(line) || DETAILS_OPEN.test(line);
  }

  function cells(line) {
    var s = line.trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|' && s.charAt(s.length - 2) !== '\\') s = s.slice(0, -1);
    var out = [];
    var cur = '';
    for (var k = 0; k < s.length; k++) {
      var c = s.charAt(k);
      if (c === '\\' && s.charAt(k + 1) === '|') { cur += '|'; k++; continue; }
      if (c === '|') { out.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    out.push(cur.trim());
    return out;
  }

  // One list, from the item at lines[i]. An item's continuation is whatever sits at its
  // content indent (or deeper), a blank followed by such a line, or — the way people
  // actually type — an unindented line straight after the item's text.
  // `1.` and `-` are different lists, as are `-` and `*`; a change of marker ends one.
  function markerKind(marker) {
    return /^\d/.test(marker) ? 'n' : marker;
  }

  function parseList(lines, i, first) {
    var base = first[1].length;
    var kind = markerKind(first[2]);
    var list = { t: 'list', ordered: kind === 'n', start: parseInt(first[2], 10) || 1, items: [] };
    while (i < lines.length) {
      var im = ITEM.exec(lines[i]);
      if (!im || im[1].length !== base || markerKind(im[2]) !== kind) break;
      var content = base + im[2].length + 1;
      var body = [im[3]];
      i++;
      while (i < lines.length) {
        var l = lines[i];
        if (BLANK.test(l)) {
          var j = i + 1;
          while (j < lines.length && BLANK.test(lines[j])) j++;
          if (j >= lines.length) { i = j; break; }
          var after = ITEM.exec(lines[j]);
          if (indentOf(lines[j]) >= content || (after && after[1].length > base)) { body.push(''); i++; continue; }
          i = j;
          break;
        }
        var lm = ITEM.exec(l);
        if (lm && lm[1].length <= base) break;
        if (indentOf(l) >= content || lm) { body.push(stripIndent(l, content)); i++; continue; }
        if (isBlockStart(l)) break;
        if (body[body.length - 1] !== '') { body.push(l.trim()); i++; continue; }
        break;
      }
      var task = TASK.exec(body[0]);
      var checked = null;
      if (task) { checked = task[1] !== ' '; body[0] = task[2]; }
      list.items.push({ checked: checked, blocks: blocks(body) });
    }
    return { block: list, next: i };
  }

  function parseDetails(lines, i, first) {
    var inner = [first[1]];
    var depth = 1;
    i++;
    while (i < lines.length) {
      var l = lines[i];
      i++;
      if (/<details\b/i.test(l)) depth++;
      if (/<\/details>/i.test(l)) {
        depth--;
        if (depth === 0) { inner.push(l.replace(/<\/details>[\s\S]*$/i, '')); break; }
      }
      inner.push(l);
    }
    var text = inner.join('\n');
    var sm = SUMMARY.exec(text);
    var summary = sm ? sm[1] : 'Details';
    if (sm) text = text.replace(SUMMARY, '');
    return { block: { t: 'details', summary: summary.trim(), blocks: blocks(text.split('\n')) }, next: i };
  }

  function blocks(lines) {
    var out = [];
    var para = null;
    var hard = null;                 // per paragraph line: it ended in a hard break
    var i = 0;

    function endPara() {
      if (para) { out.push({ t: 'p', lines: para, hard: hard }); para = null; hard = null; }
    }

    while (i < lines.length) {
      var line = lines[i];
      var m;

      if (BLANK.test(line) || TAG_ALONE.test(line) || COMMENT_ONLY.test(line)) { endPara(); i++; continue; }

      // A paragraph's underline makes it a heading, GitHub's way — and `---` right under
      // a line of text is that, not a rule, for GitHub too.
      if (para && SETEXT.test(line)) {
        var level = line.trim().charAt(0) === '=' ? 1 : 2;
        var text = para.join(' ');
        para = null;
        hard = null;
        out.push({ t: 'h', level: level, text: text });
        i++;
        continue;
      }

      // A reference definition is read by parse() before this; it is not shown.
      if (DEF.test(line)) { endPara(); i++; continue; }

      // <!-- … --> across lines: nothing in it is shown.
      if (/<!--/.test(line) && !/-->/.test(line)) {
        endPara();
        while (i < lines.length && !/-->/.test(lines[i])) i++;
        if (i < lines.length) {
          var rest = lines[i].replace(/^[\s\S]*?-->/, '');
          i++;
          if (!BLANK.test(rest)) lines.splice(i, 0, rest);
        }
        continue;
      }

      if ((m = FENCE.exec(line))) {
        endPara();
        var code = [];
        i++;
        while (i < lines.length && !closes(lines[i], m[1])) { code.push(lines[i]); i++; }
        i++;
        out.push({ t: 'code', lang: m[2] || '', text: code.join('\n') });
        continue;
      }

      if ((m = HEADING.exec(line))) { endPara(); out.push({ t: 'h', level: m[1].length, text: m[2] }); i++; continue; }

      if (line.indexOf('|') !== -1 && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
        endPara();
        var head = cells(line);
        var rows = [];
        i += 2;
        while (i < lines.length && !BLANK.test(lines[i]) && lines[i].indexOf('|') !== -1) { rows.push(cells(lines[i])); i++; }
        out.push({ t: 'table', head: head, rows: rows });
        continue;
      }

      if (HR.test(line)) { endPara(); out.push({ t: 'hr' }); i++; continue; }

      if (QUOTE.test(line)) {
        endPara();
        var quoted = [];
        while (i < lines.length && (m = QUOTE.exec(lines[i]))) { quoted.push(m[1]); i++; }
        out.push({ t: 'quote', blocks: blocks(quoted) });
        continue;
      }

      if ((m = ITEM.exec(line))) {
        endPara();
        var list = parseList(lines, i, m);
        out.push(list.block);
        i = list.next;
        continue;
      }

      if ((m = DETAILS_OPEN.exec(line))) {
        endPara();
        var det = parseDetails(lines, i, m);
        out.push(det.block);
        i = det.next;
        continue;
      }

      if (!para) { para = []; hard = []; }
      var broken = HARD.test(line);
      para.push(line.replace(HARD, '').trim());
      hard.push(broken);
      i++;
    }
    endPara();
    return out;
  }

  // Every `[name]: url` line in the text, before the blocks are read: a reference may be
  // used above the line that defines it. Not one inside a code fence, which is code.
  function definitions(lines) {
    var found = null;
    var fence = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (fence) { if (closes(line, fence)) fence = null; continue; }
      var f = FENCE.exec(line);
      if (f) { fence = f[1]; continue; }
      var m = DEF.exec(line);
      if (!m) continue;
      var key = m[1].trim().toLowerCase();
      if (!found) found = Object.create(null);
      if (!(key in found)) found[key] = m[2];   // the first definition wins, as in GitHub
    }
    return found;
  }

  function parse(text) {
    var s = String(text === null || text === undefined ? '' : text).replace(/\r\n?/g, '\n');
    return blocks(s.split('\n'));
  }

  // ── render ────────────────────────────────────────────────────────────────

  // Lines of one paragraph. With breaks on (a comment) a <br> between each — GitHub's
  // own reading of a newline typed into a comment box. With breaks off (a file) the
  // lines run on, a space between, and only a hard break (two trailing spaces, a
  // backslash) is a <br>.
  function paragraph(lines, tag, o, hard) {
    var kids = [];
    var run = '';
    for (var i = 0; i < lines.length; i++) {
      if (o.breaks !== false) {
        if (i) kids.push(h('br'));
        kids.push(inline(lines[i]));
        continue;
      }
      run += (run ? ' ' : '') + lines[i];
      if (hard && hard[i] && i < lines.length - 1) {
        kids.push(inline(run), h('br'));
        run = '';
      }
    }
    if (run) kids.push(inline(run));
    return h(tag, null, kids);
  }

  function listNode(b, o) {
    var el = h(b.ordered ? 'ol' : 'ul', b.ordered && b.start !== 1 ? { start: String(b.start) } : null);
    for (var i = 0; i < b.items.length; i++) {
      var it = b.items[i];
      var li = h('li' + (it.checked === null ? '' : '.task'));
      if (it.checked !== null) {
        li.appendChild(h('input', { type: 'checkbox', checked: it.checked || null, disabled: true, tabindex: '-1' }));
      }
      // A one-paragraph item keeps its text inline, so a plain list stays tight.
      var rest = it.blocks;
      if (rest.length && rest[0].t === 'p') { li.appendChild(paragraph(rest[0].lines, 'span', o, rest[0].hard)); rest = rest.slice(1); }
      if (rest.length) li.appendChild(renderBlocks(rest, o));
      el.appendChild(li);
    }
    return el;
  }

  function table(b) {
    var tr = h('tr');
    for (var i = 0; i < b.head.length; i++) tr.appendChild(h('th', null, inline(b.head[i])));
    var tbody = h('tbody');
    for (var r = 0; r < b.rows.length; r++) {
      var row = h('tr');
      for (var k = 0; k < b.head.length; k++) row.appendChild(h('td', null, inline(b.rows[r][k] || '')));
      tbody.appendChild(row);
    }
    return h('table', null, h('thead', null, tr), tbody);
  }

  function node(b, o) {
    switch (b.t) {
      case 'p': return paragraph(b.lines, 'p', o, b.hard);
      case 'h': return h('h' + Math.min(6, b.level), null, inline(b.text));
      case 'code': return h('pre', b.lang ? { dataset: { lang: b.lang } } : null, h('code', null, b.text));
      case 'hr': return h('hr');
      case 'quote': return h('blockquote', null, renderBlocks(b.blocks, o));
      case 'table': return table(b);
      case 'details': return h('details', null, h('summary', null, inline(b.summary)), renderBlocks(b.blocks, o));
      case 'list': return listNode(b, o);
      default: return h('p');
    }
  }

  function renderBlocks(list, o) {
    var frag = dom.frag();
    for (var i = 0; i < list.length; i++) frag.appendChild(node(list[i], o));
    return frag;
  }

  // The parsed tree holds no nodes, so the reference definitions are needed again while
  // it is rendered: inline() runs here, not in parse().
  function render(text, opts) {
    var o = opts || {};
    var s = String(text === null || text === undefined ? '' : text).replace(/\r\n?/g, '\n');
    var lines = s.split('\n');
    defs = definitions(lines);
    try {
      return renderBlocks(blocks(lines), o);
    } finally {
      defs = null;
    }
  }

  SB.markdown = { render: render, inline: inline, parse: parse };
})(window.SB);
