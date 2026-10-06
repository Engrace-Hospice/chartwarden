// @wardenx/types — hospice coverage determinations (FY2027, 42 CFR 418.24(c)). The seam M6's election statement
// addendum reads non-covered determinations through; each source module (M7 problems, M12 medications, M21
// DME/supplies, services) implements it and the composition root merges them.

/**
 * One relatedness determination another module made: "this condition / item / service / drug is unrelated to the
 * terminal illness and related conditions, so the hospice will not cover it".
 */
export interface NonCoveredItemSnapshot {
  source: "problem" | "medication" | "dme" | "supply" | "service";
  sourceId: string;
  category: "condition" | "item" | "service" | "drug";
  description: string;
  reason: string;
  determinedAt: string;
  determinedByUserId: string | null;
}

/** Lists an admission's current non-covered determinations. `orgId` is explicit (runs outside a request). */
export interface NonCoveredItemsReader {
  listForAdmission(orgId: string, admissionId: string): Promise<NonCoveredItemSnapshot[]>;
}
