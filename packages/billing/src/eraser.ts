// @wardenx/billing — the M23 tenant-offboarding / per-patient destruction eraseFn contract (M4 destruction
// registry, §3.7 / §8.4). The billing record is COMPLIANCE-class (7 years past final action per CMS
// 42 CFR §424 / §405 + state override, M4 D1); the eraser is keyed on retention class `billing_record`.
//
// PURE port-injected orchestration (the M27/M30/M34 `eraseTenant*` precedent): the sequence is a total
// function over an injected {@link BillingEraseStore}; the composition root injects the Drizzle-backed
// store (each DELETE/redact under the offboarding/erasure tenancy context) in P3. No clock / RNG /
// Drizzle / `getSeam` import here.
//
// NO MBI is ever stored, so the MBI digit is NOT an eraser field (§3.6 — it never persists). The cascade
// below is the §3.7 per-patient FK-unwind order; platform-shared reference rows (`wage_index_factor`,
// `sequestration_policy` platform-default) are NOT cascaded; `mac_submitter_credential` is destroyed at
// ORGANIZATION-destruction (cryptographic shred of `client_secret_cipher`), not per-patient erasure.

/** The retention-class key M23 registers its eraser under (M4 destruction-cert registry). */
export const M23_RETENTION_CLASS = "billing_record" as const;

/** The §3.7 ordered erase counts keyed by table (the M4 destruction-cert `tableCounts`). */
export type BillingEraseTableCounts = Record<string, number>;

/**
 * The §3.7 per-patient cascade order. Children first so FKs unwind cleanly; `claim` after its line/calc
 * children; `noe_record` / `notr_record` last (independent fast-path entities). The MUTABLE marker tables
 * are redacted (free-text PHI fields), the append-only tables are deleted in-cascade.
 */
export const M23_PATIENT_CASCADE_ORDER = [
  "eligibility_check",
  "claim_acknowledgment",
  "claim_submission",
  "claim_state_history",
  "validation_override",
  "validation_result",
  "validation_run",
  "sia_calculation",
  "hipps_calculation",
  "claim_line",
  "claim",
  "noe_record",
  "notr_record",
] as const;

export type M23PatientCascadeTable = (typeof M23_PATIENT_CASCADE_ORDER)[number];

/**
 * The free-text fields that may carry incidental PHI mentions — redacted (not just dropped) during the
 * erase. `mac_submitter_credential.client_secret_cipher` is a CRYPTOGRAPHIC SHRED (rotate DEK, zero-fill
 * ciphertext), performed at org-destruction. The MBI is deliberately ABSENT — it never persists (§3.6).
 */
export const M23_REDACT_FIELDS = [
  "claim.replacement_reason",
  "validation_override.reason",
  "sequestration_policy.set_reason",
  "mac_submitter_credential.client_secret_cipher",
  "noe_record.patient_id_ref",
  "notr_record.patient_id_ref",
  "claim.patient_id_ref",
  "eligibility_check.patient_id_ref",
] as const;

/** Raised when the §3.7 gate refuses an erase that would destroy an in-flight or surveyor-held billing record. */
export class BillingEraseRefused extends Error {
  constructor(public readonly code: string) {
    super(`billing erase refused: ${code}`);
    this.name = "BillingEraseRefused";
  }
}

/**
 * The per-table delete/redact surface the §3.7 sequence runs through (each scoped to the org/patient).
 * P3 wires the Drizzle-backed implementation. TODO(P3): the org-destruction path additionally shreds
 * `mac_submitter_credential.client_secret_cipher`.
 */
export interface BillingEraseStore {
  /** Per-patient cascade — deletes/redacts every owned table in {@link M23_PATIENT_CASCADE_ORDER}. */
  erasePatientBillingRecord(input: {
    organizationId: string;
    patientId: string;
  }): Promise<BillingEraseTableCounts>;

  /** Org-destruction — operational config + MAC credential cryptographic shred (NOT platform-shared rows). */
  eraseOrgBillingConfig(input: { organizationId: string }): Promise<BillingEraseTableCounts>;
}

/** The eraseFn shape registered into M4 under {@link M23_RETENTION_CLASS}. */
export interface BillingMedicareEraser {
  readonly retentionClass: typeof M23_RETENTION_CLASS;
  readonly cascade: readonly M23PatientCascadeTable[];
  readonly redactFields: readonly string[];
}

/** The static eraser descriptor M23 registers with M4 (the live store is injected at P3). */
export const billingMedicareEraser: BillingMedicareEraser = {
  retentionClass: M23_RETENTION_CLASS,
  cascade: M23_PATIENT_CASCADE_ORDER,
  redactFields: M23_REDACT_FIELDS,
};
