// SB.termTheme — the one palette both terminal panes and the stylesheet read.
//
// A terminal's colours live in two places that must agree: xterm's `theme` option,
// which paints the grid, and the --term-*/--t-* CSS tokens, which paint everything
// around it (the blank state, the exit line, the pane's own background before xterm
// has opened). They used to be two hand-kept copies of the same sixteen hex codes in
// three files. Here the JS object is the source and the tokens are WRITTEN from it,
// so a colour cannot be changed in one place and left stale in the other.
//
// Light is the default because the rest of the app is light-only by design
// (styles.css sets `color-scheme: light` and the window is #ffffff) and because a
// Claude Code configured with `"theme": "light"` — the common case — renders its
// near-black text straight onto the dark slab otherwise. Dark and Match system are
// both a menu item away; main owns which one is in force (§4.8).
window.SB = window.SB || {};

(function (SB) {
  'use strict';

  // The mock-up's palette, mapped onto the ANSI slots a dev server actually emits.
  // Dim output is SGR 2 / bright black.
  var DARK = {
    background: '#1c1c1e',
    foreground: '#d4d4d8',
    cursor: '#d4d4d8',
    cursorAccent: '#1c1c1e',
    selectionBackground: 'rgba(255,255,255,.20)',
    black: '#1c1c1e',
    red: '#ff8a80',
    green: '#8ad07e',
    yellow: '#f0c674',
    blue: '#7cb7ff',
    magenta: '#c99cff',
    cyan: '#7fd6d0',
    white: '#d4d4d8',
    brightBlack: '#76767c',
    brightRed: '#ff8a80',
    brightGreen: '#8ad07e',
    brightYellow: '#f0c674',
    brightBlue: '#7cb7ff',
    brightMagenta: '#c99cff',
    brightCyan: '#7fd6d0',
    brightWhite: '#f2f2f5',
  };

  // NOT the dark set with the background flipped. Those colours are pastels chosen to
  // glow on near-black; on a light ground they wash out to nothing. These are their
  // darker, saturated counterparts, taken from the app's own ink and diff tokens where
  // one already existed (--del is `red`, --add is `green`, --link is `blue`,
  // --ink-3 is `brightBlack`) so the terminal reads as part of the same app.
  //
  // Every slot here clears WCAG 4.5:1 against the background — the floor is `cyan` at
  // 4.52 — which is a better floor than the dark set manages (3.77, at brightBlack).
  // The two conventions that look wrong written down and are right on screen: on a
  // light ground `white` has to become a mid grey or it is invisible, and `brightWhite`
  // — the slot programs reach for to emphasise — has to become the darkest ink.
  var LIGHT = {
    // Not #ffffff. The pane sits on --surface (white) with a 10px radius, and a pure
    // white terminal has no edge at all; #f7f7f9 is the app's own --head-bg.
    background: '#f7f7f9',
    foreground: '#1d1d1f',
    cursor: '#1d1d1f',
    cursorAccent: '#f7f7f9',
    selectionBackground: 'rgba(0,0,0,.14)',
    black: '#1d1d1f',
    red: '#cf222e',
    green: '#1a7f37',
    yellow: '#8a6100',        // a true yellow is unreadable on white; this is amber
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#127e84',
    white: '#6f6f78',
    brightBlack: '#5a5a5f',   // dim/secondary text — the slot Claude Code leans on most
    brightRed: '#a40e26',
    brightGreen: '#116329',
    brightYellow: '#6b4600',
    brightBlue: '#0550ae',
    brightMagenta: '#6639ba',
    brightCyan: '#0e6b70',
    brightWhite: '#1d1d1f',
  };

  var PALETTES = { dark: DARK, light: LIGHT };

  // The CSS side of the same palette. styles.css declares these on :root with the dark
  // values, so a window that somehow never hears from main still looks like it always
  // did; set() then overrides them on the element itself.
  var TOKENS = {
    '--term-bg': 'background',
    '--term-fg': 'foreground',
    '--t-green': 'green',
    '--t-blue': 'blue',
    '--t-yellow': 'yellow',
    '--t-dim': 'brightBlack',
    '--t-magenta': 'magenta',
    '--t-red': 'red',
  };

  var current = 'dark';        // what styles.css ships with, until main says otherwise
  var listeners = [];

  function palette(name) {
    return PALETTES[name] || DARK;
  }

  function set(name) {
    var next = PALETTES[name] ? name : 'dark';
    var p = PALETTES[next];
    var root = document.documentElement;
    var changed = next !== current;
    current = next;

    // The attribute is for the handful of rules that are not a colour swap — a light
    // pane needs an edge that the dark slab never did.
    root.setAttribute('data-term-theme', next);
    for (var token in TOKENS) {
      if (Object.prototype.hasOwnProperty.call(TOKENS, token)) {
        root.style.setProperty(token, p[TOKENS[token]]);
      }
    }
    // Unconditional: a listener that registered after the last set() has never been
    // told anything, and the panes it owns are still painted in the default.
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](next, p);
      } catch (err) {
        console.error('[switchboard] termTheme listener:', err);
      }
    }
    return changed;
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  SB.termTheme = {
    palette: palette,
    current: function () { return current; },
    set: set,
    onChange: onChange,
  };
})(window.SB);
