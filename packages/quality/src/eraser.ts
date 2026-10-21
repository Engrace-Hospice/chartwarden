// @chartwarden/quality — the M30 tenant-offboarding eraseFn (M4 destruction registry, §3.7 / D6 / §8.4).
//
// On tenant offboarding M30's eraseFn deletes the org's OPERATIONAL quality rows (the transient
// `measure_recompute_queue`, the reproducible `quality_measure_value` aggregate ledger, and the CAHPS
// working rows: `cahps_decedent_sample` → `cahps_vendor_binding`) in FK-safe order, and REFUSES to
// destroy the COMPLIANCE-class survey evidence — the incident register, mortality reviews, the SRA
// chain, the QAPI chain, CoP-citation compliance, infection surveillance, and CAHPS result summaries.
// That evidence is destruction-BLOCKED for the agency's record of having done the work (§418.58 /
// §418.60 / §164.308); it is COUNTED for the destruction certificate but never deleted on offboarding.
// The §3.7 patient-scoped PHI erasure (the partition-aware redaction of `incident_report` /
// `mortality_review` / `infection_surveillance_event` / `cahps_decedent_sample`) is a SEPARATE path the
// per-table erasers own; this tenant-offboarding eraseFn is the operational-row cleanup.
//
// PURE port-injected orchestration (the M33/M34 `eraseTenant*` precedent): the sequence is a total
// function over an injected {@link QualityEraseStore}; the in-memory store backs the slice/tests and the
// composition root injects the Drizzle-backed store (each DELETE under the offboarding tenancy context)
// at P2C. No clock / RNG / Drizzle / `getSeam` import here.

/** The §3.7 ordered erase counts, keyed by table name (the M4 destruction-cert `tableCounts`). */
export type QualityEraseTableCounts = Record<string, number>;

/** The destruction certificate fields the §3.7 co-sign gate reads (supplied once M4 cert-binding lands). */
export interface QualityDecisionCert {
  /** The destruction scope; `org_offboarding` is the only scope that may reach compliance-class evidence. */
  readonly scope: string;
  /** The approver role keys on the certificate (the co-sign gate requires a `compliance_officer`). */
  readonly approverIds: readonly string[];
}

/** Options for one tenant-offboarding erase (the optional M4 destruction certificate driving the co-sign gate). */
export interface QualityEraseOptions {
  readonly decisionCert?: QualityDecisionCert;
}

/**
 * Raised when the §3.7 co-sign gate refuses the erase — an `org_offboarding` certificate that touches
 * compliance-class survey evidence MUST carry a `compliance_officer` approver.
 */
export class QualityEraseRefused extends Error {
  constructor(public readonly code: string) {
    super(`quality erase refused: ${code}`);
    this.name = "QualityEraseRefused";
  }
}

/** The per-table delete + count surface the §3.7 sequence runs through (each DELETE scoped to the org). */
export interface QualityEraseStore {
  /** measure_recompute_queue — the transient recompute worker queue (deleted FIRST). */
  deleteRecomputeQueue(organizationId: string): Promise<number>;
  /** quality_measure_value — the reproducible computed-measure aggregate ledger (operational). */
  deleteMeasureValues(organizationId: string): Promise<number>;
  /**
   * cahps_export_job — the rendered vendor export artifacts (sealed caregiver PHI; GAP-087, migration 0421).
   * OPTIONAL so a store predating the table keeps working; when present it is deleted before the samples.
   */
  deleteCahpsExportJobs?(organizationId: string): Promise<number>;
  /** cahps_decedent_sample — the CAHPS sampling working rows (child of binding; deleted before it). */
  deleteCahpsDecedentSamples(organizationId: string): Promise<number>;
  /** cahps_vendor_binding — the per-org CAHPS vendor adapter config. */
  deleteCahpsVendorBindings(organizationId: string): Promise<number>;
  /** incident_report — COUNT ONLY (compliance class, destruction-blocked — NOT deleted). */
  countIncidents(organizationId: string): Promise<number>;
  /** mortality_review — COUNT ONLY (compliance class, destruction-blocked). */
  countMortalityReviews(organizationId: string): Promise<number>;
  /** sra_cycle + sra_finding + sra_remediation — COUNT ONLY (compliance class, destruction-blocked). */
  countSraEvidence(organizationId: string): Promise<number>;
  /** qapi_program/indicator/project/pip/governance_minutes — COUNT ONLY (compliance class, blocked). */
  countQapiEvidence(organizationId: string): Promise<number>;
  /** cop_compliance_status — COUNT ONLY (compliance class, destruction-blocked). */
  countCopCompliance(organizationId: string): Promise<number>;
  /** infection_surveillance_event + infection_outbreak_case — COUNT ONLY (public-health evidence, blocked). */
  countInfectionEvidence(organizationId: string): Promise<number>;
  /** cahps_result_summary — COUNT ONLY (compliance class, destruction-blocked). */
  countCahpsResults(organizationId: string): Promise<number>;
  /** Emit `m30.tenant_eraser.complete` (best-effort; the slice records it, prod routes the outbox). */
  emitEraserComplete?(payload: {
    organizationId: string;
    tableCounts: QualityEraseTableCounts;
    complianceClassRefused: number;
  }): Promise<void>;
}

/** What one tenant-offboarding erase reported (the M4 destruction-cert facts). */
export interface QualityEraseResult {
  /** Total operational rows destroyed across the §3.7 tables (excludes the refused compliance class). */
  readonly erased: number;
  /** Per-table destruction counts (the compliance-class tables are always 0 — refused). */
  readonly tableCounts: QualityEraseTableCounts;
  /** The compliance-class rows REFUSED destruction (survey / QAPI / SRA / mortality / incident, §3.7). */
  readonly complianceClassRefused: number;
}

/**
 * Erase a tenant's OPERATIONAL quality rows on offboarding (§3.7). Applies the co-sign gate FIRST (an
 * `org_offboarding` certificate without a `compliance_officer` approver is refused), deletes the
 * operational tables in FK-safe order (recompute queue → measure values → CAHPS samples → CAHPS bindings),
 * and REFUSES every compliance-class table (incident / mortality / SRA / QAPI / CoP / infection / CAHPS
 * results — counted, never deleted). Emits `m30.tenant_eraser.complete` with the counts.
 *
 * @throws {QualityEraseRefused} the §3.7 co-sign gate denied the erase
 *   (`compliance_class_destruction_needs_co_sign`)
 */
export async function eraseTenantQuality(
  organizationId: string,
  store: QualityEraseStore,
  options: QualityEraseOptions = {},
): Promise<QualityEraseResult> {
  // §3.7 step 1 — co-sign gate: an offboarding that reaches compliance-class survey evidence needs co-sign.
  const cert = options.decisionCert;
  if (cert?.scope === "org_offboarding" && !cert.approverIds.includes("compliance_officer")) {
    throw new QualityEraseRefused("compliance_class_destruction_needs_co_sign");
  }

  // §3.7 step 2 — ordered operational erase (recompute queue → measure values → CAHPS samples → bindings).
  const tableCounts: QualityEraseTableCounts = {
    measure_recompute_queue: await store.deleteRecomputeQueue(organizationId),
    quality_measure_value: await store.deleteMeasureValues(organizationId),
    ...(store.deleteCahpsExportJobs
      ? { cahps_export_job: await store.deleteCahpsExportJobs(organizationId) }
      : {}),
    cahps_decedent_sample: await store.deleteCahpsDecedentSamples(organizationId),
    cahps_vendor_binding: await store.deleteCahpsVendorBindings(organizationId),
  };

  // §3.7 step 3 — the compliance-class survey evidence is destruction-BLOCKED: count, never delete.
  const refusedCounts = {
    incident_report: await store.countIncidents(organizationId),
    mortality_review: await store.countMortalityReviews(organizationId),
    sra_evidence: await store.countSraEvidence(organizationId),
    qapi_evidence: await store.countQapiEvidence(organizationId),
    cop_compliance_status: await store.countCopCompliance(organizationId),
    infection_evidence: await store.countInfectionEvidence(organizationId),
    cahps_result_summary: await store.countCahpsResults(organizationId),
  };
  const complianceClassRefused = Object.values(refusedCounts).reduce((sum, n) => sum + n, 0);
  // Surface the refused tables in the per-table map at 0 (never deleted) for the destruction cert.
  for (const table of Object.keys(refusedCounts)) tableCounts[table] = 0;

  const erased = Object.values(tableCounts).reduce((sum, n) => sum + n, 0);

  // §3.7 step 4 — emit `m30.tenant_eraser.complete` (M4 records the per-table counts on the cert).
  await store.emitEraserComplete?.({ organizationId, tableCounts, complianceClassRefused });

  return { erased, tableCounts, complianceClassRefused };
}

// ── in-memory store (slice + tests) ──────────────────────────────────────────────────────────────────────

/** A deterministic in-memory {@link QualityEraseStore} seeded with per-org row counts (slice + tests). */
export interface QualityEraseSeed {
  /** Per-org seeded counts keyed by table name (absent table ⇒ 0 rows). */
  readonly counts?: Readonly<Record<string, Partial<QualityEraseTableCounts>>>;
}

/** Inspection surface over the in-memory erase store (the acceptance tests assert against it). */
export interface QualityEraseStoreInspect {
  emittedCompletions(): ReadonlyArray<{
    organizationId: string;
    tableCounts: QualityEraseTableCounts;
    complianceClassRefused: number;
  }>;
}

/**
 * Build a deterministic in-memory {@link QualityEraseStore}. Each `delete*` returns its seeded count then
 * zeroes it (a second erase of the same org returns 0 — idempotent); each `count*` returns its seeded count
 * WITHOUT zeroing (compliance evidence is never destroyed); `emitEraserComplete` records the payload.
 */
export function createInMemoryQualityEraseStore(seed: QualityEraseSeed = {}): {
  store: QualityEraseStore;
  inspect: QualityEraseStoreInspect;
} {
  const counts = new Map<string, Map<string, number>>();
  for (const [org, tables] of Object.entries(seed.counts ?? {})) {
    counts.set(org, new Map(Object.entries(tables).map(([t, n]) => [t, n ?? 0])));
  }
  const emitted: {
    organizationId: string;
    tableCounts: QualityEraseTableCounts;
    complianceClassRefused: number;
  }[] = [];

  const take = (org: string, table: string): number => {
    const n = counts.get(org)?.get(table) ?? 0;
    counts.get(org)?.set(table, 0);
    return n;
  };
  const peek = (org: string, table: string): number => counts.get(org)?.get(table) ?? 0;

  const store: QualityEraseStore = {
    deleteRecomputeQueue: async (org) => take(org, "measure_recompute_queue"),
    deleteMeasureValues: async (org) => take(org, "quality_measure_value"),
    deleteCahpsDecedentSamples: async (org) => take(org, "cahps_decedent_sample"),
    deleteCahpsVendorBindings: async (org) => take(org, "cahps_vendor_binding"),
    countIncidents: async (org) => peek(org, "incident_report"),
    countMortalityReviews: async (org) => peek(org, "mortality_review"),
    countSraEvidence: async (org) => peek(org, "sra_evidence"),
    countQapiEvidence: async (org) => peek(org, "qapi_evidence"),
    countCopCompliance: async (org) => peek(org, "cop_compliance_status"),
    countInfectionEvidence: async (org) => peek(org, "infection_evidence"),
    countCahpsResults: async (org) => peek(org, "cahps_result_summary"),
    emitEraserComplete: async (payload) => {
      emitted.push(payload);
    },
  };

  return { store, inspect: { emittedCompletions: () => emitted } };
}
