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
  // A row retires its predecessor only if it was ever in force. A pending (unverified) or rejected proposal never
  // was, so it must not remove a verified classification; a revoked or itself-superseded one was, so its
  // predecessor stays retired (fail closed). The table is append-only, so verifying a proposal means appending a
  // new row that points at the PROPOSAL: the retirement passes through proposals to the row they proposed to replace.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const neverInForce = (r: MedicaidPayerProgramClassification): boolean =>
    r.verificationStatus === "unverified" || r.verificationStatus === "rejected";
  const supersededIds = new Set<string>();
  for (const row of rows) {
    if (neverInForce(row)) continue;
    let id = row.supersedesId;
    while (id && !supersededIds.has(id)) {
      supersededIds.add(id);
      const next = byId.get(id);
      id = next && neverInForce(next) ? next.supersedesId : null;
    }
  }
  const currentRows = rows.filter(
    (r) => r.verificationStatus !== "superseded" && !supersededIds.has(r.id),
  );
  const coveringAny = currentRows.filter(
    (r) => r.effectiveFrom <= serviceFrom && (r.effectiveTo === null || r.effectiveTo >= serviceTo),
  );
  // Unverified evidence only speaks (to say "unverified") when no verified row covers the window.
  const coveringVerified = coveringAny.filter((r) => r.verificationStatus === "verified");
  const covering = coveringVerified.length > 0 ? coveringVerified : coveringAny;
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
