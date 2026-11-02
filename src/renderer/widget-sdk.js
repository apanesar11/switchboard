// widget-sdk.js — window.Switchboard, the whole contract a whiteboard widget is written
// against. ARCHITECTURE §4.17 (Widgets).
//
// Main serves this file into every widget at sbwidget://<id>/__switchboard/widget.js,
// from the app itself and never from the widget's folder, so a widget always speaks the
// protocol of the app that draws it. A widget loads it with
//
//   <script src="/__switchboard/widget.js"></script>
//
// and gets:
//
//   Switchboard.ready()            → Promise<{ widget: { id, name }, theme, size }>
//   Switchboard.fetch(path, init?) → Promise<{ ok, status, statusText, headers, text(), json() }>
//   Switchboard.onTheme(cb) / onResize(cb) / onRefresh(cb) → unsubscribe
//   Switchboard.theme, Switchboard.size, Switchboard.widget
//
// The widget never holds an API key. fetch() asks the whiteboard, which asks main, which
// reads the widget's manifest, attaches the key and talks only to the manifest's base
// URL; `path` is relative to it. The page's own CSP (connect-src 'self') is why there is
// no other way out.
//
// It also keeps <html data-theme="light|dark"> (and color-scheme) in step with the
// board, so plain CSS can follow it: [data-theme="dark"] { … } — whether or not the page
// ever calls ready(): the SDK says 'ready' itself as it loads, which is what has the board
// send the theme and the size as they change.
//
// The protocol — every message an object, `v: 1`, `sb: 'widget'` from here and
// `sb: 'host'` from the board:
//   widget → host: { type: 'ready' }, { type: 'fetch', id, path, init }
//   host → widget: { type: 'init', widget, theme, size }, { type: 'theme', theme },
//                  { type: 'resize', size }, { type: 'refresh' },
//                  { type: 'response', id, ok, status, statusText, headers, body } or
//                  { type: 'response', id, error, code? }
// Only messages from the parent window are read. What this page posts carries nothing
// a widget didn't write itself, so it goes to the parent whatever its origin.
(function () {
  'use strict';
  if (window.Switchboard) return;

  var VERSION = 1;
  // Longer than main's 20 s for a request, so main's own sentence is what a widget sees.
  var ANSWER_TIMEOUT_MS = 30000;
  var host = window.parent;
  var root = document.documentElement;

  var theme = firstTheme();
  var size = { width: window.innerWidth, height: window.innerHeight };
  var widget = null;
  var readyPromise = null;
  var resolveReady = null;
  var initMessage = null;
  var pending = {};
  // Each page counts its requests from somewhere of its own: the board answers whichever
  // page is in the frame when an answer lands, so one meant for the page before (since
  // reloaded) must never match a request of this one's.
  var nextId = 1 + Math.floor(Math.random() * 1e9);
  var themeListeners = [];
  var resizeListeners = [];
  var refreshListeners = [];

  // The board puts its theme in the page's address (?theme=dark), so the first paint is
  // already right; after that it comes as a message.
  function firstTheme() {
    var match = /[?&]theme=(light|dark)(?:&|$)/.exec(window.location.search);
    if (match) return match[1];
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (_) { return 'light'; }
  }

  function paintTheme() {
    root.setAttribute('data-theme', theme);
    root.style.colorScheme = theme;
  }
  paintTheme();

  function post(message) {
    message.sb = 'widget';
    message.v = VERSION;
    try { host.postMessage(message, '*'); } catch (_) { /* the board has gone */ }
  }

  function call(listeners, value) {
    var list = listeners.slice();
    for (var i = 0; i < list.length; i++) {
      try { list[i](value); } catch (err) { setTimeout(function () { throw err; }); }
    }
  }

  function subscribe(listeners, callback) {
    if (typeof callback !== 'function') throw new TypeError('Switchboard: pass a function');
    listeners.push(callback);
    return function unsubscribe() {
      var at = listeners.indexOf(callback);
      if (at !== -1) listeners.splice(at, 1);
    };
  }

  function setTheme(next) {
    if ((next !== 'light' && next !== 'dark') || next === theme) return;
    theme = next;
    paintTheme();
    call(themeListeners, theme);
  }

  function setSize(next) {
    if (!next || typeof next !== 'object') return;
    var width = Math.round(Number(next.width));
    var height = Math.round(Number(next.height));
    if (!(width > 0) || !(height > 0) || (width === size.width && height === size.height)) return;
    size = { width: width, height: height };
    call(resizeListeners, { width: width, height: height });
  }

  function snapshot() {
    return {
      widget: widget ? { id: widget.id, name: widget.name } : null,
      theme: theme,
      size: { width: size.width, height: size.height },
    };
  }

  function answer(message) {
    var waiting = pending[message.id];
    if (!waiting) return;
    delete pending[message.id];
    clearTimeout(waiting.timer);
    if (typeof message.error === 'string') {
      var error = new Error(message.error);
      if (typeof message.code === 'string') error.code = message.code;
      waiting.reject(error);
      return;
    }
    var body = typeof message.body === 'string' ? message.body : '';
    var headers = {};
    if (message.headers && typeof message.headers === 'object') {
      for (var name in message.headers) {
        if (Object.prototype.hasOwnProperty.call(message.headers, name)) headers[name] = String(message.headers[name]);
      }
    }
    var status = Number(message.status) || 0;
    waiting.resolve(Object.freeze({
      ok: status >= 200 && status < 300,
      status: status,
      statusText: typeof message.statusText === 'string' ? message.statusText : '',
      headers: headers,
      text: function () { return body; },
      json: function () { return JSON.parse(body); },
    }));
  }

  window.addEventListener('message', function (event) {
    if (event.source !== host) return;
    var message = event.data;
    if (!message || typeof message !== 'object' || message.sb !== 'host' || message.v !== VERSION) return;
    switch (message.type) {
      case 'init':
        if (message.widget && typeof message.widget === 'object') {
          widget = { id: String(message.widget.id || ''), name: String(message.widget.name || '') };
        }
        setTheme(message.theme);
        setSize(message.size);
        initMessage = message;
        if (resolveReady) { resolveReady(snapshot()); resolveReady = null; }
        break;
      case 'theme':
        setTheme(message.theme);
        break;
      case 'resize':
        setSize(message.size);
        break;
      case 'refresh':
        // A widget that keeps its own data fresh says how (onRefresh); one that doesn't
        // is simply loaded again.
        if (refreshListeners.length) call(refreshListeners, undefined);
        else window.location.reload();
        break;
      case 'response':
        answer(message);
        break;
    }
  });

  // The page's own size is the truest word on it; the board's resize says the same a
  // moment later.
  window.addEventListener('resize', function () {
    setSize({ width: window.innerWidth, height: window.innerHeight });
  });

  // The page's own wait for the board's `init`. The SDK has already said 'ready' as it
  // loaded (below); asked before any `init` has come, it says so again — the board
  // answers each with an `init`, and only the first one counts here.
  function ready() {
    if (!readyPromise) {
      readyPromise = new Promise(function (resolve) {
        if (initMessage) resolve(snapshot());
        else resolveReady = resolve;
      });
    }
    if (!initMessage) post({ type: 'ready' });
    return readyPromise;
  }

  /**
   * A request to the widget's API, made by the app: `path` is read against widget.json's
   * api.baseUrl (a leading "/" means the same), `init` is { method, headers, query, body }
   * — `query` an object of names and values, `body` text or anything JSON can say (sent as
   * JSON). Resolves to the answer, whatever its status; rejects with the app's reason when
   * it refuses or the API can't be reached (`error.code` is 'needs-secret' when no key has
   * been given yet).
   */
  function request(path, init) {
    if (typeof path !== 'string') return Promise.reject(new TypeError('Switchboard.fetch(path): path must be text'));
    init = init && typeof init === 'object' ? init : {};
    var headers = {};
    if (init.headers && typeof init.headers === 'object') {
      for (var name in init.headers) {
        if (Object.prototype.hasOwnProperty.call(init.headers, name)) headers[name] = String(init.headers[name]);
      }
    }
    var body = init.body;
    if (body !== undefined && body !== null && typeof body !== 'string') {
      try { body = JSON.stringify(body); } catch (err) { return Promise.reject(err); }
      var typed = false;
      for (var key in headers) if (key.toLowerCase() === 'content-type') typed = true;
      if (!typed) headers['Content-Type'] = 'application/json';
    }
    var id = nextId++;
    return new Promise(function (resolve, reject) {
      pending[id] = {
        resolve: resolve,
        reject: reject,
        timer: setTimeout(function () {
          delete pending[id];
          reject(new Error('Switchboard did not answer in time'));
        }, ANSWER_TIMEOUT_MS),
      };
      post({
        type: 'fetch',
        id: id,
        path: path,
        init: {
          method: typeof init.method === 'string' ? init.method : 'GET',
          headers: headers,
          query: init.query && typeof init.query === 'object' ? init.query : undefined,
          body: body === null ? undefined : body,
        },
      });
    });
  }

  var api = {};
  Object.defineProperties(api, {
    version: { value: VERSION, enumerable: true },
    ready: { value: ready, enumerable: true },
    fetch: { value: request, enumerable: true },
    onTheme: { value: function (callback) { return subscribe(themeListeners, callback); }, enumerable: true },
    onResize: { value: function (callback) { return subscribe(resizeListeners, callback); }, enumerable: true },
    onRefresh: { value: function (callback) { return subscribe(refreshListeners, callback); }, enumerable: true },
    theme: { get: function () { return theme; }, enumerable: true },
    size: { get: function () { return { width: size.width, height: size.height }; }, enumerable: true },
    widget: { get: function () { return widget ? { id: widget.id, name: widget.name } : null; }, enumerable: true },
  });
  Object.defineProperty(window, 'Switchboard', { value: Object.freeze(api), enumerable: true });

  // Said as the SDK loads, with its listener already in place, so the board's `init` —
  // and every `theme` and `resize` after it — reaches a page that never calls ready(): one
  // whose CSS follows data-theme and needs nothing else still follows the board.
  post({ type: 'ready' });
})();
