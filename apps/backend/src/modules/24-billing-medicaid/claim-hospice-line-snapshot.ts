/** Transaction-bound M6 LOC evidence used to decide whether stored hospice lines may become READY. */
export interface CurrentLocPeriodForClaim {
  readonly id: string;
  readonly levelOfCare:
    | "routine_home_care"
    | "continuous_home_care"
    | "inpatient_respite_care"
    | "general_inpatient_care";
  readonly effectiveAt: Date;
  readonly endedAt: Date | null;
}

export interface HospiceClaimLineForSnapshot {
  readonly id: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly medicaidClaimId: string;
  readonly serviceDate: Date | string;
  readonly revenueCode: string;
  readonly levelOfCare: string;
  readonly locPeriodId: string | null;
  readonly units: number;
  readonly rateAtAssemblyCents: number;
  readonly stateRateScheduleIdSnapshot: string | null;
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
const inclusiveDays = (from: string, to: string): number =>
  Math.round((dateValue(to) - dateValue(from)) / DAY_MS) + 1;

/**
 * Verify that persisted non-R&B claim lines still correspond one-for-one to the complete current M6 LOC
 * partition of the claim range. Caller must first lock the M6 admission row and read these periods on the
 * same transaction. The helper validates the saved line arithmetic but deliberately does not reprice it.
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

  const periods = input.periods
    .map((period) => ({
      id: period.id,
      levelOfCare: M6_TO_M24_LOC[period.levelOfCare],
      from: isoDay(period.effectiveAt),
      to: m6LocClaimEndDate(period.endedAt, input.inclusiveEndDate) ?? input.serviceTo,
    }))
    .filter((period) => period.from <= input.serviceTo && period.to >= input.serviceFrom)
    .map((period) => ({
      ...period,
      from: period.from < input.serviceFrom ? input.serviceFrom : period.from,
      to: period.to > input.serviceTo ? input.serviceTo : period.to,
    }))
    .sort((left, right) => left.from.localeCompare(right.from));

  const lineByPeriod = new Map<string, HospiceClaimLineForSnapshot>();
  for (const line of lines) {
    if (!line.locPeriodId || lineByPeriod.has(line.locPeriodId)) return refusal();
    lineByPeriod.set(line.locPeriodId, line);
  }

  let expectedFrom = input.serviceFrom;
  for (const period of periods) {
    if (period.from !== expectedFrom || period.to < period.from) return refusal();
    const line = lineByPeriod.get(period.id);
    if (!line) return refusal();
    const expectedUnits = inclusiveDays(period.from, period.to);
    if (
      line.organizationId !== input.organizationId ||
      line.providerEntityId !== input.providerEntityId ||
      line.medicaidClaimId !== input.claimId ||
      line.isRb ||
      line.rbDayId !== null ||
      isoDay(line.serviceDate) !== period.from ||
      line.levelOfCare !== period.levelOfCare ||
      line.revenueCode !== REVENUE_BY_LOC[period.levelOfCare] ||
      line.units !== expectedUnits ||
      line.rateAtAssemblyCents <= 0 ||
      line.stateRateScheduleIdSnapshot === null ||
      line.chargesCents !== line.rateAtAssemblyCents * line.units
    ) {
      return refusal();
    }
    lineByPeriod.delete(period.id);
    expectedFrom = addDays(period.to, 1);
  }

  if (lineByPeriod.size > 0 || expectedFrom !== addDays(input.serviceTo, 1)) return refusal();
  return null;
}
