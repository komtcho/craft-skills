<!-- markdownlint-configure-file { "MD024": { "siblings_only": true } } -->

# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-20

First release.

### Added

- `add <source>`: install a skill from GitHub with `--skill`, `-a/--agent`, `--ref` and `--force`.
- `list` (`ls`): show installed skills, with `--json` for scripts.
- `install` (`i`): restore every skill at its locked commit; `--update` re-resolves refs
  and records the new commits. It continues past failures and exits 1 at the end if any failed.
- `remove` (`rm`): delete a skill's folders and its manifest entry.
- Source formats: `owner/repo[/path][@ref]`, `github:owner/repo[/path][@ref]`, and GitHub
  repository, `tree/` and `blob/` URLs.
- Agent targets under `skills/<name>/`: `.agent`, `.claude`, `.cursor`, `.codex`,
  `.windsurf`, `.agents` (the folder shared by Codex, Amp, Gemini CLI, Cursor, OpenCode and
  Copilot), `.github` (Copilot), `.gemini`, `.opencode`, `.roo` and `.kiro`. Resolved from
  `--agent`, then `defaultAgents`, then detected folders, then `agent`. Copilot is detected
  only by `.github/skills/` or `.github/copilot-instructions.md`, not by a bare `.github/`.
- `craft-skills.json` manifest: validated on read, written atomically with sorted keys.
- `GITHUB_TOKEN` / `GH_TOKEN` support, with clear messages and hints for 401, 403/429
  (with the reset time), 404, 422 and network errors.
- Safety: targets are restricted to `<agent folder>/skills/<name>` inside the project,
  agent folders that link outside the project are refused, skill folders are written
  atomically, symlinks and submodules are skipped, and skills are capped at 500 files.
- `craft` as a short alias for the `craft-skills` command.

[0.1.0]: https://github.com/komtcho/craft-skills/releases/tag/v0.1.0
