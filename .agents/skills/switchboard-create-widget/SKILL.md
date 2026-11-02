---
name: switchboard-create-widget
description: Create, change or place a Switchboard whiteboard widget — a small live page (a clock, a weather card, a status panel, a chart of an API's data) drawn in a node on a whiteboard. Use when the user asks for a widget on a board, or to change one that is already there.
---

# Create a Switchboard widget

A widget is a folder of plain HTML, CSS and JavaScript that Switchboard draws live
inside a node on a whiteboard, in a sandboxed frame. The whiteboard only renders it;
the widget holds all of its own logic. It lives outside every repository, in
`<config dir>/widgets/<id>/` (`~/.switchboard/widgets/` normally, or beside
`SWITCHBOARD_CONFIG` when that is set), and it never holds an API key: it asks the app
for data, and the app adds the key and talks only to the base URL its manifest names.

Everything goes through one CLI in the Switchboard checkout:

```bash
node scripts/widget.js list [--json]
node scripts/widget.js create <id> --name <name> [--width N --height N] [--api <baseUrl>] [--secret <NAME>]
node scripts/widget.js check <id>
node scripts/widget.js set-secret <id> [NAME]     # the user runs this one; the key comes on stdin
node scripts/widget.js add <id> --board <board> [--folder <name>] [--x N --y N] [--width N --height N]
node scripts/widget.js remove <id> [--yes]
```

Read [ARCHITECTURE.md](../../../ARCHITECTURE.md) (§4.17, Widgets) when you need more
than this page says.

## 1. Ask, briefly

- What the widget should show, and how often it changes.
- Which board it goes on (`node scripts/whiteboard.js list` shows the boards).
- Whether it needs data from an API: its base URL (https), and whether that API needs
  a key — and if so, which header carries it (`Authorization: Bearer …` unless the API
  documents another, such as `X-Api-Key`).

Never ask the user to paste a key into the chat, and never write a key into a file,
a command line or code. Section 4 says how the key gets to the app.

## 2. Create it

Pick an id: lowercase letters, digits and dashes, starting with a letter (`weather`,
`desk-clock`, `build-status`). Then:

```bash
node scripts/widget.js create weather --name "Weather" --width 420 --height 260 \
  --api https://api.example.com/v1/ --secret API_KEY
```

This writes `widget.json` and a starter `index.html` that already uses the SDK. The
manifest:

```json
{
  "name": "Weather",
  "entry": "index.html",
  "size": { "width": 420, "height": 260 },
  "minSize": { "width": 240, "height": 160 },
  "api": {
    "baseUrl": "https://api.example.com/v1/",
    "secret": "API_KEY",
    "header": "Authorization",
    "prefix": "Bearer "
  }
}
```

`name` is required (1–60 characters). `entry` defaults to `index.html`. `size` is the
node's default size, its 30px title strip included; `minSize` is the least the user may
resize it to (200×120 otherwise). `api.baseUrl` must be https (http only for
`localhost` while developing). `api.secret` is the key's NAME, never its value;
`header` defaults to `Authorization` and `prefix` to `"Bearer "` for that header (empty
for any other). Leave `api` out for a widget that needs no data (a clock, a countdown,
a checklist kept in `localStorage`).

## 3. Write the page

Replace the starter `index.html` with the widget. Plain HTML, CSS and JavaScript in the
widget's folder — more files are fine (`app.js`, `styles.css`, `icons/*.svg`), loaded by
relative path. If the user truly wants React, bundle it with the repository's esbuild
into the widget's folder (one `app.js`), and keep any sources beside it: only html, js,
css, json, svg, images, fonts, txt, map and wasm files are served (WebAssembly may be
compiled; JavaScript `eval` may not); anything else and every dotfile stays in the
folder unserved.

Load the SDK first, from the app (never copy it into the folder):

```html
<script src="/__switchboard/widget.js"></script>
```

It gives `window.Switchboard`:

```js
const { widget, theme, size } = await Switchboard.ready()   // { id, name }, 'light'|'dark', { width, height }
// (A page that only needs the theme can skip ready(): loading the SDK is enough.)

// Data through the app. The path is relative to api.baseUrl; the app adds the key.
const res = await Switchboard.fetch('forecast', {
  method: 'GET',                    // GET, HEAD, POST, PUT, PATCH, DELETE
  query: { city: 'Example City' },  // added to the URL
  headers: { Accept: 'application/json' },
  // body: { … }                     // text, or anything JSON can say (sent as JSON)
})
res.ok; res.status; res.statusText; res.headers   // content-type, cache-control, etag, last-modified, retry-after, x-ratelimit-*
res.text(); res.json()                             // synchronous: the body is already here

Switchboard.onTheme(theme => { … })    // each returns an unsubscribe function
Switchboard.onResize(size => { … })
Switchboard.onRefresh(() => load())    // the node's Reload button; without one, Reload reloads the page
Switchboard.theme; Switchboard.size; Switchboard.widget
```

`fetch` rejects with an `Error` whose message is the app's reason — a path outside the
base URL, a timeout (20 s), an answer over 5 MB, or `error.code === 'needs-secret'` when
no key has been given yet. Show that message in the widget rather than failing
silently. A 3xx comes back as it is; redirects are not followed.

What the page may not do (its Content-Security-Policy and sandbox):

- No scripts or styles from a CDN: everything is in the folder (inline is fine).
  Google Fonts are allowed (`fonts.googleapis.com` stylesheets, `fonts.gstatic.com`
  fonts). Pictures may come from any https address.
- No direct `fetch`/`XMLHttpRequest`/`WebSocket` to anywhere but its own files: data
  only through `Switchboard.fetch`.
- No popups, no frames, no forms that post, no permissions (camera, notifications,
  location). A link the user clicks in the widget opens in their browser; the page
  navigating itself (`location.href = …` on load or from a timer) opens nothing, and
  after one such try the widget's links stay shut until it reloads — never redirect.
- `localStorage` works, and is the widget's own (each widget id is its own origin).
  Copy, paste, cut, undo and select all work in its fields as in a browser.

Make it responsive — the user resizes the node:

- Fill the frame: `html, body { height: 100%; margin: 0 }`, then grid or flex.
- Size type and spacing from the frame, not the screen: `body { container-type: size }`
  and `clamp(14px, 8cqmin, 40px)`; a chart as an `<svg viewBox="…">` that scales.
- Hide detail as it shrinks (`@container (max-width: 260px) { .detail { display: none } }`).
- Follow the board's theme: the SDK keeps `<html data-theme="light|dark">` (and
  `color-scheme`) in step, so define colours as custom properties and redefine them under
  `[data-theme="dark"]`. The page's own background shows; set one.

## 4. The key: the user gives it, never you

When the manifest names a key, tell the user one of these, in your own words:

- Paste it into the widget's **Needs a key** panel on the board, which shows until a
  key is kept.
- Or, in their own terminal, run `node scripts/widget.js set-secret weather` and paste
  it at the hidden prompt.
- Or copy the key, then run in their session (the `!` prefix runs it in their own
  shell; the key goes from the clipboard straight into the CLI and never appears in the
  chat or in a command line) — on a Mac:
  `! pbpaste | node scripts/widget.js set-secret weather`
  and on Windows:
  `! powershell -NoProfile -Command Get-Clipboard | node scripts/widget.js set-secret weather`
  (`check` and `create` print the right one for the machine they run on).

The app encrypts it with the system's keychain at once (the CLI's copy waits in a file
only the user can read until the app takes it). Never read, print or move the key
yourself, and never put it in the widget's folder — the folder is served to the page.

A key is kept for the API it was given for — the origin of `api.baseUrl` then — and sent
nowhere else. If you change `baseUrl` to another host (another provider, a different
port, a local server), the widget asks for its key again and `check` says
"key kept for another API": tell the user why, and let them give it again.

## 5. Check, place, iterate

```bash
node scripts/widget.js check weather
node scripts/widget.js add weather --board "Example dashboard"
```

`check` validates the manifest, lists the files (and which are not served), says
whether the key is kept, waiting or missing (never its value), and prints the widget's
`sbwidget://` address. `add` puts the widget on the board to the right of what is there
(or at `--x/--y`), at its manifest's size, keeping every node already on the board; an
open board shows it at once, and Undo there takes it off.

Then iterate: edit the widget's files and the open board reloads that widget as each
file is saved. Ask the user what to change. If the board shows "This widget can't be
shown", run `check` and fix what it names.
