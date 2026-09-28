// @wardenx/terminology — the platform value-set member curation file (M38-T08, spec §3.9, §4.3).
//
// §3.9 ships value-set DEFINITIONS only; members come "via curation file". This file curates the
// members for the small, FULLY-ENUMERATED, CMS-public reference sets whose entire membership the spec
// lists inline — `level_of_care` (UB-04 revenue codes), `place_of_service_q_codes` (HCPCS Q-codes) and
// `hope_j_codes` (the CMS HOPE Section-J items). Their codes are stable platform reference data, so
// they belong with the seed rather than a loader run. `cms_hospice_modifiers` (F-124, #251) joined this
// list the same way: two CMS-defined HCPCS modifiers, never expected to change without a CMS rule update.
//
// The concept-data-dependent sets (SNOMED/RxNorm/ICD-keyed: route_of_administration, dosage_form,
// comfort_kit_medications, hospice_terminal_diagnosis, hqrp_measure_codes, advance_directive_type)
// are intentionally NOT curated here — their members are populated once the per-system loaders (§4.3)
// have loaded the underlying concepts, so the codes resolve to real rows.
//
// F-059 — `hope_j_codes` used to sit in that second list, and did not belong there: there is no HOPE
// loader to wait for, and until mig 0229 there was no code SYSTEM to curate under either, so the set
// could never have a member and M10's §86 Section-J rule could never resolve. It meets this file's own
// criterion exactly — small, fully enumerated, CMS-public, listed inline by M10 spec §2.1.

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
  // hope_j_codes — the CMS HOPE Section-J items M10 spec §2.1 enumerates (F-059). These are the
  // instrument's QUESTIONS (item identifiers), not the per-symptom answers: J2051's answers are the
  // eight `HOPE_J2051_SYMPTOM_CODES`, a WardenX-internal vocabulary already closed at M10's route
  // boundary and therefore not a terminology question at all. The set's own description names these
  // three plus "related"; a CMS annual update that adds an item is a curation change here.
  {
    valueSetId: "hope_j_codes",
    systemId: "cms_hope",
    code: "J2030",
    display: "Screening for pain",
  },
  {
    valueSetId: "hope_j_codes",
    systemId: "cms_hope",
    code: "J2050",
    display: "Screening for shortness of breath",
  },
  {
    valueSetId: "hope_j_codes",
    systemId: "cms_hope",
    code: "J2051",
    display: "Symptom impact at this visit",
  },

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

  // cms_hospice_modifiers — the two CMS hospice-specific HCPCS modifiers (F-124, #251).
  {
    valueSetId: "cms_hospice_modifiers",
    systemId: "hcpcs",
    code: "GV",
    display:
      "Attending physician not employed or paid under arrangement by the patient's hospice provider",
  },
  {
    valueSetId: "cms_hospice_modifiers",
    systemId: "hcpcs",
    code: "GW",
    display: "Service not related to the hospice patient's terminal condition",
  },
] as const;
