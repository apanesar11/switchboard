// SB.icons — the inline SVG strings, lifted verbatim from the approved mock-up's
// generator (gen.mjs `I`). Every glyph is viewBox="0 0 16 16"; the per-use width/
// height, stroke-width and linecap are part of the design and must not be changed.
// These strings are the ONLY markup this app ever feeds to innerHTML. (Monaco, which
// the Editor tab loads, builds its own DOM; nothing of ours reaches it as markup.)
window.SB = window.SB || {};

(function (SB) {
  'use strict';

  // The branch/merge glyph inside .pill. 13x13, stroke-width 1.5, no linejoin.
  var branch = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="4" cy="3.5" r="1.6"/><circle cx="4" cy="12.5" r="1.6"/><circle cx="12" cy="8" r="1.6"/><path d="M4 5.1v5.8M4 5.5c0 2.6 6.4 1.2 6.4 2.5"/></svg>';

  // Start button. 11x11, solid fill.
  var play = '<svg viewBox="0 0 16 16" width="11" height="11"><path d="M4.5 2.6v10.8l8.6-5.4z" fill="currentColor"/></svg>';

  // Stop button. 10x10, solid fill.
  var stop = '<svg viewBox="0 0 16 16" width="10" height="10"><rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor"/></svg>';

  // Pull main AND the per-repo .ib refresh. 12x12, stroke-width 1.6.
  var sync = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.2 8.9A5.3 5.3 0 1 1 11.75 4.25"/><path d="M11.75 1.4v2.85H8.9"/></svg>';

  // Disclosure chevron: .sumb .cv, .fr .cv, and .dfile .fh .cv (that one is rotated
  // 90deg by CSS when the card is open, which is why there is no separate down glyph
  // in screens 01-07). 11x11, stroke-width 1.8.
  var chev = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5l4.5 4.5L6 12.5"/></svg>';

  // Chevron pointing down — unused by the mock-up, kept for a real glyph swap.
  var chevD = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6l4.5 4.5L12.5 6"/></svg>';

  // Breadcrumb back caret. 12x12, stroke-width 1.8.
  var caret = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5L5.5 8 10 12.5"/></svg>';

  // .lk port links (at opacity .65 via CSS) and the "Open on GitHub" button (full
  // opacity). Same 11x11 glyph in both places, stroke-width 1.6.
  var ext = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3H3v10h10v-3M9 3h4v4M13 3L7.5 8.5"/></svg>';

  // The rail toggle beside the traffic lights — macOS's own glyph: a rounded panel
  // with the rail marked off down its left third. 15x15 so it carries next to the
  // 12px lights, and stroke-width 1.3 rather than the 1.6 the other outlines use:
  // at 1.6 a 12px-wide rectangle reads as a filled button instead of a hint.
  var sidebar = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="1.9" y="3.4" width="12.2" height="9.2" rx="2.2"/><path d="M6.3 3.4v9.2"/></svg>';

  // The Grid row at the top of the rail: four squares, the shape of the screen.
  // 14x14 at 1.4, the same weight as the branch glyph on the rows beneath it.
  var grid = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2" width="5" height="5" rx="1.2"/><rect x="9" y="2" width="5" height="5" rx="1.2"/><rect x="2" y="9" width="5" height="5" rx="1.2"/><rect x="9" y="9" width="5" height="5" rx="1.2"/></svg>';

  // ⋯ — the Grid's view menu. Three dots on a row, the way macOS draws "more".
  var more = '<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor"><circle cx="3.4" cy="8" r="1.45"/><circle cx="8" cy="8" r="1.45"/><circle cx="12.6" cy="8" r="1.45"/></svg>';

  // The rail's Usage row: a dial — the arc of a meter and its needle. 14x14 at 1.4,
  // the weight of the grid glyph on the row above the groups.
  var gauge = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 11.8a5.5 5.5 0 1 1 10 0"/><path d="M8 9.5l3-3.2"/></svg>';

  // The rail's Pull requests row: GitHub's own pull-request shape — a branch line
  // with the merge arrow curling into it. 14x14 at 1.4, the weight of the grid glyph.
  var pr = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="3.5" r="1.6"/><circle cx="4" cy="12.5" r="1.6"/><circle cx="12" cy="12.5" r="1.6"/><path d="M4 5.1v5.8"/><path d="M12 10.9V7.2a2 2 0 0 0-2-2H8.6"/><path d="M10.2 3.4L8.4 5.2l1.8 1.8"/></svg>';

  // Page glyph — defined by the mock-up, unused by screens 01-07.
  var file = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 1.75h5.5L13 5.25v9H4z"/><path d="M9.5 1.75v3.5H13"/></svg>';

  // The Editor's full-screen button at the top-right of its tab strip (§4.14): two
  // corner arrows pointing out, the shape macOS draws for "enter full screen". 14x14 at
  // 1.4 — the weight of the rail's grid and gauge glyphs, and the arrowheads' short legs
  // are what keep it from reading as a resize handle.
  var expand = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5h4v4M13.5 2.5L9.25 6.75M6.5 13.5h-4v-4M2.5 13.5l4.25-4.25"/></svg>';

  // Its twin in the full-screen band: the same arrows turned inward. Same box and weight,
  // so swapping one for the other never moves the eye.
  var collapse = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 2.5L9.5 6.5M9.5 3v3.5H13M2.5 13.5l4-4M6.5 13V9.5H3"/></svg>';

  // A magnifier: the Editor's Find results tab, the find-in-files field and the Go to
  // file palette. 13x13 at 1.6, lifted from the Editor mock-ups, which draw it at three
  // sizes: the tab's 12px and the palette's 14px are set by CSS (styles.css, Editor
  // section), as are the 10px `chev`/`chevD` of the Editor's tree — the one screen that
  // sizes these per place rather than per string.
  var search = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>';

  // ×: an Editor tab's close button, the find row's close and an Editor bar's dismiss.
  // 12x12 at 1.8 from the Find in files mock-up; a tab draws it at 10px by CSS, in the
  // 16px slot its unsaved-changes dot uses.
  var close = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

  // An eye: the Editor's markdown Preview toggle, beside the full-screen button and in
  // the same 14x14 at 1.4 box, so the two read as one row of quiet controls.
  var eye = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z"/><circle cx="8" cy="8" r="2.1"/></svg>';

  // A page with a couple of written lines on it: the Grid square's switch to that
  // workspace's note, and the Editor tree's New file. 14x14 at 1.4, the weight of the
  // rail's grid and gauge glyphs, so a square's two header buttons read as one pair.
  var note = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.25 2.25h6L12.75 5.75v8h-9.5z"/><path d="M9.25 2.25v3.5h3.5"/><path d="M5.5 8.5h5M5.5 11h3.5"/></svg>';

  // Its twin: a prompt in a rounded box, for switching a square back to the terminal.
  var term = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.9" y="3" width="12.2" height="10" rx="2.2"/><path d="M4.6 6.6L6.9 8.8 4.6 11"/><path d="M8.6 11.2h3"/></svg>';

  // A folder with a + on it: the Editor tree's New folder. Same box and weight.
  var folderPlus = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1.9 12.6V4.2a1 1 0 0 1 1-1h3.1l1.4 1.7h5.7a1 1 0 0 1 1 1v6.7a1 1 0 0 1-1 1H2.9a1 1 0 0 1-1-1z"/><path d="M8 7.4v4M6 9.4h4"/></svg>';

  // Two sliders: the rail's Settings row (§4.18), under Usage. 14x14 at 1.4, the weight
  // of the gauge above it.
  var sliders = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 4.5h5.6M12.1 4.5h1.4M2.5 11.5h1.4M8 11.5h5.5"/><circle cx="10.1" cy="4.5" r="1.7"/><circle cx="6" cy="11.5" r="1.7"/></svg>';

  // A padlock: the Settings screen's line about where API keys are kept. 12x12 at 1.4.
  var lock = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>';

  SB.icons = {
    publish: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10V2m-3 3 3-3 3 3M3 10v3h10v-3"/></svg>',
    branch: branch,
    merge: branch,   // the mock-up's generator calls it "merge"; same glyph
    play: play,
    stop: stop,
    sync: sync,
    chev: chev,
    chevD: chevD,
    caret: caret,
    back: caret,     // the breadcrumb caret, under the mock-up's own name
    ext: ext,
    file: file,
    sidebar: sidebar,
    grid: grid,
    more: more,
    gauge: gauge,
    pr: pr,
    expand: expand,
    collapse: collapse,
    search: search,
    close: close,
    eye: eye,
    note: note,
    term: term,
    folderPlus: folderPlus,
    sliders: sliders,
    lock: lock
  };
})(window.SB);
