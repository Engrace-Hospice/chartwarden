// @chartwarden/quality — M30 §4.5 CAHPS vendor adapter contract (resolves ADR-005).
//
// M30 ships a pluggable CAHPS-Hospice survey-vendor adapter pattern with Strategic Healthcare Programs
// (SHP) as the platform default. The CONCRETE adapter classes live in `@chartwarden/cahps-vendors` (one
// folder per vendor); this file owns the published INTERFACE they implement plus the two supporting
// domain shapes. Keeping the interface here (rather than in `cahps-vendors/src/types.ts`, where the spec
// drafts it) lets `@chartwarden/cahps-vendors` depend on `@chartwarden/quality` for the contract without a
// dependency cycle — both packages are M30-owned (manifest codePaths), so the edge is intra-module.
//
// P2a is PURE DOMAIN: this is an interface + value types only. No I/O, no DB, no Fastify.
import type { schema } from "@chartwarden/db";

/**
 * The vendor's display identity as carried on the adapter instance (§4.5). Mixed-case, human-facing —
 * distinct from {@link CahpsVendorAdapterId}, the lower-snake id persisted on `cahps_vendor_binding`.
 */
export type CahpsVendor = "SHP" | "Press_Ganey" | "Deyta" | "HEALTHCAREfirst" | "manual";

/**
 * The persisted adapter id (V-6) stored in `cahps_vendor_binding.vendor_adapter_id` and used as the key
 * of the per-org adapter-class resolution map. Lower-snake by convention so it is URL/config-safe.
 */
export type CahpsVendorAdapterId = "shp" | "press_ganey" | "deyta" | "healthcarefirst" | "manual";

/**
 * One decedent on the monthly CAHPS sample, projected for VENDOR EXPORT (§4.5 SHP layout). The
 * envelope-encrypted `primary_caregiver_contact_cipher` on `cahps_decedent_sample` is decrypted to these
 * plaintext fields immediately before render and never persisted in the clear. Per §4.13 the platform-only
 * `death_source` marker is deliberately ABSENT here — CMS sampling rules do not expose it to the vendor.
 */
export interface CahpsDecedentSampleRow {
  /** Stable id of the `cahps_decedent_sample` row (the vendor's `decedent_id`). */
  readonly decedentId: string;
  /** ISO-8601 date of death (the vendor's `deceased_date`). */
  readonly deceasedDate: string;
  /** Decrypted primary-caregiver name (PHI; present only in-flight during render). */
  readonly primaryCaregiverName: string;
  /** Decrypted primary-caregiver phone, or null when none is on file. */
  readonly primaryCaregiverPhone: string | null;
  /** Decrypted primary-caregiver email, or null when none is on file. */
  readonly primaryCaregiverEmail: string | null;
  /** Coded CMS exclusion reason, or null when the decedent is survey-eligible. */
  readonly exclusionReason: string | null;
  /** ISO 639-1 caregiver language preference for the survey (e.g. "en", "es"). */
  readonly languagePreference: string;
}

/**
 * One parsed CAHPS result row, in the shape a `cahps_result_summary` INSERT consumes (the org id, surrogate
 * id, and `ingested_at` are supplied server-side at write time, so they are absent here). Aggregate-only:
 * top-box / composite scores plus response counts — no patient-level PHI. Returned by
 * {@link CahpsVendorAdapter.parseResultIngest}.
 */
export interface CahpsResultSummaryInput {
  /** Logical FK to the M40 provider entity the results belong to. */
  readonly providerEntityId: string;
  /** ISO-8601 reporting-period start (inclusive). */
  readonly reportingPeriodStart: string;
  /** ISO-8601 reporting-period end (inclusive). */
  readonly reportingPeriodEnd: string;
  /** The vendor-of-record that produced the results. */
  readonly vendorAdapterId: CahpsVendorAdapterId;
  /** Per-question top-box percentages, keyed by question code. */
  readonly topBoxPercentages: schema.CahpsTopBoxPercentages;
  /** The six CMS CAHPS composites, keyed by composite code. */
  readonly compositeScores: schema.CahpsCompositeScores;
  /** Completed-survey response count for the period. */
  readonly responseCount: number;
  /** Attempted-sample count for the period (denominator of the response rate). */
  readonly attemptedSampleCount: number;
  /** Response rate in `[0,1]`, or null when the vendor does not supply it. */
  readonly responseRate: number | null;
  /** SHA-256 (hex) over the raw vendor payload — the idempotency / dedup key for the row. */
  readonly vendorResponsePayloadHash: string;
}

/**
 * The published CAHPS vendor-adapter contract (§4.5, verbatim). One class per vendor in
 * `@chartwarden/cahps-vendors` implements this; the per-org live instance is resolved through a
 * {@link import("./registry").CahpsAdapterRegistry} keyed by `orgId`, so cross-tenant invocation is
 * structurally impossible. All methods are pure with respect to the platform — the only side-effect a
 * concrete adapter may have is the (injected) vendor HTTP call inside `pushExport`.
 */
export interface CahpsVendorAdapter {
  readonly vendor: CahpsVendor;

  /** Validate the org-level binding config (API keys, endpoints, account ids). */
  validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ ok: true } | { ok: false; errors: { field: string; reason: string }[] }>;

  /** Render the monthly decedent sample to the vendor's required file format. */
  renderExport(
    orgId: string,
    samplePeriod: { start: string; end: string },
    decedents: CahpsDecedentSampleRow[],
  ): Promise<{ filename: string; mimeType: string; bytes: Buffer }>;

  /** Optionally push the export to the vendor's intake endpoint; the manual adapter returns 'no_push'. */
  pushExport(
    orgId: string,
    file: { filename: string; mimeType: string; bytes: Buffer },
    config: Record<string, unknown>,
  ): Promise<{ status: "pushed"; vendorJobId: string } | { status: "no_push"; reason: string }>;

  /** Parse a vendor-supplied aggregated result file into our `CahpsResultSummaryInput` shape. */
  parseResultIngest(payload: Buffer): Promise<CahpsResultSummaryInput[]>;

  /** The vendor's documented field-level minimum-cell-size rule (CMS protects ≤30 respondents). */
  minimumCellSize(): number; // defaults to 30 per CMS protocol; vendors may impose higher
}
