// @wardenx/billing — M23 §11.A validation-framework barrel (D1, spec §4.5). Re-exports the pure rule
// MODEL (the `Rule` interface, the `ValidationContext` aggregate snapshot, `RuleResult` + its
// `pass`/`fail`/`skip` constructors, the severity/category unions, the context helpers), the rule
// REGISTRY (`BillingRuleRegistry` + `runRules` + `summarizeRuleRun`), and the 26 platform-default rules
// assembled into a freshly-built default registry. PURE DOMAIN throughout — no Fastify, no Drizzle/DB, no
// BullMQ, no `@wardenx/db`, no `getSeam`, no clock; no PHI.
//
// RULE COUNT (§4.5): the §4.5 table enumerates 17 rule CATEGORIES across NINETEEN rule rows (the
// `eligibility` and `cap` categories each ship two default rules). The Phase-boundary "18 default rules"
// note is reconciled here to the spec table's 19 rows (the authoritative enumeration), plus
// `rhc_carry_over_hets_fresh` (the cross-hospice RHC day-count warning) and the two FY2027 rules
// (`f2f_telehealth_g0679`, CR 14495; `election_addendum_signed`, 42 CFR 418.24(c)), plus
// `claim_total_matches_lines` (the 837I claim charge balances to its line charges) and `visit_lines_reportable`
// (visits skipped for lack of a documented duration). Every default is
// `regulatoryRequired: true` (the platform floor a tenant cannot disable, D5) except
// `eligibility_check_freshness_30d`, `evv_bracket_coherence` (ADR-0008) and `rhc_carry_over_hets_fresh`.
export * from "./types";
export * from "./_registry";

import { BillingRuleRegistry } from "./_registry";
// ── the 26 platform-default rules (one file per rule) ──────────────────────────────────────────────────
import type { Rule } from "./types";

import { admissionCodesPresent } from "./admission-codes-present";
import { aggregateCapProjection } from "./aggregate-cap-projection";
import { bereavementDischargeLegitimacy } from "./bereavement-discharge";
import { cbsaValueCodesPresent } from "./cbsa-value-codes-present";
import { claimTotalMatchesLines } from "./claim-total-matches-lines";
import { ctiSignedPerPeriod } from "./cti-signed";
import { duplicateBillingCheck } from "./duplicate-billing";
import {
  ADDENDUM_APPLIES_TO_ELECTIONS_FROM,
  ADDENDUM_ENFORCE_FROM,
  electionAddendumSigned,
} from "./election-addendum-signed";
import { electionPeriodActive } from "./election-period-active";
import { eligibilityCheckFreshness30d } from "./eligibility-freshness";
import { evvBracketCoherence } from "./evv-coherence";
import { f2fAttestedForRecert } from "./f2f-attested";
import {
  G0679_ALLOWED_TOB_PREFIXES,
  G0679_EFFECTIVE_FROM,
  G0679_HCPCS,
  G0679_REVENUE_CODE,
  G0679_UNITS_PER_ENCOUNTER,
  G0679_UNIT_CHARGE_CENTS,
  f2fTelehealthG0679,
  telehealthF2fDatesRequiringG0679,
} from "./f2f-telehealth-g0679";
import { icd10Sequencing } from "./icd-sequencing";
import { ipuCapProjection } from "./ipu-cap-projection";
import { levelOfCareCoherence } from "./loc-coherence";
import { CMS_HOSPICE_MODIFIER_VALUE_SET, modifierCodesValid } from "./modifier-codes";
import { noeTimeliness5d } from "./noe-timeliness";
import { patientEligibilityPartAActive } from "./patient-eligibility-part-a";
import { perDiemClassCodingCorrect } from "./per-diem-class-coding";
import { physicianCredentialsActive } from "./physician-credentials";
import { POS_BY_QCODE, POS_LABEL_ALIASES, placeOfServiceConsistency } from "./place-of-service";
import { rhcCarryOverHetsFresh } from "./rhc-carry-over-hets";
import { siaCalculationCorrect } from "./sia-calculation";
import { tobAndDatesConsistency } from "./tob-dates-consistency";
import { visitLinesReportable } from "./visit-lines-reportable";

export {
  admissionCodesPresent,
  cbsaValueCodesPresent,
  claimTotalMatchesLines,
  visitLinesReportable,
  patientEligibilityPartAActive,
  eligibilityCheckFreshness30d,
  electionPeriodActive,
  ctiSignedPerPeriod,
  f2fAttestedForRecert,
  f2fTelehealthG0679,
  telehealthF2fDatesRequiringG0679,
  G0679_ALLOWED_TOB_PREFIXES,
  G0679_EFFECTIVE_FROM,
  G0679_HCPCS,
  G0679_REVENUE_CODE,
  G0679_UNITS_PER_ENCOUNTER,
  G0679_UNIT_CHARGE_CENTS,
  levelOfCareCoherence,
  perDiemClassCodingCorrect,
  siaCalculationCorrect,
  icd10Sequencing,
  physicianCredentialsActive,
  noeTimeliness5d,
  tobAndDatesConsistency,
  duplicateBillingCheck,
  placeOfServiceConsistency,
  aggregateCapProjection,
  ipuCapProjection,
  bereavementDischargeLegitimacy,
  modifierCodesValid,
  evvBracketCoherence,
  electionAddendumSigned,
  ADDENDUM_APPLIES_TO_ELECTIONS_FROM,
  ADDENDUM_ENFORCE_FROM,
  rhcCarryOverHetsFresh,
  CMS_HOSPICE_MODIFIER_VALUE_SET,
  POS_BY_QCODE,
  POS_LABEL_ALIASES,
};

/**
 * The 26 platform-default validation rules (§4.5 table order, then the RHC carry-over warning, the FY2027 election addendum rule, the claim-total balance rule, the unreportable-visit warning, and the admission-code and CBSA value-code rules). This is the canonical platform-floor set
 * the Phase-3 composition root registers (then layers MAC-profile + tenant-overlay rules atop, then
 * freezes). Frozen tuple — the array itself is immutable; the `Rule` objects are already `readonly`.
 */
export const DEFAULT_BILLING_RULES: readonly Rule[] = Object.freeze([
  patientEligibilityPartAActive,
  eligibilityCheckFreshness30d,
  electionPeriodActive,
  ctiSignedPerPeriod,
  f2fAttestedForRecert,
  f2fTelehealthG0679,
  levelOfCareCoherence,
  perDiemClassCodingCorrect,
  siaCalculationCorrect,
  icd10Sequencing,
  physicianCredentialsActive,
  noeTimeliness5d,
  tobAndDatesConsistency,
  duplicateBillingCheck,
  placeOfServiceConsistency,
  aggregateCapProjection,
  ipuCapProjection,
  bereavementDischargeLegitimacy,
  modifierCodesValid,
  evvBracketCoherence,
  rhcCarryOverHetsFresh,
  // FY2027 (CMS-1851-F) — 42 CFR 418.24(c) election statement addendum.
  electionAddendumSigned,
  // 837I CLM02 balances to the service-line charges (payment add-ons are never billed charges).
  claimTotalMatchesLines,
  // CMS ch. 11 §30.3 — billable visits that could not be reported as lines (warn; ids only).
  visitLinesReportable,
  // UB-04 FL 14/15 — the recorded admission type + point of origin (blocks; never invented).
  admissionCodesPresent,
  // CMS ch. 11 §30.3 — value codes 61 / G8 (the wage-index CBSA); blocks when one cannot be resolved.
  cbsaValueCodesPresent,
]);

/**
 * Build a fresh, UN-frozen registry pre-populated with the 26 platform-default rules. The Phase-3 boot
 * calls this, registers any MAC-profile / tenant-overlay rules, then `freeze()`s. A factory (not a shared
 * singleton) so each composition / test gets an isolated, mutable-until-frozen registry.
 */
export function createDefaultBillingRegistry(): BillingRuleRegistry {
  const registry = new BillingRuleRegistry();
  registry.registerRules(DEFAULT_BILLING_RULES);
  return registry;
}
