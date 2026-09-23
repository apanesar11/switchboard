// SB.views.pr — the Pull request screen (mock-up 07), with an Overview tab in front.
//
// Two ways in, one screen:
//   {view:'pr', wsId, repo, tab}           a branch pill on the workspace screen; the
//                                          data is sb.pr(wsId, repo), keyed by the LOCAL
//                                          repo so sample-1..4 never show each other's
//   {view:'pr', owner, repo, number, tab}  a row on the Pull requests list; no workspace
//                                          at all, sb.prByNumber(owner, repo, number)
//
// Overview | Files | All diffs. Overview is first and the default because the diffs are
// the part looked at least: it holds the description and everything said on the pull
// request — the conversation, each review with the inline comments it was submitted
// with, and the reactions on all of it. A 👍 from chatgpt-codex-connector on the
// description is the Codex connector's "nothing to report", which is why the reactions
// are there. The tab name on a file card or an inline comment's path jumps into All
// diffs at that spot.
//
// This screen is scoped to ONE repo, so nothing on it carries a repo prefix: the file
// cards have no `.rp` span and the Files tab has no `.fsec` group header. Every
// failure gh can hand back is a single calm line in the body: no dialogs, no stacks.
window.SB = window.SB || {};

(function (SB) {
  'use strict';

  var D = SB.dom;
  var h = D.h;

  // Fold state lives here, not in SB.state: it is view-local and must survive the
  // re-render that every onRunState tick causes while a dev server is running.
  var folded = Object.create(null);     // 'wsId\0repo\0path' -> true
  var attempt = Object.create(null);    // load slot -> retry counter, part of the load key
  var focusPath = null;                 // file card to scroll to after the next render
  var focusId = null;                   // comment card (element id) to scroll to instead
  var copied = Object.create(null);     // command -> true, so the button can say "Copied"
  var wantFresh = false;                // the next load skips main's cache — ⌘R

  // ── data ──────────────────────────────────────────────────────────────────

  function byNumber(route) {
    return !!route && !route.wsId && !!route.number;
  }

  // SB.load hands back an entry { status, value, … }. Anything that is not a settled
  // { ok } envelope is treated as "still loading", which is the only safe reading.
  function envelope(raw) {
    if (!raw || typeof raw.then === 'function') return null;
    if (typeof raw.ok === 'boolean') return raw;
    var inner = raw.value !== undefined ? raw.value
      : raw.data !== undefined ? raw.data
        : raw.result;
    if (inner && typeof inner.ok === 'boolean') return inner;
    if (raw.error) return { ok: false, error: String(raw.error) };
    return null;
  }

  function settle(p) {
    return Promise.resolve(p).then(function (r) {
      return r || { ok: false, error: 'gh returned nothing' };
    }, function (err) {
      return { ok: false, error: (err && err.message) || 'could not reach the main process' };
    });
  }

  function slotOf(route) {
    return byNumber(route)
      ? 'prn:' + route.owner + '/' + route.repo + '#' + route.number
      : 'pr:' + route.wsId + '\0' + route.repo;
  }

  function loadPr(route) {
    var slot = slotOf(route);
    var key = slot + ':' + (attempt[slot] || 0);
    var fetch = function () {
      var fresh = wantFresh;
      wantFresh = false;
      return settle(byNumber(route)
        ? window.sb.prByNumber(route.owner, route.repo, route.number, { fresh: fresh })
        : window.sb.pr(route.wsId, route.repo, { fresh: fresh }));
    };
    return envelope(SB.load(key, fetch));
  }

  function retry(route) {
    var slot = slotOf(route);
    attempt[slot] = (attempt[slot] || 0) + 1;
    wantFresh = true;
    SB.render();
  }

  // app.js calls this on a window focus for a pull request from the list (soft: main's
  // 60 s cache may answer) and on ⌘R for either flavour (hard: GitHub is asked now).
  // A workspace's own scan already revalidates the `pr:` loads on every focus.
  function refresh(hard) {
    if (hard) wantFresh = true;
    if (typeof SB.invalidate === 'function') { SB.invalidate('pr:'); SB.invalidate('prn:'); }
  }

  // ── small helpers ─────────────────────────────────────────────────────────

  function findRepo(ws, name) {
    var repos = (ws && ws.repos) || [];
    for (var i = 0; i < repos.length; i++) if (repos[i] && repos[i].name === name) return repos[i];
    return null;
  }

  function repoUrl(repo) {
    var r = repo && repo.remote;
    return r && r.owner && r.repo ? 'https://github.com/' + r.owner + '/' + r.repo : null;
  }

  function open(url) {
    if (!url) return;
    Promise.resolve(window.sb.openExternal(url))['catch'](function () {});
  }

  function pathSpans(p) {
    var e = D.elide(p);
    return [h('span.dir', null, e.dir), h('span.base', null, e.base)];
  }

  // A file's status is not in GitHub's per-file payload, but its first hunk header
  // gives it away: an added file starts at `-0,0` and a deleted one ends at `+0,0`.
  function statusOf(file) {
    var m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(file.patch || '');
    if (m) {
      if (Number(m[1]) === 0 && Number(m[2] === undefined ? 1 : m[2]) === 0) return 'A';
      if (Number(m[3]) === 0 && Number(m[4] === undefined ? 1 : m[4]) === 0) return 'D';
    }
    return 'M';
  }

  function copy(command) {
    var write = navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText(command)
      : Promise.reject();
    return Promise.resolve(write)['catch'](function () {
      // file:// without clipboard permission still has the old execCommand path.
      var box = document.createElement('textarea');
      box.value = command;
      box.setAttribute('readonly', '');
      box.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(box);
      box.select();
      try { document.execCommand('copy'); } catch (_) { /* nothing else to try */ }
      document.body.removeChild(box);
    });
  }

  function copyButton(command) {
    var label = copied[command] ? 'Copied' : 'Copy command';
    return h('button.btn', {
      type: 'button',
      onClick: function () {
        copy(command).then(function () {
          copied[command] = true;
          SB.render();
          setTimeout(function () {
            delete copied[command];
            SB.render();
          }, 2000);
        });
      }
    }, label);
  }

  function md(text) {
    return SB.markdown ? SB.markdown.render(text) : D.text(text);
  }

  // The same element id diffview.js gives a comment card, so the Overview can jump to it.
  function cardId(prefix, id) {
    return 'cmt-' + String(prefix || '').replace(/[^\w-]+/g, '-') + '-' + id;
  }

  // ── header ────────────────────────────────────────────────────────────────

  // Both navigable crumb parts land on the workspace screen: the repo has no screen
  // of its own, and the interaction spec pops Pull request → Workspace. The workspace
  // name jumps to its Terminal, matching the title everywhere else; the repo name
  // keeps the conventional step up to Changes, which is also the caret.
  function crumb(route) {
    if (byNumber(route)) {
      var toList = function () { SB.go({ view: 'prs' }); };
      return D.crumb([
        { label: 'Pull requests', onClick: toList },
        { label: route.repo, onClick: toList },
        { label: 'Pull request' }
      ]);
    }
    var wsId = route.wsId;
    var back = function () { SB.go({ view: 'workspace', wsId: wsId, tab: 'changes' }); };
    var toTerminal = function () { SB.go({ view: 'workspace', wsId: wsId, tab: 'terminal' }); };
    return D.crumb([
      { label: wsId, onClick: toTerminal },
      { label: route.repo, onClick: back },
      { label: 'Pull request' }
    ]);
  }

  var STATES = {
    OPEN: { label: 'Open', cls: '.open' },
    DRAFT: { label: 'Draft', cls: '.open.draft' },
    MERGED: { label: 'Merged', cls: '.open.merged' },
    CLOSED: { label: 'Closed', cls: '.open.closed' }
  };

  function statePill(state) {
    var s = STATES[String(state || '').toUpperCase()] || STATES.OPEN;
    return h('span' + s.cls, null, s.label);
  }

  var DECISIONS = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested' };

  // `TASK-352 → main · 3 commits · 3 files · +22 −3 · 3 comments · approved · pushed 2h ago`
  function subLine(pr) {
    var parts = [];
    if (pr.headRef || pr.baseRef) parts.push(D.text((pr.headRef || '?') + ' → ' + (pr.baseRef || 'main')));
    parts.push(D.text(D.plural(pr.commits, 'commit')));
    parts.push(D.text(D.plural(pr.changedFiles, 'file')));
    parts.push(D.pm(pr.additions, pr.deletions));
    if (pr.commentCount) parts.push(D.text(D.plural(pr.commentCount, 'comment')));
    if (DECISIONS[pr.reviewDecision]) parts.push(D.text(DECISIONS[pr.reviewDecision]));
    var ago = D.fmtAgo(pr.updatedAt);
    if (ago) parts.push(D.text('pushed ' + ago));

    var line = h('div.sub.sec');
    for (var i = 0; i < parts.length; i++) {
      if (i) line.appendChild(D.text(' · '));
      line.appendChild(parts[i]);
    }
    return line;
  }

  function tabRoute(route, tab) {
    return byNumber(route)
      ? { view: 'pr', owner: route.owner, repo: route.repo, number: route.number, tab: tab }
      : { view: 'pr', wsId: route.wsId, repo: route.repo, tab: tab };
  }

  function segmented(route, tab) {
    function option(id, label) {
      return h('button' + (tab === id ? '.on' : ''), {
        type: 'button',
        onClick: function () { SB.go(tabRoute(route, id)); }
      }, label);
    }
    return h('div.seg', null, option('overview', 'Overview'), option('files', 'Files'), option('all', 'All diffs'));
  }

  // ── the action ────────────────────────────────────────────────────────────

  // What sb:pr:merge needs to name this pull request: the route's own identity, and
  // the number the screen is showing.
  function mergeRef(route, pr) {
    var ref = byNumber(route)
      ? { owner: route.owner, repo: route.repo, host: route.host || null }
      : { wsId: route.wsId, repoName: route.repo };
    ref.number = pr.number;
    return ref;
  }

  // Squash and merge — the commits become one on the base branch, the way the user
  // always merges, so the button says so and asks nothing further; the head it sends
  // along is the one on screen, which GitHub checks before it merges. Only an open pull
  // request can be merged: a draft has to be marked ready on GitHub and conflicts have
  // to be resolved, so those read why in the tooltip instead of failing on the click.
  // (The tooltip sits on a wrapper: a disabled button takes no pointer events.)
  function mergeButton(route, pr) {
    var state = String(pr.state || '').toUpperCase();
    if (state !== 'OPEN' && state !== 'DRAFT') return null;
    var base = pr.baseRef || 'main';
    var ref = mergeRef(route, pr);
    var merging = typeof SB.busy === 'function' && typeof SB.mergeKey === 'function' && SB.busy(SB.mergeKey(ref));
    var why = state === 'DRAFT'
      ? 'a draft cannot be merged — mark it ready for review on GitHub first'
      : pr.mergeable === 'CONFLICTING'
        ? 'has conflicts with ' + base + ' — resolve them first'
        : null;
    var button = h('button.btn.pri' + (why || merging ? '.off' : ''), {
      type: 'button',
      title: why ? null : 'squash ' + D.plural(pr.commits, 'commit') + ' into one and merge it into ' + base,
      disabled: !!(why || merging),
      onClick: function () {
        if (why || merging || typeof SB.mergePr !== 'function') return;
        SB.mergePr(ref, { headSha: pr.headSha || null, baseRef: base });
      }
    }, merging ? D.spinner() : D.icon('merge'), merging ? 'Merging…' : 'Squash and merge');
    return why ? h('span', { title: why }, button) : button;
  }

  function header(route, pr) {
    return h('div.hd', null,
      crumb(route),
      h('div.top', { style: 'margin-top:10px' },
        // The title is the only part that may ellipsise: drop the #number and the
        // screen no longer says which pull request it is showing (the breadcrumb
        // is workspace › repo › Pull request). styles.css does the shrinking.
        h('h1.pr', null,
          h('span.t', null, pr.title || ''),
          h('span.sec', null, '#' + pr.number)),
        statePill(pr.state),
        mergeButton(route, pr),
        pr.url
          ? h('button.btn', { type: 'button', onClick: function () { open(pr.url); } },
            D.icon('ext'), 'Open on GitHub')
          : null),
      subLine(pr));
  }

  // ── body: Overview ────────────────────────────────────────────────────────

  // 👍 1 — with who left it in the tooltip, when GitHub said.
  function reactionChips(list) {
    if (!list || !list.length) return null;
    var box = h('span.rx');
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var who = r.users || [];
      var extra = r.count - who.length;
      var title = who.length
        ? who.join(', ') + (extra > 0 ? ' and ' + D.plural(extra, 'other') : '')
        : D.plural(r.count, 'reaction');
      box.appendChild(h('span.rxc', { title: title }, h('span.em', null, r.emoji), String(r.count)));
    }
    return box;
  }

  function avatar(initials) {
    return h('span.av', null, String(initials || '??').slice(0, 2).toUpperCase());
  }

  function descriptionCard(pr) {
    var card = h('div.cmt.desc');
    card.appendChild(h('div.ch',
      avatar(pr.avatarInitials),
      h('b', null, pr.author || 'someone'),
      h('span.sec', null, 'opened ' + (pr.relative || D.fmtAgo(pr.createdAt) || '')),
      h('span.sp')));
    var body = String(pr.body || '').trim();
    card.appendChild(body ? h('div.cb.md', null, md(body)) : h('div.cb.none.sec', null, 'no description'));
    // The reactions sit at the foot of the description, where the eye is when it has
    // read it — not in the header's far corner, half a screen from the text on a wide
    // window. They are the Codex connector's "nothing to report" (§4.11).
    var rx = reactionChips(pr.reactions);
    if (rx) card.appendChild(h('div.cf.rxs', null, rx));
    return card;
  }

  // The verdict is only worth a chip when it is one: every review "commented".
  function verdictChip(item) {
    if (item.kind !== 'review') return null;
    if (item.state === 'APPROVED') return h('span.open', null, 'Approved');
    if (item.state === 'CHANGES_REQUESTED') return h('span.open.closed', null, 'Changes requested');
    if (item.state === 'DISMISSED') return h('span.rsv', null, 'Dismissed');
    return null;
  }

  function jump(route, prefix, c) {
    focusPath = c.path || null;
    focusId = c.id !== null && c.id !== undefined ? cardId(prefix, c.id) : null;
    SB.go(tabRoute(route, 'all'));
  }

  // One inline review comment, with the line it sits on as the way into All diffs.
  function inlineCard(route, prefix, pr, c) {
    var card = h('div.cmt.inl');
    card.appendChild(h('div.ch',
      avatar(c.avatarInitials || c.author),
      h('b', null, c.author || 'someone'),
      c.relative ? h('span.sec', null, c.relative) : null,
      h('span.sp'),
      c.outdated ? h('span.sec', null, 'outdated') : null,
      c.resolved ? h('span.rsv', null, 'Resolved') : null,
      reactionChips(c.reactions)));
    if (c.path) {
      card.appendChild(h('div.at', null, h('button.loc.mono', {
        type: 'button',
        title: 'Show in All diffs',
        onClick: function () { jump(route, prefix, c); }
      }, c.path + (c.line ? ':' + c.line : ''))));
    }
    card.appendChild(h('div.cb.md', null, md(c.body)));
    var url = commentUrl(pr, c);
    if (url) card.appendChild(footer(url));
    return card;
  }

  function footer(url) {
    return h('div.cf', h('button', { type: 'button', title: url, onClick: function () { open(url); } }, 'Reply on GitHub'));
  }

  // A conversation comment or a review. A review that is only a shell around its
  // inline comments — no body, no verdict — shows those comments and nothing else.
  function eventCard(route, prefix, pr, item) {
    var comments = item.comments || [];
    var body = String(item.body || '').trim();
    var verdict = verdictChip(item);
    if (item.kind === 'inline' || (!body && !verdict && comments.length)) {
      var frag = D.frag();
      for (var k = 0; k < comments.length; k++) frag.appendChild(inlineCard(route, prefix, pr, comments[k]));
      return frag;
    }
    var card = h('div.cmt.ev');
    card.appendChild(h('div.ch',
      avatar(item.avatarInitials || item.author),
      h('b', null, item.author || 'someone'),
      verdict,
      item.relative ? h('span.sec', null, item.relative) : null,
      h('span.sp'),
      reactionChips(item.reactions)));
    if (body) card.appendChild(h('div.cb.md', null, md(body)));
    if (comments.length) {
      var list = h('div.ics');
      for (var i = 0; i < comments.length; i++) list.appendChild(inlineCard(route, prefix, pr, comments[i]));
      card.appendChild(list);
    }
    if (item.url) card.appendChild(footer(item.url));
    return card;
  }

  // Two halves: the description on the left, the conversation on the right, each
  // scrolling on its own — a long description never pushes what was said about it
  // below the fold, and on a wide window neither is a narrow column in a field of
  // white. Under 900px of body width they stack and scroll as one (styles.css).
  function overviewBody(route, prefix, pr) {
    var bd = h('div.bd.ov');
    var left = h('div.col.dcol');
    left.appendChild(h('div.ovh', null, 'Description'));
    left.appendChild(descriptionCard(pr));
    var right = h('div.col.ccol');
    var timeline = pr.timeline || [];
    right.appendChild(h('div.ovh', null, timeline.length ? 'Conversation' : 'Nothing said yet'));
    for (var i = 0; i < timeline.length; i++) right.appendChild(eventCard(route, prefix, pr, timeline[i]));
    bd.appendChild(h('div.cols', null, left, right));
    return bd;
  }

  // ── body: All diffs ───────────────────────────────────────────────────────

  function commentsFor(comments, path) {
    var out = [];
    for (var i = 0; i < comments.length; i++) if (comments[i] && comments[i].path === path) out.push(comments[i]);
    return out;
  }

  // The exact comment on GitHub: its own url when github.js sends one, otherwise
  // the PR page anchored at its databaseId — the address GitHub itself builds.
  function commentUrl(pr, c) {
    if (c && c.url) return String(c.url);
    if (pr && pr.url && c && c.id !== null && c.id !== undefined) return pr.url + '#discussion_r' + c.id;
    return null;
  }

  function openable(pr, list) {
    if (pr && pr.url) return true;
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].url) return true;
    return false;
  }

  // GitHub sends `patch: null` for binary files and for anything over its size cap,
  // so a card with no patch still gets its header — just a note where the diff goes.
  function note(file, url) {
    var text = file.binary
      ? 'binary file'
      : 'diff too large · ' + D.plural((file.add || 0) + (file.del || 0), 'line');
    return h('div.diff', null, h('div.note', null,
      text,
      h('span.sp'),
      url ? h('button.btn.sm', { type: 'button', onClick: function () { open(url); } }, 'Open on GitHub') : null));
  }

  function fileCard(slot, prefix, pr, file, comments) {
    var key = slot + '\0' + file.path;
    var card = h('div.dfile' + (folded[key] ? '.folded' : ''));
    var mine = commentsFor(comments, file.path);

    card.appendChild(h('div.fh', {
      onClick: function () {
        if (folded[key]) delete folded[key]; else folded[key] = true;
        card.classList.toggle('folded', !!folded[key]);
      }
    },
    h('span.cv', null, D.icon('chev')),
    h('span.p.mono', { title: file.path }, pathSpans(file.path)),
    mine.length ? h('span.cc', null, D.plural(mine.length, 'comment')) : null,
    h('span.mono', null, D.pm(file.add, file.del))));

    card.appendChild(file.patch
      ? SB.diffview.render(file.patch, {
        comments: mine,
        repoPrefix: prefix,
        // There is no reply/resolve IPC (ARCHITECTURE §4.4); the comment's own
        // address on GitHub is the only thing this card can honestly offer.
        onOpen: openable(pr, mine) ? function (c) { open(commentUrl(pr, c)); } : null,
        commentUrl: function (c) { return commentUrl(pr, c); }
      })
      : note(file, pr.url ? pr.url + '/files' : null));
    return card;
  }

  // ── body: Files ───────────────────────────────────────────────────────────

  function fileRow(route, file) {
    var status = statusOf(file);
    return h('div.fr', {
      onClick: function () {
        focusPath = file.path;
        focusId = null;
        SB.go(tabRoute(route, 'all'));
      }
    },
    h('span.st.' + status, null, status),
    h('span.p.mono', { title: file.path }, pathSpans(file.path)),
    h('span.n.mono', null, D.pm(file.add, file.del)),
    D.blocks(file.add, file.del),
    h('span.cv', null, D.icon('chev')));
  }

  // ── failure bodies ────────────────────────────────────────────────────────

  function bar(children) {
    var box = h('div.bar.err');
    for (var i = 0; i < children.length; i++) box.appendChild(children[i]);
    return box;
  }

  // The sentences gh hands back, as one line each with the one thing that fixes it.
  // views/prs.js borrows this for its own screen.
  function failure(error, opts) {
    var o = opts || {};
    if (/not installed/i.test(error)) {
      return bar([
        h('span', null, 'gh is not installed — run ', h('code', null, 'brew install gh'), ' to see pull requests'),
        h('span.sp'),
        copyButton('brew install gh')
      ]);
    }
    if (/not signed in|not authenticated/i.test(error)) {
      return bar([
        h('span', null, 'gh is not signed in — run ', h('code', null, 'gh auth login')),
        h('span.sp'),
        copyButton('gh auth login')
      ]);
    }
    // Unreachable, timed out, or anything else gh said — one line and a way to try again.
    return bar([
      h('span', null, error),
      h('span.sp'),
      typeof o.retry === 'function' ? h('button.btn', { type: 'button', onClick: o.retry }, 'Retry') : null
    ]);
  }

  function failureBody(error, route, repo) {
    if (/^no pull request for/i.test(error)) {
      var url = repoUrl(repo);
      return D.empty('push the branch and GitHub will offer to open one.', {
        title: error,
        action: url ? { label: 'Open on GitHub', onClick: function () { open(url); } } : null
      });
    }
    if (/^no pull request #/i.test(error)) {
      var pulls = 'https://github.com/' + route.owner + '/' + route.repo + '/pulls';
      return D.empty('it may have been closed, or the list is out of date.', {
        title: error,
        action: { label: 'Open on GitHub', onClick: function () { open(pulls); } }
      });
    }
    return failure(error, { retry: function () { retry(route); } });
  }

  // ── render ────────────────────────────────────────────────────────────────

  function tabOf(route) {
    return route.tab === 'files' ? 'files' : route.tab === 'all' ? 'all' : 'overview';
  }

  // The tab is already known while gh runs, so the segmented control must show it:
  // highlighting 'All diffs' for the whole round trip and then snapping to 'Overview'
  // when the data lands makes the app look like it changed its mind.
  function loadingScreen(route, repo, tab) {
    var known = byNumber(route) ? route.number : repo && repo.pr && repo.pr.number;
    return D.frag(
      h('div.hd', null,
        crumb(route),
        h('div.top', { style: 'margin-top:10px' },
          h('h1.pr', null, h('span.sk.w3'), known ? h('span.sec', null, '#' + known) : null)),
        h('div.sub.sec', null, 'loading…'),
        segmented(route, tab)),
      h('div.bd'));
  }

  function render(state) {
    var route = state.route || {};
    var tab = tabOf(route);
    var ws = byNumber(route) ? null : (state.byId || {})[route.wsId] || null;
    var repo = byNumber(route) ? null : findRepo(ws, route.repo);

    var result = loadPr(route);
    if (!result) return loadingScreen(route, repo, tab);

    if (!result.ok) {
      return D.frag(
        h('div.hd.tight', null, crumb(route)),
        h('div.bd', null, failureBody(String(result.error || 'gh could not read the pull request'), route, repo)));
    }

    var pr = result.pr || {};
    var files = pr.files || [];
    var comments = pr.comments || [];
    // Comment element ids carry the repo name; from the list that is the remote's.
    var prefix = byNumber(route) ? (pr.repo || route.repo) : route.repo;
    var slot = slotOf(route);

    var bd;
    var target = null;

    if (tab === 'overview') {
      bd = overviewBody(route, prefix, pr);
    } else {
      bd = h('div.bd');
      if (!files.length) {
        bd.appendChild(D.empty('this pull request changes no files.'));
      } else if (tab === 'files') {
        for (var i = 0; i < files.length; i++) bd.appendChild(fileRow(route, files[i]));
      } else {
        // A jump into a folded card must land on something visible.
        if (focusPath) delete folded[slot + '\0' + focusPath];
        for (var j = 0; j < files.length; j++) {
          var card = fileCard(slot, prefix, pr, files[j], comments);
          if (focusPath && files[j].path === focusPath) target = card;
          bd.appendChild(card);
        }
        if (focusId && target) target = target.querySelector('#' + focusId) || target;
      }
    }

    // A tap on the Files tab or an Overview comment lands on that spot in All diffs;
    // the scroll has to wait for app.js to put this fragment in the document.
    if (focusPath || focusId) {
      var block = focusId ? 'center' : 'start';
      focusPath = null;
      focusId = null;
      if (target) {
        requestAnimationFrame(function () {
          if (target.isConnected) target.scrollIntoView({ block: block });
        });
      }
    }

    var hd = header(route, pr);
    hd.appendChild(segmented(route, tab));
    return D.frag(hd, bd);
  }

  SB.views = SB.views || {};
  SB.views.pr = { render: render, refresh: refresh, failure: failure };
})(window.SB);
