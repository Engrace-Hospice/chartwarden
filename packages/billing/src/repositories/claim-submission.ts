// @wardenx/billing · repositories — `claim_submission` (M23 Billing-Medicare §3.3; non-partitioned;
// retention class `compliance`). APPEND-ONLY: one row per dispatch attempt of an 837I claim / NOE / NOTR
// to the MAC (via the x12-837-client sidecar / portal) — the worker appends a row per attempt capturing
// that attempt's `outcome`; there is deliberately NO update/delete method (the P1 DB append-only trigger
// is mirrored by the repo offering no mutating surface). Mirrors the `validation_run` append-only
// exemplar, including its IDEMPOTENT insert (§2.6): identical `(provider_entity_id, claim_control_number,
// attempt_index)` collapses to one row via the `claim_submission_control_attempt_uq` unique index, so a
// retried dispatch never doubles.
//
// ENUM BOUNDARY: `kind` (claim_837i|noe|notr) and `outcome` (queued|generated|submitted|failed_*) are
// DB-native lowercase enums with no domain-alphabet divergence, so rows pass through UN-mapped (no codec;
// contrast `claim.state`). No PHI / MBI is ever stored here (D13, §8.7).
import * as schema from "@wardenx/db/schema";
import { and, desc, eq } from "drizzle-orm";
import type { BillingDb } from "./db";

const S = schema.claimSubmission;

/** Data port for `claim_submission` (APPEND-ONLY: idempotent append + read; NO update/delete surface). */
export class ClaimSubmissionRepository {
  constructor(private readonly db: BillingDb) {}

  /**
   * Append a dispatch attempt, idempotent on `(provider_entity_id, claim_control_number, attempt_index)`
   * (§2.6): on a duplicate the INSERT no-ops and the existing row is read back, so a retried dispatch
   * collapses to the original row. Returns the persisted submission.
   */
  async append(values: schema.NewClaimSubmission): Promise<schema.ClaimSubmission> {
    const [inserted] = await this.db
      .insert(S)
      .values(values)
      .onConflictDoNothing({
        target: [S.providerEntityId, S.claimControlNumber, S.attemptIndex],
      })
      .returning();
    if (inserted) return inserted;
    const existing = await this.findByAttempt(
      values.providerEntityId,
      values.claimControlNumber,
      values.attemptIndex,
    );
    if (!existing) throw new Error("claim_submission append: conflict but no existing row found");
    return existing;
  }

  /** Point read by id, or `null`. */
  async findById(id: string): Promise<schema.ClaimSubmission | null> {
    const [row] = await this.db.select().from(S).where(eq(S.id, id)).limit(1);
    return row ?? null;
  }

  /** The submission for an idempotency key `(provider_entity, control_number, attempt)` (the dedup probe), or `null`. */
  async findByAttempt(
    providerEntityId: string,
    claimControlNumber: string,
    attemptIndex: number,
  ): Promise<schema.ClaimSubmission | null> {
    const [row] = await this.db
      .select()
      .from(S)
      .where(
        and(
          eq(S.providerEntityId, providerEntityId),
          eq(S.claimControlNumber, claimControlNumber),
          eq(S.attemptIndex, attemptIndex),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * The highest-`attempt_index` submission for a `(provider_entity, control_number)` (so the worker can
   * compute the next attempt index for a retry), or `null` when none has been dispatched yet.
   */
  async findLatestAttempt(
    providerEntityId: string,
    claimControlNumber: string,
  ): Promise<schema.ClaimSubmission | null> {
    const [row] = await this.db
      .select()
      .from(S)
      .where(
        and(eq(S.providerEntityId, providerEntityId), eq(S.claimControlNumber, claimControlNumber)),
      )
      .orderBy(desc(S.attemptIndex))
      .limit(1);
    return row ?? null;
  }

  /** A claim's submission attempts (§3.4 `claim_submission_claim_idx`), newest-first. */
  async listForClaim(
    claimId: string,
    opts: { limit?: number } = {},
  ): Promise<readonly schema.ClaimSubmission[]> {
    return this.db
      .select()
      .from(S)
      .where(eq(S.claimId, claimId))
      .orderBy(desc(S.createdAt), desc(S.id))
      .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  }

  /** The most-recent submission attempt for a claim (the submission worklist head), or `null`. */
  async findLatestForClaim(claimId: string): Promise<schema.ClaimSubmission | null> {
    const [row] = await this.db
      .select()
      .from(S)
      .where(eq(S.claimId, claimId))
      .orderBy(desc(S.createdAt), desc(S.id))
      .limit(1);
    return row ?? null;
  }
}
