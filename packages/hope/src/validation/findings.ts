// @wardenx/hope — the pre-submission validation finding descriptor + rule-id catalog (M10-T04; §3.3).
// PURE data. The CMS HOPE pre-submission validator (`validate-hope-assessment.ts`) returns these
// descriptors; the recording/submission service (M10-T06/T07) maps each into a `hope_validation_finding`
// row (rule_id / severity / section / item_code / message) inside the tenant transaction. Keeping the
// descriptor distinct from the Drizzle row keeps the engine IO-free and `@wardenx/types`-only — this
// package never imports `@wardenx/db`.
import type { HopeValidationSeverity } from "@wardenx/types";

/**
 * The stable `hope_validation_finding.rule_id` catalog (the CMS HOPE submission rule set v1; the spec's
 * `validation/rules/cms_hope_v1_<n>.ts` files). The id is the durable contract surfaced to the correction
 * worklist and the M30 acceptance posture — append new rules, never renumber.
 */
export const HOPE_VALIDATION_RULES = {
  /** Required Section letter missing for the RFA (§2.3 required-items matrix). */
  REQUIRED_SECTION_MISSING: "cms_hope_v1_required_section",
  /** Section I primary diagnosis ∉ M38 active hospice-terminal-diagnosis value set at target_date. */
  SECTION_I_DIAGNOSIS_NOT_IN_VALUE_SET: "cms_hope_v1_section_i_diagnosis_value_set",
  /** A Section-J symptom/J-item code ∉ the M38 CMS HOPE J-code value set (transposed/unknown code). */
  SECTION_J_CODE_NOT_IN_VALUE_SET: "cms_hope_v1_section_j_jcode_value_set",
  /** J2030 = Yes ⇒ pain characteristics must be present (cross-field). */
  J2030_PAIN_CHARACTERISTICS_MISSING: "cms_hope_v1_j2030_pain_characteristics",
  /** J2050 = Yes ⇒ dyspnea characteristics must be present (cross-field). */
  J2050_DYSPNEA_CHARACTERISTICS_MISSING: "cms_hope_v1_j2050_dyspnea_characteristics",
  /** Opioid prescribed ⇒ scheduled bowel regimen present OR a documented contraindication (Section N). */
  SECTION_N_BOWEL_REGIMEN_MISSING: "cms_hope_v1_section_n_bowel_regimen",
  /** Section Q required on a live-discharge / revocation / transfer Discharge RFA but absent (D9). */
  SECTION_Q_REQUIRED: "cms_hope_v1_section_q_required",
  /** Section Q forbidden on a death-discharge RFA but present (D9). */
  SECTION_Q_FORBIDDEN: "cms_hope_v1_section_q_forbidden",
  /** Cross-RFA temporal order violated (HUV1 ≤ Admission, or HUV2 ≤ HUV1). */
  CROSS_RFA_TEMPORAL_ORDER: "cms_hope_v1_cross_rfa_temporal",
  /** iQIES envelope: ProviderEntity CCN ≠ admission's ccn_at_election. */
  ENVELOPE_CCN_MISMATCH: "cms_hope_v1_envelope_ccn",
  /** iQIES envelope: patient MBI ≠ M5's election-time snapshot. */
  ENVELOPE_MBI_MISMATCH: "cms_hope_v1_envelope_mbi",
  /**
   * A value-set membership rule could not be evaluated because M38 holds no membership for that set in
   * this deployment (F-057). Advisory by construction: the rule it stands in for may be an `error`, but
   * "we could not check" is never itself a submission blocker — it is the record that the check did not
   * run, so an absent Section-I value set is visible to compliance instead of silently passing.
   */
  VALUE_SET_UNAVAILABLE: "cms_hope_v1_value_set_unavailable",
} as const;

/** A CMS HOPE pre-submission rule id (`hope_validation_finding.rule_id`). */
export type HopeValidationRuleId =
  (typeof HOPE_VALIDATION_RULES)[keyof typeof HOPE_VALIDATION_RULES];

/**
 * One pre-submission validation result — the pure shape the service persists as a `hope_validation_finding`
 * row. `severity='error'` blocks iQIES submission; `severity='warning'` is advisory and does not block.
 * `section` is the HOPE Section letter (or `"ENVELOPE"` for iQIES envelope-level rules); `itemCode` is the
 * specific J-code / ICD-10 / item identifier when the rule pins one, else null.
 */
export interface HopeValidationFindingDescriptor {
  readonly ruleId: HopeValidationRuleId;
  readonly severity: HopeValidationSeverity;
  readonly section: string;
  readonly itemCode: string | null;
  readonly message: string;
}

/** Build a {@link HopeValidationFindingDescriptor} (the validator's per-rule helper). */
export function finding(
  ruleId: HopeValidationRuleId,
  severity: HopeValidationSeverity,
  section: string,
  message: string,
  itemCode: string | null = null,
): HopeValidationFindingDescriptor {
  return { ruleId, severity, section, itemCode, message };
}

/** True when any descriptor is a blocking `error` (the §3 submission gate: an unresolved error blocks). */
export function hasBlockingError(findings: readonly HopeValidationFindingDescriptor[]): boolean {
  return findings.some((f) => f.severity === "error");
}
