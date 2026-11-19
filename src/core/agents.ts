import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { CraftError } from "../types.js";
import * as ui from "./ui.js";

interface AgentSpec {
  /** Root folder; skills go in `<dir>/skills/<name>`. */
  readonly dir: string;
  /**
   * Project-relative paths whose presence means the agent is in use. Defaults to `[dir]`.
   * Needed when `dir` is shared with unrelated tooling (e.g. `.github`).
   */
  readonly detect?: readonly string[];
}

/** The single source of truth for agents: id → root folder (+ how to detect it). */
export const AGENTS = {
  agent: { dir: ".agent" },
  claude: { dir: ".claude" },
  cursor: { dir: ".cursor" },
  codex: { dir: ".codex" },
  windsurf: { dir: ".windsurf" },
  // Cross-agent folder read by Codex, Amp, Gemini CLI, Cursor, OpenCode and Copilot.
  agents: { dir: ".agents" },
  // `.github` exists in most repos, so only Copilot-specific files count as detection.
  copilot: { dir: ".github", detect: [".github/skills", ".github/copilot-instructions.md"] },
  gemini: { dir: ".gemini" },
  opencode: { dir: ".opencode" },
  roo: { dir: ".roo" },
  kiro: { dir: ".kiro" },
} as const satisfies Record<string, AgentSpec>;

/** Supported agent identifiers, derived from `AGENTS`. */
export type AgentId = keyof typeof AGENTS;

export const AGENT_IDS = Object.keys(AGENTS) as AgentId[];

/** Root folder of an agent, e.g. `.claude`. */
export function agentDir(agent: AgentId): string {
  return AGENTS[agent].dir;
}

/** Paths that mark an agent as present (by default its root folder). */
export function agentMarkers(agent: AgentId): readonly string[] {
  const spec: AgentSpec = AGENTS[agent];
  return spec.detect ?? [spec.dir];
}

/** Used when nothing else decides. */
export const FALLBACK_AGENT: AgentId = "agent";

const NAME_PATTERN = "[A-Za-z0-9][A-Za-z0-9._-]*";
const SKILL_NAME_RE = new RegExp(`^${NAME_PATTERN}$`);
const MAX_NAME_LENGTH = 100;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TARGET_RE = new RegExp(
  `^(?:${Object.values(AGENTS).map((a) => escapeRe(a.dir)).join("|")})/skills/(${NAME_PATTERN})$`,
);

export function isValidSkillName(name: string): boolean {
  return name.length <= MAX_NAME_LENGTH && SKILL_NAME_RE.test(name);
}

export function isAgentId(value: string): value is AgentId {
  return Object.hasOwn(AGENTS, value);
}

/** Project-relative, POSIX-style target directory for an agent + skill name. */
export function agentTarget(agent: AgentId, name: string): string {
  return `${agentDir(agent)}/skills/${name}`;
}

/**
 * Returns the skill name of a well-formed target (`.claude/skills/pdf` → `pdf`),
 * or `undefined` if the string is not an allowed target.
 */
export function targetSkillName(target: string): string | undefined {
  const match = TARGET_RE.exec(target);
  const name = match?.[1];
  return name !== undefined && isValidSkillName(name) ? name : undefined;
}

/**
 * Parses `--agent` values. Each value may be comma-separated; the flag may be repeated.
 * Validates every id and removes duplicates while keeping order.
 */
export function parseAgents(values: readonly string[]): AgentId[] {
  const agents: AgentId[] = [];
  for (const value of values) {
    for (const part of value.split(",")) {
      const id = part.trim().toLowerCase();
      if (id === "") continue;
      if (!isAgentId(id)) {
        throw new CraftError(`Unknown agent "${part.trim()}".`, `Valid agents: ${AGENT_IDS.join(", ")}.`);
      }
      if (!agents.includes(id)) agents.push(id);
    }
  }
  if (agents.length === 0) {
    throw new CraftError("No agent given to --agent.", `Valid agents: ${AGENT_IDS.join(", ")}.`);
  }
  return agents;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Agents with any marker (by default their root folder, e.g. `.claude/`) in `cwd`, in mapping order. */
export async function detectAgents(cwd: string): Promise<AgentId[]> {
  const found: AgentId[] = [];
  for (const id of AGENT_IDS) {
    for (const marker of agentMarkers(id)) {
      if (await exists(path.join(cwd, ...marker.split("/")))) {
        found.push(id);
        break;
      }
    }
  }
  return found;
}

export type AgentSource = "flag" | "manifest" | "detected" | "fallback";

export interface ResolvedAgents {
  agents: AgentId[];
  source: AgentSource;
}

export interface ResolveAgentsOptions {
  cwd: string;
  /** Already-parsed `--agent` values. */
  flag?: readonly AgentId[] | undefined;
  /** `defaultAgents` from the manifest. */
  defaults?: readonly AgentId[] | undefined;
  /** Override interactivity detection (tests). */
  interactive?: boolean | undefined;
  /** Override the multiselect prompt (tests). Return `null` for cancel. */
  prompt?: ((detected: AgentId[]) => Promise<AgentId[] | null>) | undefined;
}

/** Resolution order: `--agent` → manifest `defaultAgents` → detected folders → `agent`. */
export async function resolveAgents(opts: ResolveAgentsOptions): Promise<ResolvedAgents> {
  if (opts.flag && opts.flag.length > 0) return { agents: [...opts.flag], source: "flag" };
  if (opts.defaults && opts.defaults.length > 0) return { agents: [...opts.defaults], source: "manifest" };

  const detected = await detectAgents(opts.cwd);
  if (detected.length === 0) return { agents: [FALLBACK_AGENT], source: "fallback" };
  if (detected.length === 1) return { agents: detected, source: "detected" };

  const interactive = opts.interactive ?? ui.isInteractive();
  if (!interactive) {
    ui.warn(
      `Found several agent folders (${detected.map(agentDir).join(", ")}); ` +
        `installing for all of them. Use --agent to choose.`,
    );
    return { agents: detected, source: "detected" };
  }

  const prompt = opts.prompt ?? defaultPrompt;
  const chosen = await prompt(detected);
  if (chosen === null) throw new CraftError("Cancelled.");
  if (chosen.length === 0) throw new CraftError("No agent selected.", "Use --agent to choose explicitly.");
  return { agents: chosen, source: "detected" };
}

function defaultPrompt(detected: AgentId[]): Promise<AgentId[] | null> {
  return ui.multiselect<AgentId>({
    message: "Install the skill for which agents?",
    options: detected.map((id) => ({ value: id, label: `${id} (${agentDir(id)}/skills)` })),
    initialValues: detected,
    fallback: detected,
  });
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Validates a manifest target before any write or delete and returns its absolute path.
 * The target must match `.<agent>/skills/<name>`, resolve inside `cwd`, and its agent
 * folders must not be symlinks pointing outside `cwd`.
 */
export async function assertSafeTarget(cwd: string, target: string): Promise<string> {
  const unsafe = (why: string): CraftError =>
    new CraftError(
      `Refusing to touch unsafe target "${target}": ${why}.`,
      `Targets must look like ${agentTarget("claude", "<name>")} and stay inside the project.`,
    );

  if (typeof target !== "string" || targetSkillName(target) === undefined) {
    throw unsafe("not an allowed skill path");
  }
  const root = path.resolve(cwd);
  const abs = path.resolve(root, ...target.split("/"));
  if (!isInside(root, abs)) throw unsafe("resolves outside the project");

  // `.claude` and `.claude/skills` may exist already; make sure neither escapes via a symlink.
  const realRoot = await realpath(root);
  const skillsDir = path.dirname(abs);
  for (const dir of [path.dirname(skillsDir), skillsDir]) {
    try {
      await lstat(dir);
    } catch {
      continue; // does not exist yet: it will be created inside root
    }
    if (!isInside(realRoot, await realpath(dir))) throw unsafe("its folder links outside the project");
  }
  return abs;
}
