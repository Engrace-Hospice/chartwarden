// @wardenx/mdm — the `BaaStatusProvider` seam (M40-T06, spec §4.6, §7.7).
//
// The FOCUSED BAA-gate seam, registered SEPARATELY from the omnibus `MdmEntityProvider` (§4.6.1).
// M29's HL7 paths and M22/M28's disclosure paths have needs the chart-load omnibus does not: an
// inbound listener (T-29.04) has a free-text MSH-4 `sendingFacility` code with no entity id, and an
// outbound dispatcher (T-29.08) needs `asOf` time-travel — "the BAA was active when we attempted
// transmission, but is it active at the moment we actually transmit?". This seam pins those two
// contracts without bloating the 25+-consumer omnibus. M29 imports `BaaStatusProvider` only.
//
// Like the other M40 seam, its interface lives HERE in the feature package; the M1 registry holds
// the instance opaquely (`SeamContracts["BaaStatusProvider"] = unknown`) and validates it
// fail-closed at boot. The real as-of decision is the pure {@link decideBaaStatus} engine (baa/gate.ts).

/** The §4.6.1 BAA status. `expired` is distinct from `missing` — an executed BAA past its
 *  `expires_on` as-of the disclosure moment, vs. one that never existed. */
export type BaaStatusKind = "executed" | "pending" | "n_a" | "missing" | "expired";

/**
 * The kinds a BAA gate is asked about (§4.6.1) — the PHI-disclosure recipient kinds. Note this
 * EXCLUDES `physician`/`pharmacy`: the gate guards out-of-perimeter disclosure to facilities,
 * payers, referral sources, DME vendors, and funeral homes.
 */
export type BaaEntityKind =
  | "facility"
  | "payer"
  | "referral_source"
  | "dme_vendor"
  | "funeral_home";

/** The §4.6.1 gate result. `isActive` means "may we disclose?" — true for both `executed` and the
 *  `n_a` "no BAA needed" case; false for `missing`/`pending`/`expired`. */
export interface BaaStatusResult {
  /** True when disclosure is permitted: an active BAA at `asOf`, OR the kind needs no BAA (`n_a`). */
  readonly isActive: boolean;
  readonly status: BaaStatusKind;
  /** ISO yyyy-mm-dd of the governing record's expiry, or `null` (no record / no expiry). */
  readonly expiresOn: string | null;
  /** False → this recipient kind doesn't need a BAA per policy (e.g. a DME vendor with no PHI flow). */
  readonly requiredByPolicy: boolean;
  /** The `mdm_baa_record` row that decided this, or `null` when `n_a`/`missing` (no record). */
  readonly baaRecordId: string | null;
}

/**
 * The focused BAA-gate seam (§4.6.1). Both methods resolve to a canonical entity and decide the
 * gate as-of the supplied moment. Consumed by M29 (T-29.04 inbound / T-29.08 outbound), M22
 * (document disclosure), and M28 (FHIR export) before any PHI leaves the perimeter (§7.7).
 */
export interface BaaStatusProvider {
  /**
   * Inbound case — partner identified by free-text MSH-4 `sendingFacility` code (§7.9 / W-M40-10).
   * Resolves to an M40 `facility` canonical via `facility.sending_facility_codes` (case-insensitive).
   * No matching facility → `{ isActive: false, status: 'missing', requiredByPolicy: true, … }`.
   */
  baaStatusBySendingFacility(input: {
    orgId: string;
    sendingFacility: string;
    asOf: Date;
  }): Promise<BaaStatusResult>;

  /**
   * Outbound case — partner identified by M40 entity (kind + id) with `asOf` time-travel (§7.10 /
   * W-M40-11). Consumed by T-29.08 outbound dispatcher, T-29.10 credential rotation, M22 disclosure.
   */
  baaStatusByMdmEntity(input: {
    orgId: string;
    kind: BaaEntityKind;
    id: string;
    asOf: Date;
  }): Promise<BaaStatusResult>;
}
