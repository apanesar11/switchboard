// SB.views.usage — the Usage screen, and the Grid header's five-hour gauge.
// ARCHITECTURE §6 R11.
//
// What claude.ai's "Your usage" page shows, in the app: the five-hour session window,
// the week, and any per-model week ("Fable this week"), each as one row — name, bar,
// percent, when it resets. The data is main's (sb:usage:get and sb:evt:usage, §4.11)
// and lives in state.usage; this file only draws it.
//
// The gauge is the Grid header's one line about Claude. When a poll lands, refresh()
// rewrites it in place rather than app.js rendering: a bar that moved two percent is
// not worth re-parenting four live terminals and dropping whichever one had focus.
window.SB = window.SB || {};

(function (SB) {
  'use strict';

  var D = SB.dom;
  var h = D.h;

  var SEVERITIES = ['normal', 'warning', 'critical'];

  function usage() { return SB.state ? SB.state.usage : null; }            // last GOOD, or null
  function usageError() { return SB.state ? SB.state.usageError : null; }  // a failed refresh

  // ── words ─────────────────────────────────────────────────────────────────

  // "5:00 PM" when it is today, "Thu 2:00 PM" inside the week, "Sep 24, 2:00 PM"
  // past it — the way claude.ai writes its own "Resets" lines.
  function fmtReset(iso) {
    var t = Date.parse(iso || '');
    if (isNaN(t)) return '';
    var d = new Date(t);
    var now = new Date();
    var time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    var sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (sameDay) return time;
    var days = (t - now.getTime()) / 86400000;
    if (days > -1 && days < 6.5) return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + time;
  }

  function resetText(limit) {
    var when = fmtReset(limit.resetsAt);
    return when ? 'resets ' + when : '';
  }

  function bar(limit) {
    return h('span.track', {
      role: 'progressbar',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': String(limit.percent)
    }, h('span.fill', { style: { width: limit.percent + '%' } }));
  }

  // ── the Grid's gauge ──────────────────────────────────────────────────────

  function fillGauge(el, s) {
    D.clear(el);
    SEVERITIES.forEach(function (c) { el.classList.remove(c); });
    el.classList.add(s.severity);
    var when = resetText(s);
    var words = s.percent + '% of this session’s Claude usage' + (when ? ', ' + when : '');
    el.title = words;
    el.setAttribute('aria-label', words);
    el.appendChild(bar(s));
    el.appendChild(h('span.pct', null, s.percent + '%'));
    if (when) el.appendChild(h('span.when.sec', null, '· ' + when));
  }

  // null before the first good answer or after sign-out. A transient refresh failure
  // does not take the gauge away — state.usage is still the last good numbers.
  function gauge() {
    var u = usage();
    if (!u || !u.session) return null;
    var el = h('button.gauge', { type: 'button', onClick: function () { SB.go({ view: 'usage' }); } });
    fillGauge(el, u.session);
    return el;
  }

  // Bring every gauge on screen up to date with state.usage. True when the document
  // now agrees with it; false when only a rebuild can make it — the gauge has to
  // appear on a Grid that has none, or go from one that should no longer show it.
  function refresh() {
    var u = usage();
    var want = !!(u && u.session);
    var live = Array.prototype.slice.call(document.querySelectorAll('.gauge'));
    if (!want) {
      live.forEach(function (el) { el.remove(); });
      return true;
    }
    if (!live.length) return !document.querySelector('#main .gridhd');
    live.forEach(function (el) { fillGauge(el, u.session); });
    return true;
  }

  // ── the screen ────────────────────────────────────────────────────────────

  // "updated 40s ago", ticking in place the way the workspace header's "running 14s"
  // does; it reads state.usage each time, so a poll that changed nothing visible
  // still moves the clock back to "just now".
  function updatedSpan() {
    var span = h('span.sec');
    function tick() {
      var u = usage();
      var when = u ? 'updated ' + D.fmtAgo(u.fetchedAt) : '';
      // A failed refresh with good numbers still on screen: say the numbers are the
      // last good ones, quietly, rather than blanking them.
      span.textContent = usageError() ? (when ? when + ' · couldn’t refresh' : 'couldn’t refresh') : when;
    }
    tick();                                   // now, before it is in the document
    var timer = setInterval(function () {
      if (!span.isConnected) { clearInterval(timer); return; }
      tick();
    }, 5000);
    return span;
  }

  // The one action on the screen: ask again now. ⌘R is the same thing — the View
  // menu's Refresh lands in app.js handleFocus, which sends it here on this route.
  function refreshButton() {
    var busy = typeof SB.busy === 'function' && SB.busy('usage');
    return h('button.ib' + (busy ? '.busy' : ''), {
      type: 'button',
      title: 'Ask Anthropic again  \u2318R',
      'aria-label': 'Refresh',
      onClick: function () { SB.refreshUsage(); }
    }, D.icon('sync'));
  }

  function header(u, err) {
    var hd = h('div.hd.tight');
    var top = h('div.top', null, h('h1', null, 'Usage'));
    if (u && u.plan) top.appendChild(h('span.plan.sec', null, u.plan));
    top.appendChild(refreshButton());
    hd.appendChild(top);
    var sub = h('div.sub');
    if (u) sub.appendChild(updatedSpan());          // has good numbers; note any failed refresh
    else if (err) sub.appendChild(h('span.sec', null, 'not available'));
    else sub.appendChild(h('span.sec', null, 'checking…'));
    hd.appendChild(sub);
    return hd;
  }

  function row(limit) {
    return h('div.ulim.' + limit.severity, null,
      h('span.rn', null, limit.name),
      bar(limit),
      h('span.pct', null, limit.percent + '%'),
      h('span.when.sec', null, resetText(limit)));
  }

  function body(u, err) {
    var bd = h('div.bd');
    if (u) {
      var list = h('div.ulist');
      if (u.session) list.appendChild(row(u.session));
      if (u.weekly) list.appendChild(row(u.weekly));
      (u.scoped || []).forEach(function (l) { list.appendChild(row(l)); });
      bd.appendChild(list);
      return bd;
    }
    // A configured sign-in with no good numbers yet: the sentence and one action.
    // A passing rate-limit keeps the previous numbers above; sign-out hides this view.
    if (err) {
      bd.appendChild(D.empty(err, {
        action: { label: 'Try again', onClick: function () { SB.refreshUsage(); } }
      }));
    }
    return bd;
  }

  function render() {
    var u = usage();
    var err = usageError();
    return D.frag(header(u, err), body(u, err));
  }

  SB.views = SB.views || {};
  SB.views.usage = { render: render, gauge: gauge, refresh: refresh };
})(window.SB);
