/**
 * WardenX — Plan Integrity Check  (ADR-0030; fitness guardrail)
 * ------------------------------------------------------------------
 * `docs/plans/**` are AUTHORITY INPUTS to the deterministic build harness
 * (`wardenx-piv` / `archon-plan-to-pr`). An automated run consumes a plan; it must
 * never REWRITE one. An agent that edits its own plan to narrow scope or manufacture
 * a "deferred" resolution breaks determinism — the plan stops being a fixed contract
 * and becomes whatever the agent wants it to be. (This happened on the M1+M2 slice:
 * the run self-edited M2-T09 to authorize skipping it — see ADR-0030.)
 *
 * This check FAILS if the working tree (or this branch, vs `main`) modifies anything
 * under `docs/plans/`. Plans are read-only to the harness; the right move on a
 * plan↔manifest conflict is to STOP and surface it to a human (`confirm-plan` says so).
 *
 * Escape hatch — a HUMAN making an intentional plan edit sets the env var:
 *   ALLOW_PLAN_EDITS=1 bun run arch:plan-integrity
 * The harness does not set it, so automated runs stay blocked.
 *
 * Run:   bun run scripts/check-plan-integrity.ts   (alias: bun run arch:plan-integrity)
 * CI:    exits 1 on any plan modification (arch:fitness stage).
 */

import { execSync } from "node:child_process";

const GUARDED_PREFIX = "docs/plans/";
const BASE_REF = "main";

function git(args: string): string {
  return execSync(`git ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function tryGit(args: string): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

// Not a git repo (or git unavailable) → nothing to enforce; don't break the build.
if (tryGit("rev-parse --is-inside-work-tree") !== "true") {
  console.log("ℹ check-plan-integrity: not a git work tree — skipping.");
  process.exit(0);
}

if (process.env.ALLOW_PLAN_EDITS) {
  console.log(
    "⚠ check-plan-integrity: ALLOW_PLAN_EDITS set — plan edits permitted (human override).",
  );
  process.exit(0);
}

const offenders = new Set<string>();

function addPaths(out: string | null): void {
  if (!out) return;
  for (const path of out.split("\n")) {
    const p = path.trim();
    if (p.startsWith(GUARDED_PREFIX)) offenders.add(p);
  }
}

// 1) Working-tree changes — the primary signal: during a wardenx-piv per-task `validate`
//    gate, the agent's edits are still uncommitted. Use path-only commands (no porcelain
//    column parsing): tracked modifications vs HEAD + untracked new files.
addPaths(tryGit(`diff --name-only HEAD -- ${GUARDED_PREFIX}`)); // modified + staged tracked
addPaths(tryGit(`ls-files --others --exclude-standard -- ${GUARDED_PREFIX}`)); // new untracked

// 2) Committed-on-this-branch changes vs the fork point with `main` (belt + suspenders:
//    catches a run that committed a plan edit). Skipped gracefully if `main` is unreachable
//    (e.g. shallow CI checkout) — the working-tree check above still covers the live case.
const base = tryGit(`merge-base HEAD ${BASE_REF}`);
if (base) {
  const committed = tryGit(`diff --name-only ${base} HEAD -- ${GUARDED_PREFIX}`);
  if (committed) {
    for (const path of committed.split("\n")) {
      if (path.trim().startsWith(GUARDED_PREFIX)) offenders.add(path.trim());
    }
  }
}

if (offenders.size > 0) {
  console.error("✗ check-plan-integrity: docs/plans/** is read-only to automated runs.\n");
  console.error("  Plan files were modified by this run/branch:");
  for (const f of [...offenders].sort()) console.error(`    • ${f}`);
  console.error(
    "\n  Plans are authority INPUTS, not the harness's output. On a plan↔manifest\n" +
      "  conflict, STOP and surface it to a human (open/extend an ADR) — do not rewrite\n" +
      "  the plan to fit the code. Revert these changes to go green.\n" +
      "\n  Intentional human edit? Re-run with ALLOW_PLAN_EDITS=1.",
  );
  process.exit(1);
}

console.log("✓ check-plan-integrity: no plan files modified — docs/plans/** intact.");
