import { stat } from "node:fs/promises";
import path from "node:path";
import { CraftError, type AgentId, type CommandContext, type SkillEntry } from "../types.js";
import { agentTarget, parseAgents, resolveAgents } from "../core/agents.js";
import { describeSource, fetchSkill, formatSource, parseSource } from "../core/github.js";
import { emptyManifest, getSkill, readManifest, writeManifest } from "../core/lockfile.js";
import { assertValidSkillName, removeSkillDir, resolveSkillName, writeSkillDir } from "../core/skill.js";
import * as ui from "../core/ui.js";

export interface AddOptions {
  skill?: string | undefined;
  agent?: string[] | undefined;
  ref?: string | undefined;
  force?: boolean | undefined;
}

export interface AddResult {
  name: string;
  entry: SkillEntry;
  agents: AgentId[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** fetch → name → agents → write targets → update manifest. */
export async function addCommand(sourceArg: string, opts: AddOptions, ctx: CommandContext): Promise<AddResult> {
  // Validate all local input before touching the network.
  const source = parseSource(sourceArg, opts.ref);
  const flagAgents = opts.agent && opts.agent.length > 0 ? parseAgents(opts.agent) : undefined;
  if (opts.skill !== undefined) assertValidSkillName(opts.skill);
  const manifest = (await readManifest(ctx.cwd)) ?? emptyManifest();

  ui.info(`Fetching ${describeSource(source)} ...`);
  const fetched = await fetchSkill(source);
  const name = resolveSkillName({ flag: opts.skill, files: fetched.files, path: fetched.path, repo: source.repo });
  const { agents } = await resolveAgents({ cwd: ctx.cwd, flag: flagAgents, defaults: manifest.defaultAgents });
  const targets = agents.map((agent) => agentTarget(agent, name));

  const existing = getSkill(manifest, name);
  if (!opts.force) {
    if (existing) {
      throw new CraftError(
        `Skill "${name}" is already installed (from ${existing.source.replace(/^github:/, "")}` +
          `${existing.path === "." ? "" : `/${existing.path}`}).`,
        "Use --force to reinstall it, or --skill <name> to install it under another name.",
      );
    }
    for (const target of targets) {
      if (await exists(path.join(ctx.cwd, target))) {
        throw new CraftError(
          `${target} already exists.`,
          "Use --force to overwrite it, or --skill <name> to install under another name.",
        );
      }
    }
  }

  for (const target of targets) await writeSkillDir(ctx.cwd, target, fetched.files);
  if (existing) {
    for (const stale of existing.targets) {
      if (!targets.includes(stale)) await removeSkillDir(ctx.cwd, stale);
    }
  }

  const entry: SkillEntry = {
    source: formatSource(source),
    path: fetched.path,
    ref: fetched.ref,
    commit: fetched.commit,
    targets,
    installedAt: new Date().toISOString(),
  };
  manifest.skills[name] = entry;
  if (manifest.defaultAgents.length === 0) manifest.defaultAgents = agents;
  await writeManifest(ctx.cwd, manifest);

  ui.success(
    `Installed ${name} (${entry.ref} @ ${entry.commit.slice(0, 7)}, ${fetched.files.length} files) → ${targets.join(", ")}`,
  );
  return { name, entry, agents };
}
