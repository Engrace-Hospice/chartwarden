// apps/backend/src/modules/29-external-interfaces/routes/store-drizzle.ts — M29-T08 the PRODUCTION M29Store.
//
// The Drizzle-backed repo the §4.1/§4.2 routes run against. Every org-scoped statement opens `withOrgContext`
// so RLS scopes it to the acting org and the M4 write-audit trigger stamps the acting membership as the
// actor (`userId` carries the membership id on the write path — the M18/M28 idiom). The two platform-shared
// NPPES tables (`nppes_provider` / `nppes_sync_run`) are read WITHOUT an org context (they carry no
// `organization_id`; RLS grants read-all to `wardenx_app`).
//
// PHASE-1 CRYPTO POSTURE. No module binds a per-tenant DEK envelope yet, so a minted channel credential is
// stored as its sha256 DIGEST in the NOT-NULL `secret_cipher` with the `fingerprint` = the digest's first 8
// hex; the plaintext is never persisted in the clear and never returned (the M28 posture). The compliance
// decrypt route (§4.1.3) therefore fails closed with a typed 501 until the platform cipher lands.
import { createHash, randomUUID } from "node:crypto";

import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import {
  ConflictError,
  DegradedError,
  ForbiddenError,
  type Hl7InboundProposalKind,
  NotFoundError,
  ValidationError,
} from "@wardenx/types";
import { and, desc, eq, exists, inArray, isNull, lt, or, sql } from "drizzle-orm";

import {
  canExternalFeedTransition,
  decideFeedRevokeStep,
  externalFeedCoApprovalSatisfied,
} from "../feed/lifecycle";
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
import { decodeObservationCursor, encodeObservationCursor } from "./lab-list-scope";
import { throwReviewRefusal } from "./store";
import type {
  CredentialSummary,
  FeedDetail,
  FeedHealthAggregate,
  FeedHealthView,
  InboundMessageView,
  LabObservationDetail,
  LabObservationSummary,
  ListenerStatusView,
  M29BindPatientResolver,
  M29Store,
  NppesProviderView,
  OutboundMessageView,
  Page,
  ProposalDetail,
  SyncRunView,
  UnmatchedLabView,
  UnmatchedReviewResult,
} from "./store";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const num = (v: string | null): number | null => (v === null ? null : Number(v));

/**
 * The catalog-validating tx outbox publish port (structural — the M30/M33 `WriteOutboxPort`
 * precedent; M29 never imports the M1 bootstrap). The composition root binds
 * `bindCallerModule(txOutboxPublisher, "m29")`. UNBOUND, the §4.10 decision events are NOT
 * persisted — which was the task-11 gap: `decideProposal` has produced these envelopes since
 * M29-T04 and this store silently discarded them, so the M5/M6 accept consumers starved.
 */
export interface M29WriteOutboxPort {
  publish(
    tx: DbClient,
    input: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

export interface DrizzleM29StoreDeps {
  /** The §4.10 outbox publisher — accept/reject decision events ride the deciding tx. */
  readonly outbox?: M29WriteOutboxPort;
  /**
   * GAP-044 — the M5 `PatientReader` seam the manual unmatched-lab bind resolves its target through.
   * A THUNK is accepted so the composition root can pass `getPatientReader` before `wireModuleSeams()`
   * has run. UNBOUND ⇒ the bind refuses with a 503; every other route is unaffected.
   */
  readonly patients?: M29BindPatientResolver | (() => M29BindPatientResolver);
}

/** The fail-closed stand-in when no M5 reader is bound — a bind cannot invent an agency (ARCH-011). */
const UNBOUND_PATIENTS: M29BindPatientResolver = {
  findById() {
    return Promise.reject(
      new DegradedError(
        "M29_PATIENT_READER_UNBOUND",
        "the M5 PatientReader seam is not bound — an unmatched lab cannot be bound to a patient without resolving that patient's agency (ARCH-011)",
      ),
    );
  },
};

export function createDrizzleM29Store(db: DbClient, storeDeps: DrizzleM29StoreDeps = {}): M29Store {
  const patients: M29BindPatientResolver =
    typeof storeDeps.patients === "function"
      ? {
          findById: (input) =>
            (storeDeps.patients as () => M29BindPatientResolver)().findById(input),
        }
      : (storeDeps.patients ?? UNBOUND_PATIENTS);
  const FEED = schema.externalFeed;
  const CRED = schema.externalFeedCredential;
  const HEALTH = schema.externalFeedHealth;
  const PROPOSAL = schema.hl7InboundProposal;
  const INBOUND = schema.hl7MessageInbound;
  const OUTBOUND = schema.hl7MessageOutbound;
  const OBS = schema.labObservation;
  const OBS_VALUE = schema.labObservationValue;
  const OBS_LINK = schema.labObservationInboundLink;
  const NPPES = schema.nppesProvider;
  const SYNC = schema.nppesSyncRun;

  const ctx = (orgId: string, membershipId = "") => ({
    organizationId: orgId,
    userId: membershipId,
  });

  /**
   * Load one review-queue item (the link row + its persisted OBX values) WITHIN the caller's tx, so the
   * pure decision is made against the same snapshot the claiming UPDATE then races on. A missing row is a
   * 404, not a refusal — the reviewer asked about something that does not exist in this tenant.
   */
  async function loadQueueItem(
    tx: Tx,
    orgId: string,
    observationId: string,
  ): Promise<UnmatchedLabQueueItem> {
    const [link] = await tx
      .select()
      .from(OBS_LINK)
      .where(and(eq(OBS_LINK.organizationId, orgId), eq(OBS_LINK.observationId, observationId)))
      .limit(1);
    if (!link) throw new NotFoundError("lab_observation_inbound_link", observationId);
    const values = await tx
      .select()
      .from(OBS_VALUE)
      .where(and(eq(OBS_VALUE.organizationId, orgId), eq(OBS_VALUE.observationId, observationId)));
    return {
      linkId: link.id,
      organizationId: link.organizationId,
      observationId: link.observationId,
      sourceMessageId: link.sourceMessageId,
      matchMethod: link.matchMethod,
      candidatePatientId: link.candidatePatientId,
      resolvedAt: link.resolvedAt,
      createdAt: link.createdAt,
      values: values.map((v) => ({
        obxSetId: v.obxSetId,
        loincCode: v.loincCode,
        loincDisplayText: v.loincDisplayText,
        terminologyValidation: v.terminologyValidation,
        abnormalFlag: v.abnormalFlag,
        receivedAt: v.receivedAt,
      })),
    };
  }

  const feedDetail = (row: typeof FEED.$inferSelect): FeedDetail => ({
    id: row.id,
    kind: row.kind,
    displayName: row.displayName,
    status: row.status,
    protocol: row.protocol,
    host: row.host,
    port: row.port,
    baaContractRef: row.baaContractRef,
    baaExpiresOn: iso(row.baaExpiresOn),
    activeFrom: iso(row.activeFrom),
    createdAt: row.createdAt.toISOString(),
    channelCertPin: row.channelCertPin,
    sendingFacilityAllowlist: (row.sendingFacilityAllowlist as string[]) ?? [],
    rateLimitMsgPerSec: row.rateLimitMsgPerSec,
    labDestinationFacilityId: row.labDestinationFacilityId,
    mshSendingApplication: row.mshSendingApplication,
    mshSendingFacility: row.mshSendingFacility,
    mshReceivingApplication: row.mshReceivingApplication,
    mshReceivingFacility: row.mshReceivingFacility,
    receiverDedupesControlId: row.receiverDedupesControlId,
    inFlightLeaseSeconds: row.inFlightLeaseSeconds,
    proposedByMembershipId: row.proposedByMembershipId,
    approvedByOpId: row.approvedByOpId,
    approvedByComplId: row.approvedByComplId,
    approvedAt: iso(row.approvedAt),
    revokedAt: iso(row.revokedAt),
  });

  const proposalDetail = (row: typeof PROPOSAL.$inferSelect): ProposalDetail => ({
    id: row.id,
    sourceMessageId: row.sourceMessageId,
    resourceKind: row.resourceKind,
    matchOutcome: row.matchOutcome,
    matchedPatientId: row.matchedPatientId,
    ownerModule: row.ownerModule as ProposalDetail["ownerModule"],
    proposalStatus: row.proposalStatus,
    proposedAt: row.proposedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    matchConfidence: num(row.matchConfidence),
    matchCandidateIds: (row.matchCandidateIds as string[]) ?? [],
    decidedByMembershipId: row.decidedByMembershipId,
    decidedAt: iso(row.decidedAt),
    decisionRationale: row.decisionRationale,
    acceptedAggregateId: row.acceptedAggregateId,
  });

  const inboundView = (row: typeof INBOUND.$inferSelect): InboundMessageView => ({
    id: row.id,
    feedId: row.feedId,
    messageType: row.messageType,
    messageControlId: row.messageControlId,
    payloadSha256: row.payloadSha256,
    parseStatus: row.parseStatus,
    sendingFacilityRawId: row.sendingFacilityRawId,
    matchedPatientId: row.matchedPatientId,
    receivedAt: row.receivedAt.toISOString(),
  });

  const outboundView = (row: typeof OUTBOUND.$inferSelect): OutboundMessageView => ({
    id: row.id,
    feedId: row.feedId,
    messageType: row.messageType,
    messageControlId: row.messageControlId,
    payloadSha256: row.payloadSha256,
    status: row.status,
    sourceAggregateId: row.sourceAggregateId,
    ackStatus: row.ackStatus,
    retryCount: row.retryCount,
    queuedAt: row.queuedAt.toISOString(),
    transmittedAt: iso(row.transmittedAt),
  });

  const obsSummary = (row: typeof OBS.$inferSelect): LabObservationSummary => ({
    id: row.id,
    patientId: row.patientId,
    orderId: row.orderId,
    loincCode: row.loincCode,
    loincDisplayText: row.loincDisplayText,
    observationDate: row.observationDate.toISOString(),
    resultStatus: row.resultStatus,
    abnormalSummary: row.abnormalSummary,
    attachedDocumentId: row.attachedDocumentId,
    receivedAt: row.receivedAt.toISOString(),
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    acknowledgedByMembershipId: row.acknowledgedByMembershipId,
  });

  const nppesView = (row: typeof NPPES.$inferSelect): NppesProviderView => ({
    npi: row.npi,
    enumerationType: row.enumerationType,
    status: row.status,
    basic: row.basic,
    addresses: row.addresses,
    taxonomies: row.taxonomies,
    deactivationDate: row.deactivationDate,
    lastUpdatedInNppes: row.lastUpdatedInNppes,
    fetchedAt: row.fetchedAt.toISOString(),
  });

  const syncView = (row: typeof SYNC.$inferSelect): SyncRunView => ({
    id: row.id,
    kind: row.kind,
    triggeredBy: row.triggeredBy,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    completedAt: iso(row.completedAt),
    providersFetchedCount: row.providersFetchedCount,
    providersUpdatedCount: row.providersUpdatedCount,
    providersDeactivatedCount: row.providersDeactivatedCount,
    errorsCount: row.errorsCount,
  });

  const loadFeed = async (
    tx: Tx,
    orgId: string,
    feedId: string,
  ): Promise<typeof FEED.$inferSelect> => {
    const [row] = await tx
      .select()
      .from(FEED)
      .where(and(eq(FEED.id, feedId), eq(FEED.organizationId, orgId)))
      .limit(1);
    if (!row) throw new NotFoundError("external_feed", feedId);
    return row;
  };

  const translate = (e: unknown, id: string, status: string): never => {
    if (e instanceof ProposalAlreadyDecidedError) {
      throw new ConflictError(`proposal ${id} is ${status} — decided-is-decided (§2.6)`);
    }
    if (e instanceof ProposalRejectRationaleRequiredError) {
      throw new ValidationError("proposal rejection rationale too short", [
        { field: "rationale", code: "TOO_SHORT", message: `min ${e.minChars} chars (W-XI-04)` },
      ]);
    }
    throw e;
  };

  const snapshotOf = (row: typeof PROPOSAL.$inferSelect): ProposalSnapshot => ({
    id: row.id,
    organizationId: row.organizationId,
    sourceMessageId: row.sourceMessageId,
    resourceKind: row.resourceKind as Hl7InboundProposalKind,
    ownerModule: row.ownerModule as ProposalSnapshot["ownerModule"],
    matchedPatientId: row.matchedPatientId,
    proposalStatus: row.proposalStatus,
    proposedPatientCandidate: row.proposedPatientCandidate,
  });

  return {
    async listFeeds(orgId, filter) {
      return withOrgContext(db, ctx(orgId), async (tx): Promise<Page<FeedDetail>> => {
        const rows = await tx
          .select()
          .from(FEED)
          .where(eq(FEED.organizationId, orgId))
          .orderBy(desc(FEED.createdAt))
          .limit(filter.limit ?? 50);
        return {
          items: rows
            .filter((r) => (filter.kind ? r.kind === filter.kind : true))
            .filter((r) => (filter.status ? r.status === filter.status : true))
            .map(feedDetail),
        };
      });
    },
    async getFeed(orgId, feedId) {
      return withOrgContext(db, ctx(orgId), async (tx): Promise<FeedDetail | null> => {
        const [row] = await tx
          .select()
          .from(FEED)
          .where(and(eq(FEED.id, feedId), eq(FEED.organizationId, orgId)))
          .limit(1);
        return row ? feedDetail(row) : null;
      });
    },
    async createFeed(orgId, membershipId, args) {
      return withOrgContext(db, ctx(orgId, membershipId), async (tx): Promise<FeedDetail> => {
        const [row] = await tx
          .insert(FEED)
          .values({
            organizationId: orgId,
            kind: args.kind,
            displayName: args.displayName,
            host: args.host ?? null,
            port: args.port,
            protocol: args.protocol,
            channelCertPin: args.channelCertPin ?? null,
            sendingFacilityAllowlist: [...(args.sendingFacilityAllowlist ?? [])],
            baaContractRef: args.baaContractRef ?? null,
            baaExpiresOn: args.baaExpiresOn ? new Date(args.baaExpiresOn) : null,
            rateLimitMsgPerSec: args.rateLimitMsgPerSec ?? 50,
            labDestinationFacilityId: args.labDestinationFacilityId ?? null,
            mshSendingApplication: args.mshSendingApplication ?? null,
            mshSendingFacility: args.mshSendingFacility ?? null,
            mshReceivingApplication: args.mshReceivingApplication ?? null,
            mshReceivingFacility: args.mshReceivingFacility ?? null,
            receiverDedupesControlId: args.receiverDedupesControlId ?? false,
            inFlightLeaseSeconds: args.inFlightLeaseSeconds ?? null,
            // operator proposes + submits for co-approval in one act; a DISTINCT compliance officer activates.
            status: "pending_approval",
            proposedByMembershipId: membershipId,
            approvedByOpId: membershipId,
          })
          .returning();
        return feedDetail(row!);
      });
    },
    async updateFeed(orgId, membershipId, feedId, args) {
      return withOrgContext(db, ctx(orgId, membershipId), async (tx): Promise<FeedDetail> => {
        const feed = await loadFeed(tx, orgId, feedId);
        if (feed.status === "revoked" || feed.status === "rejected") {
          throw new ConflictError(`feed ${feedId} is ${feed.status} — no further edits`);
        }
        const [row] = await tx
          .update(FEED)
          .set({
            displayName: args.displayName ?? feed.displayName,
            host: args.host ?? feed.host,
            channelCertPin: args.channelCertPin ?? feed.channelCertPin,
            sendingFacilityAllowlist: args.sendingFacilityAllowlist
              ? [...args.sendingFacilityAllowlist]
              : (feed.sendingFacilityAllowlist as string[]),
            baaContractRef: args.baaContractRef ?? feed.baaContractRef,
            baaExpiresOn: args.baaExpiresOn ? new Date(args.baaExpiresOn) : feed.baaExpiresOn,
            rateLimitMsgPerSec: args.rateLimitMsgPerSec ?? feed.rateLimitMsgPerSec,
            labDestinationFacilityId:
              args.labDestinationFacilityId ?? feed.labDestinationFacilityId,
            mshSendingApplication: args.mshSendingApplication ?? feed.mshSendingApplication,
            mshSendingFacility: args.mshSendingFacility ?? feed.mshSendingFacility,
            mshReceivingApplication: args.mshReceivingApplication ?? feed.mshReceivingApplication,
            mshReceivingFacility: args.mshReceivingFacility ?? feed.mshReceivingFacility,
            receiverDedupesControlId:
              args.receiverDedupesControlId ?? feed.receiverDedupesControlId,
            // `null` is meaningful here (clear back to the platform default), so only `undefined` keeps the value.
            inFlightLeaseSeconds:
              args.inFlightLeaseSeconds === undefined
                ? feed.inFlightLeaseSeconds
                : args.inFlightLeaseSeconds,
            updatedAt: new Date(),
          })
          .where(and(eq(FEED.id, feedId), eq(FEED.organizationId, orgId)))
          .returning();
        return feedDetail(row!);
      });
    },
    async activateFeed(orgId, membershipId, feedId) {
      return withOrgContext(db, ctx(orgId, membershipId), async (tx): Promise<FeedDetail> => {
        const feed = await loadFeed(tx, orgId, feedId);
        if (!canExternalFeedTransition(feed.status, "active")) {
          throw new ConflictError(`feed ${feedId} cannot activate from ${feed.status}`);
        }
        const patch: Partial<typeof FEED.$inferInsert> = {
          status: "active",
          activeFrom: new Date(),
          updatedAt: new Date(),
        };
        if (feed.status === "pending_approval") {
          if (!externalFeedCoApprovalSatisfied(feed.approvedByOpId, membershipId)) {
            throw new ConflictError(
              "feed activation requires a compliance co-approver DISTINCT from the proposing operator (D18)",
            );
          }
          patch.approvedByComplId = membershipId;
          patch.approvedAt = new Date();
        }
        const [row] = await tx
          .update(FEED)
          .set(patch)
          .where(and(eq(FEED.id, feedId), eq(FEED.organizationId, orgId)))
          .returning();
        return feedDetail(row!);
      });
    },
    async suspendFeed(orgId, membershipId, feedId, _reason) {
      return withOrgContext(db, ctx(orgId, membershipId), async (tx): Promise<FeedDetail> => {
        const feed = await loadFeed(tx, orgId, feedId);
        if (!canExternalFeedTransition(feed.status, "suspended")) {
          throw new ConflictError(`feed ${feedId} cannot suspend from ${feed.status}`);
        }
        const [row] = await tx
          .update(FEED)
          .set({ status: "suspended", activeThrough: new Date(), updatedAt: new Date() })
          .where(and(eq(FEED.id, feedId), eq(FEED.organizationId, orgId)))
          .returning();
        return feedDetail(row!);
      });
    },
    async revokeFeed(orgId, membershipId, feedId, args) {
      return withOrgContext(db, ctx(orgId, membershipId), async (tx): Promise<FeedDetail> => {
        const feed = await loadFeed(tx, orgId, feedId);
        if (!canExternalFeedTransition(feed.status, "revoked")) {
          throw new ConflictError(`feed ${feedId} cannot revoke from ${feed.status}`);
        }
        // GAP-153 / D20 — dual approval held SERVER-SIDE: the first call stores the requester; only a
        // DIFFERENT membership completes the revoke (never a body-supplied "primary approver").
        const step = decideFeedRevokeStep(feed.revokeRequestedByMembershipId, membershipId);
        if (step === "self_approval") {
          throw new ForbiddenError("a feed revoke needs a second, distinct approver");
        }
        const where = and(eq(FEED.id, feedId), eq(FEED.organizationId, orgId));
        if (step === "request") {
          const [pending] = await tx
            .update(FEED)
            .set({
              revokeRequestedByMembershipId: membershipId,
              revokeRequestedAt: new Date(),
              revokeReason: args.reason,
              updatedAt: new Date(),
            })
            .where(where)
            .returning();
          return feedDetail(pending!);
        }
        const [row] = await tx
          .update(FEED)
          .set({ status: "revoked", revokedAt: new Date(), updatedAt: new Date() })
          .where(where)
          .returning();
        // Credential cascade: a revoked feed's channel secrets must stop working, not just its status.
        await tx
          .update(CRED)
          .set({ status: "retired" })
          .where(
            and(eq(CRED.feedId, feedId), eq(CRED.organizationId, orgId), eq(CRED.status, "active")),
          );
        return feedDetail(row!);
      });
    },
    async listCredentials(orgId, feedId) {
      return withOrgContext(db, ctx(orgId), async (tx): Promise<CredentialSummary[]> => {
        await loadFeed(tx, orgId, feedId);
        const rows = await tx
          .select()
          .from(CRED)
          .where(and(eq(CRED.feedId, feedId), eq(CRED.organizationId, orgId)))
          .orderBy(desc(CRED.rotatedAt));
        return rows.map((c) => ({
          id: c.id,
          feedId: c.feedId,
          kind: c.kind,
          fingerprint: c.fingerprint,
          status: c.status,
          rotatedAt: c.rotatedAt.toISOString(),
          createdAt: c.createdAt.toISOString(),
        }));
      });
    },
    async mintCredential(orgId, membershipId, feedId, args) {
      return withOrgContext(
        db,
        ctx(orgId, membershipId),
        async (tx): Promise<CredentialSummary> => {
          await loadFeed(tx, orgId, feedId);
          // Rotate: retire the prior active credential of the same kind.
          await tx
            .update(CRED)
            .set({ status: "retired" })
            .where(
              and(
                eq(CRED.feedId, feedId),
                eq(CRED.organizationId, orgId),
                eq(CRED.kind, args.kind),
                eq(CRED.status, "active"),
              ),
            );
          const digest = createHash("sha256").update(args.secret).digest("hex");
          const [row] = await tx
            .insert(CRED)
            .values({
              feedId,
              organizationId: orgId,
              kind: args.kind,
              // no DEK bound (Phase 1): the NOT-NULL cipher column carries the digest, never the plaintext.
              secretCipher: digest,
              fingerprint: digest.slice(0, 8),
              status: "active",
            })
            .returning();
          return {
            id: row!.id,
            feedId: row!.feedId,
            kind: row!.kind,
            fingerprint: row!.fingerprint,
            status: row!.status,
            rotatedAt: row!.rotatedAt.toISOString(),
            createdAt: row!.createdAt.toISOString(),
          };
        },
      );
    },
    async getFeedHealth(orgId, feedId) {
      return withOrgContext(db, ctx(orgId), async (tx): Promise<FeedHealthView | null> => {
        await loadFeed(tx, orgId, feedId);
        const [row] = await tx
          .select()
          .from(HEALTH)
          .where(and(eq(HEALTH.feedId, feedId), eq(HEALTH.organizationId, orgId)))
          .orderBy(desc(HEALTH.hourBucket))
          .limit(1);
        if (!row) return null;
        return {
          feedId: row.feedId,
          hourBucket: row.hourBucket.toISOString(),
          listenerUpSeconds: row.listenerUpSeconds,
          listenerDownSeconds: row.listenerDownSeconds,
          inboundMessageCount: row.inboundMessageCount,
          outboundMessageCount: row.outboundMessageCount,
          ackAaCount: row.ackAaCount,
          ackAeCount: row.ackAeCount,
          ackArCount: row.ackArCount,
          ackTimeoutCount: row.ackTimeoutCount,
          parseErrorCount: row.parseErrorCount,
          senderRejectedCount: row.senderRejectedCount,
          lastMessageAt: iso(row.lastMessageAt),
        };
      });
    },

    async listProposals(orgId, filter) {
      return withOrgContext(db, ctx(orgId), async (tx): Promise<Page<ProposalDetail>> => {
        const rows = await tx
          .select()
          .from(PROPOSAL)
          .where(eq(PROPOSAL.organizationId, orgId))
          .orderBy(desc(PROPOSAL.proposedAt))
          .limit(filter.limit ?? 50);
        return {
          items: rows
            .filter((r) => (filter.status ? r.proposalStatus === filter.status : true))
            .filter((r) => (filter.ownerModule ? r.ownerModule === filter.ownerModule : true))
            .filter((r) =>
              filter.proposedForPatientId
                ? r.matchedPatientId === filter.proposedForPatientId
                : true,
            )
            .map(proposalDetail),
        };
      });
    },
    async getProposal(orgId, proposalId) {
      return withOrgContext(db, ctx(orgId), async (tx): Promise<ProposalDetail | null> => {
        const [row] = await tx
          .select()
          .from(PROPOSAL)
          .where(and(eq(PROPOSAL.id, proposalId), eq(PROPOSAL.organizationId, orgId)))
          .limit(1);
        return row ? proposalDetail(row) : null;
      });
    },
    async acceptProposal(orgId, membershipId, proposalId, args) {
      return withOrgContext(db, ctx(orgId, membershipId), async (tx): Promise<ProposalDetail> => {
        const [row] = await tx
          .select()
          .from(PROPOSAL)
          .where(and(eq(PROPOSAL.id, proposalId), eq(PROPOSAL.organizationId, orgId)))
          .limit(1);
        if (!row) throw new NotFoundError("hl7_inbound_proposal", proposalId);
        const decidedAt = new Date();
        let decision: ReturnType<typeof decideProposal> | undefined;
        try {
          decision = decideProposal(snapshotOf(row), {
            kind: "accept",
            decidedByMembershipId: membershipId,
            decidedAt,
            acceptedAggregateId: args.acceptedAggregateId,
            decisionRationale: args.decisionNote,
          });
        } catch (e) {
          translate(e, proposalId, row.proposalStatus);
        }
        const [updated] = await tx
          .update(PROPOSAL)
          .set({
            proposalStatus: "accepted",
            decidedByMembershipId: membershipId,
            decidedAt,
            decisionRationale: args.decisionNote?.trim() ? args.decisionNote.trim() : null,
            acceptedAggregateId: args.acceptedAggregateId ?? null,
          })
          .where(and(eq(PROPOSAL.id, proposalId), eq(PROPOSAL.organizationId, orgId)))
          .returning();
        // §4.10 — the accepted event rides the deciding tx (transactional outbox); the M5/M6
        // appliers consume it. A validation failure rolls the whole accept back — refuse-on-emit.
        if (decision?.kind === "accepted" && storeDeps.outbox) {
          await storeDeps.outbox.publish(tx as unknown as DbClient, {
            eventName: decision.event.name,
            payload: decision.event.payload as unknown as Record<string, unknown>,
            organizationId: orgId,
            aggregateKind: "hl7_inbound_proposal",
            aggregateId: proposalId,
          });
        }
        return proposalDetail(updated!);
      });
    },
    async rejectProposal(orgId, membershipId, proposalId, rationale) {
      return withOrgContext(db, ctx(orgId, membershipId), async (tx): Promise<ProposalDetail> => {
        const [row] = await tx
          .select()
          .from(PROPOSAL)
          .where(and(eq(PROPOSAL.id, proposalId), eq(PROPOSAL.organizationId, orgId)))
          .limit(1);
        if (!row) throw new NotFoundError("hl7_inbound_proposal", proposalId);
        try {
          decideProposal(snapshotOf(row), {
            kind: "reject",
            decidedByMembershipId: membershipId,
            decidedAt: new Date(),
            decisionRationale: rationale,
          });
        } catch (e) {
          translate(e, proposalId, row.proposalStatus);
        }
        const [updated] = await tx
          .update(PROPOSAL)
          .set({
            proposalStatus: "rejected",
            decidedByMembershipId: membershipId,
            decidedAt: new Date(),
            decisionRationale: rationale,
          })
          .where(and(eq(PROPOSAL.id, proposalId), eq(PROPOSAL.organizationId, orgId)))
          .returning();
        return proposalDetail(updated!);
      });
    },
    async deferProposal(orgId, membershipId, proposalId, _note) {
      return withOrgContext(db, ctx(orgId, membershipId), async (tx): Promise<ProposalDetail> => {
        const [row] = await tx
          .select()
          .from(PROPOSAL)
          .where(and(eq(PROPOSAL.id, proposalId), eq(PROPOSAL.organizationId, orgId)))
          .limit(1);
        if (!row) throw new NotFoundError("hl7_inbound_proposal", proposalId);
        if (row.proposalStatus !== "pending") {
          throw new ConflictError(`proposal ${proposalId} is ${row.proposalStatus} — cannot defer`);
        }
        // Defer keeps status 'pending' (a caseload-RN task is a forward-seam to M19); nothing else changes.
        return proposalDetail(row);
      });
    },

    async listInboundMessages(orgId, filter) {
      return withOrgContext(db, ctx(orgId), async (tx): Promise<Page<InboundMessageView>> => {
        const rows = await tx
          .select()
          .from(INBOUND)
          .where(eq(INBOUND.organizationId, orgId))
          .orderBy(desc(INBOUND.receivedAt))
          .limit(filter.limit ?? 50);
        return {
          items: rows
            .filter((r) => (filter.feedId ? r.feedId === filter.feedId : true))
            .filter((r) => (filter.messageType ? r.messageType === filter.messageType : true))
            .filter((r) =>
              filter.messageControlId ? r.messageControlId === filter.messageControlId : true,
            )
            .filter((r) => (filter.parseStatus ? r.parseStatus === filter.parseStatus : true))
            .map(inboundView),
        };
      });
    },
    async getInboundMessage(orgId, messageId) {
      return withOrgContext(db, ctx(orgId), async (tx): Promise<InboundMessageView | null> => {
        const [row] = await tx
          .select()
          .from(INBOUND)
          .where(and(eq(INBOUND.id, messageId), eq(INBOUND.organizationId, orgId)))
          .limit(1);
        return row ? inboundView(row) : null;
      });
    },
    async replayInboundMessage(orgId, membershipId, messageId) {
      return withOrgContext(
        db,
        ctx(orgId, membershipId),
        async (tx): Promise<InboundMessageView> => {
          const [row] = await tx
            .select()
            .from(INBOUND)
            .where(and(eq(INBOUND.id, messageId), eq(INBOUND.organizationId, orgId)))
            .limit(1);
          if (!row) throw new NotFoundError("hl7_message_inbound", messageId);
          if (row.parseStatus !== "parse_error" && row.parseStatus !== "rejected") {
            throw new ConflictError(
              `message ${messageId} is ${row.parseStatus} — only a parse_error/rejected message replays`,
            );
          }
          const [updated] = await tx
            .update(INBOUND)
            .set({ parseStatus: "in_progress" })
            .where(and(eq(INBOUND.id, messageId), eq(INBOUND.organizationId, orgId)))
            .returning();
          return inboundView(updated!);
        },
      );
    },
    async listOutboundMessages(orgId, filter) {
      return withOrgContext(db, ctx(orgId), async (tx): Promise<Page<OutboundMessageView>> => {
        const rows = await tx
          .select()
          .from(OUTBOUND)
          .where(eq(OUTBOUND.organizationId, orgId))
          .orderBy(desc(OUTBOUND.queuedAt))
          .limit(filter.limit ?? 50);
        return {
          items: rows
            .filter((r) => (filter.feedId ? r.feedId === filter.feedId : true))
            .filter((r) =>
              filter.placerOrderNumber ? r.sourceAggregateId === filter.placerOrderNumber : true,
            )
            .filter((r) => (filter.status ? r.status === filter.status : true))
            .map(outboundView),
        };
      });
    },
    async getOutboundMessage(orgId, messageId) {
      return withOrgContext(db, ctx(orgId), async (tx): Promise<OutboundMessageView | null> => {
        const [row] = await tx
          .select()
          .from(OUTBOUND)
          .where(and(eq(OUTBOUND.id, messageId), eq(OUTBOUND.organizationId, orgId)))
          .limit(1);
        return row ? outboundView(row) : null;
      });
    },
    async retryOutboundMessage(orgId, membershipId, messageId) {
      return withOrgContext(
        db,
        ctx(orgId, membershipId),
        async (tx): Promise<OutboundMessageView> => {
          const [row] = await tx
            .select()
            .from(OUTBOUND)
            .where(and(eq(OUTBOUND.id, messageId), eq(OUTBOUND.organizationId, orgId)))
            .limit(1);
          if (!row) throw new NotFoundError("hl7_message_outbound", messageId);
          if (row.status !== "failed" && row.status !== "dlq") {
            throw new ConflictError(
              `message ${messageId} is ${row.status} — only a failed/dlq message is manually retried (D9)`,
            );
          }
          const [updated] = await tx
            .update(OUTBOUND)
            .set({ status: "queued", nextRetryAt: new Date() })
            .where(and(eq(OUTBOUND.id, messageId), eq(OUTBOUND.organizationId, orgId)))
            .returning();
          return outboundView(updated!);
        },
      );
    },

    async getNppesProvider(npi) {
      // Platform-shared, read-all under wardenx_app — no org context.
      const [row] = await db.select().from(NPPES).where(eq(NPPES.npi, npi)).limit(1);
      return row ? nppesView(row) : null;
    },
    async listSyncRuns(filter) {
      const rows = await db
        .select()
        .from(SYNC)
        .orderBy(desc(SYNC.startedAt))
        .limit(filter.limit ?? 50);
      return { items: rows.map(syncView) };
    },

    async feedHealthAggregate(orgId) {
      return withOrgContext(db, ctx(orgId), async (tx): Promise<FeedHealthAggregate> => {
        const feeds = await tx
          .select({ status: FEED.status })
          .from(FEED)
          .where(eq(FEED.organizationId, orgId));
        const health = await tx.select().from(HEALTH).where(eq(HEALTH.organizationId, orgId));
        return {
          feedCount: feeds.length,
          activeFeedCount: feeds.filter((f) => f.status === "active").length,
          listenersUp: health.filter((h) => h.listenerUpSeconds > 0).length,
          listenersDown: health.filter((h) => h.listenerDownSeconds > 0).length,
          inboundMessageCount: health.reduce((s, h) => s + h.inboundMessageCount, 0),
          outboundMessageCount: health.reduce((s, h) => s + h.outboundMessageCount, 0),
          parseErrorCount: health.reduce((s, h) => s + h.parseErrorCount, 0),
        };
      });
    },
    async listenerStatus(orgId) {
      return withOrgContext(db, ctx(orgId), async (tx): Promise<ListenerStatusView[]> => {
        const feeds = await tx.select().from(FEED).where(eq(FEED.organizationId, orgId));
        const health = await tx.select().from(HEALTH).where(eq(HEALTH.organizationId, orgId));
        const latestByFeed = new Map<string, typeof HEALTH.$inferSelect>();
        for (const h of health) {
          const prev = latestByFeed.get(h.feedId);
          if (!prev || h.hourBucket.getTime() > prev.hourBucket.getTime()) {
            latestByFeed.set(h.feedId, h);
          }
        }
        return feeds.map((f) => {
          const h = latestByFeed.get(f.id);
          return {
            feedId: f.id,
            displayName: f.displayName,
            status: f.status,
            listenerUp: f.status === "active" && (h?.listenerUpSeconds ?? 0) > 0,
            lastMessageAt: h?.lastMessageAt ? h.lastMessageAt.toISOString() : null,
          };
        });
      });
    },

    async listObservations(orgId, filter) {
      return withOrgContext(db, ctx(orgId), async (tx): Promise<Page<LabObservationSummary>> => {
        // GAP-085 — an explicit-but-empty caseload is "no patients", never "no restriction".
        if (filter.caseloadPatientIds && filter.caseloadPatientIds.length === 0) {
          return { items: [] };
        }
        const limit = filter.limit ?? 50;
        const cursor = decodeObservationCursor(filter.cursor);
        const conds = [eq(OBS.organizationId, orgId)];
        if (filter.patientId) conds.push(eq(OBS.patientId, filter.patientId));
        if (filter.loincCode) conds.push(eq(OBS.loincCode, filter.loincCode));
        if (filter.caseloadPatientIds)
          conds.push(inArray(OBS.patientId, [...filter.caseloadPatientIds]));
        if (filter.abnormalFlag) {
          conds.push(
            exists(
              tx
                .select({ one: sql`1` })
                .from(OBS_VALUE)
                .where(
                  and(
                    eq(OBS_VALUE.observationId, OBS.id),
                    eq(OBS_VALUE.organizationId, orgId),
                    eq(OBS_VALUE.abnormalFlag, filter.abnormalFlag),
                  ),
                ),
            ),
          );
        }
        if (cursor) {
          const d = new Date(cursor.d);
          conds.push(
            or(
              lt(OBS.observationDate, d),
              and(eq(OBS.observationDate, d), lt(OBS.id, cursor.id)),
            ) ?? sql`true`,
          );
        }
        const rows = await tx
          .select()
          .from(OBS)
          .where(and(...conds))
          .orderBy(desc(OBS.observationDate), desc(OBS.id))
          .limit(limit + 1);
        const pageRows = rows.slice(0, limit);
        const last = pageRows[pageRows.length - 1];
        const items = pageRows.map(obsSummary);
        return rows.length > limit && last
          ? {
              items,
              nextCursor: encodeObservationCursor({
                d: last.observationDate.toISOString(),
                id: last.id,
              }),
            }
          : { items };
      });
    },
    async getObservation(orgId, observationId) {
      return withOrgContext(db, ctx(orgId), async (tx): Promise<LabObservationDetail | null> => {
        const [row] = await tx
          .select()
          .from(OBS)
          .where(and(eq(OBS.id, observationId), eq(OBS.organizationId, orgId)))
          .limit(1);
        if (!row) return null;
        const values = await tx
          .select()
          .from(OBS_VALUE)
          .where(
            and(eq(OBS_VALUE.observationId, observationId), eq(OBS_VALUE.organizationId, orgId)),
          );
        return {
          ...obsSummary(row),
          values: values.map((v) => ({
            obxSetId: v.obxSetId,
            loincCode: v.loincCode,
            loincDisplayText: v.loincDisplayText,
            valueType: v.valueType,
            numericValue: num(v.numericValue),
            stringValue: v.stringValue,
            units: v.units,
            referenceRange: v.referenceRange,
            abnormalFlag: v.abnormalFlag,
          })),
        };
      });
    },
    async acknowledgeAbnormalObservation(orgId, membershipId, observationId) {
      return withOrgContext(db, ctx(orgId, membershipId), async (tx) => {
        const [row] = await tx
          .select()
          .from(OBS)
          .where(and(eq(OBS.id, observationId), eq(OBS.organizationId, orgId)))
          .limit(1);
        if (!row) return null;
        // Stamped ONCE: a repeat acknowledgement returns the stored one and emits nothing.
        if (row.acknowledgedAt !== null && row.acknowledgedByMembershipId !== null) {
          return {
            acknowledgedAt: row.acknowledgedAt.toISOString(),
            acknowledgedByMembershipId: row.acknowledgedByMembershipId,
          };
        }
        const acknowledgedAt = new Date();
        await tx
          .update(OBS)
          .set({ acknowledgedAt, acknowledgedByMembershipId: membershipId })
          .where(and(eq(OBS.id, observationId), eq(OBS.organizationId, orgId)));
        await storeDeps.outbox?.publish(tx as unknown as DbClient, {
          eventName: "m29.lab_observation.abnormal_acknowledged",
          payload: {
            observationId,
            organizationId: orgId,
            patientId: row.patientId,
            acknowledgedByMembershipId: membershipId,
            acknowledgedAt: acknowledgedAt.toISOString(),
          },
          organizationId: orgId,
          aggregateKind: "lab_observation",
          aggregateId: observationId,
        });
        return {
          acknowledgedAt: acknowledgedAt.toISOString(),
          acknowledgedByMembershipId: membershipId,
        };
      });
    },
    async listUnmatchedObservations(orgId, filter) {
      return withOrgContext(db, ctx(orgId), async (tx): Promise<Page<UnmatchedLabView>> => {
        // `resolved_at IS NULL` IS the queue (GAP-044). The old predicate kept any link row whose
        // `match_method` was `unmatched` OR that carried a candidate — with no notion of resolution, so a
        // bound or discarded item would have surfaced forever. It never mattered, because ingest wrote no
        // link row for an unmatched result at all and the queue was structurally empty.
        const rows = await tx
          .select()
          .from(OBS_LINK)
          .where(
            and(
              eq(OBS_LINK.organizationId, orgId),
              eq(OBS_LINK.matchMethod, "unmatched"),
              isNull(OBS_LINK.resolvedAt),
            ),
          )
          .orderBy(desc(OBS_LINK.createdAt))
          .limit(filter.limit ?? 50);
        if (rows.length === 0) return { items: [] };
        // §5.2.4's detail panel needs the actual results — one batched read, never N+1.
        const valueRows = await tx
          .select()
          .from(OBS_VALUE)
          .where(
            and(
              eq(OBS_VALUE.organizationId, orgId),
              inArray(
                OBS_VALUE.observationId,
                rows.map((r) => r.observationId),
              ),
            ),
          );
        const byObservation = new Map<string, typeof valueRows>();
        for (const v of valueRows) {
          const bucket = byObservation.get(v.observationId) ?? [];
          bucket.push(v);
          byObservation.set(v.observationId, bucket);
        }
        return {
          items: rows.map((r) => ({
            id: r.id,
            observationId: r.observationId,
            sourceMessageId: r.sourceMessageId,
            obrPlacerOrderNumber: r.obrPlacerOrderNumber,
            matchMethod: r.matchMethod,
            candidatePatientId: r.candidatePatientId,
            candidateMatchLevel: r.candidateMatchLevel,
            createdAt: r.createdAt.toISOString(),
            values: (byObservation.get(r.observationId) ?? [])
              .sort((a, b) => a.obxSetId - b.obxSetId)
              .map((v) => ({
                obxSetId: v.obxSetId,
                loincCode: v.loincCode,
                loincDisplayText: v.loincDisplayText,
                valueType: v.valueType,
                numericValue: num(v.numericValue),
                stringValue: v.stringValue,
                units: v.units,
                referenceRange: v.referenceRange,
                abnormalFlag: v.abnormalFlag,
              })),
          })),
        };
      });
    },

    // ── §4.2 review-queue EXIT (GAP-044) ──────────────────────────────────────────────────────────────
    // Both decisions are the PURE cores in `../inbound/unmatched-lab-review`; this layer only reads the
    // queue item, resolves the patient through M5's seam, and writes what the core decided — inside ONE
    // `withOrgContext` tx so the observation insert, the link patch and the §4.10 emit commit together.
    //
    // THE LINK ROW IS THE LOCK. Both writes claim it with `UPDATE … WHERE resolved_at IS NULL` and treat
    // a zero-row result as "someone else got there first" — without that, two reviewers binding the same
    // result concurrently would both pass the pure guard (each read an unresolved row) and the second
    // insert would collide on the observation PK with an opaque constraint error instead of a 409.

    async bindUnmatchedObservation(orgId, membershipId, observationId, args) {
      const patient = await patients.findById({ organizationId: orgId, id: args.patientId });
      if (patient === null) {
        throwReviewRefusal({
          kind: "refused",
          reason: "patient_not_found",
          message: `patient ${args.patientId} does not resolve in this tenant`,
        });
      }
      return withOrgContext(
        db,
        ctx(orgId, membershipId),
        async (tx): Promise<UnmatchedReviewResult> => {
          const item = await loadQueueItem(tx, orgId, observationId);
          const decidedAt = new Date();
          const decision = planUnmatchedBind(item, {
            patient: { patientId: patient.id, providerEntityId: patient.providerEntityId ?? null },
            decidedByMembershipId: membershipId,
            ...(args.note === undefined ? {} : { note: args.note }),
            now: decidedAt,
          });
          if (decision.kind === "refused") throwReviewRefusal(decision);

          const claimed = await tx
            .update(OBS_LINK)
            .set(decision.linkPatch)
            .where(
              and(
                eq(OBS_LINK.organizationId, orgId),
                eq(OBS_LINK.observationId, observationId),
                isNull(OBS_LINK.resolvedAt),
              ),
            )
            .returning({ id: OBS_LINK.id });
          if (claimed.length === 0) {
            throw new ConflictError(
              "this unmatched lab result has already been bound or discarded — reload the queue",
            );
          }
          await tx.insert(OBS).values(decision.observation);
          await storeDeps.outbox?.publish(tx as unknown as DbClient, {
            eventName: decision.event.name,
            payload: { ...decision.event.payload },
            organizationId: orgId,
            aggregateKind: "lab_observation",
            aggregateId: observationId,
          });
          return {
            observationId,
            resolution: "manually_matched",
            resolvedAt: decidedAt.toISOString(),
            resolvedByMembershipId: membershipId,
            patientId: decision.linkPatch.candidatePatientId,
          };
        },
      );
    },

    async discardUnmatchedObservation(orgId, membershipId, observationId, args) {
      return withOrgContext(
        db,
        ctx(orgId, membershipId),
        async (tx): Promise<UnmatchedReviewResult> => {
          const item = await loadQueueItem(tx, orgId, observationId);
          const decidedAt = new Date();
          const decision = planUnmatchedDiscard(item, {
            reason: args.reason,
            decidedByMembershipId: membershipId,
            now: decidedAt,
          });
          if (decision.kind === "refused") throwReviewRefusal(decision);

          const claimed = await tx
            .update(OBS_LINK)
            .set(decision.linkPatch)
            .where(
              and(
                eq(OBS_LINK.organizationId, orgId),
                eq(OBS_LINK.observationId, observationId),
                isNull(OBS_LINK.resolvedAt),
              ),
            )
            .returning({ id: OBS_LINK.id });
          if (claimed.length === 0) {
            throw new ConflictError(
              "this unmatched lab result has already been bound or discarded — reload the queue",
            );
          }
          await storeDeps.outbox?.publish(tx as unknown as DbClient, {
            eventName: decision.event.name,
            payload: { ...decision.event.payload },
            organizationId: orgId,
            aggregateKind: "lab_observation",
            aggregateId: observationId,
          });
          return {
            observationId,
            resolution: "discarded",
            resolvedAt: decidedAt.toISOString(),
            resolvedByMembershipId: membershipId,
          };
        },
      );
    },
  };
}
