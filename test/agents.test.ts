import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AGENTS,
  agentTarget,
  assertSafeTarget,
  detectAgents,
  isValidSkillName,
  parseAgents,
  resolveAgents,
  targetSkillName,
} from "../src/core/agents.js";
import { CraftError } from "../src/types.js";
import { captureOutput, tempProject, type CapturedOutput } from "./helpers/fs.js";

describe("parseAgents", () => {
  test("accepts comma-separated and repeated values, dedupes, keeps order", () => {
    assert.deepEqual(parseAgents(["claude,cursor", "codex", " Claude "]), ["claude", "cursor", "codex"]);
  });

  test("rejects unknown agents with the valid list in the hint", () => {
    assert.throws(
      () => parseAgents(["claude,vim"]),
      (err: unknown) =>
        err instanceof CraftError && /Unknown agent "vim"/.test(err.message) && /windsurf/.test(err.hint ?? ""),
    );
  });

  test("rejects an empty value", () => {
    assert.throws(() => parseAgents([" , "]), CraftError);
  });
});

describe("names and targets", () => {
  test("agentTarget uses the single mapping", () => {
    assert.equal(agentTarget("claude", "pdf"), ".claude/skills/pdf");
    assert.equal(agentTarget("agent", "pdf"), ".agent/skills/pdf");
    assert.equal(Object.keys(AGENTS).length, 11);
  });

  test("new agents map to their documented skills folders", () => {
    assert.equal(agentTarget("agents", "pdf"), ".agents/skills/pdf");
    assert.equal(agentTarget("copilot", "pdf"), ".github/skills/pdf");
    assert.equal(agentTarget("gemini", "pdf"), ".gemini/skills/pdf");
    assert.equal(agentTarget("opencode", "pdf"), ".opencode/skills/pdf");
    assert.equal(agentTarget("roo", "pdf"), ".roo/skills/pdf");
    assert.equal(agentTarget("kiro", "pdf"), ".kiro/skills/pdf");
    assert.deepEqual(parseAgents(["copilot,gemini", "kiro"]), ["copilot", "gemini", "kiro"]);
  });

  test("targetSkillName accepts new agent targets but nothing else under .github", () => {
    assert.equal(targetSkillName(".github/skills/pdf"), "pdf");
    assert.equal(targetSkillName(".agents/skills/pdf"), "pdf");
    for (const bad of [".github/workflows", ".github/workflows/ci.yml", ".github/skills", ".github/pdf"]) {
      assert.equal(targetSkillName(bad), undefined, bad);
    }
  });

  test("isValidSkillName", () => {
    for (const ok of ["pdf", "PDF", "a.b_c-d", "9lives"]) assert.ok(isValidSkillName(ok), ok);
    for (const bad of ["", ".hidden", "-x", "_x", "a/b", "a b", "..", "x".repeat(101)]) {
      assert.ok(!isValidSkillName(bad), bad);
    }
  });

  test("targetSkillName accepts only .<agent>/skills/<name>", () => {
    assert.equal(targetSkillName(".claude/skills/pdf"), "pdf");
    assert.equal(targetSkillName(".windsurf/skills/a.b"), "a.b");
    for (const bad of [
      "/etc",
      "../x",
      ".claude/skills/../../x",
      ".claude/skills/",
      ".claude/skills/pdf/extra",
      ".vim/skills/pdf",
      "claude/skills/pdf",
      ".claude\\skills\\pdf",
      ".claude/skills/..",
    ]) {
      assert.equal(targetSkillName(bad), undefined, bad);
    }
  });
});

describe("filesystem", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let output: CapturedOutput;

  beforeEach(async () => {
    ({ dir, cleanup } = await tempProject());
    output = captureOutput();
  });
  afterEach(async () => {
    output.restore();
    await cleanup();
  });

  test("detectAgents finds existing root folders only", async () => {
    assert.deepEqual(await detectAgents(dir), []);
    await mkdir(path.join(dir, ".cursor"));
    await mkdir(path.join(dir, ".claude"));
    assert.deepEqual(await detectAgents(dir), ["claude", "cursor"]);
  });

  test("detectAgents: a bare .github folder does not mean copilot", async () => {
    await mkdir(path.join(dir, ".github", "workflows"), { recursive: true });
    assert.deepEqual(await detectAgents(dir), []);
  });

  test("detectAgents: copilot is detected by .github/skills or copilot-instructions.md", async () => {
    await mkdir(path.join(dir, ".github"));
    await writeFile(path.join(dir, ".github", "copilot-instructions.md"), "# hi\n");
    assert.deepEqual(await detectAgents(dir), ["copilot"]);
    await rm(path.join(dir, ".github", "copilot-instructions.md"));
    await mkdir(path.join(dir, ".github", "skills"));
    assert.deepEqual(await detectAgents(dir), ["copilot"]);
  });

  test("detectAgents finds the new agent folders", async () => {
    for (const d of [".agents", ".gemini", ".opencode", ".roo", ".kiro"]) await mkdir(path.join(dir, d));
    assert.deepEqual(await detectAgents(dir), ["agents", "gemini", "opencode", "roo", "kiro"]);
  });

  test("assertSafeTarget refuses .github paths outside skills", async () => {
    assert.equal(await assertSafeTarget(dir, ".github/skills/pdf"), path.join(dir, ".github", "skills", "pdf"));
    for (const bad of [".github/workflows", ".github", ".github/skills/../workflows"]) {
      await assert.rejects(assertSafeTarget(dir, bad), CraftError, bad);
    }
  });

  test("resolveAgents: flag wins over manifest defaults", async () => {
    const r = await resolveAgents({ cwd: dir, flag: ["codex"], defaults: ["claude"] });
    assert.deepEqual(r, { agents: ["codex"], source: "flag" });
  });

  test("resolveAgents: manifest defaults win over detection", async () => {
    await mkdir(path.join(dir, ".cursor"));
    const r = await resolveAgents({ cwd: dir, defaults: ["claude"] });
    assert.deepEqual(r, { agents: ["claude"], source: "manifest" });
  });

  test("resolveAgents: none detected falls back to agent", async () => {
    assert.deepEqual(await resolveAgents({ cwd: dir }), { agents: ["agent"], source: "fallback" });
  });

  test("resolveAgents: one detected is used", async () => {
    await mkdir(path.join(dir, ".claude"));
    assert.deepEqual(await resolveAgents({ cwd: dir }), { agents: ["claude"], source: "detected" });
  });

  test("resolveAgents: several detected, non-interactive → all + warning", async () => {
    await mkdir(path.join(dir, ".claude"));
    await mkdir(path.join(dir, ".codex"));
    const r = await resolveAgents({ cwd: dir, interactive: false });
    assert.deepEqual(r.agents, ["claude", "codex"]);
    assert.match(output.err.join(""), /warning: .*--agent/);
  });

  test("resolveAgents: several detected, interactive → prompt with all preselected", async () => {
    await mkdir(path.join(dir, ".claude"));
    await mkdir(path.join(dir, ".codex"));
    let offered: string[] = [];
    const r = await resolveAgents({
      cwd: dir,
      interactive: true,
      prompt: async (detected) => {
        offered = detected;
        return ["codex"];
      },
    });
    assert.deepEqual(offered, ["claude", "codex"]);
    assert.deepEqual(r.agents, ["codex"]);
  });

  test("resolveAgents: cancelled prompt throws", async () => {
    await mkdir(path.join(dir, ".claude"));
    await mkdir(path.join(dir, ".codex"));
    await assert.rejects(
      resolveAgents({ cwd: dir, interactive: true, prompt: async () => null }),
      /Cancelled/,
    );
  });

  test("assertSafeTarget returns the absolute path for good targets", async () => {
    assert.equal(await assertSafeTarget(dir, ".claude/skills/pdf"), path.join(dir, ".claude", "skills", "pdf"));
  });

  test("assertSafeTarget rejects hostile targets", async () => {
    for (const bad of ["../outside", "/etc/passwd", ".claude/skills/../../x", "src", ".claude/skills"]) {
      await assert.rejects(assertSafeTarget(dir, bad), CraftError, bad);
    }
  });

  test("assertSafeTarget rejects agent folders that link outside the project", async (t) => {
    const outside = await tempProject();
    t.after(outside.cleanup);
    try {
      await symlink(outside.dir, path.join(dir, ".claude"), "junction");
    } catch {
      t.skip("symlinks not permitted here");
      return;
    }
    await assert.rejects(assertSafeTarget(dir, ".claude/skills/pdf"), /links outside/);
  });
});
