import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { addCommand } from "../src/commands/add.js";
import { readManifest } from "../src/core/lockfile.js";
import { CraftError } from "../src/types.js";
import { captureOutput, tempProject, type CapturedOutput } from "./helpers/fs.js";
import { mockGitHub, sampleRepo, SHA_A, type MockHandle } from "./helpers/github-mock.js";

const exists = async (p: string): Promise<boolean> => stat(p).then(
  () => true,
  () => false,
);

describe("add", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let gh: MockHandle;
  let output: CapturedOutput;

  beforeEach(async () => {
    ({ dir, cleanup } = await tempProject());
    gh = mockGitHub({ repos: { "owner/repo": sampleRepo() } });
    output = captureOutput();
  });
  afterEach(async () => {
    output.restore();
    gh.restore();
    await cleanup();
  });

  test("add installs into the fallback agent and records the manifest", async () => {
    const { name, entry } = await addCommand("owner/repo/skills/pdf", {}, { cwd: dir });
    assert.equal(name, "pdf-tools"); // from SKILL.md frontmatter
    assert.deepEqual(entry.targets, [".agent/skills/pdf-tools"]);
    assert.equal(
      await readFile(path.join(dir, ".agent/skills/pdf-tools/scripts/extract.py"), "utf8"),
      "print('v1')\n",
    );
    assert.ok(!(await exists(path.join(dir, ".agent/skills/pdf-tools/link"))), "symlink skipped");

    const manifest = await readManifest(dir);
    assert.deepEqual(manifest?.defaultAgents, ["agent"]);
    assert.deepEqual(manifest?.skills["pdf-tools"], {
      source: "github:owner/repo",
      path: "skills/pdf",
      ref: "main",
      commit: SHA_A,
      targets: [".agent/skills/pdf-tools"],
      installedAt: entry.installedAt,
    });
  });

  test("add uses the detected agent folder, then reuses defaultAgents", async () => {
    await mkdir(path.join(dir, ".claude"));
    await addCommand("owner/repo/skills/pdf", { skill: "pdf" }, { cwd: dir });
    await mkdir(path.join(dir, ".cursor"));
    const second = await addCommand("owner/repo/skills/other", {}, { cwd: dir });
    assert.deepEqual(second.entry.targets, [".claude/skills/other"]);
    assert.deepEqual((await readManifest(dir))?.defaultAgents, ["claude"]);
  });

  test("add with --agent installs to every agent and validates names", async () => {
    const r = await addCommand("owner/repo/skills/pdf", { agent: ["claude,cursor", "codex"] }, { cwd: dir });
    assert.deepEqual(r.entry.targets, [
      ".claude/skills/pdf-tools",
      ".cursor/skills/pdf-tools",
      ".codex/skills/pdf-tools",
    ]);
    await assert.rejects(addCommand("owner/repo/skills/pdf", { agent: ["vim"] }, { cwd: dir }), /Unknown agent/);
  });

  test("add for copilot writes into .github/skills and leaves .github otherwise alone", async () => {
    await mkdir(path.join(dir, ".github", "workflows"), { recursive: true });
    const { entry } = await addCommand("owner/repo/skills/pdf", { skill: "pdf", agent: ["copilot,gemini"] }, { cwd: dir });
    assert.deepEqual(entry.targets, [".github/skills/pdf", ".gemini/skills/pdf"]);
    assert.ok(await exists(path.join(dir, ".github/skills/pdf/SKILL.md")));
    assert.ok(await exists(path.join(dir, ".gemini/skills/pdf/SKILL.md")));
    assert.deepEqual(await readdir(path.join(dir, ".github")), ["skills", "workflows"]);
    assert.deepEqual((await readManifest(dir))?.defaultAgents, ["copilot", "gemini"]);
  });

  test("invalid --skill is rejected before any network call", async () => {
    await assert.rejects(addCommand("owner/repo", { skill: "../x" }, { cwd: dir }), /Invalid skill name/);
    assert.equal(gh.requests.length, 0);
  });

  test("re-adding is an error without --force", async () => {
    await addCommand("owner/repo/skills/pdf", {}, { cwd: dir });
    await assert.rejects(
      addCommand("owner/repo/skills/pdf", {}, { cwd: dir }),
      (err: unknown) => err instanceof CraftError && /already installed/.test(err.message) && /--force/.test(err.hint ?? ""),
    );
  });

  test("an existing target folder is an error without --force", async () => {
    await mkdir(path.join(dir, ".agent/skills/pdf-tools"), { recursive: true });
    await assert.rejects(addCommand("owner/repo/skills/pdf", {}, { cwd: dir }), /already exists/);
  });

  test("--force reinstalls and removes stale targets", async () => {
    await addCommand("owner/repo/skills/pdf", { agent: ["claude", "cursor"] }, { cwd: dir });
    const r = await addCommand("owner/repo/skills/pdf", { agent: ["codex"], force: true }, { cwd: dir });
    assert.deepEqual(r.entry.targets, [".codex/skills/pdf-tools"]);
    assert.ok(!(await exists(path.join(dir, ".claude/skills/pdf-tools"))));
    assert.ok(!(await exists(path.join(dir, ".cursor/skills/pdf-tools"))));
    assert.deepEqual((await readdir(path.join(dir, ".codex/skills/pdf-tools"))).sort(), ["SKILL.md", "scripts"]);
  });
});
