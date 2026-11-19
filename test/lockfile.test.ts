import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  emptyManifest,
  getSkill,
  MANIFEST_FILE,
  readManifest,
  serializeManifest,
  validateManifest,
  writeManifest,
} from "../src/core/lockfile.js";
import { CraftError, type Manifest } from "../src/types.js";
import { tempProject } from "./helpers/fs.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function sample(): Manifest {
  return {
    defaultAgents: ["claude"],
    skills: {
      pdf: {
        source: "github:owner/repo",
        path: "skills/pdf",
        ref: "main",
        commit: SHA,
        targets: [".claude/skills/pdf"],
        installedAt: "2026-11-19T14:00:00.000Z",
      },
    },
  };
}

describe("validateManifest", () => {
  test("accepts the documented shape", () => {
    assert.deepEqual(validateManifest(sample()), sample());
  });

  test("defaults missing defaultAgents/skills", () => {
    assert.deepEqual(validateManifest({}), emptyManifest());
  });

  const broken: [string, (m: any) => void, RegExp][] = [
    ["unknown agent", (m) => (m.defaultAgents = ["vim"]), /unknown agent "vim"/],
    ["skills not object", (m) => (m.skills = []), /"skills" must be an object/],
    ["bad skill name", (m) => (m.skills["../x"] = m.skills.pdf), /skill name/],
    ["bad commit", (m) => (m.skills.pdf.commit = "abc"), /40-character/],
    ["bad source", (m) => (m.skills.pdf.source = "gitlab:o/r"), /github:owner\/repo/],
    ["path traversal", (m) => (m.skills.pdf.path = "a/../../b"), /safe repository path/],
    ["bad date", (m) => (m.skills.pdf.installedAt = "yesterday"), /ISO date/],
    ["targets not array", (m) => (m.skills.pdf.targets = ".claude/skills/pdf"), /must be an array/],
    ["hostile target", (m) => (m.skills.pdf.targets = ["../../etc"]), /unsafe path/],
    ["absolute target", (m) => (m.skills.pdf.targets = ["/home/user"]), /unsafe path/],
    ["target for another name", (m) => (m.skills.pdf.targets = [".claude/skills/other"]), /unsafe path/],
    ["missing ref", (m) => delete m.skills.pdf.ref, /"skills.pdf.ref"/],
  ];
  for (const [label, mutate, pattern] of broken) {
    test(`rejects: ${label}`, () => {
      const m = structuredClone(sample());
      mutate(m);
      assert.throws(
        () => validateManifest(m),
        (err: unknown) => err instanceof CraftError && pattern.test(err.message) && err.hint !== undefined,
      );
    });
  }

  test("rejects a non-object top level", () => {
    assert.throws(() => validateManifest([]), /top level/);
  });
});

describe("getSkill", () => {
  test("ignores prototype keys", () => {
    const m = sample();
    assert.equal(getSkill(m, "constructor"), undefined);
    assert.equal(getSkill(m, "pdf")?.ref, "main");
  });
});

describe("read/write", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ dir, cleanup } = await tempProject()));
  afterEach(async () => cleanup());

  test("readManifest returns null when missing", async () => {
    assert.equal(await readManifest(dir), null);
  });

  test("round-trips, sorts keys, 2-space indent, trailing newline, no temp files left", async () => {
    const m = sample();
    m.skills = { zeta: { ...m.skills["pdf"]!, targets: [".claude/skills/zeta"] }, ...m.skills };
    await writeManifest(dir, m);
    const text = await readFile(path.join(dir, MANIFEST_FILE), "utf8");
    assert.ok(text.endsWith("}\n"));
    assert.ok(text.startsWith('{\n  "defaultAgents"'));
    assert.ok(text.indexOf('"pdf"') < text.indexOf('"zeta"'));
    assert.ok(text.indexOf('"commit"') < text.indexOf('"installedAt"'));
    assert.deepEqual(await readManifest(dir), validateManifest(m));
    assert.deepEqual(await readdir(dir), [MANIFEST_FILE]);
  });

  test("serializeManifest is deterministic", () => {
    assert.equal(serializeManifest(sample()), serializeManifest(structuredClone(sample())));
  });

  test("invalid JSON gives a clear error", async () => {
    await writeFile(path.join(dir, MANIFEST_FILE), "{ nope");
    await assert.rejects(readManifest(dir), /not valid JSON/);
  });

  test("tolerates a UTF-8 BOM", async () => {
    await writeFile(path.join(dir, MANIFEST_FILE), "﻿" + JSON.stringify(sample()));
    assert.deepEqual(await readManifest(dir), sample());
  });
});
