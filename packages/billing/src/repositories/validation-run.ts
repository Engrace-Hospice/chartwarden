// @wardenx/billing · repositories — the EXEMPLAR APPEND-ONLY repo: `validation_run` (one row per claim
// validation cycle, §3.3, D5; the DB carries an append-only write-audit trigger from P1). This port offers
// INSERT + READ ONLY — there is deliberately NO update/delete method: a run's outcome is recorded once at
// completion and never mutated; a re-validation is a NEW row (a new `trigger`). This is the PATTERN every
// other append-only M23 repo mirrors — `claim_state_history`, `validation_result`, `validation_override`,
// `claim_submission`, `claim_acknowledgment`, `hipps_calculation`, `sia_calculation`, `eligibility_check`.
//
// IDEMPOTENCY (§2.6): identical `(claim_id, trigger, run_input_hash)` collapses to one row via the
// `validation_run_idempotency_uq` unique index; `append` is INSERT … ON CONFLICT DO NOTHING then read-back,
// so a retried run never doubles. ENUM BOUNDARY: `trigger` / `outcome` are DB-native lowercase enums with
// no domain-alphabet divergence, so rows pass through un-mapped (contrast `claim.state`). No PHI / MBI (D13).
import * as schema from "@wardenx/db/schema";
import { and, desc, eq } from "drizzle-orm";
import type { BillingDb } from "./db";

const R = schema.validationRun;

/** Data port for `validation_run` (APPEND-ONLY: idempotent insert + read; NO update/delete surface). */
export class ValidationRunRepository {
  constructor(private readonly db: BillingDb) {}

  /**
   * Append a validation run, idempotent on `(claim_id, trigger, run_input_hash)` (§2.6): on a duplicate the
   * INSERT no-ops and the existing row is read back, so a retry collapses to the original row. Returns the
   * persisted run.
   */
  async append(values: schema.NewValidationRun): Promise<schema.ValidationRun> {
    const [inserted] = await this.db
      .insert(R)
      .values(values)
      // The unique index is partition-key-first — `(organization_id, claim_id, trigger, run_input_hash)` (migration
      // 0076): Postgres only infers an arbiter index when the target lists EXACTLY its columns.
      .onConflictDoNothing({
        target: [R.organizationId, R.claimId, R.trigger, R.runInputHash],
      })
      .returning();
    if (inserted) return inserted;
    const existing = await this.findByIdempotency(
      values.claimId,
      values.trigger,
      values.runInputHash,
    );
    if (!existing) throw new Error("validation_run append: conflict but no existing row found");
    return existing;
  }

  /** Point read by id, or `null`. */
  async findById(id: string): Promise<schema.ValidationRun | null> {
    const [row] = await this.db.select().from(R).where(eq(R.id, id)).limit(1);
    return row ?? null;
  }

  /** The run for an idempotency key `(claim, trigger, run_input_hash)` (the dedup probe), or `null`. */
  async findByIdempotency(
    claimId: string,
    trigger: schema.ValidationRun["trigger"],
    runInputHash: string,
  ): Promise<schema.ValidationRun | null> {
    const [row] = await this.db
      .select()
      .from(R)
      .where(and(eq(R.claimId, claimId), eq(R.trigger, trigger), eq(R.runInputHash, runInputHash)))
      .limit(1);
    return row ?? null;
  }

  /** A claim's validation runs (§3.4 `validation_run_claim_recent_idx`), newest-started first. */
  async listForClaim(
    claimId: string,
    opts: { limit?: number } = {},
  ): Promise<readonly schema.ValidationRun[]> {
    return this.db
      .select()
      .from(R)
      .where(eq(R.claimId, claimId))
      .orderBy(desc(R.startedAt))
      .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  }

  /** The most-recent run for a claim (the validation worklist head), or `null`. */
  async findLatestForClaim(claimId: string): Promise<schema.ValidationRun | null> {
    const [row] = await this.db
      .select()
      .from(R)
      .where(eq(R.claimId, claimId))
      .orderBy(desc(R.startedAt))
      .limit(1);
    return row ?? null;
  }
}
