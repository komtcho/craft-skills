# craft-skills

Install AI agent skills from GitHub into your project, for Claude, Cursor, Codex,
Windsurf, GitHub Copilot, Gemini CLI, OpenCode, Roo Code, Kiro, the shared
`.agents/` folder or a generic `.agent/` folder. Each skill is locked to an exact commit.

```sh
npx craft-skills add owner/repo/skills/pdf
```

- **No config needed.** It detects which agent folders your project already has.
- **Reproducible.** `craft-skills.json` records the exact commit of every skill;
  `craft-skills install` restores those commits.
- **Safe.** It only ever writes or deletes inside `<agent folder>/skills/<name>/` in your project.
- **Small.** Two runtime dependencies (`commander`, `@clack/prompts`); uses the native `fetch`.

## Install

Requires Node.js 20.12 or newer.

```sh
# run without installing
npx craft-skills add owner/repo/skills/pdf

# or install globally
npm install -g craft-skills
craft-skills --help
```

The package installs two equivalent commands: `craft-skills` and the shorter `craft`.

## Usage

```sh
craft-skills add <source> [--skill <name>] [-a, --agent <agents>] [--ref <ref>] [--force]
craft-skills list [--json]            # alias: ls
craft-skills install [--update]       # alias: i
craft-skills remove <name>            # alias: rm
```

### `add <source>`

Fetches the skill folder from GitHub, works out its name and the agents to install
it for, writes it to every target folder, and records it in `craft-skills.json`.

| option | meaning |
| --- | --- |
| `-s, --skill <name>` | Install under this name instead of the derived one |
| `-a, --agent <agents>` | Any id from [Agents](#agents), e.g. `claude`, `copilot`, `agents`. Comma-separated and/or repeated: `-a claude,cursor -a codex` |
| `-r, --ref <ref>` | Branch, tag or commit. Overrides any `@ref` in the source |
| `-f, --force` | Reinstall a skill that is already installed, or overwrite an existing folder. Folders the skill no longer targets are removed |

Without `--force`, `add` fails if the skill name is already in the manifest or a
target folder already exists.

```sh
craft-skills add owner/repo/skills/pdf
craft-skills add owner/repo/skills/pdf@v1.2.0 --skill pdf --agent claude -a cursor
craft-skills add https://github.com/owner/repo/tree/main/skills/pdf
craft-skills add owner/repo --ref release/2.0 --force
```

### `list`

```text
$ craft-skills list
pdf-tools
  source     owner/repo/skills/pdf
  ref        main @ 3f2a1c9
  targets    .claude/skills/pdf-tools
  installed  2026-11-19T14:00:00.000Z
```

`--json` prints an array of `{ name, source, path, ref, commit, targets, installedAt }`.

### `install`

Installs every skill in `craft-skills.json`. Run it after cloning a project, much
like `npm ci`.

- By default each skill is installed at its **locked `commit`**: no branch lookups,
  and everyone gets identical files.
- `--update` resolves each skill's `ref` again (for example the latest commit on
  `main`), installs it and records the new commit.
- If one skill fails, the others are still installed. The failures are listed at the
  end and the command exits with code 1.

### `remove <name>`

Deletes the skill's folders and its manifest entry. If the name is unknown, the error
lists the installed skills.

## Source formats

| form | example |
| --- | --- |
| `owner/repo` | `acme/skills` (the repository root is the skill) |
| `owner/repo/path` | `acme/skills/skills/pdf` |
| `owner/repo/path@ref` | `acme/skills/skills/pdf@v1.2.0` |
| `github:owner/repo[/path][@ref]` | `github:acme/skills/skills/pdf@main` |
| repository URL | `https://github.com/acme/skills` |
| folder URL | `https://github.com/acme/skills/tree/main/skills/pdf` |
| file URL | `https://github.com/acme/skills/blob/main/skills/pdf/SKILL.md` |

- A trailing `.git` is stripped.
- A path ending in `SKILL.md` or `CRAFT.md` means its folder.
- `..` is rejected.
- Without a ref, the repository's default branch is used.
- `--ref` always wins over a ref in the source.

> **Branch names containing `/` in URLs are ambiguous.** In
> `.../tree/feature/x/skills/pdf` the ref is taken to be `feature` and the path
> `x/skills/pdf`. Add `--ref feature/x` to the same URL: the extra branch segments are
> then removed from the path, giving `skills/pdf`. In the shorthand forms everything after
> `@` is the ref, so `owner/repo/skills/pdf@feature/x` works.

## Skill names

The name is the first of these that yields a valid name:

1. `--skill <name>`. It must already be valid; it is never rewritten.
2. `name:` in the frontmatter of `SKILL.md`
3. `name:` in the frontmatter of `CRAFT.md`
4. The last segment of the path
5. The repository name

Valid names match `^[A-Za-z0-9][A-Za-z0-9._-]*$`. Derived names are slugified:
`PDF Tools` becomes `pdf-tools`.

## Agents

| agent | tool | skills are installed to |
| --- | --- | --- |
| `agent` | generic | `.agent/skills/<name>/` |
| `claude` | Claude Code | `.claude/skills/<name>/` |
| `cursor` | Cursor | `.cursor/skills/<name>/` |
| `codex` | OpenAI Codex | `.codex/skills/<name>/` |
| `windsurf` | Windsurf | `.windsurf/skills/<name>/` |
| `agents` | shared folder (Codex, Amp, Gemini CLI, Cursor, OpenCode, Copilot) | `.agents/skills/<name>/` |
| `copilot` | GitHub Copilot | `.github/skills/<name>/` |
| `gemini` | Gemini CLI | `.gemini/skills/<name>/` |
| `opencode` | OpenCode | `.opencode/skills/<name>/` |
| `roo` | Roo Code | `.roo/skills/<name>/` |
| `kiro` | Kiro | `.kiro/skills/<name>/` |

Several tools also read `.agents/skills/` and `.claude/skills/`, so one of those
folders often covers more than one tool. Check your tool's documentation.

The agents for an `add` are chosen in this order:

1. `--agent`
2. `defaultAgents` in `craft-skills.json`
3. The agent folders that already exist in the project (`.claude/`, `.cursor/`, …).
   Copilot is detected only by `.github/skills/` or `.github/copilot-instructions.md`,
   because most repositories have a `.github/` folder anyway:
   - one found: that agent
   - several found: you choose in a prompt, with all of them preselected. In CI or
     without a terminal, all of them are used and a warning suggests `--agent`.
   - none found: `agent`

The first `add` saves the agents it used as `defaultAgents`, so later adds go to the
same place.

## The manifest: `craft-skills.json`

It lives in the project root. Commit it.

```json
{
  "defaultAgents": ["claude"],
  "skills": {
    "pdf-tools": {
      "commit": "3f2a1c9e8d7b6a5f4e3d2c1b0a9f8e7d6c5b4a39",
      "installedAt": "2026-11-19T14:00:00.000Z",
      "path": "skills/pdf",
      "ref": "main",
      "source": "github:owner/repo",
      "targets": [".claude/skills/pdf-tools"]
    }
  }
}
```

- `ref` is what you asked for. `commit` is what was installed (the lock).
- The file is validated on every read and invalid content is reported clearly. It is
  written atomically with sorted keys and a trailing newline, so diffs stay small.
- If `targets` is empty, `install` uses `defaultAgents`, then the agent resolution above.

Whether to commit the installed skill folders as well is up to you. With
`craft-skills.json` committed, `craft-skills install` can always recreate them.

## GitHub authentication

Anonymous requests work for public repositories but are limited to 60 per hour. Set a
token to raise that to 5,000 per hour and to read private repositories:

```sh
export GITHUB_TOKEN=ghp_...   # or GH_TOKEN
```

The token is sent as a `Bearer` token to `api.github.com` and
`raw.githubusercontent.com` only. Errors come with a hint:

| status | message |
| --- | --- |
| 404 | not found (if the repository is private, set a token) |
| 403 / 429 | rate limit exceeded, with the reset time |
| 401 | the token was rejected |
| 422 | invalid ref |

## Safety

- Every target, whether from the manifest or computed, must match
  `<agent folder>/skills/<name>` (for example `.claude/skills/pdf` or
  `.github/skills/pdf`) and resolve inside the project. An agent folder that is a
  symlink pointing outside the project is refused. A tampered `craft-skills.json`
  cannot make the tool write or delete anything else.
- Files with unsafe paths (`..`, absolute paths) are never written.
- Symlinks and submodules in the source repository are skipped. A skill may have at
  most 500 files.
- Skills are written atomically: first into a hidden temporary folder next to the
  target, which then replaces the old folder.

## Troubleshooting

- `DEBUG=craft craft-skills ...` prints stack traces for unexpected errors.
- Prompts are only shown when stdin and stdout are terminals and `CI` is not set.

## Roadmap

Not in v0.1.0:

- Repositories with several skills: find every `SKILL.md` under a path, then pick
  from a list or use `--all`
- `craft-skills update [name]` and `craft-skills outdated`
- Optional `.gitignore` management for skill folders (`--gitignore`)
- Configurable agent paths
- Other sources: GitLab and local paths

## Development

```sh
npm install
npm run typecheck
npm test          # node:test against an in-memory GitHub mock, no network
npm run build     # tsc → dist/
```

## License

[MIT](LICENSE) © Karim Mohamed
