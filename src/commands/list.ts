import type { CommandContext } from "../types.js";
import { readManifest } from "../core/lockfile.js";
import * as ui from "../core/ui.js";

export interface ListOptions {
  json?: boolean | undefined;
}

export interface ListedSkill {
  name: string;
  source: string;
  path: string;
  ref: string;
  commit: string;
  targets: string[];
  installedAt: string;
}

/** `owner/repo/path` for display. */
function sourceLabel(skill: ListedSkill): string {
  const repo = skill.source.replace(/^github:/, "");
  return skill.path === "." ? repo : `${repo}/${skill.path}`;
}

export async function listCommand(opts: ListOptions, ctx: CommandContext): Promise<ListedSkill[]> {
  const manifest = await readManifest(ctx.cwd);
  const skills: ListedSkill[] = Object.entries(manifest?.skills ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => ({ name, ...entry }));

  if (opts.json) {
    ui.print(JSON.stringify(skills, null, 2));
    return skills;
  }
  if (skills.length === 0) {
    ui.print("No skills installed yet. Add one with: craft-skills add owner/repo/path");
    return skills;
  }

  for (const skill of skills) {
    ui.print(skill.name);
    ui.print(`  source     ${sourceLabel(skill)}`);
    ui.print(`  ref        ${skill.ref} @ ${skill.commit.slice(0, 7)}`);
    ui.print(`  targets    ${skill.targets.length > 0 ? skill.targets.join(", ") : "(default agents)"}`);
    ui.print(`  installed  ${skill.installedAt}`);
  }
  return skills;
}
