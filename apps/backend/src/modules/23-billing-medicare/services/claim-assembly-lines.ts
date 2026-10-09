// apps/backend/src/modules/23-billing-medicare/services/claim-assembly-lines.ts — the claim-line construction the
// assembly delegates (CMS Pub. 100-04 ch. 11 §30.3): the per-diem line amounts (CHC in 15-minute units) and the
// per-visit lines. The pure derivations live in `@wardenx/billing` (`claim-lines/`); this file only maps their
// output onto `claim_line` insert rows and fails closed on a visit it cannot report.
import {
  type BuildVisitLinesInput,
  type HippsSegmentResult,
  buildVisitLines,
  chcLineFromSegment,
  type repositories,
} from "@wardenx/billing";
import { WardenXError } from "@wardenx/types";

type NewClaimLineInput = repositories.NewClaimLineInput;

/**
 * The unit charge of a visit line. Charges on visit lines are informational — the visit is bundled into the level
 * -of-care payment and "no additional payment is made on the visit revenue lines" (ch. 11 §30.3) — and WardenX has
 * no tenant charge master, so visit lines are reported at zero charge. OPEN PRODUCT DECISION: a tenant charge
 * schedule per discipline would replace this.
 */
export const VISIT_UNIT_CHARGE_CENTS = 0;

/** The units / unit rate / charge of one per-diem segment's line (CHC in 15-minute units, the rest in days). */
export function perDiemLineAmounts(segment: HippsSegmentResult): {
  readonly unitCount: number;
  readonly unitRateCents: number;
  readonly lineChargeCents: number;
} {
  if (segment.levelOfCare === "continuous_home_care") return chcLineFromSegment(segment);
  return {
    unitCount: segment.days,
    unitRateCents: segment.ratePerDiemCents,
    // CHECK (line_charge_cents = unit_count * unit_rate_cents): compute the product directly.
    lineChargeCents: segment.ratePerDiemCents * segment.days,
  };
}

/**
 * The visit lines for the claim, numbered from `firstLineNumber`. A billable visit whose duration is undocumented,
 * or that no level-of-care period covers, cannot be reported honestly and fails the assembly with the encounter ids
 * (ids only — no PHI); visits whose reporting rule is not implemented are skipped (see the builder's `deferred`).
 */
export function buildVisitLineInputs(args: {
  readonly orgId: string;
  readonly visits: BuildVisitLinesInput;
  readonly qCode: NewClaimLineInput["qCode"];
  readonly icdPointerPositions: readonly number[];
  readonly firstLineNumber: number;
}): NewClaimLineInput[] {
  const { lines, unresolved } = buildVisitLines(args.visits);
  if (unresolved.length > 0) {
    const detail = unresolved.map((u) => `${u.encounterId} (${u.reason})`).join(", ");
    throw new WardenXError(
      "VISIT_LINES_UNRESOLVED",
      `${unresolved.length} billable visit(s) cannot be reported on the claim: ${detail}; document the visit start/end times (or the level of care covering the visit date) and retry`,
      422,
    );
  }
  return lines.map((visit, idx) => ({
    organizationId: args.orgId,
    claimId: "", // filled once the claim id is minted
    lineNumber: args.firstLineNumber + idx,
    revenueCode: visit.revenueCode,
    qCode: args.qCode,
    levelOfCare: visit.levelOfCare,
    hcpcsCode: visit.hcpcsCode,
    serviceDateFrom: visit.serviceDate,
    serviceDateTo: visit.serviceDate,
    unitCount: visit.unitCount,
    unitRateCents: VISIT_UNIT_CHARGE_CENTS,
    lineChargeCents: VISIT_UNIT_CHARGE_CENTS * visit.unitCount,
    levelOfCarePeriodId: visit.levelOfCarePeriodId,
    backingEncounterIds: [...visit.backingEncounterIds],
    icdPointerPositions: [...args.icdPointerPositions],
    modifiers: [],
  }));
}
