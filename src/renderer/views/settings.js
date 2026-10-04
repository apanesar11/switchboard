// SB.views.settings — the Settings screen (§4.18, R16): this Mac's settings, reached
// from the rail's last row, App ▸ Settings… (⌘,) and the ✦ Answer menu's "Settings…".
//
// One section today, ✦ Answer on diagrams: which of the four ways answers a box's
// question on the Diagrams tab, and the API keys two of them need. One row per way to
// answer — what it does, whether it is ready on this Mac, one action — in the
// rail's rule: details a tap away, here the key's own panel under its row.
//
// main (src/main/answer.js) is the authority on all of it: which CLIs are installed and
// signed in, which models each API takes, whether a key is stored. This screen asks it
// on the way in, and follows sb:evt:answerStatus, which main sends after every change
// wherever it was made — the ✦ Answer menu included — so the two never disagree.
//
// A key typed here goes straight to main, which checks it with its provider and keeps
// it encrypted with the Keychain. It never comes back: the screen shows its last four
// characters, and the field is always empty.
window.SB = window.SB || {};
SB.views = SB.views || {};

(function (SB) {
  'use strict';

  var D = SB.dom;
  var h = D.h;

  var LOOK_AGAIN_MS = 30 * 1000;   // a visit after this long looks for the CLIs again

  var st = {
    status: null,                  // main's answer: { settings, providers, keysSafe }
    error: null,
    loading: false,
    lookedAt: 0,
    editing: null,                 // the API whose key panel is open
    draft: '',                     // what is typed into that panel's key field
    saving: false,
    keyError: null,
  };

  function message(err) {
    if (err === null || err === undefined) return 'that did not work';
    var s = typeof err === 'string' ? err : (err.error || err.message || String(err));
    return String(s)
      .replace(/^Error invoking remote method '[^']*':\s*/, '')
      .replace(/^(?:Uncaught )?Error:\s*/, '')
      .trim() || 'that did not work';
  }

  // Feature-checked and settled as a value, the way views/notes.js calls the bridge.
  function call(name) {
    var api = window.sb;
    var args = Array.prototype.slice.call(arguments, 1);
    if (!api || typeof api[name] !== 'function') {
      return Promise.resolve({ ok: false, error: 'this build of Switchboard has no settings' });
    }
    var out;
    try { out = api[name].apply(api, args); } catch (err) { return Promise.resolve({ ok: false, error: message(err) }); }
    return Promise.resolve(out).then(function (r) {
      return r && typeof r === 'object' ? r : { ok: false, error: 'the app process did not answer' };
    }, function (err) {
      return { ok: false, error: message(err) };
    });
  }

  function onScreen() {
    return !!(SB.state && SB.state.route && SB.state.route.view === 'settings');
  }

  function repaint() {
    if (onScreen() && typeof SB.render === 'function') SB.render();
  }

  function adopt(status) {
    if (!status || status.ok !== true) return;
    st.status = status;
    st.error = null;
    repaint();
  }

  function load(fresh) {
    if (st.loading) return;
    st.loading = true;
    call('answerStatus', { fresh: !!fresh }).then(function (r) {
      st.loading = false;
      st.lookedAt = Date.now();
      if (r.ok) adopt(r);
      else { st.error = r.error; repaint(); }
    });
  }

  if (window.sb && typeof window.sb.onAnswerStatus === 'function') {
    try { window.sb.onAnswerStatus(adopt); } catch (e) { console.error('[switchboard] settings: subscribe:', e); }
  }

  // ── actions ───────────────────────────────────────────────────────────────

  function change(patch) {
    if (st.status) {
      // Applied here first, so the radio answers the click at once; main's answer and
      // its broadcast land on the same state.
      for (var k in patch) st.status.settings[k] = patch[k];
      repaint();
    }
    call('answerSetSettings', patch).then(function (r) {
      if (r.ok) adopt(r);
      else { st.error = r.error; repaint(); }
    });
  }

  function openKey(id) {
    st.editing = st.editing === id ? null : id;
    st.draft = '';
    st.keyError = null;
    repaint();
    if (st.editing) {
      setTimeout(function () {
        var field = document.querySelector('.stedit .stkey');
        if (field) { try { field.focus({ preventScroll: true }); } catch (e) { field.focus(); } }
      }, 0);
    }
  }

  function saveKey(id) {
    var key = st.draft.trim();
    if (!key || st.saving) return;
    st.saving = true;
    st.keyError = null;
    repaint();
    call('answerSetKey', id, key).then(function (r) {
      st.saving = false;
      if (r.ok) {
        st.draft = '';
        st.editing = null;
        adopt(r);
        // A first key makes that API ready; if nothing was picked before, it is now the
        // one that answers — main's own choice says so, nothing to do here.
      } else {
        st.keyError = r.error;
      }
      repaint();
    });
  }

  function removeKey(id) {
    call('answerRemoveKey', id).then(function (r) {
      if (r.ok) { st.editing = null; adopt(r); } else { st.keyError = r.error; repaint(); }
    });
  }

  // ── the screen ────────────────────────────────────────────────────────────

  function who(id) {
    return id === 'claude-api' ? 'Anthropic' : 'OpenAI';
  }

  function stateLine(p) {
    if (p.state === 'ready') return h('span.ststate', null, h('span.dot.run'), h('span', null, p.line));
    if (p.state === 'signed-out') return h('span.ststate.warned', null, h('span', null, p.line));
    return h('span.ststate.sec', null, p.line);
  }

  function action(p, picked) {
    var out = h('span.stact');
    if (picked) out.appendChild(h('span.stdef', null, 'Default'));
    if (p.kind === 'cli') {
      if (p.state !== 'ready') {
        out.appendChild(h('button.btn.sm', {
          type: 'button',
          title: 'Look for ' + p.name + ' on this Mac again',
          onClick: function () { load(true); },
        }, st.loading ? 'Looking…' : 'Look again'));
      }
      return out;
    }
    var open = st.editing === p.id;
    out.appendChild(h('button.btn.sm' + (open ? '.on' : ''), {
      type: 'button',
      'aria-expanded': open ? 'true' : 'false',
      onClick: function () { openKey(p.id); },
    }, open ? 'Close' : p.hasKey ? 'Edit' : 'Add key'));
    return out;
  }

  function what(p) {
    return p.kind === 'cli' ? 'Reads the workspace first · slower' : 'Only the diagram · fast';
  }

  function row(p, settings) {
    var picked = settings.provider === p.id;
    var canPick = p.ready || picked;
    return h('div.strow' + (picked ? '.picked' : ''), null,
      h('button.rad' + (picked ? '.on' : ''), {
        type: 'button',
        role: 'radio',
        'aria-checked': picked ? 'true' : 'false',
        'aria-label': 'Answer with ' + p.name,
        disabled: !canPick,
        title: canPick ? 'Answer with ' + p.name : p.name + ' can’t answer on this Mac yet',
        onClick: function () { if (!picked) change({ provider: p.id }); },
      }),
      h('span.stnm', null,
        h('span.stname', null, p.name, h('span.pill', null, p.kind.toUpperCase())),
        h('span.stwhat.sec', null, what(p))),
      stateLine(p),
      action(p, picked));
  }

  function seg(options, current, onPick) {
    var box = h('div.seg', { role: 'radiogroup' });
    options.forEach(function (o) {
      box.appendChild(h('button' + (o.id === current ? '.on' : ''), {
        type: 'button',
        role: 'radio',
        'aria-checked': o.id === current ? 'true' : 'false',
        title: o.title || null,
        onClick: function () { if (o.id !== current) onPick(o.id); },
      }, o.name));
    });
    return box;
  }

  // The panel under an API's row: its key, its model, and for OpenAI the effort.
  function keyPanel(p, settings) {
    var field = h('input.stkey.mono', {
      type: 'password',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': p.name + ' key',
      placeholder: p.hasKey ? 'Paste a new key to replace the one ending ' + p.last4 : (p.id === 'claude-api' ? 'sk-ant-…' : 'sk-…'),
      value: st.draft,
      onInput: function (e) { st.draft = e.target.value; st.keyError = null; },
      onFocus: function (e) { var n = e.target.value.length; try { e.target.setSelectionRange(n, n); } catch (_) { /* not a text field */ } },
      onKeydown: function (e) {
        if (e.key === 'Enter') { e.preventDefault(); saveKey(p.id); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); openKey(p.id); }
      },
    });

    var models = (p.models || []).map(function (m) { return { id: m.id, name: m.name, title: m.id }; });
    var model = p.id === 'claude-api' ? settings.claudeApiModel : settings.openaiModel;
    var panel = h('div.stedit', null,
      h('div.stlbl', null, 'API key'),
      field,
      h('div.stlbl', null, 'Model'),
      seg(models, model, function (id) {
        change(p.id === 'claude-api' ? { claudeApiModel: id } : { openaiModel: id });
      }));

    if (p.id === 'openai-api') {
      var chosen = (p.models || []).filter(function (m) { return m.id === model; })[0];
      var efforts = (chosen && chosen.efforts) || [];
      panel.appendChild(h('div.stlbl', null, 'Effort'));
      panel.appendChild(seg(efforts, settings.openaiEffort, function (id) { change({ openaiEffort: id }); }));
    }

    var note = st.saving
      ? h('span.sec', null, 'Checking the key with ' + who(p.id) + '…')
      : st.keyError
        ? h('span.bad', null, st.keyError)
        : h('span.sec', null, 'Switchboard checks the key with ' + who(p.id) + ' before keeping it.');
    panel.appendChild(h('div.stbtns', null,
      h('button.btn.pri.sm', {
        type: 'button',
        disabled: st.saving,
        onClick: function () { saveKey(p.id); },
      }, p.hasKey ? 'Replace key' : 'Save key'),
      p.hasKey ? h('button.btn.sm', { type: 'button', onClick: function () { removeKey(p.id); } }, 'Remove key') : null,
      note));
    return panel;
  }

  function section(status) {
    var settings = status.settings;
    var list = h('div.stlist', { role: 'radiogroup', 'aria-label': 'Who answers' });
    status.providers.forEach(function (p) {
      list.appendChild(row(p, settings));
      if (p.kind === 'api' && st.editing === p.id) list.appendChild(keyPanel(p, settings));
    });
    return h('div.stsec', null,
      h('div.sth', null, '✦ Answer on diagrams'),
      h('p.stdesc.sec', null,
        'Who answers a box’s question on the Diagrams tab. Claude Code and Codex use their own ' +
        'sign-in and read the workspace’s code; the two APIs need a key and see only the diagram. ' +
        'The ✦ Answer menu switches between the same four.'),
      list,
      h('p.stfoot.sec', null, D.icon('lock'), h('span', null, status.keysSafe
        ? 'Keys are encrypted with this Mac’s Keychain and kept in ~/.switchboard/keys.json. Once saved, a key is never shown again — only its last four characters.'
        : 'This Mac’s Keychain isn’t available to Switchboard, so API keys can’t be kept here.')));
  }

  function render() {
    if (!st.status || Date.now() - st.lookedAt > LOOK_AGAIN_MS) load(true);
    var hd = h('div.hd.tight', null,
      h('div.top', null, h('h1', null, 'Settings')),
      h('div.sub', null, h('span.sec', null, 'This Mac')));
    var body;
    if (st.status) body = section(st.status);
    else if (st.error) body = D.errorBox(st.error, { retry: function () { load(true); } });
    else body = h('div.stsec', null, h('p.sec', null, 'Looking for Claude Code and Codex on this Mac…'));
    return D.frag(hd, h('div.bd', null, body));
  }

  SB.views.settings = { render: render };
})(window.SB);
