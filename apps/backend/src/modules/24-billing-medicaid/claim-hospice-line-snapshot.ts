/** Transaction-bound M6 LOC evidence used to decide whether stored hospice lines may become READY. */
export interface CurrentLocPeriodForClaim {
  readonly id: string;
  readonly version?: number;
  readonly updatedAt?: Date;
  readonly levelOfCare:
    | "routine_home_care"
    | "continuous_home_care"
    | "inpatient_respite_care"
    | "general_inpatient_care";
  readonly effectiveAt: Date;
  readonly endedAt: Date | null;
  /** M37 confirmation evidence required before IRC/GIP can own an inclusive death-date service day. */
  readonly ipuBedAssignmentId?: string | null;
}

export interface HospiceClaimLineForSnapshot {
  readonly id: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly medicaidClaimId: string;
  readonly serviceDate: Date | string;
  /** Inclusive end of the persisted line; null historical spans cannot be revalidated for priced use. */
  readonly serviceDateTo: Date | string | null;
  readonly revenueCode: string;
  readonly levelOfCare: string;
  readonly locPeriodId: string | null;
  readonly units: number;
  readonly rateAtAssemblyCents: number;
  readonly stateRateScheduleIdSnapshot: string | null;
  /** Present for immutable payer-rate snapshots; it is not a legacy state schedule identity. */
  readonly payerRatePolicyIdSnapshot?: string | null;
  readonly chargesCents: number;
  readonly isRb: boolean;
  readonly rbDayId: string | null;
}

export interface HospiceClaimLineSnapshotIssue {
  readonly code: "MEDICAID_CLAIM_LINE_LOC_SNAPSHOT_STALE";
  readonly message: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const M6_TO_M24_LOC = {
  routine_home_care: "RHC",
  continuous_home_care: "CHC",
  inpatient_respite_care: "IRC",
  general_inpatient_care: "GIP",
} as const;
const REVENUE_BY_LOC = { RHC: "0651", CHC: "0652", IRC: "0655", GIP: "0656" } as const;

const isoDay = (value: Date | string): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
const instant = (value: Date | string): number =>
  value instanceof Date ? value.getTime() : Date.parse(value);
const dateValue = (value: string): number => Date.parse(`${value}T00:00:00.000Z`);
const addDays = (value: string, count: number): string =>
  new Date(dateValue(value) + count * DAY_MS).toISOString().slice(0, 10);
/** M6 LOC windows are half-open by UTC calendar day: the end date belongs to the next LOC. */
export function m6LocClaimEndDate(
  endedAt: Date | string | null,
  inclusiveEndDate: string | null = null,
): string | null {
  if (endedAt === null) return null;
  const endDate = isoDay(endedAt);
  return endDate === inclusiveEndDate ? endDate : addDays(endDate, -1);
}

/**
 * A death date may extend only the terminal M6 LOC period ending on that date. If a LOC transition also
 * occurred that day, M6's half-open intervals assign the date to the later period. A tie is ambiguous and
 * therefore does not qualify for the inclusive-date exception.
 */
export function inclusiveDeathLocPeriodId(
  periods: readonly Pick<
    CurrentLocPeriodForClaim,
    "id" | "levelOfCare" | "effectiveAt" | "endedAt" | "ipuBedAssignmentId"
  >[],
  inclusiveEndDate: string | null | undefined,
): string | null {
  if (!inclusiveEndDate) return null;
  // First resolve which LOC period owns the date, using the same latest-effective rule as the ordinary
  // half-open interval lookup. Only then consider extending that terminal period through its end date.
  // Filtering to periods that ended on the death date first would incorrectly extend an older period when
  // a newer period started that day and remains open (or ends later).
  const candidates = periods.filter((period) => isoDay(period.effectiveAt) <= inclusiveEndDate);
  if (candidates.length === 0) return null;
  const latestEffectiveAt = Math.max(...candidates.map((period) => instant(period.effectiveAt)));
  const latest = candidates.filter((period) => instant(period.effectiveAt) === latestEffectiveAt);
  if (latest.length !== 1) return null;
  const terminal = latest[0]!;
  if (terminal.endedAt === null || isoDay(terminal.endedAt) !== inclusiveEndDate) return null;
  if (
    (terminal.levelOfCare === "inpatient_respite_care" ||
      terminal.levelOfCare === "general_inpatient_care") &&
    !terminal.ipuBedAssignmentId
  ) {
    return null;
  }
  return terminal.id;
}
const inclusiveDays = (from: string, to: string): number =>
  Math.round((dateValue(to) - dateValue(from)) / DAY_MS) + 1;

/**
 * Verify that persisted non-R&B daily claim lines still form a complete, nonoverlapping partition of the
 * current M6 LOC window. A LOC period may contain multiple lines when a qualified rate/policy boundary
 * split it. Caller must lock the M6 admission row and read the periods on the same transaction. This legacy
 * validator checks only daily arithmetic and does not attest a payer-rate snapshot or reprice a claim.
 */
export function hospiceClaimLineSnapshotIssue(input: {
  readonly lines: readonly HospiceClaimLineForSnapshot[];
  readonly periods: readonly CurrentLocPeriodForClaim[];
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly claimId: string;
  readonly serviceFrom: string;
  readonly serviceTo: string;
  /** Only set when the locked M6 stay facts confirm the inclusive date of death. */
  readonly inclusiveEndDate?: string | null;
}): HospiceClaimLineSnapshotIssue | null {
  const refusal = (): HospiceClaimLineSnapshotIssue => ({
    code: "MEDICAID_CLAIM_LINE_LOC_SNAPSHOT_STALE",
    message:
      "Stored hospice claim lines no longer match the current M6 level-of-care periods. Reconcile the service range and assemble a corrected draft before validation.",
  });
  const lines = input.lines.filter((line) => !line.isRb);
  if (lines.length === 0 || input.serviceFrom > input.serviceTo) return refusal();

  const inclusiveDeathPeriodId = inclusiveDeathLocPeriodId(input.periods, input.inclusiveEndDate);
  const periods = input.periods
    .map((period) => ({
      ...period,
      inclusiveDeathEnd: period.id === inclusiveDeathPeriodId ? input.inclusiveEndDate : null,
    }))
    .map((period) => ({
      id: period.id,
      levelOfCare: M6_TO_M24_LOC[period.levelOfCare],
      from: isoDay(period.effectiveAt),
      to: m6LocClaimEndDate(period.endedAt, period.inclusiveDeathEnd) ?? input.serviceTo,
    }))
    .filter((period) => period.from <= input.serviceTo && period.to >= input.serviceFrom)
    .map((period) => ({
      ...period,
      from: period.from < input.serviceFrom ? input.serviceFrom : period.from,
      to: period.to > input.serviceTo ? input.serviceTo : period.to,
    }))
    .sort((left, right) => left.from.localeCompare(right.from));

  const linesByPeriod = new Map<string, HospiceClaimLineForSnapshot[]>();
  for (const line of lines) {
    if (!line.locPeriodId) return refusal();
    const existing = linesByPeriod.get(line.locPeriodId) ?? [];
    existing.push(line);
    linesByPeriod.set(line.locPeriodId, existing);
  }

  let expectedFrom = input.serviceFrom;
  for (const period of periods) {
    if (period.from !== expectedFrom || period.to < period.from) return refusal();
    const periodLines = (linesByPeriod.get(period.id) ?? []).sort((left, right) =>
      isoDay(left.serviceDate).localeCompare(isoDay(right.serviceDate)),
    );
    if (periodLines.length === 0) return refusal();
    let expectedSegmentFrom = period.from;
    for (const line of periodLines) {
      if (line.serviceDateTo === null) return refusal();
      const lineFrom = isoDay(line.serviceDate);
      const lineTo = isoDay(line.serviceDateTo);
      const expectedUnits = inclusiveDays(lineFrom, lineTo);
      const payerRatePriced = line.payerRatePolicyIdSnapshot != null;
      if (
        line.organizationId !== input.organizationId ||
        line.providerEntityId !== input.providerEntityId ||
        line.medicaidClaimId !== input.claimId ||
        line.isRb ||
        line.rbDayId !== null ||
        lineFrom !== expectedSegmentFrom ||
        lineTo < lineFrom ||
        lineTo > period.to ||
        line.levelOfCare !== period.levelOfCare ||
        line.revenueCode !== REVENUE_BY_LOC[period.levelOfCare] ||
        line.units !== expectedUnits ||
        line.rateAtAssemblyCents <= 0 ||
        (payerRatePriced
          ? line.stateRateScheduleIdSnapshot !== null || line.chargesCents <= 0
          : line.stateRateScheduleIdSnapshot === null ||
            line.chargesCents !== line.rateAtAssemblyCents * line.units)
      ) {
        return refusal();
      }
      expectedSegmentFrom = addDays(lineTo, 1);
    }
    if (expectedSegmentFrom !== addDays(period.to, 1)) return refusal();
    linesByPeriod.delete(period.id);
    expectedFrom = addDays(period.to, 1);
  }

  if (linesByPeriod.size > 0 || expectedFrom !== addDays(input.serviceTo, 1)) return refusal();
  return null;
}
