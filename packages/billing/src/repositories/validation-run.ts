// @chartwarden/billing · repositories — the EXEMPLAR APPEND-ONLY repo: `validation_run` (one row per claim
// validation cycle, §3.3, D5; the DB carries an append-only write-audit trigger from P1). This port offers
// INSERT + READ ONLY — there is deliberately NO update/delete method: a run's outcome is recorded once at
// completion and never mutated; a re-validation is a NEW row (a new `trigger`). This is the PATTERN every
// other append-only M23 repo mirrors — `claim_state_history`, `validation_result`, `validation_override`,
// `claim_submission`, `claim_acknowledgment`, `per_diem_rate_calculation`, `sia_calculation`, `eligibility_check`.
//
// IDEMPOTENCY (§2.6): identical `(claim_id, trigger, run_input_hash)` collapses to one row via the
// `validation_run_idempotency_uq` unique index; `append` is INSERT … ON CONFLICT DO NOTHING then read-back,
// so a retried run never doubles. ENUM BOUNDARY: `trigger` / `outcome` are DB-native lowercase enums with
// no domain-alphabet divergence, so rows pass through un-mapped (contrast `claim.state`). No PHI / MBI (D13).
import * as schema from "@chartwarden/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { BillingDb } from "./db";

const R = schema.validationRun;

/** One group of {@link ValidationRunRepository.summarizeLatestByOutcome}; `outcome: null` = never validated. */
export interface LatestOutcomeGroup {
  readonly outcome: schema.ValidationRun["outcome"] | null;
  readonly claims: number;
  /** Oldest `completed_at` among the group's latest runs (`null` for the never-validated group). */
  readonly oldestRunAt: Date | null;
}

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

  /**
   * The most-recent run for each of `claimIds` in ONE query (`DISTINCT ON (claim_id)`, newest-started first,
   * served by `validation_run_claim_recent_idx`) — the list-page batch twin of {@link findLatestForClaim}.
   * Claims never validated are simply absent from the result.
   */
  async findLatestForClaims(claimIds: readonly string[]): Promise<readonly schema.ValidationRun[]> {
    if (claimIds.length === 0) return [];
    return this.db
      .selectDistinctOn([R.claimId])
      .from(R)
      .where(inArray(R.claimId, [...claimIds]))
      .orderBy(R.claimId, desc(R.startedAt));
  }

  /**
   * Org-wide rollup: every claim visible to the caller grouped by the outcome of its NEWEST run (a LEFT JOIN
   * LATERAL `ORDER BY started_at DESC LIMIT 1`, served by `validation_run_claim_recent_idx`; a claim with no
   * run falls in the `outcome: null` group). ONE statement, no row-level data. `providerEntityScope` is the
   * same server-derived authorization narrowing the claim list applies: `undefined` = unrestricted, an
   * EMPTY array matches nothing (fail-closed). Errors propagate; this never substitutes zeros.
   */
  async summarizeLatestByOutcome(
    organizationId: string,
    providerEntityScope?: readonly string[],
  ): Promise<readonly LatestOutcomeGroup[]> {
    const C = schema.claim;
    const scopeClause =
      providerEntityScope === undefined
        ? sql``
        : providerEntityScope.length === 0
          ? sql`AND false`
          : sql`AND c.provider_entity_id IN (${sql.join(
              providerEntityScope.map((id) => sql`${id}`),
              sql`, `,
            )})`;
    const res = await this.db.execute(sql`
      SELECT l.outcome AS outcome, count(*)::int AS claims, min(l.completed_at) AS oldest_run_at
      FROM ${C} c
      LEFT JOIN LATERAL (
        SELECT r.outcome, r.completed_at
        FROM ${R} r
        WHERE r.claim_id = c.id
        ORDER BY r.started_at DESC
        LIMIT 1
      ) l ON true
      WHERE c.organization_id = ${organizationId} ${scopeClause}
      GROUP BY l.outcome
    `);
    return (
      res.rows as {
        outcome: schema.ValidationRun["outcome"] | null;
        claims: number;
        oldest_run_at: Date | string | null;
      }[]
    ).map((row) => ({
      outcome: row.outcome,
      claims: Number(row.claims),
      oldestRunAt: row.oldest_run_at === null ? null : new Date(row.oldest_run_at),
    }));
  }
}
