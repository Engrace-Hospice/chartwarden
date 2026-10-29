#!/usr/bin/env bun
/**
 * `bun run harness:phi-scan [--staged | --all | <paths...>]`
 *
 * The same PHI-shaped-identifier and credential rules the agent guard applies, for every route into
 * the repo that is not an agent tool call: a human's commit (`.githooks/pre-commit` runs `--staged`)
 * and CI (`--all`). Real-looking SSNs and MBIs must come from compliance/synthetic-identifiers.json.
 *
 * Exits 1 on any finding. Prints redacted samples only.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadRegistry } from "./io";
import { describeFindings, isScannable, scanLarge } from "./patterns";

/** NUL-separated git output (`-z`): non-ASCII and special names are not quoted, so no file is skipped as "missing". */
const splitNul = (out: string): string[] => out.split("\0").filter(Boolean);

const root = process.cwd();
const args = process.argv.slice(2);
const git = (a: string[]) =>
  execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

let files: string[];
let read: (f: string) => Buffer | null;
if (args[0] === "--staged") {
  files = splitNul(git(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"]));
  read = (f) => {
    try {
      return execFileSync("git", ["show", `:${f}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    } catch {
      return null;
    }
  };
} else {
  files = args[0] === "--all" || args.length === 0 ? splitNul(git(["ls-files", "-z"])) : args;
  read = (f) => {
    try {
      const p = join(root, f);
      if (!statSync(p).isFile()) return null;
      return readFileSync(p);
    } catch {
      return null;
    }
  };
}

const registry = loadRegistry(root);
const problems: string[] = [];
let scanned = 0;
for (const f of files) {
  if (!isScannable(f)) continue;
  const buf = read(f);
  if (!buf || buf.includes(0)) continue;
  scanned++;
  const findings = scanLarge(buf.toString("utf8"), registry, f);
  if (findings.length > 0) problems.push(describeFindings(f, findings));
}

if (problems.length > 0) {
  console.error(
    `FAIL harness:phi-scan — ${problems.length} file(s) carry PHI-shaped identifiers or credentials:\n`,
  );
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`OK harness:phi-scan — ${scanned} file(s) clean`);
