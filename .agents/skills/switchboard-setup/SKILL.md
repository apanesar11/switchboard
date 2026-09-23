---
name: switchboard-setup
description: Set up or update Switchboard workspaces, dev commands, local links, and terminal grids on the user's computer. Use when the user asks to onboard their projects or populate their local Switchboard configuration.
---

# Set up Switchboard workspaces

Configure the user's own folders in `~/.switchboard/config.json`. If
`SWITCHBOARD_CONFIG` is set, use that location instead and ensure it is outside
the checkout or ignored by Git. Keep all machine-specific settings out of tracked
files: leave `src/main/default-config.json` as `{}` and keep
`config.example.json` fictional. Never commit workspace inventories, absolute
personal paths, credentials, or local configuration backups.

1. Read the repository's [example](../../../config.example.json),
   [configuration code](../../../src/main/config.js), and the Config section of
   [ARCHITECTURE.md](../../../ARCHITECTURE.md). Read the existing local config
   without dumping its contents into logs or public documentation. If it is
   malformed, explain the error and resolve it without overwriting it silently.
2. Use folders the user has already identified. If none are known, ask where the
   projects live and which ones to include. Inspect only those folders. Read
   package manifests, lockfile names, and dev-server configuration to determine
   commands and ports. Do not read credential files or `.env` values, and do not
   execute project scripts during setup.
3. Build the requested entries using these rules:
   - `root` is an absolute path or starts with `~/`. It is optional when all
     workspace `dir` values are absolute. Setting a root enables discovery of
     its child folders with at least two immediate Git repositories; use
     explicit absolute `dir` entries without a root for a curated selection.
   - `workspaces.<id>.dir` declares a folder, including a single Git repository.
     Relative directories resolve under `root`; `~/` works here too. A discovered
     workspace with the same ID takes precedence, so choose unambiguous IDs.
   - IDs ending in `-<number>` share a project. Matching numeric suffixes are
     removed from child repo display names. Put shared settings in
     `projects.<project>` and overrides in `workspaces.<id>`.
   - Set `devCommand` explicitly with the project's actual package manager. If
     there is no root command, use `processes: [{name, dir, command}]`; order
     processes by their startup dependencies. A terminal-only workspace can use
     `devCommand: null`. Do not invent scripts or ports.
   - Local links can use `links: [{repo, url}]` on a workspace, where `repo` is
     the display name. Add only known addresses. Optional repo presets live in
     `repos.<displayName>` with `url` and `startedByRootDev`.
   - Optional `grid.views` entries have a unique `id`, a `name`, and exactly four
     `cells`: workspace IDs, absolute folder paths, or `null`.
4. Preserve unrelated settings and existing workspaces unless removal was
   requested. Save a backup beside the local config, outside Git, before editing
   an existing file. Write valid JSON atomically, keeping the file private to
   the user. Configuration contains paths and commands, never secret values.
5. Validate JSON and directory existence, then invoke `workspaces.discover()`
   using `SWITCHBOARD_CONFIG` to verify the intended entries resolve. This is
   local, read-only discovery; do not start servers, shells, Git operations, or
   network integrations. Confirm which IDs were added and explain that
   Switchboard's Refresh action or a relaunch loads the configuration.

If the user requests setup only, make no changes to tracked repository files.
