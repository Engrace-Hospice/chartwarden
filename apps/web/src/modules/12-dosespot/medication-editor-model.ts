/** Pure editor boundary helpers.  Keeping this small makes contract-field round trips testable. */
export type MedicationEditorKind = "standard" | "controlled_substance" | "compounded";
export type MedicationEditorData = Record<string, any>;

export function emptyMedicationData(kind: MedicationEditorKind = "standard"): MedicationEditorData {
  return {
    sigStructured: {
      doseQuantity: "",
      doseUnit: "",
      route: "",
      frequencyCode: "",
      asNeeded: false,
    },
    sigFreeText: "",
    refillsAuthorized: 0,
    dispenseQuantity: { value: "", unit: "" },
    daysSupply: "",
    daw: kind === "compounded",
  };
}

/**
 * GET data is already the canonical payload: clone it so local updates never mutate the response.
 *
 * One default is applied: `refillsAuthorized`. A draft opened from the chart's "Prescribe" dialog
 * stores only `sigStructured`, and the Refills control renders `data.refillsAuthorized ?? 0` — so the
 * prescriber SAW 0 refills while the payload carried none, and request-signature refused the order
 * ("data.refillsAuthorized: Expected required property") with nothing on screen to fix. For a
 * Schedule II order the control is disabled, so it could not be fixed by typing either. Seeding the
 * state with the value the control already shows makes what is saved match what is displayed.
 */
export function hydrateMedicationData(
  value: unknown,
  kind: MedicationEditorKind,
): MedicationEditorData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyMedicationData(kind);
  const data = structuredClone(value) as MedicationEditorData;
  if (data.refillsAuthorized === undefined) data.refillsAuthorized = 0;
  return data;
}

/** Canonical compound rule: a non-controlled compound never sends a stale DEA schedule. */
export function serializeMedicationData(
  data: MedicationEditorData,
  kind: MedicationEditorKind,
): MedicationEditorData {
  const next = structuredClone(data) as MedicationEditorData;
  if (kind === "compounded") {
    // This is a literal in the canonical schema, not a user preference.
    next.daw = true;
    if (next.containsControlled !== true) {
      // Omit the key entirely (rather than `= undefined`) so the wire payload has no stale field.
      const { deaSchedule: _staleSchedule, ...withoutSchedule } = next;
      return withoutSchedule;
    }
  }
  return next;
}
