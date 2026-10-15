// apps/backend/src/modules/25-remittance/routes/write-service.ts — the M25 WRITE route-service CONTRACT
// (§4.1 POST/PATCH surface). The Drizzle backend (./write-service-drizzle) implements this; every command
// runs under withOrgContext (RLS), validates the §2.2 state transition via the pure domain machines,
// version-checks the PATCH surfaces (§2.5), stamps the acting membership, and emits the §4.5 outbox event
// through the injected {@link WriteOutboxPort} in the SAME transaction (the D2 transactional-outbox posture;
// the composition root binds the live dispatcher port). A failed transition throws INVALID_TRANSITION; a
// stale version throws VERSION_CONFLICT; a missing row throws NOT_FOUND.
import type { M25WriteActor } from "./actor";

/** A §4.5 `m25.*` transactional-outbox emission. PHI-free payload by construction (§3.6). */
export interface OutboxEmission {
  readonly eventName: string;
  readonly payload: Record<string, unknown>;
  readonly organizationId: string;
  /** The aggregate the event is about (the dispatcher's routing key). */
  readonly aggregateKind: string;
  readonly aggregateId: string;
}

/**
 * The §4.5 transactional-outbox port (the composition root binds the catalog-validating M1 publisher pinned
 * to callerModule `m25`). `publish` writes the `outbox_event` row on the CALLER'S tx so it commits in the
 * SAME unit of work as the mutation (the D2 outbox-only posture); the dispatcher Value.Check's the payload
 * against the registered catalog schema. Best-effort / optional — a no-op default until the publisher binds.
 */
export interface WriteOutboxPort {
  publish(tx: unknown, emission: OutboxEmission): Promise<void>;
}

/** The result of a versioned command: the new version (for the client's next If-Match). */
export interface VersionedResult {
  readonly id: string;
  readonly version: number;
}

export interface ManualMatchInput {
  readonly proposedClaimId: string;
  readonly reason: string;
}
export interface AdjustmentOverrideInput {
  readonly newPostAction: "auto_posted" | "ledger_recorded" | "denial_seeded";
  readonly reason: string;
}
/** The post-command match state (`posted` / `reversed`, or the stored state on an idempotent replay). */
export interface ManualMatchResult {
  readonly matchState: string;
}
export interface AdjustmentOverrideResult {
  readonly postAction: AdjustmentOverrideInput["newPostAction"];
}
export interface DenialAssignInput {
  readonly assigneeMembershipId: string;
  readonly reason?: string;
}
export interface ReasonInput {
  readonly reason: string;
}
export interface AppealCreateInput {
  readonly tier?: "redetermination" | "reconsideration" | "alj" | "council" | "federal_court";
  /** YYYY-MM-DD printed on the notice the tier's clock runs from; inferred from the remittance / prior decision when absent. */
  readonly noticeDate?: string;
  /**
   * Milestone 3: the reason a person appeals a denial the routing rules send to a MAC reopening. Without it such a
   * denial refuses the appeal (409 ROUTE_IS_REOPENING); with it the appeal opens and the reason is recorded on the
   * appeal's first event. Ignored when the denial is not on a reopening route.
   */
  readonly routeOverrideReason?: string;
}
export interface AppealSubmitInput {
  readonly appealNarrative: string;
  readonly attachedDocumentIds: readonly string[];
  /** An existing M22 document the biller assembled as the medical-records bundle (validated like an enclosure). */
  readonly medicalRecordsBundleDocumentId?: string;
}
/** M25-F03 — a late good-cause filing: the normal submit input plus the documented justification (>= 40). */
export interface AppealLateGoodCauseInput extends AppealSubmitInput {
  readonly goodCauseJustification: string;
}
export interface AppealDecideInput {
  readonly outcome: "favorable" | "partial" | "unfavorable";
  readonly decidedAt: string;
  /** YYYY-MM-DD printed on the decision letter; the next tier's notice date. Defaults to the UTC date of `decidedAt`. */
  readonly decisionNoticeDate?: string;
  readonly macReferenceNumbers?: Record<string, string>;
  readonly reason: string;
}
export interface TaxonomyOverlayInput {
  readonly rarcCode?: string;
  readonly plainLanguageOverride?: string;
  readonly suggestedAction: string;
  readonly ownerRole: string;
  readonly severity: string;
}

/** The WRITE surface every M25 mutating route composes over. */
export interface M25WriteService {
  replayAdvice(actor: M25WriteActor, adviceId: string): Promise<void>;
  manualMatch(
    actor: M25WriteActor,
    lineId: string,
    input: ManualMatchInput,
  ): Promise<ManualMatchResult>;
  overrideAdjustment(
    actor: M25WriteActor,
    adjustmentId: string,
    input: AdjustmentOverrideInput,
  ): Promise<AdjustmentOverrideResult>;

  assignDenial(
    actor: M25WriteActor,
    id: string,
    input: DenialAssignInput,
    ifMatch: number,
  ): Promise<VersionedResult>;
  startDenial(actor: M25WriteActor, id: string, ifMatch: number): Promise<VersionedResult>;
  escalateDenial(
    actor: M25WriteActor,
    id: string,
    input: ReasonInput,
    ifMatch: number,
  ): Promise<VersionedResult>;
  resolveDenial(
    actor: M25WriteActor,
    id: string,
    input: ReasonInput,
    ifMatch: number,
  ): Promise<VersionedResult>;
  closeDenial(actor: M25WriteActor, id: string, ifMatch: number): Promise<VersionedResult>;
  closeWriteOffDenial(
    actor: M25WriteActor,
    id: string,
    input: ReasonInput,
    ifMatch: number,
  ): Promise<VersionedResult>;
  reopenDenial(
    actor: M25WriteActor,
    id: string,
    input: ReasonInput,
    ifMatch: number,
  ): Promise<VersionedResult>;

  createAppeal(
    actor: M25WriteActor,
    denialCaseId: string,
    input: AppealCreateInput,
  ): Promise<VersionedResult>;
  attachAppealDocument(
    actor: M25WriteActor,
    id: string,
    documentId: string,
    ifMatch: number,
  ): Promise<VersionedResult>;
  submitAppeal(
    actor: M25WriteActor,
    id: string,
    input: AppealSubmitInput,
    ifMatch: number,
  ): Promise<VersionedResult>;
  /** M25-F03 — submit past T-0 marked `late_good_cause_filing` (redetermination / reconsideration only). */
  submitAppealLateGoodCause(
    actor: M25WriteActor,
    id: string,
    input: AppealLateGoodCauseInput,
    ifMatch: number,
  ): Promise<VersionedResult>;
  ackAppeal(actor: M25WriteActor, id: string, ifMatch: number): Promise<VersionedResult>;
  decideAppeal(
    actor: M25WriteActor,
    id: string,
    input: AppealDecideInput,
    ifMatch: number,
  ): Promise<VersionedResult>;
  withdrawAppeal(
    actor: M25WriteActor,
    id: string,
    input: ReasonInput,
    ifMatch: number,
  ): Promise<VersionedResult>;
  closeAppeal(actor: M25WriteActor, id: string, ifMatch: number): Promise<VersionedResult>;

  editTaxonomyOverlay(
    actor: M25WriteActor,
    carcCode: string,
    input: TaxonomyOverlayInput,
    ifMatch: number,
  ): Promise<VersionedResult>;
}
