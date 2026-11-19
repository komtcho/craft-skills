import { CraftError, type ParsedSource, type SkillFile } from "../types.js";

export const API_BASE = "https://api.github.com";
export const RAW_BASE = "https://raw.githubusercontent.com";
export const MAX_FILES = 500;
export const DOWNLOAD_CONCURRENCY = 8;

const USER_AGENT = "craft-skills-cli";
const API_VERSION = "2022-11-28";
const JSON_ACCEPT = "application/vnd.github+json";
const SHA_ACCEPT = "application/vnd.github.sha";

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]+$/;
const REF_RE = /^[^\s~^:?*[\\]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const SKILL_FILE_RE = /^(?:SKILL|CRAFT)\.md$/i;
const GITHUB_URL_RE = /^(?:https?:\/\/)?(?:www\.)?github\.com\//i;

// ---------------------------------------------------------------------------
// Source parsing
// ---------------------------------------------------------------------------

function badSource(input: string, why: string): CraftError {
  return new CraftError(
    `Invalid source "${input}": ${why}.`,
    "Use owner/repo[/path][@ref], github:owner/repo[/path][@ref] or a https://github.com/... URL.",
  );
}

function checkRef(input: string, ref: string): string {
  const trimmed = ref.trim();
  if (trimmed === "" || !REF_RE.test(trimmed) || trimmed.includes("..")) {
    throw badSource(input, `"${ref}" is not a valid ref`);
  }
  return trimmed;
}

/**
 * Parses every supported source form:
 * `owner/repo`, `owner/repo/path`, `owner/repo/path@ref`, `github:owner/repo[/path][@ref]`,
 * `https://github.com/owner/repo`, `.../tree/<ref>/<path>`, `.../blob/<ref>/<path>`.
 *
 * In shorthand forms the first `@` starts the ref (so a ref may contain `/`).
 * In URLs, the single segment after `tree/` or `blob/` is the ref: branch names
 * containing `/` are ambiguous there — pass `--ref` instead.
 * `refOverride` (`--ref`) always wins.
 */
export function parseSource(input: string, refOverride?: string): ParsedSource {
  const raw = input.trim();
  if (raw === "") throw badSource(input, "it is empty");

  let segments: string[];
  let ref: string | undefined;

  if (GITHUB_URL_RE.test(raw)) {
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      segments = url.pathname.split("/").filter((s) => s !== "").map(decodeURIComponent);
    } catch {
      throw badSource(input, "it is not a valid URL");
    }
    if (segments.length > 2) {
      const kind = segments[2];
      if (kind !== "tree" && kind !== "blob") {
        throw badSource(input, `unsupported GitHub URL ("/${kind}/" pages are not skill folders)`);
      }
      const urlRef = segments[3];
      if (urlRef === undefined) throw badSource(input, `missing ref after "/${kind}/"`);
      ref = checkRef(input, urlRef);
      segments = [segments[0]!, segments[1]!, ...segments.slice(4)];
    }
  } else {
    let rest = raw.replace(/^github:/i, "");
    const at = rest.indexOf("@");
    if (at !== -1) {
      ref = checkRef(input, rest.slice(at + 1));
      rest = rest.slice(0, at);
    }
    if (rest.includes("\\")) throw badSource(input, "backslashes are not allowed");
    segments = rest.split("/").filter((s) => s !== "");
  }

  const [owner, rawRepo, ...pathSegments] = segments;
  if (owner === undefined || rawRepo === undefined) throw badSource(input, "expected owner/repo");
  const repo = rawRepo.replace(/\.git$/i, "");
  if (!OWNER_RE.test(owner)) throw badSource(input, `"${owner}" is not a valid owner`);
  if (!REPO_RE.test(repo) || repo === "." || repo === "..") {
    throw badSource(input, `"${rawRepo}" is not a valid repository name`);
  }

  if (pathSegments.some((s) => s === "..")) throw badSource(input, `".." is not allowed in paths`);
  if (pathSegments.some((s) => s.includes("\\"))) throw badSource(input, "backslashes are not allowed");
  const cleanPath = pathSegments.filter((s) => s !== ".");
  const last = cleanPath[cleanPath.length - 1];
  if (last !== undefined && SKILL_FILE_RE.test(last)) cleanPath.pop();
  const skillPath = cleanPath.length === 0 ? "." : cleanPath.join("/");

  if (refOverride !== undefined) ref = checkRef(refOverride, refOverride);

  return ref === undefined ? { owner, repo, path: skillPath } : { owner, repo, path: skillPath, ref };
}

/** The `source` value stored in the manifest. */
export function formatSource(source: Pick<ParsedSource, "owner" | "repo">): string {
  return `github:${source.owner}/${source.repo}`;
}

/** Parses a manifest `source` (`github:owner/repo`). */
export function parseManifestSource(source: string): { owner: string; repo: string } {
  const match = /^github:([^/]+)\/([^/]+)$/.exec(source);
  if (!match) throw new CraftError(`Unsupported source "${source}" in manifest.`, `Expected "github:owner/repo".`);
  return { owner: match[1]!, repo: match[2]! };
}

/** Human label: `owner/repo/path@ref`. */
export function describeSource(s: {
  owner: string;
  repo: string;
  path?: string | undefined;
  ref?: string | undefined;
}): string {
  const p = s.path && s.path !== "." ? `/${s.path}` : "";
  return `${s.owner}/${s.repo}${p}${s.ref ? `@${s.ref}` : ""}`;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export function getToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = env["GITHUB_TOKEN"]?.trim() || env["GH_TOKEN"]?.trim();
  return token || undefined;
}

interface RequestContext {
  owner: string;
  repo: string;
  ref?: string | undefined;
  path?: string | undefined;
}

const encodePath = (p: string): string => p.split("/").map(encodeURIComponent).join("/");

function describeNetworkError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    return `${err.message} (${code ?? cause.message})`;
  }
  return err.message;
}

function formatReset(header: string | null): string | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

async function httpError(res: Response, ctx: RequestContext, hasToken: boolean): Promise<CraftError> {
  const label = describeSource(ctx);
  const tokenHint = "Set GITHUB_TOKEN (or GH_TOKEN) to a GitHub token.";

  switch (res.status) {
    case 401:
      return new CraftError(
        "GitHub rejected the token (401 Unauthorized).",
        "Check that GITHUB_TOKEN / GH_TOKEN is valid and not expired, or unset it to use anonymous access.",
      );
    case 403:
    case 429: {
      const body = await res.text().catch(() => "");
      const limited =
        res.status === 429 || res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(body);
      if (limited) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const reset =
          formatReset(res.headers.get("x-ratelimit-reset")) ??
          (retryAfter > 0 ? new Date(Date.now() + retryAfter * 1000).toISOString() : undefined);
        return new CraftError(
          `GitHub API rate limit exceeded${reset ? ` (resets at ${reset})` : ""}.`,
          hasToken
            ? "Wait for the limit to reset and try again."
            : `${tokenHint} Authenticated requests get 5,000 requests per hour instead of 60.`,
        );
      }
      return new CraftError(
        `Access to ${label} is forbidden (403).`,
        hasToken ? "Check that your token has read access to this repository." : tokenHint,
      );
    }
    case 404:
      return new CraftError(
        `Not found: ${label}.`,
        hasToken
          ? "Check the owner, repo, path and ref. If the repository is private, make sure your token can read it."
          : `Check the owner, repo, path and ref. If the repository is private, ${tokenHint.toLowerCase()}`,
      );
    case 422:
      return new CraftError(
        ctx.ref ? `Invalid ref "${ctx.ref}" for ${ctx.owner}/${ctx.repo}.` : `GitHub rejected the request for ${label}.`,
        "Check that the branch, tag or commit exists.",
      );
    default:
      return new CraftError(`GitHub request failed (${res.status} ${res.statusText}) for ${label}.`);
  }
}

async function request(url: string, accept: string, ctx: RequestContext): Promise<Response> {
  const token = getToken();
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": API_VERSION,
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await globalThis.fetch(url, { headers });
  } catch (err) {
    throw new CraftError(
      `Network error while contacting GitHub: ${describeNetworkError(err)}.`,
      "Check your internet connection or proxy settings and try again.",
    );
  }
  if (!res.ok) throw await httpError(res, ctx, token !== undefined);
  return res;
}

async function requestJson(url: string, ctx: RequestContext): Promise<unknown> {
  const res = await request(url, JSON_ACCEPT, ctx);
  try {
    return await res.json();
  } catch {
    throw new CraftError(`Unexpected (non-JSON) response from GitHub for ${describeSource(ctx)}.`);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

// ---------------------------------------------------------------------------
// API flow
// ---------------------------------------------------------------------------

export async function getDefaultBranch(owner: string, repo: string): Promise<string> {
  const body = await requestJson(`${API_BASE}/repos/${owner}/${repo}`, { owner, repo });
  const branch = isObject(body) ? body["default_branch"] : undefined;
  if (typeof branch !== "string" || branch === "") {
    throw new CraftError(`GitHub did not report a default branch for ${owner}/${repo}.`, "Pass --ref <branch>.");
  }
  return branch;
}

export async function resolveCommit(owner: string, repo: string, ref: string): Promise<string> {
  const res = await request(`${API_BASE}/repos/${owner}/${repo}/commits/${encodePath(ref)}`, SHA_ACCEPT, {
    owner,
    repo,
    ref,
  });
  const sha = (await res.text()).trim();
  if (!SHA_RE.test(sha)) throw new CraftError(`GitHub returned an unexpected commit for ${owner}/${repo}@${ref}.`);
  return sha;
}

/** Resolves the ref (default branch if absent) and its commit sha. */
export async function resolveRef(source: ParsedSource): Promise<{ ref: string; commit: string }> {
  const ref = source.ref ?? (await getDefaultBranch(source.owner, source.repo));
  return { ref, commit: await resolveCommit(source.owner, source.repo, ref) };
}

function notADirectory(skillPath: string): CraftError {
  return new CraftError(`"${skillPath}" is a file, not a skill folder.`, "Point to the folder that contains SKILL.md.");
}

function tooMany(count: number): CraftError {
  return new CraftError(
    `The skill has more than ${MAX_FILES} files${count > MAX_FILES ? ` (${count})` : ""}.`,
    "Point to a smaller folder inside the repository.",
  );
}

async function listViaContents(owner: string, repo: string, commit: string, skillPath: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const suffix = dir === "." ? "" : `/${encodePath(dir)}`;
    const body = await requestJson(`${API_BASE}/repos/${owner}/${repo}/contents${suffix}?ref=${commit}`, {
      owner,
      repo,
      ref: commit,
      path: dir,
    });
    if (!Array.isArray(body)) throw notADirectory(dir);
    for (const item of body) {
      if (!isObject(item) || typeof item["path"] !== "string") continue;
      if (item["type"] === "dir") await walk(item["path"]);
      else if (item["type"] === "file" && item["download_url"] !== null) {
        files.push(item["path"]);
        if (files.length > MAX_FILES) throw tooMany(files.length);
      }
      // symlink / submodule entries are skipped
    }
  };
  await walk(skillPath);
  return files;
}

/** Lists repo paths of the regular files under `skillPath` at `commit`. */
export async function listSkillFiles(
  owner: string,
  repo: string,
  commit: string,
  skillPath: string,
): Promise<string[]> {
  const ctx = { owner, repo, ref: commit.slice(0, 7), path: skillPath };
  const body = await requestJson(`${API_BASE}/repos/${owner}/${repo}/git/trees/${commit}?recursive=1`, ctx);
  if (!isObject(body) || !Array.isArray(body["tree"])) {
    throw new CraftError(`Unexpected tree response from GitHub for ${describeSource(ctx)}.`);
  }

  let files: string[];
  if (body["truncated"] === true) {
    files = await listViaContents(owner, repo, commit, skillPath);
  } else {
    const prefix = skillPath === "." ? "" : `${skillPath}/`;
    let found = skillPath === ".";
    files = [];
    for (const entry of body["tree"]) {
      if (!isObject(entry) || typeof entry["path"] !== "string") continue;
      const p = entry["path"];
      if (p === skillPath) {
        if (entry["type"] === "blob") throw notADirectory(skillPath);
        found = true;
        continue;
      }
      if (!p.startsWith(prefix)) continue;
      found = true;
      // Skip trees, submodules (type "commit") and symlinks (mode 120000).
      if (entry["type"] !== "blob" || entry["mode"] === "120000") continue;
      files.push(p);
    }
    if (!found) throw new CraftError(`Not found: ${describeSource(ctx)}.`, "Check the path inside the repository.");
  }

  if (files.length > MAX_FILES) throw tooMany(files.length);
  if (files.length === 0) {
    throw new CraftError(`No files found in ${describeSource(ctx)}.`, "Check the path inside the repository.");
  }
  return files.sort();
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Downloads files from raw.githubusercontent.com; returned paths are relative to `skillPath`. */
export async function downloadFiles(
  owner: string,
  repo: string,
  commit: string,
  skillPath: string,
  repoPaths: readonly string[],
): Promise<SkillFile[]> {
  const prefix = skillPath === "." ? "" : `${skillPath}/`;
  return mapLimit(repoPaths, DOWNLOAD_CONCURRENCY, async (p) => {
    const res = await request(`${RAW_BASE}/${owner}/${repo}/${commit}/${encodePath(p)}`, "*/*", {
      owner,
      repo,
      ref: commit.slice(0, 7),
      path: p,
    });
    return { path: p.slice(prefix.length), content: new Uint8Array(await res.arrayBuffer()) };
  });
}

export interface FetchedSkill {
  owner: string;
  repo: string;
  path: string;
  ref: string;
  commit: string;
  files: SkillFile[];
}

/**
 * Fetches a skill. With `commit` (a locked install) the ref is not re-resolved.
 */
export async function fetchSkill(source: ParsedSource, opts: { commit?: string } = {}): Promise<FetchedSkill> {
  const { ref, commit } =
    opts.commit !== undefined && source.ref !== undefined
      ? { ref: source.ref, commit: opts.commit }
      : await resolveRef(source);
  const repoPaths = await listSkillFiles(source.owner, source.repo, commit, source.path);
  const files = await downloadFiles(source.owner, source.repo, commit, source.path, repoPaths);
  return { owner: source.owner, repo: source.repo, path: source.path, ref, commit, files };
}
