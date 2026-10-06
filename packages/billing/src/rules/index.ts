// @wardenx/billing — M23 §11.A validation-framework barrel (D1, spec §4.5). Re-exports the pure rule
// MODEL (the `Rule` interface, the `ValidationContext` aggregate snapshot, `RuleResult` + its
// `pass`/`fail`/`skip` constructors, the severity/category unions, the context helpers), the rule
// REGISTRY (`BillingRuleRegistry` + `runRules` + `summarizeRuleRun`), and the 20 platform-default rules
// assembled into a freshly-built default registry. PURE DOMAIN throughout — no Fastify, no Drizzle/DB, no
// BullMQ, no `@wardenx/db`, no `getSeam`, no clock; no PHI.
//
// RULE COUNT (§4.5): the §4.5 table enumerates 17 rule CATEGORIES across NINETEEN rule rows (the
// `eligibility` and `cap` categories each ship two default rules). The Phase-boundary "18 default rules"
// note is reconciled here to the spec table's 19 rows (the authoritative enumeration). Eighteen of the
// nineteen are `regulatoryRequired: true` (the platform floor a tenant cannot disable, D5); the lone
// non-regulatory default is `eligibility_check_freshness_30d` (a warn). (ADR-0008 later made
// `evv_bracket_coherence` non-regulatory too.) FY2027: `f2f_telehealth_g0679` (CR 14495) is the 20th default
// rule — a second `f2f`-category row, regulatory.
export * from "./types";
export * from "./_registry";

import { BillingRuleRegistry } from "./_registry";
// ── the 21 platform-default rules (one file per rule) ──────────────────────────────────────────────────
import type { Rule } from "./types";

import { aggregateCapProjection } from "./aggregate-cap-projection";
import { bereavementDischargeLegitimacy } from "./bereavement-discharge";
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
import { hippsCodingCorrect } from "./hipps-coding";
import { icd10Sequencing } from "./icd-sequencing";
import { ipuCapProjection } from "./ipu-cap-projection";
import { levelOfCareCoherence } from "./loc-coherence";
import { CMS_HOSPICE_MODIFIER_VALUE_SET, modifierCodesValid } from "./modifier-codes";
import { noeTimeliness5d } from "./noe-timeliness";
import { patientEligibilityPartAActive } from "./patient-eligibility-part-a";
import { physicianCredentialsActive } from "./physician-credentials";
import { POS_BY_QCODE, POS_LABEL_ALIASES, placeOfServiceConsistency } from "./place-of-service";
import { siaCalculationCorrect } from "./sia-calculation";
import { tobAndDatesConsistency } from "./tob-dates-consistency";

export {
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
  hippsCodingCorrect,
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
  CMS_HOSPICE_MODIFIER_VALUE_SET,
  POS_BY_QCODE,
  POS_LABEL_ALIASES,
};

/**
 * The 21 platform-default validation rules in §4.5 table order. This is the canonical platform-floor set
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
  hippsCodingCorrect,
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
  // FY2027 (CMS-1851-F) — the twentieth rule: 42 CFR 418.24(c) election statement addendum.
  electionAddendumSigned,
]);

/**
 * Build a fresh, UN-frozen registry pre-populated with the 20 platform-default rules. The Phase-3 boot
 * calls this, registers any MAC-profile / tenant-overlay rules, then `freeze()`s. A factory (not a shared
 * singleton) so each composition / test gets an isolated, mutable-until-frozen registry.
 */
export function createDefaultBillingRegistry(): BillingRuleRegistry {
  const registry = new BillingRuleRegistry();
  registry.registerRules(DEFAULT_BILLING_RULES);
  return registry;
}
