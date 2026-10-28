// apps/backend/src/modules/08-encounters/chart-promotion.ts - WP 3.7 (ADR-0063): M8 as the OWNER of the encounter-addendum
// chart-promotion target. A clinician in the messaging hub PROPOSES that a secure message belongs in the chart; nothing
// reaches M8 until a reviewer authors their OWN addendum here and signs it (existing step-up). M8 reads the proposal only
// through the M36 `ChartPromotionSourceReader` seam (no import edge) and tells M36 the outcome with the owner event
// `m8.chart_promotion.decided` (ids, an outcome enum, a reason code and an instant: no text, no patient id, no hash).
import {
  type CHART_PROMOTION_REJECT_REASONS,
  type ChartPromotionReview,
  ChartWardenError,
  ConflictError,
} from "@chartwarden/types";
import { getSeam } from "../../bootstrap/index";

export const CHART_PROMOTION_DECIDED_EVENT = "m8.chart_promotion.decided";
/**
 * The most proposals one GET lists. Each listed proposal costs one message-body decrypt (this module is the only caller
 * allowed to ask the seam for text), so the cap is small; the seam caps it again.
 */
export const CHART_PROMOTION_LIST_MAX = 10;
/** The unique index that allows one live addendum per proposal. */
const PROMOTION_UNIQUE_INDEX = "encounter_addendum_promotion_uq";

export type RejectReasonCode = (typeof CHART_PROMOTION_REJECT_REASONS)[number];

/** One proposal as the addendum panel shows it (snake_case: it mirrors the M36 DTO the web already renders). */
export interface ChartPromotionView {
  readonly request_id: string;
  readonly requested_by: string;
  readonly requested_at: string;
  readonly source_author_user_id: string;
  readonly source_sent_at: string;
  /**
   * The quoted text, shown to the reviewer and NEVER inserted into the addendum for them. Null when the sender edited
   * the message since it was proposed (`source_state: "edited_since"`): the superseded text is not served.
   */
  readonly snapshot_text: string | null;
  readonly source_state: "current" | "edited_since";
}

export interface ChartPromotionListView {
  readonly enabled: boolean;
  readonly promotions: readonly ChartPromotionView[];
}

/** The facts the create route passes alongside the reviewer's own addendum reason. */
export interface AddendumPromotionInput {
  readonly requestId: string;
  /** The M2 USER id of the reviewer (not the membership id). */
  readonly reviewerUserId: string;
}

export const promotionNotAvailable = (): ChartWardenError =>
  new ChartWardenError("PROMOTION_NOT_AVAILABLE", "that proposal is not available to review", 422);

const toView = (r: ChartPromotionReview): ChartPromotionView => ({
  request_id: r.requestId,
  requested_by: r.requestedByUserId,
  requested_at: r.requestedAt,
  source_author_user_id: r.sourceAuthorUserId,
  source_sent_at: r.sourceSentAt,
  snapshot_text: r.snapshotText,
  source_state: r.sourceState,
});

/**
 * The proposal for review, or PROMOTION_NOT_AVAILABLE. Not available = the seam says no (flag off, not proposed, wrong
 * target, reviewer not allowed, text cannot be proven) OR the seam is unbound / throws (fail closed) OR the proposal is
 * about another patient than the encounter's. The answer never says which.
 */
export async function requireReview(
  organizationId: string,
  requestId: string,
  reviewerUserId: string,
  encounterPatientId: string | null,
): Promise<ChartPromotionReview> {
  let review: ChartPromotionReview | null;
  try {
    review = await getSeam("ChartPromotionSourceReader").forReview(organizationId, requestId, {
      targetModule: "m8",
      reviewerUserId,
      // This module is the only caller that asks for text (the seam serves none otherwise).
      withText: true,
    });
  } catch {
    throw promotionNotAvailable();
  }
  if (!review || review.targetKind !== "encounter_addendum") throw promotionNotAvailable();
  if (encounterPatientId === null || review.patientId !== encounterPatientId) {
    throw promotionNotAvailable();
  }
  return review;
}

/** Pending proposals for the encounter's patient. Fails closed to `{enabled:false}` when the seam is off or unbound. */
export async function listForPatient(
  organizationId: string,
  patientId: string,
  reviewerUserId: string,
): Promise<ChartPromotionListView> {
  const none: ChartPromotionListView = { enabled: false, promotions: [] };
  try {
    const seam = getSeam("ChartPromotionSourceReader");
    if (!(await seam.enabled(organizationId))) return none;
    const pending = await seam.pendingForPatients(organizationId, {
      targetModule: "m8",
      patientIds: [patientId],
      reviewerUserId,
      limit: CHART_PROMOTION_LIST_MAX,
    });
    const reviews = await Promise.all(
      pending.slice(0, CHART_PROMOTION_LIST_MAX).map((p) =>
        seam.forReview(organizationId, p.requestId, {
          targetModule: "m8",
          reviewerUserId,
          withText: true,
        }),
      ),
    );
    const promotions = reviews
      .filter((r): r is ChartPromotionReview => r !== null && r.patientId === patientId)
      .map(toView);
    return { enabled: true, promotions };
  } catch {
    return none;
  }
}

export interface DecidedFacts {
  readonly organizationId: string;
  readonly promotionRequestId: string;
  readonly outcome: "accepted" | "rejected";
  readonly resultRef: string | null;
  readonly decidedByUserId: string;
  readonly reasonCode: RejectReasonCode | null;
  readonly at: Date;
}

/** The `m8.chart_promotion.decided` payload (matches the catalog schema in events-by-m8.ts). */
export const decidedPayload = (f: DecidedFacts): Record<string, unknown> => ({
  organizationId: f.organizationId,
  promotionRequestId: f.promotionRequestId,
  outcome: f.outcome,
  resultRef: f.resultRef,
  decidedByUserId: f.decidedByUserId,
  reasonCode: f.reasonCode,
  at: f.at.toISOString(),
});

/** A proposal that already has a non-voided addendum cannot be rejected: the draft's author is mid-decision (409). */
export const promotionHasDraft = (): ConflictError =>
  new ConflictError("that proposal already has an addendum");

/**
 * Map the refusals an attributed write can raise: a second live draft (409), or a proposal that moved or is no longer open
 * (422), whether at INSERT (the draft) or at SIGN (rejected, accepted or gone by the time the reviewer signs).
 */
export function mapPromotionInsertError(err: unknown): never {
  const e = err as { code?: string; constraint?: string; cause?: unknown } | null;
  const own = e?.code !== undefined ? e : (e?.cause as typeof e);
  if (own?.code === "23505" && own.constraint === PROMOTION_UNIQUE_INDEX) {
    throw new ConflictError("that proposal already has an addendum");
  }
  if (own?.code === "23514" || own?.code === "P0001") {
    const text = String((own as { message?: unknown }).message ?? "");
    if (text.includes("encounter_addendum_promotion_source")) throw promotionNotAvailable();
  }
  throw err;
}
