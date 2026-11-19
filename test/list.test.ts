import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { addCommand } from "../src/commands/add.js";
import { listCommand } from "../src/commands/list.js";
import { captureOutput, tempProject, type CapturedOutput } from "./helpers/fs.js";
import { mockGitHub, sampleRepo, SHA_A, type MockHandle } from "./helpers/github-mock.js";

describe("list", () => {
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

  test("shows name, source/path, ref @ shortsha, targets, installedAt", async () => {
    await addCommand("owner/repo/skills/pdf", { agent: ["claude"] }, { cwd: dir });
    output.out.length = 0;
    await listCommand({}, { cwd: dir });
    const text = output.out.join("");
    assert.match(text, /^pdf-tools$/m);
    assert.match(text, /source\s+owner\/repo\/skills\/pdf/);
    assert.match(text, new RegExp(`ref\\s+main @ ${SHA_A.slice(0, 7)}`));
    assert.match(text, /targets\s+\.claude\/skills\/pdf-tools/);
    assert.match(text, /installed\s+\d{4}-\d{2}-\d{2}T/);
  });

  test("--json prints the entries", async () => {
    await addCommand("owner/repo/skills/pdf", {}, { cwd: dir });
    output.out.length = 0;
    await listCommand({ json: true }, { cwd: dir });
    const parsed = JSON.parse(output.out.join(""));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].name, "pdf-tools");
    assert.equal(parsed[0].commit, SHA_A);
  });

  test("is friendly when nothing is installed", async () => {
    await listCommand({}, { cwd: dir });
    assert.match(output.out.join(""), /No skills installed yet/);
    output.out.length = 0;
    await listCommand({ json: true }, { cwd: dir });
    assert.deepEqual(JSON.parse(output.out.join("")), []);
  });
});
