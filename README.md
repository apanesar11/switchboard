# Switchboard

<img width="1728" height="1080" alt="Screenshot 2026-09-22 at 12 36 14 PM" src="https://github.com/user-attachments/assets/78488342-25df-4459-8398-9d348960ffe5" />


A local control panel for your development workspaces.

One window for terminals, dev servers, repository changes, pull requests, a plain
editor for your files and a scratch pad per workspace. Group your own projects in the
sidebar and arrange up to four terminals per grid view. Switchboard ships with no
workspaces or personal configuration.

## Run it

```bash
cd switchboard
npm install
npm start
```

Switchboard currently targets macOS. Install Node.js/npm and Git on each Mac;
GitHub features also need `gh` signed in with `gh auth login`. Install and sign in
to whichever coding CLI you use on that machine, then run `codex` or `claude` in a
Switchboard terminal. Claude is optional, and there is no Codex usage meter yet.
Install tmux if you want terminal sessions to survive quitting Switchboard.

`npm start` first builds the Diagrams tab's editor (`npm run build:diagrams`, a second or
so); it is the one part of the app that is built rather than run as written.

## Set up your workspaces

The shipped `src/main/default-config.json` is `{}`. On first launch, Switchboard
creates an empty `~/.switchboard/config.json`; it does not scan any folder until
you configure one. Your real settings belong in that local file, outside Git.

Open this checkout in Codex and ask:

> Use $switchboard-setup to configure Switchboard for my projects.

The repository includes the [workspace setup skill](.agents/skills/switchboard-setup/SKILL.md).
It helps select folders and dev commands, preserves existing settings, and writes
only your local config. It does not require Claude.

For manual setup, use [config.example.json](config.example.json) as a starting
point and replace its fictional folder, command, and port with your own. Set
`root` to a folder such as `~/Projects` to discover multi-repo workspaces, or add
absolute `workspaces.<id>.dir` paths to select individual folders. Relative
`dir` values need a `root`. Refresh or reopen Switchboard after saving.

## Install the desktop app

To build and install the macOS desktop app, run this after installing dependencies:

```bash
npm run install:desktop
```

Then double-click **Switchboard** on the Desktop. This is a standalone
`~/Desktop/Switchboard.app` bundle with its own runtime and four-pane grid icon.
Drag it to the app section of the Dock, or right-click its running Dock icon and
choose **Options → Keep in Dock**. It needs no Terminal, npm, or source checkout to
launch. The installer replaces the earlier shortcut and removes its old helper
from `~/Applications`.

The installed app is a snapshot of the source. After code changes, select
**switchboard** in the sidebar and click **Publish**. Wait for **Published**, then
close Switchboard and reopen it using the same desktop or Dock icon. The new app
is built while you work and installed when you close or quit; failed builds leave
the installed app untouched. Keep the source checkout and its development
dependencies available for publishing. The build's output appears in the workspace's
**Logs** tab as it runs, and is saved in `publish.log` under Switchboard's Application
Support folder.

`npm run install:desktop` remains available for installing from Terminal while the
desktop app is quit. `npm start` runs the source directly during development. Both
use your existing configuration and terminal sessions. To build without installing,
use `npm run package`; the result
is under `dist/Switchboard-darwin-<architecture>/Switchboard.app`. The grid icon's
editable source is `assets/switchboard.svg`; packaging generates its PNG and ICNS
versions. To uninstall, delete the desktop app and remove it from the Dock.

## What it does

- **Start / Stop** — runs the workspace's own `npm run dev` and kills the whole tree on
  stop, so nothing is left holding a port. Only one copy of a project runs at a time.
- **Logs** — the live output of that dev script, colours and all.
- **Terminal** — a real login shell in the workspace folder, for running `codex`, `claude` or
  anything else. It reads your `.zshrc`, so the prompt, aliases and `PATH` are the ones
  iTerm2 gives you. Shift+Enter and Option+Enter both send the newline Claude Code
  expects, `/copy` reaches the system clipboard, and ⌘K clears. It is not the dev server:
  Stop never touches it, and it keeps running while you look at other workspaces. When a
  shell rings the bell — Claude finishing a turn — that workspace's dot in the sidebar
  turns blue until you look at it. Quitting Switchboard does not end them: each shell
  runs inside tmux on the app's own private server, so the next launch brings every
  terminal back where it was, Claude mid-turn and all; `exit` ends one for good. That
  needs tmux (`brew install tmux`). Without it, quitting hangs the shells up the way
  closing a terminal window does, and `claude --continue` picks the conversation back up.
- **Editor** — the fourth tab, for when you want to look at or fix a file without
  opening another app: something like Sublime Text, with no extensions and no setup.
  The tree on the left has a folder for each repo, lists what `git` would plus the
  files your `.gitignore` keeps out of it — `.env.local` and the like, dimmed so you
  can tell — leaves ignored folders such as `node_modules` out, and marks changed files
  with their letter. Open files as tabs, save with ⌘S, and close a tab with ⌘W (⌘W
  anywhere else still closes the window). ⌘P goes to any file by a few letters of its
  name (`name:42` lands on line 42); ⇧⌘F searches every repo and lists the matches by
  file. Bars beside the line numbers show what you changed since the last commit. A
  markdown file gets an eye next to the full-screen button: it shows the file the way
  GitHub shows a README, following what you type, and shows the source again (⇧⌘V does
  the same); a relative link in it opens that file. A file changed on disk — by Claude, a formatter, a
  checkout — reloads into its tab by itself; if you have unsaved edits there, you are
  asked instead, and closing Switchboard with unsaved edits asks first. The button at
  the editor's top right makes it full screen, hiding the sidebar and the header; the
  same button or Esc brings them back. It follows **Terminal appearance**. Save writes
  only the file you edited — no git, no formatting, nothing else — and a file whose
  lines end in a mix of LF and CRLF asks first, since saving makes them all one kind.
  Right-click a row in the tree to make a file or a folder, rename one, copy its path
  or reveal it in Finder; the two small buttons beside **Files** make a file or a folder
  wherever the tree's cursor is. You type the name in the tree itself, and a name with
  slashes in it makes the folders on the way (or moves the file, when you are renaming).
  **Delete** asks first and puts the file in the Trash, so a slip is one ⌘Z in Finder
  away from being undone — and if the Trash is not available it says so rather than
  pretending. Nothing here runs git: a file you make is untracked, exactly as it would
  be if you had made it in a shell.
- **Notes** — the fifth tab: somewhere to write things down for a workspace, one note
  each. It works the way Notion does rather than the way a markdown editor does — type
  `### ` at the start of a line and the line becomes a heading and the `### ` goes,
  `- ` makes a bullet, `1. ` a numbered one, `[] ` a checkbox you can tick, `> ` a
  quote, three backticks a code block and `---` a divider. `**bold**`, `*italic*`,
  `` `code` `` and `~~strike~~` apply as you finish typing them, ⌘B and ⌘I do the same
  to a selection, ⇥ and ⇧⇥ indent a list, and a web address you type becomes a link.
  There is no source view and no preview toggle, because what you see is the note. It
  saves itself a moment after you stop typing, and again when you leave the window,
  close it or quit — ⌘S if you want to be sure. If it ever cannot write the file, it
  says so and asks before you quit rather than losing what you wrote. The note is an ordinary markdown file, so anything
  can read it, but it lives in `~/.switchboard/notes/` rather than in your repo: it
  will never show up in **Changes**, in the Editor's tree or in a commit. A line it has
  no block for — a table, an image, a link definition, a line of HTML — is shown as the
  source it is, in monospace, and saved back untouched; so is anything it cannot write
  out exactly as you had it. Opening a note never rewrites it.
- **Diagrams** — the sixth tab: flow diagrams for a workspace — boxes, arrows, sticky
  notes, free text and pictures, arranged by hand. Click a shape on the toolbar down the
  left and click the canvas to place it; with a box selected, Tab adds the next one joined
  to its right and starts you typing, ⇧Tab steps back, the arrow keys move between boxes
  and ⌘D duplicates. Drag from a box's dot to draw an arrow. Drop, paste or pick a picture
  to put it on the canvas. A toolbar floats over whatever is selected: shape, colour and
  outline for a box, size and style for its text, label and line for an arrow. It saves as
  you go; ⌘Z and ⇧⌘Z undo and redo. The picker over the canvas switches between diagrams
  (← and → step through them), **New diagram** makes one, and **Actions** archives or
  deletes the one on screen. Each diagram is a file in `~/.switchboard/diagrams/`, one
  folder per workspace — never in your repo.

  **✦ Answer** leads a box's toolbar (and ⌘↵): write a question in a box and the answer
  comes back as one to four boxes hanging off it, as one undo step. The chevron beside it
  picks who answers — **Claude Code** or **Codex**, which run in the workspace's folder and
  read its code before they answer (slower; a card over the canvas shows each file they
  open), or the **Claude API** or **OpenAI API**, which see only the diagram and answer in
  seconds. The CLIs can only read: Claude Code gets nothing but its read and search tools,
  and Codex runs in its read-only sandbox. Install and sign in to the CLI you use on each
  Mac; Switchboard finds it, and picks the first one that can answer.
- **Settings** — the row under Usage, or ⌘,: who answers ✦ Answer on this Mac, one row
  each — whether a CLI is installed and signed in, and the keys for the two APIs with the
  model each one uses. A key is checked with its provider before it is kept, encrypted with
  your Mac's Keychain in `~/.switchboard/keys.json`, and never shown again — only its last
  four characters.
- **Terminal appearance** — light by default, so a Claude Code set to its light theme is
  actually readable and the terminal belongs to the rest of the app. **View ▸ Terminal
  appearance** switches between Light, Dark and Match system; the choice is remembered in
  `~/.switchboard/config.json` and applies to Logs and the Editor too. Panes repaint where
  they stand — nothing restarts, no scrollback is lost and no unsaved edit is touched.
- **Jump to a terminal** — the workspace name is a link to its Terminal: the big title
  on the workspace page, the workspace name in any breadcrumb, and the name on a Grid
  square. It is the tab you spend the most time in, so it is one click from wherever
  you are.
- **Grid** — the row above the workspaces (⌘0): four terminals side by side, in views you
  make. Press **+**, name it, then put a workspace in each square; "Sample" for
  sample-1 to sample-4, "Everything else" for the rest, and switch between them the way
  you switch tabs. The ⋯ at the right holds **Edit** and Delete. Edit is one mode for
  everything about the view showing: its tab becomes a name field to rename it, the ‹ ›
  either side move it along the row, and the squares can lose a workspace (×) or gain
  one (Add workspace) — click another tab to edit that one too, and Done to finish. It
  is the only place a square's × shows, so a slip of the hand cannot empty one. The bar
  beside the ⋯ is this session's Claude usage. A
  square *is* that workspace's Terminal — the same shell, the same scrollback, whether
  you look at it here or on its own tab — and taking it out of a square leaves the shell
  running. The button at a square's top right swaps the terminal for that workspace's
  **note** and back again — one or the other, never both — so a square can be a scratch
  pad while you wait on the shell behind it, which keeps running either way. It carries
  a small amber dot when there is already something written down. A square can also
  hold **any folder** rather than a workspace: the picker's
  first row, **Choose a folder…**, opens the Mac's folder chooser, and the square becomes
  a shell in that folder — the apps folder itself, a repo outside it, anything — on no
  rail and with no screen of its own. Views are remembered in the config; the window
  comes back to the Grid if that is where you left it.
- **Usage** — how much of your Claude plan is used, read through Claude Code's own
  sign-in. The sidebar row and Grid gauge only appear after a local Claude OAuth
  sign-in is found; a machine with only Codex shows neither. Removing the Claude
  sign-in clears the cached numbers and hides the display on the next check.
  The five-hour session is the bar at the top of the Grid; the **Usage** row at
  the bottom of the sidebar has all of it — the session, the week and the per-model
  week, each with when it resets — and its dot turns red when the session is nearly
  spent. It refreshes every few minutes on its own, when the window comes back to the
  front, and on demand with the ↻ on the Usage screen (or ⌘R there); if Anthropic is
  briefly rate-limiting, the last numbers stay up with a quiet "couldn't refresh" note
  rather than the screen going blank. Switchboard reads Claude Code's credential
  from macOS Keychain (falling back to `~/.claude/.credentials.json`) and makes a
  direct HTTPS request to Anthropic's usage endpoint. This does not run the Claude
  CLI. Switchboard never saves the token or sends it to the renderer, and makes no
  Anthropic request when that credential is absent.
- **Sidebar** — the rail of workspaces closes, for when you want the whole window for a
  terminal or a diff. The button beside the traffic lights, or **View ▸ Hide Sidebar**
  (⌃⌘S); it is remembered, ⌘1–9 still switch workspace without it, and if a shell rings
  while it is closed the button carries the blue dot. Nothing reloads — the terminal keeps
  its scrollback, its focus and its shell. The Editor's full-screen button goes further
  and hides the header too, until you press it again or Esc.
- **Single-repo apps** — a workspace is usually a folder of repos, but an app that is one
  repository with nothing nested — Switchboard is one — is a workspace too. List it in
  `~/.switchboard/config.json` under `workspaces` as `"name": { "dir": "folder" }` and it
  joins the rail, the folder itself being its one repo. Projects with a single workspace
  share the **Other** group; a project gets a group of its own as soon as it has two.
- **Umbrella repos** — when a folder of repos is a repository itself (it tracks the README,
  scripts and docs around its children), it is the first row of its own workspace, above
  the repos inside it, with its branch, its changes, Pull main and the Editor like any
  other. Its git folder may be parked as `.git.disabled` — the rename some setups use to
  hide the outer repository from an IDE — and Switchboard reads it where it is, without
  attaching it.
- **Links** — once a server is listening, its address shows on the repo's row. Click it
  and it opens in your default browser. Configured ngrok tunnels can appear beside a repo.
- **Changes** — per repo, a GitHub-style summary (`4 files +84 −3`). Tap it for the file
  list, tap a file for its diff, or read them all on one page.
- **Pull main** — fast-forwards every repo that is sitting on `main`, one repo or all of
  them.
- **Pull request** — tap a branch and the pull request opens on its **Overview**: the
  description on the left, and on the right everything said on it — comments, each
  review with its verdict and the inline comments it came with, and the reactions on all
  of them (a 👍 from `chatgpt-codex-connector` under the description is Codex saying it
  found nothing; hover the chip to see who reacted). A comment's `path:line` jumps into **All diffs**, where
  the review comments sit under the lines they were left on; **Files** is the list.
  **Squash and merge** in the header does what GitHub's own button does — the commits
  become one on `main` — and then the Delete branch click you would have made next, in
  one click and on GitHub only: your checkout and its local branch are left exactly as
  they were. If the branch was pushed to after the screen loaded, GitHub refuses and says
  so; ⌘R and look before merging again.
- **Pull requests** — the row under Grid in the sidebar: every open pull request you
  authored, in any repository, newest activity first — repo, number and title, then
  Draft / Approved / Changes requested, a dot for the checks, how many comments, when it
  last moved. Tap one to open it (its Overview, as above), whether or not that repo is
  cloned under `~/Projects`; Esc comes back to the list. It refreshes when the
  window comes back to the front, and ⌘R or the ↻ asks GitHub again now. It uses the
  `gh` sign-in the rest of the app already uses — no token to set up.

Configuration lives in `~/.switchboard/config.json` (created on first run): the root
folder to scan, folders to ignore, the single-repo folders to show, and each workspace's
dev command and links.

`ARCHITECTURE.md` is the contract the code is written against.

## Local data and publishing the source

GitHub operations run through `gh`, and repository status, diffs, fetches and pulls
run through `git`. Terminals use xterm.js and node-pty to run your login shell,
optionally inside tmux. The Editor is Monaco, the editor inside VS Code, bundled with
the app; it reads the files in your repos through `git` and the file system, and
writes, moves or bins one only when you ask it to — a save, a new file or folder, a
rename, a delete. Notes are plain markdown files of Switchboard's own, one per
workspace, in `~/.switchboard/notes/`; nothing in a repo. Diagrams are JSON files of its
own too, in `~/.switchboard/diagrams/`, with the pictures on them kept once each in
`~/.switchboard/diagrams/images/`. ✦ Answer runs `claude` or `codex` in the workspace's
folder with read-only tools, or calls the Anthropic or OpenAI API directly with a key you
entered; nothing else leaves the Mac. Dev commands also run in
local shells. Claude usage
uses the direct request described above; local port checks use sockets and system
utilities, and ngrok discovery calls its local HTTP API.

The source does not need account credentials. Each computer uses its own Git/GitHub
and coding CLI sign-ins. Switchboard's configuration stays in
`~/.switchboard/config.json`, your notes and diagrams beside it in `~/.switchboard/notes/`
and `~/.switchboard/diagrams/`, and any API keys for ✦ Answer, encrypted with the
Keychain, in `~/.switchboard/keys.json`;
window state, browser storage and publish logs live in
Electron's Application Support folder. Terminal programs can save their own history
and credentials outside this checkout. Pasted images are saved in a temporary
Switchboard folder.

Commit the source and `package-lock.json`. The `.gitignore` excludes dependencies,
built apps, environment files, common credential files, logs and local app state.
Keep personal paths, project names, and configuration backups out of tracked files.
The default config stays empty; documentation and the example use fictional names.
Review the staged files before publishing.
`"private": true` in `package.json` prevents accidental npm publication; it does not
prevent hosting the Git repository publicly.
