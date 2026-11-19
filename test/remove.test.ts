import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { addCommand } from "../src/commands/add.js";
import { removeCommand } from "../src/commands/remove.js";
import { MANIFEST_FILE, readManifest } from "../src/core/lockfile.js";
import { CraftError } from "../src/types.js";
import { captureOutput, tempProject, type CapturedOutput } from "./helpers/fs.js";
import { mockGitHub, sampleRepo, SHA_A, type MockHandle } from "./helpers/github-mock.js";

const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

describe("remove", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let gh: MockHandle;
  let output: CapturedOutput;
  const ctx = () => ({ cwd: dir });

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

  test("deletes every target and the manifest entry", async () => {
    await addCommand("owner/repo/skills/pdf", { agent: ["claude,codex"] }, ctx());
    await addCommand("owner/repo/skills/other", { agent: ["claude"] }, ctx());
    await removeCommand("pdf-tools", ctx());
    assert.ok(!(await exists(path.join(dir, ".claude/skills/pdf-tools"))));
    assert.ok(!(await exists(path.join(dir, ".codex/skills/pdf-tools"))));
    assert.ok(await exists(path.join(dir, ".claude/skills/other")));
    assert.deepEqual(Object.keys((await readManifest(dir))?.skills ?? {}), ["other"]);
  });

  test("unknown name → error listing installed skills", async () => {
    await addCommand("owner/repo/skills/other", {}, ctx());
    await assert.rejects(
      removeCommand("nope", ctx()),
      (err: unknown) => err instanceof CraftError && /not installed/.test(err.message) && /other/.test(err.hint ?? ""),
    );
    await assert.rejects(removeCommand("constructor", ctx()), /not installed/);
  });

  test("missing manifest → error", async () => {
    await assert.rejects(removeCommand("x", ctx()), /No craft-skills.json/);
  });

  test("a hostile manifest cannot delete paths outside the skill folders", async () => {
    const victim = path.join(dir, "src");
    await mkdir(victim);
    await writeFile(path.join(victim, "keep.ts"), "important");
    await writeFile(
      path.join(dir, MANIFEST_FILE),
      JSON.stringify({
        skills: {
          evil: {
            source: "github:owner/repo",
            path: ".",
            ref: "main",
            commit: SHA_A,
            targets: ["src", "../../outside"],
            installedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    await assert.rejects(removeCommand("evil", ctx()), /Invalid craft-skills.json.*unsafe path/);
    assert.deepEqual(await readdir(victim), ["keep.ts"]);
  });
});
