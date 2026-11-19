import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CraftError, type AgentId, type Manifest, type SkillEntry } from "../types.js";
import { isAgentId, isValidSkillName, targetSkillName } from "./agents.js";

export const MANIFEST_FILE = "craft-skills.json";

const SHA_RE = /^[0-9a-f]{40}$/;
const SOURCE_RE = /^github:[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export function manifestPath(cwd: string): string {
  return path.join(cwd, MANIFEST_FILE);
}

export function emptyManifest(): Manifest {
  return { defaultAgents: [], skills: {} };
}

/** Own-property lookup, so names like `constructor` never hit the prototype. */
export function getSkill(manifest: Manifest, name: string): SkillEntry | undefined {
  return Object.hasOwn(manifest.skills, name) ? manifest.skills[name] : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(detail: string): CraftError {
  return new CraftError(
    `Invalid ${MANIFEST_FILE}: ${detail}.`,
    `Fix the file by hand, or delete it and add your skills again.`,
  );
}

function isRepoPath(value: string): boolean {
  if (value === ".") return true;
  if (value === "" || value.includes("\\") || value.startsWith("/")) return false;
  return value.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

function validateEntry(name: string, value: unknown): SkillEntry {
  const at = `skills.${name}`;
  if (!isPlainObject(value)) throw invalid(`"${at}" must be an object`);
  const str = (key: string): string => {
    const v = value[key];
    if (typeof v !== "string" || v === "") throw invalid(`"${at}.${key}" must be a non-empty string`);
    return v;
  };

  const source = str("source");
  if (!SOURCE_RE.test(source)) throw invalid(`"${at}.source" must look like "github:owner/repo"`);
  const repoPath = str("path");
  if (!isRepoPath(repoPath)) throw invalid(`"${at}.path" is not a safe repository path`);
  const ref = str("ref");
  const commit = str("commit");
  if (!SHA_RE.test(commit)) throw invalid(`"${at}.commit" must be a 40-character commit sha`);
  const installedAt = str("installedAt");
  if (Number.isNaN(Date.parse(installedAt))) throw invalid(`"${at}.installedAt" must be an ISO date`);

  const rawTargets = value["targets"];
  if (!Array.isArray(rawTargets)) throw invalid(`"${at}.targets" must be an array`);
  const targets: string[] = [];
  for (const t of rawTargets) {
    if (typeof t !== "string" || targetSkillName(t) !== name) {
      throw invalid(`"${at}.targets" contains an unsafe path ${JSON.stringify(t)}`);
    }
    if (!targets.includes(t)) targets.push(t);
  }

  return { source, path: repoPath, ref, commit, targets, installedAt };
}

/** Validates parsed JSON and returns a clean manifest (unknown keys are dropped). */
export function validateManifest(data: unknown): Manifest {
  if (!isPlainObject(data)) throw invalid("the top level must be an object");

  const defaultAgents: AgentId[] = [];
  const rawAgents = data["defaultAgents"] ?? [];
  if (!Array.isArray(rawAgents)) throw invalid(`"defaultAgents" must be an array`);
  for (const a of rawAgents) {
    if (typeof a !== "string" || !isAgentId(a)) {
      throw invalid(`"defaultAgents" contains an unknown agent ${JSON.stringify(a)}`);
    }
    if (!defaultAgents.includes(a)) defaultAgents.push(a);
  }

  const rawSkills = data["skills"] ?? {};
  if (!isPlainObject(rawSkills)) throw invalid(`"skills" must be an object`);
  const skills: Record<string, SkillEntry> = {};
  for (const [name, entry] of Object.entries(rawSkills)) {
    if (!isValidSkillName(name)) throw invalid(`skill name ${JSON.stringify(name)} is not valid`);
    skills[name] = validateEntry(name, entry);
  }

  return { defaultAgents, skills };
}

/** Reads and validates the manifest. Returns `null` if it does not exist. */
export async function readManifest(cwd: string): Promise<Manifest | null> {
  let text: string;
  try {
    text = await readFile(manifestPath(cwd), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch (err) {
    throw invalid(`not valid JSON (${(err as Error).message})`);
  }
  return validateManifest(data);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

export function serializeManifest(manifest: Manifest): string {
  return `${JSON.stringify(sortKeys(manifest), null, 2)}\n`;
}

/** Writes the manifest atomically: temp file in the same folder, then rename. */
export async function writeManifest(cwd: string, manifest: Manifest): Promise<void> {
  const file = manifestPath(cwd);
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, serializeManifest(manifest), "utf8");
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
