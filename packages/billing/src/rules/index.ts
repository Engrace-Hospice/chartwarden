// @wardenx/billing — M23 §11.A validation-framework barrel (D1, spec §4.5). Re-exports the pure rule
// MODEL (the `Rule` interface, the `ValidationContext` aggregate snapshot, `RuleResult` + its
// `pass`/`fail`/`skip` constructors, the severity/category unions, the context helpers), the rule
// REGISTRY (`BillingRuleRegistry` + `runRules` + `summarizeRuleRun`), and the 19 platform-default rules
// assembled into a freshly-built default registry. PURE DOMAIN throughout — no Fastify, no Drizzle/DB, no
// BullMQ, no `@wardenx/db`, no `getSeam`, no clock; no PHI.
//
// RULE COUNT (§4.5): the §4.5 table enumerates 17 rule CATEGORIES across NINETEEN rule rows (the
// `eligibility` and `cap` categories each ship two default rules). The Phase-boundary "18 default rules"
// note is reconciled here to the spec table's 19 rows (the authoritative enumeration). Eighteen of the
// nineteen are `regulatoryRequired: true` (the platform floor a tenant cannot disable, D5); the lone
// non-regulatory default is `eligibility_check_freshness_30d` (a warn).
export * from "./types";
export * from "./_registry";

import { BillingRuleRegistry } from "./_registry";
// ── the 19 platform-default rules (one file per rule) ──────────────────────────────────────────────────
import type { Rule } from "./types";

import { aggregateCapProjection } from "./aggregate-cap-projection";
import { bereavementDischargeLegitimacy } from "./bereavement-discharge";
import { ctiSignedPerPeriod } from "./cti-signed";
import { duplicateBillingCheck } from "./duplicate-billing";
import { electionPeriodActive } from "./election-period-active";
import { eligibilityCheckFreshness30d } from "./eligibility-freshness";
import { evvBracketCoherence } from "./evv-coherence";
import { f2fAttestedForRecert } from "./f2f-attested";
import { hippsCodingCorrect } from "./hipps-coding";
import { icd10Sequencing } from "./icd-sequencing";
import { ipuCapProjection } from "./ipu-cap-projection";
import { levelOfCareCoherence } from "./loc-coherence";
import { CMS_HOSPICE_MODIFIER_VALUE_SET, modifierCodesValid } from "./modifier-codes";
import { noeTimeliness5d } from "./noe-timeliness";
import { patientEligibilityPartAActive } from "./patient-eligibility-part-a";
import { physicianCredentialsActive } from "./physician-credentials";
import { placeOfServiceConsistency } from "./place-of-service";
import { siaCalculationCorrect } from "./sia-calculation";
import { tobAndDatesConsistency } from "./tob-dates-consistency";

export {
  patientEligibilityPartAActive,
  eligibilityCheckFreshness30d,
  electionPeriodActive,
  ctiSignedPerPeriod,
  f2fAttestedForRecert,
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
  CMS_HOSPICE_MODIFIER_VALUE_SET,
};

/**
 * The 19 platform-default validation rules in §4.5 table order. This is the canonical platform-floor set
 * the Phase-3 composition root registers (then layers MAC-profile + tenant-overlay rules atop, then
 * freezes). Frozen tuple — the array itself is immutable; the `Rule` objects are already `readonly`.
 */
export const DEFAULT_BILLING_RULES: readonly Rule[] = Object.freeze([
  patientEligibilityPartAActive,
  eligibilityCheckFreshness30d,
  electionPeriodActive,
  ctiSignedPerPeriod,
  f2fAttestedForRecert,
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
]);

/**
 * Build a fresh, UN-frozen registry pre-populated with the 19 platform-default rules. The Phase-3 boot
 * calls this, registers any MAC-profile / tenant-overlay rules, then `freeze()`s. A factory (not a shared
 * singleton) so each composition / test gets an isolated, mutable-until-frozen registry.
 */
export function createDefaultBillingRegistry(): BillingRuleRegistry {
  const registry = new BillingRuleRegistry();
  registry.registerRules(DEFAULT_BILLING_RULES);
  return registry;
}
