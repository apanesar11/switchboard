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
  and only one:** the Diagrams tab's editor (§4.17, R15) is a web admin's React Flow
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
  staged: a file made here is untracked, as it would be if a shell had made it. The
  Notes tab writes nothing in a repo at all — its file lives beside the config (§4.15). Squash and merge (§4.4) acts on GitHub
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
  src/renderer/views/grid.js    — Grid: four terminals side by side, in views     [R10]
  src/renderer/views/usage.js   — Usage screen + the Grid's five-hour gauge         [R11]
  src/main/usage.js             — Claude usage: the keychain token, the endpoint    [M7]
  src/main/editor.js            — the Editor's file access: tree, read, save, HEAD base, stat, find in files [M8]
  src/renderer/views/files.js   — Files + All diffs screens                       [R6]
  src/renderer/views/diff.js    — single-file Diff screen                         [R6]
  src/renderer/views/pr.js      — Pull request screen                             [R7]
  src/renderer/views/prs.js     — Pull requests screen: every open PR of yours    [R12]
  src/renderer/views/editor.js  — Editor tab (Monaco over the workspace's repos)  [R13]
  src/main/notes.js             — the Notes tab's one markdown file per workspace    [M9]
  src/main/diagrams.js          — the Diagrams tab's files, per workspace; pictures  [M10]
  src/main/images.js            — Google Images beside a diagram: webview, session, fetch [M12]
  src/main/answer.js            — ✦ Answer: Claude Code / Codex / Claude API / OpenAI [M11]
  src/renderer/views/diagrams.js — Diagrams tab: the seam to the editor bundle       [R15]
  src/renderer/views/settings.js — Settings screen: who answers, API keys            [R16]
  src/diagrams/                 — the editor bundle's sources (mirrored by hand)     [R15]
  scripts/build-diagrams.js     — builds src/diagrams into src/renderer/diagrams/   [R15]
  src/renderer/noteedit.js      — SB.noteEditor: a block editor over markdown       [R14]
  src/renderer/views/notes.js   — Notes tab, and the note a Grid square can show    [R14]
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

A **note** is a workspace's scratch pad: one markdown file, edited in the Notes tab
(§4.15) and kept beside the config rather than in any repo. A Grid folder square has one
too — there, the id is the folder's path.

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

Note = {                                  // a workspace's scratch pad — §4.15
  text: '# Release plan\n- ship it\n',     // markdown, one line per block on screen
  mtimeMs: 1737000000000 | null,          // null when no file has been written yet; what
                                          // the next save's conflict test compares against
  size: 46,
  missing: false,                         // true: nothing written yet, which is an empty note
}                                         // or { ok:true, tooLarge:true, mtimeMs, size } past
                                          // 2 MB, with NO text — a prefix would be written
                                          // back over the whole file by the first autosave

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
  paths, or null).

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
that workspace's Terminal tab is shown.

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

### 4.15 Notes

The fifth workspace tab, **Notes** (added 2026-09-28, the user's ask: "a place where I
can just write my own README notes … I should be able to directly write the README
inline … like how something like Notion works, where I can automatically select the
heading by doing three hashes and then it pops up … it's more for my temporary notes …
a single file per workspace"). One markdown file per workspace, edited in place: typing
`### ` at the start of a line makes the line a heading and the `### ` disappears, `- `
makes a bullet, `**bold**` goes bold as the second `*` is typed. There is no source view
and no preview toggle, because what is on screen IS the document. Out of scope on
purpose: more than one note per workspace, folders of notes, tables, images, attachments,
search across notes, and any kind of sync. The renderer side is R14; this is the channel
area `notes`.

`id` is a workspace id OR — unlike the Editor, which refuses one — a Grid folder
square's absolute path (§4.10): a square has a terminal, so it can have a scratch pad
too. `notes.js` never uses either as a file name; see the invariants below.

| `window.sb` | channel | returns |
|---|---|---|
| `sb.notesRead(id)` | `sb:notes:read` | `{ ok, text, mtimeMs, size, missing }` — `missing:true` with `text:''` and `mtimeMs:null` when nothing has been written yet, which is an empty note and not a failure. `{ ok, tooLarge:true, mtimeMs, size }` and NO text for a file past `MAX_BYTES` (2 MB): a prefix would be worse than useless, because the first autosave would write it over the whole file |
| `sb.notesWrite(id, text, {mtimeMs, force})` | `sb:notes:write` | `{ ok, mtimeMs, size, missing }` — `missing:true` in a SUCCESSFUL answer means the note is empty and no file was made. `{ ok:false, conflict:true, missing, mtimeMs, error }` when the file has moved underneath, `mtimeMs` being its current one so the renderer's Keep mine can go ahead knowingly; `{ ok:false, error }` for anything else, e.g. `could not save that note: the disk is full` |
| `sb.notesReveal(id)` | `sb:notes:reveal` | `{ ok }` — the file in Finder, or the folder when there is no file yet. The way out of a note too large to open |
| `sb.notesDirty(count)` | `sb:notes:dirty` | `{ ok }` — how many notes hold text that could NOT be written, whenever that number moves. Normally 0; the only note that ever reaches here is one whose file will not take it (a read-only folder, a full disk, a conflict waiting on an answer), and it joins `editorDirty` in the one question the app asks on the way out |
| `sb.notesFlushed(id)` | `sb:notes:flushed` | `{ ok }` — the renderer answering `sb:evt:notesFlush`, handing back the generation it was sent; see below |

**The file is beside the config, never in a repo.** `<dirname of the config file>/notes/`
— `~/.switchboard/notes/` normally, and wherever `SWITCHBOARD_CONFIG` points for a test
or a smoke, so a fixture run cannot write into the user's own. A file in the workspace
folder was the obvious other place and is wrong: it would show up in `git status`, in the
Changes tab and in the Editor's tree, and would be one `git add -A` from being committed
to someone else's repository. The point of the tab is somewhere to write an idea down
without thinking about any of that.

**Every id is hashed into its file name.** `sample-2` → `sample-2-72b8587ce3.md`,
`/Users/me/Projects/odds` → `odds-e1d2c8e200.md`: a readable stem so the folder makes
sense in Finder, plus ten hex of SHA-1 over the WHOLE id. No exceptions, and that is the
point — a scheme where some ids pass through verbatim collides the moment a workspace is
called what another id hashes to, and on a case-insensitive volume it collides for `Odds`
and `odds`. It is also why no id, however written (`../../etc/passwd`, `/etc/passwd`),
can name a file outside the folder.

**Nothing here ever deletes what someone wrote.** An empty note writes no file when
there was none — a workspace that was merely looked at leaves nothing behind — and
truncates the file when there was one. Emptying a note is the user's edit; an empty
BUFFER because a read failed or has not landed yet is not, and the renderer keeps that
apart with a `loaded` flag that no save path may run before (R14).

**A save is refused when the file moved underneath it**, exactly as the Editor's Save is
(§4.14): `opts.mtimeMs` is what the renderer last read or wrote — a number when it
believes there is a file, `null` when it believes there is none — and either belief being
wrong answers `{ conflict:true }` rather than overwriting. `opts.force` is the user's
Keep mine. There is no watcher here either: a clean note is re-read on every window
focus and follows the disk, and one with unsaved text is left alone until its next save
finds the conflict and asks.

**Writes for one note are serialised**, through a promise chain per file and a temp name
carrying a counter as well as the pid. Three things can start a save — the typing
debounce, a blur, the quit flush — and two overlapping ones through one temp path
interleave a truncate with a write, hand the file to whichever `rename` lands first, and
answer the newer one `ENOENT`. Unlike the Editor's Save this one IS a temp file renamed
over the original, and for the opposite reason: nothing else holds this file open, it has
no mode or hard links worth keeping, and it is rewritten whole every few seconds while
someone types — so the thing to guard against is a crash mid-write leaving half a note.

**An unsavable note is asked about, once.** A note writes itself, so the number main
holds (`sb:notes:dirty`) is 0 almost always and the way out asks nothing. It is not 0
when the file will not take the text — a read-only notes folder, a full disk, a conflict
the user has not answered — and then `confirmDiscard()` puts up the same one question it
puts up for the Editor's buffers, counting both. Without it the app exited in silence on
text that could never be written: the bar in the page said so, and nothing on the way
out did.

**Closing the window is the other way out.** ⌘W and the red button end the renderer
without quitting, and a note on a 400 ms debounce would go with it. So the window's
`close` holds itself for one round trip while the renderer writes (`event.preventDefault()`,
`flushNotes()`, then `close()` again, with a flag so the second pass goes through), and
only then does the question above get asked — a note that saved fine is never asked
about at all.

**The quit waits for the last keystroke.** A note writes itself 400 ms after typing
stops, so the only text at risk is the last few hundred milliseconds of it — and a page's
`beforeunload` is ignored by Electron, so the renderer cannot be asked on the way out the
way a browser would ask. Instead `before-quit`, after the publish wait and
`stopEverything()` and while the window is still live, sends `sb:evt:notesFlush` and
waits for `sb:notes:flushed` (2 s at the outside) and then for `notes.settle()`. After
the publish wait on purpose: a build can take a minute, the window stays usable through
it, and a flush at the top would miss everything typed while it ran. The event carries a
generation the renderer hands back, because a quit can be CANCELLED after a flush has
timed out — an unsaved Editor buffer, a failed `applyOnQuit()` — and the late answer to
that one would otherwise satisfy the next quit's flush instantly. The smoke harness's
own exit runs `flushNotes()` by hand for the reason it runs `stopEverything()` by hand:
`app.exit()` fires no `before-quit`.

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

### 4.17 Diagrams

The sixth workspace tab, **Diagrams** (added 2026-10-04, the user's ask: their web
admin's diagram feature as a desktop app, inside Switchboard, with its ✦ Answer using
"the corresponding workspace and the CLI tool … I should be able to select what CLI tool
it is, whether it's Codex or Claude"). Flow diagrams — boxes, arrows, sticky notes, text
and pictures, arranged by hand, Tab for the next box — in the admin's own editor, saved
as you go. The renderer side is R15; who answers ✦ Answer is §4.18.

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
layout when anything is in the way. A drag-select takes every box it touches
(`SelectionMode.Partial`). Any number of boxes can wait on ✦ Answer at once, one answer
per box: the strip says "Answering 3 boxes · Stop all", each box's toolbar stops its
own, and an answer that lands while you have moved on to another box leaves your
selection and the view alone. ⌘I answers as ⌘↵ does. Edit ▸ Copy, Cut and Paste work on
boxes: ⌘C keeps the selected boxes and the arrows between them for the bundle (any
diagram) and puts their words on the clipboard; ⌘V puts new copies down centred on the
pointer, but only while the clipboard still holds those words, so text copied since
never pastes an older copy. An arrow can be **collapsed** (`collapsed: true` on the edge in
the spec): `layout.ts foldFlow` hides what it points at and everything that can no longer
be reached from the diagram's starting boxes without crossing a collapsed arrow (loops set
aside, so a branch never folds away what leads to it); the editor hands React Flow those
boxes marked hidden, lays out and pushes as if they weren't there, shows a "+N" on the box
they are folded behind, carries them along when that box is dragged, and deletes them with
it. Unfolding re-tidies the tree around them. A diagram has **no limit** on boxes, arrows
or size (the admin's 60 / 120 / 512 KB, `types.ts` says why not here): the layout and save
paths stay in single milliseconds into the thousands of boxes. **Actions ▸ Rename**
(`RenameDiagramDialog.tsx`) writes a new name with the drawing as it stands. And the image
tool is a menu — a file, or **Google Images** (G): Google's own results in a panel docked
on the canvas's right, whose pictures drag straight onto it (below). `npm run
test:diagrams` covers the layout and folding (`scripts/test-flow-layout.js`).

**A diagram belongs to a workspace and lives on this Mac.** One JSON file per diagram —
the admin's row, `{ id, name, kind, createdAt, updatedAt, archivedAt, spec }` minus the
product — in `<config dir>/diagrams/<workspace>-<hash>/<id>.json`, beside the config like
a note and for the same reason: never in a repo, never in Changes, never one `git add -A`
from a commit. The folder name hashes the whole workspace id, as `notes.js` does. These
are not the admin's diagrams and never sync with them; the format is the same, so a spec
can be carried either way by hand.

| `window.sb` | channel | returns |
|---|---|---|
| `sb.diagramsList(id)` | `sb:diagrams:list` | `{ ok, data: DiagramSummary[] }` — archived ones included, newest-touched first, no specs. A workspace with none answers `[]` |
| `sb.diagramsGet(id, diagramId)` | `sb:diagrams:get` | `{ ok, data: summary + spec }` — the spec as stored; the bundle re-parses it with the admin's validator and shows what is wrong with one that no longer draws |
| `sb.diagramsCreate(id, name, spec)` | `sb:diagrams:create` | `{ ok, data: detail }`, or `{ ok:false, error }` — a name already taken IN THAT WORKSPACE says so |
| `sb.diagramsUpdate(id, diagramId, name, spec)` | `sb:diagrams:update` | the autosave: `{ ok, data: detail }`; `archivedAt` is left alone |
| `sb.diagramsArchive(id, diagramId, archived)` | `sb:diagrams:archive` | `{ ok, data: summary }` — `updatedAt` does not move, so archiving reshuffles nothing |
| `sb.diagramsDelete(id, diagramId)` | `sb:diagrams:delete` | `{ ok, data: { id } }` — for good; the confirmation dialog is the gate |
| `sb.diagramsSaveImage(bytes, type)` | `sb:diagrams:saveImage` | `{ ok, src }` — `sbimg://image/<file>`; see below |
| `sb.diagramsClipboardImage()` | `sb:diagrams:clipboardImage` | `{ ok, bytes, type }` — the clipboard's PNG, for Edit ▸ Paste over the canvas |
| `sb.diagramsFetchImage(url, referrer?)` | `sb:diagrams:fetchImage` | `{ ok, bytes, type, name }` — a picture from the Google Images panel, by its address, as PNG, JPEG or WebP; or `{ ok:false, error }`. See Google Images, below |
| `sb.diagramsDirty(count)` | `sb:diagrams:dirty` | `{ ok }` — 0 or 1, whenever it changes; see below |

**Pictures are kept once, by content.** A picture dropped, pasted or picked onto a
canvas is written to `<config dir>/diagrams/images/<sha256>.<png|jpg|webp>` and the image
node's `src` is `sbimg://image/<file>`. `sbimg` is registered as a standard, secure
scheme before `ready` and served by `protocol.handle` from that folder and nowhere else:
a request names a file only by a name `imagePath()` accepts (32 hex and one of three
extensions). The bundle's copy of the admin's validator accepts that one scheme beside
`https:`. Deleting a diagram leaves its pictures — another diagram may show the same one.

**Unsaved edits are flushed, not asked about.** The editor saves 700 ms after the last
change, so a close or a quit usually lands inside that wait. The admin holds the page
with a `beforeunload`, which Electron answers by refusing to close in silence; here the
editor reports whether it holds anything (`sb:diagrams:dirty`) and rides on the notes'
flush instead (§4.15): `notes.js`'s `onFlush` writes the open diagram before it answers,
and `flushNotes()` waits on `diagrams.settle()` too. A close holds while `noteDirty +
diagramDirty > 0` and flushes; only a diagram that STILL could not be written joins the
"unsaved changes" question. The quit asks about diagrams only after its flush, never
before — before it, the count is the autosave in flight.

**The Edit menu reaches the canvas.** ⌘Z, ⇧⌘Z and ⌘V are menu items (§4.7), so the
editor never sees them as keystrokes: `handleEdit` asks R15 right after the terminal, and
while the canvas has the keyboard — not a box's own text field, which gets the document's
fallback like any field — Undo and Redo are the editor's, and an image Paste fetches the
clipboard's picture and adds it.

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
which page the picture was on: Add Image to Diagram does; a drop cannot, and sends none —
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
(`attachGuest`): for a picture **Add Image to Diagram**, Copy Image, Copy Image Address
and Open Image in Browser; for a link Open Link in Browser and Copy Link Address; Cut,
Copy, Paste and Select All in a field, or Copy for a selection; then Back, Forward and
Reload. Add Image to Diagram sends `sb:evt:diagramsImageOffer` `{ guestId, url,
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

**Leaving the tab kills the page, so coming back makes a new one.** app.js takes the
Diagrams tab's root out of `#main` while another screen shows (R15), and Electron destroys
a `<webview>`'s guest as it leaves the document and never makes another when it is put
back: measured in 44.4.2, the element stays blank and every method answers "Invalid
guestInstanceId". So the editor hears `active` (as `shown`), and the panel keys a fresh
`<webview>` as the tab returns, at the last page it showed. That page is kept at module
scope, and only when main would let the panel start on it (`opensInPanel`), since a site
followed out of the results would be refused at the attach. The page's history is lost;
the page is not.

Google may answer a new session with its "unusual traffic" page; solved once, its cookie
stays in the partition (`Partitions/sb-images` in Electron's Application Support folder).
`npm run test:diagrams` covers both halves' pure parts (`scripts/test-images.js`,
`scripts/test-image-search.js`), checks the bundle's partition and start rule against
main's own, and runs `fetchImage` itself, with Node's fetch standing in for the session.

### 4.18 ✦ Answer and Settings

✦ Answer, on the Diagrams tab, puts a box's question to an AI and hangs the answer off it
as one box per part — six repos are six boxes; the admin's cap of four is gone here (40 is
only a backstop against a runaway list). The admin asks one OpenAI model; here it is any
of four, chosen per Mac — the user has Claude Code on one laptop and Codex on another:

| provider | what it is | sees |
|---|---|---|
| `claude-code` | `claude -p` in the workspace folder, `--tools Read,Grep,Glob` (plus `WebFetch,WebSearch` with Web access) and nothing else, `--permission-mode dontAsk`, prompt on stdin, `--json-schema` for the answer, `--output-format stream-json` for the steps | the workspace's code |
| `codex` | `codex exec --json --sandbox read-only -c web_search="live"\|"disabled" --cd <folder> --output-schema … --output-last-message …` | the workspace's code |
| `claude-api` | the Messages API, the answer as structured output (`output_config.format`, the schema) — not a forced tool call, which Opus 5.5, Sonnet 5.5 and Fable 5.1 refuse with a 400 — plus `web_search_20250305` / `web_fetch_20250910` with Web access, a paused turn (`pause_turn`) sent back to carry on | only the diagram |
| `openai-api` | the Responses API with the admin's json_schema format, streamed, the admin's models and probed efforts, plus `{type:'web_search'}` with Web access | only the diagram |

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
something the diagram (and the code) can't tell it; off, the tools are left out
altogether (for Claude Code, out of `--tools`: dontAsk would still let WebFetch open the
documentation sites Claude Code trusts) and the prompt says to admit a page it can't see
rather than guess. Codex's own default is a cached search, so off says `"disabled"`
outright. Should the Claude API ever refuse web search's always-on citations beside a
structured answer (a 400 naming citations), the answer goes again with web fetch alone. Links a model leaves in a box anyway are taken out (`ai.ts` `unlinked`).

**main owns all of it**: which providers exist, which models and efforts each takes,
whether each CLI is installed and signed in (`claude --version` / `auth status`, `codex
--version` / `login status`, cached a minute), the stored choice (config.json's `answer`
block), and the keys. The page names a provider and the workspace; main resolves the
workspace's folder itself (`workspaces.dirOf`) — a CLI never runs in a path the page
handed over — and reads the model and effort from the stored settings, never from the
request.

| `window.sb` | channel | returns |
|---|---|---|
| `sb.answerStatus({fresh})` | `sb:answer:status` | `{ ok, settings, providers, keysSafe }` — `settings.provider` is never null: with nothing chosen it is the first one ready (a CLI that is here, then an API with a key). `fresh` looks for the CLIs again |
| `sb.answerSetSettings(patch)` | `sb:answer:setSettings` | the status, after merging `{ provider, split, context, web, subtext, claudeCodeEffort, claudeApiModel, openaiModel, openaiEffort }` |
| `sb.answerSetKey(provider, key)` | `sb:answer:setKey` | the status — after the provider accepted the key (`GET /v1/models`); a refused key is never stored and answers `{ ok:false, error, code:'bad-key' }` |
| `sb.answerRemoveKey(provider)` | `sb:answer:removeKey` | the status |
| `sb.answerStart(id, req)` | `sb:answer:start` | `{ ok, text, files? }` — the answer's JSON, which the bundle reads into boxes — or `{ ok:false, error, code }`, `code` one of `missing`, `signed-out`, `no-key`, `bad-key`, `timeout`, `stopped`. `req`: `{ provider, wsId, system, user, schema }` |
| `sb.answerStop(id)` | `sb:answer:stop` | `{ ok }` — the CLI's whole process group, or the request |

`sb:evt:answerStep` carries `(id, { kind, text, target })` for every tool call a CLI
makes — "Reading lib/diagrams/ai.ts", "Opening example.com/docs" — which the canvas shows
in a card over its strip, so a minute's wait never looks stuck. The OpenAI API reports its
finished web searches the same way, and gets the card once it has one. `sb:evt:answerStatus` goes out after every change,
wherever it was made, so the ✦ Answer menu and the Settings screen never disagree.

**Keys never touch config.json.** `safeStorage` (the Keychain) encrypts them into
`<config dir>/keys.json` (mode 0600) beside the last four characters, which are all the
page ever gets back. Nothing logs a key; the Settings field is always empty.

**A CLI never outlives what asked it.** It is spawned detached, so Stop, the 5-minute
limit, the window closing and `stopEverything()` all signal its whole process group, the
ripgrep and shells it runs included.

**Settings** is a fourth free screen (`{view:'settings'}`, R16): App ▸ Settings… (⌘,),
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
sb.onNotesFlush((id) => {})          // 'sb:evt:notesFlush' — write every unsaved note NOW, and
                                     // answer sb:notes:flushed with the same `id`; §4.15
                                     // (the Diagrams tab's editor is written on the same flush)
sb.onAnswerStep((id, step) => {})    // 'sb:evt:answerStep' — what a CLI answering a box is doing; §4.18
sb.onAnswerStatus((status) => {})    // 'sb:evt:answerStatus' — who can answer, after any change; §4.18
sb.onOpenSettings(() => {})          // 'sb:evt:openSettings' — App ▸ Settings… (⌘,)
sb.onDiagramsImageOffer((offer) => {}) // 'sb:evt:diagramsImageOffer' — {guestId, url, fallback, referrer}:
                                     // Add Image to Diagram, in the Google Images panel; §4.17
```

`sb:evt:edit` exists because a menu accelerator wins over the renderer's keydown, and
xterm's selection is **not** a DOM selection, so `role: 'copy'` copies nothing from the
terminal. The Edit menu's Copy / Paste / Select All are therefore custom items that send
this event. The renderer gives first refusal to the focused terminal, then to a focused
Note (R14), then to the Editor (R13), and only then falls back to the document: its own
selection for Copy, `execCommand` for Select All, Undo and Redo, and — for a focused text
field, the Grid's name field — the field's selection for Cut and `insertText` for Paste,
since the menu's ⌘V never lets the keystroke reach it. That fallback is REFUSED for a
contenteditable: `fieldIn()` matches `INPUT` and `TEXTAREA` alone, so Cut and Paste would
do nothing in a note, and `execCommand('undo')` would run Chromium's own history over a
DOM whose block model the note owns — leaving the two out of step and the next autosave
persisting the difference. A note is the app's only contenteditable, and R14 implements
all six itself. A Paste with `image: true` (below) is the one
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
the page. And while the Diagrams tab's Google Images panel has the keyboard, every Edit
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

The Grid is the row above the workspace groups in the rail (`⌘0`): four terminals side by
side, in **views** the user makes — "Sample" is sample-1…4 in the four squares,
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

**A square is that workspace's Terminal.** `views/terminal.js` keeps one xterm and one
shell per workspace and exposes `mount(wsId, into)`, which moves the same host into
whatever is showing it — a Grid square or the workspace's own Terminal tab. Only one
screen is ever on, so the host simply moves; nothing is duplicated and nothing restarts.
Measured: the host element in the square is the host element on the Terminal tab, the
marker typed in one is in the other, and the shell's `startedAt` is unchanged across the
round trip. Taking a workspace out of a square — only from the `⋯`'s Edit, R10 —
leaves its shell running.

**A square can show that workspace's NOTE instead of its terminal** (added 2026-09-28,
the user's ask: "there should be a note that pops up in the terminal box … when I click
on it, it'll render that exact note inside of this box instead of the terminal, and then
I can toggle between the two … I shouldn't be able to see both at the same time").
A switch in the square's top-right corner, beside the `×`'s slot: the page glyph swaps
the terminal for the note, the prompt glyph swaps it back, and the click lands the
keyboard in whichever of the two just came up. Either/or on purpose — four panes in one
window is already the most it can hold, and the point of a note here is somewhere to
look while the terminal is busy, not beside it.

Which squares are showing a note is kept by WORKSPACE ID, in `localStorage`, not by
square: the same workspace can sit in two views, and a scratch pad belongs to the
workspace rather than to where it happens to be on screen. A folder square gets one too
(§4.15 takes its path as an id). The switch carries an amber dot when that workspace has
something written down. The Grid preloads each square's note through R14 as it draws —
four small reads — which both answers that question and leaves the note already open for
the click.

`views/notes.js` mounts the same slab into a square that the Notes tab shows, exactly as
`views/terminal.js` mounts the same xterm, and for the same reason: two copies of the
editor would be two unsaved buffers over one file. The terminal is NOT disposed while
its square shows a note — `retirePanes()` keeps every pane whose id is in a Grid square
whichever of the two the square is drawing — so the shell and its scrollback are
untouched, and `landFocus()` prefers a square that is showing its terminal, because
arriving at the Grid should not put the keyboard in someone's scratch pad.

Three rules in `app.js` follow from that:

* `retirePanes()` treats a square on screen as a Terminal tab on screen — a pane in the
  current view is never retired. It walks the folder ids main's shell states carry as
  well as the rail's workspaces, so a folder square's pane is retired like any other once
  its shell has exited and it has left its square.
* A bell from a square on screen has already been read: `bell()` ignores it and
  `renderMain()` clears the set on every navigation, as it does for the Terminal tab.
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

### M9 `notes.js`
The Notes tab's one markdown file per workspace (§4.15): `read(id)`, `write(id, text,
opts)`, `settle()`, and `fileFor(id)` / `keyFor(id)` / `notesDir()` for the sentence that
has to name the file and for the tests. It is its own module rather than a
corner of `editor.js` because it is the opposite kind of thing: the file is not in a repo
and there is no repo to guard — the guard here is `keyFor()`, which hashes every id into
a name that cannot leave `<config dir>/notes/`. `MAX_BYTES` (2 MB) is the only limit; a
larger file is reported, never read as a prefix, because the renderer autosaves and a
prefix would land on the whole file. Writes for one note are serialised through a promise
chain per file, `settle()` is what the quit waits on, and — like `git.js` — nothing
throws: every failure resolves to `{ ok:false, error }`. `scripts/test-notes.js` runs it
against a scratch notes folder and `scripts/test-noteedit.js` runs the markdown half of
R14's editor against a corpus, both with plain `node --test` (`npm run test:notes`).

### M10 `diagrams.js`
The Diagrams tab's files (§4.17): `list(id)`, `get(id, diagramId)`, `create`, `update`,
`setArchived`, `remove`, `saveImage(bytes, type)`, `imagePath(name)` and `settle()`, plus
`rootDir()` / `dirFor()` / `keyFor()` for the tests. The admin's server actions as files:
the same answers, the same name rule (unique within a workspace), the same "archiving
does not touch updatedAt". It checks only what keeps the folder sane — an object of kind
`flow` (of any size — §4.17), a name of 1–120 characters, a UUID for an id — because the bundle has
run the admin's validator before it asks. Writes go through a temp file and a rename,
serialised per workspace folder so two creates under one name cannot both pass the
check. Nothing throws. `scripts/test-diagrams.js` (`npm run test:diagrams`) runs it
against a scratch folder, with the stylesheet scoping from `build-diagrams.js`.

### M11 `answer.js`
✦ Answer (§4.18): `status({fresh})`, `settings()`, `setSettings(patch)`, `setKey`,
`removeKey`, `start(id, req, onStep)`, `stop(id)`, `stopAll()`. The provider catalogue —
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
the bundle's prompt and answer reading beside them. The live paths were checked against
Claude Code and the OpenAI API; the Claude API (no key on hand) and Codex (not installed)
only against their documentation.

### M12 `images.js`
Google Images beside a diagram, main's half (§4.17): `hardenWebview(webPreferences,
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
`views/logs.js`, `views/terminal.js`, `noteedit.js`, `views/notes.js`, `views/usage.js`,
`views/grid.js`, `views/files.js`, `views/diff.js`, `views/pr.js`, `views/prs.js`,
`views/editor.js`, `app.js` (last — it
boots). `term-theme.js` must precede the two views that build `Terminal`s: both read the
palette at construction; `markdown.js` must precede `diffview.js` and the two PR screens,
which render every comment body through it; `prs.js` follows `pr.js`, whose gh failure
bars it borrows; `noteedit.js` precedes `views/notes.js`, which builds an editor from it,
and both precede `views/grid.js`, whose squares mount a note the way they mount an xterm;
`views/editor.js` follows `term-theme.js` (Monaco's themes are built
from its palette) and `views/workspace.js` (it borrows the header).

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
(⌘1–9 switch workspace, ⌘R refresh, Esc back, ⌘. stop). An appearance change never calls
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

Routes: `{view:'workspace', wsId, tab:'changes'|'logs'|'terminal'|'editor'|'notes'|'diagrams'}`, `{view:'settings'}` (no workspace; §4.18), `{view:'files', wsId, tab:'files'|'all'}`,
`{view:'diff', wsId, repo, path}`, `{view:'pr', wsId, repo, tab:'overview'|'files'|'all'}`,
`{view:'pr', owner, repo, number, tab}` (no workspace — a pull request opened from the
list; its parent for the back caret and Esc is `prs`, not `workspace`),
`{view:'grid'}` (no workspace; §4.10), `{view:'usage'}` (no workspace; §4.11),
`{view:'prs'}` (no workspace; §4.12). A route with no workspace is `standalone()`:
it renders with no workspaces at all and lights its own rail row — the Pull requests
row stays lit while one of its pull requests is open.

It also owns the rail's bottom row, Usage, drawn by `renderFoot()` behind its own
signature like the nav; its dot is red only while the five-hour window is `critical`.

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
squares — §4.10), `editAction(action, text)` → `true` when the focused terminal
consumed a menu Edit action, and `xterm(wsId)` (the live Terminal, for the smoke harness
only). A pane whose shell is still alive is **never** disposed: replaying a full-screen
TUI's ring buffer into a fresh xterm paints garbage. The one time a fresh pane meets a
live shell — the window closed and opened again — the replay it asks for is a repaint
by tmux (§4.6), which is why that case is not garbage either.

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
Body: four `.cell`s — a filled one is a 30px strip (the workspace's
name, which opens its Terminal tab; its run dot; and, only while the view is being
edited, a `×` to take it out) over `terminal.mount()`; an empty one is an `Add workspace`
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
for (`.more.arr` > `.hint` — not `.note`, which is the Notes slab's class). In it:

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
the square that is choosing, the open menu, the armed Delete, the view that is being
edited, and the workspace just placed — whose terminal gets focus, because the picker row the user clicked no longer
exists and `app.js`'s path-based focus restore would land on whatever now sits at that
position. All of it is dropped when the Grid is rendered after another screen: `render()`
asks whether `#main` still holds a `.gridhd` from the previous rebuild. Landing on the
Grid otherwise focuses the first filled square, and only when nothing in the main column
has focus already.

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
The Changes tab and the shared header the Logs, Terminal, Editor and Notes tabs borrow
(§6 R8, R13, R14); its segmented control is `Changes | Logs | Terminal | Editor | Notes`,
lit from a whitelist of the five rather than a logs/else test, which would light
`Changes` for any tab it had not heard of. Adding a tab takes two lines in `app.js` as
well — `TABS.workspace` and `TAB_VIEWS` — because `normalize()` rewrites a tab it does
not know to the remembered one before anything looks it up. The
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

### R14 `noteedit.js` and `views/notes.js`
The Notes tab (§4.15; added 2026-09-28, the user's ask). The shared header, and below it
one dark (or light — §4.8) slab holding a block editor: one writing column, a bar for
what only this screen can say, and a word in the corner while it saves.

```js
SB.noteEditor = { create(opts), parseBlocks(md), blockToMd(spec), parseInline(s),
                  inlineToMd(text, marks) }
SB.views.notes = { render(state), mount(wsId, into), focus(wsId), has(wsId),
                   preload(wsId), editAction(action, text), onKey(e), refresh(),
                   flushAll(), dirty(), dispose(wsId), editor(wsId) }
```

**The root is persistent, and it is the same element every time** — the R13 contract, for
a sharper reason than the Editor's. `renderMain()` rebuilds the main column for a run
state, a shell spawn, a bell or a usage poll, several times a minute while anything is
running, and detaching a focused contenteditable makes Chromium drop the selection: the
caret comes back at the top of the note, mid-word. So `render(state)` hands back that
workspace's root and only swaps a freshly built header into it. One editor per WORKSPACE,
in the module's own `Map`, because the Notes tab and a Grid square are two places to look
at the same thing and a second copy would be a second unsaved buffer over one file;
`mount(wsId, into)` moves the same slab, as `views/terminal.js` moves the same xterm.

**Blocks are the direct children of one contenteditable.** `div.nb[data-t]`, each holding
one `div.nbc` and nothing else: `p`, `h1`…`h6`, `ul`, `ol`, `todo`, `quote`, `code`, `raw`
and `hr`. A `raw` block is a line this editor has no block for, kept as its own source:
either markdown it cannot DRAW — a table, an image, `[ref]: url`, `[^1]: …`, a line of
HTML, a setext `===` — because drawing an image as the sentence `!alt text` would be a
lie; or a line whose own re-serialisation would differ from it, which `parseBlocks()`
catches by writing every block back out and comparing (an unclosed fence, `** bold **`,
a task with a double gap). Everything else it cannot draw but CAN read as prose — a
four-space code block, a footnote reference, a pipe in a sentence — is a paragraph of
its literal text and is saved back unchanged. A bullet, a number and a checkbox are drawn by CSS — `.nb::before` — and are
**not** nodes. That is load-bearing, not tidiness: an inline `contenteditable="false"`
span has a caret position on either side of it, and Chromium will put the caret BEFORE
the bullet, where a typed character lands outside `.nbc` and is lost at save time and
where Backspace deletes the marker instead of the block. With no node there is no such
position; the checkbox is hit-tested on `mousedown` against the text's left edge instead.

**`normalize()` runs after every edit, and it is what makes contenteditable safe to build
on.** At least one block, every direct child of the root a block (a bare text node from a
select-all delete becomes a paragraph), one `.nbc` per block with any second one folded
back into the first, no stray text node beside it, nothing inside it the inline model
cannot hold — a `<span style>` from a paste, a `<b>` from a browser editing command, an
empty `<em>` left by a deletion — and never a divider as the last block, since there
would be nowhere left to type. It answers whether it changed anything, which is the cue
to put the caret back by (block index, character offset).

**Chromium's own editing is allowed only INSIDE one block.** Anything that would reach
across two — typing over a selection, Option+Delete at a boundary, a paste, a drop — is
refused in `beforeinput` and done over the block model instead, because Chromium's merge
moves the tail's nodes into the head's `.nb` rather than its `.nbc`, and text outside
`.nbc` is text the save silently loses. `historyUndo`, `historyRedo` and the four
`format*` types are refused there too: the browser's undo stack must never rewrite a DOM
the model owns.

**Inline formatting is a model, not a tree shape.** A `.nbc`'s content is
`{ text, marks }`, marks being character ranges `{s, e, t, href}` over `strong`, `em`,
`code`, `del` and `link`. The input rules, ⌘B, the serializer and the parser all work in
it, which is why toggling bold over a selection that already has italic inside it is
arithmetic rather than DOM surgery; `readInline()` reads it out of the DOM and says when
the DOM held something it had to drop, `renderInline()` writes it back.

**Finishing a bold run does not bold the rest of the sentence.** Placing the caret after
the `<strong>` is not enough on its own: Chromium computes a typing style from what is
before the caret, so the next character goes inside the element whatever the Range said
(measured — the bold ran to the end of the line). So the rule leaves a note of where the
mark ended and the first keystroke past it clips the mark back to there and re-renders,
after which the new text really is in a plain node. The same guard serves `` `code` ``.

**The input rules.** On the space at the start of a block: `#`…`######` → a heading,
`-` `*` `+` → a bullet, `1.` / `1)` → a number, `[]` / `[ ]` / `[x]` → a task, `>` → a
quote — the marker is eaten. The head is matched with its whitespace runs collapsed and
is disqualified only by whitespace at its ENDS, which is what makes `- [ ] ` reachable:
the `- ` fires the bullet rule, and the `[ ] ` that follows then fires the task rule on
a head that has a space in the middle of it. On the text becoming exactly three backticks or `---` → a
code block or a divider. On the closing character of a pair: `**bold**`, `*italic*`,
`` `code` ``, `~~strike~~`, `[text](url)`, and `***both***` for the two together. On a
space after a bare URL → a link, and that one does NOT eat its space: the space is part
of the sentence, not part of the shortcut. An underscore means nothing at all — typed,
read or written. `_italic_` is a spelling markdown readers disagree about, the
alternative is escaping every `snake_case` in the file, and a shortcut for it ate the
underscores out of a typed path (`see /tmp/_x_` became `see /tmp/*x*`).

**Keys.** `↩` splits the block (a list item makes another of its own kind, a heading makes
a paragraph, an empty list item or quote steps back out instead); `⌫` at offset 0 unwinds
what the block IS before it touches what is in it (outdent, then to a paragraph, then
merge into the one above) — and a code or raw block becomes its LINES, one paragraph
each, because carrying its newlines into one paragraph is where readInline turns every
one of them into a space and a whole fence reads as a single run-on line. Forward
`⌦` at the end of a block removes a DIVIDER and nothing else: it used to delete the
whole neighbouring fence, so now it steps into it, as `⌫` does the other way. `⇥`/`⇧⇥` indent a list item and insert two spaces in code;
`⌘B` / `⌘I` / `⌘E` / `⇧⌘X` toggle marks (and the two together are written and read as
`***both***`, which the reader has a rule for — without it, ⌘B then ⌘I turned the whole
line, heading or bullet included, into a raw source block), `⇧⌘1`…`⇧⌘3` / `⇧⌘0` set a heading (matched on
`e.code`: with Shift held a US layout reports `!` `@` `#` `)` for the digit row), `⌘U` is
swallowed so Chromium's own binding cannot put a `<u>` in the tree, and `⌘S` (through
`app.js`, as the Editor's is) writes the note now. Inside a code block `↩` inserts a
newline — the one block that holds them — and `⇧↩` steps out into a new paragraph.

**Undo is this editor's own**, a stack of `{markdown, caret}` snapshots pushed on a 500 ms
typing idle and around every structural change, bounded at 200 entries and 4 MB. It has
to be: ⌘Z arrives as `sb:evt:edit` (§4.7), the browser's stack knows nothing of the
transforms, and letting the two interleave desynchronises them. An undo that restores a
marker the rule ate — `#` with the caret after it — arms a one-shot that lets the next
space through, or a literal `# ` could never be typed. Copy and Cut serialise the
selection as MARKDOWN, so text copied out of a note pastes back as itself — a WHOLE line
with its `- ` or `## `, a partial one as the paragraph it is (escaped, so half a bullet
does not paste back as a bullet). Paste parses the clipboard as markdown, as raw lines
inside a code block, and as plain text when it holds no line break, so a pasted word does
not split the paragraph it lands in. Select All then Cut empties the note: what a deleted
range leaves behind takes its kind from whichever end still has text in it, and from
neither when the whole note went — otherwise a one-line list wrote a stray `- ` back to
the file and the note could never be empty again.

**Saving.** `onChange` marks the pane dirty and writes 400 ms after typing stops; the
window losing focus, the window closing and main's quit flush (§4.15) write immediately.
Nothing may be written before the first read has landed `ok` — a `loaded` flag — or a
blur during that one round trip would put an empty buffer over the note. The surface is
`contenteditable="false"` until then, and for a note too large to open, because a
surface that cannot save is one that throws away what is typed into it and then has it
wiped by the read when that arrives. A note that was too large and has since shrunk goes
back through the whole load, bar and all: unwinding only `loaded` left it editable and
permanently unsavable. A save that failed is the one
failure that loses what was typed, so it is a sticky line in the bar with Try again and
is retried on its own every 4 s; a conflict offers `Keep mine` and `Reload`. A window
focus re-reads every clean note and adopts the file; a dirty one is left alone. A pane
off screen is retired by `retirePanes()` (R2) — the workspace on screen keeps its own
whatever tab is showing, and so does every Grid square — and one that cannot be written
is never retired, nor retried into a loop: only a save that actually landed tries the
disposal again.

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

### R15 `views/diagrams.js`, and the bundle in `src/diagrams/`
The Diagrams tab (§4.17). `views/diagrams.js` is the classic-script seam; the editor is
the React bundle, which sets `window.SBDiagrams` (`mount`, `update`, `flush`,
`editAction`, `fullscreen`, `leaveFullscreen`, `refreshAnswers`).

Like the Editor and Notes it hands back the SAME root every render and swaps only the
header, so a re-render for a bell or a run state never tears a live canvas out of the
page. There is ONE bundle root for the window's life; its page is keyed by workspace,
and the editor being left writes what it holds as it unmounts.

**The tree stays mounted behind every other screen**, so `renderMain()` tells the view on
every render whether its tab is the one showing (`shown(route)`), and the bundle turns
every key off while it is not: React Flow listens on the whole document, and Backspace
on the Terminal would otherwise delete the boxes selected on a canvas nobody can see.

**Keys.** app.js asks `onKey` after the Editor and Notes: Esc leaves a full-screen
diagram before it means back, and ⌘↵ (or ⌘I) over the canvas is ✦ Answer (the editor's own
listener) and never Start. The editor's own Esc, in the capture phase, stops propagation
when it uses one, so app.js never sees it. G opens Google Images; Esc in its search field
closes the panel and goes no further.

**Google Images** is `ImageSearchPanel.tsx`, the app's one `<webview>` (§4.17). Staying
mounted is not enough for it: its root leaving `#main` destroys the guest. So
DiagramsPage hands the editor `active` as `shown`, and the panel makes a new `<webview>`
when it turns true again.

**Styles.** The bundle's stylesheet is the admin's Tailwind plus React Flow's, every rule
scoped to `.sbdg` behind `:where()` and with the cascade layers flattened
(`build-diagrams.js` says why), and Radix's portals render into an element inside the
root rather than `<body>`. One collision that went the other way was fixed at its source:
styles.css's `.grid` (the Grid screen's 2x2) is `.gridbd > .grid` now, since `grid` is a
Tailwind utility the editor uses. styles.css's element rules reach in too, and beat the
bundle's `:where()`-scoped classes: every `aside` is the sidebar (its padding, and
`.win.norail aside` hides it), so the bundle uses no `<aside>` — the Google Images panel
is a `div` with `role="complementary"`. The canvas follows Terminal appearance, as the Notes
and Editor slabs do: dark is `[data-term-theme="dark"]`.

`npm run check:diagrams` type-checks `src/diagrams/` (esbuild builds without checking).

### R16 `views/settings.js`
The Settings screen (§4.18): a plain view, rebuilt on every render like Usage. One
section today, ✦ Answer on diagrams — a row per provider (the radio that makes it the
one ✦ Answer uses, its name, what it does, whether it is ready on this Mac, one action),
and under an API's row, opened by Add key / Edit, its key field, its model and (OpenAI)
its effort; after the list, the Web access and Subtext switches, a whole row each (the
✦ Answer menu has the same two). It asks main on the way in (and looks for the CLIs again after 30 s away),
follows `sb:evt:answerStatus`, and never holds a key: the field is sent to main on Save
and emptied.

## 7. Screens (from the mock-up — `out/01.html` … `out/07.html`)

1. **Workspace / Changes** — header: name, `Pull main`, `Start`/`Stop` (the mock-up's sub
   line `TASK-352 · 6 changes · 1 repo behind main · ● running 14s` was cut, see R4). Segmented `Changes | Logs | Terminal |
   Editor | Notes` (R4; the mock-up predates the last three). One row per
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

8. **Terminal** — the same header, segmented `Changes | Logs | Terminal | Editor | Notes`, and a
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

11. **Editor** — the same header, segmented `Changes | Logs | Terminal | Editor | Notes`, and
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

12. **Notes** — the same header, segmented `Changes | Logs | Terminal | Editor | Notes`,
    and one slab filling the body, dark or light with the Terminal appearance. Inside it
    a single writing column, 740px wide and centred: headings, paragraphs, bullets,
    numbers, tasks with a real checkbox, quotes, code blocks and dividers, all drawn as
    themselves — there is no source view. An empty note says `Write it down…`; an empty
    line under the caret says `Type “#” for a heading, “-” for a list, “[]” for a task`.
    A line the editor has no block for — a table, an image, `[ref]: url`, a line of HTML,
    an unclosed fence — is shown as its own source, in monospace behind a dashed rule,
    and saved back byte for byte. A save
    that failed, or a note something else has edited since, is one line at the top of the
    slab with `Keep mine` and `Reload`; `saving…` and `saved` appear briefly in the
    bottom-right corner and then go. The same slab is what a Grid square shows when its
    switch is on (§4.10).

Clicking the branch pill opens the PR screen on its Overview. Clicking a summary button
opens Files. Clicking a file row opens Diff. The workspace name — the header title, the
breadcrumb crumb, and the name strip on a Grid square — opens that workspace's Terminal.
The back caret and Esc go back.

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
- Opening a note and saving it changes not one byte of the file — for anything typed in
  it, and for anything it cannot draw: a table, an image, a reference definition, a
  setext heading, an unclosed fence. `npm run test:notes` holds that against a corpus,
  and asserts which blocks each line becomes as well as that the bytes match; the corpus
  covers the markdown half (`parseBlocks` / `blockToMd`), and the DOM half — the
  `data-*` source fields `makeBlock` writes and `specOf` reads — is checked in the
  smoke harness, where the real contenteditable is.
- Typing `### ` at the start of a line in a note makes it a heading and the marker goes;
  `- `, `1. `, `[] `, `> `, three backticks and `---` do the same for their blocks, and
  `**bold**`, `*italic*`, `` `code` `` and `~~strike~~` apply as the closing character is
  typed — and the rest of the sentence after one is NOT bold.
- A note writes itself 400 ms after typing stops, on blur, and on the way out of a quit;
  an empty buffer never overwrites a note that has not finished loading, and a note
  something else changed since asks rather than clobbering it.
- A Grid square's switch shows that workspace's note in place of its terminal and back
  again, with the shell and its scrollback untouched either way, and ⌘V with the caret
  in the note goes into the note rather than into the shell behind it. Typing in a
  square's note survives an app re-render: the caret stays where it was, not at the top.
- ⌘. and ⌘Enter keep their app-wide meaning with the caret in a terminal or in Monaco,
  and step aside only for a note.
- ⌘A then Cut empties a note whatever shape it is — a one-line list, a heading, a fence,
  a note that opens with a divider — and one keystroke never destroys a whole code block
  it happens to be next to.
- Renaming a symlink onto the file it points at is refused, not a destroyed file.
- Every screen matches the mock-up's spacing, type and colour.
