#!/usr/bin/env bun
/** `bun run harness:ledger:verify` — check every local agent-ledger file's hash chain is unbroken. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { verifyChain } from "./io";

const dir = join(process.cwd(), ".claude", "audit");
const files = existsSync(dir)
  ? readdirSync(dir)
      .filter((f) => /^agent-ledger-\d{4}-\d{2}\.jsonl$/.test(f))
      .sort()
  : [];
if (files.length === 0) {
  console.log("harness:ledger:verify — no ledger files yet (.claude/audit/)");
  process.exit(0);
}
let bad = 0;
for (const f of files) {
  const r = verifyChain(readFileSync(join(dir, f), "utf8"));
  if (r.ok) console.log(`OK   ${f} (${r.lines} entries)`);
  else {
    bad++;
    console.error(
      `FAIL ${f}: chain broken at line ${r.brokenAt} of ${r.lines} — a line was edited, removed or reordered`,
    );
  }
}
process.exit(bad === 0 ? 0 : 1);
