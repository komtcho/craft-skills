import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { main } from "../src/cli.js";
import { MANIFEST_FILE } from "../src/core/lockfile.js";
import { captureOutput, tempProject, type CapturedOutput } from "./helpers/fs.js";
import { mockGitHub, RATE_LIMIT_RESET, sampleRepo, SHA_A, SHA_B, type MockHandle } from "./helpers/github-mock.js";

const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

describe("e2e (mocked GitHub)", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let gh: MockHandle;
  let output: CapturedOutput;
  const saved = { GITHUB_TOKEN: process.env["GITHUB_TOKEN"], GH_TOKEN: process.env["GH_TOKEN"] };

  const run = (...args: string[]) => main(["node", "craft-skills", ...args], { cwd: dir });
  const read = (p: string) => readFile(path.join(dir, p), "utf8");
  const manifest = async () => JSON.parse(await read(MANIFEST_FILE));
  const err = () => output.err.join("");

  beforeEach(async () => {
    ({ dir, cleanup } = await tempProject());
    gh = mockGitHub({ repos: { "owner/repo": sampleRepo() } });
    output = captureOutput();
    delete process.env["GITHUB_TOKEN"];
    delete process.env["GH_TOKEN"];
  });
  afterEach(async () => {
    output.restore();
    gh.restore();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await cleanup();
  });

  test("add → list → install → install --update → remove", async () => {
    await mkdir(path.join(dir, ".claude"));

    // add: detected .claude, name from SKILL.md frontmatter, ref resolved to the default branch
    assert.equal(await run("add", "https://github.com/owner/repo/tree/main/skills/pdf"), 0);
    assert.equal(await read(".claude/skills/pdf-tools/scripts/extract.py"), "print('v1')\n");
    let m = await manifest();
    assert.deepEqual(m.defaultAgents, ["claude"]);
    assert.equal(m.skills["pdf-tools"].commit, SHA_A);
    assert.ok((await read(MANIFEST_FILE)).endsWith("}\n"));

    // list
    output.out.length = 0;
    assert.equal(await run("list"), 0);
    assert.match(output.out.join(""), new RegExp(`pdf-tools[\\s\\S]*owner/repo/skills/pdf[\\s\\S]*main @ ${SHA_A.slice(0, 7)}`));

    // install (fresh clone: folders gone, upstream moved) → locked commit
    gh.options.repos["owner/repo"]!.refs["main"] = SHA_B;
    await rm(path.join(dir, ".claude"), { recursive: true });
    assert.equal(await run("install"), 0);
    assert.equal(await read(".claude/skills/pdf-tools/scripts/extract.py"), "print('v1')\n");
    assert.equal((await manifest()).skills["pdf-tools"].commit, SHA_A);

    // install --update → new commit recorded
    assert.equal(await run("install", "--update"), 0);
    assert.equal(await read(".claude/skills/pdf-tools/scripts/extract.py"), "print('v2')\n");
    m = await manifest();
    assert.equal(m.skills["pdf-tools"].commit, SHA_B);

    // remove
    assert.equal(await run("remove", "pdf-tools"), 0);
    assert.ok(!(await exists(path.join(dir, ".claude/skills/pdf-tools"))));
    assert.deepEqual((await manifest()).skills, {});
    output.out.length = 0;
    await run("list");
    assert.match(output.out.join(""), /No skills installed yet/);
  });

  test("hostile manifest: install and remove refuse, nothing outside is touched", async () => {
    const victim = path.join(dir, "important");
    await mkdir(victim);
    await writeFile(path.join(victim, "data.txt"), "keep me");
    await writeFile(
      path.join(dir, MANIFEST_FILE),
      JSON.stringify({
        defaultAgents: ["claude"],
        skills: {
          evil: {
            source: "github:owner/repo",
            path: "skills/pdf",
            ref: "main",
            commit: SHA_A,
            targets: ["important", ".claude/skills/../../important"],
            installedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    assert.equal(await run("install"), 1);
    assert.match(err(), /Invalid craft-skills\.json.*unsafe path/);
    assert.equal(await run("remove", "evil"), 1);
    assert.deepEqual(await readdir(victim), ["data.txt"]);
    assert.equal(gh.requests.length, 0, "no network for a rejected manifest");
  });

  test("hostile agent folder symlink: install refuses to write outside the project", async (t) => {
    const outside = await tempProject();
    t.after(outside.cleanup);
    try {
      await symlink(outside.dir, path.join(dir, ".claude"), "junction");
    } catch {
      t.skip("symlinks not permitted here");
      return;
    }
    await writeFile(
      path.join(dir, MANIFEST_FILE),
      JSON.stringify({
        skills: {
          pdf: {
            source: "github:owner/repo",
            path: "skills/pdf",
            ref: "main",
            commit: SHA_A,
            targets: [".claude/skills/pdf"],
            installedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    assert.equal(await run("install"), 1);
    assert.match(err(), /links outside the project/);
    assert.deepEqual(await readdir(outside.dir), []);
  });

  test("404: unknown repo prints not found + private repo hint", async () => {
    assert.equal(await run("add", "owner/nope"), 1);
    assert.match(err(), /error: Not found: owner\/nope/);
    assert.match(err(), /hint: .*private.*GITHUB_TOKEN/i);
    assert.ok(!(await exists(path.join(dir, MANIFEST_FILE))), "no manifest written on failure");
  });

  test("rate limit prints the reset time and a token hint", async () => {
    gh.options.rateLimited = true;
    assert.equal(await run("add", "owner/repo"), 1);
    assert.match(err(), new RegExp(`rate limit exceeded \\(resets at ${new Date(RATE_LIMIT_RESET * 1000).toISOString()}`));
    assert.match(err(), /hint: Set GITHUB_TOKEN/);
  });

  test("missing manifest: install exits 1 with a hint", async () => {
    assert.equal(await run("install"), 1);
    assert.match(err(), /error: No craft-skills\.json found/);
    assert.match(err(), /hint: Run `craft-skills add <source>`/);
  });

  test("install keeps going after a failure and exits 1", async () => {
    assert.equal(await run("add", "owner/repo/skills/pdf", "-a", "claude"), 0);
    assert.equal(await run("add", "owner/repo/skills/other", "-a", "claude"), 0);
    const m = await manifest();
    m.skills.other.commit = "c".repeat(40); // commit that does not exist upstream
    await writeFile(path.join(dir, MANIFEST_FILE), JSON.stringify(m));
    await rm(path.join(dir, ".claude"), { recursive: true });

    assert.equal(await run("install"), 1);
    assert.ok(await exists(path.join(dir, ".claude/skills/pdf-tools/SKILL.md")));
    assert.match(err(), /error: other: Not found/);
    assert.match(err(), /1 of 2 skill\(s\) failed to install: other/);
  });
});

describe("entry point (child process, no network)", () => {
  const entry = fileURLToPath(new URL("../src/index.js", import.meta.url));
  const exec = promisify(execFile);

  test("--version and --help run from the compiled entry", async () => {
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    const version = await exec(process.execPath, [entry, "--version"]);
    assert.equal(version.stdout.trim(), pkg.version);
    const help = await exec(process.execPath, [entry, "--help"]);
    assert.match(help.stdout, /Usage: craft-skills/);
  });

  test("errors set exit code 1 without a stack trace", async () => {
    const { dir, cleanup } = await tempProject();
    try {
      await assert.rejects(exec(process.execPath, [entry, "remove", "x"], { cwd: dir }), (e: any) => {
        assert.equal(e.code, 1);
        assert.match(e.stderr, /error: No craft-skills\.json found/);
        assert.doesNotMatch(e.stderr, /\n\s+at /);
        return true;
      });
    } finally {
      await cleanup();
    }
  });

  test("the entry starts with a shebang", async () => {
    const text = await readFile(entry, "utf8");
    assert.ok(text.startsWith("#!/usr/bin/env node\n"));
  });
});
