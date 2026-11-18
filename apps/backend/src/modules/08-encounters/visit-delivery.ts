// apps/backend/src/modules/08-encounters/visit-delivery.ts — what the signing clinician says about HOW and WHEN
// a visit happened (migration 1510): the visit modality and the documented start/end. PURE: the service
// resolves the facts (the row, the EVV bracket, the org-local clock) and writes the returned columns.
//
// HARD PRINCIPLE: documented time is never fabricated, defaulted or padded. A time lands on the row only when
// the M18 EVV bracket supplied it (EVV always wins) or the signing clinician typed it; with neither, the
// columns stay NULL. A modality is never defaulted to in_person: the clinician confirms it.
import {
  type EncounterDiscipline,
  type EncounterTimeSource,
  type EncounterType,
  type EncounterVisitModality,
  type LocalDate,
  MODALITY_CONFIRMATION_DISCIPLINES,
} from "@chartwarden/types";
import type { EvvAtSign } from "./evv-at-sign";
import { EncounterStateError } from "./lifecycle/errors";
import { daysBetween } from "./lifecycle/validation";

/** What the signing clinician supplied on the sign request (all optional; ISO instants for the times). */
export interface SignDeliveryInput {
  readonly visitModality?: EncounterVisitModality;
  readonly startedAt?: string;
  readonly endedAt?: string;
}

/** The facts of the encounter row the plan reads. */
export interface SignDeliveryRow {
  readonly discipline: EncounterDiscipline;
  /** A `telephonic` type cannot be signed as in person or video (see {@link assertModalityFitsVisitType}). */
  readonly encounterType: EncounterType;
  readonly serviceDate: LocalDate;
  /** NULL = the stored modality (if any) is only the unconfirmed M17 seed. */
  readonly visitModalityConfirmedAt: Date | null;
}

export interface SignDeliveryContext {
  readonly signerMembershipId: string;
  /** The service clock: the confirmation instant and the "not in the future" bound. */
  readonly now: Date;
  /** The org-local calendar date of an instant (the service resolves the tenant timezone). */
  readonly localDateOf: (instant: Date) => LocalDate;
  /** The M18 EVV bracket in force at sign (stored or just resolved), or null when there is none. */
  readonly evvTimes: {
    readonly startedAt: Date | null;
    readonly endedAt: Date | null;
  } | null;
}

/** The encounter columns the plan writes; every key is absent when there is nothing to record. */
export interface DeliveryColumns {
  readonly visitModality?: EncounterVisitModality;
  readonly visitModalityConfirmedAt?: Date;
  readonly visitModalityConfirmedBy?: string;
  readonly startedAt?: Date;
  readonly endedAt?: Date;
  readonly timeSource?: EncounterTimeSource;
}

/** A visit may cross local midnight; it may not end more than one local day after its service date. */
const MAX_END_DAYS_AFTER_SERVICE_DATE = 1;

/** A clinician-typed bracket is padding-proof only if it is bounded: no documented visit runs past 8 hours. */
export const MAX_CLINICIAN_VISIT_MINUTES = 8 * 60;
const MS_PER_MINUTE = 60_000;

/**
 * RFC 3339 date-time with an EXPLICIT offset (`Z` or `+hh:mm` / `-hh:mm`). `new Date(raw)` reads an
 * offset-less string in the SERVER's local zone and accepts non-ISO text, so neither may reach a documented time.
 */
const ISO_DATE_TIME_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
/** The calendar part of a string {@link ISO_DATE_TIME_WITH_OFFSET} already accepted. */
const DATE_TIME_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):/;

/**
 * A `telephonic` encounter type is telephonic by definition (the M17 seed already makes it win); sign and the
 * legacy-confirm route must not leave the record self-contradictory by recording it as in person or video.
 * `telephonic` is always allowed.
 */
export function assertModalityFitsVisitType(
  encounterType: EncounterType,
  modality: EncounterVisitModality,
): void {
  if (encounterType === "telephonic" && modality !== "telephonic") {
    throw new EncounterStateError(
      "MODALITY_CONFLICTS_WITH_VISIT_TYPE",
      "a telephonic visit type cannot be recorded as delivered in person or by video",
    );
  }
}

/** The three modality columns for an explicit clinician confirmation (sign flow and legacy-confirm route). */
export function confirmedModalityColumns(
  modality: EncounterVisitModality,
  membershipId: string,
  now: Date,
): Required<
  Pick<DeliveryColumns, "visitModality" | "visitModalityConfirmedAt" | "visitModalityConfirmedBy">
> {
  return {
    visitModality: modality,
    visitModalityConfirmedAt: now,
    visitModalityConfirmedBy: membershipId,
  };
}

function modalityColumns(
  input: SignDeliveryInput,
  row: SignDeliveryRow,
  ctx: SignDeliveryContext,
): DeliveryColumns {
  if (input.visitModality !== undefined) {
    assertModalityFitsVisitType(row.encounterType, input.visitModality);
    return confirmedModalityColumns(input.visitModality, ctx.signerMembershipId, ctx.now);
  }
  if (row.visitModalityConfirmedAt !== null) return {};
  if (MODALITY_CONFIRMATION_DISCIPLINES.includes(row.discipline)) {
    throw new EncounterStateError(
      "MODALITY_CONFIRMATION_REQUIRED",
      "confirm how this visit was delivered (in person, telephonic or video) before signing",
    );
  }
  return {};
}

const invalidTime = (message: string): EncounterStateError =>
  new EncounterStateError("VISIT_TIME_INVALID", message);

function parseInstant(label: string, raw: string): Date {
  if (!ISO_DATE_TIME_WITH_OFFSET.test(raw)) {
    throw invalidTime(
      `${label} must be an ISO-8601 date and time with an explicit UTC offset (for example 2026-05-05T10:00:00-04:00)`,
    );
  }
  // `Date` ROLLS an impossible calendar date forward (2026-02-31 reads as 2026-03-03, hour 24 as the next midnight), which
  // would store a time the clinician never typed: refuse any date the calendar does not have.
  const parts = DATE_TIME_PARTS.exec(raw);
  const [year, month, day, hour] = [parts?.[1], parts?.[2], parts?.[3], parts?.[4]].map(Number) as [
    number,
    number,
    number,
    number,
  ];
  const calendarDay = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDay.getUTCFullYear() !== year ||
    calendarDay.getUTCMonth() !== month - 1 ||
    calendarDay.getUTCDate() !== day ||
    hour > 23
  ) {
    throw invalidTime(`${label} is not a real calendar date and time`);
  }
  const instant = new Date(raw);
  if (Number.isNaN(instant.getTime())) throw invalidTime(`${label} is not a valid date and time`);
  return instant;
}

/** The clinician-entered bracket, validated; throws {@link EncounterStateError} `VISIT_TIME_INVALID`. */
function clinicianBracket(
  input: SignDeliveryInput,
  row: SignDeliveryRow,
  ctx: SignDeliveryContext,
): { readonly startedAt: Date; readonly endedAt: Date } | null {
  const { startedAt: rawStart, endedAt: rawEnd } = input;
  if (rawStart === undefined && rawEnd === undefined) return null;
  if (rawStart === undefined || rawEnd === undefined) {
    throw invalidTime("enter both the visit start and end time, or neither");
  }
  const startedAt = parseInstant("the visit start", rawStart);
  const endedAt = parseInstant("the visit end", rawEnd);
  if (endedAt.getTime() <= startedAt.getTime()) {
    throw invalidTime("the visit end must be after the visit start");
  }
  if ((endedAt.getTime() - startedAt.getTime()) / MS_PER_MINUTE > MAX_CLINICIAN_VISIT_MINUTES) {
    throw invalidTime("a documented visit cannot be longer than 8 hours");
  }
  if (endedAt.getTime() > ctx.now.getTime()) {
    throw invalidTime("documented visit times cannot be in the future");
  }
  if (ctx.localDateOf(startedAt) !== row.serviceDate) {
    throw invalidTime("the visit start must fall on the encounter's service date");
  }
  const endDay = daysBetween(row.serviceDate, ctx.localDateOf(endedAt));
  if (endDay < 0 || endDay > MAX_END_DAYS_AFTER_SERVICE_DATE) {
    throw invalidTime("the visit end must fall on the service date or the day after");
  }
  return { startedAt, endedAt };
}

function timeColumns(
  input: SignDeliveryInput,
  row: SignDeliveryRow,
  ctx: SignDeliveryContext,
): DeliveryColumns {
  // EVV always wins (D9): clinician-entered times never override an EVV bracket, so they are not even read.
  if (ctx.evvTimes !== null) {
    const complete = ctx.evvTimes.startedAt !== null && ctx.evvTimes.endedAt !== null;
    return complete ? { timeSource: "evv" } : {};
  }
  const bracket = clinicianBracket(input, row, ctx);
  return bracket === null ? {} : { ...bracket, timeSource: "clinician" };
}

/**
 * The delivery columns to write at sign. Throws `MODALITY_CONFIRMATION_REQUIRED` when a Medicare-countable
 * discipline neither supplies nor already has a confirmed modality, `MODALITY_CONFLICTS_WITH_VISIT_TYPE` for an
 * in-person / video modality on a telephonic encounter type, and `VISIT_TIME_INVALID` for a clinician bracket
 * that is half-entered, lacks an explicit UTC offset, is unordered, longer than
 * {@link MAX_CLINICIAN_VISIT_MINUTES}, in the future or off the service date.
 */
export function planDeliveryAtSign(
  input: SignDeliveryInput,
  row: SignDeliveryRow,
  ctx: SignDeliveryContext,
): DeliveryColumns {
  return { ...modalityColumns(input, row, ctx), ...timeColumns(input, row, ctx) };
}

/** The delivery facts as stored on an `encounter` row. */
export interface DeliveryRowFacts {
  readonly visitModality: EncounterVisitModality | null;
  readonly visitModalityConfirmedAt: Date | string | null;
  readonly timeSource: string | null;
}

/** The delivery fields every encounter read projects. */
export interface DeliveryViewFields {
  readonly visitModality: EncounterVisitModality | null;
  /** Confirmed = the clinician explicitly chose it; a seeded value alone is NOT confirmed. */
  readonly visitModalityConfirmed: boolean;
  readonly timeSource: EncounterTimeSource | null;
}

/** Project the stored delivery columns to the read DTO fields (an unknown time source reads as none). */
export function deliveryViewFields(row: DeliveryRowFacts): DeliveryViewFields {
  return {
    visitModality: row.visitModality,
    visitModalityConfirmed: row.visitModalityConfirmedAt !== null,
    timeSource: row.timeSource === "evv" || row.timeSource === "clinician" ? row.timeSource : null,
  };
}

/**
 * The EVV bracket in force at sign, as the times {@link planDeliveryAtSign} must defer to; null when EVV did
 * not bracket the visit. A bracket sign just resolved supplies its own times; one resolved earlier is already
 * on the row.
 */
export function evvTimesAtSign(
  row: { readonly startedAt: Date | null; readonly endedAt: Date | null },
  evv: EvvAtSign,
): SignDeliveryContext["evvTimes"] {
  if (evv.state !== "evv_present") return null;
  return evv.persist
    ? { startedAt: evv.persist.startedAt, endedAt: evv.persist.endedAt }
    : { startedAt: row.startedAt, endedAt: row.endedAt };
}
