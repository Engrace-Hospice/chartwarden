// apps/backend/src/modules/23-billing-medicare/services/claim-assembly-lines.ts — the claim-line construction the
// assembly delegates (CMS Pub. 100-04 ch. 11 §30.3): the per-diem line amounts (CHC in 15-minute units) and the
// per-visit lines. The pure derivations live in `@chartwarden/billing` (`claim-lines/`); this file only maps their
// output onto `claim_line` insert rows. It is shared by the assembly and by re-validation
// (`validation-context.ts`), so both see the same visits skipped and the same lines.
import {
  type BillableEncounterSnapshot,
  type BuildVisitLinesInput,
  type PerDiemClassSegmentResult,
  type VisitChargeVersion,
  type VisitLinesResult,
  type VisitReportingSnapshot,
  buildVisitLines,
  chcLineFromSegment,
  missingVisitCharges,
  type repositories,
  visitUnitChargeOn,
} from "@chartwarden/billing";
import { ChartWardenError } from "@chartwarden/types";

type NewClaimLineInput = repositories.NewClaimLineInput;

/** The units / unit rate / charge of one per-diem segment's line (CHC in 15-minute units, the rest in days). */
export function perDiemLineAmounts(segment: PerDiemClassSegmentResult): {
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

/** What the visit derivation reads from the assembly facts (shared by the assembly and re-validation). */
export interface VisitFacts {
  readonly billableEncounters: readonly BillableEncounterSnapshot[];
  readonly resolvedLoc: readonly {
    readonly levelOfCarePeriodId: string;
    readonly levelOfCare: BuildVisitLinesInput["levelOfCarePeriods"][number]["levelOfCare"];
    readonly from: string;
    readonly to: string;
  }[];
  readonly qCode: NewClaimLineInput["qCode"];
}

/**
 * Derive the claim's visit lines from the facts. An encounter from a reader that predates visit reporting (no
 * discipline) is not a visit. NEVER throws: a visit that cannot be reported comes back in `unresolved` and is
 * skipped, so the claim still assembles and the `visit_lines_reportable` warning names it.
 */
export function visitLinesFor(facts: VisitFacts): VisitLinesResult {
  return buildVisitLines({
    encounters: facts.billableEncounters.flatMap((e) =>
      e.discipline === undefined
        ? []
        : [
            {
              encounterId: e.encounterId,
              serviceDate: e.serviceDate,
              billability: e.billability,
              discipline: e.discipline,
              encounterType: e.encounterType ?? null,
              durationMinutes: e.durationMinutes ?? null,
            },
          ],
    ),
    levelOfCarePeriods: facts.resolvedLoc.map((p) => ({
      levelOfCarePeriodId: p.levelOfCarePeriodId,
      levelOfCare: p.levelOfCare,
      from: p.from,
      to: p.to,
    })),
    inpatientHospiceFacility: facts.qCode === "Q5006",
  });
}

/** The PHI-free snapshot the `visit_lines_reportable` rule reads. */
export function visitReportingOf(result: VisitLinesResult): VisitReportingSnapshot {
  return { unresolved: result.unresolved, deferredCount: result.deferred.length };
}

/**
 * The `claim_line` rows for a visit derivation, numbered from `firstLineNumber`, each billed at the TENANT-ENTERED
 * charge per 15-minute unit for its discipline on its date (the visit charge is informational — "no additional
 * payment is made on the visit revenue lines", ch. 11 §30.3 — so it never reaches the expected payment). FAILS
 * CLOSED (`VISIT_CHARGE_MISSING`, 422) when a billed discipline has no charge on its date: never a default.
 */
export function visitLineInputs(args: {
  readonly orgId: string;
  readonly result: VisitLinesResult;
  readonly chargeVersions: readonly VisitChargeVersion[];
  readonly qCode: NewClaimLineInput["qCode"];
  readonly icdPointerPositions: readonly number[];
  readonly firstLineNumber: number;
}): NewClaimLineInput[] {
  const missing = missingVisitCharges(args.chargeVersions, args.result.lines);
  if (missing.length > 0) {
    throw new ChartWardenError(
      "VISIT_CHARGE_MISSING",
      `the claim bills visits for ${[...missing].sort().join(", ")} but no visit charge is entered for that discipline on the visit date; enter the visit-charge schedule (POST /api/v1/billing/visit-charge-schedules, permission billing.visit_charge.admin) and retry`,
      422,
    );
  }
  return args.result.lines.map((visit, idx) => {
    const unitRateCents = visitUnitChargeOn(
      args.chargeVersions,
      visit.serviceDate,
      visit.discipline,
    );
    if (unitRateCents === null) {
      // `missingVisitCharges` above found a charge for every line, so this is a logic error — never bill it as free.
      throw new ChartWardenError(
        "VISIT_CHARGE_MISSING",
        `no visit charge resolved for ${visit.discipline} on ${visit.serviceDate} after the schedule check passed`,
        422,
      );
    }
    return {
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
      unitRateCents,
      // CHECK (line_charge_cents = unit_count * unit_rate_cents)
      lineChargeCents: unitRateCents * visit.unitCount,
      levelOfCarePeriodId: visit.levelOfCarePeriodId,
      backingEncounterIds: [...visit.backingEncounterIds],
      icdPointerPositions: [...args.icdPointerPositions],
      modifiers: [],
    };
  });
}
