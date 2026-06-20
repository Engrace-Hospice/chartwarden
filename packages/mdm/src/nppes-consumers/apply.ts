// @wardenx/mdm — the M29 NPPES-sync consumer logic (M40-T09, spec §4.7, §7.11–7.12).
//
// M29 (the HL7/NPPES interop module, Wave H) owns the public NPPES sync and publishes
// `m29.nppes.provider_synced` / `m29.nppes.provider_deactivated`. M40 CONSUMES them to keep its
// physician canonical current WITHOUT running its own nightly job (the §7.11 happy path). M29 is
// not built yet, so the backend registration is a forward-seam DENY-STUB (outbox-consumers/) — but
// the DECISION logic ships now, pure and tested, so wiring M29 later (W-M40-12/13) is just binding
// the Drizzle ports.
//
// ADR-0011 D1 / M40-F01: M40 NEVER reads M29's `nppes_provider` table (a same-tenant cross-module
// table access). The synced snapshot arrives ON the event payload (`payload.provider`); if a needed
// field is absent, M40 calls M29's published `NppesProviderReader` seam — never the table. D10: a
// stand-alone NPPES sync does NOT auto-create a canonical (no-canonical → skip). Minimum-update: only
// the fields M29 flagged as changed AND that actually differ are written.

/** The canonical physician fields the consumer compares/updates (a projection of `external_physician`). */
export interface NppesCanonicalPhysician {
  readonly id: string;
  readonly npi: string;
  readonly status: "active" | "deactivated" | "merged" | "provisional";
  readonly firstName: string;
  readonly lastName: string;
  readonly credentials: string | null;
  readonly specialtyTaxonomy: string | null;
}

/** The synced NPPES snapshot M29 carries on the event (the source-of-truth fields, §4.7.1). */
export interface NppesProviderSnapshot {
  readonly firstName: string;
  readonly lastName: string;
  readonly credentials: string | null;
  readonly specialtyTaxonomy: string | null;
}

/** `m29.nppes.provider_synced` payload (§4.7.1). `changedFields` is M29's per-upsert diff. */
export interface M29ProviderSyncedPayload {
  readonly npi: string;
  readonly action: "inserted" | "updated";
  readonly changedFields: readonly string[];
  readonly syncedAt: string;
  readonly syncRunId: string;
  /** The synced snapshot carried on the event (ADR-0011 D1 — never read from M29's table). */
  readonly provider: NppesProviderSnapshot;
}

/** `m29.nppes.provider_deactivated` payload (§4.7.2). */
export interface M29ProviderDeactivatedPayload {
  readonly npi: string;
  readonly deactivationDate: string;
  readonly deactivationReason: string;
  readonly detectedAt: string;
}

/** The nppes_provenance stamp written on a successful apply (§7.11 D10). */
export interface NppesProvenance {
  readonly lastSyncedAt: string;
  readonly lastSyncSource: "m29_platform_sync";
  readonly lastSyncRunId: string;
  readonly lastChangedFields: readonly string[];
}

/** The decision `decideProviderSynced` returns: the outcome + the fields/values to write. */
export interface ProviderSyncedDecision {
  readonly outcome: "updated_canonical" | "no_canonical_skipped" | "no_op";
  readonly appliedChanges: readonly string[];
  /** The column→value patch (incl. `nppesProvenance`) when `updated_canonical`; empty otherwise. */
  readonly updates: Readonly<Record<string, unknown>>;
}

/** The §4.7.1 minimum-update fields M40 maps from the NPPES snapshot (aligned to `external_physician`). */
const SYNCABLE_FIELDS = ["firstName", "lastName", "credentials", "specialtyTaxonomy"] as const;
type SyncableField = (typeof SYNCABLE_FIELDS)[number];

/**
 * Decide how a `provider_synced` event applies to the current canonical (§4.7.1, pure). No canonical
 * → `no_canonical_skipped` (D10: never auto-create from a stand-alone sync). Otherwise apply only the
 * fields M29 flagged as changed AND whose value actually differs (minimum-update); an empty applied
 * set → `no_op` (idempotent re-delivery). On a real change, stamp `nppesProvenance`.
 */
export function decideProviderSynced(
  payload: M29ProviderSyncedPayload,
  canonical: NppesCanonicalPhysician | null,
): ProviderSyncedDecision {
  if (canonical === null) {
    return { outcome: "no_canonical_skipped", appliedChanges: [], updates: {} };
  }
  const changed = new Set(payload.changedFields);
  const updates: Record<string, unknown> = {};
  const appliedChanges: string[] = [];
  for (const field of SYNCABLE_FIELDS) {
    if (changed.has(field) && canonical[field] !== payload.provider[field as SyncableField]) {
      updates[field] = payload.provider[field as SyncableField];
      appliedChanges.push(field);
    }
  }
  if (appliedChanges.length === 0) {
    return { outcome: "no_op", appliedChanges: [], updates: {} };
  }
  const provenance: NppesProvenance = {
    lastSyncedAt: payload.syncedAt,
    lastSyncSource: "m29_platform_sync",
    lastSyncRunId: payload.syncRunId,
    lastChangedFields: appliedChanges,
  };
  return { outcome: "updated_canonical", appliedChanges, updates: { ...updates, nppesProvenance: provenance } };
}

/** The decision `decideProviderDeactivated` returns (§4.7.2). */
export type ProviderDeactivatedOutcome =
  | "deactivated_canonical"
  | "no_canonical_observed"
  | "already_deactivated";

/**
 * Decide how a `provider_deactivated` event applies (§4.7.2, pure). No canonical → observe-only
 * (`no_canonical_observed`, audited but no row). Already `deactivated` → idempotent no-op. Otherwise
 * the canonical flips to `deactivated`.
 */
export function decideProviderDeactivated(
  canonical: NppesCanonicalPhysician | null,
): ProviderDeactivatedOutcome {
  if (canonical === null) return "no_canonical_observed";
  if (canonical.status === "deactivated") return "already_deactivated";
  return "deactivated_canonical";
}

// --- port-bound handlers (the slice/production binding target) --------------------------------

/** Ports the NPPES consumers bind (Drizzle canonical lookup/write + M36 alert + audit + event). */
export interface NppesConsumerPorts {
  /** Look up the physician canonical by NPI (D10; via platform context in production). */
  findCanonicalByNpi(npi: string): Promise<NppesCanonicalPhysician | null>;
  /** Apply a canonical patch via `mdm_canonical_writer` (M40-T03). */
  applyCanonicalUpdate(canonicalId: string, updates: Readonly<Record<string, unknown>>): Promise<void>;
  /** Flip a canonical physician to `deactivated`. */
  applyDeactivation(canonicalId: string): Promise<void>;
  /** Emit `m40.canonical_updated` so downstream consumers refresh caches (§7.11). */
  emitCanonicalUpdated(event: {
    kind: "physician";
    id: string;
    changedFields: readonly string[];
  }): Promise<void>;
  /** Orgs to alert on a deactivation (is_preferred / active patient) (§4.7.2). */
  tenantsToAlert(canonicalId: string): Promise<readonly string[]>;
  /** Emit the M36 deactivation alert to an org. */
  emitDeactivationAlert(orgId: string, canonicalId: string, npi: string): Promise<void>;
  /** Record an observe-only audit when a deactivation arrives for an unknown NPI (§4.7.2). */
  writeDeactivationObservedAudit(npi: string, reason: string): Promise<void>;
}

/** Handle `m29.nppes.provider_synced` over ports (§4.7.1). Returns the decision for logging. */
export async function handleProviderSynced(
  payload: M29ProviderSyncedPayload,
  ports: NppesConsumerPorts,
): Promise<ProviderSyncedDecision> {
  const canonical = await ports.findCanonicalByNpi(payload.npi);
  const decision = decideProviderSynced(payload, canonical);
  if (decision.outcome === "updated_canonical" && canonical !== null) {
    await ports.applyCanonicalUpdate(canonical.id, decision.updates);
    await ports.emitCanonicalUpdated({ kind: "physician", id: canonical.id, changedFields: decision.appliedChanges });
  }
  return decision;
}

/** Handle `m29.nppes.provider_deactivated` over ports (§4.7.2). Returns the outcome for logging. */
export async function handleProviderDeactivated(
  payload: M29ProviderDeactivatedPayload,
  ports: NppesConsumerPorts,
): Promise<ProviderDeactivatedOutcome> {
  const canonical = await ports.findCanonicalByNpi(payload.npi);
  const outcome = decideProviderDeactivated(canonical);
  if (outcome === "deactivated_canonical" && canonical !== null) {
    await ports.applyDeactivation(canonical.id);
    const orgs = await ports.tenantsToAlert(canonical.id);
    for (const orgId of orgs) await ports.emitDeactivationAlert(orgId, canonical.id, payload.npi);
  } else if (outcome === "no_canonical_observed") {
    await ports.writeDeactivationObservedAudit(payload.npi, payload.deactivationReason);
  }
  return outcome;
}
