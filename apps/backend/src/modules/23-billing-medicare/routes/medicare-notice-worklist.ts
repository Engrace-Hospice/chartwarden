import { encodeCursor as encodeDomainCursor } from "@chartwarden/billing";
import { repositories } from "@chartwarden/billing";
import * as schema from "@chartwarden/db/schema";
import { createHash } from "node:crypto";
import { decodeCursor, encodeCursor } from "@chartwarden/shared/route-kit";
import { withOrgContext } from "@chartwarden/tenancy";
import { ForbiddenError } from "@chartwarden/types";
import { and, eq, inArray } from "drizzle-orm";
import type { M23ReadActor } from "./actor";
import type { NoeView, NotrView, M23ReadRouteService } from "./read-service";
import type { TransferNoticeService, TransferNoticeView } from "../services/transfer-notice-service";
import type { NoeExceptionReviewService } from "./noe-exception-review-service";

export type MedicareNoticeWorklistType = "noe" | "notr" | "transfer" | "cancellation";
export type MedicareNoticeNextAction = "open_notice" | "open_noe_exception_review" | "open_transfer_notice";
export type NoticeReadinessState = "ready" | "blocked" | "verification_required" | "not_applicable" | "unknown";
export interface NoticeReadinessCheck {
  readonly key: string;
  readonly state: NoticeReadinessState;
  readonly reasonCode: string | null;
  readonly message: string;
  readonly blockingStage: "render" | "dispatch" | "reconciliation" | null;
}
export interface MedicareNoticeWorkItem {
  readonly identity: { readonly type: MedicareNoticeWorklistType; readonly noticeId: string };
  readonly sourceEventType: string;
  readonly sourceEventId: string | null;
  readonly patientId: string;
  readonly admissionId: string;
  readonly providerEntityId: string;
  readonly eventDate: string;
  readonly deadline: { readonly dueDate: string | null; readonly risk: string; readonly basis: string };
  readonly lifecycle: string;
  readonly latestAttempt: { readonly submissionId: string; readonly outcome: string; readonly dispatchState: string } | null;
  readonly readiness: readonly NoticeReadinessCheck[];
  readonly macAcceptance: "verified" | "not_verified" | "unknown";
  readonly exceptionReview: null | {
    readonly status: string;
    readonly decisionProvenance: "operator_attested_document" | null;
    readonly updatedAt: string;
    readonly evidenceCount: number;
  };
  readonly nextActions: readonly MedicareNoticeNextAction[];
  readonly createdAt: string;
}

export interface MedicareNoticeWorklistFilter {
  readonly types?: readonly MedicareNoticeWorklistType[];
  readonly providerEntityId?: string;
  readonly patientId?: string;
  readonly admissionId?: string;
  readonly state?: string;
  readonly eventFrom?: string;
  readonly eventTo?: string;
  readonly deadlineRisk?: string;
  readonly readiness?: "blocked" | "verification_required" | "ready";
  readonly requiresAttention?: boolean;
  readonly exceptionReviewStatus?: string;
}
export interface MedicareNoticeWorklistResult {
  readonly items: readonly MedicareNoticeWorkItem[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  /** Independent dimensions over this list's common type/provider/patient/admission/state/date filters. */
  readonly counts: {
    readonly scope: "returned_page";
    readonly total: number;
    readonly requiresAttention: number;
    readonly deadlineApproaching: number;
    readonly overdue: number;
    readonly sourceValidationRequired: number;
    readonly heldByTransportCapability: number;
    readonly inDoubt: number;
    readonly awaitingMacEvidence: number;
    readonly verifiedMacAccepted: number;
    readonly exceptionReviewsPending: number;
    readonly dimensionsOverlap: true;
  };
}

export interface MedicareNoticeWorklistService {
  list(actor: M23ReadActor, filter: MedicareNoticeWorklistFilter, permittedTypes: readonly MedicareNoticeWorklistType[], cursor?: string, limit?: number): Promise<MedicareNoticeWorklistResult>;
}
export type ArtifactReadinessMetadata = { readonly state: "pending" | "finalized" | "corrupt"; readonly vendor: string };
export interface ArtifactReadinessReader {
  bySubmissionIds(actor: M23ReadActor, submissionIds: readonly string[]): Promise<ReadonlyMap<string, ArtifactReadinessMetadata>>;
}

/** Metadata-only projection; ciphertext and tenant DEKs are never read by the worklist. */
export function buildDrizzleArtifactReadinessReader(db: repositories.BillingDb): ArtifactReadinessReader {
  return {
    async bySubmissionIds(actor, submissionIds) {
      const ids = [...new Set(submissionIds)];
      if (!ids.length) return new Map();
      return withOrgContext(db, { organizationId: actor.organizationId, userId: actor.userId }, async (tx) => {
        const rows = await tx.select({ submissionId: schema.medicareNoticeRenderIdentity.submissionId,
          vendor: schema.medicareNoticeRenderIdentity.vendor, artifactState: schema.medicareNoticeRenderArtifact.state })
          .from(schema.medicareNoticeRenderIdentity)
          .leftJoin(schema.medicareNoticeRenderArtifact, and(
            eq(schema.medicareNoticeRenderArtifact.organizationId, schema.medicareNoticeRenderIdentity.organizationId),
            eq(schema.medicareNoticeRenderArtifact.renderIdentityId, schema.medicareNoticeRenderIdentity.id),
          ))
          .where(and(eq(schema.medicareNoticeRenderIdentity.organizationId, actor.organizationId), inArray(schema.medicareNoticeRenderIdentity.submissionId, ids)));
        return new Map(rows.map((row) => [row.submissionId, {
          state: row.artifactState === "finalized" ? "finalized" as const : row.artifactState === "corrupt" ? "corrupt" as const : "pending" as const,
          vendor: row.vendor,
        }]));
      });
    },
  };
}
type SourceAnchor = { readonly createdAt: string; readonly id: string };
type Cursor = { readonly v: 1; readonly q: string; readonly noe: SourceAnchor | null; readonly notr: SourceAnchor | null; readonly transfer: SourceAnchor | null };
const cursorPayload = (v: unknown): v is Cursor => {
  if (!v || typeof v !== "object") return false;
  const c = v as Partial<Cursor>;
  const isAnchor = (x: unknown): x is SourceAnchor | null => x === null || Boolean(x && typeof x === "object" && typeof (x as SourceAnchor).createdAt === "string" && typeof (x as SourceAnchor).id === "string");
  return c.v === 1 && typeof c.q === "string" && isAnchor(c.noe) && isAnchor(c.notr) && isAnchor(c.transfer);
};
const filterKey = (f: MedicareNoticeWorklistFilter): string => createHash("sha256").update(JSON.stringify({
  types: [...(f.types ?? ["noe", "notr", "transfer", "cancellation"])].sort(),
  providerEntityId: f.providerEntityId ?? null, patientId: f.patientId ?? null,
  admissionId: f.admissionId ?? null, state: f.state ?? null, eventFrom: f.eventFrom ?? null,
  eventTo: f.eventTo ?? null, deadlineRisk: f.deadlineRisk ?? null, readiness: f.readiness ?? null,
  requiresAttention: f.requiresAttention ?? null, exceptionReviewStatus: f.exceptionReviewStatus ?? null,
})).digest("hex");

function check(key: string, state: NoticeReadinessState, reasonCode: string | null, message: string, blockingStage: NoticeReadinessCheck["blockingStage"]): NoticeReadinessCheck {
  return { key, state, reasonCode, message, blockingStage };
}

function artifactCheck(submissionId: string | null, metadata?: ArtifactReadinessMetadata): NoticeReadinessCheck {
  if (!submissionId) return check("artifact", "unknown", "ARTIFACT_NOT_PREPARED", "No durable submission attempt is available to establish artifact readiness.", "render");
  if (!metadata) return check("artifact", "verification_required", "ARTIFACT_IDENTITY_NOT_FOUND", "No render identity metadata is visible for this submission in the current organization.", "dispatch");
  if (metadata.state === "pending") return check("artifact", "blocked", "ARTIFACT_NOT_FINALIZED", "Artifact preparation is incomplete.", "dispatch");
  if (metadata.state === "corrupt") return check("artifact", "blocked", "ARTIFACT_INTEGRITY_HOLD", "Artifact integrity is held for authorized investigation.", "dispatch");
  return check("artifact", "verification_required", "ARTIFACT_INTEGRITY_NOT_CHECKED", "An encrypted artifact is finalized, but this read does not decrypt or verify its bytes.", "dispatch");
}

function transportCheck(vendor?: string): NoticeReadinessCheck {
  if (vendor === "claimmd" || vendor === "stedi") return check("transport", "blocked", "CH_NOT_WIRED", "This clearinghouse's hospice notice transaction support is not verified.", "dispatch");
  if (vendor === "direct_mac") return check("transport", "blocked", "M23_NOTICE_GATEWAY_ARTIFACT_CONTRACT_UNSUPPORTED", "Direct-MAC notice dispatch remains held pending gateway contract qualification.", "dispatch");
  return check("transport", "blocked", "NOTICE_TRANSPORT_UNSUPPORTED", "No qualified external Medicare notice transport is available.", "dispatch");
}

function fromNoe(v: NoeView, review?: { status: string; externalDecisionProvenance: "operator_attested_document" | null; updatedAt: string; evidenceDocumentIds: readonly string[] }, artifact?: ArtifactReadinessMetadata): MedicareNoticeWorkItem {
  const accepted = v.deadline.acceptance === "verified";
  const attempt = v.latestAttempt;
  return {
    identity: { type: "noe", noticeId: v.noeId }, sourceEventType: "election", sourceEventId: v.electionPeriodId,
    patientId: v.patientId, admissionId: v.admissionId, providerEntityId: v.providerEntityId,
    eventDate: v.electionEffectiveDate,
    deadline: { dueDate: v.deadline.dueDate, risk: v.deadline.risk, basis: v.deadline.basis },
    lifecycle: v.deadline.lifecycle,
    latestAttempt: attempt ? { submissionId: attempt.submissionId, outcome: attempt.outcome, dispatchState: attempt.dispatchState } : null,
    macAcceptance: v.deadline.acceptance,
    readiness: [
      check("source", "verification_required", "SOURCE_VALIDATION_NOT_RUN", "Source readiness requires the authorized notice validation; this read did not load protected beneficiary data.", "render"),
      check("provider_payer", "verification_required", "ROUTING_NOT_REVALIDATED", "Provider jurisdiction, payer route, EDI profile, account, and enrollment are not re-resolved by this read.", "dispatch"),
      check("transaction", "ready", null, "The persisted record is an implemented NOE transaction type.", null),
      check("rendering", "verification_required", "RENDER_VALIDATION_NOT_RUN", "Internal X12 rendering is available, but this read does not validate current builder inputs or render a payload.", "render"),
      artifactCheck(attempt?.submissionId ?? null, artifact),
      check("authorization", attempt ? "verification_required" : "unknown", attempt ? "SUBMISSION_APPROVAL_NOT_RECHECKED" : "SUBMISSION_NOT_AUTHORIZED", "This read does not create or renew submission authorization.", "dispatch"),
      transportCheck(artifact?.vendor),
      check("reconciliation", accepted ? "ready" : "verification_required", accepted ? null : "MAC_ACKNOWLEDGMENT_PENDING", accepted ? "MAC acceptance is supported by persisted acknowledgment evidence." : "A verified MAC acknowledgment is not recorded.", "reconciliation"),
    ],
    exceptionReview: review ? { status: review.status, decisionProvenance: review.externalDecisionProvenance, updatedAt: review.updatedAt, evidenceCount: review.evidenceDocumentIds.length } : null,
    nextActions: accepted ? ["open_notice"] : ["open_notice", "open_noe_exception_review"],
    createdAt: v.createdAt,
  };
}

function fromNotr(v: NotrView, artifact?: ArtifactReadinessMetadata): MedicareNoticeWorkItem {
  const accepted = v.deadline.acceptance === "verified";
  const attempt = v.latestAttempt;
  return {
    identity: { type: "notr", noticeId: v.notrId }, sourceEventType: v.triggerKind,
    sourceEventId: v.revocationEventId ?? v.dischargeEventId ?? v.transferEventId,
    patientId: v.patientId, admissionId: v.admissionId, providerEntityId: v.providerEntityId,
    eventDate: v.effectiveEndDate,
    deadline: { dueDate: v.deadline.dueDate, risk: v.deadline.risk, basis: v.deadline.basis },
    lifecycle: v.deadline.lifecycle,
    latestAttempt: attempt ? { submissionId: attempt.submissionId, outcome: attempt.outcome, dispatchState: attempt.dispatchState } : null,
    macAcceptance: v.deadline.acceptance,
    readiness: [
      check("source", "verification_required", "SOURCE_VALIDATION_NOT_RUN", "Source readiness requires authorized validation of the discharge or revocation event.", "render"),
      check("provider_payer", "verification_required", "ROUTING_NOT_REVALIDATED", "Provider jurisdiction, payer route, EDI profile, account, and enrollment are not re-resolved by this read.", "dispatch"),
      check("transaction", v.triggerKind === "transfer_out" ? "blocked" : "ready", v.triggerKind === "transfer_out" ? "TRANSFER_IS_NOT_NOTR" : null, v.triggerKind === "transfer_out" ? "A transfer-out event is not an ordinary NOTR workflow." : "The persisted record uses a supported NOTR trigger type.", v.triggerKind === "transfer_out" ? "render" : null),
      check("rendering", "verification_required", "RENDER_VALIDATION_NOT_RUN", "Internal X12 rendering is available, but this read does not validate current builder inputs or render a payload.", "render"),
      artifactCheck(attempt?.submissionId ?? null, artifact),
      check("authorization", attempt ? "verification_required" : "unknown", attempt ? "SUBMISSION_APPROVAL_NOT_RECHECKED" : "SUBMISSION_NOT_AUTHORIZED", "This read does not create or renew submission authorization.", "dispatch"),
      transportCheck(artifact?.vendor),
      check("reconciliation", accepted ? "ready" : "verification_required", accepted ? null : "MAC_ACKNOWLEDGMENT_PENDING", accepted ? "MAC acceptance is supported by persisted acknowledgment evidence." : "A verified MAC acknowledgment is not recorded.", "reconciliation"),
    ],
    exceptionReview: null,
    nextActions: ["open_notice"],
    createdAt: v.createdAt,
  };
}

function fromTransfer(v: TransferNoticeView, artifact?: ArtifactReadinessMetadata): MedicareNoticeWorkItem {
  const cancellation = v.action === "void";
  const accepted = v.state === "ack_accepted";
  return {
    identity: { type: cancellation ? "cancellation" : "transfer", noticeId: v.transferNoticeId },
    sourceEventType: cancellation ? "transfer_notice_cancellation" : "transfer_in",
    sourceEventId: v.transferEventId,
    patientId: v.patientId, admissionId: v.admissionId, providerEntityId: v.providerEntityId,
    eventDate: v.statementFromDate,
    deadline: { dueDate: null, risk: "not_applicable", basis: cancellation ? "CMS Chapter 11 §20.1.4; no generic five-day deadline applies." : "CMS Chapter 11 §20.1.3; no generic five-day deadline applies." },
    lifecycle: v.latestSubmissionDispatchState === "in_doubt" ? "outcome_unknown" : v.state.toLowerCase(),
    latestAttempt: v.latestSubmissionId && v.latestSubmissionOutcome ? { submissionId: v.latestSubmissionId, outcome: v.latestSubmissionOutcome, dispatchState: v.latestSubmissionDispatchState ?? "unknown" } : null,
    macAcceptance: accepted ? "verified" : "not_verified",
    readiness: [
      check("source", v.blockers.length ? "blocked" : "verification_required", v.blockers.length ? "TRANSFER_SOURCE_BLOCKED" : "SOURCE_VALIDATION_NOT_RUN", v.blockers.length ? "Transfer-specific source prerequisites remain blocked." : "Transfer source validation is not repeated by this read.", "render"),
      check("provider_payer", "verification_required", "ROUTING_NOT_REVALIDATED", "Provider jurisdiction, payer route, EDI profile, account, and enrollment are not re-resolved by this read.", "dispatch"),
      check("transaction", "ready", null, cancellation ? "This is the supported transfer-cancellation transaction, not an ordinary transfer." : "This is a persisted transfer notice transaction.", null),
      check("rendering", "verification_required", "RENDER_VALIDATION_NOT_RUN", "Internal X12 rendering is available, but this read does not validate current builder inputs or render a payload.", "render"),
      artifactCheck(v.latestSubmissionId, artifact),
      check("authorization", v.latestSubmissionId ? "verification_required" : "unknown", v.latestSubmissionId ? "SUBMISSION_APPROVAL_NOT_RECHECKED" : "SUBMISSION_NOT_AUTHORIZED", "This read does not create or renew submission authorization.", "dispatch"),
      transportCheck(artifact?.vendor),
      check("reconciliation", accepted ? "ready" : "verification_required", accepted ? null : "MAC_ACKNOWLEDGMENT_PENDING", accepted ? "Existing transfer notice state records MAC acceptance." : "Verified MAC acceptance is not recorded.", "reconciliation"),
    ],
    exceptionReview: null,
    nextActions: ["open_transfer_notice"],
    createdAt: v.createdAt,
  };
}

function matches(item: MedicareNoticeWorkItem, filter: MedicareNoticeWorklistFilter): boolean {
  if (filter.types?.length && !filter.types.includes(item.identity.type)) return false;
  if (filter.eventFrom && item.eventDate < filter.eventFrom) return false;
  if (filter.eventTo && item.eventDate > filter.eventTo) return false;
  if (filter.deadlineRisk && item.deadline.risk !== filter.deadlineRisk) return false;
  if (filter.readiness && !item.readiness.some((c) => c.state === filter.readiness)) return false;
  if (filter.requiresAttention && !["overdue", "approaching", "due_today", "transport_rejected", "outcome_unknown", "filing_timeliness_unknown"].includes(item.deadline.risk) && !item.readiness.some((c) => c.state === "blocked")) return false;
  if (filter.exceptionReviewStatus && item.exceptionReview?.status !== filter.exceptionReviewStatus) return false;
  return true;
}

function compare(a: MedicareNoticeWorkItem, b: MedicareNoticeWorkItem): number {
  return b.createdAt.localeCompare(a.createdAt) || a.identity.type.localeCompare(b.identity.type) || a.identity.noticeId.localeCompare(b.identity.noticeId);
}

/** Reuses the established per-type readers/deadline projections; the cursor stores independent source anchors to avoid cross-type ID collisions. */
export function buildMedicareNoticeWorklistService(deps: {
  readonly readService: M23ReadRouteService;
  readonly transferNoticeService: TransferNoticeService;
  readonly exceptionReviews?: Pick<NoeExceptionReviewService, "summaries">;
  readonly artifactReadiness?: ArtifactReadinessReader;
  readonly pageSize?: number;
}): MedicareNoticeWorklistService {
  const pageSize = Math.min(Math.max(deps.pageSize ?? 50, 1), 100);
  return {
    async list(actor, filter, permittedTypes, rawCursor, requestedLimit) {
      const limit = Math.min(Math.max(requestedLimit ?? pageSize, 1), 100);
      const effectiveFilter = { ...filter, types: filter.types?.filter((t) => permittedTypes.includes(t)) ?? permittedTypes };
      if (effectiveFilter.types.length === 0) throw new ForbiddenError("notice read permission is required");
      const q = filterKey(effectiveFilter);
      let sourceCursors: { noe: SourceAnchor | null; notr: SourceAnchor | null; transfer: SourceAnchor | null } = { noe: null, notr: null, transfer: null };
      if (rawCursor) {
        const decoded = decodeCursor(actor.organizationId, rawCursor, cursorPayload);
        if (!decoded || decoded.q !== q) throw new ForbiddenError("worklist cursor does not match this filter set");
        sourceCursors = { noe: decoded.noe, notr: decoded.notr, transfer: decoded.transfer };
      }
      const allowed = new Set(effectiveFilter.types);
      const all: MedicareNoticeWorkItem[] = [];
      const consumed: typeof sourceCursors = { ...sourceCursors };
      let reachedPageBoundary = false;
      let boundaryHasMore = false;
      let exhausted = { noe: !allowed.has("noe"), notr: !allowed.has("notr"), transfer: !allowed.has("transfer") && !allowed.has("cancellation") };
      // A bounded page per source is sufficient to determine the first global page. If selective filters
      // remove a whole round, advance those source cursors and fetch the next round (never scan unboundedly).
      for (let round = 0; round < 20 && all.length <= limit; round++) {
        const [noes, notrs, transfers] = await Promise.all([
          exhausted.noe ? null : deps.readService.listNoes(actor, { providerEntityId: filter.providerEntityId, patientId: filter.patientId, admissionId: filter.admissionId, state: filter.state as never }, sourceCursors.noe ? encodeDomainCursor(actor.organizationId, sourceCursors.noe) : undefined, 100),
          exhausted.notr ? null : deps.readService.listNotrs(actor, { providerEntityId: filter.providerEntityId, patientId: filter.patientId, admissionId: filter.admissionId, state: filter.state as never }, sourceCursors.notr ? encodeDomainCursor(actor.organizationId, sourceCursors.notr) : undefined, 100),
          exhausted.transfer ? null : deps.transferNoticeService.list(actor, { providerEntityId: filter.providerEntityId, patientId: filter.patientId, admissionId: filter.admissionId, state: filter.state as never }, sourceCursors.transfer ? encodeDomainCursor(actor.organizationId, sourceCursors.transfer) : undefined, 100),
        ]);
        const reviewMap = noes && deps.exceptionReviews
          ? await deps.exceptionReviews.summaries(actor, noes.items.map((item) => item.noeId))
          : new Map();
        const submissionIds = [
          ...(noes?.items.map((item) => item.latestSubmissionId).filter((id): id is string => id !== null) ?? []),
          ...(notrs?.items.map((item) => item.latestSubmissionId).filter((id): id is string => id !== null) ?? []),
          ...(transfers?.items.map((item) => item.latestSubmissionId).filter((id): id is string => id !== null) ?? []),
        ];
        const artifactMap = deps.artifactReadiness
          ? await deps.artifactReadiness.bySubmissionIds(actor, submissionIds)
          : new Map<string, ArtifactReadinessMetadata>();
        const roundItems = [
          ...(noes?.items.map((item) => fromNoe(item, reviewMap.get(item.noeId), item.latestSubmissionId ? artifactMap.get(item.latestSubmissionId) : undefined)) ?? []),
          ...(notrs?.items.map((item) => fromNotr(item, item.latestSubmissionId ? artifactMap.get(item.latestSubmissionId) : undefined)) ?? []),
          ...(transfers?.items.map((item) => fromTransfer(item, item.latestSubmissionId ? artifactMap.get(item.latestSubmissionId) : undefined)) ?? []),
        ].sort(compare);
        if (!roundItems.length) break;
        let cutoff = -1;
        let qualifyingCount = 0;
        for (let index = 0; index < roundItems.length; index++) {
          if (matches(roundItems[index]!, effectiveFilter)) qualifyingCount++;
          if (all.length + qualifyingCount >= limit) { cutoff = index; reachedPageBoundary = true; break; }
        }
        if (cutoff >= 0) {
          boundaryHasMore = roundItems.slice(cutoff + 1).some((item) => matches(item, effectiveFilter)) || Boolean(noes?.hasMore || notrs?.hasMore || transfers?.hasMore);
          for (const item of roundItems.slice(0, cutoff + 1)) {
            const anchor = { createdAt: item.createdAt, id: item.identity.noticeId };
            if (item.identity.type === "noe") consumed.noe = anchor;
            else if (item.identity.type === "notr") consumed.notr = anchor;
            else consumed.transfer = anchor;
          }
          all.push(...roundItems.slice(0, cutoff + 1).filter((item) => matches(item, effectiveFilter)));
          break;
        }
        all.push(...roundItems.filter((item) => matches(item, effectiveFilter)));
        const lastNoe = noes?.items.at(-1); if (lastNoe) consumed.noe = { createdAt: lastNoe.createdAt, id: lastNoe.noeId };
        const lastNotr = notrs?.items.at(-1); if (lastNotr) consumed.notr = { createdAt: lastNotr.createdAt, id: lastNotr.notrId };
        const lastTransfer = transfers?.items.at(-1); if (lastTransfer) consumed.transfer = { createdAt: lastTransfer.createdAt, id: lastTransfer.transferNoticeId };
        exhausted = { noe: exhausted.noe || !noes?.hasMore, notr: exhausted.notr || !notrs?.hasMore, transfer: exhausted.transfer || !transfers?.hasMore };
        if (exhausted.noe && exhausted.notr && exhausted.transfer) break;
      }
      all.sort(compare);
      const hasMore = reachedPageBoundary ? boundaryHasMore : !(exhausted.noe && exhausted.notr && exhausted.transfer);
      const items = all.slice(0, limit);
      const counts = {
        scope: "returned_page" as const,
        total: items.length, requiresAttention: items.filter((x) => matches(x, { requiresAttention: true })).length,
        deadlineApproaching: items.filter((x) => ["approaching", "due_today"].includes(x.deadline.risk)).length,
        overdue: items.filter((x) => x.deadline.risk === "overdue").length,
        sourceValidationRequired: items.filter((x) => x.readiness.some((c) => c.key === "source" && ["verification_required", "blocked"].includes(c.state))).length,
        heldByTransportCapability: items.filter((x) => x.readiness.some((c) => c.key === "transport" && c.state === "blocked")).length,
        inDoubt: items.filter((x) => x.lifecycle === "outcome_unknown").length,
        awaitingMacEvidence: items.filter((x) => x.latestAttempt !== null && x.macAcceptance !== "verified").length,
        verifiedMacAccepted: items.filter((x) => x.macAcceptance === "verified").length,
        exceptionReviewsPending: items.filter((x) => x.exceptionReview !== null && !["external_approved_recorded", "external_denied_recorded", "withdrawn"].includes(x.exceptionReview.status)).length,
        dimensionsOverlap: true as const,
      };
      const nextCursor = hasMore ? encodeCursor(actor.organizationId, { v: 1, q, ...consumed } satisfies Cursor) : null;
      return { items, nextCursor, hasMore, counts };
    },
  };
}
