---
name: switchboard-create-widget
description: Create, change or place a Switchboard whiteboard widget — a small live page (a clock, a weather card, a status panel, a chart of an API's data or of a database the user saved in Switchboard) drawn in a node on a whiteboard. Use when the user asks for a widget on a board, or to change one that is already there.
---

# Create a Switchboard widget

A widget is a folder of plain HTML, CSS and JavaScript that Switchboard draws live
inside a node on a whiteboard, in a sandboxed frame. The whiteboard only renders it;
the widget holds all of its own logic. It lives outside every repository, in
`<config dir>/widgets/<id>/` (`~/.switchboard/widgets/` normally, or beside
`SWITCHBOARD_CONFIG` when that is set), and it never holds an API key: it asks the app
for data, and the app adds the key and talks only to the base URL its manifest names.
Nor does it hold a database's address: a widget can read a connection the user saved in
a workspace's Databases tab by its name, and the app runs its read-only queries.

Everything goes through one CLI in the Switchboard checkout:

```bash
node scripts/widget.js list [--json]
node scripts/widget.js create <id> --name <name> [--width N --height N] [--api <baseUrl>] [--secret <NAME>] [--database <connection name>]
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
- Where its data lives. If it is in a database the user has saved in Switchboard (a
  connection in a workspace's **Databases** tab), or will save there, use `"database"`
  (section 4) — don't build an API for it. Ask which connection, by the name it has in
  that tab; it must be in the workspace the board belongs to.
- Otherwise, whether it needs data from an API: its base URL (https), and whether that
  API needs a key — and if so, which header carries it (`Authorization: Bearer …` unless
  the API documents another, such as `X-Api-Key`).

Never ask the user to paste a key or a connection string into the chat, and never write
either into a file, a command line or code. Section 5 says how a key gets to the app;
a database connection is added by the user in the app itself.

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
a checklist kept in `localStorage`), or that reads a database (`"database"`, section 4).

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
  only through `Switchboard.fetch` and `Switchboard.db`.
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

## 4. Data from a database the user saved in Switchboard

When the data is in a database the user keeps in Switchboard — a connection in a
workspace's **Databases** tab — the widget reads it directly instead of through an API:

```json
{ "name": "Open orders", "database": "Main database" }
```

```bash
node scripts/widget.js create open-orders --name "Open orders" --database "Main database"
```

`database` is the connection's NAME, exactly as the Databases tab shows it (1–80
characters, no spaces at either end), in the workspace the board belongs to — the
board's own workspace, the one its ✦ Answer reads. It may sit beside `api` or alone. The
app reads the name from `widget.json`; nothing the page sends can pick another
connection or workspace.

- **Never ask for, read, print or handle a connection string**, a password or a host.
  The user adds the connection themselves, in that workspace's Databases tab. Until it is
  there the widget shows **Needs a connection** — "Add a connection named “Main
  database” in <workspace>'s Databases tab" — with a button that opens the tab, and loads
  as soon as it is added. `check` and `add` say whether the board's workspace has a
  connection of that name; they never see anything else about it.
- **Tell the user, once, to give a PostgreSQL connection a role that can only read**:
  SELECT grants on what the widget needs, and not `pg_signal_backend`. The app's
  read-only transaction stops writes made by statements, but not every function a SELECT
  can call (`dblink_exec` writes over a connection of its own).
- **Read the app's own repository to write the queries**: its models, schemas,
  migrations or ORM definitions say which collections or tables there are, their fields,
  and how a record belongs to a user. Read it only — never edit it, commit to it, or run
  its code for a widget.
- **Filter to the user's own records** — their user, account or team id — the way the app
  itself scopes them. A widget never shows everyone's data just because the connection
  can read it. Ask the user for their id if the repository doesn't make it clear.
- Ask only for what the widget shows: a projection or a column list, a sort, a limit.

The SDK's database half, `Switchboard.db`:

```js
// MongoDB: find, aggregate and count
const open = await Switchboard.db.find('orders',
  { owner: { $oid: '0123456789abcdef01234567' }, status: 'open' },        // filter
  { projection: { total: 1, createdAt: 1 }, sort: { createdAt: -1 }, limit: 20, skip: 0 })
const byDay = await Switchboard.db.aggregate('orders', [
  { $match: { owner: { $oid: '0123456789abcdef01234567' }, createdAt: { $gte: { $date: '2026-01-01T00:00:00Z' } } } },
  { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, total: { $sum: '$total' } } },
  { $sort: { _id: 1 } },
])
const waiting = await Switchboard.db.count('orders', { owner: { $oid: '0123456789abcdef01234567' }, status: 'open' })

// PostgreSQL: one statement, $1, $2 … as params; rows keyed by column name
const rows = await Switchboard.db.sql(
  'SELECT id, total, created_at FROM orders WHERE owner_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 20',
  [42, 'open'])

// Several at once: run in order on ONE connection (one read-only transaction for
// PostgreSQL); the results come back in the same order.
const [recent, count] = await Switchboard.db.batch([
  { find: 'orders', filter: { status: 'open' }, sort: { createdAt: -1 }, limit: 5 },
  { count: 'orders', filter: { status: 'open' } },
])
// ops: { find, filter?, projection?, sort?, limit?, skip? } | { aggregate, pipeline }
//    | { count, filter? } | { sql, params? }  — a single call is a one-op batch
```

**Inputs.** Filters, projections, sorts and pipelines are MongoDB Extended JSON
(relaxed): `{ "$oid": "<24 hex>" }` is an ObjectId and `{ "$date": "<ISO string>" }` a
Date — write them that way, or the comparison is against a string and matches nothing
(a JavaScript `Date` inside one is sent as `$date` for you). SQL params are JSON values.

**Outputs** are plain JSON: an ObjectId comes back as its 24-character hex string, a Date
as an ISO-8601 string, a Long or Decimal128 as a string, binary as `{ "$binary": "…" }`.
Turn them back into what the page needs (`new Date(row.createdAt)`).

**Read-only, always.** MongoDB gets only find, aggregate and countDocuments. `$where`,
`$function`, `$accumulator`, `$out`, `$merge` and any `$_…` internal operator are refused wherever they appear,
nested pipelines included, and a pipeline's stages must be among `$match $project
$addFields $set $unset $group $sort $limit $skip $unwind $lookup $count $facet $bucket
$bucketAuto $sortByCount $replaceRoot $replaceWith $sample $unionWith $densify $fill
$setWindowFields $graphLookup $redact`; `system.*` collections can't be read. PostgreSQL
takes one SELECT, WITH, VALUES or TABLE statement per `sql` (leading comments are fine; a
second statement after a semicolon is refused), inside a read-only transaction — SET,
BEGIN, COMMIT and anything that writes are refused, and so is SQL that names a function
that acts outside the transaction: `dblink…`, `pg_terminate_backend`, `pg_cancel_backend`,
`pg_advisory…`/`pg_try_advisory…`, `lo_import`, `lo_export` and the other large-object
writers, and `set_config`. That check reads the text, so it is a backstop: the role the
connection uses is what really keeps a widget to reading. A MongoDB operation on a
PostgreSQL connection, or `sql` on MongoDB, is refused.

**Limits.** At most 20 operations a batch. A find's `limit` defaults to 1,000 and is
capped at 10,000; at most 10,000 rows from any operation and 8 MB from a batch, checked
as rows arrive; 15 s a batch, after which a running PostgreSQL statement is cancelled on
the server (a busy app may first wait up to 15 s for a free connection). At most 8 batches on
their way at once per widget — group what one view needs into one `batch`.

**Errors** reject with an `Error` whose `message` is one plain sentence — show it in the
widget — and whose `code` is:

| `code` | what happened |
|---|---|
| `needs-connection` | the board has no workspace, its workspace has no connection of that name (or more than one), or widget.json has no `"database"` |
| `refused` | turned down before running: a blocked operator or stage, a statement that isn't a read, the wrong kind of operation for the connection, a malformed operation |
| `too-large` | past the row or byte limit — ask for fewer rows or fields |
| `timeout` | the batch ran past the time limit |
| `database` | the database's own error, with its message (never an address or a password) |

## 5. The key: the user gives it, never you

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

## 6. Check, place, iterate

```bash
node scripts/widget.js check weather
node scripts/widget.js add weather --board "Example dashboard"
```

`check` validates the manifest, lists the files (and which are not served), says
whether the key is kept, waiting or missing (never its value) and, for a widget with
`"database"`, whether each board's workspace has a connection of that name; and prints
the widget's `sbwidget://` address. `add` puts the widget on the board to the right of
what is there (or at `--x/--y`), at its manifest's size, keeping every node already on
the board — an open board shows it at once, and Undo there takes it off — and says
whether the board's workspace has the widget's connection yet.

Then iterate: edit the widget's files and the open board reloads that widget as each
file is saved. Ask the user what to change. If the board shows "This widget can't be
shown", run `check` and fix what it names.
