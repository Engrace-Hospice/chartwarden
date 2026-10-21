// @wardenx/triage-vendors — D13 PHI minimization at the external-triage-vendor boundary (M19-T01).
//
// HIPAA §164.502(b) / §164.514(d) minimum necessary: the vendor operator needs enough to run a triage
// protocol, not the chart. D13 fixes two Phase-1 profiles and makes the outbound body a discriminated
// union so a field the profile does not permit is a BUILD error rather than a packet a pen-tester finds
// (§7.10). This module is the ONLY place that translation happens.
//
// TWO LAYERS, deliberately:
//   1. `VendorOutboundPayload` — the compile-time guarantee. Its arms carry only permitted fields, so
//      TypeScript's excess-property check refuses `lastName` at the construction site.
//   2. `findLeakedSourceValues()` — the runtime guarantee. Types are erased before the socket, and a
//      body assembled through `unknown`/`JSON.parse`/a vendor SDK's own builder is outside the type
//      system entirely. The scan compares the SERIALIZED body against the denylisted values of the
//      source context it came from, which is exactly the assertion §7.10's packet capture makes.
// Layer 2 exists because layer 1 is the guarantee people believe they have and layer 2 is the one that
// survives contact with an adapter written by someone else.

import { ChartWardenError } from "@wardenx/types";

/** D13 — the two Phase-1 minimization profiles. `centralized` vendors select dispositions inside their
 *  own scope and therefore need slightly more structured chart context than `hybrid` vendors, who only
 *  run the protocol and escalate. */
export type VendorMinimizationProfile = "hybrid_phi_min" | "centralized_phi_min";

/** §7.5 — how many current medications the `hybrid_phi_min` projection carries ("top-5 current meds"). */
export const HYBRID_TOP_N_MEDICATIONS = 5;

/** `centralized_phi_min` carries a longer med list because the operator dispositions against it. */
export const CENTRALIZED_TOP_N_MEDICATIONS = 10;

/**
 * §164.514(b)(2)(i)(C) — ages over 89 are a safe-harbor identifier and must be aggregated. A hospice
 * census is old enough that this is a live case on most nights, not a theoretical one, so age crosses
 * the boundary as a band and the raw number for a 94-year-old never leaves the building.
 */
export const HIPAA_AGE_AGGREGATION_FLOOR = 90;

/** The age projection the vendor receives. */
export type VendorAge =
  | { readonly kind: "years"; readonly years: number }
  | { readonly kind: "ninety_plus" };

/**
 * The FULL internal context M19 assembles before minimization. It is the input on purpose: making the
 * minimizer the only function that ever sees both sides is what lets `findLeakedSourceValues` know what
 * a leak would even look like. Nothing in this shape is transmitted; the return value is.
 */
export interface TriageVendorSourceContext {
  readonly patientId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly medicalRecordNumber: string | null;
  /** Whole years as of the call. Banded on the way out per {@link HIPAA_AGE_AGGREGATION_FLOOR}. */
  readonly ageYears: number;
  readonly dateOfBirth: string | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly postalCode: string | null;
  readonly phoneE164: string | null;
  readonly caregiverName: string | null;
  readonly caregiverPhoneE164: string | null;
  readonly codeStatusDnr: boolean;
  readonly allergies: readonly string[];
  /** Ordered most-relevant-first; the projection takes the profile's top N. */
  readonly currentMedications: readonly string[];
  readonly primaryDiagnosisLabel: string;
  readonly primaryDiagnosisIcd10: string | null;
  /** `centralized_phi_min` only — the structured chart fields a disposition needs. */
  readonly levelOfCare: string | null;
  readonly recentVitalsSummary: string | null;
  readonly activeProblemLabels: readonly string[];
  /** Never transmitted under any profile: the clinician's raw chart notes. */
  readonly rawChartNotes: string | null;
}

/** The `hybrid_phi_min` body: first name, age, code status, allergies, top-N meds, primary diagnosis. */
export interface HybridVendorOutboundPayload {
  readonly profile: "hybrid_phi_min";
  /** An M19-side opaque handle. NOT the patient id — see {@link minimizeForVendor}. */
  readonly patientRef: string;
  readonly firstName: string;
  readonly age: VendorAge;
  readonly codeStatusDnr: boolean;
  readonly allergies: readonly string[];
  readonly currentMedications: readonly string[];
  readonly primaryDiagnosisLabel: string;
  readonly primaryDiagnosisIcd10: string | null;
}

/** The `centralized_phi_min` body: everything `hybrid` carries plus the structured fields a vendor
 *  operator needs to select a disposition within their scope. Still no name beyond the first, no MRN,
 *  no address, no caregiver, no raw notes. */
export interface CentralizedVendorOutboundPayload {
  readonly profile: "centralized_phi_min";
  readonly patientRef: string;
  readonly firstName: string;
  readonly age: VendorAge;
  readonly codeStatusDnr: boolean;
  readonly allergies: readonly string[];
  readonly currentMedications: readonly string[];
  readonly primaryDiagnosisLabel: string;
  readonly primaryDiagnosisIcd10: string | null;
  readonly levelOfCare: string | null;
  readonly recentVitalsSummary: string | null;
  readonly activeProblemLabels: readonly string[];
}

/** D13 — the compile-time-enforced outbound body, discriminated by profile. */
export type VendorOutboundPayload = HybridVendorOutboundPayload | CentralizedVendorOutboundPayload;

/** The keys each profile permits on the wire, at ANY depth — `kind`/`years` are {@link VendorAge}'s own
 *  nested keys and are listed because the guard walks the whole body, not just its top level. The guard
 *  rejects anything else, so an adapter that hand-rolls a body cannot quietly widen the projection. */
export const VENDOR_PAYLOAD_ALLOWED_KEYS: {
  readonly [P in VendorMinimizationProfile]: readonly string[];
} = {
  hybrid_phi_min: [
    "profile",
    "patientRef",
    "firstName",
    "age",
    "kind",
    "years",
    "codeStatusDnr",
    "allergies",
    "currentMedications",
    "primaryDiagnosisLabel",
    "primaryDiagnosisIcd10",
  ],
  centralized_phi_min: [
    "profile",
    "patientRef",
    "firstName",
    "age",
    "kind",
    "years",
    "codeStatusDnr",
    "allergies",
    "currentMedications",
    "primaryDiagnosisLabel",
    "primaryDiagnosisIcd10",
    "levelOfCare",
    "recentVitalsSummary",
    "activeProblemLabels",
  ],
} as const;

/** The source fields that may never appear in an outbound body under ANY profile (D13, §7.10: "zero
 *  full names, zero MRNs, zero addresses, zero caregiver names, zero raw chart notes"). */
export const VENDOR_DENYLISTED_SOURCE_FIELDS = [
  "patientId",
  "lastName",
  "medicalRecordNumber",
  "dateOfBirth",
  "addressLine1",
  "addressLine2",
  "city",
  "postalCode",
  "phoneE164",
  "caregiverName",
  "caregiverPhoneE164",
  "rawChartNotes",
] as const satisfies readonly (keyof TriageVendorSourceContext)[];

export type VendorDenylistedSourceField = (typeof VENDOR_DENYLISTED_SOURCE_FIELDS)[number];

/** Thrown when a body about to leave for a vendor carries something the profile does not permit. The
 *  caller treats this as fatal: the call falls back to the in-agency path rather than transmitting. */
export class VendorPhiMinimizationError extends ChartWardenError {
  constructor(
    message: string,
    public readonly leakedFields: readonly string[],
  ) {
    super("VENDOR_PHI_MINIMIZATION_VIOLATION", message, 500);
    this.name = "VendorPhiMinimizationError";
  }
}

/** Band an age per the safe-harbor floor. */
export function toVendorAge(ageYears: number): VendorAge {
  if (!Number.isFinite(ageYears) || ageYears < 0) {
    throw new VendorPhiMinimizationError(`age_not_representable: ${ageYears}`, ["ageYears"]);
  }
  return ageYears >= HIPAA_AGE_AGGREGATION_FLOOR
    ? { kind: "ninety_plus" }
    : { kind: "years", years: Math.floor(ageYears) };
}

/**
 * Build the outbound body for a profile.
 *
 * Every field is copied by NAME. There is no spread of the source anywhere in this function, and that is
 * the point: `{ ...ctx, lastName: undefined }` type-checks, serializes a `lastName` key, and is how this
 * kind of boundary usually fails.
 *
 * `patientRef` is `opaquePatientRef`, not `patientId`. The internal uuid is a stable cross-tenant
 * correlator a vendor could accumulate across engagements; the caller passes a per-vendor-per-call
 * handle instead, and the runtime guard treats a raw `patientId` on the wire as a leak.
 */
export function minimizeForVendor(
  profile: VendorMinimizationProfile,
  ctx: TriageVendorSourceContext,
  opaquePatientRef: string,
): VendorOutboundPayload {
  const age = toVendorAge(ctx.ageYears);
  const allergies = [...ctx.allergies];

  if (profile === "hybrid_phi_min") {
    return {
      profile: "hybrid_phi_min",
      patientRef: opaquePatientRef,
      firstName: ctx.firstName,
      age,
      codeStatusDnr: ctx.codeStatusDnr,
      allergies,
      currentMedications: ctx.currentMedications.slice(0, HYBRID_TOP_N_MEDICATIONS),
      primaryDiagnosisLabel: ctx.primaryDiagnosisLabel,
      primaryDiagnosisIcd10: ctx.primaryDiagnosisIcd10,
    };
  }

  return {
    profile: "centralized_phi_min",
    patientRef: opaquePatientRef,
    firstName: ctx.firstName,
    age,
    codeStatusDnr: ctx.codeStatusDnr,
    allergies,
    currentMedications: ctx.currentMedications.slice(0, CENTRALIZED_TOP_N_MEDICATIONS),
    primaryDiagnosisLabel: ctx.primaryDiagnosisLabel,
    primaryDiagnosisIcd10: ctx.primaryDiagnosisIcd10,
    levelOfCare: ctx.levelOfCare,
    recentVitalsSummary: ctx.recentVitalsSummary,
    activeProblemLabels: [...ctx.activeProblemLabels],
  };
}

/** Every key present anywhere in a JSON-ish value, at any depth. */
function collectKeys(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      collectKeys(v, into);
    }
  }
}

/** Every string scalar present anywhere in a JSON-ish value, at any depth. */
function collectStrings(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) collectStrings(v, into);
  }
}

/** Denylisted values shorter than this are not attributable: a three-character surname is a substring of
 *  half the medication names in the formulary, and a guard that cries wolf gets switched off. The
 *  compile-time union is what covers the short-value case. */
export const MIN_ATTRIBUTABLE_VALUE_LENGTH = 4;

/**
 * The §7.10 property: given the source context a body was built from, no denylisted source VALUE appears
 * anywhere in the body. Returns the denylisted source field names whose value leaked, so a failure names
 * what escaped rather than just failing.
 *
 * The match is by SUBSTRING, not equality — the realistic failure is not `lastName: "Chen"` as its own
 * key (the union already refuses that) but `firstName: "Mary Chen, MRN-40182"`, a permitted key stuffed
 * with an identifier by a well-meaning operator or a sloppy adapter.
 *
 * AMBIGUITY, stated rather than hidden: a body string that is a VERBATIM copy of a permitted source
 * value is not scanned. If a patient's surname is also her first name, or her diagnosis label happens to
 * contain her town, the scan cannot tell which source field the string came from, and reporting it would
 * fire on a body that is genuinely minimal. So the scan asks only about strings the body carries that
 * are not exactly what a permitted field held — which is precisely the set an adapter mutated.
 */
export function findLeakedSourceValues(
  ctx: TriageVendorSourceContext,
  body: unknown,
): readonly VendorDenylistedSourceField[] {
  const emitted = new Set<string>();
  collectStrings(body, emitted);

  const permitted = new Set<string>([ctx.firstName, ctx.primaryDiagnosisLabel]);
  for (const a of ctx.allergies) permitted.add(a);
  for (const m of ctx.currentMedications) permitted.add(m);
  for (const p of ctx.activeProblemLabels) permitted.add(p);
  if (ctx.primaryDiagnosisIcd10 !== null) permitted.add(ctx.primaryDiagnosisIcd10);
  if (ctx.levelOfCare !== null) permitted.add(ctx.levelOfCare);
  if (ctx.recentVitalsSummary !== null) permitted.add(ctx.recentVitalsSummary);

  const scannable = [...emitted].filter((s) => !permitted.has(s));

  const leaked: VendorDenylistedSourceField[] = [];
  for (const field of VENDOR_DENYLISTED_SOURCE_FIELDS) {
    const raw = ctx[field];
    if (typeof raw !== "string" || raw.length < MIN_ATTRIBUTABLE_VALUE_LENGTH) continue;
    if (permitted.has(raw)) continue;
    if (scannable.some((s) => s.includes(raw))) leaked.push(field);
  }
  return leaked;
}

/**
 * The gate every adapter calls immediately before transmitting. Checks BOTH directions — no unpermitted
 * KEY (a widened projection) and no denylisted VALUE (a permitted key stuffed with the wrong content,
 * e.g. `firstName: "Mary Chen, MRN 40182"`). Throws rather than returning a boolean: a caller who
 * forgets to branch on a boolean transmits, and the failure mode of this check is a HIPAA disclosure.
 */
export function assertVendorPayloadMinimized(
  profile: VendorMinimizationProfile,
  ctx: TriageVendorSourceContext,
  body: unknown,
): void {
  const allowed = new Set(VENDOR_PAYLOAD_ALLOWED_KEYS[profile]);
  const present = new Set<string>();
  collectKeys(body, present);

  const unexpectedKeys = [...present].filter((k) => !allowed.has(k));
  const leakedValues = findLeakedSourceValues(ctx, body);

  if (unexpectedKeys.length > 0 || leakedValues.length > 0) {
    const parts: string[] = [];
    if (unexpectedKeys.length > 0) parts.push(`unpermitted keys [${unexpectedKeys.join(", ")}]`);
    if (leakedValues.length > 0) parts.push(`denylisted values from [${leakedValues.join(", ")}]`);
    throw new VendorPhiMinimizationError(
      `vendor payload failed ${profile} minimization: ${parts.join("; ")}`,
      [...unexpectedKeys, ...leakedValues],
    );
  }
}
