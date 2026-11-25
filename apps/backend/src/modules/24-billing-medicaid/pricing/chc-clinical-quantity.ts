/** M8-backed interval projection used to measure actual CHC care. This does not decide payer eligibility. */
export interface SignedChcEncounterFact {
  readonly organizationId: string;
  readonly providerEntityId: string | null;
  readonly patientId: string;
  readonly admissionId: string;
  readonly encounterId: string;
  readonly serviceDate: string;
  readonly status: string;
  readonly signedAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly timeSource: "evv" | "clinician" | null;
  readonly sourceVersion: number | undefined;
}

export interface ChcDailyObservedQuantity {
  readonly serviceDate: string;
  /** Actual source-backed minutes. They are not billable minutes or institutional 837I units. */
  readonly actualClinicalMinutes: number;
  readonly sourceEncounters: readonly {
    readonly encounterId: string;
    readonly sourceVersion: number;
    readonly timeSource: "evv" | "clinician";
    readonly signedAt: string;
  }[];
}

export type ChcClinicalQuantityResult =
  | {
      readonly status: "observed";
      readonly days: readonly ChcDailyObservedQuantity[];
      readonly payerEligibility: "unresolved";
      readonly institutionalUnits: "unqualified";
    }
  | { readonly status: "unresolved" | "ambiguous"; readonly reasonCode: string };

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function zonedDate(value: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: "year" | "month" | "day") =>
    parts.find((entry) => entry.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  if (!year || !month || !day) throw new RangeError("timezone date could not be resolved");
  return `${year}-${month}-${day}`;
}

/** Find the first millisecond in the next local calendar day, including 23/25-hour DST days. */
function nextLocalDayBoundary(from: number, currentDate: string, timeZone: string): number | null {
  let low = from;
  let high = from + 30 * 60_000;
  const latest = from + 36 * 60 * 60_000;
  while (high <= latest && zonedDate(high, timeZone) === currentDate) {
    low = high;
    high += 30 * 60_000;
  }
  if (high > latest) return null;
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (zonedDate(middle, timeZone) === currentDate) low = middle;
    else high = middle;
  }
  return high;
}

export function resolveSignedChcClinicalQuantity(input: {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly serviceFrom: string;
  readonly serviceTo: string;
  readonly serviceTimeZone: string;
  /** M6 LOC dates that are actively assigned to continuous home care. */
  readonly chcServiceDates: readonly string[];
  readonly encounters: readonly SignedChcEncounterFact[];
}): ChcClinicalQuantityResult {
  if (
    !validDate(input.serviceFrom) ||
    !validDate(input.serviceTo) ||
    input.serviceFrom > input.serviceTo ||
    input.chcServiceDates.length === 0 ||
    input.chcServiceDates.some(
      (date) => !validDate(date) || date < input.serviceFrom || date > input.serviceTo,
    )
  ) {
    return { status: "unresolved", reasonCode: "CHC_SERVICE_WINDOW_OR_LOC_INVALID" };
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: input.serviceTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return { status: "unresolved", reasonCode: "CHC_SERVICE_TIMEZONE_UNAVAILABLE" };
  }
  if (!formatter) return { status: "unresolved", reasonCode: "CHC_SERVICE_TIMEZONE_UNAVAILABLE" };

  const chcDates = new Set(input.chcServiceDates);
  const encounterIds = new Set<string>();
  const intervals: {
    fact: SignedChcEncounterFact;
    start: number;
    end: number;
  }[] = [];
  for (const fact of input.encounters) {
    if (
      fact.organizationId !== input.organizationId ||
      fact.providerEntityId !== input.providerEntityId ||
      fact.patientId !== input.patientId ||
      fact.admissionId !== input.admissionId
    ) {
      return { status: "unresolved", reasonCode: "CHC_ENCOUNTER_SCOPE_MISMATCH" };
    }
    if (encounterIds.has(fact.encounterId)) {
      return { status: "ambiguous", reasonCode: "CHC_DUPLICATE_ENCOUNTER_SOURCE" };
    }
    encounterIds.add(fact.encounterId);
    if (fact.status !== "signed" && fact.status !== "cosigned") {
      return { status: "unresolved", reasonCode: "CHC_ENCOUNTER_NOT_SIGNED" };
    }
    if (
      !validDate(fact.serviceDate) ||
      fact.serviceDate < input.serviceFrom ||
      fact.serviceDate > input.serviceTo ||
      !fact.startedAt ||
      !fact.endedAt ||
      !fact.timeSource ||
      !Number.isSafeInteger(fact.sourceVersion) ||
      (fact.sourceVersion ?? -1) < 0 ||
      !Number.isFinite(Date.parse(fact.signedAt))
    ) {
      return { status: "unresolved", reasonCode: "CHC_ACTUAL_INTERVAL_EVIDENCE_INCOMPLETE" };
    }
    const start = Date.parse(fact.startedAt);
    const end = Date.parse(fact.endedAt);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start ||
      start % 60_000 !== 0 ||
      end % 60_000 !== 0
    ) {
      return { status: "unresolved", reasonCode: "CHC_ACTUAL_INTERVAL_INVALID" };
    }
    if (zonedDate(start, input.serviceTimeZone) !== fact.serviceDate) {
      return { status: "unresolved", reasonCode: "CHC_SOURCE_SERVICE_DATE_MISMATCH" };
    }
    intervals.push({ fact, start, end });
  }
  if (intervals.length === 0) {
    return { status: "unresolved", reasonCode: "CHC_ACTUAL_INTERVAL_EVIDENCE_MISSING" };
  }

  intervals.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < intervals.length; index += 1) {
    if (intervals[index]!.start < intervals[index - 1]!.end) {
      return { status: "ambiguous", reasonCode: "CHC_OVERLAPPING_CARE_INTERVALS_UNQUALIFIED" };
    }
  }

  const daily = new Map<
    string,
    { minutes: number; sources: ChcDailyObservedQuantity["sourceEncounters"][number][] }
  >();
  for (const { fact, start, end } of intervals) {
    let cursor = start;
    while (cursor < end) {
      const serviceDate = zonedDate(cursor, input.serviceTimeZone);
      if (serviceDate < input.serviceFrom || serviceDate > input.serviceTo) {
        return { status: "unresolved", reasonCode: "CHC_INTERVAL_OUTSIDE_SERVICE_WINDOW" };
      }
      if (!chcDates.has(serviceDate)) {
        return { status: "unresolved", reasonCode: "CHC_LOC_PERIOD_MISMATCH" };
      }
      const boundary = nextLocalDayBoundary(cursor, serviceDate, input.serviceTimeZone);
      if (boundary === null) {
        return { status: "unresolved", reasonCode: "CHC_LOCAL_DAY_BOUNDARY_UNRESOLVED" };
      }
      const chunkEnd = Math.min(boundary, end);
      const duration = chunkEnd - cursor;
      if (duration <= 0 || duration % 60_000 !== 0) {
        return { status: "unresolved", reasonCode: "CHC_MINUTE_PRECISION_UNRESOLVED" };
      }
      const row = daily.get(serviceDate) ?? { minutes: 0, sources: [] };
      row.minutes += duration / 60_000;
      if (!Number.isSafeInteger(row.minutes) || row.minutes > 1440) {
        return { status: "ambiguous", reasonCode: "CHC_DAILY_DURATION_CONFLICT" };
      }
      row.sources.push({
        encounterId: fact.encounterId,
        sourceVersion: fact.sourceVersion!,
        timeSource: fact.timeSource!,
        signedAt: fact.signedAt,
      });
      daily.set(serviceDate, row);
      cursor = chunkEnd;
    }
  }

  const days = [...chcDates].sort().map((serviceDate) => {
    const row = daily.get(serviceDate);
    if (!row || row.minutes <= 0) return null;
    return {
      serviceDate,
      actualClinicalMinutes: row.minutes,
      sourceEncounters: row.sources,
    };
  });
  if (days.some((day) => day === null)) {
    return { status: "unresolved", reasonCode: "CHC_ACTUAL_INTERVAL_EVIDENCE_MISSING" };
  }
  return {
    status: "observed",
    days: days as ChcDailyObservedQuantity[],
    payerEligibility: "unresolved",
    institutionalUnits: "unqualified",
  };
}
