// @wardenx/billing · repositories — `validation_result` (one row per (validation_run, rule), §3.3/§3.4,
// D5; APPEND-ONLY, retention class `operational`; the DB carries an append-only write-audit trigger from
// P1). This port mirrors the `ValidationRunRepository` exemplar: it offers INSERT + READ ONLY — there is
// deliberately NO update/delete method. A run's per-rule outcomes are recorded once as the rule engine
// completes the run and never mutated; a re-validation produces a NEW run with a NEW result set. The
// `override_id` link is therefore NOT updated here either — the override is resolved by joining through
// `validation_override.result_id` (see `ValidationOverrideRepository`).
//
// ENUM BOUNDARY: `severity` (error/warn/info) and `outcome` (pass/fail/warn/info) are DB-native lowercase
// enums identical to the domain alphabet (`ValidationSeverity` / `ValidationOutcome`), so rows pass through
// un-mapped (contrast `claim.state`). No PHI / MBI is ever stored here (D13, §8.7).
import * as schema from "@wardenx/db/schema";
import { and, asc, eq } from "drizzle-orm";
import type { BillingDb } from "./db";

const R = schema.validationResult;

/** Data port for `validation_result` (APPEND-ONLY: batch/single insert + read; NO update/delete surface). */
export class ValidationResultRepository {
  constructor(private readonly db: BillingDb) {}

  /**
   * Append a run's per-rule results in one statement (the rule engine's only write path — it emits the
   * whole result set as a run completes). Returns the persisted rows in insertion order.
   */
  async appendBatch(
    values: readonly schema.NewValidationResult[],
  ): Promise<readonly schema.ValidationResult[]> {
    if (values.length === 0) return [];
    return this.db.insert(R).values([...values]).returning();
  }

  /** Append a single per-rule result. Returns the persisted row. */
  async append(values: schema.NewValidationResult): Promise<schema.ValidationResult> {
    const [row] = await this.db.insert(R).values(values).returning();
    if (!row) throw new Error("validation_result insert returned no row");
    return row;
  }

  /** Point read by id, or `null`. */
  async findById(id: string): Promise<schema.ValidationResult | null> {
    const [row] = await this.db.select().from(R).where(eq(R.id, id)).limit(1);
    return row ?? null;
  }

  /** A run's results (§3.4 `validation_result_run_idx`), in deterministic `(recorded_at, id)` order. */
  async listForRun(
    validationRunId: string,
    opts: { limit?: number } = {},
  ): Promise<readonly schema.ValidationResult[]> {
    return this.db
      .select()
      .from(R)
      .where(eq(R.validationRunId, validationRunId))
      .orderBy(asc(R.recordedAt), asc(R.id))
      .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  }

  /**
   * A run's FAILED results only (§3.4 `validation_result_failed_per_claim` partial index `outcome='fail'`)
   * — the validation-worklist head a claim must clear or override before it can reach READY.
   */
  async listFailuresForRun(
    validationRunId: string,
    opts: { limit?: number } = {},
  ): Promise<readonly schema.ValidationResult[]> {
    return this.db
      .select()
      .from(R)
      .where(and(eq(R.validationRunId, validationRunId), eq(R.outcome, "fail")))
      .orderBy(asc(R.recordedAt), asc(R.id))
      .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  }
}
