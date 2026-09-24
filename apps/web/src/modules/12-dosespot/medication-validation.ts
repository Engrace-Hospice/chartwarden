export interface MedicationFinding {
  field?: string;
  code: string;
  message: string;
}

/** Canonical M12 paths → stable editor control ids, including compound array members. */
export function medicationFindingKey(field?: string): string | null {
  if (!field) return null;
  const canonical = field
    .replace(/^data\./, "")
    .replace(/^sigStructured\./, "sig.")
    .replace(/^dispenseQuantity\./, "quantity.")
    .replace(/^components\.(\d+)\./, "component.$1.");
  // Envelope fields deliberately use their wire name.  This makes one mapper cover
  // both route-contract findings and discriminated `data.*` findings.
  return canonical;
}

/** True only when the editor owns a control for this canonical/wire finding. */
export function isMedicationFindingMapped(field?: string): boolean {
  const key = medicationFindingKey(field);
  return key !== null && (
    [
      "admissionId", "medClass", "rxnormRxcui", "ndc", "drugName",
      "strength", "doseForm", "route", "prescriberDiscipline",
      "prescribingPhysicianMdmId", "dispensingPharmacyMdmId", "refillsAuthorized",
      "sigStructured", "sig.doseQuantity", "sig.doseUnit", "sig.route",
      "sig.frequencyCode", "sig.duration.durationValue", "sig.duration.durationUnit",
      "sig.asNeeded", "sig.asNeededReasonCode", "sigFreeText", "indication",
      "clinicalJustification", "notes", "quantity", "quantity.value", "quantity.unit",
      "daysSupply", "daw", "deaSchedule", "prescriberDea", "compoundingPharmacyMdmId",
      "formulationDescription", "containsControlled", "components",
    ].includes(key) || /^component\.\d+\.(rxnormRxcui|ndc|componentName|componentStrength|quantityRatio)$/.test(key)
  );
}

export function medicationFindings(error: unknown): MedicationFinding[] {
  const value = error as {
    error?: { details?: MedicationFinding[] };
    details?: MedicationFinding[];
  };
  return value?.error?.details ?? value?.details ?? [];
}
