// apps/backend/src/modules/29-external-interfaces/routes/store.ts — M29-T08 route-facing repo PORT + DTOs
// + in-memory impl.
//
// The data surface the §4.1 operator + §4.2 clinician routes compose over. Drizzle in prod
// (./store-drizzle.ts, org-scoped through `withOrgContext`); this in-memory implementation serves the
// route tests and any db-less boot. Both share the §2.2 FSM cores (`externalFeedTransition`,
// `externalFeedCoApprovalSatisfied`) and the T04 `decideProposal` decision core, so the two paths enforce
// the SAME dual-approval + propose-then-review rules — a test that passes here is testing the rule, not a
// second spelling of it.
//
// PHASE-1 POSTURE. Three surfaces need infrastructure no module binds yet and are honestly deferred with a
// typed 501: the compliance decrypt of a stored HL7 payload (needs the per-tenant DEK), and the manual
// bind / discard of an UNMATCHED lab result (materializing a `lab_observation` from a stored wire message —
// T-29.13). Every such route still walks the full guard + actor chain; only the effect is deferred.
import { randomUUID } from "node:crypto";

import {
  ConflictError,
  type ExternalFeedCredentialKind,
  type ExternalFeedKind,
  type ExternalFeedProtocol,
  type ExternalFeedStatus,
  ForbiddenError,
  type Hl7InboundParseStatus,
  type Hl7InboundProposalKind,
  type Hl7InboundProposalStatus,
  type Hl7OutboundStatus,
  type Hl7ProposalOwnerModule,
  type LabAbnormalFlag,
  type LabAbnormalSummary,
  NotFoundError,
  ValidationError,
  WardenXError,
} from "@wardenx/types";

import {
  canExternalFeedTransition,
  decideFeedRevokeStep,
  externalFeedCoApprovalSatisfied,
} from "../feed/lifecycle";
import type { UnmatchedReviewRefused } from "../inbound/unmatched-lab-review";
import {
  type UnmatchedLabQueueItem,
  planUnmatchedBind,
  planUnmatchedDiscard,
} from "../inbound/unmatched-lab-review";
import {
  ProposalAlreadyDecidedError,
  ProposalRejectRationaleRequiredError,
  type ProposalSnapshot,
  decideProposal,
} from "../proposals/decision";
import { decodeObservationCursor, encodeObservationCursor, isAfterCursor } from "./lab-list-scope";

// ── DTOs ──────────────────────────────────────────────────────────────────────────────────────────────

export interface FeedSummary {
  readonly id: string;
  readonly kind: ExternalFeedKind;
  readonly displayName: string;
  readonly status: ExternalFeedStatus;
  readonly protocol: ExternalFeedProtocol;
  readonly host: string | null;
  readonly port: number;
  readonly baaContractRef: string | null;
  readonly baaExpiresOn: string | null;
  readonly activeFrom: string | null;
  readonly createdAt: string;
}

export interface FeedDetail extends FeedSummary {
  readonly channelCertPin: string | null;
  readonly sendingFacilityAllowlist: readonly string[];
  readonly rateLimitMsgPerSec: number;
  /** F-181 — outbound routing + MSH identity (null when unset). */
  readonly labDestinationFacilityId: string | null;
  readonly mshSendingApplication: string | null;
  readonly mshSendingFacility: string | null;
  readonly mshReceivingApplication: string | null;
  readonly mshReceivingFacility: string | null;
  /** F-183 — the operator's statement that the receiver dedupes on MSH-10 (default false: a lost send is HELD,
   *  never auto-re-sent), and the feed's own `in_flight` lease in seconds (null = the platform default). */
  readonly receiverDedupesControlId: boolean;
  readonly inFlightLeaseSeconds: number | null;
  readonly proposedByMembershipId: string;
  readonly approvedByOpId: string | null;
  readonly approvedByComplId: string | null;
  readonly approvedAt: string | null;
  readonly revokedAt: string | null;
}

export interface CredentialSummary {
  readonly id: string;
  readonly feedId: string;
  readonly kind: ExternalFeedCredentialKind;
  /** sha256 first-8 hex for ops display — NEVER the ciphertext. */
  readonly fingerprint: string;
  readonly status: "active" | "retired";
  readonly rotatedAt: string;
  readonly createdAt: string;
}

export interface FeedHealthView {
  readonly feedId: string;
  readonly hourBucket: string;
  readonly listenerUpSeconds: number;
  readonly listenerDownSeconds: number;
  readonly inboundMessageCount: number;
  readonly outboundMessageCount: number;
  readonly ackAaCount: number;
  readonly ackAeCount: number;
  readonly ackArCount: number;
  readonly ackTimeoutCount: number;
  readonly parseErrorCount: number;
  readonly senderRejectedCount: number;
  readonly lastMessageAt: string | null;
}

export interface ProposalSummary {
  readonly id: string;
  readonly sourceMessageId: string;
  readonly resourceKind: string;
  readonly matchOutcome: string;
  readonly matchedPatientId: string | null;
  readonly ownerModule: Hl7ProposalOwnerModule;
  readonly proposalStatus: Hl7InboundProposalStatus;
  readonly proposedAt: string;
  readonly expiresAt: string;
}

export interface ProposalDetail extends ProposalSummary {
  readonly matchConfidence: number | null;
  readonly matchCandidateIds: readonly string[];
  readonly decidedByMembershipId: string | null;
  readonly decidedAt: string | null;
  readonly decisionRationale: string | null;
  readonly acceptedAggregateId: string | null;
}

export interface InboundMessageView {
  readonly id: string;
  readonly feedId: string;
  readonly messageType: string;
  readonly messageControlId: string;
  readonly payloadSha256: string;
  readonly parseStatus: Hl7InboundParseStatus;
  readonly sendingFacilityRawId: string;
  readonly matchedPatientId: string | null;
  readonly receivedAt: string;
}

export interface OutboundMessageView {
  readonly id: string;
  readonly feedId: string;
  readonly messageType: string;
  readonly messageControlId: string;
  readonly payloadSha256: string;
  readonly status: Hl7OutboundStatus;
  readonly sourceAggregateId: string;
  readonly ackStatus: string | null;
  readonly retryCount: number;
  readonly queuedAt: string;
  readonly transmittedAt: string | null;
}

export interface LabObservationValueView {
  readonly obxSetId: number;
  readonly loincCode: string;
  readonly loincDisplayText: string;
  readonly valueType: string;
  readonly numericValue: number | null;
  readonly stringValue: string | null;
  readonly units: string | null;
  readonly referenceRange: string | null;
  readonly abnormalFlag: LabAbnormalFlag | null;
}

export interface LabObservationSummary {
  readonly id: string;
  readonly patientId: string;
  readonly orderId: string | null;
  readonly loincCode: string;
  readonly loincDisplayText: string;
  readonly observationDate: string;
  readonly resultStatus: string;
  readonly abnormalSummary: LabAbnormalSummary;
  readonly attachedDocumentId: string | null;
  readonly receivedAt: string;
  /** GAP-152 - set once an RN acknowledges the abnormal flag (migration 0461); null until then. */
  readonly acknowledgedAt: string | null;
  readonly acknowledgedByMembershipId: string | null;
}

export interface LabObservationDetail extends LabObservationSummary {
  readonly values: readonly LabObservationValueView[];
}

export interface UnmatchedLabView {
  readonly id: string;
  readonly observationId: string;
  readonly sourceMessageId: string;
  readonly obrPlacerOrderNumber: string | null;
  readonly matchMethod: string;
  readonly candidatePatientId: string | null;
  readonly candidateMatchLevel: string | null;
  readonly createdAt: string;
  /**
   * The OBX rows persisted under the RESERVED observation id (GAP-044). §5.2.4 requires the reviewer's
   * detail panel to show the result — you cannot decide which patient a lab belongs to from an id and a
   * LOINC alone. Empty only for a result whose ORU carried no non-PDF OBX segments.
   */
  readonly values: readonly LabObservationValueView[];
}

/** The outcome of a §4.2 review decision — the route maps a refusal to its HTTP status. */
export interface UnmatchedReviewResult {
  readonly observationId: string;
  readonly resolution: "manually_matched" | "discarded";
  readonly resolvedAt: string;
  readonly resolvedByMembershipId: string;
  /** The bound patient (bind only). */
  readonly patientId?: string;
}

export interface NppesProviderView {
  readonly npi: string;
  readonly enumerationType: string;
  readonly status: string;
  readonly basic: unknown;
  readonly addresses: unknown;
  readonly taxonomies: unknown;
  readonly deactivationDate: string | null;
  readonly lastUpdatedInNppes: string | null;
  readonly fetchedAt: string;
}

export interface SyncRunView {
  readonly id: string;
  readonly kind: string;
  readonly triggeredBy: string;
  readonly status: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly providersFetchedCount: number;
  readonly providersUpdatedCount: number;
  readonly providersDeactivatedCount: number;
  readonly errorsCount: number;
}

export interface FeedHealthAggregate {
  readonly feedCount: number;
  readonly activeFeedCount: number;
  readonly listenersUp: number;
  readonly listenersDown: number;
  readonly inboundMessageCount: number;
  readonly outboundMessageCount: number;
  readonly parseErrorCount: number;
}

export interface ListenerStatusView {
  readonly feedId: string;
  readonly displayName: string;
  readonly status: ExternalFeedStatus;
  readonly listenerUp: boolean;
  readonly lastMessageAt: string | null;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

// ── query shapes ────────────────────────────────────────────────────────────────────────────────────

export interface FeedListFilter {
  readonly kind?: ExternalFeedKind;
  readonly status?: ExternalFeedStatus;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface ProposalListFilter {
  readonly status?: Hl7InboundProposalStatus;
  readonly ownerModule?: Hl7ProposalOwnerModule;
  readonly feedId?: string;
  readonly proposedForPatientId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface InboundMessageFilter {
  readonly feedId?: string;
  readonly messageType?: string;
  readonly messageControlId?: string;
  readonly parseStatus?: Hl7InboundParseStatus;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface OutboundMessageFilter {
  readonly feedId?: string;
  readonly placerOrderNumber?: string;
  readonly status?: Hl7OutboundStatus;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface ObservationListFilter {
  readonly patientId?: string;
  readonly loincCode?: string;
  readonly abnormalFlag?: LabAbnormalFlag;
  readonly caseloadPatientIds?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string;
}

export interface CreateFeedArgs {
  readonly kind: ExternalFeedKind;
  readonly displayName: string;
  readonly host?: string;
  readonly port: number;
  readonly protocol: ExternalFeedProtocol;
  readonly channelCertPin?: string;
  readonly sendingFacilityAllowlist?: readonly string[];
  readonly baaContractRef?: string;
  readonly baaExpiresOn?: string;
  readonly rateLimitMsgPerSec?: number;
  readonly labDestinationFacilityId?: string;
  readonly mshSendingApplication?: string;
  readonly mshSendingFacility?: string;
  readonly mshReceivingApplication?: string;
  readonly mshReceivingFacility?: string;
  readonly receiverDedupesControlId?: boolean;
  readonly inFlightLeaseSeconds?: number;
}
export interface UpdateFeedArgs {
  readonly displayName?: string;
  readonly host?: string;
  readonly channelCertPin?: string;
  readonly sendingFacilityAllowlist?: readonly string[];
  readonly baaContractRef?: string;
  readonly baaExpiresOn?: string;
  readonly rateLimitMsgPerSec?: number;
  readonly labDestinationFacilityId?: string;
  readonly mshSendingApplication?: string;
  readonly mshSendingFacility?: string;
  readonly mshReceivingApplication?: string;
  readonly mshReceivingFacility?: string;
  readonly receiverDedupesControlId?: boolean;
  /** `null` clears the per-feed lease back to the platform default. */
  readonly inFlightLeaseSeconds?: number | null;
}

/** The route-facing repo the §4.1/§4.2 routes run against. Every method is org-scoped by its first arg. */
export interface M29Store {
  // feeds
  listFeeds(orgId: string, filter: FeedListFilter): Promise<Page<FeedSummary>>;
  getFeed(orgId: string, feedId: string): Promise<FeedDetail | null>;
  createFeed(orgId: string, membershipId: string, args: CreateFeedArgs): Promise<FeedDetail>;
  updateFeed(
    orgId: string,
    membershipId: string,
    feedId: string,
    args: UpdateFeedArgs,
  ): Promise<FeedDetail>;
  activateFeed(orgId: string, membershipId: string, feedId: string): Promise<FeedDetail>;
  suspendFeed(
    orgId: string,
    membershipId: string,
    feedId: string,
    reason: string,
  ): Promise<FeedDetail>;
  revokeFeed(
    orgId: string,
    membershipId: string,
    feedId: string,
    args: { reason: string },
  ): Promise<FeedDetail>;
  listCredentials(orgId: string, feedId: string): Promise<readonly CredentialSummary[]>;
  mintCredential(
    orgId: string,
    membershipId: string,
    feedId: string,
    args: { kind: ExternalFeedCredentialKind; secret: string },
  ): Promise<CredentialSummary>;
  getFeedHealth(orgId: string, feedId: string): Promise<FeedHealthView | null>;
  // proposals
  listProposals(orgId: string, filter: ProposalListFilter): Promise<Page<ProposalSummary>>;
  getProposal(orgId: string, proposalId: string): Promise<ProposalDetail | null>;
  acceptProposal(
    orgId: string,
    membershipId: string,
    proposalId: string,
    args: { decisionNote?: string; acceptedAggregateId?: string },
  ): Promise<ProposalDetail>;
  rejectProposal(
    orgId: string,
    membershipId: string,
    proposalId: string,
    rationale: string,
  ): Promise<ProposalDetail>;
  deferProposal(
    orgId: string,
    membershipId: string,
    proposalId: string,
    note?: string,
  ): Promise<ProposalDetail>;
  // messages
  listInboundMessages(
    orgId: string,
    filter: InboundMessageFilter,
  ): Promise<Page<InboundMessageView>>;
  getInboundMessage(orgId: string, messageId: string): Promise<InboundMessageView | null>;
  replayInboundMessage(
    orgId: string,
    membershipId: string,
    messageId: string,
  ): Promise<InboundMessageView>;
  listOutboundMessages(
    orgId: string,
    filter: OutboundMessageFilter,
  ): Promise<Page<OutboundMessageView>>;
  getOutboundMessage(orgId: string, messageId: string): Promise<OutboundMessageView | null>;
  retryOutboundMessage(
    orgId: string,
    membershipId: string,
    messageId: string,
  ): Promise<OutboundMessageView>;
  // nppes
  getNppesProvider(npi: string): Promise<NppesProviderView | null>;
  listSyncRuns(filter: { limit?: number; cursor?: string }): Promise<Page<SyncRunView>>;
  // ops
  feedHealthAggregate(orgId: string): Promise<FeedHealthAggregate>;
  listenerStatus(orgId: string): Promise<readonly ListenerStatusView[]>;
  // labs
  listObservations(
    orgId: string,
    filter: ObservationListFilter,
  ): Promise<Page<LabObservationSummary>>;
  getObservation(orgId: string, observationId: string): Promise<LabObservationDetail | null>;
  /**
   * GAP-152 - persist the RN's acknowledgement of an abnormal result (stamped once; a repeat is a no-op that
   * returns the stored acknowledgement) and emit `m29.lab_observation.abnormal_acknowledged` so M36 clears
   * the abnormal-flag alert badge. Returns null when the observation does not exist in the org.
   */
  acknowledgeAbnormalObservation(
    orgId: string,
    membershipId: string,
    observationId: string,
  ): Promise<{
    readonly acknowledgedAt: string;
    readonly acknowledgedByMembershipId: string;
  } | null>;
  listUnmatchedObservations(
    orgId: string,
    filter: { limit?: number; cursor?: string },
  ): Promise<Page<UnmatchedLabView>>;
  /**
   * GAP-044 — bind an unmatched result to a patient: materialize the deferred `lab_observation` parent
   * under the reserved id, flip the link to `manual`, stamp the reviewer, emit
   * `m29.lab_observation.manually_matched`. All in ONE transaction.
   */
  bindUnmatchedObservation(
    orgId: string,
    membershipId: string,
    observationId: string,
    args: { patientId: string; note?: string },
  ): Promise<UnmatchedReviewResult>;
  /**
   * GAP-044 — discard an unmatched result: soft-tombstone the link row with a ≥10-char reason (§5.2.4),
   * emit `m29.lab_observation.discarded`. The link + its value rows are RETAINED (§8, 180 days); they
   * simply stop surfacing in the queue.
   */
  discardUnmatchedObservation(
    orgId: string,
    membershipId: string,
    observationId: string,
    args: { reason: string },
  ): Promise<UnmatchedReviewResult>;
}

/** Thrown for a Phase-1-deferred surface — mapped to a 501 by the route (honest "not yet", not a 404). */
export class M29StoreError extends WardenXError {
  constructor(message: string, statusCode = 501) {
    super("NOT_IMPLEMENTED", message, statusCode);
    this.name = "M29StoreError";
  }
}

/**
 * The narrow M5 read the manual bind needs — structurally a subset of the `PatientReader` seam M29 already
 * consumes for the match cascade. Declared here so the store takes no seam-registry import; the
 * composition root passes `getPatientReader()` straight in.
 */
export interface M29BindPatientResolver {
  findById(input: {
    organizationId: string;
    id: string;
  }): Promise<{ readonly id: string; readonly providerEntityId?: string | null } | null>;
}

/**
 * Map a pure review refusal to its wire error. Shared by both store implementations so the in-memory
 * route tests exercise the SAME status codes production returns.
 */
export function throwReviewRefusal(refusal: UnmatchedReviewRefused): never {
  switch (refusal.reason) {
    case "already_resolved":
    case "not_an_unmatched_result":
    case "no_result_values":
      throw new ConflictError(refusal.message);
    case "reason_too_short":
      throw new ValidationError(refusal.message, [
        { field: "reason", code: "TOO_SHORT", message: refusal.message },
      ]);
    case "patient_not_found":
      throw new ValidationError(refusal.message, [
        { field: "patientId", code: "NOT_FOUND", message: refusal.message },
      ]);
    case "patient_has_no_provider_entity":
      throw new ValidationError(refusal.message, [
        { field: "patientId", code: "NO_PROVIDER_ENTITY", message: refusal.message },
      ]);
  }
}

// ── in-memory implementation (route tests / db-less boot) ─────────────────────────────────────────────

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MemFeed = Mutable<FeedDetail>;
type MemCredential = Mutable<CredentialSummary>;
type MemProposal = Mutable<ProposalDetail>;

export interface InMemoryM29Seed {
  readonly feeds?: readonly Partial<MemFeed>[];
  readonly proposals?: readonly Partial<MemProposal>[];
  readonly observations?: readonly (Partial<LabObservationDetail> & { organizationId: string })[];
}

/** A seedable unmatched-lab queue item (the link row + its persisted OBX values). */
export type MemUnmatchedLab = UnmatchedLabQueueItem & {
  readonly obrPlacerOrderNumber: string | null;
};

/** A deterministic in-memory {@link M29Store} — the route/abac tests seed it and pin the clock. */
export function createInMemoryM29Store(
  opts: { now?: () => string; patients?: M29BindPatientResolver } = {},
): M29Store & {
  seedFeed(orgId: string, feed: Partial<MemFeed> & { id: string }): MemFeed;
  seedProposal(orgId: string, p: Partial<MemProposal> & { id: string }): MemProposal;
  seedObservation(orgId: string, o: Partial<LabObservationDetail> & { id: string }): void;
  seedUnmatched(orgId: string, u: Partial<MemUnmatchedLab> & { observationId: string }): void;
} {
  const now = opts.now ?? (() => new Date().toISOString());
  const feeds = new Map<string, MemFeed & { organizationId: string }>();
  const creds = new Map<string, MemCredential & { organizationId: string }>();
  /** feedId → the first approver of a pending dual-approval revoke (GAP-153). */
  const revokeRequesters = new Map<string, string>();
  const proposals = new Map<string, MemProposal & { organizationId: string }>();
  const observations = new Map<string, LabObservationDetail & { organizationId: string }>();
  const unmatched = new Map<
    string,
    { -readonly [K in keyof MemUnmatchedLab]: MemUnmatchedLab[K] }
  >();

  const feedDetailOf = (f: MemFeed): FeedDetail => ({ ...f });

  const requireFeed = (orgId: string, feedId: string): MemFeed & { organizationId: string } => {
    const f = feeds.get(feedId);
    if (!f || f.organizationId !== orgId) throw new NotFoundError("external_feed", feedId);
    return f;
  };
  const requireProposal = (
    orgId: string,
    proposalId: string,
  ): MemProposal & { organizationId: string } => {
    const p = proposals.get(proposalId);
    if (!p || p.organizationId !== orgId)
      throw new NotFoundError("hl7_inbound_proposal", proposalId);
    return p;
  };

  const snapshotOf = (p: MemProposal & { organizationId: string }): ProposalSnapshot => ({
    id: p.id,
    organizationId: p.organizationId,
    sourceMessageId: p.sourceMessageId,
    resourceKind: p.resourceKind as Hl7InboundProposalKind,
    ownerModule: p.ownerModule,
    matchedPatientId: p.matchedPatientId,
    proposalStatus: p.proposalStatus,
    proposedPatientCandidate: {},
  });

  const decide = (
    p: MemProposal & { organizationId: string },
    command: Parameters<typeof decideProposal>[1],
  ) => {
    try {
      return decideProposal(snapshotOf(p), command);
    } catch (e) {
      if (e instanceof ProposalAlreadyDecidedError) {
        throw new ConflictError(
          `proposal ${p.id} is ${p.proposalStatus} — decided-is-decided (§2.6)`,
        );
      }
      if (e instanceof ProposalRejectRationaleRequiredError) {
        throw new ValidationError("proposal rejection rationale too short", [
          { field: "rationale", code: "TOO_SHORT", message: `min ${e.minChars} chars (W-XI-04)` },
        ]);
      }
      throw e;
    }
  };

  const fp = (secret: string): string =>
    // deterministic ops-display fingerprint (never the ciphertext) — a real fingerprint is a sha256 prefix.
    Array.from(secret)
      .reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
      .toString(16)
      .padStart(8, "0")
      .slice(0, 8);

  function seedFeed(orgId: string, feed: Partial<MemFeed> & { id: string }): MemFeed {
    const created: MemFeed & { organizationId: string } = {
      organizationId: orgId,
      id: feed.id,
      kind: feed.kind ?? "adt_inbound",
      displayName: feed.displayName ?? "Seeded feed",
      status: feed.status ?? "proposed",
      protocol: feed.protocol ?? "mllp_tls",
      host: feed.host ?? null,
      port: feed.port ?? 6000,
      baaContractRef: feed.baaContractRef ?? null,
      baaExpiresOn: feed.baaExpiresOn ?? null,
      activeFrom: feed.activeFrom ?? null,
      createdAt: feed.createdAt ?? now(),
      channelCertPin: feed.channelCertPin ?? null,
      sendingFacilityAllowlist: feed.sendingFacilityAllowlist ?? [],
      rateLimitMsgPerSec: feed.rateLimitMsgPerSec ?? 50,
      labDestinationFacilityId: feed.labDestinationFacilityId ?? null,
      mshSendingApplication: feed.mshSendingApplication ?? null,
      mshSendingFacility: feed.mshSendingFacility ?? null,
      mshReceivingApplication: feed.mshReceivingApplication ?? null,
      mshReceivingFacility: feed.mshReceivingFacility ?? null,
      receiverDedupesControlId: feed.receiverDedupesControlId ?? false,
      inFlightLeaseSeconds: feed.inFlightLeaseSeconds ?? null,
      proposedByMembershipId: feed.proposedByMembershipId ?? "seed-op",
      approvedByOpId: feed.approvedByOpId ?? null,
      approvedByComplId: feed.approvedByComplId ?? null,
      approvedAt: feed.approvedAt ?? null,
      revokedAt: feed.revokedAt ?? null,
    };
    feeds.set(created.id, created);
    return created;
  }

  function seedProposal(orgId: string, p: Partial<MemProposal> & { id: string }): MemProposal {
    const created: MemProposal & { organizationId: string } = {
      organizationId: orgId,
      id: p.id,
      sourceMessageId: p.sourceMessageId ?? randomUUID(),
      resourceKind: p.resourceKind ?? "patient_demographic_update",
      matchOutcome: p.matchOutcome ?? "matched_single",
      matchedPatientId: p.matchedPatientId ?? null,
      ownerModule: p.ownerModule ?? "m5",
      proposalStatus: p.proposalStatus ?? "pending",
      proposedAt: p.proposedAt ?? now(),
      expiresAt: p.expiresAt ?? new Date(Date.parse(now()) + 72 * 3600_000).toISOString(),
      matchConfidence: p.matchConfidence ?? null,
      matchCandidateIds: p.matchCandidateIds ?? [],
      decidedByMembershipId: p.decidedByMembershipId ?? null,
      decidedAt: p.decidedAt ?? null,
      decisionRationale: p.decisionRationale ?? null,
      acceptedAggregateId: p.acceptedAggregateId ?? null,
    };
    proposals.set(created.id, created);
    return created;
  }

  function seedObservation(orgId: string, o: Partial<LabObservationDetail> & { id: string }): void {
    observations.set(o.id, {
      organizationId: orgId,
      id: o.id,
      patientId: o.patientId ?? randomUUID(),
      orderId: o.orderId ?? null,
      loincCode: o.loincCode ?? "2345-7",
      loincDisplayText: o.loincDisplayText ?? "Glucose",
      observationDate: o.observationDate ?? now(),
      resultStatus: o.resultStatus ?? "final",
      abnormalSummary: o.abnormalSummary ?? "all_normal",
      attachedDocumentId: o.attachedDocumentId ?? null,
      receivedAt: o.receivedAt ?? now(),
      acknowledgedAt: o.acknowledgedAt ?? null,
      acknowledgedByMembershipId: o.acknowledgedByMembershipId ?? null,
      values: o.values ?? [],
    });
  }

  function seedUnmatched(
    orgId: string,
    u: Partial<MemUnmatchedLab> & { observationId: string },
  ): void {
    unmatched.set(u.observationId, {
      linkId: u.linkId ?? randomUUID(),
      organizationId: orgId,
      observationId: u.observationId,
      sourceMessageId: u.sourceMessageId ?? randomUUID(),
      obrPlacerOrderNumber: u.obrPlacerOrderNumber ?? null,
      matchMethod: u.matchMethod ?? "unmatched",
      candidatePatientId: u.candidatePatientId ?? null,
      resolvedAt: u.resolvedAt ?? null,
      createdAt: u.createdAt ?? new Date(now()),
      values: u.values ?? [],
    });
  }

  const requireUnmatched = (orgId: string, observationId: string) => {
    const item = unmatched.get(observationId);
    if (!item || item.organizationId !== orgId) {
      throw new NotFoundError("lab_observation_inbound_link", observationId);
    }
    return item;
  };

  const page = <T>(items: readonly T[], limit?: number): Page<T> => ({
    items: items.slice(0, limit ?? 50),
  });

  return {
    seedFeed,
    seedProposal,
    seedObservation,
    seedUnmatched,

    async listFeeds(orgId, filter) {
      const items = [...feeds.values()]
        .filter((f) => f.organizationId === orgId)
        .filter((f) => (filter.kind ? f.kind === filter.kind : true))
        .filter((f) => (filter.status ? f.status === filter.status : true))
        .map(feedDetailOf);
      return page(items, filter.limit);
    },
    async getFeed(orgId, feedId) {
      const f = feeds.get(feedId);
      return f && f.organizationId === orgId ? feedDetailOf(f) : null;
    },
    async createFeed(orgId, membershipId, args) {
      const id = randomUUID();
      const ts = now();
      // Insert 'proposed' then submit to 'pending_approval' (operator proposal); a DISTINCT compliance
      // officer promotes to 'active' via activateFeed (D18 dual-approval).
      const created = seedFeed(orgId, {
        id,
        kind: args.kind,
        displayName: args.displayName,
        status: "pending_approval",
        protocol: args.protocol,
        host: args.host ?? null,
        port: args.port,
        baaContractRef: args.baaContractRef ?? null,
        baaExpiresOn: args.baaExpiresOn ?? null,
        channelCertPin: args.channelCertPin ?? null,
        sendingFacilityAllowlist: args.sendingFacilityAllowlist ?? [],
        rateLimitMsgPerSec: args.rateLimitMsgPerSec ?? 50,
        labDestinationFacilityId: args.labDestinationFacilityId ?? null,
        mshSendingApplication: args.mshSendingApplication ?? null,
        mshSendingFacility: args.mshSendingFacility ?? null,
        mshReceivingApplication: args.mshReceivingApplication ?? null,
        mshReceivingFacility: args.mshReceivingFacility ?? null,
        receiverDedupesControlId: args.receiverDedupesControlId ?? false,
        inFlightLeaseSeconds: args.inFlightLeaseSeconds ?? null,
        proposedByMembershipId: membershipId,
        approvedByOpId: membershipId,
        createdAt: ts,
      });
      return feedDetailOf(created);
    },
    async updateFeed(orgId, _membershipId, feedId, args) {
      const f = requireFeed(orgId, feedId);
      if (f.status === "revoked" || f.status === "rejected") {
        throw new ConflictError(`feed ${feedId} is ${f.status} — no further edits`);
      }
      Object.assign(f, {
        displayName: args.displayName ?? f.displayName,
        host: args.host ?? f.host,
        channelCertPin: args.channelCertPin ?? f.channelCertPin,
        sendingFacilityAllowlist: args.sendingFacilityAllowlist ?? f.sendingFacilityAllowlist,
        baaContractRef: args.baaContractRef ?? f.baaContractRef,
        baaExpiresOn: args.baaExpiresOn ?? f.baaExpiresOn,
        rateLimitMsgPerSec: args.rateLimitMsgPerSec ?? f.rateLimitMsgPerSec,
        labDestinationFacilityId: args.labDestinationFacilityId ?? f.labDestinationFacilityId,
        mshSendingApplication: args.mshSendingApplication ?? f.mshSendingApplication,
        mshSendingFacility: args.mshSendingFacility ?? f.mshSendingFacility,
        mshReceivingApplication: args.mshReceivingApplication ?? f.mshReceivingApplication,
        mshReceivingFacility: args.mshReceivingFacility ?? f.mshReceivingFacility,
        receiverDedupesControlId: args.receiverDedupesControlId ?? f.receiverDedupesControlId,
        inFlightLeaseSeconds:
          args.inFlightLeaseSeconds === undefined
            ? f.inFlightLeaseSeconds
            : args.inFlightLeaseSeconds,
      });
      return feedDetailOf(f);
    },
    async activateFeed(orgId, membershipId, feedId) {
      const f = requireFeed(orgId, feedId);
      if (!canExternalFeedTransition(f.status, "active")) {
        throw new ConflictError(`feed ${feedId} cannot activate from ${f.status}`);
      }
      if (f.status === "pending_approval") {
        if (!externalFeedCoApprovalSatisfied(f.approvedByOpId, membershipId)) {
          throw new ConflictError(
            "feed activation requires a compliance co-approver DISTINCT from the proposing operator (D18)",
          );
        }
        f.approvedByComplId = membershipId;
        f.approvedAt = now();
      }
      f.status = "active";
      f.activeFrom = now();
      return feedDetailOf(f);
    },
    async suspendFeed(orgId, _membershipId, feedId, _reason) {
      const f = requireFeed(orgId, feedId);
      if (!canExternalFeedTransition(f.status, "suspended")) {
        throw new ConflictError(`feed ${feedId} cannot suspend from ${f.status}`);
      }
      f.status = "suspended";
      return feedDetailOf(f);
    },
    async revokeFeed(orgId, membershipId, feedId, _args) {
      const f = requireFeed(orgId, feedId);
      if (!canExternalFeedTransition(f.status, "revoked")) {
        throw new ConflictError(`feed ${feedId} cannot revoke from ${f.status}`);
      }
      // GAP-153 / D20 — dual approval: the first call records the requester, a DISTINCT second completes.
      const step = decideFeedRevokeStep(revokeRequesters.get(feedId), membershipId);
      if (step === "self_approval") {
        throw new ForbiddenError("a feed revoke needs a second, distinct approver");
      }
      if (step === "request") {
        revokeRequesters.set(feedId, membershipId);
        return feedDetailOf(f);
      }
      f.status = "revoked";
      f.revokedAt = now();
      for (const c of creds.values()) {
        if (c.feedId === feedId && c.status === "active") c.status = "retired";
      }
      return feedDetailOf(f);
    },
    async listCredentials(orgId, feedId) {
      requireFeed(orgId, feedId);
      return [...creds.values()].filter((c) => c.organizationId === orgId && c.feedId === feedId);
    },
    async mintCredential(orgId, _membershipId, feedId, args) {
      requireFeed(orgId, feedId);
      // Rotation: retire the prior active credential of the same kind.
      for (const c of creds.values()) {
        if (c.organizationId === orgId && c.feedId === feedId && c.kind === args.kind) {
          (c as { status: "active" | "retired" }).status = "retired";
        }
      }
      const cred: MemCredential & { organizationId: string } = {
        organizationId: orgId,
        id: randomUUID(),
        feedId,
        kind: args.kind,
        fingerprint: fp(args.secret),
        status: "active",
        rotatedAt: now(),
        createdAt: now(),
      };
      creds.set(cred.id, cred);
      return cred;
    },
    async getFeedHealth(orgId, feedId) {
      requireFeed(orgId, feedId);
      return null; // no rollup rows in the in-memory store
    },

    async listProposals(orgId, filter) {
      const items = [...proposals.values()]
        .filter((p) => p.organizationId === orgId)
        .filter((p) => (filter.status ? p.proposalStatus === filter.status : true))
        .filter((p) => (filter.ownerModule ? p.ownerModule === filter.ownerModule : true))
        .filter((p) =>
          filter.proposedForPatientId ? p.matchedPatientId === filter.proposedForPatientId : true,
        );
      return page(items, filter.limit);
    },
    async getProposal(orgId, proposalId) {
      const p = proposals.get(proposalId);
      return p && p.organizationId === orgId ? { ...p } : null;
    },
    async acceptProposal(orgId, membershipId, proposalId, args) {
      const p = requireProposal(orgId, proposalId);
      const decidedAt = now();
      decide(p, {
        kind: "accept",
        decidedByMembershipId: membershipId,
        decidedAt: new Date(decidedAt),
        acceptedAggregateId: args.acceptedAggregateId,
        decisionRationale: args.decisionNote,
      });
      p.proposalStatus = "accepted";
      p.decidedByMembershipId = membershipId;
      p.decidedAt = decidedAt;
      p.decisionRationale = args.decisionNote?.trim() ? args.decisionNote.trim() : null;
      p.acceptedAggregateId = args.acceptedAggregateId ?? null;
      return { ...p };
    },
    async rejectProposal(orgId, membershipId, proposalId, rationale) {
      const p = requireProposal(orgId, proposalId);
      const decidedAt = now();
      decide(p, {
        kind: "reject",
        decidedByMembershipId: membershipId,
        decidedAt: new Date(decidedAt),
        decisionRationale: rationale,
      });
      p.proposalStatus = "rejected";
      p.decidedByMembershipId = membershipId;
      p.decidedAt = decidedAt;
      p.decisionRationale = rationale;
      return { ...p };
    },
    async deferProposal(orgId, _membershipId, proposalId, _note) {
      const p = requireProposal(orgId, proposalId);
      if (p.proposalStatus !== "pending") {
        throw new ConflictError(`proposal ${proposalId} is ${p.proposalStatus} — cannot defer`);
      }
      // Defer keeps status 'pending' (a caseload-RN task is a forward-seam to M19); nothing else changes.
      return { ...p };
    },

    async listInboundMessages() {
      return { items: [] };
    },
    async getInboundMessage() {
      return null;
    },
    async replayInboundMessage(orgId, _membershipId, messageId) {
      throw new NotFoundError("hl7_message_inbound", messageId);
    },
    async listOutboundMessages() {
      return { items: [] };
    },
    async getOutboundMessage() {
      return null;
    },
    async retryOutboundMessage(orgId, _membershipId, messageId) {
      throw new NotFoundError("hl7_message_outbound", messageId);
    },

    async getNppesProvider() {
      return null;
    },
    async listSyncRuns() {
      return { items: [] };
    },

    async feedHealthAggregate(orgId) {
      const orgFeeds = [...feeds.values()].filter((f) => f.organizationId === orgId);
      return {
        feedCount: orgFeeds.length,
        activeFeedCount: orgFeeds.filter((f) => f.status === "active").length,
        listenersUp: 0,
        listenersDown: 0,
        inboundMessageCount: 0,
        outboundMessageCount: 0,
        parseErrorCount: 0,
      };
    },
    async listenerStatus(orgId) {
      return [...feeds.values()]
        .filter((f) => f.organizationId === orgId)
        .map((f) => ({
          feedId: f.id,
          displayName: f.displayName,
          status: f.status,
          listenerUp: false,
          lastMessageAt: null,
        }));
    },

    async listObservations(orgId, filter) {
      const cursor = decodeObservationCursor(filter.cursor);
      const limit = filter.limit ?? 50;
      const rows = [...observations.values()]
        .filter((o) => o.organizationId === orgId)
        .filter((o) => (filter.patientId ? o.patientId === filter.patientId : true))
        .filter((o) => (filter.loincCode ? o.loincCode === filter.loincCode : true))
        .filter((o) =>
          filter.abnormalFlag ? o.values.some((v) => v.abnormalFlag === filter.abnormalFlag) : true,
        )
        .filter((o) =>
          filter.caseloadPatientIds ? filter.caseloadPatientIds.includes(o.patientId) : true,
        )
        .sort((a, b) =>
          Date.parse(a.observationDate) === Date.parse(b.observationDate)
            ? a.id < b.id
              ? 1
              : -1
            : Date.parse(b.observationDate) - Date.parse(a.observationDate),
        )
        .filter((o) => (cursor ? isAfterCursor(o.observationDate, o.id, cursor) : true));
      const pageRows = rows.slice(0, limit);
      const items = pageRows.map(
        (o): LabObservationSummary => ({
          id: o.id,
          patientId: o.patientId,
          orderId: o.orderId,
          loincCode: o.loincCode,
          loincDisplayText: o.loincDisplayText,
          observationDate: o.observationDate,
          resultStatus: o.resultStatus,
          abnormalSummary: o.abnormalSummary,
          attachedDocumentId: o.attachedDocumentId,
          receivedAt: o.receivedAt,
          acknowledgedAt: o.acknowledgedAt,
          acknowledgedByMembershipId: o.acknowledgedByMembershipId,
        }),
      );
      const last = pageRows[pageRows.length - 1];
      return rows.length > limit && last
        ? {
            items,
            nextCursor: encodeObservationCursor({
              d: new Date(last.observationDate).toISOString(),
              id: last.id,
            }),
          }
        : { items };
    },
    async getObservation(orgId, observationId) {
      const o = observations.get(observationId);
      return o && o.organizationId === orgId ? { ...o } : null;
    },
    async acknowledgeAbnormalObservation(orgId, membershipId, observationId) {
      const o = observations.get(observationId);
      if (!o || o.organizationId !== orgId) return null;
      const stored = o as {
        acknowledgedAt: string | null;
        acknowledgedByMembershipId: string | null;
      };
      if (stored.acknowledgedAt === null) {
        stored.acknowledgedAt = now();
        stored.acknowledgedByMembershipId = membershipId;
      }
      return {
        acknowledgedAt: stored.acknowledgedAt as string,
        acknowledgedByMembershipId: stored.acknowledgedByMembershipId ?? membershipId,
      };
    },
    async listUnmatchedObservations(orgId, filter) {
      const items = [...unmatched.values()]
        .filter((u) => u.organizationId === orgId && u.resolvedAt === null)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map(
          (u): UnmatchedLabView => ({
            id: u.linkId,
            observationId: u.observationId,
            sourceMessageId: u.sourceMessageId,
            obrPlacerOrderNumber: u.obrPlacerOrderNumber,
            matchMethod: u.matchMethod,
            candidatePatientId: u.candidatePatientId,
            candidateMatchLevel: null,
            createdAt: u.createdAt.toISOString(),
            values: u.values.map((v) => ({
              obxSetId: v.obxSetId,
              loincCode: v.loincCode,
              loincDisplayText: v.loincDisplayText,
              valueType: "ST",
              numericValue: null,
              stringValue: null,
              units: null,
              referenceRange: null,
              abnormalFlag: v.abnormalFlag,
            })),
          }),
        );
      return page(items, filter.limit);
    },

    async bindUnmatchedObservation(orgId, membershipId, observationId, args) {
      const item = requireUnmatched(orgId, observationId);
      const patient =
        (await opts.patients?.findById({ organizationId: orgId, id: args.patientId })) ?? null;
      if (patient === null) {
        throwReviewRefusal({
          kind: "refused",
          reason: "patient_not_found",
          message: `patient ${args.patientId} does not resolve in this tenant`,
        });
      }
      const decidedAt = new Date(now());
      const decision = planUnmatchedBind(item, {
        patient: { patientId: patient.id, providerEntityId: patient.providerEntityId ?? null },
        decidedByMembershipId: membershipId,
        ...(args.note === undefined ? {} : { note: args.note }),
        now: decidedAt,
      });
      if (decision.kind === "refused") throwReviewRefusal(decision);
      item.matchMethod = "manual";
      item.candidatePatientId = decision.linkPatch.candidatePatientId;
      item.resolvedAt = decidedAt;
      // The deferred parent materializes here too, so a bound result is immediately readable.
      seedObservation(orgId, {
        id: observationId,
        patientId: decision.linkPatch.candidatePatientId,
        loincCode: decision.observation.loincCode,
        loincDisplayText: decision.observation.loincDisplayText,
        abnormalSummary: decision.observation.abnormalSummary,
        observationDate: decision.observation.observationDate.toISOString(),
        receivedAt: decision.observation.receivedAt?.toISOString() ?? decidedAt.toISOString(),
      });
      return {
        observationId,
        resolution: "manually_matched",
        resolvedAt: decidedAt.toISOString(),
        resolvedByMembershipId: membershipId,
        patientId: decision.linkPatch.candidatePatientId,
      };
    },

    async discardUnmatchedObservation(orgId, membershipId, observationId, args) {
      const item = requireUnmatched(orgId, observationId);
      const decidedAt = new Date(now());
      const decision = planUnmatchedDiscard(item, {
        reason: args.reason,
        decidedByMembershipId: membershipId,
        now: decidedAt,
      });
      if (decision.kind === "refused") throwReviewRefusal(decision);
      item.resolvedAt = decidedAt;
      return {
        observationId,
        resolution: "discarded",
        resolvedAt: decidedAt.toISOString(),
        resolvedByMembershipId: membershipId,
      };
    },
  };
}
