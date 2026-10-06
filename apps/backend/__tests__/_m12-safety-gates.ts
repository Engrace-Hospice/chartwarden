// GAP-036 — live suites that drive the REAL Drizzle M12 backend through `requestSignature` must now bind the
// two safety gates (the production default resolves the M39 ConsentEvaluator / M5 PatientAllergyReader seams
// and FAILS CLOSED when they are unregistered). These ports stand in for a patient with no recorded allergy
// and an SUD-consented chart; suites proving the DENY paths pass their own ports.
import type { DoseSpotSafetyGateDeps } from "../src/modules/12-dosespot/dosespot-route-service-db";

export const PASSING_M12_SAFETY_GATES: DoseSpotSafetyGateDeps = {
  resolveAllergyReader: () => ({ activeAllergies: async () => [] }),
  resolveConsentEvaluator: () => ({
    evaluateForInternalAccess: async () => ({ redactSubstanceUseDisorderFields: false }),
  }),
};
