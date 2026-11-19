import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleError, main, readVersion } from "../src/cli.js";
import { CraftError } from "../src/types.js";
import { captureOutput, tempProject, type CapturedOutput } from "./helpers/fs.js";
import { mockGitHub, sampleRepo, type MockHandle } from "./helpers/github-mock.js";

const run = (cwd: string, ...args: string[]) => main(["node", "craft-skills", ...args], { cwd });

describe("cli", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let gh: MockHandle;
  let output: CapturedOutput;
  const savedDebug = process.env["DEBUG"];

  beforeEach(async () => {
    ({ dir, cleanup } = await tempProject());
    gh = mockGitHub({ repos: { "owner/repo": sampleRepo() } });
    output = captureOutput();
    delete process.env["DEBUG"];
  });
  afterEach(async () => {
    output.restore();
    gh.restore();
    if (savedDebug === undefined) delete process.env["DEBUG"];
    else process.env["DEBUG"] = savedDebug;
    await cleanup();
  });

  test("--version prints the package.json version", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    assert.equal(readVersion(), pkg.version);
    assert.equal(await run(dir, "--version"), 0);
    assert.equal(output.out.join("").trim(), pkg.version);
  });

  test("--help lists every command and exits 0", async () => {
    assert.equal(await run(dir, "--help"), 0);
    const text = output.out.join("");
    for (const cmd of ["add", "list", "install", "remove", "GITHUB_TOKEN"]) assert.match(text, new RegExp(cmd));
  });

  test("add --help documents agents and source formats", async () => {
    assert.equal(await run(dir, "add", "--help"), 0);
    const text = output.out.join("");
    assert.match(text, /windsurf\s+\.windsurf\/skills\/<name>/);
    assert.match(text, /tree\/<ref>\/<path>/);
  });

  test("usage errors exit 1 with a suggestion", async () => {
    assert.equal(await run(dir, "instal"), 1);
    assert.match(output.err.join(""), /Did you mean install/);
    assert.equal(await run(dir, "add"), 1);
    assert.match(output.err.join(""), /missing required argument 'source'/);
  });

  test("CraftError prints message + hint and exits 1", async () => {
    assert.equal(await run(dir, "remove", "pdf"), 1);
    assert.match(output.err.join(""), /^error: No craft-skills\.json found.*\nhint: .+/m);
    assert.doesNotMatch(output.err.join(""), /\n\s+at /, "no stack trace without DEBUG");
  });

  test("every add error path prints a hint", async () => {
    const cases: string[][] = [
      ["add", "owner/../x"],
      ["add", "owner/repo", "--agent", "vim"],
      ["add", "owner/repo", "--skill", "bad name"],
      ["add", "owner/missing"],
      ["add", "owner/repo@nope"],
    ];
    for (const args of cases) {
      output.err.length = 0;
      assert.equal(await run(dir, ...args), 1, args.join(" "));
      assert.match(output.err.join(""), /^error: .+\nhint: .+/m, args.join(" "));
    }
  });

  test("unexpected errors show the message; the stack only with DEBUG=craft", () => {
    assert.equal(handleError(new Error("boom")), 1);
    assert.match(output.err.join(""), /Unexpected error: boom/);
    assert.match(output.err.join(""), /DEBUG=craft/);
    assert.doesNotMatch(output.err.join(""), /\n\s+at /);

    output.err.length = 0;
    process.env["DEBUG"] = "craft";
    handleError(new Error("boom"));
    assert.match(output.err.join(""), /\n\s+at /);

    output.err.length = 0;
    handleError(new CraftError("known", "hint"));
    assert.match(output.err.join(""), /error: known\nhint: hint\n.*CraftError/s);
  });

  test("add then list works end-to-end through the CLI", async () => {
    assert.equal(await run(dir, "add", "owner/repo/skills/pdf", "-a", "claude", "--skill", "pdf"), 0);
    output.out.length = 0;
    assert.equal(await run(dir, "list", "--json"), 0);
    const listed = JSON.parse(output.out.join(""));
    assert.equal(listed[0].name, "pdf");
    assert.deepEqual(listed[0].targets, [".claude/skills/pdf"]);
  });
});
