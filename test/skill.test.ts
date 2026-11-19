import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  parseFrontmatterName,
  removeSkillDir,
  resolveSkillName,
  slugify,
  writeSkillDir,
} from "../src/core/skill.js";
import { CraftError, type SkillFile } from "../src/types.js";
import { tempProject } from "./helpers/fs.js";

const file = (p: string, text: string): SkillFile => ({ path: p, content: new TextEncoder().encode(text) });

describe("parseFrontmatterName", () => {
  test("reads name, quoted or not, strips comments", () => {
    assert.equal(parseFrontmatterName("---\nname: pdf\n---\n"), "pdf");
    assert.equal(parseFrontmatterName('---\r\ndescription: x\r\nname: "My Skill"\r\n---'), "My Skill");
    assert.equal(parseFrontmatterName("---\nname: 'a # b'\n---"), "a # b");
    assert.equal(parseFrontmatterName("---\nname: pdf # main one\n---"), "pdf");
    assert.equal(parseFrontmatterName("﻿---\nname: bom\n---"), "bom");
  });

  test("ignores missing frontmatter, nested keys and names after the block", () => {
    assert.equal(parseFrontmatterName("# title\nname: nope"), undefined);
    assert.equal(parseFrontmatterName("---\nmeta:\n  name: nested\n---"), undefined);
    assert.equal(parseFrontmatterName("---\ntitle: x\n---\nname: late"), undefined);
    assert.equal(parseFrontmatterName("---\nname:\n---"), undefined);
  });
});

describe("slugify", () => {
  test("produces valid names", () => {
    assert.equal(slugify("PDF Tools!"), "pdf-tools");
    assert.equal(slugify("  --Café  Crème-- "), "cafe-creme");
    assert.equal(slugify("_private.skill_"), "private.skill");
    assert.equal(slugify("!!!"), "");
  });
});

describe("resolveSkillName", () => {
  const base = { path: "skills/pdf", repo: "repo" };

  test("--skill wins and must be valid", () => {
    assert.equal(resolveSkillName({ ...base, flag: "Custom", files: [file("SKILL.md", "---\nname: x\n---")] }), "Custom");
    assert.throws(() => resolveSkillName({ ...base, flag: "bad name", files: [] }), CraftError);
    assert.throws(() => resolveSkillName({ ...base, flag: "../x", files: [] }), CraftError);
  });

  test("SKILL.md name, then CRAFT.md name", () => {
    const skill = file("SKILL.md", "---\nname: From Skill\n---");
    const craft = file("CRAFT.md", "---\nname: from-craft\n---");
    assert.equal(resolveSkillName({ ...base, files: [craft, skill] }), "from-skill");
    assert.equal(resolveSkillName({ ...base, files: [craft, file("SKILL.md", "# no fm")] }), "from-craft");
  });

  test("falls back to the last path segment, then the repo name", () => {
    assert.equal(resolveSkillName({ ...base, files: [] }), "pdf");
    assert.equal(resolveSkillName({ path: ".", repo: "My.Repo", files: [] }), "my.repo");
  });

  test("throws when nothing usable is left", () => {
    assert.throws(() => resolveSkillName({ path: "!!!", repo: "___", files: [] }), /Could not derive/);
  });
});

describe("writeSkillDir / removeSkillDir", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ dir, cleanup } = await tempProject()));
  afterEach(async () => cleanup());

  test("writes nested files and replaces the previous version atomically", async () => {
    const target = ".claude/skills/pdf";
    const abs = path.join(dir, ".claude", "skills", "pdf");
    await mkdir(abs, { recursive: true });
    await writeFile(path.join(abs, "stale.txt"), "old");

    await writeSkillDir(dir, target, [file("SKILL.md", "hi"), file("scripts/a.py", "print(1)")]);

    assert.deepEqual((await readdir(abs)).sort(), ["SKILL.md", "scripts"]);
    assert.equal(await readFile(path.join(abs, "scripts", "a.py"), "utf8"), "print(1)");
    assert.deepEqual(await readdir(path.join(dir, ".claude", "skills")), ["pdf"]); // no temp dir left
  });

  test("refuses unsafe targets and file paths, leaving nothing behind", async () => {
    await assert.rejects(writeSkillDir(dir, "../evil", [file("x", "y")]), CraftError);
    await assert.rejects(writeSkillDir(dir, ".claude/skills/pdf", [file("../../x", "y")]), /unsafe file path/);
    await assert.rejects(writeSkillDir(dir, ".claude/skills/pdf", [file("/abs", "y")]), /unsafe file path/);
    assert.deepEqual(await readdir(path.join(dir, ".claude", "skills")), []);
  });

  test("removeSkillDir deletes only safe targets", async () => {
    await writeSkillDir(dir, ".codex/skills/x", [file("SKILL.md", "")]);
    await removeSkillDir(dir, ".codex/skills/x");
    assert.deepEqual(await readdir(path.join(dir, ".codex", "skills")), []);
    await assert.rejects(removeSkillDir(dir, ".."), CraftError);
    await assert.rejects(removeSkillDir(dir, "src"), CraftError);
  });
});
