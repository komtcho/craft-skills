import { readFileSync } from "node:fs";
import { Command, CommanderError } from "commander";
import { CraftError } from "./types.js";
import { addCommand } from "./commands/add.js";
import { listCommand } from "./commands/list.js";
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

const collect = (value: string, previous: string[]): string[] => [...previous, value];

export function createProgram(cwd: string): Command {
  const ctx = { cwd };
  const program = new Command()
    .name("craft-skills")
    .description("Install AI agent skills from GitHub into your project")
    .version(readVersion(), "-v, --version")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => ui.getOutput().out(text),
      writeErr: (text) => ui.getOutput().err(text),
    });

  program
    .command("add")
    .description("Fetch a skill from GitHub and install it for your agents")
    .argument("<source>", "owner/repo[/path][@ref], github:owner/repo[/path][@ref] or a GitHub URL")
    .option("-s, --skill <name>", "skill name (default: from SKILL.md, the folder, or the repo)")
    .option("-a, --agent <agents>", "agents to install for, comma-separated or repeated", collect, [])
    .option("-r, --ref <ref>", "branch, tag or commit (overrides any ref in <source>)")
    .option("-f, --force", "overwrite an installed skill or existing folder")
    .action(async (source: string, opts: { skill?: string; agent: string[]; ref?: string; force?: boolean }) => {
      await addCommand(source, opts, ctx);
    });

  program
    .command("list")
    .alias("ls")
    .description("List installed skills")
    .option("--json", "print machine-readable JSON")
    .action(async (opts: { json?: boolean }) => {
      await listCommand(opts, ctx);
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
