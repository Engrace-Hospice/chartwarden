// @wardenx/terminology — the platform value-set member curation file (M38-T08, spec §3.9, §4.3).
//
// §3.9 ships value-set DEFINITIONS only; members come "via curation file". This file curates the
// members for the two small, FULLY-ENUMERATED, CMS-public reference sets whose entire membership
// the spec lists inline — `level_of_care` (UB-04 revenue codes) and `place_of_service_q_codes`
// (HCPCS Q-codes). Their codes are stable platform reference data, so they belong with the seed
// rather than a loader run.
//
// The concept-data-dependent sets (SNOMED/RxNorm/ICD-keyed: route_of_administration, dosage_form,
// comfort_kit_medications, hospice_terminal_diagnosis, hope_j_codes, hqrp_measure_codes,
// advance_directive_type) are intentionally NOT curated here — their members are populated once the
// per-system loaders (§4.3) have loaded the underlying concepts, so the codes resolve to real rows.

import type { CodeSystemId } from "../interfaces/kinds";

/** One curated platform `value_set_member` row (§3.5). `effectiveDate` defaults to the set's epoch. */
export interface PlatformValueSetMemberSeed {
  readonly valueSetId: string;
  readonly systemId: CodeSystemId;
  readonly code: string;
  readonly display: string;
}

/**
 * Curated members for the fully-enumerated reference value sets. Stable order for deterministic
 * seeding/tests. Every `valueSetId` here MUST exist in `PLATFORM_VALUE_SETS` and every `systemId`
 * in `PLATFORM_CODE_SYSTEMS` (enforced by the seed integration test).
 */
export const PLATFORM_VALUE_SET_MEMBERS: readonly PlatformValueSetMemberSeed[] = [
  // level_of_care — UB-04 revenue codes (§3.9: "0651 RHC, 0652 CHC, 0655 IRC, 0656 GIP").
  {
    valueSetId: "level_of_care",
    systemId: "revenue",
    code: "0651",
    display: "Routine home care (RHC)",
  },
  {
    valueSetId: "level_of_care",
    systemId: "revenue",
    code: "0652",
    display: "Continuous home care (CHC)",
  },
  {
    valueSetId: "level_of_care",
    systemId: "revenue",
    code: "0655",
    display: "Inpatient respite care (IRC)",
  },
  {
    valueSetId: "level_of_care",
    systemId: "revenue",
    code: "0656",
    display: "General inpatient care (GIP)",
  },

  // place_of_service_q_codes — HCPCS Q-codes Q5001..Q5010 (§3.9).
  {
    valueSetId: "place_of_service_q_codes",
    systemId: "hcpcs",
    code: "Q5001",
    display: "Hospice care provided in patient's home/residence",
  },
  {
    valueSetId: "place_of_service_q_codes",
    systemId: "hcpcs",
    code: "Q5002",
    display: "Hospice care provided in assisted living facility",
  },
  {
    valueSetId: "place_of_service_q_codes",
    systemId: "hcpcs",
    code: "Q5003",
    display:
      "Hospice care provided in nursing long-term care facility (LTC) or non-skilled nursing facility (NF)",
  },
  {
    valueSetId: "place_of_service_q_codes",
    systemId: "hcpcs",
    code: "Q5004",
    display: "Hospice care provided in skilled nursing facility (SNF)",
  },
  {
    valueSetId: "place_of_service_q_codes",
    systemId: "hcpcs",
    code: "Q5005",
    display: "Hospice care provided in inpatient hospital",
  },
  {
    valueSetId: "place_of_service_q_codes",
    systemId: "hcpcs",
    code: "Q5006",
    display: "Hospice care provided in inpatient hospice facility",
  },
  {
    valueSetId: "place_of_service_q_codes",
    systemId: "hcpcs",
    code: "Q5007",
    display: "Hospice care provided in long-term care facility (LTCH)",
  },
  {
    valueSetId: "place_of_service_q_codes",
    systemId: "hcpcs",
    code: "Q5008",
    display: "Hospice care provided in inpatient psychiatric facility",
  },
  {
    valueSetId: "place_of_service_q_codes",
    systemId: "hcpcs",
    code: "Q5009",
    display: "Hospice care provided in place not otherwise specified (NOS)",
  },
  {
    valueSetId: "place_of_service_q_codes",
    systemId: "hcpcs",
    code: "Q5010",
    display: "Hospice home care provided in a hospice facility",
  },
] as const;
