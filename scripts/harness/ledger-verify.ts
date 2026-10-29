#!/usr/bin/env bun
/**
 * `bun run harness:ledger:verify [--print-head]` — check the local agent ledger.
 *
 * Verifies each month's hash chain, that every month starts where the previous one ended (a deleted
 * middle month breaks the link), and that the newest file still matches the anchor in `HEAD` (a
 * truncated tail or a deleted newest file does not). The oldest file may start mid-chain, since old
 * months can be pruned. This catches accidents; it is not proof against someone who rewrites the files
 * and `HEAD` together, so publish `--print-head` output somewhere the agent cannot write if it matters.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ledgerFiles, readHead, verifyChain } from "./io";

const dir = join(process.cwd(), ".claude", "audit");
const files = ledgerFiles(dir);
const head = readHead(dir);

if (process.argv.includes("--print-head")) {
  console.log(head ? `${head.file} lines=${head.lines} sha256=${head.hash}` : "no ledger head yet");
  process.exit(0);
}
if (files.length === 0) {
  if (head) {
    console.error(
      `FAIL HEAD names ${head.file} but .claude/audit has no ledger files — they were deleted`,
    );
    process.exit(1);
  }
  console.log("harness:ledger:verify — no ledger files yet (.claude/audit/)");
  process.exit(0);
}
let bad = 0;
let carry: string | undefined;
for (const f of files) {
  const r = verifyChain(readFileSync(join(dir, f), "utf8"), carry);
  if (r.ok) console.log(`OK   ${f} (${r.lines} entries)`);
  else {
    bad++;
    console.error(
      `FAIL ${f}: chain broken at line ${r.brokenAt} of ${r.lines} — a line was edited, removed or reordered, or a month before it is missing`,
    );
  }
  carry = r.lastHash;
}
if (head) {
  const newest = files[files.length - 1] as string;
  const last = verifyChain(readFileSync(join(dir, newest), "utf8"), undefined);
  if (head.file !== newest || !existsSync(join(dir, head.file))) {
    bad++;
    console.error(
      `FAIL HEAD names ${head.file} but the newest ledger is ${newest} — a newer file was deleted`,
    );
  } else if (last.lines !== head.lines || last.lastHash !== head.hash) {
    bad++;
    console.error(
      `FAIL ${newest}: HEAD expects ${head.lines} entries ending ${head.hash.slice(0, 12)}, found ${last.lines} ending ${String(last.lastHash).slice(0, 12)} — the tail was cut or rewritten`,
    );
  }
}
process.exit(bad === 0 ? 0 : 1);
