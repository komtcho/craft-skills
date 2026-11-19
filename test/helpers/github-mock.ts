/**
 * In-memory fake of the GitHub REST API + raw.githubusercontent.com, installed by
 * replacing `globalThis.fetch`. No network is ever touched.
 */

export type MockFile = string | { symlink: string } | { submodule: true };

export interface MockRepo {
  defaultBranch?: string;
  /** branch/tag → commit sha */
  refs: Record<string, string>;
  /** commit sha → (repo path → file) */
  commits: Record<string, Record<string, MockFile>>;
}

export interface MockOptions {
  repos: Record<string, MockRepo>;
  /** Report every tree as truncated, forcing the contents API fallback. */
  truncatedTrees?: boolean;
  /** Return a 403 rate-limit response for every request. */
  rateLimited?: boolean;
  /** Throw a network error for every request. */
  offline?: boolean;
  /** Return this status for every request (e.g. 401). */
  forceStatus?: number;
}

export interface MockHandle {
  options: MockOptions;
  requests: { url: string; headers: Record<string, string> }[];
  restore(): void;
}

export const RATE_LIMIT_RESET = 1_900_000_000;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const notFound = (): Response => json({ message: "Not Found" }, 404);

function dirsOf(files: Record<string, MockFile>): Set<string> {
  const dirs = new Set<string>();
  for (const p of Object.keys(files)) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return dirs;
}

function treeEntry(p: string, f: MockFile): Record<string, string> {
  if (typeof f === "string") return { path: p, mode: "100644", type: "blob" };
  if ("symlink" in f) return { path: p, mode: "120000", type: "blob" };
  return { path: p, mode: "160000", type: "commit" };
}

function contentsEntry(p: string, f: MockFile): Record<string, unknown> {
  if (typeof f === "string") return { path: p, type: "file", download_url: `https://raw/${p}` };
  if ("symlink" in f) return { path: p, type: "symlink", download_url: null };
  return { path: p, type: "submodule", download_url: null };
}

function handle(opts: MockOptions, rawUrl: string): Response {
  if (opts.forceStatus) return json({ message: "forced" }, opts.forceStatus);
  if (opts.rateLimited) {
    return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(RATE_LIMIT_RESET) },
    });
  }

  const url = new URL(rawUrl);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (url.host === "raw.githubusercontent.com") {
    const [owner, repo, sha, ...rest] = parts;
    const file = opts.repos[`${owner}/${repo}`]?.commits[sha ?? ""]?.[rest.join("/")];
    return typeof file === "string" ? new Response(file) : new Response("404: Not Found", { status: 404 });
  }
  if (url.host !== "api.github.com" || parts[0] !== "repos") return notFound();

  const [, owner, repoName, kind, ...rest] = parts;
  const repo = opts.repos[`${owner}/${repoName}`];
  if (!repo) return notFound();

  if (kind === undefined) return json({ default_branch: repo.defaultBranch ?? "main" });

  if (kind === "commits") {
    const ref = rest.join("/");
    const sha = repo.refs[ref] ?? (repo.commits[ref] ? ref : undefined);
    return sha ? new Response(sha) : json({ message: `No commit found for SHA: ${ref}` }, 422);
  }

  if (kind === "git" && rest[0] === "trees") {
    const files = repo.commits[rest[1] ?? ""];
    if (!files) return notFound();
    const tree = [
      ...[...dirsOf(files)].map((d) => ({ path: d, mode: "040000", type: "tree" })),
      ...Object.entries(files).map(([p, f]) => treeEntry(p, f)),
    ];
    return json({ sha: rest[1], tree, truncated: opts.truncatedTrees === true });
  }

  if (kind === "contents") {
    const files = repo.commits[url.searchParams.get("ref") ?? ""];
    if (!files) return notFound();
    const dir = rest.join("/");
    const exact = files[dir];
    if (exact !== undefined) return json(contentsEntry(dir, exact));
    const dirs = dirsOf(files);
    if (dir !== "" && !dirs.has(dir)) return notFound();
    const prefix = dir === "" ? "" : `${dir}/`;
    const children = new Map<string, Record<string, unknown>>();
    for (const [p, f] of Object.entries(files)) {
      if (!p.startsWith(prefix)) continue;
      const head = p.slice(prefix.length).split("/")[0]!;
      const childPath = prefix + head;
      if (childPath === p) children.set(childPath, contentsEntry(p, f));
      else children.set(childPath, { path: childPath, type: "dir", download_url: null });
    }
    return json([...children.values()]);
  }

  return notFound();
}

/** Replaces `globalThis.fetch` with the fake. Call `restore()` afterwards. */
export function mockGitHub(options: MockOptions): MockHandle {
  const original = globalThis.fetch;
  const requests: MockHandle["requests"] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, headers: { ...(init?.headers as Record<string, string> | undefined) } });
    if (options.offline) {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) });
    }
    return handle(options, url);
  }) as typeof fetch;
  return {
    options,
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);

/** A small repo with one skill at `skills/pdf` (plus noise), at two commits. */
export function sampleRepo(): MockRepo {
  const v1: Record<string, MockFile> = {
    "README.md": "# repo",
    "skills/pdf/SKILL.md": "---\nname: pdf-tools\ndescription: PDF things\n---\n# PDF\n",
    "skills/pdf/scripts/extract.py": "print('v1')\n",
    "skills/pdf/link": { symlink: "../../README.md" },
    "skills/pdf/vendor": { submodule: true },
    "skills/other/SKILL.md": "---\nname: other\n---\n",
  };
  const v2: Record<string, MockFile> = { ...v1, "skills/pdf/scripts/extract.py": "print('v2')\n" };
  return { defaultBranch: "main", refs: { main: SHA_A, v1: SHA_A }, commits: { [SHA_A]: v1, [SHA_B]: v2 } };
}
