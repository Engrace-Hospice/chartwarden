// @chartwarden/medicaid-adapters — M24 §4.6 validation-framework barrel. Re-exports the rule MODEL, the
// REGISTRY + runner, and the 13 platform-default rules assembled into a freshly-built default registry.
// All 13 are regulatoryRequired (the §4.6 platform floor); 12 are `error`, the cap rule is `warn` until M26
// locks. PURE DOMAIN throughout — no Fastify, Drizzle, BullMQ, getSeam, clock, PHI.
export * from "./types";
export * from "./_registry";

import { MedicaidRuleRegistry } from "./_registry";
import type { MedicaidRule } from "./types";

import {
  medicaidRateSchedulePresentForServiceDate,
  medicarePrimaryRequiredForDual,
} from "./cob-rate-rules";
import {
  medicaidEligibilityActive,
  medicaidEligibilityFreshness30d,
  medicaidRecipientIdFormat,
} from "./eligibility-rules";
import { medicaidCapCoherence, medicaidEvvBracketCoherence } from "./evv-cap-rules";
import { medicaidMcoAssignmentRoutes } from "./mco-rules";
import {
  medicaidRbArrangementRequiredForNfResident,
  medicaidRbContractEffectiveForServiceDate,
  medicaidRbDayLocCoherence,
} from "./rb-rules";
import {
  medicaidStateSpecificDocumentation,
  medicaidStateSpecificModifiersValid,
} from "./state-specific-rules";

export {
  medicaidEligibilityActive,
  medicaidEligibilityFreshness30d,
  medicaidRecipientIdFormat,
  medicaidMcoAssignmentRoutes,
  medicaidRbArrangementRequiredForNfResident,
  medicaidRbDayLocCoherence,
  medicaidRbContractEffectiveForServiceDate,
  medicarePrimaryRequiredForDual,
  medicaidRateSchedulePresentForServiceDate,
  medicaidStateSpecificModifiersValid,
  medicaidStateSpecificDocumentation,
  medicaidEvvBracketCoherence,
  medicaidCapCoherence,
};

/** The 13 platform-default Medicaid validation rules in §4.6 table order (frozen tuple). */
export const DEFAULT_MEDICAID_RULES: readonly MedicaidRule[] = Object.freeze([
  medicaidEligibilityActive,
  medicaidEligibilityFreshness30d,
  medicaidRecipientIdFormat,
  medicaidMcoAssignmentRoutes,
  medicaidRbArrangementRequiredForNfResident,
  medicaidRbDayLocCoherence,
  medicaidRbContractEffectiveForServiceDate,
  medicarePrimaryRequiredForDual,
  medicaidRateSchedulePresentForServiceDate,
  medicaidStateSpecificModifiersValid,
  medicaidStateSpecificDocumentation,
  medicaidEvvBracketCoherence,
  medicaidCapCoherence,
]);

/** Build a fresh, UN-frozen registry pre-populated with the 13 platform-default rules. */
export function createDefaultMedicaidRegistry(): MedicaidRuleRegistry {
  const registry = new MedicaidRuleRegistry();
  registry.registerRules(DEFAULT_MEDICAID_RULES);
  return registry;
}
