#!/usr/bin/env bun
/**
 * Detection proof for the M36 restore drill: a drill that cannot fail proves nothing. Runs scripts/m36-restore-drill.ts
 * once per seeded inconsistency and requires BOTH that the drill exits 1 AND that the check named for that fault is
 * the one that failed (not an unrelated failure that happens to coincide).
 *
 *   bun run m36:restore-drill:detect     # exit 0 only if every seeded fault was caught by its own check
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DrillReport } from "./lib/restore-drill/report";

const EXPECTED_CHECK: Readonly<Record<string, string>> = {
  "missing-object": "byte-identical",
  "object-bytes": "byte-identical",
  "hash-flip": "body hashes verify",
};

function main(): number {
  const out = mkdtempSync(join(tmpdir(), "wx-m36-drill-detect-"));
  let undetected = 0;
  try {
    for (const [fault, checkFragment] of Object.entries(EXPECTED_CHECK)) {
      const run = spawnSync(
        "bun",
        ["run", "scripts/m36-restore-drill.ts", `--fault=${fault}`, `--out=${out}`],
        {
          stdio: ["ignore", "ignore", "inherit"],
        },
      );
      const report = JSON.parse(
        readFileSync(join(out, `m36-restore-drill.${fault}.json`), "utf8"),
      ) as DrillReport;
      const failed = report.checks.filter((c) => !c.ok);
      const caught = run.status === 1 && failed.some((c) => c.name.includes(checkFragment));
      console.log(
        `${caught ? "DETECTED" : "MISSED  "} ${fault}: exit ${run.status}; failed checks: ${failed.map((c) => c.name).join(" | ") || "none"}`,
      );
      if (!caught) undetected += 1;
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  return undetected === 0 ? 0 : 1;
}

process.exit(main());
