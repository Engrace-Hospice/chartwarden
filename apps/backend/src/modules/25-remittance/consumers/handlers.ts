// apps/backend/src/modules/25-remittance/consumers/handlers.ts — M25 (§2.4 / §4.4) the upstream outbox
// consumers. PURE handlers over an injected {@link DenialSeedStore} (the Drizzle binding lands at boot —
// module-only here, NOT wired into the dispatcher subscription yet; the M23 conservative posture):
//   - m23.claim.rejected           → seed a denial_case (source=claim_rejection_277ca) before any 835 lands.
//   - m18.evv.aggregator_rejected  → seed a denial_case (source=evv_aggregator_rejection) with the M18 ref.
//   - m22.document.rendered        → back-reference the rendered appeal-packet / resolution-letter doc id.
// Idempotency (§2.6): the 277CA seed dedupes on (claimId, source, UTC date); the EVV seed on the
// aggregator submission id; the doc backref on (aggregateType, aggregateId). The store enforces the dedupe.

/** The seam the Drizzle store implements (org-scoped writes under withOrgContext at the call site). */
export interface DenialSeedStore {
  /** Insert a denial_case if no matching one exists for the idempotency key; returns the id (new or existing). */
  seedDenial(input: {
    organizationId: string;
    providerEntityId: string;
    claimId: string | null;
    sourceEvvAggregatorSubmissionId: string | null;
    carcCode: string;
    rarcCode: string | null;
    category: string;
    source: "claim_rejection_277ca" | "evv_aggregator_rejection";
    dollarValue: string;
    idempotencyKey: string;
  }): Promise<{ denialCaseId: string; created: boolean }>;
  /** Populate appeal_case.appeal_packet_document_id / denial_case.resolution_letter ref from an M22 render. */
  backrefDocument(input: {
    organizationId: string;
    aggregateType: "appeal_case" | "denial_case";
    aggregateId: string;
    documentId: string;
  }): Promise<{ updated: boolean }>;
}

/** A denial-opened emission the caller forwards to the outbox after a NEW seed (PHI-free). */
export interface DenialOpenedEmission {
  readonly denialCaseId: string;
  readonly providerEntityId: string;
  readonly claimId: string | null;
  readonly carcCode: string;
  readonly category: string;
  readonly source: string;
  readonly dollarValue: string;
}

const utcDate = (iso: string): string => new Date(iso).toISOString().slice(0, 10);

/** m23.claim.rejected → seed a 277CA-derived denial worklist row. Returns the emission iff newly created. */
export async function handleClaimRejected(
  store: DenialSeedStore,
  event: {
    organizationId: string;
    providerEntityId: string;
    claimId: string;
    rejectionCodes: string[];
    occurredAt: string;
  },
): Promise<DenialOpenedEmission | null> {
  const carcCode = event.rejectionCodes[0] ?? "16"; // CARC 16 "claim/service lacks information" default
  const result = await store.seedDenial({
    organizationId: event.organizationId,
    providerEntityId: event.providerEntityId,
    claimId: event.claimId,
    sourceEvvAggregatorSubmissionId: null,
    carcCode,
    rarcCode: null,
    category: "denial",
    source: "claim_rejection_277ca",
    dollarValue: "0",
    idempotencyKey: `277ca:${event.claimId}:${utcDate(event.occurredAt)}`,
  });
  if (!result.created) return null;
  return {
    denialCaseId: result.denialCaseId,
    providerEntityId: event.providerEntityId,
    claimId: event.claimId,
    carcCode,
    category: "denial",
    source: "claim_rejection_277ca",
    dollarValue: "0",
  };
}

/** m18.evv.aggregator_rejected → seed an EVV-back-linked denial worklist row. */
export async function handleEvvAggregatorRejected(
  store: DenialSeedStore,
  event: {
    organizationId: string;
    providerEntityId: string;
    aggregatorSubmissionId: string;
    carcCode?: string;
    rarcCode?: string;
  },
): Promise<DenialOpenedEmission | null> {
  const carcCode = event.carcCode ?? "16";
  const result = await store.seedDenial({
    organizationId: event.organizationId,
    providerEntityId: event.providerEntityId,
    claimId: null,
    sourceEvvAggregatorSubmissionId: event.aggregatorSubmissionId,
    carcCode,
    rarcCode: event.rarcCode ?? "N365", // RARC N365 "procedure code not payable" — the EVV-mismatch signal
    category: "denial",
    source: "evv_aggregator_rejection",
    dollarValue: "0",
    idempotencyKey: `evv:${event.aggregatorSubmissionId}`,
  });
  if (!result.created) return null;
  return {
    denialCaseId: result.denialCaseId,
    providerEntityId: event.providerEntityId,
    claimId: null,
    carcCode,
    category: "denial",
    source: "evv_aggregator_rejection",
    dollarValue: "0",
  };
}

/** m22.document.rendered → back-reference the rendered appeal-packet / denial-resolution-letter doc. */
export async function handleDocumentRendered(
  store: DenialSeedStore,
  event: {
    organizationId: string;
    aggregateType: "appeal_case" | "denial_case";
    aggregateId: string;
    documentId: string;
  },
): Promise<{ updated: boolean }> {
  if (event.aggregateType !== "appeal_case" && event.aggregateType !== "denial_case") {
    return { updated: false }; // not an M25-owned aggregate
  }
  return store.backrefDocument(event);
}

/** The §4.4 inbound subscriptions M25 declares (consumed module-only until the dispatcher subscription binds). */
export const M25_OUTBOX_SUBSCRIPTIONS = [
  "m23.claim.rejected",
  "m18.evv.aggregator_rejected",
  "m22.document.rendered",
] as const;
