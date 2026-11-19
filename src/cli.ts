import { readFileSync } from "node:fs";
import { Command, CommanderError, Option } from "commander";
import { CraftError } from "./types.js";
import { AGENT_IDS, agentTarget } from "./core/agents.js";
import { addCommand } from "./commands/add.js";
import { installCommand } from "./commands/install.js";
import { listCommand } from "./commands/list.js";
import { removeCommand } from "./commands/remove.js";
import * as ui from "./core/ui.js";

/** Finds this package's version by walking up from the compiled file. */
export function readVersion(): string {
  let dir = new URL("./", import.meta.url);
  for (let i = 0; i < 4; i++) {
    try {
      const pkg = JSON.parse(readFileSync(new URL("package.json", dir), "utf8")) as Record<string, unknown>;
      if (pkg["name"] === "craft-skills" && typeof pkg["version"] === "string") return pkg["version"];
    } catch {
      // keep walking up
    }
    dir = new URL("../", dir);
  }
  return "0.0.0";
}

const collect = (value: string, previous: string[] | undefined): string[] => [...(previous ?? []), value];

const ROOT_HELP = `
Examples:
  $ npx craft-skills add owner/repo/skills/pdf
  $ npx craft-skills add https://github.com/owner/repo/tree/main/skills/pdf --agent claude,cursor
  $ npx craft-skills list
  $ npx craft-skills install            # restore skills at their locked commits
  $ npx craft-skills install --update   # move every skill to the latest commit of its ref
  $ npx craft-skills remove pdf

Skills are recorded in craft-skills.json; commit it so your team gets the same versions.
Set GITHUB_TOKEN (or GH_TOKEN) for private repositories and higher rate limits.
"craft" is a shorter alias for "craft-skills".`;

const ADD_HELP = `
Agents and install folders:
${AGENT_IDS.map((id) => `  ${id.padEnd(9)} ${agentTarget(id, "<name>")}`).join("\n")}

When --agent is not given: defaultAgents from craft-skills.json, else the agent
folders that already exist in the project, else "agent".

Source formats:
  owner/repo                      whole repository
  owner/repo/path/to/skill        a folder inside the repository
  owner/repo/path@ref             a branch, tag or commit
  github:owner/repo[/path][@ref]
  https://github.com/owner/repo/tree/<ref>/<path>   (blob/.../SKILL.md links work too)

In URLs, branch names containing "/" are ambiguous: use --ref feature/x instead.

Examples:
  $ craft-skills add owner/repo/skills/pdf
  $ craft-skills add owner/repo/skills/pdf@v1.2.0 --skill pdf --agent claude -a cursor
  $ craft-skills add owner/repo --ref release/2.0 --force`;

export function createProgram(cwd: string): Command {
  const ctx = { cwd };
  const program = new Command()
    .name("craft-skills")
    .description("Install AI agent skills from GitHub into your project")
    .version(readVersion(), "-v, --version", "print the version")
    .helpOption("-h, --help", "show help")
    .helpCommand("help [command]", "show help for a command")
    .showSuggestionAfterError()
    .showHelpAfterError("(run with --help for usage)")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => ui.getOutput().out(text),
      writeErr: (text) => ui.getOutput().err(text),
    })
    .addHelpText("after", ROOT_HELP);

  program
    .command("add")
    .description("Fetch a skill from GitHub and install it for your agents")
    .argument("<source>", "owner/repo[/path][@ref], github:owner/repo[/path][@ref] or a GitHub URL")
    .option("-s, --skill <name>", "skill name (default: SKILL.md name, then folder, then repo)")
    .addOption(
      new Option("-a, --agent <agents>", `agents to install for (${AGENT_IDS.join(", ")}); comma-separated or repeated`)
        .argParser(collect),
    )
    .option("-r, --ref <ref>", "branch, tag or commit (overrides any ref in <source>)")
    .option("-f, --force", "overwrite an installed skill or existing folders")
    .addHelpText("after", ADD_HELP)
    .action(async (source: string, opts: { skill?: string; agent?: string[]; ref?: string; force?: boolean }) => {
      await addCommand(source, opts, ctx);
    });

  program
    .command("list")
    .alias("ls")
    .description("List installed skills")
    .option("--json", "print machine-readable JSON")
    .addHelpText("after", "\nShows each skill's name, owner/repo/path, ref @ short commit, folders and install time.")
    .action(async (opts: { json?: boolean }) => {
      await listCommand(opts, ctx);
    });

  program
    .command("install")
    .alias("i")
    .description("Install every skill from craft-skills.json at its locked commit")
    .option("-u, --update", "re-resolve each ref and record the new commit")
    .addHelpText(
      "after",
      `
Without --update, every skill is installed at the exact commit recorded in
craft-skills.json, so everyone gets identical files. With --update, each
skill's ref (branch or tag) is resolved again and the new commit is saved.
A failing skill does not stop the others; the command exits 1 at the end.`,
    )
    .action(async (opts: { update?: boolean }) => {
      await installCommand(opts, ctx);
    });

  program
    .command("remove")
    .alias("rm")
    .description("Delete a skill's folders and its manifest entry")
    .argument("<name>", "installed skill name (see `craft-skills list`)")
    .addHelpText("after", "\nExample:\n  $ craft-skills remove pdf")
    .action(async (name: string) => {
      await removeCommand(name, ctx);
    });

  return program;
}

function debugEnabled(): boolean {
  return (process.env["DEBUG"] ?? "").split(",").some((s) => s.trim() === "craft" || s.trim() === "*");
}

/** Prints an error and returns the exit code. */
export function handleError(err: unknown): number {
  if (err instanceof CommanderError) return err.exitCode; // commander already printed it
  if (err instanceof CraftError) {
    ui.error(err.message, err.hint);
    if (debugEnabled() && err.stack) ui.getOutput().err(`${err.stack}\n`);
    return 1;
  }
  const message = err instanceof Error ? err.message : String(err);
  ui.error(`Unexpected error: ${message}`, debugEnabled() ? undefined : "Run with DEBUG=craft for the stack trace.");
  if (debugEnabled() && err instanceof Error && err.stack) ui.getOutput().err(`${err.stack}\n`);
  return 1;
}

/** Runs the CLI and resolves to the process exit code. Never calls `process.exit`. */
export async function main(argv: readonly string[], opts: { cwd?: string } = {}): Promise<number> {
  try {
    await createProgram(opts.cwd ?? process.cwd()).parseAsync([...argv]);
    return 0;
  } catch (err) {
    return handleError(err);
  }
}
