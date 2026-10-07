// apps/backend/src/modules/21-supplies/lifecycle/coverage-determination.ts — COP27 workstream B
// (42 CFR 418.24(c)). The pure rules for a supply request's hospice coverage determination.
//
// NOT a §2.2 transition (status never moves; a determination may be set in any status, including after
// delivery — a plan-of-care change can re-classify equipment already in the home, § 418.24(d)(2)). Two rules:
//   1. only the GOODS kinds (`dme` | `supply`) carry a determination. A comfort kit is the hospice's own
//      symptom-management medication supply by construction; a drug in it the hospice deems unrelated is
//      determined on its M12 `medication_order` (mirrors CHECK `m21_supply_request_coverage_kind`);
//   2. a NOT-covered value needs a non-blank reason (`assertCoverageDetermination`, shared with M12 and
//      mirrored by CHECK `m21_supply_request_coverage_reason`).
import {
  type HospiceCoverage,
  type SupplyRequestKind,
  assertCoverageDetermination,
} from "@wardenx/types";
import { SupplyStateError } from "./errors";

/** The kinds a hospice coverage determination applies to. */
export const COVERAGE_DETERMINABLE_KINDS: ReadonlySet<SupplyRequestKind> =
  new Set<SupplyRequestKind>(["dme", "supply"]);

/**
 * Validate a determination against the row's kind; returns the normalised reason (`null` when blank).
 * Throws `M21_COVERAGE_NOT_APPLICABLE_TO_KIND` (422) for a kit kind, the shared 422 for a missing reason.
 */
export function decideCoverageDetermination(input: {
  readonly kind: SupplyRequestKind;
  readonly hospiceCoverage: HospiceCoverage;
  readonly reason?: string | null;
}): string | null {
  if (!COVERAGE_DETERMINABLE_KINDS.has(input.kind)) {
    throw new SupplyStateError(
      "M21_COVERAGE_NOT_APPLICABLE_TO_KIND",
      `a hospice coverage determination applies to dme and supply requests only (this is a ${input.kind}); determine a comfort-kit drug on its medication order`,
    );
  }
  return assertCoverageDetermination(input);
}
