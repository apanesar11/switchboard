# Repository privacy

`src/main/default-config.json` must stay `{}`. Put real workspace settings only
in the user's local `~/.switchboard/config.json` (or an ignored path selected by
`SWITCHBOARD_CONFIG`). Keep `config.example.json`, tests, and documentation
fictional. Do not copy local project names, repository inventories, paths,
credentials, or configuration backups into tracked files.

For workspace onboarding, use `.agents/skills/switchboard-setup/SKILL.md`.
Run `npm run check` and `npm run test:config` after changing configuration or
discovery behavior. Run `npm run test:publish` after changing packaging or
desktop update behavior.
