import type { ModuleEventContribution } from "@chartwarden/types";
// apps/backend/src/modules/29-external-interfaces/events-by-m29.ts — M29's transactional-outbox
// event contribution (task-11 follow-up closing the TASK-006 gap: the accept/reject decision cores
// have produced these event envelopes since M29-T04, but nothing registered them in the boot
// catalog and the Drizzle store discarded them — so the M5/M6 accept consumers, deferred since
// Waves C/D, had nothing to consume). Folded into `buildBootOutboxCatalog` at the composition root;
// the Drizzle store publishes each within the deciding mutation's own tx.
import { Type } from "@sinclair/typebox";

/** Shared core — every proposal-decision event names the proposal + org (decision.ts payloads). */
const coreProposal = {
  proposalId: Type.String({ minLength: 1 }),
  organizationId: Type.String({ minLength: 1 }),
  sourceMessageId: Type.String({ minLength: 1 }),
  ownerModule: Type.Union([Type.Literal("m5"), Type.Literal("m6")]),
  decidedByMembershipId: Type.String({ minLength: 1 }),
  decidedAt: Type.String({ minLength: 1 }),
};

export const M29_OUTBOX_EVENTS: ModuleEventContribution = [
  {
    eventName: "m29.hl7_inbound_proposal.accepted",
    moduleOwner: "m29",
    description:
      "A reviewer accepted an HL7 inbound proposal — the owner module (M5 demographics / M6 admission events) applies it via its outbox consumer (§4.10).",
    payloadSchema: Type.Object({
      ...coreProposal,
      resourceKind: Type.String({ minLength: 1 }),
      decisionRationale: Type.Union([Type.String(), Type.Null()]),
      matchedPatientId: Type.Union([Type.String(), Type.Null()]),
      acceptedAggregateId: Type.Union([Type.String(), Type.Null()]),
      appliedFields: Type.Union([Type.Array(Type.String()), Type.Null()]),
      // The parsed PID/event candidate — shape is owner-module-specific; the consumers' own
      // decision cores validate it (the catalog validates the envelope, not the clinical payload).
      proposedPatientCandidate: Type.Unknown(),
    }),
    declaredConsumers: ["m5", "m6"],
    isOutboxOnly: true,
  },
  {
    eventName: "m29.hl7_inbound_proposal.rejected",
    moduleOwner: "m29",
    description:
      "A reviewer rejected an HL7 inbound proposal (≥40-char rationale, W-XI-04) — a durable record; no consumer applies anything.",
    payloadSchema: Type.Object({
      ...coreProposal,
      decisionRationale: Type.String({ minLength: 1 }), // rejects REQUIRE the ≥40-char rationale
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m29.hl7_inbound_proposal.expired",
    moduleOwner: "m29",
    description:
      "A pending HL7 inbound proposal was auto-expired by a system-driven sweep, never a human reviewer (`decidedByMembershipId: null`) — either the §2.2 72h SLA-review-window sweep (unbuilt: no cron worker anywhere calls `expireProposal`, F-165/#248) or the `m5.patient.deceased` freeze consumer (`outbox-consumers/m5-patient-deceased.ts`, F-165/#248), distinguishable by `decision_rationale` on the row. Had NO catalog entry at all before F-165 even though `expireProposal` has produced this envelope since M29-T04 — the `.accepted`/`.rejected` task-11 gap a third sibling over. Record-only: the row IS the durable record, the same posture `.rejected` above already states.",
    payloadSchema: Type.Object({
      proposalId: Type.String({ minLength: 1 }),
      organizationId: Type.String({ minLength: 1 }),
      expiredAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },

  // ── §4.2 / §4.10 unmatched-lab review decisions (GAP-044) ─────────────────────────────────────────
  // Both are record-only. The spec's §4.10 table lists M4 (and M11 for the bind) as consumers, but M4 is
  // the AUDIT module — its record is the write-audit trigger on the row itself, not an outbox
  // subscription — and M11's `order_record.fulfillment_status` flip keys on `m29.lab_observation
  // .attached`/`.received`, which a manual bind of an UNMATCHED result does not produce: an unmatched lab
  // has no OBR-2 placer, therefore no M11 order to fulfil. Declaring a consumer nobody binds would leave
  // every decision permanently `pending`; the row IS the durable record here.
  {
    eventName: "m29.lab_observation.manually_matched",
    moduleOwner: "m29",
    description:
      "A reviewer bound an unmatched lab result to a patient (§4.2) — the deferred lab_observation parent was materialized under the reserved id and the inbound link flipped to match_method='manual'.",
    payloadSchema: Type.Object({
      observationId: Type.String({ minLength: 1 }),
      organizationId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      sourceMessageId: Type.String({ minLength: 1 }),
      loincCode: Type.String(),
      abnormalSummary: Type.String({ minLength: 1 }),
      decidedByMembershipId: Type.String({ minLength: 1 }),
      decidedAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m29.lab_observation.discarded",
    moduleOwner: "m29",
    description:
      "A reviewer discarded an unmatched lab result (§4.2/§5.2.4, reason ≥10 chars) — the link row and its OBX values are retained per §8 (180 days) but stop surfacing in the queue. No lab_observation was ever created.",
    payloadSchema: Type.Object({
      observationId: Type.String({ minLength: 1 }),
      organizationId: Type.String({ minLength: 1 }),
      sourceMessageId: Type.String({ minLength: 1 }),
      decidedByMembershipId: Type.String({ minLength: 1 }),
      decidedAt: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 10 }),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },

  // ── §4.2 acknowledge-abnormal (GAP-152, D7) ──────────────────────────────────────────────────────
  // Record-only, like the two review decisions above: the acknowledgement is stamped on the observation row
  // and this event is the durable signal M36's abnormal-flag badge clear keys on (M36 pulls — it declares no
  // outbox binding here, so nothing is left permanently `pending`).
  {
    eventName: "m29.lab_observation.abnormal_acknowledged",
    moduleOwner: "m29",
    description:
      "An RN acknowledged an abnormal lab result (§4.2, D7) — stamped once on the lab_observation; M36 clears the abnormal-flag alert badge.",
    payloadSchema: Type.Object({
      observationId: Type.String({ minLength: 1 }),
      organizationId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      acknowledgedByMembershipId: Type.String({ minLength: 1 }),
      acknowledgedAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },

  // ── §4.7 / §4.10 NPPES platform sync (GAP-045) ────────────────────────────────────────────────────
  // These five are PLATFORM-WIDE: every row publishes with `organization_id IS NULL` (one public CMS
  // directory, no tenant it belongs to). `provider_synced` / `provider_deactivated` declare `m40` because
  // M40 owns the canonical `external_physician` these keep current. Both appliers are LIVE as of GAP-099
  // (`40-mdm/outbox-consumers/m29-nppes-consumers.ts`, registered on the dispatcher's platform binding
  // list) — before that they could not be reached at all, because `pollPlatform()` had no way to deliver
  // an org-less row and M40's canonical had no write path. The three `sync_run.*` lifecycle events are
  // record-only: the row IS the operational record, and M33's dashboard reads `nppes_sync_run` directly
  // rather than subscribing.
  // ── §4.4/§4.10 outbound ORM lifecycle (M29-T08, F-175/#248) ───────────────────────────────────────
  // HAD NO CATALOG ENTRY AT ALL before F-175 — the task-11/F-165/F-167 "decision core ships, nothing
  // registers or drains it" shape one module over: `dispatch-planner.ts`/`ack-correlation.ts`/
  // `retry-policy.ts` have produced these exact envelopes since M29-T06, but `outbound-events.ts`'s own
  // header ("published by the T08 worker") was future tense until this pass — no `M29_OUTBOX_EVENTS`
  // entry existed, so `bindCallerModule(txOutboxPublisher, "m29")`'s `Value.Check` would have REJECTED
  // every publish attempt even after a T08 worker existed to make one. `declaredConsumers: ["m11"]` per
  // the spec's own §4.4 relationship text ("M11 also receives... consumed by M11 to update
  // order_record.transmission_status") — checked directly, not guessed: no `LabTransmissionApplier`
  // implementation exists anywhere in the repo (only the two doc-comment mentions on
  // `m11.order.transmission_status_changed`/`.transmission_terminal_failed` in `events-by-m11.ts`), so
  // this pair is itself now the SAME "declared but genuinely unbound" shape on M11's side that this
  // register (`scripts/outbox-deferred-consumers.ts`) exists to track — a real, separate follow-up this
  // pass surfaces but does not build (M11's own consumer, out of this task's scope).
  {
    eventName: "m29.lab_order.transmitted",
    moduleOwner: "m29",
    description:
      "An outbound ORM^O01 the destination lab `AA`-acked (§4.12.2) — M11 consumes to flip `order_record.transmission_status` to TRANSMITTED.",
    payloadSchema: Type.Object({
      orderId: Type.String({ minLength: 1 }),
      organizationId: Type.String({ minLength: 1 }),
      feedId: Type.String({ minLength: 1 }),
      outboundMessageId: Type.String({ minLength: 1 }),
      messageControlId: Type.String({ minLength: 1 }),
      ackReceivedAt: Type.String({ minLength: 1 }),
      // F-200 — the outbound attempt the acked row belongs to; M11 applies it only to the order's current attempt.
      // Optional: a row queued before F-200 (or a request that carried no attempt) has none and applies as before.
      attemptId: Type.Optional(Type.String({ minLength: 1 })),
    }),
    declaredConsumers: ["m11"],
    isOutboxOnly: true,
  },
  {
    eventName: "m29.lab_order.transmission_failed",
    moduleOwner: "m29",
    description:
      "A terminal outbound ORM^O01 failure (§4.12.2/W-XI-09) — an `AR` structural reject (`application_reject`, no retry) or a transport/`AE` retry-budget exhaustion (`dlq_exhausted`); NEVER emitted for a pre-persist BAA refusal (that is transient and self-heals, per `dispatch-planner.ts`'s own header). M11 consumes to flip `order_record.transmission_status` to TRANSMISSION_FAILED; M36 raises the high-severity operator alert.",
    payloadSchema: Type.Object({
      orderId: Type.String({ minLength: 1 }),
      organizationId: Type.String({ minLength: 1 }),
      feedId: Type.String({ minLength: 1 }),
      outboundMessageId: Type.String({ minLength: 1 }),
      reason: Type.Union([Type.Literal("application_reject"), Type.Literal("dlq_exhausted")]),
      detail: Type.Union([Type.String(), Type.Null()]),
      attemptCount: Type.Integer({ minimum: 0 }),
      // F-200 — the outbound attempt the failed row belongs to (see `m29.lab_order.transmitted`).
      attemptId: Type.Optional(Type.String({ minLength: 1 })),
    }),
    declaredConsumers: ["m11"],
    isOutboxOnly: true,
  },
  {
    // F-187 (#248) — the worker's "wrote NO row" exits (no/ambiguous/unlinked active feed, incomplete MSH identity
    // on the feed, lapsed BAA) used to end silently, leaving the order `pending` forever with no path to resend.
    // This is the terminal signal M11's `LabTransmissionApplier` consumes to flip such an order to `failed`
    // (`dispatch_refused:<reason>`), which F-182's resend then acts on once the operator fixes the cause. Distinct
    // from `transmission_failed` because there is NO outbound row (no `outboundMessageId`) and the reasons are
    // configuration states, not wire outcomes.
    eventName: "m29.lab_order.dispatch_refused",
    moduleOwner: "m29",
    description:
      "The outbound ORM worker could not persist a dispatch row for an order — no/ambiguous/unlinked active feed, an incomplete MSH identity on the feed, or a lapsed BAA. Nothing was sent and no outbound row exists. M11 consumes to flip `order_record.transmission_status` to failed with `dispatch_refused:<reason>` so the order is never silently stuck pending; M36 raises the ordering-provider alert.",
    payloadSchema: Type.Object({
      orderId: Type.String({ minLength: 1 }),
      organizationId: Type.String({ minLength: 1 }),
      feedId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      refusalId: Type.String({ minLength: 1 }),
      reason: Type.Union([
        Type.Literal("no_active_feed"),
        Type.Literal("ambiguous_feed"),
        Type.Literal("no_feed_for_destination"),
        Type.Literal("feed_identity_incomplete"),
        Type.Literal("baa_inactive"),
        Type.Literal("attested_redispatch_blocked"),
      ]),
      // F-188 — the outbound attempt this refusal concerns (echoed from the request); M11 applies it only to the
      // order's current attempt.
      attemptId: Type.Optional(Type.String({ minLength: 1 })),
    }),
    declaredConsumers: ["m11"],
    isOutboxOnly: true,
  },

  {
    eventName: "m29.nppes.provider_synced",
    moduleOwner: "m29",
    description:
      "A cached NPPES provider row was inserted or updated by the platform sync — M40 applies the §4.7.1 minimum-update to its canonical external_physician from the snapshot carried ON the event (ADR-0011 D1: M40 never reads M29's table).",
    payloadSchema: Type.Object({
      npi: Type.String({ minLength: 10, maxLength: 10 }),
      action: Type.Union([Type.Literal("inserted"), Type.Literal("updated")]),
      changedFields: Type.Array(Type.String()),
      syncedAt: Type.String({ minLength: 1 }),
      syncRunId: Type.String({ minLength: 1 }),
      provider: Type.Object({
        firstName: Type.String(),
        lastName: Type.String(),
        credentials: Type.Union([Type.String(), Type.Null()]),
        specialtyTaxonomy: Type.Union([Type.String(), Type.Null()]),
      }),
    }),
    declaredConsumers: ["m40"],
    isOutboxOnly: true,
  },
  {
    eventName: "m29.nppes.provider_deactivated",
    moduleOwner: "m29",
    description:
      "NPPES flipped a provider active→deactivated (death, license revocation) — M40 deactivates the canonical and alerts every tenant whose overlay marked the provider preferred or attached to an active patient (§4.7.2).",
    payloadSchema: Type.Object({
      npi: Type.String({ minLength: 10, maxLength: 10 }),
      deactivationDate: Type.String({ minLength: 1 }),
      deactivationReason: Type.String({ minLength: 1 }),
      detectedAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m40"],
    isOutboxOnly: true,
  },
  {
    eventName: "m29.nppes.sync_run.started",
    moduleOwner: "m29",
    description:
      "The platform NPPES sync opened a run (§4.10). Record-only — the durable operational trail beside the `nppes_sync_run` row it opened.",
    payloadSchema: Type.Object({
      syncRunId: Type.String({ minLength: 1 }),
      kind: Type.String({ minLength: 1 }),
      triggeredBy: Type.String({ minLength: 1 }),
      startedAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m29.nppes.sync_run.completed",
    moduleOwner: "m29",
    description: "The platform NPPES sync finished walking every NPI (§4.10). Record-only.",
    payloadSchema: Type.Object({
      syncRunId: Type.String({ minLength: 1 }),
      completedAt: Type.String({ minLength: 1 }),
      providersFetched: Type.Integer({ minimum: 0 }),
      providersUpdated: Type.Integer({ minimum: 0 }),
      deactivations: Type.Integer({ minimum: 0 }),
      errors: Type.Integer({ minimum: 0 }),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m29.nppes.sync_run.failed",
    moduleOwner: "m29",
    description:
      "The platform NPPES sync aborted — the §2.3 consecutive-failure circuit breaker tripped, or a fatal error escaped the NPI walk (§4.10). Record-only.",
    payloadSchema: Type.Object({
      syncRunId: Type.String({ minLength: 1 }),
      failedAt: Type.String({ minLength: 1 }),
      error: Type.String({ minLength: 1 }),
      providersFetched: Type.Integer({ minimum: 0 }),
      providersUpdated: Type.Integer({ minimum: 0 }),
      errors: Type.Integer({ minimum: 0 }),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },

  // ── §4.10 inbound parse-worker outputs (GAP-086) ──────────────────────────────────────────────────
  // Published by `inbound/parse-worker.ts` in the same tx as the rows they describe. Record-only (no consumer binding):
  // the proposal / observation row IS the durable record, and the M5/M6/M11/M33 consumers spec §4.10 lists are forward
  // work — declaring one nobody binds would leave each row permanently `pending`.
  {
    eventName: "m29.hl7_inbound_proposal.created",
    moduleOwner: "m29",
    description:
      "The inbound parse worker resolved an ADT message to a pending review proposal (propose-then-review, D5; 72h SLA).",
    payloadSchema: Type.Object({
      proposalId: Type.String({ minLength: 1 }),
      organizationId: Type.String({ minLength: 1 }),
      sourceMessageId: Type.String({ minLength: 1 }),
      resourceKind: Type.String({ minLength: 1 }),
      ownerModule: Type.String({ minLength: 1 }),
      matchOutcome: Type.String({ minLength: 1 }),
      matchedPatientId: Type.Union([Type.String(), Type.Null()]),
      matchLevel: Type.String({ minLength: 1 }),
      matchConfidence: Type.Union([Type.Number(), Type.Null()]),
      matchCandidateIds: Type.Array(Type.String()),
      expiresAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m29.hl7_message.routing_dropped",
    moduleOwner: "m29",
    description:
      "An A03/A11 ADT for a patient the cascade could not match was dropped with audit — a discharge or cancel cannot act on an unknown patient (§4.6).",
    payloadSchema: Type.Object({
      messageId: Type.String({ minLength: 1 }),
      feedId: Type.String({ minLength: 1 }),
      organizationId: Type.String({ minLength: 1 }),
      messageControlId: Type.String({ minLength: 1 }),
      messageType: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m29.lab_observation.received",
    moduleOwner: "m29",
    description:
      "An inbound ORU result was auto-attached to a patient and materialized as a lab_observation (D7).",
    payloadSchema: Type.Object({
      observationId: Type.String({ minLength: 1 }),
      sourceMessageId: Type.String({ minLength: 1 }),
      organizationId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      orderRecordId: Type.Union([Type.String(), Type.Null()]),
      matchMethod: Type.String({ minLength: 1 }),
      terminologyValidation: Type.String({ minLength: 1 }),
      sudRedacted: Type.Boolean(),
      abnormalSummary: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m29.lab_observation.attached",
    moduleOwner: "m29",
    description:
      "A lab_observation was attached to its patient (and order, when the OBR-2 placer resolved one). " +
      "GAP-016: M11's `LabResultsApplier` consumes it to flip the order's `results_status` and emit `m11.order.results_received`.",
    payloadSchema: Type.Object({
      observationId: Type.String({ minLength: 1 }),
      organizationId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      orderRecordId: Type.Union([Type.String(), Type.Null()]),
      loincCode: Type.String(),
      abnormalFlag: Type.Union([Type.String(), Type.Null()]),
      observationDatetime: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m11"],
    isOutboxOnly: true,
  },
  {
    eventName: "m29.lab_observation.abnormal_flag",
    moduleOwner: "m29",
    description:
      "An attached lab carried a critical (HH/LL) flag (D7). The panel LOINC only — the abnormal value stays off the event (PHI denylist).",
    payloadSchema: Type.Object({
      observationId: Type.String({ minLength: 1 }),
      organizationId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      loincCode: Type.String(),
      criticalCount: Type.Integer({ minimum: 1 }),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m29.lab_observation.unmatched",
    moduleOwner: "m29",
    description:
      "An inbound ORU result could not be bound to a patient and entered the §4.2 unmatched-lab review queue (GAP-044).",
    payloadSchema: Type.Object({
      observationId: Type.String({ minLength: 1 }),
      sourceMessageId: Type.String({ minLength: 1 }),
      organizationId: Type.String({ minLength: 1 }),
      loincCode: Type.String(),
      reason: Type.String({ minLength: 1 }),
      receivedAt: Type.String({ minLength: 1 }),
      candidatePatientId: Type.Union([Type.String(), Type.Null()]),
      candidateMatchLevel: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },

  // ── §4.11.5 listener health (GAP-043) ───────────────────────────────────────────────────────────────
  // Published by the worker-role feed-health watcher (`listener/health-watch.ts`) in the SAME transaction that
  // moves `external_feed_listener_state`, so the state and the event cannot diverge. Consumed by M36's
  // `feed-health-alerts` consumer (`external_feed.listener_down` page / `external_feed.listener_recovered` notice).
  // Ids, enums, counts and instants only: no host, port, certificate or PHI.
  {
    eventName: "m29.external_feed.listener_down",
    moduleOwner: "m29",
    description:
      "An ACTIVE inbound HL7 feed has been silent past its down-threshold and its listener is not serving (heartbeat stale or unbound, or the TCP probe failed) - the breaker tripped OPEN (§4.11.5).",
    payloadSchema: Type.Object({
      feedId: Type.String({ minLength: 1 }),
      organizationId: Type.String({ minLength: 1 }),
      state: Type.Union([Type.Literal("closed"), Type.Literal("open"), Type.Literal("half_open")]),
      silentSeconds: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
      lastFrameAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      heartbeatStale: Type.Boolean(),
      tcpOk: Type.Boolean(),
      outageOpenedAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      at: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m29.external_feed.listener_recovered",
    moduleOwner: "m29",
    description:
      "A feed whose listener-down alert was raised is serving again (a frame arrived within the window, or silence is now expected) - the breaker closed (§4.11.5).",
    payloadSchema: Type.Object({
      feedId: Type.String({ minLength: 1 }),
      organizationId: Type.String({ minLength: 1 }),
      state: Type.Union([Type.Literal("closed"), Type.Literal("open"), Type.Literal("half_open")]),
      silentSeconds: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
      lastFrameAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      heartbeatStale: Type.Boolean(),
      tcpOk: Type.Boolean(),
      outageOpenedAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      at: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
];
