#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";

function readVersion(): string {
  const pkgUrl = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version?: unknown };
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}

const program = new Command()
  .name("craft-skills")
  .description("Install AI agent skills from GitHub into your project")
  .version(readVersion(), "-v, --version");

await program.parseAsync(process.argv);
