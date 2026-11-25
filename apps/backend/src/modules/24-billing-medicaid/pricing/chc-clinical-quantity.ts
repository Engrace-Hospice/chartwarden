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
  /** Required for M8's `cosigned` state; it is not interchangeable with the initial signature. */
  readonly cosignedAt?: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly timeSource: "evv" | "clinician" | null;
  readonly sourceVersion: number | undefined;
  readonly locationId?: string | null;
  readonly discipline?: string | null;
  readonly voidedAt?: string | null;
}

export interface ChcDailyObservedQuantity {
  readonly serviceDate: string;
  readonly serviceDayStart: string;
  readonly serviceDayEnd: string;
  /** Actual source-backed minutes. They are not billable minutes or institutional 837I units. */
  readonly actualClinicalMinutes: number;
  readonly sourceEncounters: readonly {
    readonly encounterId: string;
    readonly sourceVersion: number;
    readonly timeSource: "evv" | "clinician";
    readonly signedAt: string;
    readonly discipline: string | null;
    readonly locationId: string | null;
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

/** Resolve a local date's actual UTC bounds; DST dates can be 23 or 25 hours long. */
function localDayBounds(
  date: string,
  timeZone: string,
): { readonly start: number; readonly end: number } | null {
  const center = Date.parse(`${date}T12:00:00.000Z`);
  if (!Number.isFinite(center)) return null;
  let candidate: number | null = null;
  for (let offset = -36; offset <= 36; offset += 1) {
    const instant = center + offset * 60 * 60_000;
    if (zonedDate(instant, timeZone) === date) {
      candidate = instant;
      break;
    }
  }
  if (candidate === null) return null;

  let low = candidate - 36 * 60 * 60_000;
  let high = candidate;
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (zonedDate(middle, timeZone) < date) low = middle;
    else high = middle;
  }
  const start = high;
  const end = nextLocalDayBoundary(start, date, timeZone);
  return end === null || end <= start ? null : { start, end };
}

/** Public, PHI-free local-day boundary helper for source-owner adapters and evidence qualification. */
export function chcLocalServiceDayBounds(
  serviceDate: string,
  serviceTimeZone: string,
): { readonly start: string; readonly end: string } | null {
  try {
    const bounds = localDayBounds(serviceDate, serviceTimeZone);
    return bounds
      ? { start: new Date(bounds.start).toISOString(), end: new Date(bounds.end).toISOString() }
      : null;
  } catch {
    return null;
  }
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
  /** The assessment clock is fixed by the caller so later signatures cannot enter an earlier snapshot. */
  readonly assessedAt: string;
  /** M6 LOC dates that are actively assigned to continuous home care. */
  readonly chcServiceDates: readonly string[];
  readonly encounters: readonly SignedChcEncounterFact[];
}): ChcClinicalQuantityResult {
  const assessedAt = Date.parse(input.assessedAt);
  if (
    !validDate(input.serviceFrom) ||
    !validDate(input.serviceTo) ||
    input.serviceFrom > input.serviceTo ||
    input.chcServiceDates.length === 0 ||
    !Number.isFinite(assessedAt) ||
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
  const firstDay = localDayBounds(input.serviceFrom, input.serviceTimeZone);
  const lastDay = localDayBounds(input.serviceTo, input.serviceTimeZone);
  if (!firstDay || !lastDay) {
    return { status: "unresolved", reasonCode: "CHC_LOCAL_DAY_BOUNDARY_UNRESOLVED" };
  }
  const requestedStart = firstDay.start;
  const requestedEnd = lastDay.end;
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
      !fact.startedAt ||
      !fact.endedAt ||
      !fact.timeSource ||
      !Number.isSafeInteger(fact.sourceVersion) ||
      (fact.sourceVersion ?? -1) < 0 ||
      !Number.isFinite(Date.parse(fact.signedAt)) ||
      Date.parse(fact.signedAt) > assessedAt ||
      (fact.status === "cosigned" &&
        (!fact.cosignedAt ||
          !Number.isFinite(Date.parse(fact.cosignedAt)) ||
          Date.parse(fact.cosignedAt) > assessedAt)) ||
      (fact.voidedAt != null && fact.voidedAt !== "")
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
    const attestedAt =
      fact.status === "cosigned" ? Date.parse(fact.cosignedAt!) : Date.parse(fact.signedAt);
    if (
      zonedDate(start, input.serviceTimeZone) !== fact.serviceDate ||
      Date.parse(fact.signedAt) < end ||
      attestedAt < end
    ) {
      return { status: "unresolved", reasonCode: "CHC_SOURCE_SERVICE_DATE_MISMATCH" };
    }
    const clippedStart = Math.max(start, requestedStart);
    const clippedEnd = Math.min(end, requestedEnd);
    if (clippedEnd > clippedStart) intervals.push({ fact, start: clippedStart, end: clippedEnd });
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
      const bounds = localDayBounds(serviceDate, input.serviceTimeZone);
      if (
        !bounds ||
        !Number.isSafeInteger(row.minutes) ||
        row.minutes > (bounds.end - bounds.start) / 60_000
      ) {
        return { status: "ambiguous", reasonCode: "CHC_DAILY_DURATION_CONFLICT" };
      }
      row.sources.push({
        encounterId: fact.encounterId,
        sourceVersion: fact.sourceVersion!,
        timeSource: fact.timeSource!,
        signedAt: fact.signedAt,
        discipline: fact.discipline ?? null,
        locationId: fact.locationId ?? null,
      });
      daily.set(serviceDate, row);
      cursor = chunkEnd;
    }
  }

  const days = [...chcDates].sort().map((serviceDate) => {
    const row = daily.get(serviceDate);
    if (!row || row.minutes <= 0) return null;
    const bounds = localDayBounds(serviceDate, input.serviceTimeZone);
    if (!bounds) return null;
    return {
      serviceDate,
      serviceDayStart: new Date(bounds.start).toISOString(),
      serviceDayEnd: new Date(bounds.end).toISOString(),
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
