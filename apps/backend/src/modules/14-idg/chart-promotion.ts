// apps/backend/src/modules/14-idg/chart-promotion.ts - WP 3.7 (ADR-0063): M14 as the OWNER of the IDG agenda-item chart-promotion
// target. A clinician in the messaging hub PROPOSES that a secure message be raised at an IDG meeting. The coordinator
// adds an `other` agenda item from it (a pointer plus attribution: NO message text is ever copied here) or declines it.
// M14 reads the proposal only through the M36 `ChartPromotionSourceReader` seam (no import edge) and tells M36 the outcome
// with `m14.chart_promotion.decided`. This never records an IDG decision and never touches the plan of care: a decision is
// a separate, quorate act in the meeting.
import {
  type CHART_PROMOTION_REJECT_REASONS,
  type ChartPromotionReview,
  ConflictError,
  ChartWardenError,
} from "@wardenx/types";
import { getSeam } from "../../bootstrap/index";

export const CHART_PROMOTION_DECIDED_EVENT = "m14.chart_promotion.decided";
/** The most proposals the meeting panel lists (the seam caps it again). */
export const CHART_PROMOTION_LIST_MAX = 50;
/**
 * The most distinct patients one GET asks the seam about (the seam runs one 42 CFR Part 2 lookup per patient, so an
 * org-wide caller's whole caseload must not fan out unbounded). The seam caps it again.
 */
export const CHART_PROMOTION_LIST_PATIENTS_MAX = 100;
/** The title of an agenda item added from a proposal: fixed, generic text (never anything from the message). */
export const PROMOTED_AGENDA_TITLE = "Raised from a secure message";
/** The unique index that allows one agenda item per proposal. */
const PROMOTION_UNIQUE_INDEX = "idg_agenda_item_promotion_uq";

export type RejectReasonCode = (typeof CHART_PROMOTION_REJECT_REASONS)[number];

/** One proposal as the meeting panel lists it: metadata only (the IDG screen never sees the text). */
export interface ChartPromotionView {
  readonly request_id: string;
  readonly patientId: string;
  readonly requested_by: string;
  readonly requested_at: string;
  readonly source_author_user_id: string;
  readonly source_sent_at: string;
}

export interface ChartPromotionListView {
  readonly enabled: boolean;
  readonly promotions: readonly ChartPromotionView[];
}

/** Whether a patient is within the caller's IDG scope (an org-wide role, the caseload, or the pinned patient). */
export type PatientInScope = (patientId: string) => boolean;

export const promotionNotAvailable = (): ChartWardenError =>
  new ChartWardenError("PROMOTION_NOT_AVAILABLE", "that proposal is not available to review", 422);

/**
 * The proposal for review, or PROMOTION_NOT_AVAILABLE. Not available = the seam says no (flag off, not proposed, wrong
 * target, reviewer not allowed, source cannot be proven) OR the seam is unbound / throws (fail closed) OR the patient is
 * outside the caller's IDG scope. The answer never says which. The seam's `snapshotText` is null for `m14` by design.
 */
export async function requireReview(
  organizationId: string,
  requestId: string,
  reviewerUserId: string,
  inScope: PatientInScope,
): Promise<ChartPromotionReview> {
  let review: ChartPromotionReview | null;
  try {
    review = await getSeam("ChartPromotionSourceReader").forReview(organizationId, requestId, {
      targetModule: "m14",
      reviewerUserId,
    });
  } catch {
    throw promotionNotAvailable();
  }
  if (!review || review.targetKind !== "idg_agenda_item") throw promotionNotAvailable();
  if (!inScope(review.patientId)) throw promotionNotAvailable();
  return review;
}

/** Pending proposals for the given patients. Fails closed to `{enabled:false}` when the seam is off or unbound. */
export async function listForPatients(
  organizationId: string,
  patientIds: readonly string[],
  reviewerUserId: string,
): Promise<ChartPromotionListView> {
  const none: ChartPromotionListView = { enabled: false, promotions: [] };
  try {
    const seam = getSeam("ChartPromotionSourceReader");
    if (!(await seam.enabled(organizationId))) return none;
    if (patientIds.length === 0) return { enabled: true, promotions: [] };
    const pending = await seam.pendingForPatients(organizationId, {
      targetModule: "m14",
      patientIds: [...new Set(patientIds)].slice(0, CHART_PROMOTION_LIST_PATIENTS_MAX),
      reviewerUserId,
      limit: CHART_PROMOTION_LIST_MAX,
    });
    return {
      enabled: true,
      promotions: pending.map((p) => ({
        request_id: p.requestId,
        patientId: p.patientId,
        requested_by: p.requestedByUserId,
        requested_at: p.requestedAt,
        source_author_user_id: p.sourceAuthorUserId,
        source_sent_at: p.sourceSentAt,
      })),
    };
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

/** The `m14.chart_promotion.decided` payload (matches the catalog schema in events-by-m14.ts). */
export const decidedPayload = (f: DecidedFacts): Record<string, unknown> => ({
  organizationId: f.organizationId,
  promotionRequestId: f.promotionRequestId,
  outcome: f.outcome,
  resultRef: f.resultRef,
  decidedByUserId: f.decidedByUserId,
  reasonCode: f.reasonCode,
  at: f.at.toISOString(),
});

/** A proposal that already has an agenda item cannot be rejected: the coordinator already acted on it (409). */
export const promotionHasItem = (): ConflictError =>
  new ConflictError("that proposal already has an agenda item");

/** Map the two database refusals an attributed insert can raise: a second item for the proposal (409) or a proposal that moved (422). */
export function mapPromotionInsertError(err: unknown): never {
  const e = err as {
    code?: string;
    constraint?: string;
    message?: unknown;
    cause?: unknown;
  } | null;
  const own = e?.code !== undefined ? e : (e?.cause as typeof e);
  if (own?.code === "23505" && own.constraint === PROMOTION_UNIQUE_INDEX) {
    throw new ConflictError("that proposal already has an agenda item");
  }
  if (
    own?.code === "23514" &&
    String(own.message ?? "").includes("idg_agenda_item_promotion_source")
  ) {
    throw promotionNotAvailable();
  }
  throw err;
}
