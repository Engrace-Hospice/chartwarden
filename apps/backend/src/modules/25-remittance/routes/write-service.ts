// apps/backend/src/modules/25-remittance/routes/write-service.ts — the M25 WRITE route-service CONTRACT
// (§4.1 POST/PATCH surface). The Drizzle backend (./write-service-drizzle) implements this; every command
// runs under withOrgContext (RLS), validates the §2.2 state transition via the pure domain machines,
// version-checks the PATCH surfaces (§2.5), stamps the acting membership, and emits the §4.5 outbox event
// through the injected {@link WriteOutboxPort} in the SAME transaction (the D2 transactional-outbox posture;
// the composition root binds the live dispatcher port). A failed transition throws INVALID_TRANSITION; a
// stale version throws VERSION_CONFLICT; a missing row throws NOT_FOUND.
import type { M25WriteActor } from "./actor";

/** An outbox emission within the command's transaction. PHI-free payload by construction (§3.6). */
export interface OutboxEmission {
  readonly eventName: string;
  readonly payload: Record<string, unknown>;
}

/** The injected transactional-outbox port (the composition root binds the live M1 dispatcher). */
export interface WriteOutboxPort {
  emit(organizationId: string, emission: OutboxEmission): Promise<void>;
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
export interface DenialAssignInput {
  readonly assigneeMembershipId: string;
  readonly reason?: string;
}
export interface ReasonInput {
  readonly reason: string;
}
export interface AppealCreateInput {
  readonly tier?: "redetermination" | "reconsideration" | "alj" | "council" | "federal_court";
}
export interface AppealSubmitInput {
  readonly appealNarrative: string;
  readonly attachedDocumentIds: readonly string[];
}
export interface AppealDecideInput {
  readonly outcome: "favorable" | "partial" | "unfavorable";
  readonly decidedAt: string;
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
  manualMatch(actor: M25WriteActor, lineId: string, input: ManualMatchInput): Promise<void>;
  overrideAdjustment(actor: M25WriteActor, adjustmentId: string, input: AdjustmentOverrideInput): Promise<void>;

  assignDenial(actor: M25WriteActor, id: string, input: DenialAssignInput, ifMatch: number): Promise<VersionedResult>;
  startDenial(actor: M25WriteActor, id: string, ifMatch: number): Promise<VersionedResult>;
  escalateDenial(actor: M25WriteActor, id: string, input: ReasonInput, ifMatch: number): Promise<VersionedResult>;
  resolveDenial(actor: M25WriteActor, id: string, input: ReasonInput, ifMatch: number): Promise<VersionedResult>;
  closeDenial(actor: M25WriteActor, id: string, ifMatch: number): Promise<VersionedResult>;
  closeWriteOffDenial(actor: M25WriteActor, id: string, input: ReasonInput, ifMatch: number): Promise<VersionedResult>;
  reopenDenial(actor: M25WriteActor, id: string, input: ReasonInput, ifMatch: number): Promise<VersionedResult>;

  createAppeal(actor: M25WriteActor, denialCaseId: string, input: AppealCreateInput): Promise<VersionedResult>;
  attachAppealDocument(actor: M25WriteActor, id: string, documentId: string, ifMatch: number): Promise<VersionedResult>;
  submitAppeal(actor: M25WriteActor, id: string, input: AppealSubmitInput, ifMatch: number): Promise<VersionedResult>;
  ackAppeal(actor: M25WriteActor, id: string, ifMatch: number): Promise<VersionedResult>;
  decideAppeal(actor: M25WriteActor, id: string, input: AppealDecideInput, ifMatch: number): Promise<VersionedResult>;
  withdrawAppeal(actor: M25WriteActor, id: string, input: ReasonInput, ifMatch: number): Promise<VersionedResult>;
  closeAppeal(actor: M25WriteActor, id: string, ifMatch: number): Promise<VersionedResult>;

  editTaxonomyOverlay(actor: M25WriteActor, carcCode: string, input: TaxonomyOverlayInput, ifMatch: number): Promise<VersionedResult>;
}
