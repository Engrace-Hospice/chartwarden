// @wardenx/types — hospice coverage determinations (FY2027 CoP workstream B, 42 CFR 418.24(b)(6)/(c)).
//
// From 2026-10-01 every hospice election must come with the "Patient Notification of Hospice Non-Covered
// Items, Services, and Drugs" addendum (§ 418.24(c)): the conditions, items, services and drugs the hospice
// has determined are NOT covered, each with a reason the patient can understand. The determination lives on
// the record that owns the item — M12 `medication_order` for drugs, M21 `supply_request` (dme | supply kinds)
// for equipment and supplies — and M6's addendum composes the not-covered rows through the module-owned
// `NonCoveredItemsReader` seams below. M6 never reads M12/M21 tables (architecture §25.15).
//
// `NonCoveredItemSnapshot` / `NonCoveredItemsReader` are declared with EXACTLY the shape workstream A (the M6
// addendum) declares on its own branch, so the COP27 integration merge is a de-duplication, not a redesign.

import { Type } from "@sinclair/typebox";
import { ValidationError } from "./errors";

/** The determination values (DB enum `hospice_coverage`, mirrored in `packages/db/src/enums.ts`). */
export const HOSPICE_COVERAGE_VALUES = [
  /** Related to the terminal illness and related conditions; the hospice covers it (the default). */
  "covered_related",
  /** Unrelated to the terminal illness and related conditions; NOT covered by the hospice (§ 418.24(c)(5)). */
  "not_covered_unrelated",
  /** Not covered for another reason (e.g. not reasonable and necessary for palliation) — still listed. */
  "not_covered_other",
] as const;

export type HospiceCoverage = (typeof HOSPICE_COVERAGE_VALUES)[number];

/** Upper bound on the patient-facing clinical explanation (§ 418.24(c)(6)). */
export const COVERAGE_REASON_MAX_LENGTH = 2000;

/** TypeBox mirror of {@link HospiceCoverage} — the route bodies / read projections of M12 and M21 share it. */
export const HospiceCoverageSchema = Type.Union([
  Type.Literal("covered_related"),
  Type.Literal("not_covered_unrelated"),
  Type.Literal("not_covered_other"),
]);

/** The set/change body both owning modules accept (`reason` required when not covered — 422 otherwise). */
export const SetHospiceCoverageBodySchema = Type.Object(
  {
    hospiceCoverage: HospiceCoverageSchema,
    reason: Type.Optional(
      Type.Union([Type.String({ maxLength: COVERAGE_REASON_MAX_LENGTH }), Type.Null()]),
    ),
  },
  { additionalProperties: false },
);

/** The coverage fields every read projection publishes (spread into the module's response schema). */
export const HospiceCoverageFieldsSchema = {
  hospiceCoverage: HospiceCoverageSchema,
  coverageReason: Type.Union([Type.String(), Type.Null()]),
  coverageDeterminedAt: Type.Union([Type.String(), Type.Null()]),
  coverageDeterminedBy: Type.Union([Type.String(), Type.Null()]),
} as const;

/** The DB default and the migration backfill value (see migrations 0385/0386 for why). */
export const DEFAULT_HOSPICE_COVERAGE: HospiceCoverage = "covered_related";

/** True for the two values that put an item on the addendum's not-covered list. */
export function isNotCovered(coverage: HospiceCoverage): boolean {
  return coverage !== "covered_related";
}

export type CoverageDeterminationValidation =
  | { readonly ok: true; readonly reason: string | null }
  | {
      readonly ok: false;
      readonly code: "COVERAGE_REASON_REQUIRED" | "COVERAGE_REASON_TOO_LONG";
      readonly message: string;
    };

/**
 * The one rule both modules (and the DB CHECK) enforce: a NOT-covered determination must carry a non-blank
 * reason (§ 418.24(c)(6) requires a written clinical explanation for every non-covered item). A covered
 * determination may carry an optional note; whitespace-only reasons normalise to `null`.
 */
export function validateCoverageDetermination(input: {
  readonly hospiceCoverage: HospiceCoverage;
  readonly reason?: string | null;
}): CoverageDeterminationValidation {
  const trimmed = input.reason?.trim() ?? "";
  if (trimmed.length > COVERAGE_REASON_MAX_LENGTH) {
    return {
      ok: false,
      code: "COVERAGE_REASON_TOO_LONG",
      message: `coverage reason must be at most ${COVERAGE_REASON_MAX_LENGTH} characters`,
    };
  }
  if (isNotCovered(input.hospiceCoverage) && trimmed.length === 0) {
    return {
      ok: false,
      code: "COVERAGE_REASON_REQUIRED",
      message:
        "a reason is required when an item is not covered by the hospice (42 CFR 418.24(c)(6))",
    };
  }
  return { ok: true, reason: trimmed.length === 0 ? null : trimmed };
}

/**
 * {@link validateCoverageDetermination} for a write path: returns the normalised reason, or throws the
 * 422 `ValidationError` (detail `field: "reason"`) both owning modules answer with.
 */
export function assertCoverageDetermination(input: {
  readonly hospiceCoverage: HospiceCoverage;
  readonly reason?: string | null;
}): string | null {
  const checked = validateCoverageDetermination(input);
  if (!checked.ok) {
    throw new ValidationError(checked.message, [
      { field: "reason", code: checked.code, message: checked.message },
    ]);
  }
  return checked.reason;
}

/** The coverage block every medication-order / supply-request read projection carries. */
export interface HospiceCoverageDetermination {
  readonly hospiceCoverage: HospiceCoverage;
  readonly coverageReason: string | null;
  /** `null` = never explicitly determined (the migration default, presumed related). */
  readonly coverageDeterminedAt: string | null;
  /** The acting MEMBERSHIP id (the codebase-wide "userId" convention); `null` when never determined. */
  readonly coverageDeterminedBy: string | null;
}

/**
 * The payload of `m12.medication_order.coverage_determination_changed` and
 * `m21.supply_request.coverage_determination_changed`. `sourceId` is the medication-order / supply-request
 * id. `reason` is the patient-facing clinical explanation: it is published deliberately because the
 * addendum must hand it to the patient and to non-hospice providers (§ 418.24(c)(6), (c)(9)).
 */
export interface HospiceCoverageDeterminationChangedPayload {
  readonly orgId: string;
  readonly admissionId?: string;
  readonly patientId: string;
  readonly sourceId: string;
  readonly hospiceCoverage: HospiceCoverage;
  readonly previousHospiceCoverage: HospiceCoverage;
  readonly reason: string | null;
  readonly changedAt: string;
}

// ── The M6 addendum seam contract (shape shared verbatim with workstream A) ────────────────────────────

export interface NonCoveredItemSnapshot {
  source: "problem" | "medication" | "dme" | "supply" | "service";
  sourceId: string;
  category: "condition" | "item" | "service" | "drug";
  description: string;
  reason: string;
  determinedAt: string;
  determinedByUserId: string | null;
}

export interface NonCoveredItemsReader {
  listForAdmission(orgId: string, admissionId: string): Promise<NonCoveredItemSnapshot[]>;
}
