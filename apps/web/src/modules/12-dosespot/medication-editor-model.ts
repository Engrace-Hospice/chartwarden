/** Pure editor boundary helpers.  Keeping this small makes contract-field round trips testable. */
export type MedicationEditorKind = "standard" | "controlled_substance" | "compounded";
export type MedicationEditorData = Record<string, any>;

export function emptyMedicationData(kind: MedicationEditorKind = "standard"): MedicationEditorData {
  return {
    sigStructured: { doseQuantity: "", doseUnit: "", route: "", frequencyCode: "", asNeeded: false },
    sigFreeText: "",
    refillsAuthorized: 0,
    dispenseQuantity: { value: "", unit: "" },
    daysSupply: "",
    daw: kind === "compounded",
  };
}

/** GET data is already the canonical payload: clone it so local updates never mutate the response. */
export function hydrateMedicationData(value: unknown, kind: MedicationEditorKind): MedicationEditorData {
  return value && typeof value === "object" && !Array.isArray(value)
    ? structuredClone(value) as MedicationEditorData
    : emptyMedicationData(kind);
}

/** Canonical compound rule: a non-controlled compound never sends a stale DEA schedule. */
export function serializeMedicationData(data: MedicationEditorData, kind: MedicationEditorKind): MedicationEditorData {
  const next = structuredClone(data) as MedicationEditorData;
  if (kind === "compounded") {
    // This is a literal in the canonical schema, not a user preference.
    next.daw = true;
    if (next.containsControlled !== true) delete next.deaSchedule;
  }
  return next;
}
