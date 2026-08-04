// @wardenx/billing · repositories — `claim_acknowledgment` (M23 Billing-Medicare §3.3; non-partitioned;
// retention class `compliance`). APPEND-ONLY: one row per inbound 999 / 277CA / 835 acknowledgment file
// processed for a submission — the ack-ingest worker appends a row capturing the parsed result; there is
// deliberately NO update/delete method (the P1 DB append-only trigger is mirrored by the repo offering no
// mutating surface). Mirrors the `validation_run` append-only exemplar, including its IDEMPOTENT insert
// (§2.6): identical `(mac_jurisdiction, ack_file_uri)` collapses to one row via the `claim_ack_file_uq`
// unique index, so re-processing the same ack file never doubles.
//
// ENUM BOUNDARY: `kind` (ack_999|ack_277ca|ack_835) and `mac_jurisdiction` are DB-native lowercase enums
// with no domain-alphabet divergence, so rows pass through UN-mapped (no codec; contrast `claim.state`).
// `parsed_payload` carries only X12 status/reason codes — NEVER PHI/MBI (D13, §8.7).
import * as schema from "@wardenx/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  type BillingDb,
  type CursorPage,
  buildCursorPage,
  decodeCursor,
  keysetBefore,
  pageSizeOf,
} from "./db";

const A = schema.claimAcknowledgment;

/** The negative-outcome slice handed off to the M25 denial worklist (§3.4 `claim_acknowledgment_outcome_partial`). */
const DENIAL_OUTCOMES = ["rejected", "partial", "denied"] as const;

/** Data port for `claim_acknowledgment` (APPEND-ONLY: idempotent append + read; NO update/delete surface). */
export class ClaimAcknowledgmentRepository {
  constructor(private readonly db: BillingDb) {}

  /**
   * Append a parsed acknowledgment, idempotent on `(mac_jurisdiction, ack_file_uri)` (§2.6): on a duplicate
   * the INSERT no-ops and the existing row is read back, so re-processing the same ack file collapses to
   * the original row. Returns the persisted acknowledgment.
   */
  async append(values: schema.NewClaimAcknowledgment): Promise<schema.ClaimAcknowledgment> {
    const [inserted] = await this.db
      .insert(A)
      .values(values)
      .onConflictDoNothing({ target: [A.macJurisdiction, A.ackFileUri] })
      .returning();
    if (inserted) return inserted;
    const existing = await this.findByFile(values.macJurisdiction, values.ackFileUri);
    if (!existing)
      throw new Error("claim_acknowledgment append: conflict but no existing row found");
    return existing;
  }

  /** Point read by id, or `null`. */
  async findById(id: string): Promise<schema.ClaimAcknowledgment | null> {
    const [row] = await this.db.select().from(A).where(eq(A.id, id)).limit(1);
    return row ?? null;
  }

  /** The acknowledgment for an idempotency key `(mac_jurisdiction, ack_file_uri)` (the dedup probe), or `null`. */
  async findByFile(
    macJurisdiction: schema.ClaimAcknowledgment["macJurisdiction"],
    ackFileUri: string,
  ): Promise<schema.ClaimAcknowledgment | null> {
    const [row] = await this.db
      .select()
      .from(A)
      .where(and(eq(A.macJurisdiction, macJurisdiction), eq(A.ackFileUri, ackFileUri)))
      .limit(1);
    return row ?? null;
  }

  /** A claim's acknowledgments (§3.4 `claim_ack_claim_recent_idx`), newest-received first. */
  async listForClaim(
    claimId: string,
    opts: { limit?: number } = {},
  ): Promise<readonly schema.ClaimAcknowledgment[]> {
    return this.db
      .select()
      .from(A)
      .where(eq(A.claimId, claimId))
      .orderBy(desc(A.ackReceivedAt), desc(A.id))
      .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  }

  /** The acknowledgments for a submission (§3.4 `claim_ack_submission_idx`), newest-received first. */
  async listForSubmission(submissionId: string): Promise<readonly schema.ClaimAcknowledgment[]> {
    return this.db
      .select()
      .from(A)
      .where(eq(A.submissionId, submissionId))
      .orderBy(desc(A.ackReceivedAt), desc(A.id));
  }

  /** The most-recent acknowledgment for a claim (the ack worklist head), or `null`. */
  async findLatestForClaim(claimId: string): Promise<schema.ClaimAcknowledgment | null> {
    const [row] = await this.db
      .select()
      .from(A)
      .where(eq(A.claimId, claimId))
      .orderBy(desc(A.ackReceivedAt), desc(A.id))
      .limit(1);
    return row ?? null;
  }

  /**
   * One keyset page of an org's NEGATIVE-outcome acknowledgments (§3.4 denial-worklist hand-off to M25;
   * `outcome_status IN (rejected, partial, denied)`), `(created_at DESC, id DESC)` newest-first.
   * Over-fetches `size + 1` rows so {@link buildCursorPage} can reveal `hasMore` + mint the next cursor.
   * RLS scopes the statement to `app.org_id` at the service layer.
   */
  async listDenialWorklistPage(
    organizationId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<schema.ClaimAcknowledgment>> {
    const size = pageSizeOf(limit);
    const where = and(
      eq(A.organizationId, organizationId),
      inArray(A.outcomeStatus, DENIAL_OUTCOMES as unknown as string[]),
      keysetBefore(A.createdAt, A.id, cursor ? decodeCursor(cursor) : undefined),
    );
    const rows = await this.db
      .select()
      .from(A)
      .where(where)
      .orderBy(desc(A.createdAt), desc(A.id))
      .limit(size + 1);
    return buildCursorPage(rows, size, (r) => ({
      createdAt: r.createdAt.toISOString(),
      id: r.id,
    }));
  }
}
