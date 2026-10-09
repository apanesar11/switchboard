# Switchboard — architecture contract

A macOS Electron app that replaces Cursor as the control panel for the multi-repo
workspaces under `~/Projects`. It shows, per workspace: what is running, what
changed, and what the branch's pull request looks like — and it starts and stops the
dev servers, and opens the repos' files in a plain editor.

This file is the **contract**. Every module is written against it, in parallel, by
separate authors. If you own a file listed below, you implement exactly the exports and
IPC shapes described here. Do not invent new IPC channels, do not rename fields, do not
edit files you do not own.

---

## 0. Ground rules

- **No build step, no bundler, no framework.** Plain CommonJS in the main process,
  plain *classic* scripts (no ES modules, no `import`) in the renderer. **One exception,
  and only one:** the whiteboard editor (§4.17, R15) is a web admin's React Flow
  editor, copied into `src/diagrams/` and mirrored by hand — four thousand lines that would
  otherwise be two editors to keep alike. `scripts/build-diagrams.js` builds it into
  `src/renderer/diagrams/diagrams.{js,css}`: one IIFE that sets `window.SBDiagrams`, and a
  stylesheet scoped to the element the editor is mounted in. Both are generated and
  ignored by git; `npm start` (prestart) and `scripts/package.js` build them. Nothing else
  in the app may import from the bundle or be built.
- **Renderer modules attach to a single global**, `window.SB`. Every renderer file
  starts with `window.SB = window.SB || {}` and assigns its namespace. Load order is
  fixed by `index.html`; a file may only call into namespaces loaded before it, except
  inside functions that run after load.
- **The renderer never touches Node.** `contextIsolation: true`, `nodeIntegration: false`.
  Everything goes through `window.sb`, defined in `src/preload.js`.
- **Design fidelity is the point.** The approved mock-up is the spec; the styles and DOM
  come from it. Do not restyle, do not "improve" the layout, do not add a dashboard.
  The user's standing rule: *one row = name + one line of state + one action; details
  are a tap away; summarise counts, don't list.*
- **Never write to the user's repos** except the explicit actions: `git pull --ff-only`
  (Pull main), starting/stopping dev processes, Publish building Switchboard's
  source into a desktop app, Save in the Editor (⌘S), which writes the one file the
  user edited, in place; nothing else — no git, no formatting, no other file (§4.14);
  and the Editor tree's own four — New file, New folder, Rename and Delete (three
  channels; the first two share one), each of them one path the user named and nothing
  near it. Delete goes to the Trash, and falls back to an `unlink` only for a FILE the
  Trash refuses; a folder is never removed behind a failed Trash (§4.16). No commits,
  no checkouts, no stashes, and nothing is ever
  staged: a file made here is untracked, as it would be if a shell had made it. Squash and merge (§4.4) acts on GitHub
  through `gh pr merge --squash -R owner/repo` and then deletes the merged branch
  there, as GitHub's own Delete branch button would — never on the checkout: nothing
  is checked out and no local branch is deleted.
- Errors are values. Main-process handlers never throw across IPC: they resolve to
  `{ ok: false, error: "human sentence" }`. The renderer renders the sentence.

---

## 1. File ownership

```
switchboard/
  package.json                  — owner: scaffold
  README.md                     — owner: scaffold
  ARCHITECTURE.md               — this file
  src/main/index.js             — app lifecycle, BrowserWindow, IPC wiring        [M1]
  src/main/publisher.js         — build from source; retain the prepared update    [M1]
  src/main/desktop-install.js   — verified staging and rollback-safe app swap      [M1]
  src/main/config.js            — config file load/save/defaults                  [M2]
  src/main/workspaces.js        — discovery + per-workspace scan orchestration    [M2]
  src/main/git.js               — every git command                               [M3]
  src/main/github.js            — every `gh` command                              [M4]
  src/main/runner.js            — dev process lifecycle, pty, log buffer          [M5]
  src/main/ports.js             — listening-port probe + ngrok tunnel lookup      [M5]
  src/main/shell.js             — the interactive login shell per workspace       [M6]
  src/main/drops.js             — what a terminal types for a dropped/pasted file  [M6]
  src/preload.js                — the `window.sb` bridge                          [M1]
  src/renderer/index.html       — shell + script load order                       [R1]
  src/renderer/styles.css       — the whole design system                         [R1]
  src/renderer/icons.js         — SB.icons                                        [R1]
  src/renderer/dom.js           — SB.dom helpers                                  [R1]
  src/renderer/term-theme.js    — SB.termTheme: the light/dark terminal palette   [R9]
  src/renderer/app.js           — state, routing, data loading, sidebar           [R2]
  src/renderer/markdown.js      — SB.markdown: GitHub-flavoured markdown → DOM     [R3]
  src/renderer/diffview.js      — SB.diffview: unified-diff → DOM                 [R3]
  src/renderer/views/workspace.js — Changes tab (repo rows) + header              [R4]
  src/renderer/views/logs.js    — Logs tab (terminal)                             [R5]
  src/renderer/views/terminal.js — Terminal tab (a real login shell)               [R8]
  src/renderer/views/wbterminals.js — a whiteboard's terminals: panels, tray, pins [R15]
  src/renderer/wbterminals.css  — their styles, after styles.css                  [R15]
  src/renderer/views/grid.js    — Grid: four workspace panes, in views            [R10]
  src/renderer/views/usage.js   — Usage screen + the Grid's five-hour gauge         [R11]
  src/main/usage.js             — Claude usage: the keychain token, the endpoint    [M7]
  src/main/editor.js            — the Editor's file access: tree, read, save, HEAD base, stat, find in files [M8]
  src/renderer/views/files.js   — Files + All diffs screens                       [R6]
  src/renderer/views/diff.js    — single-file Diff screen                         [R6]
  src/renderer/views/pr.js      — Pull request screen                             [R7]
  src/renderer/views/prs.js     — Pull requests screen: every open PR of yours    [R12]
  src/renderer/views/editor.js  — Editor tab (Monaco over the workspace's repos)  [R13]
  src/main/whiteboards.js       — Whiteboards: folders, boards, documents, pictures; the migration [M10]
  src/main/images.js            — Google Images beside a whiteboard: webview, session, fetch [M12]
  src/main/answer.js            — ✦ Answer: Claude Code / Codex / Claude API / OpenAI [M11]
  src/main/databases.js         — local encrypted connections and read-only browsing [M13]
  src/renderer/views/databases.js — Databases tab: connections, entities, records     [R17]
  src/renderer/views/whiteboards.js — Whiteboards screen, an open board, the canvases [R15]
  src/renderer/views/settings.js — Settings screen: who answers, API keys            [R16]
  src/diagrams/                 — the editor bundle's sources (mirrored by hand)     [R15]
  scripts/build-diagrams.js     — builds src/diagrams into src/renderer/diagrams/   [R15]
  scripts/test-whiteboards.js   — the store and the migration, under plain node    [M10]
```

---

## 2. Domain model

A **workspace** is usually a directory under the root (`~/Projects`) whose
immediate children include git repos: `sample-1 … sample-4`, `example-1`,
`example-2`, `demo`. It can also be a **single repo** — a folder that is the repo
itself, with nothing nested (`switchboard`, and any app that is one repository) — which
discovery never finds on its own, so the config declares it (§3, `workspaces.<id>.dir`);
its one repo is the folder. A folder of repos can be a repo **itself** as well — an
umbrella that tracks the glue around its children (a README, scripts, docs) — and then
the folder is the workspace's first repo and its children follow. Its **project** is the
id with a trailing `-<n>` stripped (`sample-2` → `sample`). Only one copy of a project may run at a time. Its **section**
is the rail heading it sits under: the project's own name when that project has more
than one workspace, else `other`, which the single-workspace projects share.

A **repo** is one of those immediate children (`sample-api-2`), or the workspace folder
when that is a repo. Its **display name** is the directory name with the workspace's
numeric suffix stripped (`sample-api-2` → `sample-api`, and the folder `sample-2` →
`sample`), because the mock-up shows `sample-api`. A name is how every call finds its
repo, so no two repos of a workspace share one: a folder whose name a child already
answers to keeps its full folder name, and is `.` if that is taken too.

A repo's git dir may be **parked**: `.git` renamed to `.git.disabled`, which is how an
umbrella folder is hidden from an IDE that shows only the outermost repository. It is a
repo all the same — `git.js` names the git dir on every command (`--git-dir`,
`--work-tree`) — and nothing in the app attaches or parks one. A folder with a `.git` is
never parked, whatever else it holds. Discovery does not count a parked CHILD: the
two-child rule is about `.git`, and only the workspace folder itself is looked at for a
parked git dir.

### Shapes (the single source of truth for both sides)

```js
Workspace = {
  id: 'sample-2',
  project: 'sample',
  section: 'sample' | 'other',          // the rail heading — decided by discover(), never the renderer
  dir: '/Users/…/apps/sample-2',
  self: false,                           // true for the workspace that IS this app (its package.json
                                         // is Switchboard's): never startable — devCommand null and
                                         // processes [] whatever the folder says — and no Start (§6 R4)
  devCommand: 'npm run dev' | null,      // a root dev script, when there is one
  processes: ['demo-nextjs', …],      // the config's named processes; a workspace is
                                         // startable when devCommand OR processes exist
  fetchedAt: 1737000000000 | null,       // oldest successful fetch across the repos
  fetchAgeMs: 540000 | null,
  fetchStale: false,                     // true past 10 min — behind-counts are a guess
  repos: [Repo],                          // present only on scan(), not on list()
  branchSummary: 'TASK-352' | 'mixed' | 'main',  // the dominant non-main branch, for the Editor's full-screen band
  files: 6, add: 131, del: 24,           // workspace totals over all repos
  behindRepos: 1,                         // repos on main with behind > 0
}

Repo = {
  name: 'sample-api',                     // display name
  dirName: 'sample-api-2',
  dir: '/Users/…/apps/sample-2/sample-api-2',
  root: false,                            // true for the workspace folder itself — always the
                                          // first repo when there is one
  nested: [],                             // on the root: its child repos' folder names, which
                                          // git leaves out of the root's own listings
  branch: 'TASK-352',
  detached: false,
  head: '8740cb4…' | null,                // full HEAD sha — the only identity a detached repo has
  hasOrigin: true,
  onMain: false,                          // branch === 'main' (or 'master')
  ahead: 2, behind: 0,                    // vs origin/<branch> if tracking, else vs origin/main
  remote: { owner: 'example-user', repo: 'sample-api' } | null,
  files: [FileChange],
  add: 84, del: 3,
  pr: { number: 218, state: 'OPEN' } | null,   // filled lazily; see §4.4
  error: null | 'human sentence',
}

FileChange = {
  path: 'src/services/filters.ts',
  status: 'M' | 'A' | 'D' | 'R' | '?',    // '?' = untracked, rendered as 'A'
  add: 9, del: 2,
  binary: false,
  oldPath: null,                          // set when status === 'R'
}

RunState = {
  wsId: 'sample-2',
  status: 'idle' | 'starting' | 'running' | 'exited',
  pid: 12345 | null,
  startedAt: 1737000000000 | null,        // epoch ms
  exitCode: null | number,                // 128+N when a signal killed it, so a crash
                                          // never reads as a clean stop
  links: [Link],                          // live links, see ports.js
  procs: [{ name, pid, status, exitCode, signal, startedAt, command, cwd, mode, bytes, lines }],
}

GridView = {                              // one of the Grid's views — §4.10
  id: 'vmu8tsoedbx0b',
  name: 'Sample',
  cells: ['sample-1', '/Users/…/any/folder', null, 'sample-4'],   // always four; null is an empty
                                         // square; an absolute path is a FOLDER square — §4.10
}

Whiteboard = {                            // one board as every list and write answers it — §4.17
  id: '6f1d2c3a-…',                       // a UUID; the board's file is boards/<id>.json
  name: 'Search filters',                 // 1–120, one line; unique within its folder
  kind: 'flow',
  folderId: '0b7e…' | null,               // null is No folder — and so is a folder that has gone
  workspace: 'sample-2' | null,           // the rail workspace ✦ Answer's CLIs read for it (§4.18);
                                         // an id, never a path
  createdAt: '…', updatedAt: '…',         // updatedAt moves on a save or a rename, nothing else
  archivedAt: null | '…',
  boxes: 12,                              // nodes on it, pinned terminals left out
  reads: ['sample-2'],                    // the workspaces its AI boxes say they read (answeredIn), sorted
  thumb: [[4, 4.4, 10.7, 5.5], …],        // the list's mini preview: up to 14 boxes at the editor's own
                                         // node sizes, fitted inside a 4px margin of 40×30, none under 6×4
}                                         // + `spec` where the whole board is asked for (get, create, duplicate)

Folder = {                                // a folder the user made — a row in store.json, never a directory
  id: '0b7e…',
  name: 'sample',                         // 1–60, one line; unique whatever the case
  createdAt: '…',
  moved: true,                            // the migration made it and nothing has happened in it since
  count: 3, archived: 1,                  // list() only: its active and its archived boards
}

TerminalSlot = {                          // where a PINNED terminal's live xterm goes, as the editor
                                         // reports it to the host (onTerminalSlots) — §4.17, R15
  wsId: 'sample-2', nodeId: '…',
  body: { left, top, width, height },     // CLIENT px under the node's 30-unit header, inset 5px
                                         // left, right and bottom so the resize handles stay reachable
  clip: { left, top, right, bottom },     // CLIENT px of the React Flow pane
  zoom: 0.8,
  size: { width: 560, height: 340 },      // flow units, the COMMITTED size — it moves when a resize ends
  font: 12.5,                             // rendered px: the node's stored font × zoom
  minimized: false, selected: true,
  resizing: false,                        // from a resize handle's press until its size is committed,
                                         // or until that press is let go having moved nothing
  covered: false,                         // the canvas's own floating UI is over `body`
  holes: [{ left, top, right, bottom }],  // CLIENT px of the canvas's chrome over `body` — the tool
                                         // rail, the undo strip, the zoom controls — cut to it; [] if none
  live: true,                             // false when minimized, folded away, its workspace has left
                                         // the rail, or font < 7 px — the node draws its own card then
}

Usage = {                                 // what Anthropic says about the plan — §4.11
  ok: true,
  configured: true,                       // a local Claude OAuth credential was found
  plan: 'Max 5x' | 'Pro' | null,
  session: Limit | null,                  // the five-hour window
  weekly: Limit | null,                   // the week
  scoped: [Limit],                        // per-model weeks — "Fable this week"
  fetchedAt: 1737000000000,
}                                         // or { ok: false, configured, reason, error: 'human sentence', fetchedAt }

Limit = {
  name: 'Session' | 'This week' | 'Fable this week',
  percent: 92,                            // 0–100, rounded
  resetsAt: '2026-09-19T21:00:00Z' | null,
  severity: 'normal' | 'warning' | 'critical',   // Anthropic's when it says one; else 75 / 90
}

Shell = {                                 // the Terminal tab's login shell, NOT a dev process
  wsId: 'sample-2',                       // or a folder square's absolute path — §4.10
  status: 'running' | 'exited',
  pid: 12345 | null,
  startedAt: 1737000000000 | null,
  exitedAt: 1737000004000 | null,         // stamped by main in finish(); the renderer
                                          // cannot infer it for a shell that ended while
                                          // its window was shut
  exitCode: null | number,                // 128+N on a signal, as RunState does
  signal: null | number,
  cwd: '/Users/…/Projects/sample-2',
  shell: '/bin/zsh',
  pty: true,                              // false when node-pty is unavailable; see M6
  persistent: true,                       // inside tmux, so it outlives the app — M6
  closed: false,                          // true when Switchboard hung it up (close/quit)
                                          // rather than the user typing `exit`. zsh exits
                                          // 1 on SIGHUP, so the code alone cannot tell
                                          // a deliberate close from a crash.
  error: null | 'human sentence',
}

Link = { label: 'localhost:3000', url: 'http://localhost:3000', repo: 'sample-api', live: true }

Pr = {
  number: 218, title: 'Add search filters', state: 'OPEN' | 'MERGED' | 'CLOSED' | 'DRAFT',
  url: 'https://github.com/…/pull/218',
  owner: 'example-user', repo: 'sample-api',  // the remote's, so a PR from the list names itself
  headRef: 'TASK-352', baseRef: 'main',
  headSha: '8740cb4…' | null,             // the head shown; sb:pr:merge sends it back as its guard
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN',   // GitHub's word; UNKNOWN while it computes
  commits: 3, changedFiles: 3, additions: 22, deletions: 3,
  createdAt: '2026-09-15T…Z', relative: '2d ago',
  updatedAt: '2026-09-17T…Z',
  body: '## The problem\n…',              // the description, GitHub-flavoured markdown
  author: 'example-user', avatarInitials: 'EU',
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null,
  reactions: [Reaction],                   // on the description — Codex's 👍 lives here
  timeline: [PrEvent],                     // the conversation, oldest first — §4.4
  files: [{ path, add, del, patch }],      // patch = the unified diff body for that file
  comments: [PrComment],
  commentCount: 3,                         // conversation comments + inline review comments
}

Reaction = {
  content: 'THUMBS_UP',                    // GitHub's enum: THUMBS_UP … EYES
  emoji: '👍', count: 1,
  users: ['chatgpt-codex-connector'],      // who, when asked for (see §4.4); [] on inline comments
}

PrEvent = {                                // one entry of the Overview's conversation
  kind: 'comment' | 'review' | 'inline',   // a conversation comment, a review, or an inline
                                           // comment that belongs to no review on the page
  id: 123, url: '…', author: 'maya', avatarInitials: 'MA',
  createdAt: '…', relative: '2h ago',
  body: '…markdown…',                      // '' for a review that only carried inline comments
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | null,   // reviews only
  verdict: 'approved' | 'requested changes' | 'commented' | null,
  reactions: [Reaction],
  comments: [PrComment],                   // the inline comments submitted with this review
}

MyPr = {                                   // one row of the Pull requests screen — §4.12
  number: 81, title: '…', url: '…', state: 'OPEN' | 'DRAFT',
  owner: 'example-user', repo: 'sample-native',
  headRef: 'TASK-341', baseRef: 'main',
  createdAt: '…', updatedAt: '…', relative: '1d ago',
  additions: 2555, deletions: 830, changedFiles: 15,
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null,
  checks: 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED' | null,   // the last commit's rollup
  comments: 3,                             // conversation comments + review threads
}

PrComment = {
  id: 123, path: 'prisma/schema.prisma',
  line: 61 | null,                         // line in the NEW file; NULL means the comment
                                           // belongs to no line of the patch on screen
                                           // (outdated, or file-level) and must be rendered
                                           // at the end of that file's diff, never on a line
  originalLine: 490 | null,                // the line it was written against — shown, never used as an anchor
  diffHunk: '@@ …',                        // the hunk it was written against, for context
  url: 'https://github.com/…#discussion_r1',
  side: 'RIGHT' | 'LEFT',
  body: 'Add `@@index([itemId])` here — …',   // GitHub-flavoured markdown, render inline code only
  author: 'maya', avatarInitials: 'MA',
  createdAt: '…', relative: '2h ago',
  resolved: false,
  outdated: false,                         // true when the anchor line no longer exists
  replyTo: null | 123,
  reviewId: 456 | null,                    // the review it was submitted with — folds it under
                                           // that review on the Overview
  reactions: [Reaction],                   // counts only; see §4.4
}
```

---

## 3. Config

`src/main/default-config.json` is exactly `{}`. On first run, the app creates
`~/.switchboard/config.json` as an empty object. It does not select or scan a
workspace root automatically. `SWITCHBOARD_CONFIG` can select another local file.
User edits and app preferences are merged into that file, never the shipped defaults.

See `config.example.json` for a fictional starting point and
`.agents/skills/switchboard-setup/SKILL.md` for assisted onboarding. Real workspace
names, paths, commands, and ports belong only in the user's local configuration.

Optional configuration fields:

- `root`: a directory to discover multi-repo workspaces under. `~` expands to the
  current user's home. `appsRoot` is a legacy alias; explicit `root` takes precedence.
- `exclude`: child folder names to omit from discovery.
- `workspaces`: entries keyed by workspace ID. `dir` declares a folder even if it
  has only one repo. An absolute or `~/` directory works without a root; a relative
  directory requires a root. Declared folders are not filtered by `exclude`.
- `projects`: shared presets keyed by project name. Per-workspace settings override
  them. A trailing numeric workspace suffix is removed to derive the project name.
- `devCommand`, `processes`, `preflight`, `sideEffects`, `extras`, `needsPty`, and
  `repos` configure execution and links under a project or workspace. Per-workspace
  `links` override matching repo links. No command or port inventory ships by default.
- `terminal.appearance`, `sidebar.visible`, and `grid.views` store UI preferences.
  Each grid view has an `id`, `name`, and four `cells` (workspace IDs, absolute folder
  paths, or null). Which whiteboard a Grid square shows is not here: it is this Mac's
  arrangement, in localStorage (§4.10).
- `answer` is the ✦ Answer block (§4.18): who answers, the models and efforts, Web
  access and Subtext. Never a key — those are in `keys.json`.

Whiteboards keep a store of their own beside this file, `whiteboards/` (§4.17), and
nothing about them is in `config.json`: the folders, the workspace a new board starts
with, the recent workspaces the pickers lead with and the one-time migration notice are
all in `whiteboards/store.json`. `SWITCHBOARD_CONFIG` moves that folder with the config,
which is how every test and smoke keeps out of `~/.switchboard`.

Invalid configuration reports `configError` and falls back to an empty setup;
it is not overwritten on load. Missing roots produce no automatic discoveries.
Explicit folder terminals and absolute declared workspaces still work without a root.

---

## 4. IPC contract

Channel names are `sb:<area>:<verb>`. Every handler is registered with
`ipcMain.handle` in `src/main/index.js` and exposed on `window.sb` by `preload.js` with
exactly these names:

### 4.1 Workspaces
| `window.sb` | channel | returns |
|---|---|---|
| `sb.listWorkspaces()` | `sb:ws:list` | `Workspace[]` without `repos` — fast, no git |
| `sb.scanWorkspace(id, {fetch=false})` | `sb:ws:scan` | `Workspace` with `repos` |
| `sb.pullMain(id, repoName?)` | `sb:ws:pullMain` | `{ ok, results: [{repo, ok, message}] }` — all main repos when `repoName` omitted |

`scanWorkspace` must finish a 4-repo workspace in well under a second without `fetch`.
With `fetch: true` it runs `git fetch --no-tags` per repo first, in parallel.

### 4.2 Running
| `window.sb` | channel | returns |
|---|---|---|
| `sb.start(id)` | `sb:run:start` | `{ ok }` or `{ ok:false, error }` or `{ ok:false, conflict: { wsId } }` |
| `sb.stop(id)` | `sb:run:stop` | `{ ok }` |
| `sb.runStates()` | `sb:run:states` | `{ [wsId]: RunState }` |
| `sb.logs(id, procName?)` | `sb:run:logs` | `{ ok, text, name, procs: [{name, status}] }` — one process's ring buffer, for replay; the self workspace's last publish (§4.13) when the runner has nothing |
| `sb.sendInput(id, data, procName?)` | `sb:run:input` | `{ ok }` — keystrokes to the pty (expo's `i`, `r`) |
| `sb.resize(id, cols, rows, procName?)` | `sb:run:resize` | `{ ok }` — the terminal tells the pty its real size |

`conflict` is returned when another copy of the same project is running; the renderer
then offers "Stop <that one> and start this". The renderer performs that by calling
`sb.stop(conflict.wsId)` then `sb.start(id)` — main does not do it implicitly.

### 4.13 Desktop publishing

| `window.sb` | channel | returns |
|---|---|---|
| `sb.publish(id)` | `sb:publish:start` | `{ok, status, wsId, message}` or `{ok:false, error}` |
| `sb.publishState()` | `sb:publish:state` | `{status, wsId, message}` |
| `sb.onPublish(cb)` | `sb:evt:publish` | subscription; receives the same state |

Only a discovered `self` workspace may publish. `status` is `idle`, `publishing`,
`ready`, or `error`. A single build runs at a time; state survives renderer reloads.
Publish runs that workspace's `npm run install:desktop -- --stage <receipt> --target
<app>` with the repaired PATH. The target is the running packaged app, or the desktop
app when running from source. Neither paths nor shell commands come from the renderer.

The installer builds and signs a complete app, copies it to a hidden sibling folder,
and verifies it before reporting ready. The current app is unchanged until normal
quit: wait for any active publish, stop dev processes/detach terminals, then swap
the prepared app into the same location. A failed swap restores the old app and
keeps the window open with an error. Closing the window also quits while an update
is pending, so close/reopen works; ordinary macOS window closing is unchanged.
Publish requires the source checkout and its development dependencies. It publishes
locally, without Git operations, uploads or a remote release.

The build's output is written verbatim to `publish.log` under the app's user-data
folder and, at the same time, shown in the workspace's Logs tab. The publisher is not
a runner session — a session is stopped on quit, whereas a quit during a publish waits
for the build — so it emits the runner's own `sb:evt:log` and `sb:evt:run` events for
a single pseudo-process named `publish`, with piped line feeds rewritten as CR LF for
xterm. `sb:run:states` includes the workspace's last publish as a RunState (`running`,
then `exited` with code 0 or 1) when the runner has no session for it, and
`sb:run:logs` answers from the publisher's buffer (1 MB, trimmed at a line) in the
same case. The Logs footer of the self workspace offers **Publish again** in place of
Restart, and hides it while a verified update is pending; before any publish it reads
"nothing has been published yet — press Publish". Keystrokes typed into that pane go
nowhere: the build's stdin is not connected.

### 4.3 Diffs
| `window.sb` | channel | returns |
|---|---|---|
| `sb.fileDiff(id, repoName, path)` | `sb:diff:file` | `{ ok, patch, binary, truncated }` |
| `sb.allDiffs(id, repoName?)` | `sb:diff:all` | `{ ok, files: [{repo, path, add, del, patch, binary, truncated}] }` |

`patch` is the raw unified diff **body** (hunk headers + lines), without the
`diff --git`/`index`/`---`/`+++` preamble. Truncate any single file at 2000 lines and
set `truncated: true`.

### 4.4 Pull requests
| `window.sb` | channel | returns |
|---|---|---|
| `sb.prSummary(id)` | `sb:pr:summary` | `{ [repoName]: { number, state } \| null }` — cheap, cached 60 s |
| `sb.pr(id, repoName, {fresh})` | `sb:pr:get` | `{ ok, pr: Pr }` or `{ ok:false, error }`; `fresh` skips the 60 s cache (⌘R) |
| `sb.prByNumber(owner, repo, number, {host, fresh})` | `sb:pr:byNumber` | the same `Pr`, for a pull request named by owner/repo/number alone — how the Pull requests screen opens one, cloned here or not |
| `sb.mergePr(ref, {headSha})` | `sb:pr:merge` | `{ ok, merged: true, branch }`, `{ ok, merged: false, queued: true, branch: null }` when the base branch has a merge queue, or `{ ok:false, error }` — squash and merge on GitHub, then delete the merged branch there. `branch` is `{ name, deleted: true, already? }`, `{ name, deleted: false, skipped: 'it lives in a fork' }` or `{ name, deleted: false, error }`. `ref` is `{ wsId, repoName, number }` from a branch pill or `{ owner, repo, host, number }` from the list |

Errors the renderer must be able to show verbatim: `gh is not installed`,
`gh is not signed in`, `no pull request for TASK-352 yet`, `no pull request #81 in owner/repo`.

**Squash and merge** is `gh pr merge <number> --squash --repo [host/]owner/repo`, with
`--match-head-commit <headSha>` when the screen has one: `-R` keeps gh out of the
checkout entirely (no branch delete, no checkout — §0), and the head guard is the one
GitHub's own button uses, so a branch that was pushed to after the screen loaded is
refused with GitHub's sentence rather than merged unseen. The squash commit's message
is GitHub's default. On success every cached answer is dropped — the same pull request
may be cached under four workspace directories, the list's pseudo-directory and the
list itself — so the next look anywhere says Merged. A refusal (branch protection,
failing checks, a draft, conflicts) is gh's sentence with its `X` glyph and "failed to
merge pull request:" wrapper stripped.

**Then the branch goes**, on GitHub only: the click the user was always making on
GitHub's Delete branch button after a merge. Main asks GitHub what it merged
(`state headRefName baseRefName isCrossRepository`) rather than trusting the screen, and
deletes that head through `DELETE /repos/o/r/git/refs/heads/<branch>` only when the
state is MERGED, the branch is the repository's own (never a fork's) and it is not a
trunk. A 422 "Reference does not exist" is the branch already gone — a repository that
deletes head branches itself — and counts as deleted. The outcome rides along in
`branch` and never turns a merge that happened into a failure: the renderer's bar reads
`squashed and merged #218 into main · deleted TASK-352 on GitHub`, or a warning with
GitHub's sentence when the delete was refused. The checkout's local branch is untouched
(§0); a queued merge deletes nothing, the branch being still needed.

`Pr.timeline` is the conversation as GitHub's own tab shows it: every comment on the
pull request and every review, oldest first, each review carrying the inline comments
it was submitted with (`PrComment.reviewId`). A review with nothing to say — no body,
no inline comments, state COMMENTED — is the shell GitHub leaves behind when one inline
comment is posted alone, and is dropped; an empty APPROVED or CHANGES_REQUESTED review
is kept, the verdict being the content.

**Reactions are the point of the Overview**, not decoration: the Codex connector posts
no review at all when it has nothing to say — it leaves a 👍 on the PR's description
(login `chatgpt-codex-connector`), and that is only readable with the login. So the
query asks WHO reacted on the description, the conversation comments and the reviews,
and only HOW MANY on the inline review comments. The difference is the rate limit,
measured on #81: reactor lists under every inline comment cost 53 of the 5000
points/hour per PR; counts alone, 3.

### 4.12 Your pull requests
| `window.sb` | channel | returns |
|---|---|---|
| `sb.myPrs({fresh})` | `sb:prs:mine` | `{ ok, login, prs: [MyPr], total, fetchedAt }` or `{ ok:false, error }` — every open PR the signed-in user authored, in any repository, newest activity first; cached 60 s, `fresh` skips it |

One `gh api graphql` search (`is:pr is:open author:@me archived:false sort:updated-desc`),
the only call that spans every repository at once; one rate-limit point, ~1 s warm. It
needs nothing but the `gh` sign-in the rest of the app already uses — no token of its own.

### 4.5 Misc
| `window.sb` | channel | returns |
|---|---|---|
| `sb.openExternal(url)` | `sb:open` | `{ ok }` — `shell.openExternal` |
| `sb.writeClipboard(text)` | `sb:clipboard:write` | `{ ok }` — main owns the clipboard; see §4.7 |
| `sb.revealInFinder(dir)` | `sb:reveal` | `{ ok }` |
| `sb.openInEditor(dir)` | `sb:editor` | `{ ok }` — `open -a "Visual Studio Code" dir`, best effort |
| `sb.pathForFile(file)` | — | `string` — the absolute path of a `File` a Finder drop handed the renderer, `''` when it has none. Answered in the preload by `webUtils.getPathForFile`, no IPC: a sandboxed renderer's `File` has carried no path since Electron 32. The Terminal's drop handling (R8) is its only caller |
| `sb.dragBegan()` | `sb:term:drag` | `{ ok }` — a drag has entered a terminal pane; main snapshots the macOS drag pasteboard's promised files while the drag is live (R8, `main/drops.js`). Answered when the read is done; the renderer does not wait |
| `sb.dropFiles(entries)` | `sb:term:drop` | `{ ok, text }` — `entries` is `[{ path, name, type, bytes? }]` for a drop's Files (`path` from `sb.pathForFile`, `bytes` a `Uint8Array` when there was no path); `text` is what the terminal types: each file's escaped path, space-separated, a space after the last; `''` for a drop with no file. R8 |

### 4.6 Terminal

The Terminal tab is a real interactive login shell in the workspace directory — the
thing the user runs `claude` in. It is **not** the dev server: `Stop` never touches it,
and it survives every navigation. One shell per workspace, opened lazily the first time
anything shows it — the workspace's Terminal tab, a Grid square, or a terminal on a
whiteboard (R8).

**It survives quitting, too.** With tmux installed, the shell runs inside a tmux session
on Switchboard's own socket and what the app holds is a client attached to it; quitting
detaches the client, the next launch attaches again, and tmux paints the screen that was
there — Claude mid-turn included. `sb:term:open` on a session that already exists
attaches rather than spawns, and answers the SAME `startedAt` and `pid` (the session's
creation time and the shell inside it) so the renderer reads it as the shell it is. A
fresh xterm asking `sb:term:buffer` for a live tmux-backed shell gets `''` and a fresh
client behind it, painted whole by tmux, instead of a ring-buffer replay. See M6.

| `window.sb` | channel | returns |
|---|---|---|
| `sb.openShell(id, cols, rows)` | `sb:term:open` | `{ ok, state: Shell }` — idempotent: returns the live shell if there is one, else spawns. `id` is a workspace id or a folder square's absolute path (§4.10); main resolves either through `workspaces.dirOf` (M2), so a declared workspace (`website`, folder `website-landing-v2`) opens in its declared folder and never in one merely named after its id |
| `sb.shellInput(id, data)` | `sb:term:input` | `{ ok }` — keystrokes to the pty |
| `sb.shellResize(id, cols, rows)` | `sb:term:resize` | `{ ok }` |
| `sb.shellBuffer(id)` | `sb:term:buffer` | `{ ok, text }` — the ring buffer, for replay into a fresh xterm; `''` for a live tmux-backed shell, which is re-attached and repainted instead |
| `sb.closeShell(id)` | `sb:term:close` | `{ ok }` — SIGHUP the group, as closing a terminal window does |
| `sb.shellStates()` | `sb:term:states` | `{ [wsId]: Shell }` — for adoption after a renderer reload |
| `sb.termAppearance()` | `sb:term:appearance` | `{ appearance, effective }` — asked once at boot |
| `sb.setTermAppearance(choice)` | `sb:term:setAppearance` | `{ appearance, effective }` |

### 4.14 Editor

The fourth workspace tab, **Editor** (added 2026-09-26, the user's ask: "something very
simple, like Sublime Text … light, no extensions … browse and edit files", and a button
in the editor's top-right corner that opens it up full screen). Monaco — VS Code's
editor, nothing else of VS Code — over the workspace's repos: a file tree with one top
folder per repo, tabs, ⌘S, ⌘P, ⇧⌘F, modified-line markers against `HEAD`, and — since
2026-09-28 — New file, New folder, Rename and Delete on the tree (§4.16). Out of scope
on purpose: any git operation, language servers, extensions, settings, split panes. The
renderer side is R13; this is the channel area
`code` (`sb:editor` is the older "open the folder in VS Code" of §4.5 and has nothing to
do with it).

`id` is a workspace id — **never** an absolute path: those are the Grid's folder squares
(§4.10), which have no workspace screen and so no Editor, and they are refused. `repoName`
is `Repo.name`, the display name, the same key `sb:diff:file` takes; `path` is
repo-relative with `/` separators.

| `window.sb` | channel | returns |
|---|---|---|
| `sb.codeTree(id)` | `sb:code:tree` | `{ ok, repos: [{ name, files: [path…], ignored: [path…], truncated, error }] }` — `files` is every file git would show: tracked plus untracked-not-ignored, minus tracked files deleted from the worktree, deduplicated; `ignored` is every file `.gitignore` keeps out of git — `.env.local`, a `config.json`, a `debug.log` — which the tree shows too, dimmed, because being kept out of git is the usual reason someone needs to open a file. Ignored *folders* stay out whole (`node_modules/`, `dist/`, `.next/`: git prints each as one entry with `--directory` rather than walking it, and every such entry is dropped, so a file inside one is in neither list), and `.DS_Store` / `Thumbs.db` are dropped from the ignored list, as VS Code hides them. Four listings run side by side (`git ls-files -z -c`, `-o --exclude-standard`, `-d`, `-o -i --exclude-standard --directory`), tracked files first and ignored ones last, so the cap of 100 000 per repo over both lists (`truncated: true`) costs ignored files before untracked ones and those before any tracked one: one `-c -o` call printed every untracked path before the first tracked one, and an un-ignored `node_modules` filled the tree with nothing else. An untracked or ignored listing that fails or times out is that same cut, not a failed repo. An untracked nested repo or linked worktree is one `-o` entry, `vendor/lib/`; it loses the slash and is a row like any file, whose read says it is a folder. One entry per repo in the order `workspaces.scan` gives them, the folder itself for a single-repo workspace; a workspace folder that is a repo as well as a folder of repos is the first entry, and its tree leaves out the child repos (each is an entry of its own) and a parked `.git.disabled`. A repo git cannot list gets `files: []` and an `error` sentence; it never fails the call. Find in files (`sb.codeSearch`) still searches only `files`: `git grep --untracked --exclude-standard` does not read ignored files |
| `sb.codeRead(id, repoName, path)` | `sb:code:read` | `{ ok, text, mtimeMs, size, bom }` for UTF-8 text up to 5 MB (a BOM is stripped from `text` and reported as `bom: true`); `{ ok, binary: true, mtimeMs, size }` when the first 8 KB hold a NUL or the bytes are not valid UTF-8; `{ ok, tooLarge: true, mtimeMs, size }` over 5 MB; `{ ok:false, missing: true, error: '<path> is not there any more' }`; `{ ok:false, error: '<path> is a folder' }` — a submodule's gitlink, an untracked nested repo and a linked worktree each list as one path |
| `sb.codeWrite(id, repoName, path, text, {mtimeMs, bom, force})` | `sb:code:write` | Save. `{ ok, mtimeMs, size }` from a fresh stat, or `{ ok:false, conflict: true, missing, mtimeMs, error: '<name> changed on disk since it was opened' }` (`… was deleted on disk`) — see below. `text` is a string of at most 20 MB |
| `sb.codeBase(id, repoName, path, oldPath?)` | `sb:code:base` | The `HEAD` version, for the markers: `git cat-file blob HEAD:<oldPath or path>`. `{ ok, text }` when the blob exists, holds no NUL and is at most 3 MB; `{ ok, text: null }` when `HEAD` has no such path or there is no `HEAD` yet (every line is then "added"); `{ ok, text: null, skip: true }` for a binary or oversize blob (no markers at all). `oldPath` is a rename's, from `FileChange.oldPath`. A path that goes through a symlink (`CLAUDE.md -> AGENTS.md`, or a file in a linked folder) is asked for by where it really is in the repo, since the read shows the target's text and `HEAD`'s blob for the link is only the target's name — diffed against each other, an unchanged file was all modified. A path with no link in it keeps git's spelling, which is what `HEAD` knows it by after a case-only rename not yet committed |
| `sb.codeStat(id, files)` | `sb:code:stat` | `{ ok, stats: [{ repo, path, exists, mtimeMs, size }] }` for `files = [{ repo, path }]`, in order, at most 200 (the rest ignored); a path the guard refuses, or one that is not there, is `{ exists: false, mtimeMs: null, size: null }`. How open tabs notice an outside change |
| `sb.codeSearch(id, query, {caseSensitive, regex})` | `sb:code:search` | Find in files: `{ ok, matches: [{ repo, path, line, text, offset, ranges }], truncated, files, errors: [{ repo, error }] }` — per repo `git grep -z -n -I --untracked --exclude-standard --no-color --no-column --no-recurse-submodules --max-count 200 [-i] (-F \| -P) -e <query> --` (`--no-recurse-submodules` because a user's `submodule.recurse=true` makes git refuse `--untracked` outright; exit 1 is no matches, not an error), across repos in order, at most 2 000 matching lines (`truncated`; the Find results count is of matches — a line can hold several — so it adds up the spans), 15 s. `-E` gets one retry only when this git was built without PCRE (`cannot use Perl-compatible regexes when not compiled with USE_LIBPCRE`); a PCRE that gives up mid-search (its match limit) is that repo's error, never a quiet re-read as POSIX ERE, where `\d` is the letter d. A line over 400 characters comes back as a 400-character window from about 80 before the first match, `offset` being where it starts in the full line. `ranges` are the highlights, `[[start, end], …]` inside the returned `text` (UTF-16, at most 50 a line, empty matches skipped, clipped to the window) — see below. An empty query answers no matches; one over 500 characters, `that search is too long`; one with a line break, `find in files searches one line at a time` |
| `sb.codeDirty(count)` | `sb:code:dirty` | `{ ok }` — how many open files have unsaved edits, sent whenever the number changes; main asks before a close or a quit (below) |
| `sb.closeWindow()` | `sb:ui:closeWindow` | `{ ok }` — closes the window exactly as File ▸ Close's old role did, through `win.close()`, so its `close` handler still runs (bounds, publish on close, the question below) |

**One path guard, in `main/editor.js`, for read, write, base and stat.** It resolves
`(id, repoName)` without a `scan()` — that runs several git commands per repo, and a
stat poll every 3 s cannot afford it: `workspaces.lookup(id)` gives the folder,
`workspaces.reposOf` its repos (the folder itself when it is a repo, then its repo
children), and the one whose display name is `repoName` wins. Then the path: a
non-empty string, no NUL, not absolute, and no segment that is empty, `.`, `..`,
`.git` or `.git.disabled` — a parked git dir is a `.git` by another name — (in any case:
a Mac's disk is case-insensitive). Then the disk: the realpath of
the file — or, for a file that is not there yet, of its parent folder — must be the
repo's realpath or under it, and never under its `.git`; a symlink pointing out of the
repo is refused like `../`. The sentences: `<path> is outside <repo>`, `<repo> is not a
repo in <id>`, `no workspace called <id>`.

**Save writes in place.** `fs.promises.writeFile` on the file itself, never a temp file
renamed over it: a rename is a new inode, which drops the file's mode (an executable
script stops being one) and breaks a hard link — for a file the user did nothing to but
edit. The BOM the read stripped goes back on. Before writing, unless `force`, the
file's current mtime is compared with the one the tab opened (or last saved) at: more
than 0.5 ms apart, or the file gone, and nothing is written — the answer is `conflict`,
and the renderer asks (Overwrite, or Reload). A missing file may only be created again
where its parent folder still exists inside the repo: that is "deleted on disk → Save
again", not a way to make new files. The renderer only asks for a write there is a
reason for: ⌘S on a clean tab writes nothing (a forced save — Overwrite, Save again —
and a deleted file's still do), and a file that mixes line endings on disk asks before
its first save, which would make every line end the model's one way (R13).

**Find's highlights are main's, and bounded.** The user's pattern is run by git, and
then once more in JS to say where on each line it matched — and git's `-P` is PCRE
while a JS `RegExp` is V8's: `\h` is whitespace to one and the letter h to the other,
so `(\h+)+b`, which git answers in 12 ms, backtracks 2^40 times in V8 over a line of
h's. That second run is therefore in main, never the renderer, and never unbounded:
`git.js` builds the `RegExp` inside a fresh `vm` context from the pattern's source and
flags (with `u` when it compiles so, without when it does not) and scans every matched
line of a repo's answer in ONE `runInContext` with a 250 ms timeout, which V8 does
interrupt mid-backtrack. A timeout, or a pattern V8 cannot compile, gives every line of
that repo `ranges: []` and a window from 0 — the lines still show, unhighlighted. A
fixed string is a plain `indexOf` loop with nothing to bound; case-insensitive compares
lowercase with lowercase, and a line whose length lowercasing changes (`İ`) gets no
spans. The renderer paints `ranges` and runs no pattern of its own at all, so a user's
regex never runs unbounded in either process.

**No watcher.** Open tabs are stat-polled by the renderer — every 3 s, and only while
that Editor is on screen and the window has focus — and re-checked on every window
focus (`handleFocus`, R2). One `stat` per open tab is cheaper than an `fs.watch` over
repos of tens of thousands of files, and it cannot go deaf: an editor or formatter that
saves atomically (temp file, rename) swaps the inode a watch handle is holding, and the
watch never hears of the file again. The tree is re-listed on focus, on ⌘R and after a
save.

**Unsaved work is asked about, once.** `beforeunload` is no use — Electron shows no
dialog for it, it only cancels the close silently — so the renderer keeps main told how
many files are dirty (`sb:code:dirty`), and main asks, synchronously, in the window's
`close` and in `before-quit`: `dialog.showMessageBoxSync` with **Discard Changes** and
**Cancel** (the default), `You have unsaved changes in N file(s).` It is the one
question the app ever asks in a modal, against the standing rule of one bar, and it has
to be: a close or a quit is decided inside main's event handler — `preventDefault()`
then or never — while a bar would need the renderer to answer across IPC first, and ⌘Q,
the Dock's Quit and a logout do not wait for that. `before-quit` asks first and marks
the answer, so the window's own `close` that follows a Discard does not ask again; a
quit that then does not happen clears the mark. The count is reset when the window
closes, its buffers being gone with it. A smoke run never shows the box: under
`SB_SMOKE` it logs `SMOKE unsaved: N` and discards.

**And once more, if the quit had to wait.** A quit is deferred until a publish in flight
has finished and the dev servers are down (§4.13, M5) — tens of seconds when it is a
whole build — and the window stays live meanwhile: nothing tells the renderer a quit is
pending. So `before-quit` asks again at the END of that wait — after `stopEverything()`,
before `publisher.applyOnQuit()` — when files are dirty by then and no Discard covers
them: nothing was dirty at ⌘Q, so nothing was asked, or a file has gone dirty since the
Discard (`sb:code:dirty` reporting a higher count while `quitting` clears `discardOk` — a
Discard was about the files unsaved then, not whatever is typed next). Without it an edit
typed during the wait was dropped unasked: the second `before-quit` returns at once on
`quitting`, and the window's `close` skips its question while quitting. Cancel there
clears `quitting` and shows the window, its buffers and the prepared update all kept
for the next quit; the dev servers and shells are already stopped, which a cancelled
quit can live with.

`sb:ui:closeWindow` exists because ⌘W is no longer the `close` role (§4.7): in the Editor
it closes a file tab, and anywhere else the renderer asks for exactly what the role did.
While the key window is not a Switchboard window at all — the About panel, a native
panel, where `BrowserWindow.getFocusedWindow()` is null — main never sends the event: it
does what the role did, `performClose:` to that window. Otherwise the event reached the
main page behind the panel, which closed an Editor tab or the whole window and left the
panel up.

### 4.16 Editor: making, renaming and removing a file

The three writes the Editor's tree can do beside Save (added 2026-09-28, the user's ask:
"it's not possible for me to create new files within the actual apps. That should be
possible. There should be a right-click and a new file, and I should be able to rename
files and so on"). Same channel area `code` as the rest of §4.14, the same arguments, and
the same one guard in `main/editor.js` in front of them: nothing here can name a path
Save could not.

| `window.sb` | channel | returns |
|---|---|---|
| `sb.codeCreate(id, repoName, path, {dir})` | `sb:code:create` | `{ ok, path, dir }` — an empty file, or a folder with `opts.dir`. Folders on the way are made as needed, so a name typed with slashes in it means all of it. An existing path is always `{ ok:false, error: '<path> is already there' }`, never an overwrite |
| `sb.codeRename(id, repoName, from, to)` | `sb:code:rename` | `{ ok, from, to, dir }` — `to` is a whole repo-relative path, so renaming and moving are one operation and folders on the way are made. `{ ok:false, error: 'there is already something called <name> there' }` for a destination that is taken, `'<path> cannot be moved inside itself'` for a folder into its own subtree |
| `sb.codeDelete(id, repoName, path)` | `sb:code:delete` | `{ ok, path, dir, trashed }` — the Trash, via `shell.trashItem`, passed in by `index.js` because `editor.js` never loads Electron (its tests run under plain `node`). A FILE whose trashing fails falls back to an `unlink` and answers `trashed:false`; a FOLDER never does — a recursive delete nobody can undo is not a thing to do behind a failure — and answers `could not move <path> to the Trash: <reason>` |

**No git, ever.** A new file is untracked and `git ls-files -o --exclude-standard` shows
it on the next listing with nothing staged (M3's `lsFiles`). `git add -N` would also
work and is forbidden for the reason it always was: it mutates the user's index.

**They act on the LEXICAL path, not on what the guard resolved.** `path.join(repoReal,
rel)`, not `checkPath`'s `real`. The difference is a symlink: renaming or binning
`CLAUDE.md -> AGENTS.md` has to move THE LINK, and following it would silently operate on
a different file than the row that was clicked. The guard has already answered the
question that mattered — whatever the path resolves to is inside this repo, and a link
pointing OUT of it is refused outright, as it is for read and write — so which of the two
ends is touched is this code's own decision, and it is the one the user pointed at.

**A delete that could not reach the Trash says so.** The bar asked "move X to the
Trash?", and that promise — a slip is one ⌘Z in Finder away — is the whole reason this is
allowed at all. When `trashItem` fails and a FILE is unlinked instead, the answer carries
`trashed: false` and the Editor's bar reads `deleted X — the Trash was not available, so
this cannot be undone`. Reporting plain success there would be reporting a guarantee that
did not hold.

**A case-only rename is the one time an existing destination is allowed.** On APFS
`readme.md` and `README.md` are the same file, so the "is something there?" test sees the
source itself; refusing would make fixing a file's capitalisation impossible. The test is
`realpath(src) === realpath(dst)`, and `fs.rename` does the right thing with it. The test is the two paths' `lstat` dev+ino, NOT
their realpath: realpath follows links, so `CLAUDE.md -> AGENTS.md` and `AGENTS.md`
resolved to one path, read as "the same file", and `fs.rename` replaced the real file with
the link — a dangling self-reference, the bytes gone and never in the Trash. Measured.

### 4.17 Whiteboards

**Whiteboards** is a free screen in the rail, the third row above the workspaces beside
Grid and Pull requests (2026-10-08, from an approved mock-up). It began on 2026-10-04 as
the workspace's fifth tab, **Diagrams** — the user's ask: their web admin's diagram
feature as a desktop app, inside Switchboard, with its ✦ Answer using "the corresponding
workspace and the CLI tool … I should be able to select what CLI tool it is, whether it's
Codex or Claude". Flow diagrams — boxes, arrows, sticky notes, text, pictures and
Markdown documents, arranged by hand, Tab for the next box — in the admin's own editor,
saved as you go. A whiteboard belongs to no workspace: boards live in folders the user
makes, and each board names the one workspace its ✦ Answer reads (§4.18). Terminals float
over a board or are pinned to it — any number, one per workspace — and each is still that
workspace's own shell (R8, R15). The renderer side is R15; who answers ✦ Answer is §4.18.
What the user reads says whiteboard; the internal names — `src/diagrams`, `SBDiagrams`,
`DiagramsPage`, `build:diagrams`, `test:diagrams` and the `sb:diagrams:*` channels kept
below — stay as they were.

**The editor is the admin's, mirrored by hand.** `src/diagrams/` holds copies of the
admin's `app/dashboard/diagrams/*` and `lib/diagrams/*` under the same paths, so a change
there can be carried across file by file. Where Switchboard differs the copy says so
(`Switchboard:`), and the differences sit behind module boundaries wherever they can: the
admin's server actions, Vercel Blob uploads and OpenAI client are replaced by modules of
the same names that call `window.sb` (`lib/diagrams/actions.ts`, `upload.ts`,
`ai-client.ts`). It is the one React in the app, built by `scripts/build-diagrams.js`
(§0).

**Where the editor goes further than the admin's** (added 2026-10-04, the user's asks —
"it automatically creates the new nodes so that it's perfectly shaped. We need to honor
that"). A branch Tab builds is always laid out symmetrically: Tab, ✦ Answer's boxes and
a delete all go through `lib/diagrams/flow-editor.ts`, which re-centres the whole tree
on its top box and then pushes whatever it would now crowd (another tree, a note) up or
down out of its way, whole, `FLOW_ROOM_GAP` clear — where the admin gives up on the
layout when anything is in the way. A box drags what hangs off it along, step for
step ("when I move this parent node … I want it to also move all of the children with
it"; `flowBranches`, worked out when the drag begins), and so does a Shift+arrow nudge.
Let go, it takes the place its height says among its siblings — "if I drop that node
somewhere in between two other nodes … it'll squeeze it in" — back in their column, and
the tree is laid out again the same way (`tidyAfterMove`), one undo step with the drag.
A box dragged left of what it hangs off leaves the branch, which closes up; a box in no
branch stays where it was dropped. The box toolbar's **Attached / Detached** (a link)
takes a box out of every branch (`detached: true` on the node): it moves on its own,
nothing it is joined to moves with it, and laying out a branch leaves it where it is;
attached again, it is laid out in its branch and its branch around it. Tab or ✦ Answer
on a detached box attaches it first. A drag-select takes every box it touches
(`SelectionMode.Partial`). Any number of boxes can wait on ✦ Answer at once, one answer
per box: the strip says "Answering 3 boxes · Stop all", each box's toolbar stops its
own, and an answer that lands while you have moved on to another box leaves your
selection and the view alone. ⌘I answers as ⌘↵ does. Edit ▸ Copy, Cut and Paste work on
boxes: ⌘C keeps the selected boxes and the arrows between them for the bundle (any
whiteboard) and puts their words on the clipboard; ⌘V puts new copies down centred on
the pointer, but only while the clipboard still holds those words, so text copied since
never pastes an older copy. An arrow can be **collapsed** (`collapsed: true` on the edge in
the spec): `layout.ts foldFlow` hides what it points at and everything that can no longer
be reached from the board's starting boxes without crossing a collapsed arrow (loops set
aside, so a branch never folds away what leads to it); the editor hands React Flow those
boxes marked hidden, lays out and pushes as if they weren't there, shows a "+N" on the box
they are folded behind, carries them along when that box is dragged, and deletes them with
it. Unfolding re-tidies the tree around them. A whiteboard has **no limit** on boxes,
arrows or size (the admin's 60 / 120 / 512 KB, `types.ts` says why not here): the layout
and save paths stay in single milliseconds into the thousands of boxes. **Actions ▸
Rename** (`RenameDiagramDialog.tsx`) writes the name and nothing else. And the image
tool is a menu — a file, or **Google Images** (G): Google's own results in a panel docked
on the canvas's right, whose pictures drag straight onto it (below). The tool rail fits
the canvas's height (`data-rail-fit`): at full size, `compact` (28px tools packed closer),
or in two `columns` on a canvas shorter still — a Grid square, a small window — where
what a tool opens sits beside the whole rail rather than over the next column; it never
runs off the canvas with its first tools out of reach. Full screen re-frames the drawing
by hand, not with `fitView`'s d3 transition, which measures the pane a frame or two late
and, for a board taken off screen in between, interpolated over a pane of no size, NaN
on every frame: the target is worked out once from the pane on screen and each step is
set outright; a pane gone part-way jumps to the end, a pan or zoom by hand wins, and a
board already off screen is framed at once, not animated, when it is back. `npm run
test:diagrams` covers the layout and folding (`scripts/test-flow-layout.js`).

**Condense replaces an explored discussion.** A rectangle selection of connected text
nodes, or sibling branches sharing an outside parent, gets **✦ Condense** in the
floating toolbar; ⌘I dispatches to it for multiple selected nodes. The complete selected
graph and its outside parents go to the current AI provider. The prompt reconciles
corrections and asks for a few standalone concepts, fewer than the selection and at
most six. `lib/diagrams/answer.ts` validates every returned part before the editor
changes anything. `lib/diagrams/condense.ts` keeps IDs and layout local: incoming arrows
fan out to the summaries, outgoing continuations follow the final concept, and every
unselected node survives. A pinned terminal in the selection is refused ("Leave
terminals out of the selection before condensing."), and one beside it stays where it
was put. The replacement is one undo step. A content/connection fingerprint prevents a
pending response from replacing a changed discussion; moves are allowed, and Stop,
undo/redo, or leaving the whiteboard cancels it. Graph and prompt tests are in
`scripts/test-condense.js` and `scripts/test-answer.js`.

**A whiteboard lives on this Mac, in a folder the user makes.** Everything is under
`<config dir>/whiteboards/` — beside the config rather than in a repo, so it never
appears in Changes or gets staged with `git add -A`:

```
whiteboards/
  store.json          { version: 1, folders: [Folder], lastWorkspace, recentWorkspaces,
                        notice: { boards, folders, dismissed } | null, migration: {…} | null }
  boards/<id>.json    one board: the admin's row { id, name, kind, createdAt, updatedAt,
                      archivedAt, spec } minus the product, plus folderId, workspace and,
                      on a migrated one, migratedFrom: { legacyKey, workspace }
  documents/<id>.md   every board's Markdown documents, keyed by document id
  images/<sha>.<ext>  pictures, kept once by content (below)
```

Folders exist only in `store.json`. A board names its folder by id and every board file
sits flat in `boards/`, so moving a board or renaming a folder is one small write, and a
folder's name is only ever data, never a path. A board names its workspace the same way:
a rail workspace id, which `index.js` resolves to a folder and nothing else does. These
are not the admin's diagrams and never sync with them; the spec's format is the same, so
one can be carried either way by hand. A field a board file holds that this version does
not know survives every write. A file in `boards/` that is not a board is skipped by the
list and logged, and `get` says so; an unreadable `store.json` is copied aside as
`store.unreadable-<ms>.json` before the first write replaces it, never overwritten unseen.

**Every write goes through one chain.** Each board write and each `store.json` write —
create, save, rename, workspace, move, duplicate, archive, delete, the folders, the
notice, the recent workspaces and the migration itself — is a job on ONE serial chain,
so a name check and the write it guards cannot interleave with another, and each goes
through a temp file and a rename, so a crash cannot leave half a file. Documents keep a
chain per file, and every copy into `documents/` — the migration's, a first open's
(below) — runs on that document's chain too. `settle()` waits on all of them. After
every successful write main sends `sb:evt:wbChanged` `{ reason, boardId?, folderId? }`
(§4.7), `reason` one of `save`, `create`, `rename`, `workspace`, `move`, `duplicate`,
`archive`, `delete`, `folder` and `notice`; the recent workspaces change no board or
folder and send nothing, so a picker asks again each time it opens. Every `sb:wb:*`
handler waits for the migration that runs before the first window (below), so nothing
reads a half-moved store. Nothing here deletes anything but the one board, or the one
empty folder, the user asked to delete.

| `window.sb` | channel | returns |
|---|---|---|
| `sb.whiteboardsList()` | `sb:wb:list` | `{ ok, data: { folders: Folder[], boards: Whiteboard[], notice, lastWorkspace, recentWorkspaces, migration } }` — every board, archived ones included, newest edit first, no specs; folders by name (`sample 2` before `sample 10`, case ignored); `migration` is `{ error, skipped, legacyRoot, legacyLabel }` once one has run, else null — `legacyLabel` the old tree's real folder as the screen's sentences name it, the home written `~` (a finished run's renamed tree, or null when there was none; before then `<config dir>/diagrams`, or a rename a stopped run made and never recorded). Summaries are cached by the file's mtime, size and inode, so a board nobody touched is not parsed again. A store with nothing in it answers empty lists |
| `sb.whiteboardsGet(id)` | `sb:wb:get` | `{ ok, data: Whiteboard + spec }` — the spec as stored; the bundle re-parses it with the admin's validator and shows what is wrong with one that no longer draws. `Whiteboard not found` for one that has gone |
| `sb.whiteboardsCreate(req)` | `sb:wb:create` | `req = { folderId, name, spec, workspace? }` → `{ ok, data: Whiteboard + spec }`. `folderId` null is No folder; `workspace` left out starts the board with the workspace a new board starts with (below), null with none. A name already in that folder: `A whiteboard named “X” is already in “F” — pick another name` |
| `sb.whiteboardsSaveSpec(id, spec)` | `sb:wb:saveSpec` | the autosave: `{ ok, data: Whiteboard }` — the spec only, never the name; `updatedAt` moves |
| `sb.whiteboardsRename(id, name)` | `sb:wb:rename` | `{ ok, data: Whiteboard }` — the name only, unique in its folder; `updatedAt` moves |
| `sb.whiteboardsSetWorkspace(id, wsId)` | `sb:wb:setWorkspace` | `{ ok, data: Whiteboard }` — the workspace ✦ Answer reads for it, or null. Not an edit of the board: `updatedAt` stays. A workspace (not null) also becomes the one used last and leads the recent ones |
| `sb.whiteboardsMove(id, folderId)` | `sb:wb:move` | `{ ok, data: Whiteboard }` — into a folder, or No folder (null); `updatedAt` stays. Refused onto a name that folder already has: `A whiteboard named “X” is already in “F” — rename it first` |
| `sb.whiteboardsDuplicate(id)` | `sb:wb:duplicate` | `{ ok, data: Whiteboard + spec }` — beside it, in the same folder with the same workspace, active, named `X copy` (then `X copy 2`, …). Every document its spec names is copied to a new file — read from the old tree when only it has one (below) — and the copy points at that |
| `sb.whiteboardsArchive(id, archived)` | `sb:wb:archive` | `{ ok, data: Whiteboard }` — `updatedAt` does not move, so archiving reshuffles nothing |
| `sb.whiteboardsDelete(id)` | `sb:wb:delete` | `{ ok, data: { id } }` — for good, the board's own file and nothing else; the confirmation dialog is the gate |
| `sb.whiteboardsCreateFolder(name)` | `sb:wb:createFolder` | `{ ok, data: Folder }`, or `A folder named “F” already exists` |
| `sb.whiteboardsRenameFolder(id, name)` | `sb:wb:renameFolder` | `{ ok, data: Folder }` — and a migrated folder stops being `moved` |
| `sb.whiteboardsDeleteFolder(id)` | `sb:wb:deleteFolder` | `{ ok, data: { id } }` — an empty folder only: with any board in it, archived ones too, `Move its whiteboards out first` |
| `sb.whiteboardsDismissNotice()` | `sb:wb:dismissNotice` | `{ ok, data: {} }` — the migration notice has been read and does not come back |
| `sb.whiteboardsNoteWorkspace(wsId)` | `sb:wb:noteWorkspace` | `{ ok, data: { recentWorkspaces } }` — a terminal was opened in it on a board: it leads the pickers' Recent |
| `sb.whiteboardsWorkspaces()` | `sb:wb:workspaces` | `{ ok, data: { workspaces: [{ id, project, dirLabel }], recent, last } }` — what a workspace picker offers: the rail in discovery order, each with its project and its folder (the home written `~`), the recent ones that are still in the rail, and `last`, the workspace a new board would start with. One `discover()`, never a scan |
| `sb.whiteboardsCreateDocument(text)`, `sb.whiteboardsGetDocument(id)`, `sb.whiteboardsSaveDocument(id, text, revision)` | `sb:wb:createDocument`, `sb:wb:getDocument`, `sb:wb:saveDocument` | `{ ok, data: { id, text, revision, path } }`; a save whose revision is stale answers `code: 'conflict'`; a get for a document only the old tree has copies it in first. Markdown documents, below |
| `sb.whiteboardsMigrate()` | `sb:wb:migrate` | `{ ok, data: { boards, folders, skipped, legacyRoot, already? } }` — the screen's Try again after a migration that stopped part way: it resumes where the last run left off, and `list()` then says how it went |
| `sb.diagramsSaveImage(bytes, type)` | `sb:diagrams:saveImage` | `{ ok, src }` — `sbimg://image/<file>`; see below |
| `sb.diagramsGetImagePath(src)` | `sb:diagrams:getImagePath` | `{ ok, data: path }` — a picture's file on disk, for its copy-path button; an `https:` picture an imported spec names is fetched and kept first |
| `sb.diagramsClipboardImage()` | `sb:diagrams:clipboardImage` | `{ ok, bytes, type }` — the clipboard's PNG, for Edit ▸ Paste over the canvas |
| `sb.diagramsFetchImage(url, referrer?)` | `sb:diagrams:fetchImage` | `{ ok, bytes, type, name }` — a picture from the Google Images panel, by its address, as PNG, JPEG or WebP; or `{ ok:false, error }`. See Google Images, below |
| `sb.diagramsDirty(count)` | `sb:diagrams:dirty` | `{ ok }` — 0 or 1, whenever it changes; see below |

The pictures, the clipboard, the Google Images fetch, the dirty count and the flush keep
their `sb:diagrams:*` names: they are internal, and the bundle mirrors them.

**Folders are the user's.** Any number, made, renamed and deleted on the Whiteboards
screen (R15). A folder's name is one line of 1–60 characters, unique whatever its case,
and folders list by name, numbers in order. A board's name is unique within its folder —
exactly, as the admin's is within a product — and the boards in no folder are one
namespace of their own, so two folders may each hold a "Search filters". A board whose
`folderId` names a folder that is not there lists as No folder. A folder the migration
made is `moved`, and the screen marks it so, until something happens in it: the folder
renamed, a board created in it or moved into it, or one of its boards saved, renamed or
duplicated. A folder with any board in it — an archived one included — is never deleted;
the user moves them out first, so deleting a folder can never take a board with it.

**A board's workspace.** `workspace` is the rail workspace ✦ Answer's CLIs read for that
board (§4.18) — one per board, never one per box. It is checked as an id and never taken
as a path: one line, at most 200 characters, no `/` or `\`, no control character, no
leading dot. A new board starts with the workspace used last (`store.lastWorkspace`: the
last one picked for a board, or the last one a CLI was asked to read) while that is still
on the rail, else the most recent one that is, else none (`startingWorkspace`, against
one `discover()` started before the write joins the chain; a discovery that fails trusts
the store) — workspaces leave the rail, and a new board never starts out reading one
that has gone. An explicit `workspace` is taken as given. A copy starts with its
original's, a migrated board with the one its old folder belonged to, gone or not.
`recentWorkspaces` — eight at most, newest first — is the pickers' Recent group: a
workspace goes to its front when it is picked for a board, when a CLI starts reading it,
and when a terminal is opened in it on a board.

**Markdown documents.** A `shape: "document"` node stores a display label and UUID
`documentId`; its source is a plain file at `<config
dir>/whiteboards/documents/<documentId>.md` — one folder for every board, so moving a
board between folders moves no file. `DocumentPanel.tsx` opens floating by default, with
docked and focus layouts and Read / Write / Split modes. Rendering reuses `SB.markdown`
with document soft breaks. The native textarea owns its editing history; Tab indents
Markdown and panel events stay outside canvas shortcuts. `useFlowDocuments.ts` owns the
buffers and serial save queues in one store for the whole window, retaining failed edits
across board switches; each editor's dirty flag and save error count only the documents
that editor has opened or edited, so one board never shows another's failed save. A
change wakes only those editors too: the store says which document changed, and a hook
re-renders only for one of its own, so typing in a document never re-renders the
canvases parked beside it. Saves use the file's content hash as a revision, refusing
stale writes after an external edit. `whiteboardsCreateDocument`,
`whiteboardsGetDocument`, and `whiteboardsSaveDocument` bridge to atomic writes in
`main/whiteboards.js`, whose `settle()` includes document writes. Copies and duplicates
create independent files — Duplicate copies every document its board names and rewrites
the `documentId`s; removing nodes, or a whole board, retains their files for undo and
recovery. Archived boards open documents in Read mode. The isolated production-bundle
check is `npm run test:documents:browser`.

**Pictures are kept once, by content.** A picture dropped, pasted or picked onto a
canvas is written to `<config dir>/whiteboards/images/<sha256>.<png|jpg|webp>` and the
image node's `src` is `sbimg://image/<file>`. `sbimg` is registered as a standard, secure
scheme before `ready` and served by `protocol.handle` from that folder and nowhere else
but the old tree's (below): a request names a file only by a name `imagePath()` accepts
(32 hex and one of three extensions), and the old tree's name is read from `store.json`
only when it is one the migration could have written. The bundle's copy of the admin's
validator accepts that one scheme beside `https:`. Deleting a board leaves its pictures —
another board may show the same one.

**The diagrams moved here once, and nothing was deleted.** Before Whiteboards each
workspace had a folder of diagrams, `<config dir>/diagrams/<stem>-<hash>/` — the stem
readable, the hash the first ten hex of the whole workspace id's SHA-1 — with its
documents inside it and one `images/` shared by all. `whiteboards.migrate()` brings them
into the store, once. `index.js` starts it inside the single-instance branch, so a second
instance quits without touching the store, and it runs while Electron gets ready:
`whenReady` waits for it before the first window, `activate` waits for it too and opens a
window only when there is none (macOS sends it at launch), and every `sb:wb:*` handler
waits on it. Requiring the module does nothing on disk — `scripts/test-images.js`
requires it with no temp config, and a migration at require time would move the user's
real `~/.switchboard`.

* **Which workspace each old folder was.** The hash cannot be inverted, so it is
  recomputed (`legacyKeyFor`, byte for byte the old `keyFor`) for the folder's own stem,
  then for every workspace discovery finds, then for every one the config declares. A
  folder that matches none keeps its stem and gets no workspace.
* **One folder per project, named after it** and unchanged — `sample-1`'s boards and
  `sample-2`'s both land in `sample` — made only when a board lands in it; one that would
  clash with a folder already there gets a number (`sample 2`). A board name that clashes
  inside the folder gets its workspace: `Name (sample-2)`, then `Name (sample-2) 2`. Each
  board keeps its id and records its old workspace as its own (`workspace`, and
  `migratedFrom: { legacyKey, workspace }`), and every AI box on it that does not say what
  it read is tagged with that workspace (`answeredIn`), so ✦ Answer reads what it read
  before and the boxes say so.
* **Documents and pictures come along.** Each folder's `documents/*.md` is copied into
  the one `documents/`; every picture is hard-linked into `images/` where the disk
  allows, which takes no extra space, and copied where it does not. Every copy goes to
  a temp file beside its target (`<name>.<pid>.<n>.tmp`) and is hard-linked into place
  only when whole — a rename on a disk without hard links, and only while the name is
  free — so a resumed run, which skips every target that exists, never keeps half a file
  and never replaces one that is there (`placeCopy`).
* **It is crash-consistent.** The whole run is one job on the store chain. The folders
  that will receive boards, and the run's record — `migration: { from: 'diagrams',
  at: null, imported: [], folders: { <old folder>: folderId }, skipped, legacyRoot,
  error }` — are written before any board; each old folder's boards are written before
  their ids join `imported`; and the record is marked finished (`at`) only after the old
  tree has been renamed. A run that stops anywhere — a full disk, a crash — leaves `at`
  null, and the next launch, or the screen's **Try again** (`sb:wb:migrate`), picks up
  where it stopped without a second copy of anything: folders are found again by
  `migration.folders`, never by name, and a board already in `boards/` from that same
  old folder counts as imported. Only a failed write to `boards/` or `store.json` stops a
  run. A document or picture that will not copy, and an old file that is not a diagram
  (broken JSON, an id that is not a UUID, a second file with the same id), is counted in
  `skipped` and left where it was. `list()` reports the last failure as
  `migration.error` until a run succeeds.
* **The old tree is renamed, never deleted**: `diagrams` → `diagrams-before-whiteboards`
  (`-2`, `-3` beside an earlier one), recorded as `legacyRoot`. A rename that fails is
  logged and leaves `legacyRoot: 'diagrams'`. `imagePath()` still looks in
  `diagrams/images/` and in `<legacyRoot>/images/` for a picture the copy left behind, so
  no spec's `sbimg://` address ever has to change. A document the copy left behind (one
  that failed, or a run not yet that far) is copied in from
  `diagrams/<old folder>/documents/` or `<legacyRoot>/<old folder>/documents/` the first
  time `getDocument()` is asked for it (`legacyDocumentFile`), and `duplicate()` reads one
  from there too; one in neither place is still `Document file not found`.
* **What the user sees.** A notice on the Whiteboards screen until it is dismissed
  (`notice: { boards, folders, dismissed }`, written when any board moved or any file
  was skipped), the migrated folders marked `moved`, and the recent workspaces seeded
  with the migrated boards' workspaces that are still on the rail, newest edit first,
  the first of them the workspace used last when none is yet; a board keeps its own gone
  workspace, and its ✦ Answer says so. The notice and the error bar name the old tree by
  `migration.legacyLabel`. A store with no old tree only records that the migration ran
  (`from: null`). Once finished, `migrate()` answers `already: true` and touches nothing
  — so a copy of an older Switchboard still writing to `diagrams/` after the move is
  never followed; nothing reads that tree again but the picture fallback.

**The bundle's seam is one board.** `window.SBDiagrams.create(element, props)` makes an
editor for exactly `props.boardId` and never opens another on its own. Props: `boardId`;
`active` (false while off screen, or while another Grid square has the keyboard);
`onOpenSettings`; `onOpenBoard(id)` (the quick switcher, ← / →, New whiteboard and
Duplicate — the host changes the route); `onClosed(folderId, info?)` (after Delete, and
Back on a board that no longer exists or can't be read — `info.missing` true only for one
that is gone, deleted or not found, false for one that merely couldn't be read and may
open again; only `missing` lets the host refuse the board from then on);
`onBoardChange(board, folder)` (after the load and every
write — the host's breadcrumb and status line); `onDirty(count)`;
`onFullscreenChange(open)`; `terminals` (the host's list, `{ wsId, open, minimized,
pinned }[]`); `workspaceStatus` (`{ [wsId]: { dot, branch } }`, the rail's dot and branch,
for pinned terminals' headers and the pickers); and the terminal callbacks
`onOpenTerminal(wsId)`, `onToggleTerminals()`, `onTerminalSlots(slots)`,
`onTerminalFloat(wsId)` and `onTerminalRemoved(wsId, reason, rect)`. The handle has
`update(partial)`, `flush()`, `editAction(action, image, text)`, `fullscreen()`,
`leaveFullscreen()` and `contains(el)`, and `destroy()` — flush, unmount, remove its
body-level portal; nothing reaches the host after it, so a late `onDirty(0)` cannot clear
the flag of a new canvas the host has since made for the same board — `board()`, the
summary as last reported, `pickWorkspace(anchor, opts)` — a light `WorkspacePicker`
under `anchor` and kept inside the window, its choices fetched afresh each time,
resolving the id picked or null — and `pinTerminal`, `unpinTerminal`, `revealTerminal`
and `terminalSlots`, passed through to the editor (false, null or `[]` without one). The
host's picker (`AnchoredPicker`) is never hidden while it is measured — its search box
takes the keyboard as it mounts, which an element under `visibility: hidden` cannot — so
typing and Enter go to it, not to the + or the body behind it. Escape anywhere closes it
and nothing more (a capture-phase listener on the window, before the app's "Esc means
back"); a press outside it closes it; and a press on its anchor — the tray's +, or
Actions — closes it and goes no further, its click swallowed, so the button that opened
it puts it away rather than opening a fresh one (a press dragged off the button leaves
it open). It also closes, unanswered, when `active` turns false and on `destroy()`, and
`pickWorkspace` answers null for a board going away or not in the window: a picker left
open would float over the next screen and open a terminal on a board nobody can see. The
global adds `flush()` (every board, parked ones included), `refreshAnswers(fresh)` and
`blankSpec()`, the empty spec the screen's New whiteboard writes.

`DiagramsPage.tsx` is that one board. It fetches the board first and draws it without
waiting for the folder list. A board that has gone says `This whiteboard no longer
exists`, with Back (`onClosed(…, { missing: true })`); one that cannot be read, `This
whiteboard can't be opened` over main's reason, with Back (`{ missing: false }`) and
**Try again**, which reads it again — as does the board coming back on screen still in
that state — so a file fixed by hand opens without a restart while the host keeps the
canvas. A spec that no longer parses still opens, so Rename, Move, Archive and Delete
stay available on it. Its bar holds the quick switcher (`DiagramPicker.tsx`: the boards
of THIS board's folder, active ones first and archived ones under their own heading, the
trigger reading `name · folder`, ← / → stepping through them), **New whiteboard** (a
name; it lands in this board's folder, its workspace left to main), full screen, and
**Actions** (`data-whiteboard-actions`): **Open terminal…** (a picker: this board's
workspace first, then Recent, then the rest, with search), **Show or hide terminals**
(⌘A), **Rename…**, **Move to folder…** (every folder and No folder, the current one
checked), **Duplicate** (and opens the copy), **Archive** or **Unarchive**, **Delete**.
A dialog an Actions item opens waits until the menu has closed: opened in the same tick,
a modal left `<body>` at `pointer-events: none` and the whole window dead to clicks. An
item picked as the board leaves the screen, or a menu left open then, is marked stale:
its close finishes only once the board is back, and the item is dropped then rather than
greeting the user unasked, focus left where it is; Delete checks again after its flush
that the same board is still on screen. Autosave writes the spec only and Rename the
name only, so neither can carry an old copy of the other over a newer one. The page
refetches the folder list, debounced, on `sb:evt:wbChanged` — not for its own saves, nor
for another board's while it is off screen — and again when `active` turns true, so the
switcher, the breadcrumb's folder and the Move menu stay current.

**A terminal can be pinned to a board.** A `shape: "terminal"` node is a workspace's
terminal made board content — `{ id, label, shape: 'terminal', workspace, size, font?,
minimized?, position }`, its label the workspace id — saved in the board file and undone
and redone like any edit. The node is only a frame (`TerminalNode` in `FlowEditor.tsx`):
a 30-unit header that drags it — the rail's dot, the workspace, its branch, then
**Float**, **Minimize** or **Restore**, and **Close** — over a dark body. The live xterm
is never inside the canvas, whose CSS transform would blur its text and throw xterm's
mouse coordinates off: the host lays it over the body (R15) from the geometry the
editor reports, `onTerminalSlots(TerminalSlot[])` (§2), coalesced to one call a frame
(rAF, with a 50 ms timer behind it, since rAF starves in a hidden window), sent only when
something changed, and `[]` on unmount — and from the page whenever it draws no editor
(an archived, missing or unreadable board). `font` is 12.5 over the zoom the terminal
was pinned at, so pinning keeps its text exactly the size it was on screen; it is drawn
at `font × zoom`, and below 7 px the slot is `live: false` and the body shows **Zoom in
to use**, whose button zooms to `12.5 / font` around it. Minimized, the node folds to its
header where it is. `covered` is worked out against `[data-canvas-overlay]` — the node
toolbar and its menus, the ✦ Answer menu, a workspace picker, the Google Images panel —
and the document panel, so the host hides the xterm while one of them is over it rather
than drawing on top. `holes` are the canvas's own chrome over the body — every React
Flow panel and the zoom controls, cut to it — which the host leaves out of the live
terminal so the chrome stays visible and clickable above it, as above any other node;
a ResizeObserver on those panels (re-attached as they come and go) re-sends the slots
when one changes size, the undo strip growing during an answer included. A workspace
that has left the rail shows `<id> is no longer in the rail`, with Close only — but one
pinned through the host's own picker that the editor's list does not have yet is newer
than that list, not gone: it stays live while main is asked again, and main's answer has
the last word (`terminalGone`); `revealTerminal` asks again too. One node per workspace on
a board: Copy, Paste and Duplicate skip terminals, they take no colour and no text,
✦ Answer's context and Condense leave them out, and every tidy leaves them where they
were put. Nor does a tidy put a box on one — the live terminal over it would hide the box:
going down a freshly laid-out tree (Tab, ✦ Answer's boxes), the first box that would
land on a terminal moves down past it and takes its branch and every box laid out after
it, so the tree keeps its order and spacing and its top never moves (`clearOfTerminals`,
`flow-editor.ts`); and an arrow to or from a terminal ties nothing to it, so a box wired
to one is pushed out of a tree's way like any other. 560 × 340 when pinned with no
size; a hand resize never goes under 280 × 140 (`FLOW_TERMINAL_MIN_SIZE`), but a
terminal pinned at a high zoom keeps the smaller size it was pinned at, its handles
taking that as their least, and only `FLOW_TERMINAL_FLOOR` (96 × 46, a header and a
sliver of body) bounds how it is drawn. A resize is written once its handle is let go;
React Flow ends no resize for a press that changed nothing, so the press's own
`pointerup` (or `pointercancel`) on the window ends `resizing` then. The handle's
`pinTerminal(wsId, rect, body?)` adds one — one undo step; for a workspace already
pinned it reveals that node and answers false, and with no usable rect it answers false.
Given `body`, where the floating panel's terminal sits, the node is fitted round it —
`computeSlots`' body worked backwards, the 30-unit header above it and the 5px inset on
the other three sides — so the slot's body is `body` and the text does not move; else
its outer client rect is `rect`. Its size is rounded UP to whole canvas units (exact at
zoom 1, never smaller elsewhere) and never clamped up to what the handles allow, which
at a high zoom would make the node bigger on screen than the panel it replaces.
`unpinTerminal(wsId)` removes it and answers where it was, and `revealTerminal(wsId)`
opens every collapsed arrow hiding it (`unfoldTo`, one undo step and one layout pass),
pans to it, restores it if minimized and selects it — or answers false, selecting
nothing, when it cannot be brought into view. Any other way a terminal node
leaves the canvas reaches the host as `onTerminalRemoved(wsId, 'undo' | 'delete', rect)`:
`undo` from undo or redo, `delete` from Delete, Cut or the node's Close. An archived
board's read-only canvas draws one as a dark card, `Unarchive to use this terminal`.

**Unsaved edits are flushed, not asked about.** The editor saves 700 ms after the last
change, so a close or a quit usually lands inside that wait. The admin holds the page
with a `beforeunload`, which Electron answers by refusing to close in silence; here the
renderer reports whether any open canvas holds anything (`sb:diagrams:dirty`, 0 or 1
across all of them). Main sends `sb:evt:diagramsFlush`, the renderer writes every board
it holds, parked ones included, and answers `sb:diagrams:flushed`; main then waits for
`whiteboards.settle()`. A close holds while `diagramDirty > 0` and flushes; only a
whiteboard that STILL could not be written joins the "unsaved changes" question. The
quit asks about whiteboards only after its flush, never before — before it, the count is
the autosave in flight.

**The Edit menu reaches the canvas.** ⌘Z, ⇧⌘Z, ⌘V and ⌘A are menu items (§4.7), so the
editor never sees them as keystrokes. ⌘A on a board shows or hides its terminals unless a
text field, menu, dialog or list has the keyboard (R15). For the rest `handleEdit` asks
R15 right after the terminal, and while the canvas has the keyboard — not a box's own
text field, which gets the document's fallback like any field — Undo and Redo are the
editor's, and an image Paste fetches the clipboard's picture and adds it.

#### Google Images

Added 2026-10-04, the user's ask, from an approved mock-up. The image tool on the rail
opens a menu — **Choose a file…** (I, the picker as before) and **Search Google Images**
(G) — and the second docks a 400px panel on the canvas's right (`ImageSearchPanel.tsx`):
the canvas narrows beside it rather than hiding under it. In a window too narrow for both
the panel gives way, not the canvas, which keeps 360px: room for the rail and the menus
beside it, which the canvas clips. Opening the image menu puts the shape tool (and its
menu) away, and picking a tool closes it. Its two choices are buttons the tool shows and
hides, not an ARIA menu, whose arrow keys would be the canvas's; a pick or Escape made
from them hands the keyboard back to the tool. With one box with words selected it
searches that box's label, not its second line; otherwise it reopens the page it showed
last this session, or Google Images' first page. The panel is a `div` with
`role="complementary"`, never an `<aside>`: styles.css styles every aside as the sidebar
(R15, Styles). A guest paints no background, so once the page is ready the `<webview>`
has a browser's white behind it, and not before, so dark mode doesn't flash white.

**It is Google's own page, in a `<webview>`.** No sign-in and no API key: Google's Custom
Search JSON API, the sanctioned way to ask for its results, is closed to new customers and
ends on 2027-01-01, and the page the user would open in a browser needs neither. The
bundle loads two kinds of address — `https://www.google.com/search?udm=2&q=<words>`
(udm=2 is the Images tab) and `https://www.google.com/imghp` — and once there the panel is
a browser: links, Back, another search in Google's own box.

**Main keeps it on a short lead** (`main/images.js`, M12). The main window has
`webviewTag: true` for this alone, and `will-attach-webview` refuses every `<webview>`
whose partition is not exactly `persist:sb-images` or whose `src` is not https on
www.google.com or images.google.com — parsed, so `www.google.com.evil.test` is just
another host. One that passes gets no preload, no Node, context isolation, the sandbox,
web security and no JavaScript dialogs whatever its attributes asked for; the partition
is forced too, since a `webpreferences` attribute can name another. Dialogs are off
(`disableDialogs`) because a guest's `alert()` and `confirm()` are sheets on the main
window, in the page's words, one after another with no way to stop them; measured, with
them off `confirm()` answers false at once. That partition's session sends Chrome's
user agent (Electron's own minus the app's and the `Electron/x` tokens, so Google serves
its real page), refuses every permission request and check, and cancels every download.
A guest's window-open handler denies every popup, and a navigation to anything but
http(s) is prevented. Popups are let THROUGH to that handler (`disablePopups: false`): measured,
without it `window.open` answers null in the guest before the handler is ever asked, and
a result opening "in a new tab" did nothing at all. But Electron then has no popup
blocker — its `CanCreateWindow` ignores the user gesture once popups are allowed, and a
page's `window.open` in a loop reached the handler every time — so the handler sends a
popup to the user's browser (`openExternal()`) only within a second of a click or key in
that page (its `input-event`s), and one per click (`userActivation`), as Chrome would.

**A picture leaves the panel as an address, never a file.** Chromium hands a drag out of
a `<webview>` over as `text/uri-list`, `text/html` and `text/plain`, and never as a File.
So the canvas accepts those kinds on dragover (with a soft blue ring while one is over
it), and on the drop takes the markup's `<img src>`, then the list's first address, then
the plain text (`lib/diagrams/image-search.ts`). Such a drop is ALWAYS
`preventDefault`-ed, picture or not: let through, the window navigates to the address,
and main's `will-navigate` opens it in the browser. The panel's own header and footer
take one let go short of the canvas for the same reason. One `<img>` is not taken at
its word: a `data:` src beside a `srcset` is a lazy loader's placeholder (a 1px GIF, an
empty SVG), and the picture is the srcset's choice — the listed address when it is one
of the srcset's absolute ones (Chromium lists it when the picture is in no link, and
writes the srcset unresolved), else the largest absolute one, else the list as usual.
Google's own thumbnails are `data:` srcs with no srcset and are kept. The markup is
the drag source's to write, so at most 1 MB of it is read, by a pattern that takes time
in proportion to it. **A Google result lands at its own size.** Dragged, one of Google's
results carries its thumbnail (a gstatic picture a couple of hundred pixels across) as
the markup and the result's link, `/imgres?imgurl=<the full picture>&imgrefurl=<its
page>`, as the address — measured on Google's page in this Electron. So the drop tries
that link first and the thumbnail after it (`imageUrlsFromDrop`), and the thumbnail goes
in only when the full picture's host refuses it, is too big or too slow; a right-click
does the same (below). `sb:diagrams:fetchImage` then fetches each address through the
panel's session — its cookies, and the Referer a browser would send when the caller says
which page the picture was on: Add Image to Whiteboard does; a drop cannot, and sends none —
after unwrapping Google's `/imgres?imgurl=` and `/url?url=` / `?q=` wrappers — an
`/imgres` picture goes out with its own page (`imgrefurl`) as the Referer, the one a host
that guards its pictures expects, rather than Google's — and
decodes a base64 `data:image/` URL itself (most thumbnails are those). It allows 20 s
for the download and 25 MB counted as it streams, aborts the request on every way out
before the body is in (an error page included: measured, one that never ends otherwise
keeps streaming, and six hold every connection to that host), and sniffs the type from
the bytes, never the header. PNG, JPEG and WebP come back as they are; GIF, AVIF, HEIC,
BMP and TIFF come back as PNG through macOS's `sips`, because measured, this Electron's
`nativeImage` decodes PNG and JPEG and nothing else, WebP included; anything else is
"That picture's format can't be used here". sips decodes a stranger's bytes in its own
process, unlike a browser, so it runs under `sandbox-exec` (`SIPS_PROFILE`): deny by
default, read anything, write only the picture's temp folder and the user's
(`DARWIN_USER_TEMP_DIR`, which sips writes through whatever `TMPDIR` says), no network,
no other program, and no service but the video decoder and the IOSurface a HEIC or AVIF
needs. A picture's name is the last part of its address's path, or "Image" — for a
`data:` URL, and for Google's `encrypted-tbnN.gstatic.com/images?q=tbn:…` thumbnails.
The bundle makes the bytes a File and hands it to the same `addImages` a dropped file
goes through, so it is saved by `sb:diagrams:saveImage` exactly as one is.

**Right-click is main's menu.** Each guest gets a browser's context menu, built in main
(`attachGuest`): for a picture **Add Image to Whiteboard**, Copy Image, Copy Image Address
and Open Image in Browser; for a link Open Link in Browser and Copy Link Address; Cut,
Copy, Paste and Select All in a field, or Copy for a selection; then Back, Forward and
Reload. Add Image to Whiteboard sends `sb:evt:diagramsImageOffer` `{ guestId, url,
fallback, referrer }` (§4.7) — on a Google result `url` is the result's `/imgres` link
(the full picture) and `fallback` the thumbnail clicked, since the right-click carries
both (`imageOffer`); on any other picture `url` is the picture and `fallback` is `''`.
The panel acts on it only when `guestId` is its own `<webview>`'s `getWebContentsId()`,
and the picture goes in at the middle of the view by the same fetch, the fallback only
if the first fails. Copy Image then ⌘V needs nothing new: the canvas's paste already reads a picture
off the clipboard.

**The Edit menu goes to the panel's page while it has the keyboard.** ⌘C, ⌘V, ⌘X, ⌘A, ⌘Z
and ⇧⌘Z are menu items (§4.7) that would otherwise send `sb:evt:edit` to the main page —
and copy boxes when the user meant Google's search box. `guestEdit()` runs the native
command on the guest instead whenever `images.focusedGuest()` names one: the host's
`focusedFrame` mapped through `webContents.fromFrame()`, a `webview` whose host is the
main window. Not `webContents.getFocusedWebContents()` and not `guest.isFocused()`:
measured, both name the guest whenever one is attached, the page's own input focused or
not, so every ⌘C on the canvas would have gone to the panel. Never while the DevTools
have focus, and never ⌘W. Should an event arrive anyway, the renderer stands aside too:
the bundle's `editAction` and app.js's document fallback both decline while a `WEBVIEW`
is the active element.

**Leaving the board kills the page, so coming back makes a new one.** app.js takes the
board's root out of `#main` while another screen shows (R15), and Electron destroys
a `<webview>`'s guest as it leaves the document and never makes another when it is put
back: measured in 44.4.2, the element stays blank and every method answers "Invalid
guestInstanceId". So the editor hears `active` (as `shown`), and the panel keys a fresh
`<webview>` as the board returns, at the last page it showed. That page is kept at module
scope, and only when main would let the panel start on it (`opensInPanel`), since a site
followed out of the results would be refused at the attach. The page's history is lost;
the page is not.

Google may answer a new session with its "unusual traffic" page; solved once, its cookie
stays in the partition (`Partitions/sb-images` in Electron's Application Support folder).
`npm run test:diagrams` covers both halves' pure parts (`scripts/test-images.js`,
`scripts/test-image-search.js`), checks the bundle's partition and start rule against
main's own, and runs `fetchImage` itself, with Node's fetch standing in for the session.

### 4.18 ✦ Answer and Settings

Condense uses the same provider and request lifecycle, with `operation: 'condense'`
on `sb.answerStart`. Main validates this operation and disables web access regardless
of saved Answer settings. Claude Code receives no built-in tools; Codex keeps its
read-only sandbox with web search disabled. Every provider is instructed to condense
only the supplied discussion, without researching new facts. A condensation reads no
file, so it never needs a workspace: a CLI condenses in the board's workspace folder
when it has one, and in the system's temp folder when it has none or that one has left
the rail.

✦ Answer, on a whiteboard, puts a box's question to an AI and hangs the answer off it
as one box per part — six repos are six boxes; the admin's cap of four is gone here (40 is
only a backstop against a runaway list). The admin asks one OpenAI model; here it is any
of four, chosen per Mac — the user has Claude Code on one laptop and Codex on another:

| provider | what it is | sees |
|---|---|---|
| `claude-code` | `claude -p` in the board's workspace folder, `--tools Read,Grep,Glob` (plus `WebFetch,WebSearch` with Web access) and nothing else, `--permission-mode dontAsk`, prompt on stdin, `--json-schema` for the answer, `--output-format stream-json` for the steps | the code of the board's workspace |
| `codex` | `codex exec --json --sandbox read-only -c web_search="live"\|"disabled" --cd <folder> --output-schema … --output-last-message …` | the code of the board's workspace |
| `claude-api` | the Messages API, the answer as structured output (`output_config.format`, the schema) — not a forced tool call, which Opus 5.5, Sonnet 5.5 and Fable 5.1 refuse with a 400 — plus `web_search_20250305` / `web_fetch_20250910` with Web access, a paused turn (`pause_turn`) sent back to carry on | only the whiteboard |
| `openai-api` | the Responses API with the admin's json_schema format, streamed, the admin's models and probed efforts, plus `{type:'web_search'}` with Web access | only the whiteboard |

A CLI is slower — it opens and searches files first — and knows the code; an API answers
in seconds, much as the admin's ✦ Answer does. The user rejected sending an API any part
of the workspace: "the API options will be very limited." The prompt and the answer's
JSON shape are the admin's either way (`lib/diagrams/ai.ts`, mirrored by hand), with
Switchboard's changes marked "Switchboard:" — no cap of four, the Subtext variant of the
prompt, link stripping — so re-copying the admin's file would undo them; a CLI is
also told it is in the workspace, that it can only read, and — with Subtext on — to name
the file in a box's second line when the answer came from code (`lib/diagrams/answer.ts`).

**Subtext** (off by default) is that second line: off, the prompt asks for none and the
bundle drops whatever the model wrote there anyway. **Web access** (on by default) gives
whoever answers its own web tools — a page a box links to, or a search — and main adds a
line to the system prompt saying so, and to use them only when the question needs
something the diagram (and the code) can't tell it — the prompts still say diagram,
which is the model's word, not the user's; off, the tools are left out
altogether (for Claude Code, out of `--tools`: dontAsk would still let WebFetch open the
documentation sites Claude Code trusts) and the prompt says to admit a page it can't see
rather than guess. Codex's own default is a cached search, so off says `"disabled"`
outright. Should the Claude API ever refuse web search's always-on citations beside a
structured answer (a 400 naming citations), the answer goes again with web fetch alone. Links a model leaves in a box anyway are taken out (`ai.ts` `unlinked`).

**main owns all of it**: which providers exist, which models and efforts each takes,
whether each CLI is installed and signed in (`claude --version` / `auth status`, `codex
--version` / `login status`, cached a minute), the stored choice (config.json's `answer`
block), and the keys. The page names a provider and the board's workspace; main resolves
the folder itself, with `answer.resolveAnswerDir(req, workspaces.lookup)` — the rail's
own list, never `workspaces.dirOf`, which would take an absolute path — so a CLI never
runs in a path the page handed over; an API provider gets no folder and no lookup. Main
reads the model and effort from the stored settings, never from the request.

| `window.sb` | channel | returns |
|---|---|---|
| `sb.answerStatus({fresh})` | `sb:answer:status` | `{ ok, settings, providers, keysSafe }` — `settings.provider` is never null: with nothing chosen it is the first one ready (a CLI that is here, then an API with a key). `fresh` looks for the CLIs again |
| `sb.answerSetSettings(patch)` | `sb:answer:setSettings` | the status, after merging `{ provider, split, context, web, subtext, claudeCodeEffort, claudeApiModel, openaiModel, openaiEffort }` |
| `sb.answerSetKey(provider, key)` | `sb:answer:setKey` | the status — after the provider accepted the key (`GET /v1/models`); a refused key is never stored and answers `{ ok:false, error, code:'bad-key' }` |
| `sb.answerRemoveKey(provider)` | `sb:answer:removeKey` | the status |
| `sb.answerStart(id, req)` | `sb:answer:start` | `{ ok, text, files? }` — the answer's JSON, which the bundle reads into boxes — or `{ ok:false, error, code }`, `code` one of `missing`, `signed-out`, `no-key`, `bad-key`, `timeout`, `stopped`, `no-workspace`. `req`: `{ provider, wsId, system, user, schema, operation? }` — `wsId` is the board's workspace, or null; `operation: 'condense'` for ✦ Condense |
| `sb.answerStop(id)` | `sb:answer:stop` | `{ ok }` — the CLI's whole process group, or the request |

`sb:evt:answerStep` carries `(id, { kind, text, target })` for every tool call a CLI
makes — "Reading lib/diagrams/ai.ts", "Opening example.com/docs" — which the canvas shows
in a card over its strip, so a minute's wait never looks stuck. The OpenAI API reports its
finished web searches the same way, and gets the card once it has one. `sb:evt:answerStatus` goes out after every change,
wherever it was made, so the ✦ Answer menu and the Settings screen never disagree.

**Which workspace a CLI reads is the board's** (2026-10-08, with Whiteboards). A
whiteboard belongs to no workspace, so each board names one (`workspace`, §4.17), and the
who-answers menu under ✦ Answer's chevron (`AiSettingsMenu`) has one row for it, headed
**Workspace**, under the providers: the id (or `None chosen`), its folder and `what a CLI
reads`, and **Change…**, which opens a short `WorkspacePicker` beside the menu — over its
right column when there is no room, or when the menu is cut short and scrolls, then kept
inside the menu's own box so focusing its search never scrolls the menu sideways; the
panel is placed (`keepInCanvas`, once, `data-placed`) before the picker measures it, as
Choose workspace… opens both at once — with the board's workspace first, then Recent, then
the rest, and a search box that has the keyboard: never every workspace inline. Escape
closes the picker first, then the menu. A pick is `whiteboardsSetWorkspace`, and the
picker's footer says what it does: `Applies to the next answers on this whiteboard.
Boxes already answered keep their tag.` With an API selected the row is dimmed and reads
`Claude API and OpenAI API see only the whiteboard`; while condensing it is not there.
Each provider's line says what it would do — a CLI `Reads sample-2 first, then answers`
(or `Pick a workspace to read`), an API `<model> · sees only the whiteboard · fast` — and
the menu's footer `A box for each part an answer has. Workspace is kept with this
whiteboard; the rest on this Mac.`

The workspace is taken when the box asks, not when the answer lands, and every box the
answer adds carries it as `answeredIn`: the small tag hanging under the box's corner (a
dashed one on the placeholder while the answer is awaited). It belongs to the AI's
words — kept while `ai` is true, gone once the box's text is edited, carried wherever
`ai` is carried — and an API's answer has none, having read no workspace. An invalid one
is dropped, never a parse failure. The Whiteboards list's `reads` is made from these
tags.

A CLI with no workspace to read is stopped before anything is asked: the editor's
`notReady` answers `no-workspace` (`Pick a workspace for Claude Code to read`), and main
answers the same code for any ask that gets through (`Pick a workspace for ✦ Answer to
read`, or `could not find the folder for <id>` for an id the rail does not have). The
failure line under the strip offers **Choose workspace…**, which selects the box that
asked and opens the who-answers menu with the picker already showing — or the picker
over the strip, for a box that is gone, folded away, being answered or in a condense on
its way, whose toolbar has no menu to take it. Each request is numbered, and one that no
menu takes within a second of when it was due lapses, so selecting the box minutes later
never opens the menu by itself. A workspace that has left the rail is the same
case: the row shows it with `No longer in the rail — choose another`, its provider line
says `<id> is no longer in the rail`, and nothing is sent. The failure line's Open
Terminal opens a terminal floating over the board, in the workspace the answer was to
read. A CLI ask whose workspace resolved makes that the workspace used last and puts it
first in the recent ones (`whiteboards.noteWorkspace(wsId, { last: true })`, not
awaited), so the next new board starts with it.

**Keys never touch config.json.** `safeStorage` (the Keychain) encrypts them into
`<config dir>/keys.json` (mode 0600) beside the last four characters, which are all the
page ever gets back. Nothing logs a key; the Settings field is always empty.

**A CLI never outlives what asked it.** It is spawned detached, so Stop, the 5-minute
limit, the window closing and `stopEverything()` all signal its whole process group, the
ripgrep and shells it runs included.

**Settings** is a free screen (`{view:'settings'}`, R16): App ▸ Settings… (⌘,),
the rail's last row under Usage, and the ✦ Answer menu's "Settings…". It is not
remembered as the screen to reopen on — it is visited, not worked in.

### 4.7 Push events (main → renderer)
`preload.js` exposes subscribe helpers returning an unsubscribe function:

```js
sb.onLog((wsId, chunk, procName) => {})  // 'sb:evt:log' — pty output, tagged with its process
sb.onRunState((state /*RunState*/) => {})  // 'sb:evt:run'
sb.onLinks((wsId, links /*Link[]*/) => {}) // 'sb:evt:links' — as ports come up
sb.onFocus((opt) => {})              // 'sb:evt:focus' — refresh now; {fetch:true} from ⌘R
sb.onTermData((wsId, chunk) => {})   // 'sb:evt:term' — shell output
sb.onTermState((state /*Shell*/) => {})  // 'sb:evt:termState' — spawned, exited
sb.onEdit((e) => {})                 // 'sb:evt:edit' — {action:'copy'|'paste'|'selectAll'|'undo'|'redo'|'cut'|'close', text?, image?}
sb.onAppearance((s) => {})           // 'sb:evt:appearance' — {appearance, effective}; see §4.8
sb.onSidebar((s) => {})              // 'sb:evt:sidebar' — {visible}; see §4.9
sb.onDiagramsFlush((id) => {})       // 'sb:evt:diagramsFlush' — save every board's pending edits,
                                     // answer sb:diagrams:flushed with the same `id`; §4.17
sb.onWhiteboardsChanged((change) => {}) // 'sb:evt:wbChanged' — {reason, boardId?, folderId?} after
                                     // every write to the whiteboards store; §4.17, R2
sb.onAnswerStep((id, step) => {})    // 'sb:evt:answerStep' — what a CLI answering a box is doing; §4.18
sb.onAnswerStatus((status) => {})    // 'sb:evt:answerStatus' — who can answer, after any change; §4.18
sb.onOpenSettings(() => {})          // 'sb:evt:openSettings' — App ▸ Settings… (⌘,)
sb.onDiagramsImageOffer((offer) => {}) // 'sb:evt:diagramsImageOffer' — {guestId, url, fallback, referrer}:
                                     // Add Image to Whiteboard, in the Google Images panel; §4.17
```

`sb:evt:edit` exists because a menu accelerator wins over the renderer's keydown, and
xterm's selection is **not** a DOM selection, so `role: 'copy'` copies nothing from the
terminal. The Edit menu's Copy / Paste / Select All are therefore custom items that send
this event. The renderer gives Select All first to a whiteboard on screen, where ⌘A shows
or hides its terminals unless a text field, menu, dialog or list has the keyboard (R15);
then first refusal to the focused terminal, then to the whiteboard's canvas (R15) and the
Editor (R13), and only then falls back to the document: its own
selection for Copy, `execCommand` for Select All, Undo and Redo, and — for a focused text
field, the Grid's name field — the field's selection for Cut and `insertText` for Paste,
since the menu's ⌘V never lets the keystroke reach it. A Paste with `image: true` (below) is the one
exception: if the terminal declines it, nothing else is offered it.

**Undo, Redo and Cut became items too, and File ▸ Close with them** (added 2026-09-26,
with the Editor). Measured with Monaco 0.57 in this Electron 44: the native `undo` /
`redo` roles run Chromium's editing command on the focused element, and Monaco ignores
it — with its default EditContext nothing happens at all, and with its textarea it undoes
one character of the hidden textarea rather than anything on Monaco's own undo stack —
while the accelerator, winning over keydown as always, means Monaco never sees ⌘Z to do
it itself. So ⌘Z / ⇧⌘Z / ⌘X send `{action:'undo'|'redo'|'cut'}` and the Editor runs its
own commands; Cut goes the same way so its copy half takes Copy's path through main
(below) and its delete half is one edit on Monaco's undo stack. ⌘W was `role: 'close'`,
and Sublime's muscle memory — ⌘W closes the file — closed the whole window; it now sends
`{action:'close'}`, the Editor closes its active tab, and anywhere else the renderer
answers with `sb.closeWindow()` (§4.14), which is the old behaviour exactly. While the
DevTools have focus all four call the native method on the DevTools' own contents
instead (`undo()`, `redo()`, `cut()`, `closeDevTools()`), so the DevTools keep their Undo
and ⌘W. And while the key window is no BrowserWindow at all — the About panel — ⌘W is
`Menu.sendActionToFirstResponder('performClose:')`, the role's own action, and no event
is sent: it closes the panel, not a tab or the window behind it (§4.14). That test comes
after the DevTools' and before the crashed page's, and a smoke run skips it — its
window is never shown, so never key, and `SB_SMOKE_MENU='File>Close'` must still reach
the page. And while a whiteboard's Google Images panel has the keyboard, every Edit
item but Close runs natively on the panel's page instead, after the DevTools' test
(`guestEdit()`, §4.17).

**Both directions of the clipboard belong to main**, and this is not a preference:
* Chromium refuses `document.execCommand('copy')` outside a user gesture, and an IPC
  event is not one. It fails *silently* — verified with a 337-character diff selection
  and an untouched clipboard — so every copy goes to `sb:clipboard:write`.
* `clipboard.readText()` in this Electron is **async**: the module exposes the six-method
  web API (`clear/has/read/readText/write/writeText`), not the old synchronous one.
  Sending its return value straight through put a `Promise` in the IPC payload, which
  cannot be structured-cloned, so `webContents.send` threw inside the menu callback and
  Paste did nothing at all while Copy and Select All worked. Await it, and never send a
  non-string.
* Reading the clipboard in main also keeps the renderer from needing clipboard-read
  permission, and writing there works when the window is not focused — which is exactly
  the case for a `/copy` finishing in a workspace the user is not looking at.
* ⌘V with an image on the clipboard and no text (a screenshot copied with ⌃⇧⌘4, an
  image copied from a browser): `readText()` answers `''`, and the Paste item then reads
  the clipboard's `image/png` (`clipboard.has` / `read` / `getType`, all async), writes
  it under `$TMPDIR/switchboard-pastes/` via `main/drops.js` and sends that file's
  escaped path as `text` — the same text a Finder drop of the image would have typed,
  and so the same route into Claude Code. Without it the accelerator swallowed ⌘V and
  the terminal never saw the keystroke. That payload carries `image: true` (plain text
  never does), because the path is for a terminal alone: typed into a source file, the
  Editor's ⌘P and ⇧⌘F fields or the Grid's name field it is junk, so `handleEdit` (R2)
  returns after the terminal's refusal instead of offering it to the Editor or the
  document. The PNG is still written on every such ⌘V, wherever focus is; the paste
  folder is pruned after a day.

### 4.8 Terminal appearance

`appearance` is the user's choice — `'light' | 'dark' | 'system'`, persisted at
`config.terminal.appearance` and set from **View ▸ Terminal appearance**. `effective` is
that choice resolved against `nativeTheme.shouldUseDarkColors`, so it is only ever
`'light'` or `'dark'`, and it is the one anything paints with. `nativeTheme`'s `updated`
event re-resolves it, but only while the choice is `'system'`.

Light is the default, and deliberately not `'system'`: the rest of the app is light-only
(`color-scheme: light`, window `#ffffff`), so following a Mac in Dark Mode would leave a
single dark slab in an otherwise white window — the thing this setting exists to fix.

The choice has three consumers and they need it at different moments:

* **The renderer**, immediately. `term-theme.js` rewrites the `:root` colour tokens and
  assigns the new palette to every live `Terminal.options.theme`. xterm registers
  `onSpecificOptionChange('theme')`, so a pane repaints in place — no rebuild, which
  matters because rebuilding would throw away the scrollback, the keyboard focus and a
  half-painted TUI's frame. Measured after a toggle: the shell's `startedAt` is unchanged,
  the text on screen is the text that was there before, and focus is still in the pane.
* **The Editor**, at the same moment and the same way (added 2026-09-26). Its slab is the
  other thing in the window that follows the appearance: `views/editor.js` registers one
  `SB.termTheme.onChange` listener at load and switches Monaco between its two themes,
  `sb-dark` and `sb-light`, built from the same palette, with `monaco.editor.setTheme` —
  global to every editor, repainted in place, never a render, so the buffers, the undo
  stack, the cursor and focus all stay. The slab's own chrome (tree, tabs, status line)
  follows `data-term-theme` through its `--ed-*` tokens. The menu item keeps its name;
  it now governs the Logs panes and the Editor as well as the Terminal.
* **`shell.js`**, *before* it spawns. A shell's environment is fixed at fork, so
  `COLORFGBG` (`0;15` light, `15;0` dark) can only ever be set for the NEXT shell. A
  running shell keeps the old value on purpose rather than being restarted under the user.

`COLORFGBG` is not belt-and-braces. xterm.js *does* answer the OSC 11 background query
from the live theme — measured: light replies `ESC ] 11 ; rgb:f7f7/f7f7/f9f9 ST`, dark
replies `rgb:1c1c/1c1c/1e1e` — and that path stays true for the life of a pane. But a
program has to know to *ask*, and the ones that do gate it on a short list of terminal
names which cannot include this one. Claude Code is the case in point: it reads
`COLORFGBG`, and on `theme: auto` this is what stops it picking its dark theme on a white
pane. (On an explicit `"theme": "light"` — the common case — none of this is consulted and
the pane's background is the whole story, which is why this feature exists.)

### 4.9 Sidebar

| `window.sb` | channel | returns |
|---|---|---|
| `sb.sidebar()` | `sb:ui:sidebar` | `{ visible }` — asked once at boot |
| `sb.setSidebar(visible)` | `sb:ui:setSidebar` | `{ visible }` — persists, broadcasts, rebuilds the menu |

Hiding the rail is a **layout** change, not a render: nothing in the view tree reads it,
so it is one class (`.norail`) on `.win` and the stylesheet does the rest. That is what
makes it free of the usual cost — no view is rebuilt, so the terminal's scrollback, its
focus and any selection all survive it, and the shell never notices.

Main owns the stored value for one reason: the View item has to read **Hide Sidebar** or
**Show Sidebar**, and the menu is main's. `⌃⌘S` is macOS's own accelerator for it. The
renderer applies the class the moment its own button is clicked and tells main after, so
a click never waits on IPC; the `sb:evt:sidebar` that comes back lands on the state the
window is already in and does nothing.

Three things the layout has to get right, all of them measured:

* **The rail leaves on a negative `margin-left`, not a width.** Its content keeps its
  220px and slides out whole. Animating the width instead reflows every row on the way,
  and the labels squash against the edge rather than leaving with the panel.
* **The traffic lights.** They are the OS's, painted at `{x:18, y:18}` — 12px each, 8px
  apart, so they end at x=70, y=30. With the rail gone they sit over the main column, so
  it grows a 30px inset (its header's own 26px makes up the 56px the rail's first row
  starts at) and the button moves to x=82. A `.drag` strip covers that band so the window
  can still be dragged by it — and it is `display:none` while the rail is open, where it
  would otherwise cover the top third of the Start button and swallow its clicks.
* **`SB.layout.busy()`.** The slide fires the terminals' `ResizeObserver` on every frame
  of itself. `views/terminal.js` and `views/logs.js` ask this before every fit and hold;
  `app.js` calls their `relayout()` once when it is over. Measured on a 1100px window
  with a live shell: the gate gives **one** reflow, 753px → 971px. Without it, seven —
  seven pty resizes and seven SIGWINCHs into a TUI that is redrawing between each one.

One thing the rail is the only place for: a background workspace's bell. With it closed
the button carries the blue dot instead, so hiding the rail does not silently drop the
signal it exists for.

**The Editor's full screen** (added 2026-09-26, the user's ask: a button in the editor's
top-right corner "to open the editor up, like full screen"). The button hides the rail
AND the header so the editor fills the window; the same button, or Esc, brings them
back. It is the same kind of change as hiding the rail — one class, `.edfull`, on
`.win`, and the stylesheet does the rest, so nothing is rendered and the editor's
buffers, cursor and focus survive it — but it is **not** `.norail`: that class is the
user's stored choice and owns the View menu's label, and a full screen is neither
persisted nor the menu's business; leaving it must put back exactly the rail the user
had, open or closed. `app.js` owns the class next to `.norail` and exports
`SB.layout.full()` / `SB.layout.setFull(on)` for `views/editor.js`, whose button and Esc
are the only callers.

* **The rail slides out** exactly as `.norail`'s does (same margin, same delayed
  `visibility`, same reduced-motion and `noanim` exits); `.edview > .hd` goes, and the
  slab loses its margin and radius to meet the window's edges.
* **The traffic lights and the drag region move into the editor.** With the rail and
  the header both gone the lights sit over the slab's top-left and the window has no
  drag region left, so the slab grows a `--titlebar` band (`.edband`) — draggable, with
  a 78px spacer for the lights (x 18–70), the workspace and its branch, and at its right
  the exit button, `no-drag` — and `main` drops the 30px `.norail` inset, the band being
  the inset now. The buttons are INSIDE the band, so walking the document in order adds
  the band's drag region before their holes are subtracted — the order §6 R1 insists
  on. The `.drag` strip and `#rail` are `display:none` meanwhile: the strip comes after
  `main` in the document, so shown it would cover the band's buttons and turn their
  clicks into window drags. The tab strip's own button hides too, so there is exactly
  one toggle, top right.
* **The app's notice moves to the foot.** `applyNotice` still puts its `.bar` first in
  `.edbd`, which in full screen put it at y=0 under the traffic lights, above the band
  — pushing the one drag region left down the window. `.win.edfull .edbd > .bar` takes
  `order:1`, no margin and no radius, so it paints as a strip below the slab and the
  band stays at the top. `order` moves only the paint: `applyNotice`'s "never two bars"
  test reads the DOM's first child and is untouched.
* **It belongs to the Editor on screen.** `renderMain()` drops it the moment the route is
  anything else — ⌘1–9 and ⌘0 still work with the rail gone, and `back()` never passes
  through `go()` — and snaps the rail back rather than sliding it, under `noanim`: the
  screen arrived at may hold a terminal (a Terminal tab, the Grid's four), and a slide
  would fire their `ResizeObserver`s on every frame with no `busy()` to hold them. ⌃⌘S
  while full screen leaves it and then applies the rail choice, so the keystroke
  visibly does something. `busy()` is otherwise untouched: no terminal is on screen
  while the Editor is, and Monaco's `automaticLayout` follows the slide for free; its
  `relayout()` runs once when the slide is over.
* **The bell is not dropped.** The band carries a blue dot (`.edbell`, "a terminal in
  another workspace rang") while another workspace's shell has rung, computed on the
  render a bell already schedules.

### 4.10 Grid

The Grid is the row above the workspace groups in the rail (`⌘0`): four workspace panes
side by side, in **views** the user makes — "Sample" is sample-1…4 in the four squares,
"Everything else" is what is left. It is the two iTerm2 windows of four panes each that
the Terminal tab replaced one at a time, brought back as one screen. Route `{view:'grid'}`,
and it is the one route with no `wsId`.

| `window.sb` | channel | returns |
|---|---|---|
| `sb.gridViews()` | `sb:grid:list` | `{ views: GridView[] }` — asked once at boot |
| `sb.saveGridViews(views)` | `sb:grid:save` | `{ views }` — what main kept after cleaning |
| `sb.chooseFolder()` | `sb:dialog:folder` | `{ ok, dir }` — the system's folder sheet on the window (`openDirectory`, `createDirectory`, opening on the root); `{ ok:false, canceled:true }` when dismissed, which is not an error. A smoke run never shows a sheet: `SB_SMOKE_FOLDER=<path>` is the choice there, and without it the answer is a cancel |

Main is the store and nothing more: it keeps only the `GridView` shape (four cells, no
workspace twice in one view, at most 20 views) and writes `config.grid.views`. A cell
naming a workspace that no longer exists is **kept**; the renderer shows the square as
gone with a Clear button, which beats a view silently losing a square when a folder is
renamed. Which view the Grid is showing, and whether the window was last on the Grid at
all, live in `localStorage` the way the last workspace does.

**A square may hold a folder instead of a workspace** (added 2026-09-20, the user's ask:
a terminal need not belong to a workspace). The picker's first group, `Folder`, offers
`Choose a folder…`, which raises the system's own folder sheet through
`sb.chooseFolder()`; the chosen folder's absolute path goes into the cell as its id —
the root itself, a repo outside it, any folder on the Mac. A folder square is a terminal
and nothing more: it is on no rail, has no workspace screen, is never scanned and never
started. Its path is its id everywhere a workspace id goes — the pane, the shell, the
tmux session, the bell — so nothing beyond `views/grid.js` (the strip: the folder's name,
the path as tooltip, no dot, no jump) and `shell.js` (opens in the path itself; M6 names
the session) has to tell the two apart. Choosing the folder a workspace already lives in
puts that workspace in the square, not a second shell in its folder under another name.
A folder that has since gone shows the shell's own sentence with Try again, and Edit
takes it out.

**A workspace square shows Terminal, Changes, or a whiteboard.** The three mode buttons
live in its 30px header. Changes uses the workspace page's repository summary and shows
compact green addition and red deletion counts in its button. **Show a whiteboard**
(`data-grid-mode="whiteboard"`) shows any board — a square is no longer limited to its
workspace's — and the board's live canvas is the very one its own screen shows, moved
into the square (`SB.views.whiteboards.mountGrid`), with its quick switcher, full-screen
control and terminals. With no board chosen yet the square is a picker with a search
box: the boards whose workspace is the square's first, then Recent, then each folder,
then No folder, each board once; archived boards and boards another square of this view
already shows are left out, since one board is one canvas and cannot be in two squares.
A chevron beside the mode buttons (**Change whiteboard**) picks again. A board switched
from inside its square (its switcher, ← / →, New whiteboard, Duplicate) keeps the
keyboard there; Back on one that can't be read sends its square back to choosing with
the board still offered, and Delete or one that has gone, without it (R10). The chosen
mode is stored per workspace in localStorage (`switchboard.grid.cellMode`) and follows
it across Grid views; the chosen board likewise (`switchboard.grid.cellBoard`), keyed by
the square's workspace. `GridView` is untouched. A square saved as `diagrams` — its
workspace's Diagrams tab, before Whiteboards — reads as a whiteboard square and takes
that workspace's most recently edited board. Older saved Notes choices are ignored;
those squares start on Terminal. Folder squares remain Terminal-only.

`views/terminal.js` keeps one xterm and one shell per workspace. `mount(wsId, into)`
moves that same host into a route's screen — a Grid square or the workspace's own
Terminal tab — and takes it unconditionally, as the only screen on show; nothing is
duplicated and nothing restarts when a square changes mode. Measured: the host element
in the square is the host element on the Terminal tab, the marker typed in one is in the
other, and the shell's `startedAt` is unchanged across the round trip. A whiteboard's
terminals take the same host with `place()`, which yields to whoever has it (R8): a
board in one square and a Terminal square for the same workspace are on screen together,
and two hosts that both took it on every render would bounce it between them. Taking a
workspace out of a square — only from the `⋯`'s Edit, R10 — leaves its shell running.

Three rules in `app.js` follow from that:

* `retirePanes()` keeps a workspace shell for any square in the current view, including
  one showing Changes or a whiteboard, and for any terminal a whiteboard on screen is
  showing (`SB.views.whiteboards.terminalShown`). It walks the folder ids main's shell
  states carry as well as the rail's workspaces, so a folder square's pane is retired
  like any other once its shell has exited and it has left its square.
* A bell is read only while that workspace's Terminal is visible: `bell()` ignores
  a Terminal-mode Grid square and `renderMain()` clears its bell, as on the workspace's
  Terminal tab. Changes and whiteboard squares keep unread bells until Terminal is shown.
  A whiteboard's terminals are read only while the keyboard is in one
  (`SB.views.whiteboards.terminalFocused`): several can be open over a board at once,
  and the blue dot on a panel that is merely open is how the user learns which of them
  Claude has finished in.
* `SB.grid` — `create / rename / move / remove / select / assign` — is the only writer of
  `state.grid`. Every change is applied first and written after, so a click never waits
  on the round trip, and whatever main kept replaces the list when it answers.
  `move(id, to)` puts a view at index `to` of the row; the order of `config.grid.views`
  IS the order of the segments, so there is nothing else to store. Only the answer to
  the LAST save is adopted: two changes a moment apart (a name typed, then a `‹`) are
  two saves, and the first one's answer is the list as it was before the second change.

The layout is CSS: `.grid` is `1fr 1fr` by `1fr 1fr` and fills the body; below 860px of
body width (a container query) it is one column of fixed-height rows and the page
scrolls. Fixed, not auto: an auto row takes its height from the terminal and the terminal
its rows from the height, and the pair settle wherever xterm's default 24 rows put them.

### 4.11 Claude usage

The three bars claude.ai's "Your usage" page shows — the five-hour session, the week,
and any per-model week — in the app: a gauge in the Grid's header for the session, and a
Usage screen for all of them behind the row pinned to the bottom of the rail. Route
`{view:'usage'}`; like the Grid it carries no `wsId`, and it shows with no workspaces at
all, being about this Mac's Claude sign-in rather than any folder.

The row, gauge and Usage content are hidden until a local Claude OAuth credential
is found (`configured: true`). Missing credentials return `configured: false` and
`reason: 'no-login'` without a network request. That clears cached numbers, hides
the row and gauge, and sends an active or restored Usage route to the Grid. While
the initial check is pending, a restored Usage route displays the Grid. Configured
accounts retain Usage and its error messages on expired sign-ins or network failures.

| `window.sb` | channel | returns |
|---|---|---|
| `sb.usage()` | `sb:usage:get` | `Usage` — the last answer, or the one in flight; asked once at boot |
| `sb.refreshUsage()` | `sb:usage:refresh` | `Usage` — asks Anthropic again now (the screen's ↻, its Try again, and ⌘R there) |
| `sb.onUsage(cb)` | `sb:evt:usage` | every answer: every 5 min, on a window focus when the last is over 60s old, and on the manual refresh |

There is no CLI for this — `claude` has no usage subcommand, and `/usage` is a screen
inside its TUI — so `usage.js` does what that screen does: it reads the OAuth token
Claude Code keeps in the macOS keychain (`Claude Code-credentials`, written by
`/usr/bin/security` and so readable by it without a prompt; `~/.claude/.credentials.json`
is the fallback) and asks `api.anthropic.com/api/oauth/usage` with it. **The token is a
credential.** It is read per request, sent to that one host, and never logged, never in
an IPC payload, never written anywhere. Nothing refreshes it — Claude Code rotates its
own, and a second refresher racing it would invalidate the session the user is typing
into — so an expired token is a sentence (`reason: 'expired'`) and the next poll simply
tries again, by which time Claude Code has renewed it. Every failure is an `{ ok:false }`
Usage with a sentence; the handlers never reject.

The answer's `limits[]` (kind `session` / `weekly_all` / `weekly_scoped`, the last with a
`scope.model.display_name` such as "Fable") is the shape read; `five_hour` / `seven_day`
/ `seven_day_<model>` are the older windows and the fallback when it is missing.
Anthropic's `severity` is kept when it says one; otherwise red from 90 and amber from 75,
which is where claude.ai's own page turns.

The endpoint is shared with every Claude Code the user is running — each polls it for
its own status line — so the app is deliberately gentle: 5-minute automatic polls, a
fetch on window focus only when the last is over 60s old, and the manual ↻. A failure
sets an exponential cooldown (a 429 backs off from 5 min doubling to 30; a network blip
from 1 min) during which the timer and focus hold off; the manual ↻ ignores the cooldown
because it is a person asking. A transient failure **never replaces the numbers already on
screen**: `state.usage` is only ever the last good answer, a failure sets `usageError`
beside it, and the gauge, the rail's dot and the screen's rows all keep showing the last
good data with a quiet "couldn't refresh" note. The full-screen sentence is only for a
configured account that has never had an answer at all. This is the whole fix for
"why do I keep seeing this" — a passing rate-limit used to blank everything.

**A poll landing must not cost a render.** `app.js` keeps a signature of what is
visible — the plan, and each limit's percent, severity and reset — and when a poll
changes nothing it does nothing. When one does, the rail's row and the Grid's gauge are
rewritten in place (`views/usage.js` `refresh()`), and only the Usage screen itself is
rebuilt, being the one screen with no terminal on it: a render of the Grid for a bar
that moved two percent would re-parent four live shells and drop whichever one had
focus. A gauge appearing takes a render, and `refresh()` says so by answering `false`.
Removing a gauge after sign-out happens in place, preserving the live terminals.
Measured: after an answer that moved the bar, the Grid's `.grid` element is the one that
was there before, and the gauge that had focus still has it.

`SB_USAGE_FIXTURE=<a.json>[,<b.json>…]` stands in for the network in a smoke run — each
poll reads the next file, the last one repeats; a file may add `_credential` for the
plan name, `_status` (with `_expired`) to play a bad answer, or `_nologin` — and
`SB_USAGE_INTERVAL=<ms>` sets the poll. Neither is read outside those variables.

---

### 4.19 Databases (`sb:db:*`)

The Databases workspace tab browses named Neon/PostgreSQL and MongoDB connections.
The approved screen is a connection picker, an entity picker, Refresh, Add connection,
and one records table. Selecting an entity fetches its records automatically. A row
opens a drawer with all fields, including nested objects and arrays. There is no query
editor or database write action.

The service is `createDatabases({ directory, resolveWorkspace, safeStorage, drivers? })`
in `src/main/databases.js`. Main supplies a `databases/` directory beside
`config.CONFIG_FILE`, a workspace lookup, and Electron's safeStorage. The injectable
`drivers` are for fictional test fixtures. Renderer calls are:

| Bridge | IPC | Result |
| --- | --- | --- |
| `databaseList(wsId)` | `sb:db:list` | `{ ok, connections, keysSafe }` |
| `databaseAdd(wsId, { name, provider, uri })` | `sb:db:add` | `{ ok, connection, connections }` |
| `databaseRemove(wsId, connectionId)` | `sb:db:remove` | `{ ok, connections }` |
| `databaseEntities(wsId, connectionId)` | `sb:db:entities` | `{ ok, entities }` |
| `databaseRecords(wsId, connectionId, entityId)` | `sb:db:records` | `{ ok, columns, rows, fetchedAt }` |

Failures are `{ ok: false, error }` with credential-free sentences. A connection's
public shape is `{ id, name, provider: 'postgres' | 'mongodb', host, database, createdAt }`;
the encrypted URI stays on disk and its plaintext never returns to the renderer.
Every workspace has its own private file, with serialized atomic mutations. Connect
validates the URI and lists entities with the supplied credentials before saving.
Secure OS encryption is required; Linux's basic_text fallback is refused. Removing
connection metadata never drops a database, table or collection.

Entities are `{ id, name, schema?, kind: 'table' | 'view' | 'collection' }`. PostgreSQL
entity IDs encode their schema/name; the service revalidates them against accessible
catalog entries before quoting identifiers and selecting. Every PostgreSQL operation
uses a read-only transaction. MongoDB uses collection listing and `find({})` only.
Drivers and database cursors are closed in finally paths and at app teardown. Results
normalize dates, large integers and BSON values into IPC-safe objects while preserving
nested fields. Columns are `{ name, type }`.

Reads consume cursors in batches and return all records together. Beyond 100,000 records,
32 MB or the operation timeout, the entire fetch fails with an explicit error rather
than returning a misleading partial table. The renderer keeps a virtual window of
44px rows so a large successful result stays scrollable. It preserves per-workspace
connection/entity selection, rejects stale async replies, clears URI input when a
modal is closed or its workspace is left, and retains the same root across routine
app repainting. `shown(route)` tells the view when it is hidden; `onKey` handles its
menus, modal, drawer and refresh shortcut. All data and credentials remain outside
repositories; `src/main/default-config.json` stays `{}`.

---

## 5. Main-process modules

### M2 `config.js`
`load()`, `save(patch)`, `defaults()`, `linksFor(workspace, repo)`.

### M2 `workspaces.js`
`discover()` → `Workspace[]` (no git): read `root`, keep directories with ≥2 child git
repos, drop `exclude`, then add every `workspaces.<id>.dir` the config declares (a
folder that is missing is skipped, and `exclude` does not apply — it is declared, not
discovered). Mark the one whose package.json is this app's own `self`, with
`devCommand: null` and `processes: []` whatever the folder or the config says.
Give each its `section`: its project when that project has more than one
workspace, else `other`. Sort by section in the config's project order with `other`
last, then by project, then by id.
`reposOf(ws)` → `[{ name, dirName, dir, root, nested }]`, no git: the folder itself when
it is a repo (a `.git`, or a parked `.git.disabled`), then its child repos. A single-repo
workspace is the first half alone, a plain folder of repos the second, an umbrella both.
It is the one rule for which repos a workspace has and what each is called, shared by
`scan()` and the Editor's path guard (M8).
`scan(id, {fetch})` → `Workspace` with `repos` — `reposOf()`'s, in that order — calling
`git.js` per repo **in parallel** and folding in `pr` from the cached PR summary if
present. Never throws: a repo that fails gets `error` and empty change data.
`lookup(id)` → the `Workspace` (no repos) the rail shows under that id, or null — the one
place a bare id turns back into a folder, so a declared workspace resolves to its
declared `dir`. `dirOf(id)` → the absolute folder a terminal for `id` opens in: an
absolute path (a folder square, §4.10) when it is a directory, else `lookup(id).dir`,
else the root's child of that name (the old resolution), else null. `shell.js` and
`runner.js` resolve every bare id through these and never join the root with the id
themselves — that is how `website` used to answer "unknown workspace".

### M3 `git.js`
Pure functions over a repo directory, all `execFile('git', […], {cwd})`, no shell:
`branchInfo(dir)`, `divergence(dir, branch)`, `changes(dir, {exclude})` (tracked numstat +
status + untracked, NUL-separated parsing), `fileDiff(dir, path, {untracked})`,
`allDiffs(dir, {exclude})`, `pullMain(dir)`, `remoteInfo(dir)`, `fetch(dir)`. Handle: no
upstream, missing `origin/main`, detached HEAD, renames, binary files, paths with spaces
and unicode.

A **parked** repo (§2) is handled in one place: `run()` adds `--git-dir=<dir>/.git.disabled
--work-tree=<dir>` when `dir` has no `.git` and has that folder, so every function above
and below reads, fetches and pulls it as it would an attached one; `gitDirs(dir)` answers
with the parked folder, which is where `lastFetch()` and `github.js` look for FETCH_HEAD,
HEAD and the config. git skips a folder called `.git` and nothing else, so the listings
that can see untracked files — `status -uall`, `ls-files -o`, `grep --untracked` — are
given `:(exclude,literal).git.disabled` for a parked repo, and `:(exclude,literal)<name>`
for every name in `exclude`: the workspace folder's child repos (`Repo.nested`), each of
which would otherwise be one untracked "file" of an umbrella that does not gitignore it.

An untracked file's line counts are counted in-process (`countLines()`), not by a
`git diff --no-index --numstat` per file: a process each is ~30 ms, and a folder of 300
untracked images made one scan take nine seconds. The rules are git's — a NUL in the first
8 000 bytes is binary, a line is what ends in `\n` and the last one counts without it —
and anything that is not a regular file (a symlink) is still asked of git.

For the Editor (§4.14), three readers that never write: `lsFiles(dir, {max, exclude})` → `{ ok,
files, ignored, truncated, error }` (`files`: tracked first, then untracked-not-ignored,
less what the worktree has deleted; `ignored`: the files `.gitignore` excludes, by name,
with ignored folders left out whole and `.DS_Store` / `Thumbs.db` dropped — four
`ls-files` calls side by side — the two lists together cut at `LS_FILES_MAX`, 100 000,
ignored files first), `headBlob(dir, relPath)` → `{ ok, text, skip }` (`git cat-file blob HEAD:…`,
`HEAD_BLOB_MAX_BYTES`, 3 MB, as its `maxBuffer`) and `grep(dir, query, {caseSensitive,
regex, max, exclude})` → `{ ok, matches: [{path, line, text, offset, ranges}], truncated, error }`
(`GREP_MAX_MATCHES`, 2 000; `GREP_MAX_PER_FILE`, 200; the 400/80-character window; and
`matchSpans()`, the one bounded pass that finds `ranges` — at most `GREP_MAX_RANGES`, 50,
a line, under a `GREP_REGEX_MS`, 250 ms, `vm` timeout for a regex). `-z` on anything that
prints paths, and a user's string only ever after `-e` or `--`, so a query or a file name
can never be read as an option. `max` is for tests, which need a cap they can reach.

### M4 `github.js`
`prForBranch(dir, branch)`, `prDetail(dir, number)`, `prDetailByRemote({owner, repo,
host}, number, {fresh})`, `myPullRequests({fresh})`, `reviewComments(dir, number)`,
`resolvedThreads(dir, number)`, `mergePr(dir, number, {headSha})`,
`mergePrByRemote({owner, repo, host}, number, {headSha})`, `deleteHeadBranch(target,
{dryRun})`, `deleteRemoteBranch(remote, branch)` (§4.4). Uses `gh` with `--json`; caches per (dir, branch) for
60 s — a PR named by remote alone is cached under a `host/owner/repo` pseudo-directory,
which no real directory can collide with; distinguishes *not installed* / *not
authenticated* / *no PR* by exit code and stderr, returning those exact sentences.

### M5 `runner.js`
One dev process per workspace. Spawns the workspace's `devCommand` through a pty when
`node-pty` loads, else `child_process.spawn` with `FORCE_COLOR=1`. Keeps a ring buffer
(1 MB / 5000 lines) per workspace for replay. Emits `sb:evt:log` and `sb:evt:run`.
Stops by killing the whole process group (SIGTERM → SIGKILL after 4 s) so npm, node,
expo and ngrok children never survive. Refuses to start a second copy of the same
project, returning `conflict`. Kills everything on `app.before-quit`. A bare id from
`sb:run:start` is resolved through `workspaces.lookup` (M2) to `{ id, project, dir }`
only — the config fills the processes in — so a declared workspace starts in its
declared folder.

### M6 `shell.js`
One interactive login shell per workspace: `pty.spawn($SHELL, ['-l'], {cwd: ws.dir})`, so
it reads the same `.zprofile`/`.zshrc` iTerm2 does and `claude` is on `PATH`. A bare id
is resolved through `workspaces.dirOf` (M2): a workspace id opens in the folder the rail
lists for it, declared `dir` included, and an absolute path — a folder square (§4.10) —
opens in itself. A folder that is not there answers `that folder is not there any more:
<path>`; an id the rail does not know, `unknown workspace "<id>"`. The tmux session for a
workspace id is `sb-<id>` and must stay so across versions, or a launch would stop finding
last week's session; a folder's is `sb-<basename>-<8 hex of sha1(path)>`, so two folders
of one name are two sessions and the name still reads in `tmux -L switchboard ls`. `TERM` is
`xterm-256color`, `COLORTERM` is `truecolor`, `TERM_PROGRAM` is `Switchboard`, and
`COLORFGBG` says which way round the terminal is (§4.8). Deliberately does NOT set
`FORCE_COLOR`/`CLICOLOR_FORCE` — a real tty needs no coaxing and forcing them lies to
anything that pipes. `setAppearance(name)` takes the resolved appearance for the NEXT
shell; an environment cannot be rewritten after fork.

Keeps a 1 MB / 5000-line ring buffer per shell, trimmed at a line boundary, for replay.
Emits `sb:evt:term` (wsId, chunk) and `sb:evt:termState` (Shell).

**The shell outlives the app** (added 2026-09-19, the user's ask). When `tmux` is on
PATH (Homebrew's 3.7), the shell runs inside a tmux session named `sb-<wsId>` on the
app's own server — `tmux -L switchboard -f src/main/switchboard.tmux.conf`, so the
user's own tmux and `~/.tmux.conf` are never touched — and `Term.term` is a tmux
*client* attached to it in the pty. `open()` attaches to a session that is already
there and creates one only when it is not (`new-session -d -c dir -x cols -y rows -e
COLORFGBG=…`, a login shell as tmux runs `default-shell`); `startedAt` is the session's
`session_created` and `pid` its `pane_pid`, so a shell attached again next week is the
same generation to the renderer. `buffer()` for a live one re-attaches a fresh client
(the old one is dropped first, so its exit is not the shell's) and answers `''`: tmux
paints the whole screen into the fresh pane, where a ring replay would paint a
half-drawn TUI. `closeAll()` at quit *detaches* (SIGHUP to the client, which tmux takes
as detach); `close()` is `kill-session`. A client that ends unasked means the session is
gone — the user typed `exit`, and tmux prints `[exited]` first — or it was detached
under us, in which case it just gets a new client. Without tmux, everything is the old
way: a bare `zsh -l`, hung up at quit, and `claude --continue` resumes.

Things the config gets right that took measuring: the server exits the moment it has
no sessions (`exit-empty`), so `-f` rides on EVERY command — the one that happens to
start the server must carry the config or it comes up on the user's own; the outer
terminal loses `smcup`/`rmcup`, because in xterm.js's alternate buffer there is no
scrollback at all; and it loses `indn` (CSI S, "scroll N lines"), because xterm.js
drops what that scrolls off rather than keeping it — with it, `seq 1 200` left zero
lines of scrollback, without it 187. `Ms` plus `set-clipboard on` carry OSC 52 (Claude's
`/copy`) out to the pane; `bell-action any` carries the bell that turns the rail's dot
blue; `escape-time 0` keeps Esc immediate and still lets Shift+Enter's ESC CR through
as one key. `prefix None`, `status off`, `mouse off`: tmux draws and intercepts nothing.
`display-message -t` takes a pane target, where the `=name` exact-match prefix answers
nothing on 3.7; `name:` is used there and `=name` everywhere else.

Teardown of a plain shell is a terminal's, not the runner's: SIGHUP the process group,
SIGKILL it after a 2 s grace, and stop. No orphan sweep, no port sweep — this is the
user's own shell and anything it started is theirs.

A shell is invisible to `runner.js`: it has its own session (forkpty calls setsid) and
therefore its own pgid, which is the only thing `Session.sweepOrphans` treats as "ours",
so `Stop` and the dev-server teardown can never reach it. The reverse also holds.

### M5 `ports.js`
`probe(links)` → marks each link live via a fast TCP connect (150 ms timeout).
`ngrokUrl()` → `http://127.0.0.1:4040/api/tunnels`, null when ngrok is not running.
The runner polls every 2 s while a workspace is starting, then every 10 s while running,
and emits `sb:evt:links`.

### M7 `usage.js`
`start()` / `stop()` the once-a-minute poll; `get()` — the last answer, or the one in
flight; `refresh()` — ask now, deduped while one is in flight; `poke()` — a window
focus, which re-asks only past 20s; and `events`, emitting `usage` with every answer.
`normalize(body, plan)` and `planName(subscription, tier)` are exported for tests.
Never rejects; see §4.11 for what it reads and the one place it sends it.

### M8 `editor.js`
The Editor's file access (§4.14): `tree(id)`, `read(id, repoName, rel)`, `write(id,
repoName, rel, text, opts)`, `base(id, repoName, rel, oldPath)`, `stat(id, files)`,
`search(id, query, opts)`, and the tree's three writes of §4.16 — `create(id, repoName,
rel, {dir})`, `rename(id, repoName, from, to)` and `remove(id, repoName, rel, {trash})`.
It is a module of its own so that everything that touches a file in a repo sits behind
one guard: every path from the renderer goes through it (resolve the repo from the id
without a scan, refuse `..`, `.git`, absolute paths and symlinks out, check the
realpath), and the five writes behind it — the in-place `writeFile` of Save behind its
mtime check, an `open(…, 'wx')` or a `mkdir`, a `rename`, a `trashItem`, and the `unlink`
a FILE falls back to when the Trash refuses — are the only files the app itself ever
writes, moves or removes in a repo (Pull main's writes are git's). A folder is never
removed behind a failed Trash. None of the four runs a git command, and `remove` takes its Trash function
as an argument so that this module still requires nothing of Electron and its tests
still run under plain `node`. Its own limits live here — 5 MB to open
(`READ_MAX_BYTES`), 20 MB to save (`WRITE_MAX_BYTES`), 200 files a stat
(`STAT_MAX_FILES`), 500 characters a query (`SEARCH_MAX_QUERY`); the git-side caps it
relies on live in `git.js` (M3) — 3 MB for a `HEAD` base (`HEAD_BLOB_MAX_BYTES`),
100 000 files a repo (`LS_FILES_MAX`), 2 000 matching lines a search (`GREP_MAX_MATCHES`, which
`search()` re-applies across repos) and the highlights' 50 a line and 250 ms. Git itself
goes through `git.js` too. There is deliberately no watcher
(§4.14). Like `git.js`, nothing throws: every failure resolves to `{ ok:false, error }`,
and `scripts/test-editor.js` runs all of it against fictional scratch repos with plain
`node --test` (`npm run test:editor`) — the three writes included: that a new file is
untracked and staged nowhere, that a rename or a delete moves the LINK and not its
target, that a link pointing out of the repo is refused either way, that `.git` and `..`
are refused, and that a folder the Trash will not take is left alone.

### M10 `whiteboards.js`
The Whiteboards store (§4.17), which replaced the per-workspace `diagrams.js`: `list()`,
`get(id)`, `create(req)`, `saveSpec`, `rename`, `setWorkspace`, `move`, `duplicate`,
`setArchived`, `remove`; `createFolder`, `renameFolder`, `removeFolder`;
`dismissNotice()`, `noteWorkspace(wsId, {last})`, `workspaceChoices()`;
`createDocument`, `getDocument`, `saveDocument`; `saveImage(bytes, type)`,
`imagePath(name)` (synchronous, for the `sbimg` handler), `getImagePath(src)` and
`IMAGE_TYPES`; `migrate()`, `settle()` and `onChange(fn)` (→ an unsubscribe; `index.js`
forwards each change as `sb:evt:wbChanged`); and `rootDir()` / `legacyKeyFor()` for the
tests. The admin's server actions as files: the same answers, the same name rule (unique
within a folder here), the same "archiving does not touch updatedAt". It checks only
what keeps the store sane — an object of kind `flow` (of any size — §4.17), a name of
1–120 characters, a folder name of 1–60, a UUID for an id, a workspace that is an id and
never a path — because the bundle has run the admin's validator before it asks. Every
board and `store.json` write is one job on one serial chain, through a temp file and a
rename, so two creates under one name cannot both pass the check; documents keep a chain
per file. Every path is computed from `config.CONFIG_FILE` when it is needed, and
requiring the module does nothing on disk — the migration runs only when `index.js`
calls it. It reads the rail through `workspaces.discover()` (pickers, the migration) and
`projectOf()`, and runs no git. Nothing throws. `scripts/test-whiteboards.js` (`npm run
test:diagrams`) runs all of it under plain node against scratch folders — folders,
moves, duplicates and their documents, summaries and their previews, change events, the
workspace a new board starts with as workspaces leave the rail, every migration case
(a clash, a stop part way and the resume, a run that renamed the tree and stopped before
saying so, an unreadable file, a hash that names no workspace, a second run, a copy a
crash cut short, a disk without hard links, a document brought in from the old tree on
its first open) — with the stylesheet scoping from `build-diagrams.js`.

### M11 `answer.js`
✦ Answer (§4.18): `status({fresh})`, `settings()`, `setSettings(patch)`, `setKey`,
`removeKey`, `start(id, req, onStep)`, `stop(id)`, `stopAll()`, and
`resolveAnswerDir(req, lookup)` → `{ ok, dir, wsId }` or `{ ok:false, code:'no-workspace',
error }` — the folder a CLI answer runs in, from the board's workspace through the rail's
own `lookup`; an API gets `dir: null` without one, and a condensation the temp folder
when there is no workspace (`cliDir()`). The provider catalogue —
the admin's OpenAI models with their probed efforts, the Claude models, Claude Code's
`--effort` levels — is here and only here; the menu and the Settings screen draw what
`status()` says. Each provider is one function that turns `{ system, user, schema }` into
the answer's JSON: a CLI through `spawnCli()` (detached, its stdout read a line at a
time, stopped by process group), an API through `net.fetch` with the request's own
AbortController wired to Stop until the body is in. Failures carry a `code` the page can
act on. Each provider's request is built by a pure function (`claudeCodeArgs`,
`codexArgs`, `claudeApiBody`, `openAiBody`) and its answer read by another
(`claudeAnswerText`, `readOpenAiStream`), so `scripts/test-answer.js` (`npm run
test:diagrams`) checks them with Electron stubbed — Web access and Subtext included, with
the bundle's prompt and answer reading beside them, and `resolveAnswerDir` for a CLI, an
API, a condensation, a path handed over as an id and a lookup that throws. The live paths were checked against
Claude Code and the OpenAI API; the Claude API (no key on hand) and Codex (not installed)
only against their documentation.

### M12 `images.js`
Google Images beside a whiteboard, main's half (§4.17): `hardenWebview(webPreferences,
params)` (the whole `will-attach-webview` decision), `setupImagesSession()`,
`attachGuest(wc, deps)` (popups, navigation, the right-click menu), `focusedGuest(host)`
(for the Edit menu) and `fetchImage(url, referrer)`, whose conversions run sips under
`SIPS_PROFILE`. The pure helpers — the src rule, the user agent, Google's wrappers, data:
URLs, the byte sniff, the name, the Referer, a page's user activation, the menu as data —
load no Electron, so `scripts/test-images.js` (`npm run test:diagrams`) runs them under
plain node; what needs Electron requires it inside the function, and that test hands
`fetchImage` and `attachGuest` a stand-in. Nothing throws across IPC.

---

## 6. Renderer

### R1 `index.html`
Load order, all classic scripts, no `type=module`:
`icons.js`, `dom.js`, `term-theme.js`, `markdown.js`, `diffview.js`, `views/workspace.js`,
`views/logs.js`, `views/terminal.js`, `views/wbterminals.js`, `views/usage.js`,
`views/grid.js`, `views/files.js`, `views/diff.js`, `views/pr.js`, `views/prs.js`,
`views/editor.js`, `diagrams/diagrams.js` (the built bundle, §0), `views/whiteboards.js`,
`views/databases.js`, `views/settings.js`, `app.js` (last — it
boots). `term-theme.js` must precede the two views that build `Terminal`s: both read the
palette at construction; `markdown.js` must precede `diffview.js` and the two PR screens,
which render every comment body through it; `prs.js` follows `pr.js`, whose gh failure
bars it borrows;
`views/editor.js` follows `term-theme.js` (Monaco's themes are built
from its palette) and `views/workspace.js` (it borrows the header);
`views/wbterminals.js` follows `views/terminal.js`, whose panes its panels and pins hold;
`views/whiteboards.js` follows the bundle it drives, and reads `SB.wbTerminals` only when
a canvas is made, feature-checked, so a build without it still draws boards. The
stylesheets are `xterm.css`, `styles.css`, `wbterminals.css` (a whiteboard's terminals,
after the tokens and classes it leans on) and the bundle's scoped `diagrams/diagrams.css`.

**Monaco is not in this list, and must never be put above it.** Its AMD `loader.js`
installs a global `define` with `define.amd`, and the xterm UMD wrappers at the top of
the page check exactly that FIRST — `"function"==typeof define&&define.amd` comes before
their global branch — so with Monaco's loader ahead of them xterm registers itself as an
anonymous AMD module, `window.Terminal` and `window.FitAddon` never exist, and every
Terminal, Logs pane and Grid square says the terminal did not load. `views/editor.js`
injects `node_modules/monaco-editor/min/vs/loader.js` itself, the first time an Editor tab
opens (R13): long after the xterm scripts ran, and nothing at all for a user who never
opens one. Its `editor.main.css` arrives the same way, after `styles.css`, so Monaco wins
a tie and the Editor's overrides are scoped under `.ed`. Packaging keeps only
`monaco-editor/min/vs` (less its legacy `language/` workers and non-English `nls/`) —
about 15 MB of the package's 100 — through `scripts/package.js`'s `ignore`.

Body skeleton:
`<div class="win noanim"><aside id="side"></aside><main id="main"></main><div class="drag"></div><button id="rail"></button></div>`.
The toggle is a child of `.win`, not of the aside, because it has to outlive the rail —
closed, it slides over to sit beside the traffic lights. **It is last for a reason.**
Electron builds the window's draggable region by walking the document in order — union
for `drag`, subtract for `no-drag` — so a `no-drag` element that precedes a `drag` one
has its hole punched first and then covered over. With the button before the `.drag`
strip, closing the rail worked and a real click on the button to reopen it moved the
window instead; a programmatic `click()` in the smoke never noticed, because it bypasses
the native hit test. Every drag region has to precede the button. `noanim` is in the markup rather
than added by script: a window that opens with the rail already closed would otherwise
slide it shut in front of the user, and by the time a script could add the class the first
paint has happened. `app.js` drops it one task after the stored state has been applied,
forcing a style recalculation first — in the same task the browser folds both changes into
one recalc whose after-change style has the transition back, and it animates anyway.
The top 52 px of the sidebar is the drag region holding the real traffic lights
(`titleBarStyle: 'hiddenInset'`, `trafficLightPosition: {x: 18, y: 18}`).

### R1 `dom.js`
```js
SB.dom = { h(tag, attrs, ...children), frag(...), esc(s), clear(el), on(el, ev, fn),
           fmtAgo(ms), plural(n, word) }
```
`h('div.repo', {onclick}, …)` supports a `tag.class.class` selector string and an
`html: '<svg…>'` attr for trusted icon markup. Everything else is escaped.

### R9 `term-theme.js`
```js
SB.termTheme = { palette(name), current(), set(name) /* -> changed */, onChange(fn) }
```
The **one** definition of the terminal's sixteen ANSI colours, for both consumers that
need them: `Terminal.options.theme`, and the `--term-*` / `--t-*` CSS tokens, which
`set()` writes onto `:root` from the same object. They used to be hand-kept copies in
three files. `set()` also stamps `data-term-theme` on `:root` for the handful of rules
that are not a colour swap — in light the pane needs an edge and the scrollbar has to
stop being white.

The light palette is not the dark one inverted: those are pastels chosen to glow on
near-black and they wash out on a light ground. Every light slot clears WCAG 4.5:1
against its background (floor: `cyan`, 4.52), which is a better floor than the dark set
manages (3.77, at `brightBlack`). Two conventions that look wrong written down and are
right on screen: on a light ground `white` becomes a mid grey or it is invisible, and
`brightWhite` — the slot programs reach for to emphasise — becomes the darkest ink.

The light pane's edge is a `box-shadow`, never a `border`. FitAddon sizes the pty from
`getComputedStyle('.term').height`, so a real 1px border would cost a row exactly the way
the old padding cost two (see `.term` in `styles.css`). A shadow paints without touching
the box — measured identical geometry in both appearances.

### R2 `app.js`
Holds the only mutable state:
```js
SB.state = { workspaces: [], byId: {}, route: {view:'workspace', wsId, tab:'changes'}, run: {}, loading:false }
```
`SB.go(route)` sets the route and re-renders; `SB.refresh(wsId, {fetch})` re-scans;
`SB.render()` renders sidebar + the view for `route.view`; the rail's group headings are
the workspaces' `section`s, in the order main hands them over. Views are pure functions
`(state) => HTMLElement`; `app.js` swaps `#main`'s child. It subscribes to `onLog`,
`onRunState`, `onLinks`, `onFocus`, `onAppearance`, `onUsage`, and owns keyboard shortcuts
(⌘1–9 switch workspace, ⌘R refresh, Esc back, ⌘. stop). Esc never goes back once
something has acted on it (`defaultPrevented` — a Radix dialog or menu that closed on that
very key marks it handled first), so one Esc is one step. An appearance change never calls
`render()`: `term-theme.js` repaints the live xterms itself, and rebuilding the view would
throw away the terminal's focus and selection to repaint colours that already changed.

It also owns the rail's visibility (§4.9) and `SB.layout.busy()`, the flag the two
terminal views hold their fits behind while it moves. The settling period is a **timer**,
not `transitionend`: under `prefers-reduced-motion` there is no transition at all, the
event never arrives, and every terminal would stay frozen for good at its old size.

The Editor (R13) is wired in at four calls, each feature-checked and wrapped in a
`try`/`catch` that logs, so a broken Editor never takes the rest of the app with it:
its `onKey(e)` is the FIRST thing the window's keydown listener asks — ⌘S, ⌘P, ⇧⌘F,
and Esc while its palette, its find field or its full screen is up, before Esc can
mean back; its `editAction(action, text)` is asked right after the terminal's (§4.7),
except for a Paste with `image: true`, a screenshot's temp-file path that only a
terminal may type and `handleEdit` drops once the terminal has declined it;
`handleFocus` calls its `refresh(fetch)` while it is on screen, behind the same 1200 ms
storm guard as everything else there; and `settle()` calls its `relayout()` with the
terminals'. And `renderMain()` leaves its root in place when a render hands back the
element already mounted (the reuse path), where every other view is torn down.
`SB.layout.full()` / `SB.layout.setFull(on)` are its full screen (§4.9): the `.edfull`
class on `.win`, dropped by `renderMain()` off the Editor's route and by ⌃⌘S.

Routes: `{view:'workspace', wsId, tab:'changes'|'logs'|'terminal'|'editor'|'databases'}`, `{view:'settings'}` (no workspace; §4.18), `{view:'files', wsId, tab:'files'|'all'}`,
`{view:'diff', wsId, repo, path}`, `{view:'pr', wsId, repo, tab:'overview'|'files'|'all'}`,
`{view:'pr', owner, repo, number, tab}` (no workspace — a pull request opened from the
list; its parent for the back caret and Esc is `prs`, not `workspace`),
`{view:'grid'}` (no workspace; §4.10), `{view:'usage'}` (no workspace; §4.11),
`{view:'prs'}` (no workspace; §4.12), `{view:'whiteboards', folder}` and
`{view:'whiteboard', board}` (no workspace; §4.17, R15). A route with no workspace is
`standalone()`: it renders with no workspaces at all and lights its own rail row — the
Pull requests row stays lit while one of its pull requests is open, and the Whiteboards
row while a board is.

The two whiteboard routes mirror `prs` and `pr`: the Whiteboards screen, and one board
open. Both are drawn by `views/whiteboards.js` (`VIEW_MODULES` maps `whiteboard` to it),
both are in `FREE` — and in `buildView()`'s own `free` test, which does not read `FREE`
and would otherwise show the no-workspaces screen for them — and `PARENT.whiteboard` is
`whiteboards`. `folder` is a folder id or `all`, `recent`, `archived` or `none`; a route
that names none gets `SB.views.whiteboards.lastFolder()` — the folder of the board shown
last, or the one last looked at, whichever came last (`switchboard.wb.folder` in
localStorage) — and never inherits one from the screen being left. `board` is a board
id; a `whiteboard` route without one is the Whiteboards screen. `normalize()`,
`sameRoute()` and `routeKey()` carry both fields, or two boards would be one route and
`go()` would take the second for a re-render. A route to the old Diagrams tab,
`{view:'workspace', tab:'diagrams'}`, lands on the Whiteboards screen rather than on the
first tab, and `rememberScreen()` keeps an open board as `whiteboards`, so the window
comes back to the list in the board's folder. `sb:evt:wbChanged` marks every `wb:` load
stale without a render and redraws only when the Whiteboards screen is up, or on the
Grid for a change that is not a `save` while a square is choosing a board
(`SB.views.grid.choosingBoard()`), so its list has the board just made or renamed: an
autosave is a write too, many a minute, and a render for it would rebuild the Grid's
four squares for a list nobody is looking at. `SB.ensureScanned(wsId)` scans a workspace
once, if nothing has asked yet — for a terminal panel's branch and the pickers, which
can name a workspace no route has visited.

It also owns the rail's bottom row, Usage, drawn by `renderFoot()` behind its own
signature like the nav; its dot is red only while the five-hour window is `critical`.
Above the workspace groups are three rows, Grid, Pull requests and Whiteboards — the
last with no dot, a board having nothing running; its terminals' bells ring on their
workspaces' rows — and all three are drawn before the zero-workspace return, since a
rail with nothing configured must still reach them. The lit one is a letter in
`sidebarSignature()`, or leaving Whiteboards for Usage would read as no change and the
row would stay lit.

### R3 `markdown.js`
`SB.markdown.render(text, { breaks })` → a DocumentFragment of block elements;
`inline(text)` → nodes for one line; `parse(text)` → the block tree, for tests.
GitHub-flavoured markdown as the text on a pull request and a README actually use it:
headings (`#` and the `===` / `---` underline), paragraphs, bullet / numbered / task
lists, fenced code, blockquotes, tables, rules, `<details>`; inline code, bold, italic,
strike, links — inline and reference-style, `[text][name]` with `[name]: url` anywhere in
the text — bare addresses, images to their alt text. `breaks` is what a single newline
inside a paragraph means: `true`, the default and every comment's, is a line break, as
GitHub renders a comment box; `false`, the Editor's preview of a file, is the soft break
of a document, folded into a space, as GitHub renders a README — a line ending in two
spaces or a backslash is a hard break either way. No engine and no innerHTML — every
string reaches the document as a text node — and raw HTML is read only for the tags that
carry meaning (`<a href>`, `<br>`, `<details>`, `<code>`, bold/italic); every other tag is
stripped to its text, which is what Codex's `<sub>` badge wrappers and the Linear bot's
`<p><a>` need. Every comment body in the app — in a diff, on the Overview — goes through
it, and so does the Editor's preview (R13); the `.md` class is what the stylesheet sizes
the blocks by, re-coloured under `.edprev` for the slab.

### R3 `diffview.js`
`SB.diffview.render(patch, {comments: PrComment[], collapsedContext: false})` → DOM node
using the mock-up's `.diff`/`.h`/`.a`/`.r` classes, inserting `.cmt` comment cards after
the line a comment anchors to. Pure; no IPC. Comment bodies are `SB.markdown`'s.

### R8 `views/terminal.js`
The Terminal tab. Same header as Changes and Logs (`SB.views.workspace.header`), a
`.bd.pane` below it holding one xterm per workspace. Opens the shell on first render.

Keyboard, matching what `claude /terminal-setup` installs elsewhere:
* **Shift+Enter** sends `ESC CR` (`\x1b\r`) — the newline sequence Claude Code expects.
* `macOptionIsMeta: true`, so **Option+Enter** sends the same thing and Option+B/F do
  word motion.
* **⌘K** clears the screen and scrollback.
* OSC 52 (`ESC ] 52 ; c ; <base64> BEL`) writes to the system clipboard, which is how
  Claude Code's `/copy` works. Registered with `term.parser.registerOscHandler(52, …)`;
  no addon.
* `term.onBell` marks the workspace so the sidebar can show it; see §7.

**Drops.** A file dropped on the pane is typed at the cursor as its escaped path with
a space after it — every file, space-separated — which is exactly what iTerm2 and
Terminal.app do, and all that "drag an image into Claude Code" ever was: Claude reads
the image from the path. Escaping is a backslash before whitespace and shell
metacharacters, never quotes, because that is the form those terminals type and so the
form Claude Code's path detection was built against. The renderer takes the Files off
the DataTransfer synchronously, asks the preload for each one's path (`sb.pathForFile`,
§4.5) and reads the bytes of any File that has none, then hands the lot to main
(`sb.dropFiles`, §4.5), which answers the text to type; it goes through `term.paste()` —
the ⌘V route — so bracketed paste applies and the composer takes it as inserted text.
Main (`main/drops.js`) knows three kinds of File, and only the first is a file on disk:
a Finder drop, whose path exists and is typed as it is; a File built in memory (an image
dragged out of a browser), whose bytes are written under `$TMPDIR/switchboard-pastes/`
and that path typed; and a file *promise* — an unsaved macOS screenshot dragged off its
floating thumbnail — which Chromium 152 hands the page as a File whose path is the
screenshot tool's own temporary copy, `$TMPDIR/TemporaryItems/NSIRD_screencaptureui_*/`
(it keeps the promise's file URL, discards the PNG bytes that ride alongside it, and
never fulfils a promise; `web_drag_dest_mac.mm`,
`FileURLAndFilePromiseContentDoNotDuplicate`). That file exists at the instant of the
drop, so existence proves nothing; it is unreadable to every other process and is
deleted when the thumbnail goes. Typed as-is that is a dead path and Claude Code sees
text (`zsh: permission denied` in a plain shell). The bytes are still on the macOS drag pasteboard, which
Electron's clipboard module cannot read (no drag buffer) but `/usr/bin/osascript -l
JavaScript` can, in ~90 ms — so on `dragenter` the renderer calls `sb.dragBegan()` and
main snapshots the pasteboard's promised files into the paste folder *while the drag is
live* (the pasteboard may be cleared by the time the DOM `drop` has crossed IPC), and
the drop types the snapshot's files, renamed to the screenshot's own name, in
preference to any path whenever the drag carried promised content at all; a Finder
drag promises nothing, so its paths are typed as they are. A drop with no file (a URL
or selection dragged out of a browser)
is pasted as its text. The listeners are on the pane's host, so the Grid's squares get
them too. Without them, Chromium's answer to a dropped file is to navigate the window
to its `file://` URL, which main's `will-navigate` cancels and `openExternal` refuses
(http(s) only): the drop vanished silently, and `dragover` has to `preventDefault` or
`drop` never fires at all.

Exports `render(state)`, `write(wsId, chunk)`, `onState(shell)`, `dispose(wsId)`,
`relayout()` (every pane refits — §4.9), `mount(wsId, into)` and `focus(wsId)` (the Grid's
squares — §4.10), `place`, `setFontSize`, `propose`, `setFixed`, `hold` and `owner` (a
whiteboard's terminals, below), `editAction(action, text)` → `true` when the focused
terminal consumed a menu Edit action, and `xterm(wsId)` (the live Terminal, for the smoke
harness and the browser tests only). A pane whose shell is still alive is **never**
disposed: replaying a full-screen TUI's ring buffer into a fresh xterm paints garbage. The
one time a fresh pane meets a live shell — the window closed and opened again — the
replay it asks for is a repaint by tmux (§4.6), which is why that case is not garbage
either.

**One pane, many hosts, one holder.** The Terminal tab, a Grid square and a whiteboard's
terminals all show the SAME pane — one xterm and one shell per workspace (a second xterm
would steal the tmux client and repaint garbage) — and with several boards and a Grid on
screen together, more than one place can want it at once. So the pane records who holds
it: `owner` is null for a route host, which takes it with `mount()`, and `'wb:<boardId>'`
for a board's terminal layer (R15), which takes it with
`place(wsId, into, { owner, fixed?, fontSize?, force? })` → whether `into` now holds it.
`place()` YIELDS: it takes the host only when nothing on screen has it, when it is
already in `into`, when the same owner put it elsewhere (a pinned terminal floating back
out), or when `force` says the user asked for it here — otherwise it answers false and
the layer draws a stand-in, `Showing in another place`, with **Show here** only when
another board holds it (a Grid square or the Terminal tab would only take it back on its
next render). Two hosts that both took it on every render would bounce it between them,
refitting and resizing the pty each time. `place()` refuses an `into` that is not in the
document, always sets the pane's whole mode — fit at 12.5 px unless it passes otherwise,
so a pinned terminal's 7 px text and fixed grid never leak onto the Terminal tab — draws
the failed-to-open sentence (kept as it is when it already says that, so a focused Try
again survives every render) and the exit footer as `mount()` does, ends any hold, and
calls `activate()`. `mount()` resets owner, font and fixed mode, and releases any hold, as
it takes the host.

**Fixed mode** is a pinned terminal's (`setFixed(wsId, {cols, rows} | null, owner)`):
the box follows the canvas zoom every frame while the grid does not, so a fit is
`term.resize(fixed)` instead of `fit.fit()` and the pty hears a size only when the fixed
one changes — memoised, the one memo `sendResize` keeps, since a ResizeObserver firing
on every zoom frame would otherwise put an ioctl on the IPC channel per frame. The
first-fit path still runs, so a pinned terminal restored after a relaunch opens its
shell at exactly those cols/rows, and a new shell generation is always told.
`setFontSize(wsId, px, owner)` sets the live `fontSize` (xterm re-measures and repaints
at the same cols/rows) and steps down a quarter pixel, at most three times, while the
fixed grid would not fit the box — measured cells are rounded and ceil'd, and the prompt
line is the one that gets clipped. Every font change then asks xterm's viewport to
measure its scroll range again (`syncScroll`, its internal
`_core._viewport.queueSync()`, a no-op when missing): xterm 6 recomputes that range only
when the buffer resizes or scrolls, so after a zoom the wheel over a pinned terminal
stopped scrolling its scrollback. `propose(wsId)` is what a fit would make of the box
now, without resizing anything. `hold(wsId, on, owner)` suspends fits while a panel's
edge, or a pinned node's resize handle, is dragged; the release fits once. All three do
nothing unless `owner` holds the pane and it sits in the element that owner placed it
in, so a layer that lost its terminal to the Grid cannot shrink the Grid's font or pin
its size. `owner(wsId)` answers who holds it.

### R10 `views/grid.js`
The Grid screen (§4.10). Header: one row — the views as the same segmented control the
workspace screen switches tabs with, plus a `+` that becomes the name field in place, and
a `⋯` at the right edge holding Edit and a Delete that asks once (the
item turns red and names the view; a second click deletes). No title and no count line: the selected
segment is the title, and the squares show their own state. The menu is in-page (`.more`
> `.menu`, hanging from the `⋯`, after the header in the DOM so its no-drag holds — §4.9);
it closes on Escape (focus back on the `⋯`), on a mousedown anywhere outside it, and when
focus leaves it; the arrow keys move between its items.

The menu's "focus left" and the name field's blur are both decided a tick later, never
from the event: Chromium blurs a focused element *before* a rebuild detaches it, so the
handler sees a connected element and no relatedTarget. Decided synchronously, the render
that opens the menu (the `⋯` has focus from the press) closed it again, and the next
render's landing focus put the user in a terminal; a bell mid-word would likewise have
committed half a name. After the tick, focus is back in the new element — `app.js`
restores it by position — or it has really left. A hidden window fires no focus events
at all, which is why the smoke harness gives its window page focus (`scripts` — R1).

What the name field's blur decides also waits for a press in flight. The press on a `×`,
a `‹` or Done is what takes focus out of the field, the blur fires on its mousedown, and
a rebuild between a mousedown and its mouseup detaches what was pressed — Chromium then
fires no click at all (measured: a render in that gap and the segment pressed never
switched). So `whenReleased()` holds the decision until the mouseup and runs it a tick
after, behind the click the press became.
Body: four `.cell`s — a filled workspace has a 30px strip (its name, which opens its
Terminal tab; its run dot; Terminal, Changes and Show a whiteboard mode buttons, and
beside them, while a board is showing, the chevron that changes it; and, only while the
view is being edited, a `×` to take it out) over the selected content. Terminal uses
`terminal.mount()`, Changes reuses `workspace.changesBody()`, and a whiteboard uses
`whiteboards.mountGrid(boardId, cell)` — or, with no board chosen, one gone, or one
another square of the view already shows (the first square to claim a board keeps it),
the in-cell picker: `Which whiteboard?`, a search field that hides rows in place rather
than rendering (a render rebuilds all four squares, terminals included, on every
keystroke), and the groups `For <workspace>`, `Recent`, each folder and `No folder`.
Its list is `SB.load('wb:grid', whiteboards.boards)`, a `wb:` key, so a whiteboard
change marks it stale, and `choosingBoard()` — a `.wbpick` on screen — is how app.js
knows to redraw for one (R2). The search has the keyboard whenever the picker shows (by
the mode button, by Change whiteboard); ↑/↓ walk the boards it leaves showing, and ↑
from the first goes back to it. A board's own quick switcher, ← / →, New whiteboard and
Duplicate inside a square change what the square shows
(`SB.views.grid.replaceBoard(from, to)`) rather than leaving the Grid, and the keyboard
stays in the square (R15). Delete, or Back on a board that has gone, returns the square
to its picker, the board refused; Back on one that couldn't be read is
`chooseAgain(boardId)`: the square goes back to choosing with that board still its
choice, offered again, and Cancel reads it afresh — rather than reloading the same
error. A folder square shows only Terminal. An empty cell is an `Add workspace`
button that turns into a picker of the workspaces not already in this view, headed by a
`Folder` › `Choose a folder…` row — first, because the list already overflows a square
and a row under ten workspaces is one nobody scrolls to — that raises the system's folder sheet
(`sb.chooseFolder()`, §4.10) — a cancel leaves the picker up, a choice fills the square
with the folder's path, or with the workspace that lives there when one does; a gone one
explains itself and offers Clear. A folder square's strip is the folder's name as a plain
label (the path is its tooltip), no dot and no jump: nothing runs there and no screen
sits behind it.

**Edit** is the one mode for everything about a view that can change (2026-09-29, the
user's ask: "it should literally just be 'edit' and 'delete' … we don't need two separate
settings for 'rename' and 'edit terminals'"). It is entered from the `⋯` and left with
the Done that takes the `⋯`'s place in the header, beside a line saying what the mode is
for (`.more.arr` > `.hint`). In it:

* **The name.** The selected segment becomes `.vedit`: the name as a field
  (`input.vname`, focused and selected on entry, so typing renames) inside the same
  raised pill the selected segment is. What the field says becomes the name when focus
  leaves it, on Enter — which hands the focus to Done rather than leaving, so Enter
  twice is rename-and-finish — and on Done. An empty field is not a name: the view keeps
  the one it had. Escape drops what was typed and the mode with it. The field's text and
  caret are put back on every rebuild.
* **Its place in the row.** A `‹` and a `›` either side of the field move the view one
  place along (`SB.grid.move`). The one at the end of the row is disabled, and a view on
  its own gets neither. The button pressed keeps the focus — it has moved with its
  segment, where `app.js`'s restore by position would not find it.
* **Its squares.** The filled squares' heads are tinted (`.cell.arr`) and carry a `×`
  drawn as a button; the empty ones offer `Add workspace` as they always do, so a square
  can be emptied and filled again in one visit. This is the only place a `×` exists: it
  used to sit on every square all the time, one slip away on the screen the hand is
  busiest in. Removing a workspace keeps the mode. A square just filled hands the focus
  to Done — the terminals take no landing focus while the view is being edited, and the
  restore by position would otherwise land on whatever replaced the picker's row.

Clicking another segment carries the edit to that view — the name typed is saved first —
so several views can be renamed and put in order in one visit. The `+` ends the edit and
becomes the new view's name field. Leaving the screen ends it, as it ends everything
mid-flight.

What it keeps between rebuilds is only what a rebuild would lose: the name being typed,
the square that is choosing, the square choosing another whiteboard and what each
square's board search says, the open menu, the armed Delete, the view that is being
edited, and the workspace just placed — whose terminal gets focus, because the picker row the user clicked no longer
exists and `app.js`'s path-based focus restore would land on whatever now sits at that
position. All of it is dropped when the Grid is rendered after another screen: `render()`
asks whether `#main` still holds a `.gridhd` from the previous rebuild. Landing on the
Grid otherwise focuses the first visible Terminal, and only when nothing in the main
column has focus already.

### R11 `views/usage.js`
The Usage screen (§4.11). Header: `Usage`, the plan at the right (`Max 5x`) with the
one action beside it — an `.ib` ↻ that asks again now and spins while it waits
(`SB.busy('usage')`; ⌘R on this screen does the same through the View menu's Refresh
and `handleFocus`) — and one line of state under it — `updated 40s ago`, ticking in place the way the workspace
header's `running 14s` does, or `not available` when there is no answer. Body: one
`.ulim` row per limit — name (the 150px repo-name column), bar, percent, `resets Thu
2:00 PM` — and, when there is no answer, the sentence with a single Try again.

The header's one action is the ↻ (`.ib`, `SB.busy('usage')` spins it; ⌘R on this
screen does the same). A failed refresh with good numbers still up shows them and adds
"· couldn't refresh" to the updated-ago line rather than blanking the screen; the
full-screen sentence with Try again is only for the never-answered case.

It also exports `gauge()`, the Grid header's session bar (`.gauge`: the bar, the
percent, when it resets; a button to this screen; nothing at all when there is no good
answer yet — a later failure keeps the last good gauge), and `refresh()`, which brings every
gauge on screen up to date in place and answers whether the document now agrees with
`state.usage` — `false` means only a rebuild can make it, and `app.js` renders then and
only then.

### R4 `views/workspace.js`
The Changes tab and the shared header the Logs, Terminal, Editor and Databases tabs borrow
(§6 R8, R13); its segmented control is `Changes | Logs | Terminal | Editor | Databases`,
lit from a whitelist rather than a logs/else test, which would light
`Changes` for any tab it had not heard of. Adding a tab takes two lines in `app.js` as
well — `TABS.workspace` and `TAB_VIEWS` — because `normalize()` rewrites a tab it does
not know to the remembered one before anything looks it up. Whiteboards are not a tab:
they belong to no workspace, and have a screen of their own in the rail (R15). The
header's title (`h1.jump`) is a shortcut into this workspace's Terminal — the tab the
user lives in — no-drag so the click is not eaten by the drag region, and the workspace
name in the Files, Diff and Pull request breadcrumbs jumps there too. The repo name and
the back caret keep the conventional step up to Changes.

The workspace header has no sub line: the name, Pull main and Start/Stop, then the
segment straight under them. The user cut `main · clean` (2026-10-04) as height spent
on nothing the header owned — branch, changes and behind are the Changes tab's,
running and failed the rail's dot and the Stop button, a missing dev script the
Changes tab's bar and the greyed Start. Don't put it back. A folder git has never
seen says `not a git repo` in its body. The workspace that is this app (`self`) has a
Publish button in place of Start and no `no dev script` bar. During a publish the
button reads `Publishing…`; a verified update changes it to `Published`, its tooltip
saying to close and reopen Switchboard. A failed publish is the one line the header
still grows, under the name, and the button allows a retry. Other workspaces retain
their existing Start/Stop actions.

### R5–R7 views
Each exports `SB.views.<name>.render(state)` returning a DOM node and nothing else —
they call `window.sb.*` for their own data through the helpers `app.js` provides
(`SB.load(key, fn)` memoises an in-flight promise and re-renders on resolve).

### R7 `views/pr.js`
The Pull request screen, reached two ways — a branch pill (`sb.pr`, keyed by the local
repo) or a row of the Pull requests screen (`sb.prByNumber`, no workspace) — and the
same screen either way but for the breadcrumb: `sample-2 › sample-api › Pull request`
or `Pull requests › sample-api › Pull request`. Segmented `Overview | Files | All
diffs`, **Overview first and the default**, because the diffs are the part looked at
least. The Overview is two halves, each a column scrolling on its own: on the left the
description as a card — author, when it was opened, the text at the full width of the
half, its reactions at its foot — and on the right the conversation: every `PrEvent` as
a card, a review's verdict as a chip when it is one (Approved / Changes requested;
"commented" says nothing), its inline comments nested under it with the file and line
as a link that jumps into All diffs and scrolls to that comment's card. Under 900px of
body width (a container query) the halves stack and scroll as one. Reactions are chips
(`👍 1`) with who left them in the tooltip. The header's one action is **Squash and
merge** (`.btn.pri`, between the state pill and Open on GitHub), shown only while the
pull request is open: one click runs `SB.mergePr` with the head on screen, the button
reads `Merging…` until gh answers, an ok bar says `squashed and merged #218 into main ·
deleted TASK-352 on GitHub` (a warning instead when the branch could not be deleted, the
merge having happened either way) and the screen asks GitHub again, so the pill reads
Merged and the button goes. A draft
or a conflicting pull request shows the button disabled with the reason in its tooltip.
Exports `render`, `refresh(hard)` (app.js: a focus revalidates a
listed PR softly, ⌘R asks GitHub again for either flavour) and `failure(error, {retry})`,
the gh failure bars the list borrows.

### R12 `views/prs.js`
The Pull requests screen (§4.12), the rail's row under Grid. Header: `Pull requests`,
the login at the right, the ↻ (`.ib`, spinning while gh answers), `3 open pull requests
· updated 40s ago` ticking under it. Body: one `.prr` row per pull request — the repo
in the name column (widened to the longest, as the workspace screen does), `#81` and
the title, then only the state worth a glance: `Draft`, the review verdict, a dot for
the last commit's checks, `3 comments`, `1d ago`, a chevron. Sorted by activity, newest
first. A row opens the pull request by number with its Overview up; Esc comes back.
A refresh keeps the rows on screen while gh answers, and a refresh that fails keeps the
last good list up under a one-line "couldn't refresh" bar rather than blanking it; the
full-width `brew install gh` / `gh auth login` bars are only for a list that never
loaded. Empty: `no open pull requests`, with Open on GitHub. Exports `render` and
`refresh(hard)`.

### R13 `views/editor.js`
The Editor tab (§4.14; added 2026-09-26, the user's ask). The shared header, and below
it one dark (or light — §4.8) slab: the file tree on the left, the tab strip with the
full-screen button at its far right, the editor, and a one-line status (`Ln 21, Col 73
· Spaces: 2 · TypeScript`, and the repo with its branch).

```js
SB.views.editor = { render(state), editAction(action, text), onKey(e), refresh(fetch),
                    relayout(), dirtyCount() }
```

**The root is persistent, and it is the same element every time.** Everything in it —
the Monaco instance, its models (one per open file, so each keeps its own undo stack and
view state; keyed `sb://ws/<encoded workspace id>/<repo>/<path>`, the id in the path
because Monaco lowercases an authority, and `Demo` and `demo` then shared every model —
opening a file in one disposed the other's live buffer as stale), the tabs, the tree's
expanded folders — lives in one record per workspace in the module's own `Map`, never
on the route (`normalize()` keeps no such fields) and never in `SB.state`. `render(state)` is called on every app render — a window focus, a
bell, a run state — and never rebuilds any of it: it returns that workspace's root
(`div.view.edview`, `.hd` then `.bd.pane.edbd` holding the slab) and only swaps a freshly
built header into it in place, putting focus back at the same position when it was in
the old one. `renderMain()` sees the element it already mounted and leaves it where it
is (R2), so unlike the Terminal's re-parented host — which is blurred and refocused on
every render — Monaco is never detached at all: an open suggest widget, an IME
composition and the cursor survive. The app's own `.bar` still lands at the top of
`.edbd` and the slab lays out beneath it (in full screen it paints below the slab
instead, §4.9). When the root has just been attached again (it was not connected when
the render began) the Editor lays Monaco out, re-stats its open tabs, re-reads their
`HEAD` bases and takes focus if nothing inside it has it, on a `setTimeout` — never rAF,
which is starved while the window is hidden. The bases because `HEAD` moves without a
window focus: a commit or a checkout typed in the in-app Terminal tab is the same
window, so `refresh()` never hears of it, and the change bars must be drawn against the
`HEAD` there is now. It never disposes an editor with unsaved changes; in fact it
disposes none.

**Monaco loads lazily, once.** No `<script>` for it in `index.html` (R1: its AMD
`define` would hijack the xterm bundles). The first Editor open appends
`min/vs/loader.js`, points `require` at `min/vs` and requires `vs/editor/editor.main` —
measured at ~55 ms in this window. It sets up its own Blob workers that
`importScripts` the `file://` worker files, which work in this sandboxed,
contextIsolated renderer (the editor worker is what gives word suggestions and link
detection). A load that fails shows `the editor did not load` with Try again, never a
broken screen.

**`editContext: false`, and it is required.** Monaco 0.57 defaults to the EditContext
API, whose focus target is a DIV — measured. `typing()` in `app.js` only counts INPUT,
TEXTAREA and contentEditable as typing, and the textarea is what `renderMain()`'s
refocus and the Esc rules were written for; with a DIV, Esc inside the editor would be
a step back.

**The language services are off.** There is no project behind a file here — no
`tsconfig`, no `node_modules` the worker can see — so TypeScript's diagnostics paint
"cannot find module" over every import. `setModeConfiguration` turns off completions,
hovers, diagnostics, formatting and the rest for TypeScript, JavaScript, JSON, CSS and
HTML right after the load (JSON keeps its tokens, its colouring coming from its own
main-thread tokenizer). Measured: none of their workers ever starts, while syntax
colouring (the Monarch grammars), word-based suggestions and links all still work.
Two themes, `sb-dark` and `sb-light`, are built from `term-theme.js`'s palette and the
mock-ups, and one `onChange` listener switches them (§4.8).

**Keys.** `onKey(e)` answers only on the Editor's own route (R2 asks it first): ⌘S
saves the active file; ⌘P opens Go to file; ⇧⌘F opens Find in files; Esc closes the
palette, or leaves the find field for the previous tab, or leaves full screen, and is
otherwise the app's. Monaco consumes Esc itself — closing its find or suggest widget,
dropping a selection or extra cursors — and stops it there, so the second Esc is the one
that leaves full screen (measured). None of the three is a menu accelerator and Monaco
binds none of them, so they reach the window (measured for ⌘P-class keys); Monaco keeps
⌘Enter, ⌘F, ⌘D, ⌘/ and the rest, and ⌘1–9, ⌘0 and ⌘. keep their app-wide meaning as in
the Terminal. `editAction` (§4.7) takes Copy, Paste, Select All, Undo, Redo and Cut when
focus is in one of its roots — in Monaco, or in its palette and find fields, which the
menu's ⌘V would otherwise never reach; Copy with nothing selected copies the whole line,
as Sublime and VS Code do, and pasting that same text puts it on a line of its own —
and Close when a file tab is open and focus is in the Editor or nowhere at all.

**The tree** is `sb.codeTree` — one top folder per repo, `git ls-files`: the files git
shows, plus the files `.gitignore` keeps out of it (`.env.local`, a local config)
drawn dim with "ignored by git" in their tooltip, ignored folders left out whole
(§4.14); a submodule, an untracked nested repo or a linked worktree is a single row
like a file's, and opening it says it is a folder — drawn lazily (only expanded
folders' children, at most 2 000 in one folder with a "⌘P to find them" row after).
One focusable element with a roving active row, not a button per row: a repo can hold
tens of thousands of files. The git letters (`M` `A` `D` `R`) and the amber dot on a
folder holding changes come from the scan the app already refreshes (`Repo.files`),
not from a git call of its own. Its width is remembered in `localStorage`, as are each
workspace's open tabs (at most 30), the active one and which of them are previewing
(below), reopened lazily the first time that workspace's Editor is shown; a file that
no longer reads is dropped quietly.

**Making, renaming and removing a file** (§4.16) hangs off that same roving-row tree,
so none of it is a per-row button: the heading carries a New file and a New folder, and
a right-click on a row opens the menu (`Open`, `New file…`, `New folder…`, `Rename…`,
`Delete`, `Copy path`, `Reveal in Finder`; no Rename or Delete on a repo's own row — that
is the workspace, not this Editor's to bin). The menu is placed against the SLAB, not
inside the tree: the tree scrolls and clips, and a menu in it would be cut off at the
first row. Naming is a one-line field standing exactly where the row will be — first
inside its folder for a new one, since the tree is sorted and the name is not known yet,
and in the row's own place for a rename, with the stem selected and the extension left
alone as Finder does. `↩` commits, `esc` cancels, and a blur decides deferredly, never
from the event: Chromium blurs a focused element BEFORE a rebuild detaches it, so a
re-listed tree arriving mid-word looks exactly like the user clicking away (the same trap
the Grid's name field is written around, R10). Delete asks in the Editor's own bar, with
`Move to Trash` as the button `↩` presses — never a dialog — and says so when an open
file under it has unsaved changes. A rename with an unsaved tab under it is REFUSED
(`save <name> before renaming it`): every affected tab is closed and reopened at the new
path afterwards, which is the only way a Monaco model's URI follows its file, and a dirty
one cannot survive that. An empty folder is the one thing `git ls-files` cannot report —
it lists blobs — so a folder made here is remembered in the editor's own `newDirs` and
folded back into every re-listing for as long as the window lives; a relaunch forgets it,
exactly as git has.

**Markdown preview.** A tab whose file name Monaco's markdown language would claim
(`.md`, `.markdown`, `.mdown`, `.mkdn`, `.mkd`, `.mdwn`, `.mdtxt`, `.mdtext`) gets an
eye beside the full-screen button, and the eye (or ⇧⌘V) swaps the source for
`SB.markdown.render(text, { breaks: false })` (R3) in a scrolling pane that stands
where Monaco does — `visibility`, not `display`, so the model stays attached
underneath and the switch back is instant; ⌘S still saves it, ⌘W still asks. It is per
tab, remembered with the tab, and off by default: this is an editor. The pane renders
the buffer, unsaved edits included, 250 ms after the last keystroke while it is on
screen and again whenever the text moves (a reload in place); an activate that finds
the same model version repaints nothing, so a README is not re-rendered for a bell. Its
scroll position is the tab's own. Links: `http(s)` opens the browser (markdown.js's
own click); `#a-heading` scrolls to the heading whose GitHub-style slug matches; a
relative path opens that file in a tab when the tree lists it (`/docs/x.md` from the
repo's root, as GitHub reads it); any other scheme does nothing — decided in the capture
phase, before Chromium could navigate the window to a relative URL. Images stay their
alt text, as in a comment: the renderer has no road to a file on disk, and none is
being opened for this. A file over 1 MB is not rendered (`too long to preview`). Opening
a file at a line (a find result, `name:42`) turns the preview off for that tab — a line
is a place in the source. The pane is focusable and its text selectable, so ⌘C copies a
selection through `handleEdit`'s document fallback (R2); the status bar reads `Preview
· Markdown` in place of the cursor position.

**Saving and the disk.** ⌘S writes through `sb.codeWrite` with the mtime the file was
opened at; a conflict asks in the Editor's own one-line bar — `x.ts changed on disk since
you opened it`, Overwrite or Reload. ⌘S on a clean tab writes nothing at all: it is a
key pressed out of habit, and rewriting a file nobody edited is what §0 rules out
(Overwrite, Save again and a deleted file's tab still write). After a save the workspace
is re-scanned (debounced), so the header's count, the tree's letters and the Changes tab
catch up. An outside change to an open file — seen by the 3 s stat poll while the
Editor is on screen and the window focused, or on a window focus — is applied to a
clean buffer as one minimal edit (the common prefix and suffix kept), so the cursor and
the scroll stay put; a dirty buffer is never clobbered — the bar offers Reload or Keep
mine — and a file deleted under a tab strikes the tab through and offers Close or Save
again. "Clean" is checked twice: when the stat answers and again when the read does, by
the model's alternative version id — whatever was typed while the read was in flight is
the user's, so that reload is not applied and the same "changed on disk" bar goes up
instead. The bar's Reload is the user saying discard mine, and it does. Closing a dirty
tab asks Save, Don't save or Cancel. That bar is `.edbar`, inside the slab, and not the
app's `.bar`, so the "never two bars" rule in `applyNotice` is untouched. Whenever the
number of dirty files changes it goes to main (`sb.codeDirty`), which asks before a
close or a quit.

**Line endings.** Monaco makes every line of a model end one way — the majority's, CR
and CRLF counted together against LF — so a file on disk that mixes them, or holds a
bare CR, would be rewritten on Save beyond the lines the user touched. Such a file is
noticed when it is read (opened or reloaded), and its first save asks in the bar
instead: `x.ts mixes line endings — saving makes them all LF` (or `CRLF`), Save anyway
or Cancel, and only Save anyway writes. The bar takes no focus — ⌘S is typed
mid-sentence, and a focused button would take the next Space — and the close question's
Save goes through it before the tab closes. The yes lasts until a save lands (the disk
no longer mixes) or the file is read again, so an Overwrite after a conflict does not ask
twice. A reload into a live model picks its line ending by the same majority rule, never
"any CRLF", so one stray line does not turn a mostly-LF file into CRLF on the next save.

**Undo steps.** A save ends one (`pushStackElement` right before the text is taken), or
the ⌘Z after a save took back text typed before it too, the saved part included —
measured. A reload's edit is a step of its own, with a stop either side, so one ⌘Z never
takes back the outside change together with the user's typing.

**Markers** are the mock-up's 3px bars left of the code: green for added lines, amber for
modified, a small red triangle where lines were deleted — each open file diffed against
`sb.codeBase` (its `HEAD` version) by lines, CRLF-blind, 250 ms after the last edit (common
prefix and suffix, then Myers with a cap past which the middle is simply "modified"). A
file not in `HEAD` is all added; a binary or oversize base draws nothing. The base is
read when the file opens and again on `refresh()`, on every re-attach (above) and after
an outside change is reloaded in place — a file changing on disk is exactly when `HEAD`
may have moved too (a checkout, a pull, a reset); a sequence number drops a stale answer.

**Go to file** (⌘P) is an overlay inside the slab, mounted once and toggled — never
through a render: a fuzzy match over `repo/path` that favours runs, segment starts and
the file name, recent files first on an empty query, `name:42` to land on a line.
**Find in files** (⇧⌘F) is a pseudo-tab, "Find results": `git grep` over every repo
(`sb.codeSearch`), `Aa` and `.*` toggles, results grouped by file with every match
highlighted, a click opening the file with its first match selected (`column = offset +
start + 1`), or at the line's start when there is none. The highlights are main's
`ranges` (§4.14): the renderer never compiles the user's pattern — a JS `RegExp` here
could backtrack for hours, and nothing in the window could stop it — and takes a span
only while they come in order, do not overlap and fall inside `text`; a line main ran out
of time on, or a main with no `ranges` at all, shows unhighlighted. It searches what is
on disk — unsaved buffers are not searched, and its field says so. A file dropped on the
slab is refused rather than navigating the window.

---

### R15 `views/whiteboards.js`, `views/wbterminals.js`, and the bundle in `src/diagrams/`
The Whiteboards screen and an open board (§4.17). `views/whiteboards.js` is the
classic-script seam: it draws the home and a board's header and keeps the canvases. The
editor is the React bundle, one instance per open board. `views/wbterminals.js`
(`SB.wbTerminals`) is the terminals over each board.

**The Whiteboards screen** (`{view:'whiteboards', folder}`, mock-up screen 1) is built
fresh on every render, like Pull requests, from `SB.load('wb:index', whiteboardsList)`.
Header `.hd.tight`: `Whiteboards`, **New folder** and **New whiteboard**, and under them
`N whiteboards · K folders · A archived`. Body: two columns. On the left, the folders —
`All whiteboards` with its count, `Recent` (the twelve edited last), the heading
`Folders` and a row per folder with its count and, on one the migration made and nothing
has touched since, a `moved` chip; `No folder` only while something is in it (and while
a board is being dragged, as somewhere to drop it); `Archived`, dimmed. A folder row's
`…`, shown on hover or focus, holds Rename (an inline field) and Delete, disabled with
`Move its N whiteboards out first` while anything is in it. On the right, a row per
board: a mini preview drawn from `thumb`, the name, and `Edited 2h ago · 12 boxes ·
answers read` with a pill per workspace (or `· no answers yet`) — in All, Recent and
Archived the folder's name first. **Open** is the one action and the whole row opens
it; a row dragged onto a folder row, or No folder, moves there. A folder row takes only a
drag that carries a board (its own drag type, the id read from the drag itself), and a
drag ends on any drop or dragend the window sees, the next press, or a move with no
button down: a render mid-drag detaches the row, Chromium sends a detached source no
dragend, and a drag left stuck would have moved that board on a later, unrelated drop.
The folder column scrolls on its own, so a long list of folders never pushes Archived
out of reach. New folder and New
whiteboard are inline fields — the second at the top of the list, `Lands in <folder> ·
Enter to create, Esc to cancel` (No folder from All, Recent and Archived), writing
`SBDiagrams.blankSpec()` and opening the board. Only Enter or Create makes one: on blur a
typed name stays in its field, since committing there would let a click on a row open
one board while the field made and opened another. The fields — their text and caret —
the open menu and the last write's error survive re-renders the way the Grid's name
field does (R10, `whenReleased()` included). At most one bar sits above the columns: a migration that stopped
(`Your diagrams couldn't all be moved: … Nothing was deleted`, with **Try again** —
`whiteboardsMigrate()`), else the one-time notice (`Your workspace diagrams moved here.
Each project's diagrams are in a folder of its name. Drag a whiteboard into any folder,
or make new folders.`, how many files could not be read and where they were left, and
**Dismiss**). A write that fails is a warn bar over the list in main's words, and the
field keeps its text. The empty states are the mock-up's: `No whiteboards yet`,
`Nothing in <folder> yet`, `Whiteboards you edit show here`, `Nothing archived`.

**An open board** (`{view:'whiteboard', board}`, mock-up screen 2) is a persistent root
like the Editor's (R13): the same element comes back on every render, so the canvas,
its xterms and focus never see a teardown. Its header is swapped only when what it says
has changed (`putHeader`, against a signature of `headerOf()`'s plain data): the editor
reports every write, autosave included, and a header rebuilt for each took the crumb
from under a press — mousedown on the old span, mouseup on the new, no click. The body
loses only what is neither the slab nor app.js's notice bar (`[data-sb-notice]`), and the
slab is appended only when it is not already there: taken out and put back on every
render while a notice was up, it lost focus and a `<webview>`'s page. Header: the
breadcrumb `Whiteboards › <folder> › <board>` — `Archived` or `No folder` in the middle
for a board listed there, the first two going to the home on that folder — the board's
name, and `Saved locally · 12 boxes · answers read sample-2 and example-1` (or `· no
answers yet`), with `· 2 terminals` while any are open and `· archived`, fed by
`onBoardChange` and the terminal layer. No workspace tabs. Body: the board's slab.

**Canvases are keyed by board.** One `SBDiagrams.create` instance and one `.dgslab` per
board, moved between the board's screen and a Grid square — and onto `<body>` for its
full screen, `position: fixed` and `no-drag`, since the slab then covers the header's
drag region, which Electron still counts — and never remounted by a render. The slab is
focusable but never tabbed to (`tabindex="-1"`, no outline): a press on empty paper
leaves the keyboard there rather than on `<body>`, from which a Grid render's landing
focus would hand it to the first terminal square. At most
eight live at once: the least recently shown that is off screen, not full screen and
holding nothing unsaved is let go — its layer destroyed, every shell living on, and its
editor flushed and destroyed after the current task, since that is often a callback from
inside the editor. A canvas let go is marked dead: the editor's callbacks are silenced
for the gap until its destroy (`kept()`), so a late dirty flag or slot list never lands
on a new canvas for the same board, and no terminal layer is attached to it again. A
full-screen board goes back once the route moves on. After Delete, or Back, the board's
own screen goes to the list it was in — its breadcrumb's: its folder, No folder, or
Archived (`listedIn`); and only `info.missing` makes it gone for the session, refused by
every Grid square, while one that merely couldn't be read is let go and opens again
once fixed (in a square, `SB.views.grid.chooseAgain`, R10). A board switched inside a
square takes the keyboard with it when the old one had it: `activeGrid` names the new
board before `replaceBoard()` renders, and `holdFocus()` focuses its slab before grid.js's
deferred landing looks, so the next → is not typed into a shell. `renderMain()`
tells the view after every render which canvas is visible (`shown(route)`). Only the
active canvas handles document shortcuts — in Grid, focus or a pointer press selects
it — and hidden canvases turn their keyboard handlers off, so Backspace in a Terminal
cannot delete boxes on another canvas. `shown()` also rebuilds `workspaceStatus` (each
workspace's rail dot and, once scanned, branch), pushes it only to canvases on screen and
only when it changed, and gives every layer its turn (`layer.shown(visible)`). The seam:
`SB.views.whiteboards = { render, mountGrid(boardId, cell), shown, onKey, editAction,
refresh, flushAll, toggleTerminalShortcut, terminalShown(wsId), terminalFocused(wsId),
boards(), lastFolder(), api(boardId) }`, `api` for the smoke harness and the browser
tests only. Main's flush (`sb:evt:diagramsFlush`), the window's blur and `pagehide` all
write every board.

**Terminals over a board** (mock-up screen 4) are a layer per canvas,
`SB.wbTerminals.attach({ boardId, slab, getApi, getBoard, onChange })`, which puts three
layers in the slab as SIBLINGS of `.dgcanvas`, never inside the React tree: Tailwind's
reset stays off xterm, the editor's keys stay off a shell, and every element a terminal
lives in is marked `[data-wb-terminal]`, which is how ⌘A, Esc and the Edit menu's guards
know to leave it alone. Inside `.dgslab` — its own stacking context, `z-index: 0`, under
the bundle's portal — they are `.wbpins` (55), `.wbterms` (60) and `.wbtray` (61). A layer
is `open(wsId)`, `toggleAll()`, `pick(anchor?)`, `slots(list)`, `float(wsId)`,
`removed(wsId, reason, rect)`, `shown(on)`, `shows(wsId)`, `focused(wsId)`,
`contains(el)`, `list()`, `tile()` and `destroy()`; its owner for `place()` is
`'wb:' + boardId` (R8). Its styles are a sheet of their own, `wbterminals.css`.

* **Floating panels**, one per workspace and any number at once (`section.wbterm`,
  `role=group`, `<ws> terminal`). The header: the terminal icon, the workspace,
  `~/…/folder · branch` small (`.wbterm-where`: a long folder is cut from its START —
  right-to-left with left-to-right marks — and the branch keeps its width until the
  folder is gone) — the folder from `whiteboardsWorkspaces()`, cached, since the
  renderer has no home directory; the branch once a scan has said it
  (`SB.ensureScanned`) — the rail's dot with its title (`Running`, `Claude finished a
  turn`, `Failed`, `Has changes`), then **Pin to board**, **Minimize** and **Close**. A
  panel drags by its header and resizes from four edges and four corners, at least 300 ×
  180, kept inside the slab, never above the canvas bar — the measured top of the React
  Flow pane, else just under Actions; dragged there it would cover the one way back to
  Open terminal… — and, in full screen, below the traffic lights (56 px); a panel
  restored before the bar is drawn is fitted again once it is (`refitSoon`). The pty is
  resized once, on release (`hold()`). A gesture's end is listened for on the window,
  not the handle (`track()`): a panel hidden by ⌘A, minimized or closed mid-drag leaves
  the handle hearing neither its pointerup nor its lost capture, and it would go on
  moving the panel whenever the pointer passed; hiding a panel ends its gesture at once
  (`endGesture`). A press anywhere brings it to the front. The first opens against the
  right edge under the bar, 560 wide and up to 420 tall — shorter on a short slab, to
  clear the zoom controls the tray lifts; each next one 28 px down and LEFT of the last
  one opened (stepping right would only pile them against the edge), keeping the 16 px
  margin; off the bottom the next column starts under the bar one more step left, and a
  last panel dragged to the left edge cascades right. Keys in a panel go to
  `SB.views.whiteboards.onKey` first (⌘A) and then stop, so ⌘1–9, Esc-to-go-back and the
  canvas shortcuts never fire while the user types into a shell; the wheel stays in the
  panel. Opening one notes the workspace (`whiteboardsNoteWorkspace`) and focuses its
  terminal. Minimize folds it into the tray and Close takes it off the board — both
  detach it rather than hide it, so the host is free for anyone else, and neither ever
  closes the shell: the tmux session lives on, as it does when the Terminal tab is left.
  Focus goes to the next panel, else to Actions. The arrangement is this Mac's, not the
  board's: `switchboard.wb.terms.<boardId>` in localStorage, `{ hidden, items: [{ wsId,
  minimized, open, rect }], grids? }`, restored when the canvas is made, less any
  workspace that has left the rail — asked of main again first when this session's list
  does not name one, since that list may predate it. `grids` is `{ <wsId>: { cols, rows,
  w, h, font } }`: the cols/rows each pinned terminal was fixed at, with the node size
  and font they were worked out for. The node is in the board file; its grid depends on
  this Mac's font metrics and is what the tmux session still has, so a board reopened at
  another zoom gives a pinned terminal that grid back rather than fitting a new one
  (`savedGrid`), and a relaunch resizes no pty.
* **The tray**, bottom right, while the board has any terminal and ⌘A has not put them
  away: `Terminals`, a chip per terminal that is open (solid), minimized (dashed, with a
  restore chevron) or pinned (a pin), each with its dot; then **Tile**, the open panels
  side by side along the right edge, in the left-to-right order they already had, 8 px
  apart, from under the bar to above the tray and the zoom controls, each
  `clamp(62% of the width / n, 300, 560)` wide; and **+**, the same picker as Actions ▸
  Open terminal…, which a second press puts away (the bundle swallows a press on the
  picker's anchor; `addPressed`/`addClicked` cover a + that has moved since, so a click
  whose own press closed the picker opens nothing). `pick()` never opens a second picker
  over its own open one — a keyboard + or ⌘A leaves it, typed text and all. A chip
  restores its terminal or brings it to the front, or for a pinned one pans to its node.
  Closing a panel removes its chip; chips have no ×. While the tray shows it lifts React
  Flow's zoom controls above itself (`.dgslab:has(> .wbtray:not([hidden]))
  .react-flow__controls`, 64 px), and it never runs under the undo/redo/Saved strip in
  the middle: its width is capped at the room right of that strip (`fitTray`, a
  ResizeObserver on the strip, which grows while an answer is on its way). Only the chips
  scroll (`.wbtray-chips`), so Tile and + stay in reach; squeezed, the word `Terminals`
  goes first (`.tight`), then the chips fade at the edge (`.scrolls`). The tray's keydown
  rule lets the whiteboard view see a key first (⌘A), then stops Esc only — it is not a
  shell, so ⌘1–9 and ⌘R still reach the window from Tile or +.
* **⌘A** is `toggleAll()`: the open panels and the tray go away together and come back
  together; with only minimized ones, they are restored; with none, it opens the board's
  workspace, or the picker when the board has none or its workspace has left the rail —
  which this session's list, fetched once, cannot say on its own: a workspace it does
  not name is asked of main again (`knownFresh`, once however often ⌘A is pressed
  meanwhile) before the picker opens. Pinned terminals are board content and stay. It is
  the Edit menu's Select All (§4.7), so it arrives even from an xterm's helper textarea;
  a text field, a contentEditable, a menu, a dialog, a listbox and a `<webview>` keep
  Select All.
* **Pinned terminals.** **Pin to board** — disabled on an archived board, `Unarchive the
  whiteboard to pin` — passes the editor the panel's rect AND its terminal body's
  (`pinTerminal(wsId, rect, body)`), so the node is laid out with its slot's body on the
  panel's body; when that slot arrives the SAME body element moves from the panel into
  an overlay, `.wbpin`: no remount, no clear, no reconnect, the cols/rows it has kept and
  its font the node's, and the overlay's xterm padding at zoom 1 the panel's own
  (`calc(var(--wbz) * 12px) calc(var(--wbz) * 16px)`), so the text does not move and the
  pty is not resized. The node's **Float** is `float(wsId)`: `unpinTerminal` answers
  where the node was, and the panel that opens there is lined up so its body covers where
  the terminal's text was on the board (`bodyOnBoard`, read before the node goes;
  `alignBody`, measured, one pass) — the exact inverse of the pin, since the node's outer
  rect is the body plus its header and insets, and a panel put there drifted and gained a
  column on every Pin → Float. It is back at 12.5 px and fitted to the panel — the one
  pty resize floating costs. Focus follows the terminal both ways: pressed from a panel
  that had the keyboard, or from the node's own header, the moved terminal is focused.
  Each slot is laid with integer `left/top/width/height` in the `.wbpins` layer,
  which is clipped to the pane — NO transform on any ancestor of the xterm, which would
  blur its text and throw its mouse coordinates off — at `round4(slot.font)`:
  quarter-pixel steps, smooth enough to follow a zoom and coarse enough that a pan never
  re-measures, the xterm's padding scaled to match (`--wbz`). The cols/rows are fixed at
  pin time and worked out again only when the node's committed size changes
  (`propose()`, `setFixed()`), so a zoom never resizes the pty; while a resize handle is
  held, fits are held. Only this layer's own Pin keeps the panel's grid (`t.pinning`
  says so): a node that comes back any other way — an undo or redo of a Float or a Pin —
  brings its own size and font, which that grid was never fitted to, so it gets the grid
  saved for that size and font (`grids`), else one fitted once at the node's font, never
  the panel's. A size committed while the node could not show its terminal (below the
  font floor, folded, minimized), or by an undo of one, drops the old grid (`takeSize`),
  so it is neither clipped into the new box nor saved under the new size. `covered`
  hides the overlay — `visibility`, no detach, no refit — while the canvas's own floating
  UI is over it; `live: false` detaches the body and the node draws its own card. What
  the canvas draws over a pinned node is cut out of its overlay, which sits above the
  whole canvas: the slot's `holes` (the tool rail, the undo strip, the zoom controls),
  and the box — ring and handles included — of every pinned node stacked above it, as
  `clip-path: path(evenodd, …)` in the overlay's own integer pixels (a clip, never a
  transform; a clipped-out area takes no pointer, so the chrome under it is clickable).
  Overlapping holes are first split into pieces that do not overlap (`disjoint`), since
  evenodd would fill their overlap back in. The overlays' z-index follows their nodes' —
  the slot's `selected` first (a frame ahead of the DOM), then React Flow's z-index, then
  document order — so where two overlap, the one drawn on top owns the keyboard and the
  pointer. A pinch (ctrl+wheel) over an overlay is handed to the React
  Flow pane, so zooming works wherever the pointer is; a plain wheel scrolls the
  terminal. `removed(wsId, 'undo', rect)` floats the terminal again where its node was,
  lined up on its body as Float is (read while the overlay is still over the node: the
  editor reports it from inside its undo); `'delete'` closes it. A slot that vanishes with
  no event — the editor unmounted — just lets the terminal go, and it comes back with the
  editor's next list.
* **Place, and yield.** A layer calls `place()` only from `shown(true)` and from the
  user's own actions while it is on screen; slots and a restore only build and position
  DOM, and a board off screen never moves the host. A body is placed again only when its
  shell changed or it no longer holds the xterm; where another host has it the body
  shows the stand-in (R8). The stand-in's Show here tells every other layer at once
  (the module's `layers` registry, `{ repaint, lost }`), so the board it was taken from
  draws its own stand-in now rather than at some later render.
* **Bells and retiring.** `focusin` in a panel or an overlay marks that workspace's
  bell read; a panel merely open keeps its dot (R2's `bell()`, §4.10). `terminalShown(wsId)`
  keeps `retirePanes()` from disposing a pane that a board on screen is showing.

**Keys.** app.js asks `onKey` after the Editor: ⌘A shows or hides the board's terminals;
Esc (`escape()`) is the board's, never a step back, when something already answered it —
`defaultPrevented`, or a target no longer in the document: a Radix dialog or menu closes
on that very keydown in the capture phase, so by the window its Cancel is in no document
at all — and it leaves a Radix picker, menu or dialog to Radix; it leaves a full-screen
board before it means anything else; and inside the board — the canvas, its bar, the
terminals' tray — it never leaves the board, on its own screen or in a Grid square, nor
from the page itself on the board's own screen: the canvas has had its turn, and one Esc
too many must not throw the user out; leaving is the breadcrumb or its caret. ⌘↵ (or ⌘I)
over the canvas is ✦ Answer (the editor's own listener) and never Start. `onKey` leaves
alone anything inside a terminal (`[data-wb-terminal="<ws>"]`, a panel or a pinned
overlay) and, but for ⌘A and Esc, the tray, which carries the attribute with no
workspace — it is board chrome; `editAction` ignores both.
The editor's own Esc, in the capture phase, stops propagation when it uses one, so app.js
never sees it. G opens Google Images; Esc in its search field closes the panel and goes
no further.

**Google Images** is `ImageSearchPanel.tsx`, using a `<webview>` (§4.17). Staying
mounted is not enough for it: its root leaving `#main` destroys the guest. So
DiagramsPage hands the editor `active` as `shown`, and the panel makes a new `<webview>`
when it turns true again.

**Styles.** The bundle's stylesheet is the admin's Tailwind plus React Flow's, every rule
scoped to `.sbdg` behind `:where()` and with the cascade layers flattened
(`build-diagrams.js` says why), and Radix's portals render into a second scoped root
each instance appends to `<body>` (`.sbdg.sbdg-portal-root`, fixed, z-index 1500), so a
popover escapes a Grid square's container query and clip and keeps the editor's rules
and dark theme; it is shown only while its board is active or a picker the host asked
for is open, and `destroy()` removes it. One collision that went the other way was fixed at its source:
styles.css's `.grid` (the Grid screen's 2x2) is `.gridbd > .grid` now, since `grid` is a
Tailwind utility the editor uses. styles.css's element rules reach in too, and beat the
bundle's `:where()`-scoped classes: every `aside` is the sidebar (its padding, and
`.win.norail aside` hides it), so the bundle uses no `<aside>` — the Google Images panel
is a `div` with `role="complementary"`. The canvas follows Terminal appearance, as the
Editor slab does: dark is `[data-term-theme="dark"]`. A terminal node's dot uses
styles.css's `--run`, `--chg`, `--fail` and `--link`, which must keep existing.

`npm run check:diagrams` type-checks `src/diagrams/` (esbuild builds without checking).
`npm run test:whiteboards:browser` (`scripts/test-whiteboards-browser.js`, in place of
the old floating-panel test) runs the production `index.html` and preload, the built
bundle, xterm and a real PTY (`SWITCHBOARD_NO_TMUX=1`) in a hidden Electron window, with
a main of its own: its IPC is stubbed but for the store, which is the real
`whiteboards.js` beside a temporary `SWITCHBOARD_CONFIG`. It covers the rail screen and
its list, opening a board, Open terminal… floating the Terminal tab's own xterm, a
second panel from the tray (whose + also puts its picker away) cascading down and left,
Tile, minimize and restore, Close keeping the shell, ⌘A, the tray leaving the zoom
controls clickable, Pin keeping the same xterm, cols/rows and text position (slot body
on the panel's body) while the overlay follows a pan and a zoom, the pinned node in the
board file, Float landing on the node's body, Undo putting the node back with a grid that
fits it and Redo floating it where its text was, Select All kept by Markdown and labels,
full screen and leaving right after it, a Grid square showing a whiteboard, and a
panel's exit footer and retry. A
product bug it has found is listed in its `KNOWN_BUGS` by check name: the run reports it
and passes only while it still fails, so a fix says to take it off the list.

### R16 `views/settings.js`
The Settings screen (§4.18): a plain view, rebuilt on every render like Usage. One
section today, ✦ Answer on whiteboards — `Who answers a box's question on a whiteboard.
Claude Code and Codex use their own sign-in and read the workspace you pick for each
whiteboard; the two APIs need a key and see only the whiteboard.` — a row per provider
(the radio that makes it the one ✦ Answer uses, its name, what it does — `Reads the
whiteboard's workspace first · slower` or `Only the whiteboard · fast` — whether it is
ready on this Mac, one action),
and under an API's row, opened by Add key / Edit, its key field, its model and (OpenAI)
its effort; after the list, the Web access and Subtext switches, a whole row each (the
✦ Answer menu has the same two). It asks main on the way in (and looks for the CLIs again after 30 s away),
follows `sb:evt:answerStatus`, and never holds a key: the field is sent to main on Save
and emptied.

## 7. Screens (from the mock-up — `out/01.html` … `out/07.html`)

1. **Workspace / Changes** — header: name, `Pull main`, `Start`/`Stop` (the mock-up's sub
   line `TASK-352 · 6 changes · 1 repo behind main · ● running 14s` was cut, see R4). Segmented `Changes | Logs | Terminal |
   Editor | Databases` (R4; the mock-up predates the latest tabs). One row per
   repo: name (150px), branch pill (`⎇ TASK-352 #218`), refresh icon button (only when on
   main), summary button (`4 files +84 −3 ›`) when it has changes else plain state text
   (`up to date` / `2 behind`), and — when running — its link(s) right-aligned.
2. **Logs** — the same header, a dark terminal filling the body.
3. **Files** — breadcrumb `‹ sample-2 › Files`, `6 files changed · +131 −24`, segmented
   `Files | All diffs`, rows grouped by repo with status letter, path, `+n −n`, five-block bar.
4. **Diff** — breadcrumb `‹ sample-2 › Files › src/services/filters.ts`, sub line
   `sample-api · TASK-352 · +9 −2`, the diff.
5. **All diffs** — stacked file cards, each with a header (path, `+n −n`) and its diff.
6. **Pull request** — breadcrumb `‹ sample-2 › sample-api › Pull request` (or `‹ Pull
   requests › sample-api › Pull request` from the list), title + `#218`, `Open` pill,
   `Squash and merge` (while open), `Open on GitHub`, sub line `TASK-352 → main · 3 commits · 3 files · +22 −3 · 3 comments ·
   approved · pushed 2h ago`, segmented `Overview | Files | All diffs`. Overview: two
   halves — left, the description as a card with its reactions at its foot; right, the
   conversation — comments, reviews with their verdict, each review's inline comments
   nested under it with `path:line` linking into All diffs. All diffs: the diffs with review comments inline under the
   lines they sit on.

8. **Terminal** — the same header, segmented `Changes | Logs | Terminal | Editor | Databases`, and a
   dark terminal filling the body: a login shell in the workspace directory. When the shell
   has exited, the `.exit` footer from screen 2 with a single `New shell` button. A bell
   from a background workspace's shell (Claude finishing a turn) turns that workspace's
   sidebar dot blue until its Terminal is looked at — the same one dot the row already
   has, never a second one.

9. **Usage** — header `Usage` with the plan at the right and `updated 40s ago` under it;
   one row per limit: `Session`, `This week`, `Fable this week` — name, bar, percent,
   `resets 5:00 PM`. Reached from the row pinned to the bottom of the rail, or from the
   session gauge in the Grid's header. When there is no answer: the sentence and Try again.

10. **Pull requests** — the rail's row under Grid. Header `Pull requests`, the login at
    the right, ↻, `3 open pull requests · updated 40s ago`; one row per open pull request
    of yours in any repository: repo, `#81 title`, `Draft` / `Approved` / `Changes
    requested` when so, a checks dot, `3 comments`, `1d ago`, chevron. A row opens the
    pull request's Overview; Esc comes back.

11. **Editor** — the same header, segmented `Changes | Logs | Terminal | Editor | Databases`, and
    one slab filling the body, dark or light with the Terminal appearance. On the left
    the file tree: a folder per repo (a single repo starts open; of several, the one with
    the most changes), 24px rows, a chevron per folder, the git letter at the right of a
    changed file and an amber dot on a folder holding one, the open file's row lit. On
    the right the tab strip — name, an amber `●` while unsaved that turns into `×` on
    hover, `— dir` when two open files share a name — ending in the full-screen button;
    the editor with its 3px change bars beside the line numbers; and a status line,
    `Ln 21, Col 73 · Spaces: 2 · TypeScript` on the left and `sample-api · ⎇ TASK-352` on
    the right. With no file open: `open a file from the tree, or press ⌘P`. ⌘P is a
    centred Go to file palette over the editor (`↑↓ navigate · ↩ open · esc close · N of
    M files`); ⇧⌘F is the "Find results" tab — the query, `Aa`, `.*`, `8 matches in 4
    files`, the matches grouped by file. **Full screen**: the rail and the header are
    gone, the slab meets the window's edges, and a 38px band across its top carries the
    traffic lights, the workspace and branch, a blue dot when another workspace's
    terminal has rung, and at its right the one button that restores it; Esc restores it
    too. The tree's heading carries two icon buttons, New file and New folder, and a
    right-click on any row opens a menu — `Open`, `New file…`, `New folder…`, `Rename…`,
    `Delete`, `Copy path`, `Reveal in Finder`, with the two destructive ones missing on a
    repo's own row. Naming happens in the tree itself: a one-line field where the row
    will be, `↩` to commit and `esc` to cancel. Delete asks in the Editor's own bar —
    `move <name> to the Trash?` with `Move to Trash` and `Cancel` — never a dialog.

12. **Whiteboards** (the Whiteboards mock-up's screen 1) — the rail's row under Pull
    requests. Header `Whiteboards` with **New folder** and **New whiteboard** at the right
    and `14 whiteboards · 3 folders · 2 archived` under it; a one-time notice bar after
    the migration. Left, the folders: `All whiteboards 14`, `Recent`, `Folders` with a
    row each (count; a `moved` chip on a migrated one), `No folder` when it has any,
    `Archived`, dimmed. Right, the selected folder's name, `N whiteboards` and `Edited ⌄`,
    then one row per board: a mini preview, the name, `Edited 2h ago · 12 boxes ·
    answers read [sample-2]`, and `Open ›`. Rows drag onto folders.

13. **An open whiteboard** (screen 2) — breadcrumb `Whiteboards › sample › Search
    filters`, the name, `Saved locally · 12 boxes · answers read sample-2`; no workspace
    tabs. Over the canvas, the bar: the quick switcher (`Search filters · sample`, ← →),
    **New whiteboard**, full screen and **Actions** — Open terminal…, Show or hide
    terminals `⌘A`, Rename…, Move to folder… ›, Duplicate, Archive, Delete. ✦ Answer's
    chevron menu (screen 3) has the **Workspace** row: `sample-2`, `~/Projects/sample-2 ·
    what a CLI reads`, **Change… ›**, the short picker opening beside it; a box an
    answer made carries a `sample-2` tag under its corner.

14. **Terminals on a whiteboard** (screen 4) — floating panels over the canvas, one per
    workspace: header `sample-2 · ~/Projects/sample-2 · TASK-352`, the rail's dot, Pin,
    Minimize, Close; a dark terminal below. Bottom right the tray: `Terminals`, a chip per
    terminal (solid open, dashed minimized, a pin when pinned), Tile, +. A pinned
    terminal is a node on the canvas with the same header (Float in place of Pin), moving
    and zooming with the board; below readable size it shows `Zoom in to use`.

Clicking the branch pill opens the PR screen on its Overview. Clicking a summary button
opens Files. Clicking a file row opens Diff. The workspace name — the header title, the
breadcrumb crumb, and the name strip on a Grid square — opens that workspace's Terminal.
The back caret and Esc go back — except on an open whiteboard, where Esc on the board
itself never leaves it, and the breadcrumb's `Whiteboards` and folder crumbs are the way
back to the list.

---

## 8. Definition of done

- `npm start` opens the window on the last-used workspace with real data from the real repos.
- Start actually runs the workspace's dev script; Logs shows its coloured output live;
  Stop leaves no surviving child (verified with `pgrep`).
- Links appear as each port starts listening and open in the default browser.
- Pull main fast-forwards every repo sitting on main and reports per-repo results.
- Files/Diff/All diffs render the real working tree, including untracked files.
- The PR screen shows the real PR for the repo's branch with its review comments, and a
  clear one-line message when there is no PR or `gh` is unavailable. Its Overview shows
  the description, the conversation and the reactions — a 👍 from the Codex connector
  on the description reads as such, with the login in the chip's tooltip.
- The Pull requests screen lists every open PR of the signed-in user, in every
  repository, and a row opens that PR's Overview whether or not the repo is cloned here.
- The Editor's tree is `git ls-files` for every repo of the workspace: untracked files
  in, ignored files in but dimmed (`.env.local` opens), ignored folders out, one top
  folder per repo.
- A markdown tab's eye (⇧⌘V) shows the file rendered as GitHub would render a README —
  soft breaks folded, setext headings, reference-style links — following unsaved edits,
  and the eye again shows the source; a relative link in it opens that file.
- Save in the Editor writes exactly the file that was edited, in place — mode and
  inode unchanged — and nothing else: no git, no formatting, no other file. ⌘S on a
  file nobody edited writes nothing, and one that mixes line endings asks first.
- The Editor's change bars match `git diff HEAD` for the file, unsaved edits included —
  after a commit or checkout in the Terminal tab too.
- A file changed on disk reloads into a clean tab without moving the cursor, and a tab
  with unsaved changes is never clobbered — it asks, typing that lands while the reload
  is in flight included. Closing or quitting with unsaved changes asks once, and a quit
  that waited on a build or the dev servers asks about edits made meanwhile.
- A user's regex in Find in files cannot hang either process: a pattern that backtracks
  without end still lists git's matches, unhighlighted, after 250 ms of trying.
- The Editor follows the Terminal appearance (`effective`), repainting in place.
- Full screen hides the rail and the header; Esc or the button restores them, and the
  terminal's scrollback and focus are intact afterwards.
- The Editor's tree makes a file, makes a folder, renames and deletes: the new file is
  in the tree and open in a tab immediately and staged nowhere (`git status` reads
  `??`), a rename carries its open tab with it, a delete is in the Trash and its tab is
  closed, and `.git`, `..`, an absolute path and a symlink out of the repo are all
  refused with a sentence.
- Renaming a symlink onto the file it points at is refused, not a destroyed file.
- The first launch after Whiteboards moves every old per-workspace diagram into the
  store — one folder per project, each board answering from the workspace it answered
  from before, its documents and pictures with it — renames `diagrams` to
  `diagrams-before-whiteboards`, and deletes nothing. A run that stops part way finishes
  on the next launch, or on Try again, without a second copy of any board, and a second
  run changes nothing.
- A board's terminal — floating or pinned — is the workspace's own shell: what is typed
  there shows on its Terminal tab, the shell's `startedAt` is unchanged across Pin,
  Float, Minimize and Close, and Close leaves the tmux session running.
- A pinned terminal's text stays crisp at every zoom, the pointer lands on the cell under
  it, and panning or zooming never resizes its pty.
- Every screen matches the mock-up's spacing, type and colour.
