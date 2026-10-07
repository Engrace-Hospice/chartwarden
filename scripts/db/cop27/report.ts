/**
 * COP27 API seed — per-step logging and the end-of-run summary table.
 *
 * Every step is recorded as `ok` (a write landed), `exists` (already present — idempotent re-run), `skip`
 * (not attempted: a missing role or org setup), `plan` (dry run: would be written), `fail` (the server
 * refused; the API error code is kept) or `note` (a deliberate design choice, not counted). A scenario fails when any of its steps fails; the run exits non-zero
 * when any scenario failed.
 */
import { ApiError, SkipStep } from "./http";

export type StepOutcome = "ok" | "exists" | "skip" | "fail" | "plan" | "note";

interface StepRecord {
  readonly scenario: string;
  readonly step: string;
  readonly outcome: StepOutcome;
  readonly detail: string;
}

const MARK: Record<StepOutcome, string> = {
  ok: "✓",
  exists: "•",
  skip: "⊘",
  fail: "✗",
  plan: "→",
  note: "ℹ",
};

export class RunReport {
  private readonly records: StepRecord[] = [];

  record(scenario: string, step: string, outcome: StepOutcome, detail = ""): void {
    this.records.push({ scenario, step, outcome, detail });
    const suffix = detail ? ` — ${detail}` : "";
    console.log(`  ${MARK[outcome]} [${scenario}] ${step}: ${outcome}${suffix}`);
  }

  /** Record a thrown error as `skip` (SkipStep) or `fail` (anything else, API code kept). */
  recordError(scenario: string, step: string, err: unknown): void {
    if (err instanceof SkipStep) {
      this.record(scenario, step, "skip", err.message);
    } else if (err instanceof ApiError) {
      this.record(scenario, step, "fail", `HTTP ${err.status} ${err.code} — ${err.message}`);
    } else {
      this.record(scenario, step, "fail", err instanceof Error ? err.message : String(err));
    }
  }

  failedScenarios(): string[] {
    return [...new Set(this.records.filter((r) => r.outcome === "fail").map((r) => r.scenario))];
  }

  skips(): StepRecord[] {
    return this.records.filter((r) => r.outcome === "skip");
  }

  printSummary(): void {
    const scenarios = [...new Set(this.records.map((r) => r.scenario))];
    const count = (s: string, o: StepOutcome): number =>
      this.records.filter((r) => r.scenario === s && r.outcome === o).length;
    const rows = scenarios.map((s) => ({
      scenario: s,
      ok: count(s, "ok"),
      exists: count(s, "exists"),
      skip: count(s, "skip"),
      fail: count(s, "fail"),
      plan: count(s, "plan"),
      result:
        count(s, "fail") > 0
          ? "FAILED"
          : count(s, "plan") > 0
            ? "planned"
            : count(s, "skip") > 0
              ? "partial"
              : "complete",
    }));
    console.log("\n=== COP27 demo seed summary ===");
    console.table(rows);
    const skipped = this.skips();
    if (skipped.length > 0) {
      console.log("Skipped steps:");
      for (const r of skipped) console.log(`  ⊘ [${r.scenario}] ${r.step} — ${r.detail}`);
    }
    const failed = this.records.filter((r) => r.outcome === "fail");
    if (failed.length > 0) {
      console.log("Failed steps:");
      for (const r of failed) console.log(`  ✗ [${r.scenario}] ${r.step} — ${r.detail}`);
    }
  }
}
