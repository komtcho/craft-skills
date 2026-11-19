import { test } from "node:test";
import assert from "node:assert/strict";
import { CraftError } from "../src/types.js";
import { isInteractive } from "../src/core/ui.js";

test("CraftError keeps message and hint", () => {
  const err = new CraftError("not found", "check the repo name");
  assert.ok(err instanceof Error);
  assert.equal(err.name, "CraftError");
  assert.equal(err.message, "not found");
  assert.equal(err.hint, "check the repo name");
  assert.equal(new CraftError("plain").hint, undefined);
});

test("isInteractive requires both TTYs and no CI", () => {
  const tty = { stdinIsTTY: true, stdoutIsTTY: true };
  assert.equal(isInteractive({ ...tty, ci: undefined }), true);
  assert.equal(isInteractive({ ...tty, ci: "" }), true);
  assert.equal(isInteractive({ ...tty, ci: "true" }), false);
  assert.equal(isInteractive({ stdinIsTTY: false, stdoutIsTTY: true, ci: undefined }), false);
  assert.equal(isInteractive({ stdinIsTTY: true, stdoutIsTTY: false, ci: undefined }), false);
});
