import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CraftError, type SkillFile } from "../types.js";
import { assertSafeTarget, isValidSkillName } from "./agents.js";

const NAME_HINT = "Names must start with a letter or digit and contain only letters, digits, '.', '_' or '-'.";

/** Throws unless `name` is a valid skill name (used for `--skill`). */
export function assertValidSkillName(name: string): string {
  if (!isValidSkillName(name)) throw new CraftError(`Invalid skill name "${name}".`, NAME_HINT);
  return name;
}

/**
 * Reads `name:` from a leading `---` frontmatter block. Deliberately tiny: top-level
 * `name:` only, optional quotes, trailing `# comment` stripped when unquoted.
 */
export function parseFrontmatterName(text: string): string | undefined {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (trimmed === "---" || trimmed === "...") return undefined;
    const match = /^name\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[1]!.trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1);
      value = end === -1 ? value.slice(1) : value.slice(1, end);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    value = value.trim();
    return value === "" ? undefined : value;
  }
  return undefined;
}

/** Turns an arbitrary string into a valid skill name, or `""` if nothing is left. */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 100)
    .replace(/[-._]+$/, "");
}

function frontmatterName(files: readonly SkillFile[], fileName: string): string | undefined {
  const file =
    files.find((f) => f.path === fileName) ?? files.find((f) => f.path.toLowerCase() === fileName.toLowerCase());
  return file ? parseFrontmatterName(new TextDecoder().decode(file.content)) : undefined;
}

export interface NameInput {
  flag?: string | undefined;
  files: readonly SkillFile[];
  /** Skill path inside the repo (`.` for root). */
  path: string;
  repo: string;
}

/** `--skill` → SKILL.md `name:` → CRAFT.md `name:` → last path segment → repo name. */
export function resolveSkillName(input: NameInput): string {
  if (input.flag !== undefined) return assertValidSkillName(input.flag);

  const candidates = [
    frontmatterName(input.files, "SKILL.md"),
    frontmatterName(input.files, "CRAFT.md"),
    input.path === "." ? undefined : input.path.split("/").pop(),
    input.repo,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const slug = slugify(candidate);
    if (slug !== "" && isValidSkillName(slug)) return slug;
  }
  throw new CraftError("Could not derive a skill name.", "Pass --skill <name>.");
}

function safeRelativeSegments(file: string): string[] {
  const segments = file.split("/");
  if (
    file === "" ||
    file.includes("\\") ||
    path.isAbsolute(file) ||
    segments.some((s) => s === "" || s === "." || s === "..")
  ) {
    throw new CraftError(`Refusing to write unsafe file path "${file}".`);
  }
  return segments;
}

/**
 * Writes a skill atomically: files go into a hidden temp sibling directory,
 * then the old directory is removed and the temp directory renamed into place.
 */
export async function writeSkillDir(cwd: string, target: string, files: readonly SkillFile[]): Promise<void> {
  const abs = await assertSafeTarget(cwd, target);
  const parent = path.dirname(abs);
  await mkdir(parent, { recursive: true });
  const tmp = path.join(parent, `.${path.basename(abs)}.tmp-${randomBytes(4).toString("hex")}`);
  try {
    for (const file of files) {
      const dest = path.join(tmp, ...safeRelativeSegments(file.path));
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, file.content);
    }
    await mkdir(tmp, { recursive: true }); // in case `files` is empty
    await rm(abs, { recursive: true, force: true });
    await rename(tmp, abs);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
}

/** Deletes an installed skill directory after validating the target. */
export async function removeSkillDir(cwd: string, target: string): Promise<void> {
  await rm(await assertSafeTarget(cwd, target), { recursive: true, force: true });
}
