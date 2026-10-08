// @wardenx/terminology — the platform `value_set` definition seed (M38-T08, spec §3.9).
//
// Definitions ONLY (id/name/description/scope). Members live in `value_set_member`, seeded from
// the curation file (value-set-members.ts) for the small, fully-enumerated reference sets and
// loaded by the per-system loaders (§4.3) for the concept-data-dependent ones — exactly as §3.9
// notes ("definitions only; members loaded via curation file").

import type { ValueSetScope } from "../interfaces/kinds";
import { SUD_TEST_LOINC_VALUE_SET_ID } from "./sud-test-loinc";

/** One platform `value_set` definition row (§3.5, §3.9). */
export interface PlatformValueSetSeed {
  readonly id: string; // stable slug
  readonly name: string;
  readonly description: string;
  readonly scope: ValueSetScope;
}

/**
 * The Phase-1 platform value-set definitions (§3.9). Stable order for deterministic
 * seeding/tests. Members are NOT here — see {@link PLATFORM_VALUE_SET_MEMBERS} (curated) and
 * the per-system loaders (§4.3).
 */
export const PLATFORM_VALUE_SETS: readonly PlatformValueSetSeed[] = [
  {
    id: "hospice_terminal_diagnosis",
    name: "Hospice terminal diagnoses",
    description: "ICD-10-CM codes acceptable as terminal diagnosis on a hospice claim",
    scope: "hospice",
  },
  {
    id: "hope_j_codes",
    name: "HOPE J-code symptom-impact items",
    description: "J2030, J2050, J2051 plus related; consumed by Module 10",
    scope: "hqrp",
  },
  {
    id: "hqrp_measure_codes",
    name: "HQRP measure codes",
    description: "Quality measure codes per CMS HQRP spec",
    scope: "hqrp",
  },
  {
    id: "level_of_care",
    name: "Hospice level-of-care revenue codes",
    description: "0651 RHC, 0652 CHC, 0655 IRC, 0656 GIP",
    scope: "platform",
  },
  {
    id: "place_of_service_q_codes",
    name: "HCPCS Q-codes for hospice place of service",
    description: "Q5001..Q5010",
    scope: "platform",
  },
  {
    id: "route_of_administration",
    name: "Route of administration (SNOMED-coded)",
    description: "PO, IV, SQ, SL, PR, topical, inhalation, ...",
    scope: "platform",
  },
  {
    id: "dosage_form",
    name: "Dosage form (SNOMED-coded)",
    description: "tablet, capsule, solution, suspension, patch, ...",
    scope: "platform",
  },
  {
    id: "comfort_kit_medications",
    name: "Common comfort medications (RxNorm-keyed)",
    description: "morphine, lorazepam, haloperidol, atropine, scopolamine, ...",
    scope: "hospice",
  },
  {
    id: "advance_directive_type",
    name: "Advance directive types",
    description: "living will, DPOA-HC, POLST/MOLST, code status",
    scope: "platform",
  },
  // cms_hospice_modifiers — the two CMS hospice-specific HCPCS modifiers (GV/GW), added binding M23's
  // `modifier_codes_valid` rule (F-124, #251). Small, fully-enumerated, CMS-public — the same shape as
  // `level_of_care` and `place_of_service_q_codes` above, curated in value-set-members.ts.
  {
    id: "cms_hospice_modifiers",
    name: "CMS hospice-specific HCPCS modifiers",
    description: "GV, GW — the two modifiers CMS defines specifically for hospice claim lines",
    scope: "platform",
  },
  // sud_test_loinc — LOINC codes of 42 CFR Part 2 substance-use-disorder lab tests (GAP-086). M29's inbound
  // lab gate redacts a result whose LOINC is a member (platform members + the tenant's own extension). Members
  // are the generated list in sud-test-loinc.ts; the platform database gets them via migration 0500.
  {
    id: SUD_TEST_LOINC_VALUE_SET_ID,
    name: "42 CFR Part 2 substance-use-disorder laboratory tests (LOINC)",
    description:
      "LOINC codes for drug-screen / drugs-of-abuse panels, individual drug and metabolite screens and confirmations, and alcohol biomarkers; a match marks an inbound lab result SUD-class (M29 D15). Tenants extend via value_set_tenant_extension.",
    scope: "platform",
  },
] as const;
