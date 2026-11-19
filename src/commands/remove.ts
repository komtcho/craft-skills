import { CraftError, type CommandContext, type SkillEntry } from "../types.js";
import { assertSafeTarget } from "../core/agents.js";
import { getSkill, MANIFEST_FILE, readManifest, writeManifest } from "../core/lockfile.js";
import { removeSkillDir } from "../core/skill.js";
import * as ui from "../core/ui.js";

/** Deletes a skill's target folders and its manifest entry. */
export async function removeCommand(name: string, ctx: CommandContext): Promise<SkillEntry> {
  const manifest = await readManifest(ctx.cwd);
  if (!manifest) {
    throw new CraftError(`No ${MANIFEST_FILE} found in ${ctx.cwd}.`, "There is nothing to remove.");
  }

  const entry = getSkill(manifest, name);
  if (!entry) {
    const installed = Object.keys(manifest.skills).sort();
    throw new CraftError(
      `Skill "${name}" is not installed.`,
      installed.length > 0 ? `Installed skills: ${installed.join(", ")}.` : "No skills are installed.",
    );
  }

  // Validate all targets first so a bad entry never leaves a half-removed skill.
  for (const target of entry.targets) await assertSafeTarget(ctx.cwd, target);
  for (const target of entry.targets) await removeSkillDir(ctx.cwd, target);

  delete manifest.skills[name];
  await writeManifest(ctx.cwd, manifest);
  ui.success(`Removed ${name}${entry.targets.length > 0 ? ` (${entry.targets.join(", ")})` : ""}.`);
  return entry;
}
