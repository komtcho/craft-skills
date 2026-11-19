import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setOutput } from "../../src/core/ui.js";

/** Creates a fresh temp project dir; call the returned cleanup when done. */
export async function tempProject(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "craft-skills-test-")));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export interface CapturedOutput {
  out: string[];
  err: string[];
  text(): string;
  restore(): void;
}

/** Captures everything `core/ui.ts` prints. */
export function captureOutput(): CapturedOutput {
  const out: string[] = [];
  const err: string[] = [];
  const restore = setOutput({ out: (t) => void out.push(t), err: (t) => void err.push(t) });
  return { out, err, text: () => [...out, ...err].join(""), restore };
}
