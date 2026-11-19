import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchSkill,
  formatSource,
  getToken,
  MAX_FILES,
  parseManifestSource,
  parseSource,
} from "../src/core/github.js";
import { CraftError } from "../src/types.js";
import { mockGitHub, RATE_LIMIT_RESET, sampleRepo, SHA_A, SHA_B, type MockHandle } from "./helpers/github-mock.js";

describe("parseSource", () => {
  const cases: [string, object][] = [
    ["owner/repo", { owner: "owner", repo: "repo", path: "." }],
    ["owner/repo.git", { owner: "owner", repo: "repo", path: "." }],
    ["owner/repo/skills/pdf", { owner: "owner", repo: "repo", path: "skills/pdf" }],
    ["owner/repo/skills/pdf/", { owner: "owner", repo: "repo", path: "skills/pdf" }],
    ["owner/repo/skills/pdf@v1", { owner: "owner", repo: "repo", path: "skills/pdf", ref: "v1" }],
    ["owner/repo@feature/x", { owner: "owner", repo: "repo", path: ".", ref: "feature/x" }],
    ["github:owner/repo", { owner: "owner", repo: "repo", path: "." }],
    ["github:owner/repo/skills/pdf@main", { owner: "owner", repo: "repo", path: "skills/pdf", ref: "main" }],
    ["owner/repo/skills/pdf/SKILL.md", { owner: "owner", repo: "repo", path: "skills/pdf" }],
    ["owner/repo/CRAFT.md", { owner: "owner", repo: "repo", path: "." }],
    ["https://github.com/owner/repo", { owner: "owner", repo: "repo", path: "." }],
    ["https://github.com/owner/repo.git", { owner: "owner", repo: "repo", path: "." }],
    ["github.com/owner/repo", { owner: "owner", repo: "repo", path: "." }],
    ["https://github.com/owner/repo/tree/main", { owner: "owner", repo: "repo", path: ".", ref: "main" }],
    [
      "https://github.com/owner/repo/tree/dev/skills/pdf",
      { owner: "owner", repo: "repo", path: "skills/pdf", ref: "dev" },
    ],
    [
      "https://github.com/owner/repo/blob/v2/skills/pdf/SKILL.md",
      { owner: "owner", repo: "repo", path: "skills/pdf", ref: "v2" },
    ],
    [
      "https://github.com/owner/repo/tree/main/packages/%40scope/skill?tab=x#y",
      { owner: "owner", repo: "repo", path: "packages/@scope/skill", ref: "main" },
    ],
  ];
  for (const [input, expected] of cases) {
    test(input, () => assert.deepEqual(parseSource(input), expected));
  }

  test("--ref overrides any ref in the source", () => {
    assert.equal(parseSource("owner/repo@v1", "main").ref, "main");
    assert.equal(parseSource("https://github.com/o/r/tree/dev/x", "release/1.0").ref, "release/1.0");
  });

  test("slashed branch in a URL: first segment is the ref unless --ref says otherwise", () => {
    const url = "https://github.com/o/r/tree/feature/x/skills/pdf";
    assert.deepEqual(parseSource(url), { owner: "o", repo: "r", path: "x/skills/pdf", ref: "feature" });
    assert.deepEqual(parseSource(url, "feature/x"), { owner: "o", repo: "r", path: "skills/pdf", ref: "feature/x" });
  });

  for (const bad of [
    "",
    "owner",
    "owner/repo/../etc",
    "https://github.com/owner/repo/tree/main/../../x",
    "owner/repo@",
    "owner/repo@bad ref",
    "https://github.com/owner/repo/issues/1",
    "https://github.com/owner/repo/tree",
    "-owner/repo",
    "owner/..",
    "owner\\repo",
  ]) {
    test(`rejects ${JSON.stringify(bad)}`, () => assert.throws(() => parseSource(bad), CraftError));
  }

  test("formatSource / parseManifestSource round-trip", () => {
    assert.equal(formatSource({ owner: "o", repo: "r" }), "github:o/r");
    assert.deepEqual(parseManifestSource("github:o/r"), { owner: "o", repo: "r" });
    assert.throws(() => parseManifestSource("o/r"), CraftError);
  });
});

describe("getToken", () => {
  test("GITHUB_TOKEN, then GH_TOKEN", () => {
    assert.equal(getToken({ GITHUB_TOKEN: "a", GH_TOKEN: "b" }), "a");
    assert.equal(getToken({ GH_TOKEN: "b" }), "b");
    assert.equal(getToken({ GITHUB_TOKEN: " ", GH_TOKEN: "" }), undefined);
  });
});

describe("fetchSkill", () => {
  let gh: MockHandle | undefined;
  const savedEnv = { GITHUB_TOKEN: process.env["GITHUB_TOKEN"], GH_TOKEN: process.env["GH_TOKEN"] };
  const setToken = (value: string | undefined): void => {
    delete process.env["GH_TOKEN"];
    if (value === undefined) delete process.env["GITHUB_TOKEN"];
    else process.env["GITHUB_TOKEN"] = value;
  };
  afterEach(() => {
    gh?.restore();
    gh = undefined;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const repos = () => ({ "owner/repo": sampleRepo() });

  test("resolves the default branch, filters to the path, skips symlinks/submodules", async () => {
    setToken(undefined);
    gh = mockGitHub({ repos: repos() });
    const skill = await fetchSkill(parseSource("owner/repo/skills/pdf"));
    assert.equal(skill.ref, "main");
    assert.equal(skill.commit, SHA_A);
    assert.deepEqual(
      skill.files.map((f) => f.path),
      ["SKILL.md", "scripts/extract.py"],
    );
    const urls = gh.requests.map((r) => r.url);
    assert.equal(urls[0], "https://api.github.com/repos/owner/repo");
    assert.equal(urls[1], "https://api.github.com/repos/owner/repo/commits/main");
    assert.ok(urls.some((u) => u.startsWith(`https://raw.githubusercontent.com/owner/repo/${SHA_A}/skills/pdf/`)));
  });

  test("sends the required headers and the bearer token", async () => {
    setToken("tok123");
    gh = mockGitHub({ repos: repos() });
    await fetchSkill(parseSource("owner/repo/skills/pdf@main"));
    for (const { headers } of gh.requests) {
      assert.equal(headers["X-GitHub-Api-Version"], "2022-11-28");
      assert.ok(headers["User-Agent"]);
      assert.equal(headers["Authorization"], "Bearer tok123");
    }
    const commitReq = gh.requests.find((r) => r.url.includes("/commits/"));
    assert.equal(commitReq?.headers["Accept"], "application/vnd.github.sha");
  });

  test("a locked commit skips ref resolution", async () => {
    gh = mockGitHub({ repos: repos() });
    const skill = await fetchSkill(parseSource("owner/repo/skills/pdf@main"), { commit: SHA_B });
    assert.equal(skill.commit, SHA_B);
    assert.ok(!gh.requests.some((r) => r.url.includes("/commits/")));
    const script = skill.files.find((f) => f.path === "scripts/extract.py");
    assert.equal(new TextDecoder().decode(script?.content), "print('v2')\n");
  });

  test("truncated tree falls back to the contents API", async () => {
    gh = mockGitHub({ repos: repos(), truncatedTrees: true });
    const skill = await fetchSkill(parseSource("owner/repo/skills/pdf"));
    assert.deepEqual(
      skill.files.map((f) => f.path),
      ["SKILL.md", "scripts/extract.py"],
    );
    assert.ok(gh.requests.some((r) => r.url.includes("/contents/skills/pdf/scripts?ref=")));
  });

  test("whole-repo skill (path .)", async () => {
    gh = mockGitHub({ repos: { "o/r": { refs: { main: SHA_A }, commits: { [SHA_A]: { "SKILL.md": "x" } } } } });
    const skill = await fetchSkill(parseSource("o/r"));
    assert.deepEqual(
      skill.files.map((f) => f.path),
      ["SKILL.md"],
    );
  });

  const expectError = async (p: Promise<unknown>, message: RegExp, hint?: RegExp): Promise<void> => {
    await assert.rejects(p, (err: unknown) => {
      assert.ok(err instanceof CraftError, String(err));
      assert.match(err.message, message);
      if (hint) assert.match(err.hint ?? "", hint);
      return true;
    });
  };

  test("404 repo → not found + private/token hint", async () => {
    setToken(undefined);
    gh = mockGitHub({ repos: {} });
    await expectError(fetchSkill(parseSource("owner/missing")), /Not found: owner\/missing/, /private.*GITHUB_TOKEN/i);
  });

  test("missing path → not found", async () => {
    gh = mockGitHub({ repos: repos() });
    await expectError(fetchSkill(parseSource("owner/repo/skills/nope")), /Not found/);
  });

  test("path pointing to a non-skill file → clear error", async () => {
    gh = mockGitHub({ repos: repos() });
    await expectError(fetchSkill(parseSource("owner/repo/README.md")), /is a file/);
  });

  test("422 → bad ref", async () => {
    gh = mockGitHub({ repos: repos() });
    await expectError(fetchSkill(parseSource("owner/repo@nope")), /Invalid ref "nope"/, /branch, tag or commit/);
  });

  test("403 rate limit → reset time + token hint", async () => {
    setToken(undefined);
    gh = mockGitHub({ repos: repos(), rateLimited: true });
    await expectError(
      fetchSkill(parseSource("owner/repo")),
      new RegExp(`rate limit.*${new Date(RATE_LIMIT_RESET * 1000).toISOString().replace(/\./g, "\\.")}`),
      /GITHUB_TOKEN/,
    );
  });

  test("429 → rate limit", async () => {
    gh = mockGitHub({ repos: repos(), forceStatus: 429 });
    await expectError(fetchSkill(parseSource("owner/repo")), /rate limit/);
  });

  test("401 → bad token", async () => {
    setToken("bad");
    gh = mockGitHub({ repos: repos(), forceStatus: 401 });
    await expectError(fetchSkill(parseSource("owner/repo")), /rejected the token/, /GITHUB_TOKEN/);
  });

  test("network failure → readable message", async () => {
    gh = mockGitHub({ repos: repos(), offline: true });
    await expectError(fetchSkill(parseSource("owner/repo")), /Network error.*ENOTFOUND/, /internet connection/);
  });

  test(`more than ${MAX_FILES} files → error`, async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= MAX_FILES; i++) files[`s/f${i}.txt`] = "x";
    gh = mockGitHub({ repos: { "o/r": { refs: { main: SHA_A }, commits: { [SHA_A]: files } } } });
    await expectError(fetchSkill(parseSource("o/r/s")), /more than 500 files/);
  });
});
