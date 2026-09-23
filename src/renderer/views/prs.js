// SB.views.prs — the Pull requests screen: every open pull request the signed-in user
// authored, in any repository, newest activity first. ARCHITECTURE §6 R12.
//
// One row per pull request — the repo, the number and title, then only the state that
// matters at a glance: Draft, the review verdict, whether the checks pass, how many
// conversations, when it last moved. A row opens the Pull request screen with its
// Overview up (views/pr.js, named by owner/repo/number since this list spans repos
// that may be cloned nowhere under the root); Esc comes back here.
//
// The data is one gh search (sb.myPrs), routed through SB.load so a re-render never
// re-fetches. A refresh keeps the rows on screen while gh answers, and a refresh that
// fails keeps the last good list up with a one-line note rather than blanking it.
window.SB = window.SB || {};

(function (SB) {
  'use strict';

  var D = SB.dom;
  var h = D.h;

  var KEY = 'prs:mine';
  var wantFresh = false;     // the next load skips main's 60 s cache — ⌘R, the ↻
  var lastGood = null;       // the last { ok:true, login, prs, fetchedAt } answer

  // ── data ──────────────────────────────────────────────────────────────────

  function fetch() {
    var fresh = wantFresh;
    wantFresh = false;
    return Promise.resolve(window.sb.myPrs({ fresh: fresh })).then(function (r) {
      return r || { ok: false, error: 'gh returned nothing' };
    }, function (err) {
      return { ok: false, error: (err && err.message) || 'could not reach the main process' };
    });
  }

  // app.js's SB.load memoises per key: { status, value, error, running }. An entry
  // revalidating on top of good data keeps its value, so the rows stay put while gh
  // answers — the ↻ spins and nothing flashes.
  function load() {
    var entry = SB.load(KEY, fetch);
    var res = entry && entry.value && typeof entry.value.ok === 'boolean' ? entry.value : null;
    if (res && res.ok) lastGood = res;
    return { res: res, running: !!(entry && entry.running) };
  }

  // app.js calls this on a window focus (soft: main's cache may answer) and on ⌘R
  // (hard: GitHub is asked again now); the header's ↻ is the hard one.
  function refresh(hard) {
    if (hard) wantFresh = true;
    if (typeof SB.invalidate === 'function') SB.invalidate(KEY);
  }

  function open(url) {
    if (!url) return;
    Promise.resolve(window.sb.openExternal(url))['catch'](function () {});
  }

  function openPr(pr) {
    SB.go({ view: 'pr', owner: pr.owner, repo: pr.repo, number: pr.number, tab: 'overview' });
  }

  // ── header ────────────────────────────────────────────────────────────────

  // "3 open · updated 40s ago", ticking in place the way the Usage screen's does.
  function subLine(running) {
    var span = h('span');
    function tick() {
      var d = lastGood;
      if (!d) { span.textContent = running ? 'asking GitHub…' : ''; return; }
      var words = [D.plural(d.prs.length, 'open pull request')];
      var ago = D.fmtAgo(d.fetchedAt);
      if (ago) words.push('updated ' + ago);
      span.textContent = words.join(' · ');
    }
    tick();
    var timer = setInterval(function () {
      if (!span.isConnected) { clearInterval(timer); return; }
      tick();
    }, 5000);
    return span;
  }

  function header(running) {
    var hd = h('div.hd.tight');
    var top = h('div.top', null, h('h1', null, 'Pull requests'));
    if (lastGood && lastGood.login) top.appendChild(h('span.plan.sec', null, lastGood.login));
    top.appendChild(h('button.ib' + (running ? '.busy' : ''), {
      type: 'button',
      title: 'Ask GitHub again  ⌘R',
      'aria-label': 'Refresh',
      onClick: function () { refresh(true); }
    }, D.icon('sync')));
    hd.appendChild(top);
    hd.appendChild(h('div.sub.sec', null, subLine(running)));
    return hd;
  }

  // ── rows ──────────────────────────────────────────────────────────────────

  var DECISION = {
    APPROVED: { label: 'Approved', cls: '.open' },
    CHANGES_REQUESTED: { label: 'Changes requested', cls: '.open.closed' }
  };

  var CHECKS = {
    SUCCESS: { dot: 'run', title: 'checks passed' },
    FAILURE: { dot: 'fail', title: 'checks failed' },
    ERROR: { dot: 'fail', title: 'checks errored' },
    PENDING: { dot: 'chg', title: 'checks running' },
    EXPECTED: { dot: 'chg', title: 'checks expected' }
  };

  function row(pr) {
    var el = h('div.prr', {
      role: 'button',
      tabindex: '0',
      title: pr.owner + '/' + pr.repo + ' #' + pr.number + ' · ' + pr.headRef + ' → ' + pr.baseRef,
      onClick: function () { openPr(pr); },
      onKeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPr(pr); } }
    });
    el.appendChild(h('span.rn', null, pr.repo));
    el.appendChild(h('span.t', null, h('span.sec', null, '#' + pr.number + ' '), pr.title));
    if (pr.state === 'DRAFT') el.appendChild(h('span.open.draft', null, 'Draft'));
    var d = DECISION[pr.reviewDecision];
    if (d) el.appendChild(h('span' + d.cls, null, d.label));
    var c = CHECKS[pr.checks];
    if (c) el.appendChild(h('span.dot.' + c.dot, { title: c.title }));
    if (pr.comments) el.appendChild(h('span.n.sec', null, D.plural(pr.comments, 'comment')));
    el.appendChild(h('span.n.sec', null, pr.relative || D.fmtAgo(pr.updatedAt)));
    el.appendChild(h('span.cv', null, D.icon('chev')));
    return el;
  }

  function skeletonRows(bd) {
    for (var i = 0; i < 3; i++) {
      bd.appendChild(h('div.prr', h('span.rn', null, h('span.sk.w2')), h('span.t', null, h('span.sk.w3')), h('span.sk.w1')));
    }
  }

  // The repo column is 150px in the design; widen it to the longest name in the list
  // so the titles line up, exactly as the workspace screen does for its repos.
  var ruler = null;
  function nameColumn(prs) {
    if (!ruler) {
      ruler = document.createElement('canvas').getContext('2d');
      ruler.font = '600 13px -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif';
    }
    var widest = 0;
    for (var i = 0; i < prs.length; i++) widest = Math.max(widest, ruler.measureText(prs[i].repo || '').width);
    return Math.min(260, Math.max(150, Math.ceil(widest) + 14));
  }

  // ── body ──────────────────────────────────────────────────────────────────

  function failureBar(error) {
    var pr = SB.views.pr;
    if (pr && typeof pr.failure === 'function') return pr.failure(error, { retry: function () { refresh(true); } });
    return D.errorBox(error, { retry: function () { refresh(true); } });
  }

  function body(res) {
    var bd = h('div.bd');
    if (res && !res.ok) {
      if (lastGood) {
        bd.appendChild(h('div.bar.warn', h('span', null, 'couldn’t refresh — ' + res.error), h('span.sp'),
          h('button.btn', { type: 'button', onClick: function () { refresh(true); } }, 'Retry')));
      } else {
        bd.appendChild(failureBar(String(res.error || 'gh could not list your pull requests')));
        return bd;
      }
    }
    if (!lastGood) { skeletonRows(bd); return bd; }
    var prs = lastGood.prs || [];
    if (!prs.length) {
      bd.appendChild(D.empty('nothing of yours is open on GitHub right now.', {
        title: 'no open pull requests',
        action: { label: 'Open on GitHub', onClick: function () { open('https://github.com/pulls'); } }
      }));
      return bd;
    }
    bd.style.setProperty('--repo-name', nameColumn(prs) + 'px');
    for (var i = 0; i < prs.length; i++) bd.appendChild(row(prs[i]));
    return bd;
  }

  function render() {
    var got = load();
    return D.frag(header(got.running), body(got.res));
  }

  SB.views = SB.views || {};
  SB.views.prs = { render: render, refresh: refresh };
})(window.SB);
