import type { MedicaidPayerProgramClassification } from "@chartwarden/mdm";

export type MedicaidProgramClassificationReason =
  | "MEDICAID_PROGRAM_CLASSIFICATION_MISSING"
  | "MEDICAID_PROGRAM_CLASSIFICATION_UNVERIFIED"
  | "MEDICAID_PROGRAM_CLASSIFICATION_EXPIRED"
  | "MEDICAID_PROGRAM_CLASSIFICATION_AMBIGUOUS"
  | "MEDICAID_PROGRAM_CLASSIFICATION_MISMATCH";

export type MedicaidProgramClassificationDecision =
  | { readonly qualified: true; readonly classification: MedicaidPayerProgramClassification }
  | { readonly qualified: false; readonly reasonCode: MedicaidProgramClassificationReason };

/**
 * Only one source-verified M40 classification covering the entire service window can qualify, and no other
 * verified classification may contradict it anywhere inside that window.
 */
export function qualifyMedicaidProgramClassification(
  rows: readonly MedicaidPayerProgramClassification[],
  requestedKind: string,
  canonicalPayerId: string,
  stateCode: string,
  serviceFrom: string,
  serviceTo: string,
): MedicaidProgramClassificationDecision {
  if (serviceFrom > serviceTo)
    return { qualified: false, reasonCode: "MEDICAID_PROGRAM_CLASSIFICATION_MISMATCH" };
  if (rows.length === 0)
    return { qualified: false, reasonCode: "MEDICAID_PROGRAM_CLASSIFICATION_MISSING" };
  const supersededIds = new Set(rows.flatMap((r) => (r.supersedesId ? [r.supersedesId] : [])));
  const currentRows = rows.filter(
    (r) => r.verificationStatus !== "superseded" && !supersededIds.has(r.id),
  );
  const covering = currentRows.filter(
    (r) => r.effectiveFrom <= serviceFrom && (r.effectiveTo === null || r.effectiveTo >= serviceTo),
  );
  if (covering.length > 1)
    return { qualified: false, reasonCode: "MEDICAID_PROGRAM_CLASSIFICATION_AMBIGUOUS" };
  if (covering.length === 0) {
    return {
      qualified: false,
      reasonCode: currentRows.some(
        (r) =>
          r.verificationStatus === "verified" &&
          r.effectiveTo !== null &&
          r.effectiveTo < serviceFrom,
      )
        ? "MEDICAID_PROGRAM_CLASSIFICATION_EXPIRED"
        : "MEDICAID_PROGRAM_CLASSIFICATION_UNVERIFIED",
    };
  }
  const classification = covering[0]!;
  // A verified record that starts or ends inside the window and says something different means the window
  // straddles two programs; the covering row alone must not speak for the days the other one governs.
  const contradicted = currentRows.some(
    (r) =>
      r !== classification &&
      r.verificationStatus === "verified" &&
      r.effectiveFrom <= serviceTo &&
      (r.effectiveTo === null || r.effectiveTo >= serviceFrom) &&
      (r.classification !== classification.classification ||
        r.canonicalPayerId !== classification.canonicalPayerId ||
        r.stateCode !== classification.stateCode),
  );
  if (contradicted)
    return { qualified: false, reasonCode: "MEDICAID_PROGRAM_CLASSIFICATION_AMBIGUOUS" };
  if (
    classification.canonicalPayerId !== canonicalPayerId ||
    classification.stateCode !== stateCode ||
    (classification.classification === "oregon_ffs" && classification.stateCode !== "OR")
  ) {
    return { qualified: false, reasonCode: "MEDICAID_PROGRAM_CLASSIFICATION_MISMATCH" };
  }
  if (classification.verificationStatus !== "verified")
    return { qualified: false, reasonCode: "MEDICAID_PROGRAM_CLASSIFICATION_UNVERIFIED" };
  const compatible =
    (requestedKind === "ffs_open_card" && classification.classification === "oregon_ffs") ||
    (requestedKind === "managed_care" && classification.classification === "medicaid_cco") ||
    (requestedKind === "other_managed_care" &&
      classification.classification === "other_managed_care");
  return compatible
    ? { qualified: true, classification }
    : { qualified: false, reasonCode: "MEDICAID_PROGRAM_CLASSIFICATION_MISMATCH" };
}
