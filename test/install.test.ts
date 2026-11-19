import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { addCommand } from "../src/commands/add.js";
import { installCommand } from "../src/commands/install.js";
import { MANIFEST_FILE, readManifest } from "../src/core/lockfile.js";
import { CraftError } from "../src/types.js";
import { captureOutput, tempProject, type CapturedOutput } from "./helpers/fs.js";
import { mockGitHub, sampleRepo, SHA_A, SHA_B, type MockHandle } from "./helpers/github-mock.js";

const SCRIPT = ".claude/skills/pdf-tools/scripts/extract.py";

describe("install", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let gh: MockHandle;
  let output: CapturedOutput;
  const ctx = () => ({ cwd: dir });
  const read = (p: string) => readFile(path.join(dir, p), "utf8");

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

  test("missing manifest → error with hint", async () => {
    await assert.rejects(
      installCommand({}, ctx()),
      (err: unknown) => err instanceof CraftError && /No craft-skills.json/.test(err.message) && /add/.test(err.hint ?? ""),
    );
  });

  test("empty manifest → nothing to do", async () => {
    await writeFile(path.join(dir, MANIFEST_FILE), "{}");
    const r = await installCommand({}, ctx());
    assert.deepEqual(r.installed, []);
  });

  test("restores deleted folders at the locked commit, even after the branch moved", async () => {
    await addCommand("owner/repo/skills/pdf", { agent: ["claude"] }, ctx());
    const before = await readFile(path.join(dir, MANIFEST_FILE), "utf8");
    gh.options.repos["owner/repo"]!.refs["main"] = SHA_B; // upstream moved on
    await rm(path.join(dir, ".claude"), { recursive: true });

    gh.requests.length = 0;
    const r = await installCommand({}, ctx());
    assert.deepEqual(r.installed, ["pdf-tools"]);
    assert.deepEqual(r.updated, []);
    assert.equal(await read(SCRIPT), "print('v1')\n");
    assert.ok(!gh.requests.some((q) => q.url.includes("/commits/")), "locked install does not resolve refs");
    assert.equal(await readFile(path.join(dir, MANIFEST_FILE), "utf8"), before, "manifest untouched");
  });

  test("--update re-resolves the ref and records the new commit", async () => {
    await addCommand("owner/repo/skills/pdf", { agent: ["claude"] }, ctx());
    gh.options.repos["owner/repo"]!.refs["main"] = SHA_B;

    const r = await installCommand({ update: true }, ctx());
    assert.deepEqual(r.updated, ["pdf-tools"]);
    assert.equal(await read(SCRIPT), "print('v2')\n");
    assert.equal((await readManifest(dir))?.skills["pdf-tools"]?.commit, SHA_B);
  });

  test("empty targets fall back to defaultAgents", async () => {
    await writeFile(
      path.join(dir, MANIFEST_FILE),
      JSON.stringify({
        defaultAgents: ["cursor"],
        skills: {
          pdf: {
            source: "github:owner/repo",
            path: "skills/pdf",
            ref: "main",
            commit: SHA_A,
            targets: [],
            installedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    await installCommand({}, ctx());
    assert.equal(await read(".cursor/skills/pdf/SKILL.md"), sampleRepo().commits[SHA_A]!["skills/pdf/SKILL.md"]);
    assert.deepEqual((await readManifest(dir))?.skills["pdf"]?.targets, [".cursor/skills/pdf"]);
  });

  test("continues past failures, summarizes them and fails at the end", async () => {
    await addCommand("owner/repo/skills/pdf", { agent: ["claude"] }, ctx());
    await addCommand("owner/repo/skills/other", { agent: ["claude"] }, ctx());
    // Break "other": point it at a path that no longer exists upstream.
    const manifest = JSON.parse(await readFile(path.join(dir, MANIFEST_FILE), "utf8"));
    manifest.skills.other.path = "skills/gone";
    await writeFile(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest));
    await rm(path.join(dir, ".claude"), { recursive: true });

    await assert.rejects(
      installCommand({}, ctx()),
      (err: unknown) => err instanceof CraftError && /1 of 2 skill\(s\) failed.*other/.test(err.message),
    );
    assert.equal(await read(SCRIPT), "print('v1')\n", "the healthy skill was still installed");
    assert.match(output.err.join(""), /error: other: Not found/);
  });
});
