import { CraftError, type AgentId, type CommandContext, type ParsedSource } from "../types.js";
import { agentTarget, assertSafeTarget, resolveAgents } from "../core/agents.js";
import { fetchSkill, parseManifestSource } from "../core/github.js";
import { MANIFEST_FILE, readManifest, writeManifest } from "../core/lockfile.js";
import { writeSkillDir } from "../core/skill.js";
import * as ui from "../core/ui.js";

export interface InstallOptions {
  /** Re-resolve each `ref` and record the new commit instead of using the lock. */
  update?: boolean | undefined;
}

export interface InstallResult {
  installed: string[];
  updated: string[];
  failed: { name: string; error: unknown }[];
}

/**
 * Installs every skill from the manifest. By default uses the locked `commit`;
 * with `--update` re-resolves `ref`. Keeps going past per-skill failures and
 * throws a summary `CraftError` at the end if any failed.
 */
export async function installCommand(opts: InstallOptions, ctx: CommandContext): Promise<InstallResult> {
  const manifest = await readManifest(ctx.cwd);
  if (!manifest) {
    throw new CraftError(
      `No ${MANIFEST_FILE} found in ${ctx.cwd}.`,
      "Run `craft-skills add <source>` to install your first skill.",
    );
  }

  const result: InstallResult = { installed: [], updated: [], failed: [] };
  const names = Object.keys(manifest.skills).sort();
  if (names.length === 0) {
    ui.info(`No skills in ${MANIFEST_FILE}. Nothing to install.`);
    return result;
  }

  let fallbackAgents: AgentId[] | undefined;
  let changed = false;

  for (const name of names) {
    const entry = manifest.skills[name]!;
    try {
      let targets = entry.targets;
      if (targets.length === 0) {
        fallbackAgents ??= (await resolveAgents({ cwd: ctx.cwd, defaults: manifest.defaultAgents })).agents;
        targets = fallbackAgents.map((agent) => agentTarget(agent, name));
      }
      // Validate every target before fetching or writing anything for this skill.
      for (const target of targets) await assertSafeTarget(ctx.cwd, target);

      const { owner, repo } = parseManifestSource(entry.source);
      const source: ParsedSource = { owner, repo, path: entry.path, ref: entry.ref };
      const fetched = opts.update ? await fetchSkill(source) : await fetchSkill(source, { commit: entry.commit });

      for (const target of targets) await writeSkillDir(ctx.cwd, target, fetched.files);

      const commitChanged = fetched.commit !== entry.commit;
      if (commitChanged || targets !== entry.targets) {
        manifest.skills[name] = { ...entry, commit: fetched.commit, targets, installedAt: new Date().toISOString() };
        changed = true;
      }
      result.installed.push(name);
      if (commitChanged) {
        result.updated.push(name);
        ui.success(`Updated ${name}: ${entry.commit.slice(0, 7)} → ${fetched.commit.slice(0, 7)} (${entry.ref})`);
      } else {
        ui.success(`Installed ${name} (${entry.ref} @ ${fetched.commit.slice(0, 7)}) → ${targets.join(", ")}`);
      }
    } catch (error) {
      result.failed.push({ name, error });
      const message = error instanceof Error ? error.message : String(error);
      ui.error(`${name}: ${message}`, error instanceof CraftError ? error.hint : undefined);
    }
  }

  if (changed) await writeManifest(ctx.cwd, manifest);

  if (result.failed.length > 0) {
    throw new CraftError(
      `${result.failed.length} of ${names.length} skill(s) failed to install: ` +
        `${result.failed.map((f) => f.name).join(", ")}.`,
      "See the errors above. Skills that succeeded were installed.",
    );
  }
  ui.success(`Installed ${result.installed.length} skill(s).`);
  return result;
}
