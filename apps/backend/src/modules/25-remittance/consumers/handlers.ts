// apps/backend/src/modules/25-remittance/consumers/handlers.ts — M25 (§2.4 / §4.4) the upstream outbox
// consumers. PURE handlers over an injected {@link DenialSeedStore} (the Drizzle binding lands at boot —
// module-only here, NOT wired into the dispatcher subscription yet; the M23 conservative posture):
//   - m23.claim.rejected           → seed a denial_case (source=claim_rejection_277ca) before any 835 lands.
//   - m18.evv.aggregator_rejected  → seed a denial_case (source=evv_aggregator_rejection) with the M18 ref.
//   - m22.document.rendered        → back-reference the rendered appeal-packet / resolution-letter doc id.
// Idempotency (§2.6): the 277CA seed dedupes on (claimId, source, UTC date); the EVV seed on the
// aggregator submission id; the doc backref on (aggregateType, aggregateId). Migration 0249
// (`denial_case_source_idempotency_key_uq`, F-153/F-156 #248) is what actually enforces it now — the store
// just conditions its INSERT on that constraint.
import { type DenialCategory, type TaxonomyStatus, effectiveCategory } from "../domain";

/** CARC/RARC → category lookup — the same shape `ingest/service.ts`'s `TerminologyLookupPort` publishes
 *  (a structural mirror rather than a re-export, so this file stays import-free of `../ingest/service` —
 *  no runtime edge is needed for a type). */
export interface DenialTerminologyLookupPort {
  lookup(carcCode: string, rarcCode: string | null): Promise<{ category: string } | null>;
}

/** A consumer wired with no real M38 port honestly degrades every code to `unmapped` — never fabricates a
 *  category, the same posture `ingest/service.ts`'s own `DENY_TERMINOLOGY` establishes for the 835 path. */
export const DENY_DENIAL_TERMINOLOGY: DenialTerminologyLookupPort = {
  async lookup() {
    return null;
  },
};

// Mirrors `ingest/service-drizzle.ts`'s private `DENIAL_CATEGORIES` set — the pre-filter that keeps a
// non-catalog string M38 might someday return from being trusted as a real `DenialCategory`. Duplicated as
// data (five literals), not as LOGIC: the actual resolution decision stays centralized in
// `effectiveCategory`, reused below rather than reimplemented.
const KNOWN_DENIAL_CATEGORIES = new Set<string>([
  "denial",
  "reduction",
  "informational",
  "recoupment",
  "unmapped",
]);

/**
 * Resolve {category, taxonomyStatus} for a CARC exactly the way the WX-PR-012 835 ingest pipeline already
 * does (`ingest/service-drizzle.ts`'s `resolveCategory` + `effectiveCategory`) — reused here rather than
 * reimplemented, because `category === "unmapped"` is NOT a safe proxy for `taxonomyStatus === "unmapped"`:
 * M38's catalog can itself classify a KNOWN code under the literal category "unmapped" (a real, mapped
 * answer of "we don't know the effect"), which is a different fact from the code being ABSENT from the
 * catalog entirely. `effectiveCategory` is the one place that distinction is decided; this only resolves
 * the raw catalog lookup into its input. `rarcCode` is deliberately unused in the lookup call — the ingest
 * pipeline's own `resolveCategory` always looks up by CARC alone (`terminology.lookup(carcCode, null)`),
 * so this mirrors that exact call shape rather than inventing a richer one.
 */
async function resolveDenialCategory(
  terminology: DenialTerminologyLookupPort,
  carcCode: string,
): Promise<{ category: string; taxonomyStatus: TaxonomyStatus }> {
  const looked = await terminology.lookup(carcCode, null);
  const catalogCategory: DenialCategory | null =
    looked && KNOWN_DENIAL_CATEGORIES.has(looked.category)
      ? (looked.category as DenialCategory)
      : null;
  return effectiveCategory(catalogCategory);
}

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
    // F-153/F-156 (#248) — was missing entirely; `denial_case.taxonomy_status` is NOT NULL with no default
    // and the only prior writer (`ingest/service-drizzle.ts`) always derived it via `effectiveCategory`.
    taxonomyStatus: TaxonomyStatus;
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
  readonly rarcCode: string | null;
  readonly category: string;
  readonly taxonomyStatus: TaxonomyStatus;
  readonly source: string;
  readonly dollarValue: string;
}

const utcDate = (iso: string): string => new Date(iso).toISOString().slice(0, 10);

/**
 * m23.claim.rejected → seed a 277CA-derived denial worklist row. Returns the emission iff newly created.
 * `terminology` is REQUIRED (no default) — a caller with no real M38 port must pass
 * {@link DENY_DENIAL_TERMINOLOGY} explicitly, so an un-wired composition root is a visible "everything
 * resolves to unmapped" choice rather than a silent one.
 */
export async function handleClaimRejected(
  store: DenialSeedStore,
  event: {
    organizationId: string;
    providerEntityId: string;
    claimId: string;
    rejectionCodes: string[];
    occurredAt: string;
  },
  terminology: DenialTerminologyLookupPort,
): Promise<DenialOpenedEmission | null> {
  const carcCode = event.rejectionCodes[0] ?? "16"; // CARC 16 "claim/service lacks information" default
  const { category, taxonomyStatus } = await resolveDenialCategory(terminology, carcCode);
  const result = await store.seedDenial({
    organizationId: event.organizationId,
    providerEntityId: event.providerEntityId,
    claimId: event.claimId,
    sourceEvvAggregatorSubmissionId: null,
    carcCode,
    rarcCode: null,
    category,
    taxonomyStatus,
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
    rarcCode: null,
    category,
    taxonomyStatus,
    source: "claim_rejection_277ca",
    dollarValue: "0",
  };
}

/** m18.evv.aggregator_rejected → seed an EVV-back-linked denial worklist row. `terminology` is REQUIRED —
 *  see {@link handleClaimRejected}'s doc comment. */
export async function handleEvvAggregatorRejected(
  store: DenialSeedStore,
  event: {
    organizationId: string;
    providerEntityId: string;
    aggregatorSubmissionId: string;
    carcCode?: string;
    rarcCode?: string;
  },
  terminology: DenialTerminologyLookupPort,
): Promise<DenialOpenedEmission | null> {
  const carcCode = event.carcCode ?? "16";
  const rarcCode = event.rarcCode ?? "N365"; // RARC N365 "procedure code not payable" — the EVV-mismatch signal
  const { category, taxonomyStatus } = await resolveDenialCategory(terminology, carcCode);
  const result = await store.seedDenial({
    organizationId: event.organizationId,
    providerEntityId: event.providerEntityId,
    claimId: null,
    sourceEvvAggregatorSubmissionId: event.aggregatorSubmissionId,
    carcCode,
    rarcCode,
    category,
    taxonomyStatus,
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
    rarcCode,
    category,
    taxonomyStatus,
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
