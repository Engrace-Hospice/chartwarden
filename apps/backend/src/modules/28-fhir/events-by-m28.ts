import type { ModuleEventContribution } from "@chartwarden/types";
// apps/backend/src/modules/28-fhir/events-by-m28.ts — M28's transactional-outbox event catalog
// contribution.
//
// M28 had NO catalog contribution at all (alongside M2 and M36; #205) — no `M28_OUTBOX_EVENTS`
// anywhere in the repo and no entry in the boot dispatcher's `buildBootOutboxCatalog([...])`. The
// fail-closed dispatcher refuses any publish whose event name is not in the boot catalog, so the
// gap was not "publishes but nobody's listening" — it was that `packages/fhir/src/lifecycle/*.ts`
// (M28-T07) has built and typed every one of these event envelopes (`M28OutboxEvent`,
// `packages/fhir/src/outbox-events.ts`) since T07 and nothing could ever publish one: the store
// (`routes/store-drizzle.ts`) had no outbox dependency at all.
//
// The payload shapes below are transcribed from `M28OutboxEvent` — the payload-shape contract T07
// already committed to — so this file adds the REGISTRY half T08 never built, not a new contract.
import { Type } from "@sinclair/typebox";

const fhirClientId = Type.String({ minLength: 1 });
const membershipId = Type.String({ minLength: 1 });
const isoTimestamp = Type.String({ minLength: 1 });
const nonEmptyString = Type.String({ minLength: 1 });

export const M28_OUTBOX_EVENTS: ModuleEventContribution = [
  // ── §2.2 client lifecycle (D12 dual-approval FSM) ──────────────────────────────────────────────
  {
    eventName: "m28.fhir.client.pending_approval",
    moduleOwner: "m28",
    description:
      "An Org Admin proposed a new fhir_client (D12's first of two required, distinct approvers).",
    payloadSchema: Type.Object({
      clientId: fhirClientId,
      proposedByMembershipId: membershipId,
      tier: Type.String({ minLength: 1 }),
      allowedScopes: Type.Array(Type.String()),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m28.fhir.client.activated",
    moduleOwner: "m28",
    description:
      "A Compliance Officer satisfied D12 dual approval (distinct from the proposing admin) and the client became active.",
    payloadSchema: Type.Object({
      clientId: fhirClientId,
      approvedByAdminMembershipId: membershipId,
      approvedByComplianceMembershipId: membershipId,
      approvedAt: isoTimestamp,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m28.fhir.client.revoked",
    moduleOwner: "m28",
    description:
      "A fhir_client was revoked — cascades to every live session (revoked) and inflight bulk-export job (cancelled) via `cascadeClientRevocation`.",
    payloadSchema: Type.Object({
      clientId: fhirClientId,
      revokedAt: isoTimestamp,
      rationale: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m28.fhir.client.suspended",
    moduleOwner: "m28",
    description: "A fhir_client was suspended, with the same session/job cascade as a revocation.",
    payloadSchema: Type.Object({
      clientId: fhirClientId,
      reason: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },

  // ── §2.3 bulk export ────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m28.fhir.bulk_export.accepted",
    moduleOwner: "m28",
    description: "A $export request was accepted and a fhir_bulk_export_job opened.",
    payloadSchema: Type.Object({
      jobId: Type.String({ minLength: 1 }),
      clientId: fhirClientId,
      resourceTypes: Type.Array(Type.String()),
      requestKind: Type.Union([
        Type.Literal("system"),
        Type.Literal("group"),
        Type.Literal("patient"),
      ]),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m28.fhir.bulk_export.completed",
    moduleOwner: "m28",
    description:
      "A bulk-export job finished. M33's report_mv.OUTBOX_SUBSCRIPTION_MAP already keys `mv_fhir_bulk_export_org_month` off this exact name — but that relationship is a PULL through report_mv, not a bound outbox consumer (M33's `M33_MV_REFRESH_SUBSCRIPTIONS` incremental-invalidation tier is itself still marked `_DEFERRED = true` pending its own composition-root binding, a separate task spanning ~60 topics). Recorded as a seam, not a declared consumer, so this event finalizes `dispatched` rather than deferring forever the moment M33's binding lands. No worker actually transitions a job to `completed` yet either (§2.3's async processing is unbuilt) — this entry documents the payload contract for when one exists.",
    payloadSchema: Type.Object({
      jobId: Type.String({ minLength: 1 }),
      clientId: fhirClientId,
      completedAt: isoTimestamp,
      totalResources: Type.Integer({ minimum: 0 }),
      artifactCount: Type.Integer({ minimum: 0 }),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m28.fhir.bulk_export.failed",
    moduleOwner: "m28",
    description:
      "A bulk-export job failed. No worker transitions a job to `failed` yet (§2.3's async processing is unbuilt) — this entry documents the payload contract for when one exists.",
    payloadSchema: Type.Object({
      jobId: Type.String({ minLength: 1 }),
      clientId: fhirClientId,
      failedAt: isoTimestamp,
      failureReason: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m28.fhir.bulk_export.cancelled",
    moduleOwner: "m28",
    description:
      "A bulk-export job was cancelled, either by an admin (§2.3 R33) or by the D12 revocation/suspension cascade (`cancelledByMembershipId: null`).",
    payloadSchema: Type.Object({
      jobId: Type.String({ minLength: 1 }),
      clientId: fhirClientId,
      cancelledByMembershipId: Type.Union([membershipId, Type.Null()]),
      cancelledAt: isoTimestamp,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },

  // ── §2.4 inbound proposals (D3 review queue) ───────────────────────────────────────────────────
  {
    eventName: "m28.fhir.inbound.proposed",
    moduleOwner: "m28",
    description: "A partner staged an inbound write as a pending review-queue proposal.",
    payloadSchema: Type.Object({
      proposalId: Type.String({ minLength: 1 }),
      ownerModule: Type.Union([Type.Literal("m5"), Type.Literal("m12")]),
      resourceType: Type.String({ minLength: 1 }),
      sourceClientId: fhirClientId,
      proposedAt: isoTimestamp,
      payloadSha256: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m28.fhir.inbound.accepted",
    moduleOwner: "m28",
    description:
      "A reviewer accepted an inbound proposal. Record-only for now: neither M5 nor M12 has an applier consuming this event — the decision is durable (`fhir_inbound_resource.proposal_status`), but nothing yet writes the accepted change into the owning module's own tables. A declared consumer here with no applier would defer every acceptance forever.",
    payloadSchema: Type.Object({
      proposalId: Type.String({ minLength: 1 }),
      ownerModule: Type.Union([Type.Literal("m5"), Type.Literal("m12")]),
      acceptedAggregateId: nonEmptyString,
      decidedByMembershipId: membershipId,
      decidedAt: isoTimestamp,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m28.fhir.inbound.rejected",
    moduleOwner: "m28",
    description:
      "A reviewer rejected an inbound proposal — a durable record; no consumer applies anything.",
    payloadSchema: Type.Object({
      proposalId: Type.String({ minLength: 1 }),
      ownerModule: Type.Union([Type.Literal("m5"), Type.Literal("m12")]),
      decidedByMembershipId: membershipId,
      decidedAt: isoTimestamp,
      rationale: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m28.fhir.inbound.expired",
    moduleOwner: "m28",
    description: "An inbound proposal aged past its tenant's review SLA with no decision recorded.",
    payloadSchema: Type.Object({
      proposalId: Type.String({ minLength: 1 }),
      ownerModule: Type.Union([Type.Literal("m5"), Type.Literal("m12")]),
      expiredAt: isoTimestamp,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },

  // ── §4.9 capability statement ───────────────────────────────────────────────────────────────────
  {
    eventName: "m28.fhir.capability.regenerated",
    moduleOwner: "m28",
    description:
      "The published CapabilityStatement snapshot was regenerated (a new `SERVED_RESOURCES` release). Platform-wide, record-only.",
    payloadSchema: Type.Object({
      releaseTag: Type.String({ minLength: 1 }),
      fhirVersion: Type.Union([
        Type.Literal("4.0.1"),
        Type.Literal("5.0.0"),
        Type.Literal("6.0.0"),
      ]),
      checksumSha256: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
];
