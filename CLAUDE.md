# CLAUDE.md — `craft-skills`

CLI that installs AI agent skills from GitHub into a project
(`npx craft-skills add owner/repo/path`). This file records every project
decision. Follow it in every session.

## 0. Working rules

1. **Plan first.** Inspect the repo, present the plan for the current phase,
   then STOP and wait for the user's approval. Never start the next phase
   without an explicit "go".
2. **Quality gate before every commit:** `npm run typecheck` and `npm test`
   must pass. Show a short summary + the diff, then commit.
3. **Never** push, publish to npm, create tags, or change git config without
   asking first.

### Commit rules

- Author: the user, from the existing git config. Never modify
  `user.name` / `user.email`.
- Every commit message MUST end with this trailer, after a blank line:

  ```
  Co-Authored-By: Claude <noreply@anthropic.com>
  ```

- Conventional Commits: `type(scope): summary` — imperative, ≤ 72 chars,
  optional body explaining *why*.
  Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`, `build`.
- One logical change per commit. A phase may have several commits; never one
  giant commit.

## 1. Identity

- npm package: `craft-skills` (unscoped), license MIT.
- Repo: `github.com/komtcho/craft-skills` (`repository`, `homepage`, `bugs`
  set in `package.json`).
- Binaries: `"bin": { "craft-skills": "./dist/index.js", "craft": "./dist/index.js" }`.

## 2. Stack

- TypeScript, ESM (`"type": "module"`), `"module"`/`"moduleResolution": "NodeNext"`.
- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `verbatimModuleSyntax`.
- Node `>=20.12` (`@clack/prompts@1` requires 20.12). `@types/node@20` so no
  newer APIs sneak in.
- `commander@14` (v15 requires Node 22.12 — do not upgrade while we support 20).
- `@clack/prompts` — prompts **only** when stdin and stdout are TTYs and `CI`
  is unset (`core/ui.ts#isInteractive`). Otherwise plain output and
  non-interactive fallbacks.
- Native `fetch`. No HTTP or YAML dependencies.
- Build: `tsc` → `dist/`. `#!/usr/bin/env node` at the top of `src/index.ts`.
  `"files": ["dist"]`.
- Tests: `node:test` + mocked `globalThis.fetch` + temp dirs. **No network in
  tests.** `tsconfig.test.json` compiles `src` + `test` into `.build-test/`,
  then `node --test` runs there (works identically on Node 20 and 22; no
  loader dependency).
- Scripts: `build`, `typecheck` (`tsc --noEmit`), `test`, `prepublishOnly`
  (typecheck + test + build).

## 3. Functional spec

### 3.1 Agent targets (no `.craft/` folder)

| agent      | target                       |
|------------|------------------------------|
| `agent`    | `.agent/skills/<name>/`      |
| `claude`   | `.claude/skills/<name>/`     |
| `cursor`   | `.cursor/skills/<name>/`     |
| `codex`    | `.codex/skills/<name>/`      |
| `windsurf` | `.windsurf/skills/<name>/`   |

The mapping lives in ONE constant in `core/agents.ts`.

**Agent resolution order:**
1. `-a, --agent <agents>` — comma-separated and/or repeatable; validated.
2. `defaultAgents` in the manifest.
3. Detect root folders (`.agent`, `.claude`, …) in cwd:
   - 1 found → use it.
   - several → clack multiselect (all preselected); non-interactive → all
     detected + a warning suggesting `--agent`.
   - none → `agent`.

On the first `add`, save the resolved agents as `defaultAgents`.

### 3.2 Manifest `craft-skills.json` (project root)

```json
{
  "defaultAgents": ["claude"],
  "skills": {
    "pdf": {
      "source": "github:owner/repo",
      "path": "skills/pdf",
      "ref": "main",
      "commit": "<40-char sha>",
      "targets": [".claude/skills/pdf"],
      "installedAt": "2026-11-19T14:00:00.000Z"
    }
  }
}
```

- Validate the shape on read, with clear errors.
- Write atomically (tmp + rename), keys sorted, 2-space indent + trailing newline.

### 3.3 Source parsing

Accept:
- `owner/repo`, `owner/repo/path`, `owner/repo/path@ref`
- `github:owner/repo[/path][@ref]`
- `https://github.com/owner/repo`
- `.../tree/<ref>/<path>` and `.../blob/<ref>/<path>`

Rules:
- Strip `.git`.
- A path ending in `SKILL.md` / `CRAFT.md` → its directory.
- Reject `..`.
- `--ref` overrides any ref in the source.
- Document that `/` in branch names inside URLs is ambiguous (first segment
  after `tree/`/`blob/` is taken as the ref; use `--ref` for slashed branches).

### 3.4 GitHub fetching

- Auth: `GITHUB_TOKEN` (fallback `GH_TOKEN`) as `Authorization: Bearer`.
  Always send `User-Agent` and `X-GitHub-Api-Version: 2022-11-28`.
- Flow:
  1. No ref → `GET /repos/{o}/{r}` → `default_branch`.
  2. ref → sha: `GET /repos/{o}/{r}/commits/{ref}` with
     `Accept: application/vnd.github.sha`.
  3. Files: `GET /repos/{o}/{r}/git/trees/{sha}?recursive=1`, filtered to the
     skill path. If `truncated` → recursive contents API fallback.
  4. Download: `https://raw.githubusercontent.com/{o}/{r}/{sha}/{path}`,
     concurrency ≈ 8.
- Skip symlinks (mode `120000`) and submodules. Max 500 files per skill.
- Errors → `CraftError(message, hint?)`:
  - 404 → not found (+ private repo / token hint)
  - 403/429 rate limit → show the reset time (+ token hint)
  - 401 → bad token
  - 422 → bad ref
  - network failure → readable message

### 3.5 Skill name resolution

1. `--skill`
2. `name:` in the frontmatter of `SKILL.md`, then `CRAFT.md` (simple parser,
   no YAML dependency)
3. Last segment of the path (if not `.`)
4. Repo name

Valid names: `^[A-Za-z0-9][A-Za-z0-9._-]*$`. Slugify derived names; reject an
invalid `--skill`.

### 3.6 Safety

- Every manifest target must match
  `^\.(agent|claude|cursor|codex|windsurf)/skills/<valid-name>$` **and**
  resolve inside cwd before any write or delete. A hostile manifest must not
  be able to delete arbitrary paths.
- Write skills atomically: temp sibling dir → remove old dir → rename.

### 3.7 Commands

- `add <source>` — `--skill`, `-a/--agent`, `--ref`, `--force`:
  fetch → name → agents → write targets → update manifest. If the skill exists
  in the manifest or a target dir exists → error unless `--force`. With
  `--force`, remove stale targets.
- `install` — `--update`: install all skills into their `targets` (or
  `defaultAgents` → resolution if empty). Default: the **locked `commit`**.
  `--update`: re-resolve `ref`, record the new commit. Continue past per-skill
  failures, summarize, exit 1 if any failed. Missing manifest → error + hint.
- `list` — `--json`: name, `source/path`, `ref @ shortsha`, targets,
  installedAt. Friendly message when empty.
- `remove <name>`: delete targets + entry. Unknown name → error listing the
  installed skills.
- Global: `--version` from package.json, good `--help`. Top-level handler:
  `CraftError` → message + hint, exit 1. Unexpected errors → message; stack
  only with `DEBUG=craft`.

### 3.8 Structure

```
src/
  index.ts
  types.ts                 # shared types + CraftError
  core/{agents,lockfile,github,skill,ui}.ts
  commands/{add,install,list,remove}.ts
test/
```

Commands orchestrate; logic lives in `core/`. Small, typed, pure where possible.

## 4. Development plan

One phase at a time, approval between phases.

| # | Phase | Scope | Done when | Status |
|---|---|---|---|---|
| 1 | Scaffold | `CLAUDE.md`, `package.json`, `tsconfig.json`, `.gitignore`, `types.ts`, `core/ui.ts`, test runner | `npm run typecheck` passes | in progress |
| 2 | Agents + manifest | `core/agents.ts`, `core/lockfile.ts` + tests | parse/detect/resolve agents, target safety, manifest read/validate/write tested | — |
| 3 | GitHub + skill | `core/github.ts`, `core/skill.ts` + tests (mocked fetch) | all source forms parsed; error mapping; name resolution + atomic write tested | — |
| 4 | add + list | `commands/add.ts`, `commands/list.ts`, minimal `index.ts` | `add` then `list` works end-to-end against the mock | — |
| 5 | install + remove | `commands/install.ts`, `commands/remove.ts` | locked-commit install, `--update`, partial failures, remove tested | — |
| 6 | CLI polish | final `index.ts`, help, error handler, `--version`, both bins | `node dist/index.js --help` clean; every error path prints message + hint | — |
| 7 | E2E tests | add → list → install → install --update → remove; hostile manifest; 404; rate limit; missing manifest | `npm test` green | — |
| 8 | Docs | `README.md` (install, usage, sources, agent resolution, manifest, `GITHUB_TOKEN`, commit lock, safety, roadmap) | README examples match real behavior | — |
| 9 | CI + release prep | `ci.yml` (Node 20 & 22), `release.yml` (`v*` tag → `npm publish --provenance --access public`, Trusted Publishing, `id-token: write`), `CHANGELOG.md`, version `0.1.0` | valid YAML; `npm pack --dry-run` shows only `dist`, README, LICENSE, package.json | — |

After phase 9, STOP. The user creates the tag and publishes.

## 5. Roadmap after v0.1.0 (do NOT implement now)

- Multi-skill repos: discover every `SKILL.md` under a path → picker / `--all`.
- `craft-skills update [name]` and `outdated`.
- Optional `.gitignore` management for skill folders (`--gitignore`).
- Configurable agent paths (verify real Cursor / Codex / Windsurf skill locations).
- Other sources (GitLab, local paths).
