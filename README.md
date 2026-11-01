# Switchboard

<img width="1728" height="1080" alt="Screenshot 2026-09-22 at 12 36 14 PM" src="https://github.com/user-attachments/assets/78488342-25df-4459-8398-9d348960ffe5" />


A local control panel for your development workspaces.

One window for terminals, dev servers, repository changes, pull requests, a plain
editor for your files, and whiteboards. Group your own projects in the
sidebar and arrange up to four workspace panes per grid view. Switchboard ships with no
workspaces or personal configuration.

## Run it

```bash
cd switchboard
npm install
npm start
```

Switchboard builds on macOS and Windows (x64 or ARM64). Install Node.js 24+ with npm and Git on the build machine;
GitHub features also need `gh` signed in with `gh auth login`. Install and sign in
to whichever coding CLI you use on that machine, then run `codex` or `claude` in a
Switchboard terminal. Claude is optional, and there is no Codex usage meter yet.
On macOS, install tmux if you want terminal sessions to survive quitting Switchboard.
Windows terminals use PowerShell and ConPTY; they close when Switchboard quits.

`npm start` first builds the whiteboard editor (`npm run build:diagrams`, a second or
so); it is the one part of the app that is built rather than run as written.

To check a change: `npm run check` (every source file parses, and it names any file
`ARCHITECTURE.md` lists that is not there yet), `npm run test:config` (configuration
and workspace discovery), `npm run test:editor`, `npm run test:databases`,
`npm run test:publish`, and `npm run test:diagrams` for the whiteboards — their store
and its one-time migration, the layout, ✦ Answer, Google Images and YouTube links —
all under plain Node in scratch folders. `npm run check:diagrams` type-checks the whiteboard editor.
Three checks run the built editor in a hidden Electron window, with scratch data rather
than your `~/.switchboard`: `npm run test:whiteboards:browser` (the Whiteboards screen,
its tabs and the terminals on a board), `npm run test:documents:browser` and
`npm run test:rich-text:browser`.

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

To preview the OS, CPU and install location without building anything:

```bash
npm run install:desktop -- --dry-run
```

To build and install for the computer you are using, run this after installing dependencies:

```bash
npm run install:desktop
```

The command automatically selects macOS or Windows and the current Node.js CPU
architecture. Use native ARM64 Node.js for an ARM64 build, or x64 Node.js for an
x64 build. Build on the target operating system; copying `node_modules` between
Mac and Windows does not work because the terminal includes native code.

On Windows, the app installs to `%LOCALAPPDATA%\Programs\Switchboard` and creates a
**Switchboard** desktop shortcut. Launch it from that shortcut or from
`Switchboard.exe` in the install folder. Administrator access is not required.
The whole app folder is needed when sharing a Windows build, not just the `.exe`.
Windows builds are unsigned. Git and coding CLIs are separate tools for the
features that use them; launching a packaged app does not require Node.js or npm.

On macOS, double-click **Switchboard** on the Desktop. This is a standalone
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

On Windows, Publish prepares the update while you work and a separate Node.js
helper installs it after Switchboard exits. Wait a few seconds before reopening;
the result is appended to `publish.log` in Electron's Application Support/userData
folder. A failed swap restores the previous app; the staged update is retained if
it cannot be applied. Keep Node.js/npm installed for building and publishing.

`npm run install:desktop` remains available for installing from Terminal while the
desktop app is quit. `npm start` runs the source directly during development. Both
use your existing configuration and terminal sessions. To build without installing,
use `npm run package`; the result
is under `dist/Switchboard-darwin-<architecture>/Switchboard.app` on macOS, or
`dist/Switchboard-win32-<architecture>/Switchboard.exe` on Windows. Use
`npm run package -- --dry-run` to preview that target. The grid icon's
editable source is `assets/switchboard.svg`; packaging generates its PNG and ICNS
versions on macOS. To uninstall on macOS, delete the desktop app and remove it from
the Dock. On Windows, quit the app, delete its install folder and desktop shortcut.

Mac-specific integrations (Finder clipboard files and Quick Look PDF cover images)
are unavailable on Windows. Port probing works on Windows, but process working
directories are not attributed there; Start/Stop tracks its own process trees by
PID and creation time instead. Workspace commands must work on the host OS: a
Mac shell script does not become a Windows command automatically.

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
  closing a terminal window does, and `claude --continue` picks the conversation back up
  (yours: it passes over ✦ Answer's conversations about that workspace).
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
- **Whiteboards** — the row under Pull requests in the sidebar: flowcharts, notes,
  Markdown documents and pictures, in folders you make. A whiteboard belongs to no
  workspace. The screen lists your folders on the left — **All whiteboards**, **Recent**,
  each folder of yours, **No folder** and **Archived** — and the boards on the right, one
  row each: its name, when you last edited it, how many boxes it has, and which
  workspaces its answers read; **Open** is the one action. **New folder** and **New
  whiteboard** are at the top (a new whiteboard lands in the folder you are looking at),
  a row dragged onto a folder moves there, and a folder's **…** renames it, or deletes it
  once it is empty — a folder is never deleted with a whiteboard still in it.

  Whiteboards open in tabs, as many as you like, one on screen at a time. The strip
  across the top starts with **Whiteboards** — this list, pinned, never closed — then a
  tab per open whiteboard with its folder under its name; **+** opens another (search
  every whiteboard, or pick from the ones edited last and the folders, or make a **New
  whiteboard…**), × or a middle click closes one, ⌘W closes the one on screen, ⌃Tab and
  ⌃⇧Tab go round them and ⌘1–9 pick one. Drag a tab to move it; right-click for Close
  other tabs, Close tabs to the right and Show in Whiteboards. A whiteboard on another tab
  shows a blue dot when one of its terminals rings and a violet one while ✦ Answer is
  still drawing on it. Closing a tab never asks — whiteboards save as you go. The tabs
  are still there after a relaunch, and the rail's **Whiteboards** comes back to the one
  you left (full screen, if it was); pressed again, it shows the list. The bar over the
  canvas holds full screen and **Actions**: **Open terminal…**, **Show or hide
  terminals** (⌘A), **Rename…**, **Move to folder…**, **Duplicate** (opened in a tab of
  its own, with its own copies of the documents on it), **Archive** and **Delete**. Esc
  never takes you out of a whiteboard; the Whiteboards tab does. A whiteboard whose file
  can't be read says so, with **Try again** for once it is fixed. Click a shape on the
  toolbar down the left and click the canvas to place it; with a box selected, Tab adds
  the next one joined to its right and starts you typing, ⇧Tab steps back, the arrow keys
  move between boxes and ⌘D duplicates. Drag from a box's dot to draw an arrow: drawn
  from a box's right side into another's left, or from its bottom into another's top, it
  joins that box into the branch, which is laid out around it — boxes to the right stack
  under one another, boxes below spread side by side — and Tab on a box whose boxes all
  hang below it adds the next one below too. While typing in a box, **Code block** on the
  text toolbar (⌘E) turns the selected lines into a code block: monospace, its spaces
  kept, with a copy button in its corner; Enter in it is a new line, Tab indents, and Enter
  on an empty last line leaves it. Drop,
  paste or pick a picture to put it on the canvas, or find one with **Search Google
  Images** on the picture tool (or G): Google's own image results open in a panel beside
  the canvas, searching the selected box's words, and a picture dragged out of it — or
  right-clicked ▸ Add Image to Whiteboard — goes onto the whiteboard like a dropped file,
  at its full size rather than the thumbnail's. Paste or drop a YouTube link and it is
  that video, playing on the whiteboard (**Videos**, below). Hover over a picture or document and
  click the copy button in its bottom-right corner to copy its local file path for
  pasting into a terminal. Document edits are saved before the path is copied; the
  document panel's `.md file` button does the same. Tab keeps a branch symmetrical
  around the box it hangs off, and so do ✦ Answer's boxes and a delete; anything in the
  branch's way moves aside. A box drags everything hanging off it along; drag one up or
  down among its siblings and let go, and it takes that place, back in line, the branch
  re-centred around it. The link in its toolbar **detaches** it, to move it on its own
  (click again to attach it). A drag-select takes every box it touches, and ⌘C / ⌘V copy
  boxes and paste them at the pointer. An arrow's toolbar can **collapse** it: what it
  points at, and everything beyond, folds away behind a "+N" on the box, and the branch
  closes up; click the "+N" to bring it back. A whiteboard has no limit on boxes. A
  toolbar floats over whatever is selected: shape, colour and outline for a box, size and
  style for its text, label and line for an arrow. It saves as you go; ⌘Z and ⇧⌘Z undo
  and redo. Each whiteboard is a file in `~/.switchboard/whiteboards/` — never in your
  repo.

  **Timers** live on the canvas too. Pick **Timer** (O) and click to place a card;
  drag its header or resize it like other board items. Name it, choose **5m**, **15m**,
  **25m**, **60m**, or click the countdown to enter minutes, `mm:ss` or `h:mm:ss`
  (1 second to 24 hours). **Start**, **Pause**, **Resume** and **Reset** stay on the
  card. A paused timer keeps its remaining time; editing its duration starts a fresh
  session. At zero, the card says **Time’s up** and offers **Restart** or **Dismiss**.
  The speaker toggles its completion chime. Timers keep running on other boards and
  after closing a tab; the timer indicator beside the tabs lists them and returns you
  to a card. An alarm also posts a desktop notification when the app is in the
  background. Deadlines survive relaunch; a timer that expired while the app was quit
  or the Mac asleep alerts when it returns. Duplicated cards and boards start idle.
  `npm run test:timers:browser` checks timer controls and background completion in an
  isolated Electron profile.

  **Terminals** float over a whiteboard: **Open terminal…** asks which workspace — the
  whiteboard's own first, then the ones you used recently, then the rest, with a search
  box — and any number can be open at once, one per workspace. Each is that workspace's
  own shell, with the same scrollback: what you type there shows on its Terminal tab, so
  Claude or Codex can work beside the canvas. Each new one opens a step down and to the
  left of the last. Drag one by its header, resize it from any edge or corner, and click
  it to bring it to the front; its dot turns blue when Claude finishes a turn, until you
  click into it. **Minimize** folds it into the tray at the bottom right, and **Close**
  takes it off the whiteboard and leaves the shell running. The tray has a chip for every
  terminal on the whiteboard, **Tile** lines the open ones up along the right edge in the
  order they stand, and **+** opens another (press it again to put its list away); the
  zoom buttons move up above the tray while it shows. ⌘A hides and shows them all; it is
  still Select All while you edit a label, a document or a field. **Pin** drops a
  terminal onto the whiteboard where it is: it becomes a box that moves and zooms with
  the canvas, resizes from the same handles, and is saved with the whiteboard; **Float**
  lifts it back out at the same spot. Neither clears or reconnects anything, nor moves
  the text, and the terminal keeps the keyboard if it had it. The toolbar, undo bar and
  zoom buttons stay clickable over a pinned terminal. Zoomed far out, a pinned terminal
  shows **Zoom in to use**.

  Choose **Document** on the toolbar and click or drag it onto the canvas. A document
  appears as an icon and name; double-click it or press Enter to open a scrollable
  floating panel. Its controls also offer a docked panel and a wider focus view.
  **Read**, **Write**, and **Split** show rendered Markdown, source, or both. Tab and
  ⇧Tab indent and outdent Markdown before any canvas shortcuts run. Text autosaves to
  `~/.switchboard/whiteboards/documents/<document-id>.md`; renaming the card keeps its
  filename, and moving the whiteboard to another folder moves no file. The footer copies
  the file path for opening it elsewhere. Copies get independent files, and removing a
  card keeps its file for undo and recovery. External edits reload when you return to
  Switchboard; conflicting edits offer **Reload file** or **Save my version**. Archived
  documents open for reading.

  **Teleport** (P on the toolbar) is a button on the canvas that takes you to another
  box on the same whiteboard, however far away. Place one and it asks where it goes:
  click the box — nothing is drawn between them, and under the word Teleport it says
  "to" and that box's words. Click the teleport (or select it and press Enter) and the
  view flies to its box and selects it; **Back** at the top of the canvas puts the view
  where it was. The crosshair on its corner, or **Change destination** in its toolbar, picks
  another box; Esc or a click on empty canvas leaves it as it was. ⇧- or ⌘-click
  selects a teleport without going anywhere. Delete the box it goes to and it says **No
  destination yet** until you pick another (⌘Z brings both back). Arrows can still point
  at a teleport, so it works as a flowchart's off-page connector.

  **Record**, just below Image on the whiteboard's side toolbar, records your laptop
  camera and microphone. Allow access when macOS asks; a movable, resizable preview
  stays within that whiteboard and shows elapsed time, microphone mute, and **Stop & save**.
  Drag its corner to make it larger. Stopping adds the saved recording to that board
  as a video card with a first-frame thumbnail, play/pause, seeking, volume, and the
  same resize handles as YouTube videos. Click the pencil beside its title (or
  double-click the title) to rename it; Enter or a click away saves, and Escape cancels.
  Saving prepares the full timeline so you can immediately seek anywhere, including
  near the end. Older WebM recordings are prepared once when first opened.
  The files stay in `~/Movies/Switchboard/`;
  the board keeps a local reference and plays them again after reopening. Closing a
  recording's tab or quitting stops, saves, and adds its video before closing. This
  records your camera and voice; whiteboard activity is not included in the video.
  Interrupted recordings keep any bytes already written
  as `.partial.webm` or `.partial.mp4` files in the same folder. Recording needs no
  account, server, or upload.

  **Videos** are YouTube's, played in a box on the whiteboard. Paste a YouTube link (⌘V)
  and its video lands at the pointer; drop one — or a video's picture dragged off
  YouTube — and it lands where you let go. Type or paste a link into a box and, when you
  finish (Enter, **Done**, or a click elsewhere), a box whose words are only that link
  becomes its video, where the box was and keeping its arrows; ⌘Z makes it the box again
  (and it stays a box until you change the link). A link inside a sentence stays words.
  A link's time (`t=1m30s`) is where the video starts, a Short stands up, and a link from
  a playlist is its one video. The video is named for its title once YouTube says what
  that is ("YouTube video" until then). Its strip, which you drag it by, has **Open on
  YouTube** and, while it plays, **Stop**; under it is YouTube's picture of the video.
  Click the picture (or select the video and press Enter) to play it there; Enter again
  or Stop puts the picture back, and so does leaving the whiteboard or going in or out of
  full screen. A video you leave part way — paused or playing — remembers where it got
  to for as long as Switchboard runs: the picture says so ("Resume at 3:42", with a red
  line along its bottom as far as you got), and the next play takes it up there. Stop,
  or watching it to the end, starts it over next time. Resized from its sides or bottom
  corners, it keeps the video's shape. ⌘C
  copies it as its YouTube link, its start included, so it pastes as a link anywhere else
  and as a copy back on a whiteboard. Tab after a video adds a plain box. An archived
  whiteboard plays its videos too.

  **✦ Answer** leads a box's toolbar (and ⌘I or ⌘↵): write a question in a box and the
  answer comes back as a box for each part it has, hanging off it, as one undo step. Several boxes
  can wait on their answers at once. The chevron beside it picks who answers — **Claude
  Code** or **Codex**, which run in the whiteboard's workspace and read its code before
  they answer (slower; a card over the canvas shows each file they open), or the **Claude
  API** or **OpenAI API**, which see only the whiteboard and answer in seconds. Which
  workspace the CLIs read is the whiteboard's: the **Workspace** row in the same menu
  names it, and **Change…** picks another from a short list (the ones you used recently
  first, with search); the APIs ignore it. A new whiteboard starts with the workspace you
  used last while it is still in the sidebar (else the most recent one that is), and a
  box an answer made carries a small tag naming the workspace that was
  read. With no workspace chosen, a CLI says so and offers **Choose workspace…** instead
  of answering. The CLIs can only
  read: Claude Code gets nothing but its read and search tools (and, with Web access, its
  web fetch and search), and Codex runs in its read-only sandbox. Install and sign in to the CLI you use on each Mac; Switchboard finds
  it, and picks the first one that can answer. With a CLI, every answer on one whiteboard
  continues one conversation with it, whichever box asks, so it already knows the branches
  you have explored there; only a whiteboard it has never answered on starts one. The
  **Conversation** row in the same menu says how many questions it holds, and **New
  conversation** makes the next answer start afresh. Answers on one whiteboard take turns —
  the card says so while one waits — and a copy of a whiteboard, or one given another
  workspace, starts a conversation of its own. The APIs and ✦ Condense take each question
  on its own, and so does a Codex older than 0.132, which can't continue one — the row
  says so. Under the chevron, and in Settings, **Web access** (on) lets whichever answers
  open a link in the question or search the web, only when the question needs it. Under
  the chevron alone, **Details** says how much each answer box holds: **Low** (the
  default) a few words; **Medium** two or three sentences, in a wider box; **High** a
  full paragraph, wider still. An answer never writes a second line under a box. Every
  answer reads the boxes leading up to its question.

  **✦ Condense** appears when you drag-select several connected text nodes, including
  sibling branches with the same parent (⌘I also works). It replaces the discussion
  with a few readable concept nodes, keeps the original parent connected, and preserves
  unselected branches. It uses the selected discussion as its evidence, so it needs no
  workspace. The originals
  stay until the summary is ready; **Stop** cancels it and **Undo** restores the entire
  discussion in one step. If the selected discussion changes while it thinks, retry
  with the updated selection.

  Your diagrams from before moved here the first time this version opened: each
  workspace's diagrams went into a folder named after its project, marked **moved** until
  you change something in it, kept their workspace for ✦ Answer, and brought their
  documents and pictures along — a document the move missed is brought over the first
  time you open it, and nothing is ever half-copied. The old folder was renamed
  `~/.switchboard/diagrams-before-whiteboards`, and nothing was deleted. A Grid square
  that showed a workspace's diagrams opens its Terminal now: whiteboards have a screen of
  their own.
- **Databases** — save multiple named Neon/PostgreSQL or MongoDB connections for each
  workspace. Choose a connection, then a table, view or collection to fetch its records;
  Refresh (or ⌘R) reads them again. Click a row to see every field, including nested
  objects and arrays. Connections require a URI containing the database name and are
  verified before being saved. The browser issues reads only; PostgreSQL queries run
  in read-only transactions. Large tables scroll without creating a DOM node for every
  record. A fetch past 100,000 records, 32 MB or its timeout reports an error instead of
  quietly showing incomplete data. Removing a saved connection leaves its database intact.
- **Settings** — the row under Usage, or ⌘,: who answers ✦ Answer on this Mac, one row
  each — whether a CLI is installed and signed in, and the keys for the two APIs with the
  model each one uses — and the Web access switch. The workspace a CLI
  reads is not here: each whiteboard keeps its own. A key is checked with its provider before it is kept, encrypted with
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
- **Grid** — the row above the workspaces (⌘0): four panes side by side, in views you
  make. Press **+**, name it, then put a workspace in each square; "Sample" for
  sample-1 to sample-4, "Everything else" for the rest, and switch between them the way
  you switch tabs. The ⋯ at the right holds **Edit** and Delete. Edit is one mode for
  everything about the view showing: its tab becomes a name field to rename it, the ‹ ›
  either side move it along the row, and the squares can lose a workspace (×) or gain
  one (Add workspace) — click another tab to edit that one too, and Done to finish. It
  is the only place a square's × shows, so a slip of the hand cannot empty one. The bar
  beside the ⋯ is this session's Claude usage. Each workspace square switches between
  **Terminal** and **Changes** using the buttons in its header. Changes shows the
  workspace's repository summary, with compact green `+` and red `−` counts in its button.
  A square never shows a whiteboard: one whiteboard can hold terminals for any number of
  workspaces, so it has a screen of its own, and a square that used to show one opens
  Terminal. The Terminal is the same shell and scrollback as the workspace tab, and keeps
  running while Changes is shown. A
  square can also hold **any folder** rather than a workspace: the picker's
  first row, **Choose a folder…**, opens the Mac's folder chooser, and the square becomes
  a shell in that folder — the apps folder itself, a repo outside it, anything — on no
  rail and with no screen of its own. Views are remembered in the config; the window
  comes back to the Grid if that is where you left it.
- **Usage** — how much of your Claude plan is used, read through Claude Code's own
  sign-in. The sidebar row and the session gauge only appear after a local Claude OAuth
  sign-in is found; a machine with only Codex shows neither. Removing the Claude
  sign-in clears the cached numbers and hides the display on the next check.
  The five-hour session is the bar at the top of the Grid and of Whiteboards (out of
  sight while a whiteboard is full screen); the **Usage** row at
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
  (⌃⌘S); it is remembered, ⌘1–9 still switch workspace without it (on the Whiteboards
  screens, with a whiteboard open in a tab, they pick a tab), and if a shell rings
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
rename, a delete. Whiteboards are files of its own too, in
`~/.switchboard/whiteboards/`: `store.json` (your folders, the workspaces you used last
and the one-time notice), `boards/` (one JSON file per whiteboard, with its ✦ Answer
conversations), `documents/` (the
Markdown documents on them) and `images/` (their pictures, kept once each). A folder is
an entry in `store.json`, not a directory, so moving a whiteboard or renaming a folder
moves no file. ✦ Answer runs `claude` or `codex` in the folder of the whiteboard's
workspace with read-only tools, or calls the Anthropic or OpenAI API directly with a key
you entered. A CLI keeps a whiteboard's conversation where it keeps its own: a Claude
Code session named `Whiteboard · <its name>` with the workspace's own sessions — kept as
a print-mode session, which `claude --continue` and `claude --resume` there pass over,
so yours always come back first (an older Claude Code may offer it too) — or a Codex
thread; the whiteboard's file holds only which one, never the conversation itself. A whiteboard's Google Images panel is Google's own page, in a session of
its own, and fetches a picture you add from it from wherever that picture lives; it
loads nothing until you open it. A board's file keeps a YouTube video as its id, where
it starts and its title, never an address. Its picture comes from YouTube's image
server (i.ytimg.com) whenever the board is drawn; its title is asked of YouTube once,
when the video is made (an oEmbed request to www.youtube.com, sent without cookies); and
YouTube's player, from www.youtube-nocookie.com, loads only when you press Play. Database browsing connects directly to the database
URI you supply, from the main process; credentials never return to the renderer.
Dev commands also run in local shells. Claude usage
uses the direct request described above; local port checks use sockets and system
utilities, and ngrok discovery calls its local HTTP API.

The source does not need account credentials. Each computer uses its own Git/GitHub
and coding CLI sign-ins. Switchboard's configuration stays in
`~/.switchboard/config.json`, your whiteboards beside it in
`~/.switchboard/whiteboards/`, and any API keys for ✦ Answer, encrypted with the
Keychain, in `~/.switchboard/keys.json`. Diagrams from before Whiteboards were copied
into `~/.switchboard/whiteboards/` once, and their old folder renamed
`~/.switchboard/diagrams-before-whiteboards/`, where they still are; nothing reads it
again but a picture or document the copy missed (a document is copied in when first
opened). Database connection URIs are also encrypted
through Electron's OS credential storage, in `~/.switchboard/databases/`; saving a
connection requires secure encryption support. An alternate `SWITCHBOARD_CONFIG`
keeps this data beside that config file. Older markdown files in
`~/.switchboard/notes/` remain on disk but are no longer opened or changed by
Switchboard. Window state, browser storage (the Google Images panel's cookies included), and publish
logs live in Electron's Application Support folder. Terminal programs can save their own
history and credentials outside this checkout. Pasted images are saved in a temporary
Switchboard folder.

Commit the source and `package-lock.json`. The `.gitignore` excludes dependencies,
built apps, environment files, common credential files, logs and local app state.
Keep personal paths, project names, and configuration backups out of tracked files.
The default config stays empty; documentation and the example use fictional names.
Review the staged files before publishing.
`"private": true` in `package.json` prevents accidental npm publication; it does not
prevent hosting the Git repository publicly.
