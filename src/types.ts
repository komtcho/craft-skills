import type { AgentId } from "./core/agents.js";

/** Supported agent identifiers, derived from the mapping in `core/agents.ts`. */
export type { AgentId };

/** One installed skill, as recorded in `craft-skills.json`. */
export interface SkillEntry {
  /** Source repository, e.g. `github:owner/repo`. */
  source: string;
  /** Path of the skill inside the repo (`.` for the repo root). */
  path: string;
  /** Branch, tag or sha the user asked for. */
  ref: string;
  /** Resolved 40-char commit sha (the lock). */
  commit: string;
  /** Project-relative install directories, e.g. `.claude/skills/pdf`. */
  targets: string[];
  /** ISO-8601 timestamp of the last install. */
  installedAt: string;
}

/** Shape of `craft-skills.json`. */
export interface Manifest {
  defaultAgents: AgentId[];
  skills: Record<string, SkillEntry>;
}

/** A parsed `<source>` argument. */
export interface ParsedSource {
  owner: string;
  repo: string;
  /** Path inside the repo, `.` for the root. */
  path: string;
  /** Explicit ref, if the source (or `--ref`) carried one. */
  ref?: string;
}

/** A file belonging to a skill, relative to the skill directory. */
export interface SkillFile {
  path: string;
  content: Uint8Array;
}

/** What every command needs from the outside world. */
export interface CommandContext {
  /** Project root: where `craft-skills.json` and the agent folders live. */
  cwd: string;
}

/** A user-facing error: printed as message + optional hint, exit code 1. */
export class CraftError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "CraftError";
    this.hint = hint;
  }
}
