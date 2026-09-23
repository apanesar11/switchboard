// SB.diffview — one unified-diff BODY rendered into the mock-up's diff markup.
//
//   SB.diffview.render(patch, {
//     comments: [PrComment],    // ARCHITECTURE §2, anchored by `line` + `side`
//     repoPrefix: 'sample-api', // keeps comment element ids unique across files
//     collapsedContext: false,  // fold long runs of unchanged lines
//     binary: false,            // or let the "Binary files … differ" line say so
//     truncated: false, hiddenLines: 0,
//     onOpen(comment),          // renders ONE footer action; omit it for none
//     commentUrl(comment),      // that action's destination, for its tooltip
//     openLabel: 'Reply on GitHub',
//   })  ->  <div class="diff">…</div>
//
// The caller wraps that node: `.diffwrap` on the single-file Diff screen, `.dfile`
// on All diffs and Pull request. `patch` is the body ARCHITECTURE §4.3 defines —
// hunk headers and lines, no `diff --git` / `index` / `---` / `+++` preamble.
//
// Pure: no IPC, no SB.state. Every string from git or GitHub reaches the document
// as a text node (SB.icons markup is the one exception), so nothing can inject.
window.SB = window.SB || {};

(function (SB) {
  'use strict';

  var dom = SB.dom;
  var h = dom.h;

  // Hunk counts are OPTIONAL: `@@ -1 +1 @@` means one line on each side. A regex
  // that demands `,\d+` silently skips every single-line hunk.
  var HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  var BINARY = /^(Binary files .* differ|GIT binary patch)/;

  // Runs of unchanged lines longer than this fold when collapsedContext is on;
  // KEEP lines survive at each end, which is exactly what `git diff -U3` gives.
  var KEEP = 3;
  var FOLD_OVER = KEEP * 2 + 1;

  // ── parsing ───────────────────────────────────────────────────────────────

  // -> { binary, rows: [{kind, text, oldLine, newLine}] }
  // kind: 'hunk' | 'ctx' | 'add' | 'del' | 'nonl'
  function parse(patch) {
    var text = typeof patch === 'string' ? patch : '';
    var lines = text.split('\n');
    // A body ends with a newline; splitting it leaves a phantom empty last line
    // that would render as a stray blank row.
    if (lines.length && lines[lines.length - 1] === '') lines.pop();

    var rows = [];
    var binary = false;
    var inHunk = false;
    var oldLine = 0;
    var newLine = 0;

    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];

      if (BINARY.test(raw)) { binary = true; continue; }

      var m = HUNK.exec(raw);
      if (m) {
        inHunk = true;
        oldLine = Number(m[1]);
        newLine = Number(m[2]);
        rows.push({ kind: 'hunk', text: raw });
        continue;
      }

      // Anything before the first @@ is preamble a caller left on. After a
      // `diff --git` we are back in preamble — a multi-file patch still renders,
      // each file's hunks in turn.
      if (raw.indexOf('diff --git ') === 0) { inHunk = false; continue; }
      if (!inHunk) continue;

      var c = raw.charAt(0);
      if (c === '\\') {
        // `\ No newline at end of file` belongs to the line above it and must
        // never advance a counter, or every later comment anchors one line off.
        rows.push({ kind: 'nonl', text: raw });
      } else if (c === '+') {
        rows.push({ kind: 'add', text: raw, newLine: newLine });
        newLine++;
      } else if (c === '-') {
        rows.push({ kind: 'del', text: raw, oldLine: oldLine });
        oldLine++;
      } else {
        // ' ' is a context line; a completely empty body line is a context line
        // whose content is ''.
        rows.push({ kind: 'ctx', text: raw, oldLine: oldLine, newLine: newLine });
        oldLine++;
        newLine++;
      }
    }

    return { binary: binary, rows: rows };
  }

  // ── comments ──────────────────────────────────────────────────────────────

  function num(v) {
    var n = Number(v);
    return isFinite(n) && v !== null && v !== '' ? n : null;
  }

  function key(side, line) {
    return (side === 'LEFT' ? 'L' : 'R') + ':' + line;
  }

  // Roots in the order they arrived, each followed by its own replies, so a
  // thread reads top to bottom in the one place it is anchored.
  function threadOrder(list) {
    var byId = {};
    var i;
    for (i = 0; i < list.length; i++) if (list[i] && list[i].id != null) byId[list[i].id] = list[i];

    var roots = [];
    var replies = {};
    for (i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c) continue;
      var parent = (c.replyTo != null && byId[c.replyTo] && c.replyTo !== c.id) ? byId[c.replyTo] : null;
      if (parent) (replies[c.replyTo] = replies[c.replyTo] || []).push(c);
      else roots.push(c);
    }

    var out = [];
    for (i = 0; i < roots.length; i++) {
      out.push(roots[i]);
      var kids = replies[roots[i].id] || [];
      for (var j = 0; j < kids.length; j++) out.push(kids[j]);
    }
    // A reply whose root is not in this file's list still has to be shown.
    for (var id in replies) if (!byId[id]) out = out.concat(replies[id]);
    return out;
  }

  // key -> [comment]. A reply with no line of its own inherits its root's anchor.
  function indexComments(comments) {
    var list = threadOrder((comments || []).filter(Boolean));
    var byId = {};
    var index = {};
    var unanchored = [];
    var i;
    for (i = 0; i < list.length; i++) if (list[i].id != null) byId[list[i].id] = list[i];

    for (i = 0; i < list.length; i++) {
      var c = list[i];
      var side = c.side === 'LEFT' ? 'LEFT' : 'RIGHT';
      var line = num(c.line);
      if (line === null && c.replyTo != null && byId[c.replyTo]) {
        var root = byId[c.replyTo];
        side = root.side === 'LEFT' ? 'LEFT' : 'RIGHT';
        line = num(root.line);
      }
      // An OUTDATED comment was written against a commit that is no longer on
      // screen. Whatever number came with it indexes that older file, so pinning
      // the card to it lands a reviewer's objection under innocent code that
      // merely inherited the line number. Stale threads go under the diff.
      if (c.outdated) { unanchored.push(c); continue; }
      if (line === null) { unanchored.push(c); continue; }
      var k = key(side, line);
      (index[k] = index[k] || []).push(c);
    }
    return { index: index, unanchored: unanchored, count: list.length };
  }

  function initials(c) {
    if (c.avatarInitials) return String(c.avatarInitials).slice(0, 2).toUpperCase();
    var name = String(c.author || '?').replace(/\[bot\]$/, '');
    return name.slice(0, 2).toUpperCase();
  }

  // The body is GitHub-flavoured markdown; SB.markdown (loaded before this file)
  // builds nodes for it rather than markup, so a review comment can never smuggle
  // HTML in. Its `.md` class is what the stylesheet sizes the blocks by.
  function bodyNodes(text) {
    return SB.markdown ? SB.markdown.render(text) : dom.text(text);
  }

  function when(c) {
    return c.relative || dom.fmtAgo(c.createdAt) || '';
  }

  // The anchor line is gone from the current diff; the comment is still worth
  // reading, so it is marked rather than dropped. `originalLine` numbers the file
  // as it was, which is worth saying and — see indexComments — never worth using.
  function outdatedChip(c) {
    var was = num(c.originalLine);
    return h('span.sec', null, was === null ? 'outdated' : 'outdated · was line ' + was);
  }

  function commentCard(c, opts) {
    var resolved = !!c.resolved;
    var head = h('div.ch',
      h('span.av', null, initials(c)),
      h('b', null, c.author || 'someone'),
      when(c) ? h('span.sec', null, when(c)) : null,
      h('span.sp'),
      c.outdated ? outdatedChip(c) : null,
      resolved ? h('span.rsv', null, 'Resolved') : null);

    var card = h('div.cmt', head, h('div.cb.md', null, bodyNodes(c.body)));

    // Replying and resolving are GitHub writes, and there is no IPC for either
    // (ARCHITECTURE §4.4) — buttons that hover like actions and do nothing read as
    // a broken app. The one thing this screen can honestly offer is the comment
    // itself, on GitHub, where both actions live.
    if (opts.onOpen) {
      card.appendChild(h('div.cf', h('button', {
        type: 'button',
        title: (typeof opts.commentUrl === 'function' ? opts.commentUrl(c) : null) || null,
        onClick: function () { opts.onOpen(c); }
      }, opts.openLabel || 'Reply on GitHub')));
    }

    if (c.id != null) card.id = 'cmt-' + (opts.repoPrefix ? String(opts.repoPrefix).replace(/[^\w-]+/g, '-') + '-' : '') + c.id;
    return card;
  }

  // A stale card sits under the diff, where it could be misread as a note on the
  // last line. This dim row says where it actually came from: the hunk header
  // GitHub recorded with it, or — when there is none — the plain fact.
  function staleContext(c) {
    var first = String(c.diffHunk || '').split('\n')[0];
    // "written against" so the header is not read as one more hunk of the diff
    // above it — this one belongs to a commit that is no longer on screen.
    if (HUNK.test(first)) return h('div.h', null, 'written against ' + first);
    return dim('⋯ outdated · written against an earlier version of this file');
  }

  // ── notes ─────────────────────────────────────────────────────────────────

  function note(text) {
    return h('div.note', null, text);
  }

  function commas(n) {
    return Number(n).toLocaleString('en-US');
  }

  // ── folding ───────────────────────────────────────────────────────────────

  // Replace long runs of unchanged lines with one dim summary row, keeping any
  // line a comment is anchored to.
  function fold(rows, index) {
    var keep = new Array(rows.length);
    var run = [];
    var out = [];
    var i;

    function flush() {
      if (!run.length) return;
      for (var j = 0; j < run.length; j++) {
        if (run.length <= FOLD_OVER) { keep[run[j]] = true; continue; }
        var row = rows[run[j]];
        var anchored = index[key('RIGHT', row.newLine)] || index[key('LEFT', row.oldLine)];
        keep[run[j]] = j < KEEP || j >= run.length - KEEP || !!anchored;
      }
      run = [];
    }

    for (i = 0; i < rows.length; i++) {
      if (rows[i].kind === 'ctx') run.push(i);
      else { flush(); keep[i] = true; }
    }
    flush();

    var hidden = 0;
    for (i = 0; i < rows.length; i++) {
      if (keep[i]) {
        if (hidden) { out.push({ kind: 'fold', hidden: hidden }); hidden = 0; }
        out.push(rows[i]);
      } else {
        hidden++;
      }
    }
    if (hidden) out.push({ kind: 'fold', hidden: hidden });
    return out;
  }

  // ── render ────────────────────────────────────────────────────────────────

  function lineNode(row) {
    var sel = row.kind === 'add' ? 'div.a' : row.kind === 'del' ? 'div.r' : 'div';
    // white-space:pre gives an empty div no line box at all, so an empty context
    // line would silently vanish. Its stripped marker is a space; put it back.
    return h(sel, null, row.text === '' ? ' ' : row.text);
  }

  function dim(text) {
    return h('div', { style: { color: 'var(--sec)' } }, text);
  }

  function render(patch, options) {
    var opts = options || {};
    var box = h('div.diff');
    var parsed = parse(patch);

    if (opts.binary || parsed.binary) {
      box.appendChild(note('binary file — no diff to show'));
      return box;
    }
    if (!parsed.rows.length) {
      box.appendChild(note('no diff to show'));
      return box;
    }

    var comments = indexComments(opts.comments);
    var rows = opts.collapsedContext ? fold(parsed.rows, comments.index) : parsed.rows;
    var used = {};

    function flushComments(k) {
      var list = comments.index[k];
      if (!list || used[k]) return;
      used[k] = true;
      for (var i = 0; i < list.length; i++) box.appendChild(commentCard(list[i], opts));
    }

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];

      if (row.kind === 'hunk') { box.appendChild(h('div.h', null, row.text)); continue; }
      if (row.kind === 'fold') { box.appendChild(dim('⋯ ' + dom.plural(row.hidden, 'unchanged line'))); continue; }
      if (row.kind === 'nonl') { box.appendChild(dim(row.text)); continue; }

      box.appendChild(lineNode(row));

      // The no-newline marker is part of the line above it, so it goes in before
      // any comment card anchored to that line.
      if (rows[i + 1] && rows[i + 1].kind === 'nonl') { box.appendChild(dim(rows[i + 1].text)); i++; }

      if (row.kind !== 'del') flushComments(key('RIGHT', row.newLine));
      if (row.kind !== 'add') flushComments(key('LEFT', row.oldLine));
    }

    // Comments whose line is not in this patch (outdated ones, or a file-level
    // note) still belong on the screen — they go under the diff rather than into it.
    var tail = comments.unanchored.slice();
    for (var k in comments.index) if (!used[k]) tail = tail.concat(comments.index[k]);
    for (var t = 0; t < tail.length; t++) {
      // One context row per stale THREAD: a reply inherits its root's, just above.
      if (tail[t].outdated && !tail[t].replyTo) box.appendChild(staleContext(tail[t]));
      box.appendChild(commentCard(tail[t], opts));
    }

    if (opts.truncated) {
      var hidden = num(opts.hiddenLines);
      box.appendChild(note(hidden === null
        ? 'diff truncated · the rest is hidden'
        : 'diff truncated · ' + commas(hidden) + ' more ' + (hidden === 1 ? 'line' : 'lines') + ' hidden'));
    }

    return box;
  }

  SB.diffview = { render: render };
})(window.SB);
