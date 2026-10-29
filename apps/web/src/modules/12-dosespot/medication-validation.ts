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
  return (
    key !== null &&
    ([
      "admissionId",
      "medClass",
      "rxnormRxcui",
      "ndc",
      "drugName",
      "strength",
      "doseForm",
      "route",
      "prescriberDiscipline",
      "prescribingPhysicianMdmId",
      "dispensingPharmacyMdmId",
      "refillsAuthorized",
      "sigStructured",
      "sig.doseQuantity",
      "sig.doseUnit",
      "sig.route",
      "sig.frequencyCode",
      "sig.duration.durationValue",
      "sig.duration.durationUnit",
      "sig.asNeeded",
      "sig.asNeededReasonCode",
      "sigFreeText",
      "indication",
      "clinicalJustification",
      "notes",
      "quantity",
      "quantity.value",
      "quantity.unit",
      "daysSupply",
      "daw",
      "deaSchedule",
      "prescriberDea",
      "compoundingPharmacyMdmId",
      "formulationDescription",
      "containsControlled",
      "components",
    ].includes(key) ||
      /^component\.\d+\.(rxnormRxcui|ndc|componentName|componentStrength|quantityRatio)$/.test(key))
  );
}

export function medicationFindings(error: unknown): MedicationFinding[] {
  const value = error as {
    error?: { details?: MedicationFinding[] };
    details?: MedicationFinding[];
  };
  return value?.error?.details ?? value?.details ?? [];
}

const FINDING_LABELS: Record<string, string> = {
  admissionId: "Admission",
  medClass: "Medication class",
  rxnormRxcui: "RxNorm drug",
  ndc: "NDC",
  drugName: "Drug name",
  strength: "Strength",
  doseForm: "Dose form",
  route: "Drug route",
  prescriberDiscipline: "Prescriber discipline",
  prescribingPhysicianMdmId: "Prescribing physician",
  dispensingPharmacyMdmId: "Dispensing pharmacy",
  refillsAuthorized: "Refills",
  sigStructured: "SIG",
  "sig.doseQuantity": "SIG dose quantity",
  "sig.doseUnit": "SIG dose unit",
  "sig.route": "SIG route",
  "sig.frequencyCode": "SIG frequency",
  "sig.duration.durationValue": "SIG duration",
  "sig.duration.durationUnit": "SIG duration unit",
  "sig.asNeeded": "SIG as needed",
  "sig.asNeededReasonCode": "SIG as-needed reason",
  sigFreeText: "SIG text",
  indication: "Indication",
  clinicalJustification: "Clinical justification",
  quantity: "Dispense quantity",
  "quantity.value": "Dispense quantity",
  "quantity.unit": "Dispense quantity unit",
  daysSupply: "Days supply",
  daw: "Dispense as written",
  deaSchedule: "DEA schedule",
};

/** A reader-facing name for a finding's field path (`data.sigStructured.route` → `SIG route`). */
export function medicationFieldLabel(field?: string): string | null {
  const key = medicationFindingKey(field);
  if (key === null) return null;
  return FINDING_LABELS[key] ?? null;
}

/** `SIG route: message; Strength: message` — findings whose field has no label show the bare message. */
export function describeMedicationFindings(findings: readonly MedicationFinding[]): string {
  return findings
    .map((f) => {
      const label = medicationFieldLabel(f.field);
      return label ? `${label}: ${f.message}` : f.message;
    })
    .join("; ");
}
