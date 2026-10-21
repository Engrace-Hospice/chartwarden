// @chartwarden/emar — §2.1 Administration-Mode catalog (M13-T01 domain layout).
//
// The single source of per-mode metadata the lifecycle (§2.2 D6), the per-mode validators (§3.4), the
// FHIR `MedicationAdministration` projection (§2.12 / M28), and the audit-denylist install (§3.6) read
// instead of re-deriving rules inline: which body fields each mode requires over the shared envelope, how
// the mode maps onto a FHIR `effective[x]`, which per-mode `data` free-text fields are denylisted, and how
// each mode relates to the `iv_session_id` correlation chain (§2.1).
//
// PURE DATA — no IO, `@chartwarden/types`-only. The per-mode TypeBox `data` schemas + cross-field `validate.ts`
// + `terminology.ts` (M38 bindings) + `fhir-mapping.ts` land per-folder in `modes/<mode>/` in later tasks
// (the spec §2.1 open-taxonomy shape); this catalog pins the metadata they hang off so adding a mode is one
// PR (drop a folder + add an entry; the central `administration_record` schema does not change — §2.1).

import type { AdministrationMode } from "@chartwarden/types";

/** How a mode maps onto a FHIR `MedicationAdministration` `effective[x]` (§2.1 "FHIR mapping" column). */
export type FhirEffectiveMapping =
  | "dateTime" // single discrete administration → effectiveDateTime
  | "period_start" // opens an effectivePeriod (no end yet)
  | "period_snapshot" // a point-in-time titration within the running period
  | "period_end_segment" // closes the prior segment (pause)
  | "period_new_segment" // opens a new segment (resume)
  | "period_end"; // closes the session (stop)

/** A mode's relationship to the §2.1 `iv_session_id` correlation chain. */
export type IvSessionRole =
  | "none" // single_dose — no IV session
  | "mint" // iv_continuous_start — mints the session id
  | "reference" // mid-session segment — references the existing session id
  | "close"; // iv_continuous_stop — closes the session

/** Per-mode §2.1 metadata. */
export interface AdministrationModeMeta {
  readonly mode: AdministrationMode;
  /** Body fields required over the shared envelope (§2.1 "Required body fields" column). */
  readonly requiredBodyFields: readonly string[];
  /** Optional body fields the mode accepts. */
  readonly optionalBodyFields: readonly string[];
  /** Whether this is one of the five `iv_continuous_*` modes. */
  readonly isIvContinuous: boolean;
  /** The mode's role in the IV-session correlation chain. */
  readonly ivSessionRole: IvSessionRole;
  /** How the mode projects onto FHIR `MedicationAdministration.effective[x]` (§2.12 / M28). */
  readonly fhirEffectiveMapping: FhirEffectiveMapping;
  /** Free-text keys inside the per-mode `data` jsonb that the M4 audit trigger must scrub (§3.6 `data->>...`). */
  readonly denylistedDataFields: readonly string[];
  /** Whether the mode can carry a `wastageAmount` that triggers the §2.6 controlled-substance witness. */
  readonly mayCarryWastage: boolean;
}

/** §2.1 — the authoritative per-mode catalog (one entry per {@link AdministrationMode}). */
export const ADMINISTRATION_MODE_CATALOG: {
  readonly [K in AdministrationMode]: AdministrationModeMeta;
} = {
  single_dose: {
    mode: "single_dose",
    requiredBodyFields: ["administeredAmount", "route"],
    optionalBodyFields: ["siteOfAdministration", "wastageAmount", "wastageReason"],
    isIvContinuous: false,
    ivSessionRole: "none",
    fhirEffectiveMapping: "dateTime",
    denylistedDataFields: ["sig_free_text", "wastageReason"],
    mayCarryWastage: true,
  },
  iv_continuous_start: {
    mode: "iv_continuous_start",
    requiredBodyFields: ["infusionRate", "infusionDilution"],
    optionalBodyFields: ["pumpProgrammingVerifiedByMembershipId"],
    isIvContinuous: true,
    ivSessionRole: "mint",
    fhirEffectiveMapping: "period_start",
    denylistedDataFields: ["infusionDilution"],
    mayCarryWastage: false,
  },
  iv_continuous_rate_change: {
    mode: "iv_continuous_rate_change",
    requiredBodyFields: ["previousRate", "newRate", "titrationReason"],
    optionalBodyFields: [],
    isIvContinuous: true,
    ivSessionRole: "reference",
    fhirEffectiveMapping: "period_snapshot",
    denylistedDataFields: ["titrationReason"],
    mayCarryWastage: false,
  },
  iv_continuous_pause: {
    mode: "iv_continuous_pause",
    requiredBodyFields: ["pauseReason"],
    optionalBodyFields: [],
    isIvContinuous: true,
    ivSessionRole: "reference",
    fhirEffectiveMapping: "period_end_segment",
    denylistedDataFields: ["pauseReason"],
    mayCarryWastage: false,
  },
  iv_continuous_resume: {
    mode: "iv_continuous_resume",
    requiredBodyFields: [],
    optionalBodyFields: [],
    isIvContinuous: true,
    ivSessionRole: "reference",
    fhirEffectiveMapping: "period_new_segment",
    denylistedDataFields: [],
    mayCarryWastage: false,
  },
  iv_continuous_stop: {
    mode: "iv_continuous_stop",
    requiredBodyFields: ["stopReason"],
    optionalBodyFields: ["wastageAmount", "wastageReason"],
    isIvContinuous: true,
    ivSessionRole: "close",
    fhirEffectiveMapping: "period_end",
    denylistedDataFields: ["stopReason", "wastageReason"],
    mayCarryWastage: true,
  },
} as const;
