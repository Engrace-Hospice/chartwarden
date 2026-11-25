// @chartwarden/medicaid-adapters — M24 §4.6 validation-framework barrel. Re-exports the rule MODEL, the
// REGISTRY + runner, and the platform-default rules assembled into a freshly-built default registry.
// Blocking rules are either regulatoryRequired or non-overridable platformRequired safety gates; the cap rule is
// `warn` until M26 locks. PURE DOMAIN throughout — no Fastify, Drizzle, BullMQ, getSeam, clock, PHI.
export * from "./types";
export * from "./_registry";

import { MedicaidRuleRegistry } from "./_registry";
import type { MedicaidRule } from "./types";

import {
  medicaidMedicareClaimLinkageSupported,
  medicaidPayerRatePolicySnapshotVerified,
  medicaidPayerResponsibilityResolved,
  medicaidRateSchedulePresentForServiceDate,
  medicarePrimaryRequiredForDual,
} from "./cob-rate-rules";
import {
  medicaidEligibilityActive,
  medicaidEligibilityFreshness30d,
  medicaidRecipientIdFormat,
} from "./eligibility-rules";
import { medicaidCapCoherence, medicaidEvvBracketCoherence } from "./evv-cap-rules";
import { medicaidHospiceInstitutionalFormatQualified } from "./institutional-format-rules";
import { medicaidMcoAssignmentRoutes } from "./mco-rules";
import {
  medicaidHospiceClaimSnapshotVerified,
  medicaidRbArrangementRequiredForNfResident,
  medicaidRbClaimSnapshotVerified,
  medicaidRbContractEffectiveForServiceDate,
  medicaidRbDayLocCoherence,
} from "./rb-rules";
import {
  medicaidStateSpecificDocumentation,
  medicaidStateSpecificModifiersValid,
} from "./state-specific-rules";

export {
  medicaidPayerResponsibilityResolved,
  medicaidMedicareClaimLinkageSupported,
  medicaidEligibilityActive,
  medicaidEligibilityFreshness30d,
  medicaidRecipientIdFormat,
  medicaidMcoAssignmentRoutes,
  medicaidRbArrangementRequiredForNfResident,
  medicaidHospiceClaimSnapshotVerified,
  medicaidRbClaimSnapshotVerified,
  medicaidRbDayLocCoherence,
  medicaidRbContractEffectiveForServiceDate,
  medicarePrimaryRequiredForDual,
  medicaidRateSchedulePresentForServiceDate,
  medicaidPayerRatePolicySnapshotVerified,
  medicaidHospiceInstitutionalFormatQualified,
  medicaidStateSpecificModifiersValid,
  medicaidStateSpecificDocumentation,
  medicaidEvvBracketCoherence,
  medicaidCapCoherence,
};

/** Platform-default Medicaid validation rules in §4.6 order (frozen tuple). */
export const DEFAULT_MEDICAID_RULES: readonly MedicaidRule[] = Object.freeze([
  medicaidEligibilityActive,
  medicaidEligibilityFreshness30d,
  medicaidRecipientIdFormat,
  medicaidMcoAssignmentRoutes,
  medicaidRbArrangementRequiredForNfResident,
  medicaidHospiceClaimSnapshotVerified,
  medicaidRbDayLocCoherence,
  medicaidRbClaimSnapshotVerified,
  medicaidRbContractEffectiveForServiceDate,
  medicaidPayerResponsibilityResolved,
  medicaidMedicareClaimLinkageSupported,
  medicarePrimaryRequiredForDual,
  medicaidRateSchedulePresentForServiceDate,
  medicaidPayerRatePolicySnapshotVerified,
  medicaidHospiceInstitutionalFormatQualified,
  medicaidStateSpecificModifiersValid,
  medicaidStateSpecificDocumentation,
  medicaidEvvBracketCoherence,
  medicaidCapCoherence,
]);

/** Build a fresh, UN-frozen registry pre-populated with the platform-default rules. */
export function createDefaultMedicaidRegistry(): MedicaidRuleRegistry {
  const registry = new MedicaidRuleRegistry();
  registry.registerRules(DEFAULT_MEDICAID_RULES);
  return registry;
}
