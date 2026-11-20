// apps/backend/src/modules/08-encounters/closure/clock-stamp.ts — stamping the visit-note closure clock (ADR-0113).
//
// The clock starts when the clinician's documentation duty began. Four signals can say so: `evv_check_in`, `visit_started` (both from
// the M17 `m17.visit.started` event), `draft_opened` (the first authoring write on a seeded draft, or sign if none came earlier) and
// `draft_created` (ad-hoc creation). The FIRST signal to arrive wins; there is no precedence between them, because a stamp is
// write-once: `stampClockIfNull` never overwrites and never touches a closed note. So an author's pre-charting write on a seeded draft
// before the visit starts starts the clock then (stricter than arrival, on purpose: the fail-safe is a clock that runs).
//
// `clampClockStart` and `localDayStart` are pure; `stampClockIfNull` is the one UPDATE every stamping path shares.
import { type DbClient, schema } from "@chartwarden/db";
import { localDateInTimeZone } from "@chartwarden/shared/dates";
import type { EncounterClockStartSource } from "@chartwarden/types";
import { type SQL, and, eq, inArray, isNull } from "drizzle-orm";
import { OPEN_NOTE_STATUSES } from "./open-status";

const ENC = schema.encounters;

const MS_PER_MINUTE = 60_000;
/** Every real UTC offset lies in [-12h, +14h], so one day either side of the UTC midnight brackets any zone's local midnight. */
const SEARCH_RADIUS_MINUTES = 24 * 60;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function assertValidInstant(name: string, instant: Date): void {
  if (Number.isNaN(instant.getTime())) throw new RangeError(`${name} is not a valid instant`);
}

/**
 * Bound a device-supplied start instant to [`serviceDateLocalStart`, `upperBound`]: a handset clock that ran behind cannot pull the
 * clock into an earlier day, one that ran ahead cannot put it past `upperBound`. The consumer passes the SERVER time the start
 * event was recorded (never its own, later, delivery time), so the device cannot choose its arrival from a widening window.
 * If the window is inverted (service date after the upper bound) the upper bound wins. Returns a new Date.
 */
export function clampClockStart(
  candidate: Date,
  serviceDateLocalStart: Date,
  upperBound: Date,
): Date {
  assertValidInstant("candidate", candidate);
  assertValidInstant("serviceDateLocalStart", serviceDateLocalStart);
  assertValidInstant("upperBound", upperBound);
  const lifted = Math.max(candidate.getTime(), serviceDateLocalStart.getTime());
  return new Date(Math.min(lifted, upperBound.getTime()));
}

/** UTC midnight of a real `YYYY-MM-DD` calendar date, `NaN` for anything else (a rolled-over day such as 2026-02-30, or a year `Date.UTC` maps to 19xx). */
function utcMidnightOf(serviceDate: string): number {
  const parts = ISO_DATE.exec(serviceDate);
  if (!parts) return Number.NaN;
  const midnightUtc = Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  const isRealDate =
    !Number.isNaN(midnightUtc) && new Date(midnightUtc).toISOString().slice(0, 10) === serviceDate;
  return isRealDate ? midnightUtc : Number.NaN;
}

/** Whether `localDayStart` accepts `value`: the ONE rule for a service date, so a caller's pre-check cannot disagree with the throw. */
export function isValidServiceDate(value: string): boolean {
  return !Number.isNaN(utcMidnightOf(value));
}

/**
 * The instant an org-local calendar day (`YYYY-MM-DD`) begins in IANA `timeZone`: the earliest minute whose
 * org-local date is `serviceDate` (DST-safe, and still right for a zone whose midnight does not exist).
 * Found by bisecting over `localDateInTimeZone` — the platform's org-local day rule — so no second
 * timezone rule exists to drift from the one the late-entry tiers use.
 */
export function localDayStart(serviceDate: string, timeZone: string): Date {
  const midnightUtc = utcMidnightOf(serviceDate);
  if (Number.isNaN(midnightUtc)) {
    throw new RangeError(`localDayStart: '${serviceDate}' is not a YYYY-MM-DD date`);
  }
  const reachesDay = (minute: number): boolean =>
    localDateInTimeZone(new Date(midnightUtc + minute * MS_PER_MINUTE), timeZone) >= serviceDate;
  // Invariant: the local date is before `serviceDate` at `before`, and on/after it at `onOrAfter`.
  let before = -SEARCH_RADIUS_MINUTES;
  let onOrAfter = SEARCH_RADIUS_MINUTES;
  while (onOrAfter - before > 1) {
    const middle = Math.floor((before + onOrAfter) / 2);
    if (reachesDay(middle)) onOrAfter = middle;
    else before = middle;
  }
  return new Date(midnightUtc + onOrAfter * MS_PER_MINUTE);
}

type StampKey = { readonly encounterId: string } | { readonly visitId: string };

export type StampClockInput = StampKey & {
  readonly orgId: string;
  /** The (already clamped, where the source is device-supplied) instant the duty began. */
  readonly at: Date;
  readonly source: EncounterClockStartSource;
};

/** The UPDATE predicate: this org, this note, no clock yet, still open. Exported so a test can pin it. */
export function clockStampWhere(input: StampKey & { readonly orgId: string }): SQL {
  const key = "visitId" in input ? eq(ENC.visitId, input.visitId) : eq(ENC.id, input.encounterId);
  return and(
    eq(ENC.organizationId, input.orgId),
    key,
    isNull(ENC.clockStartedAt),
    inArray(ENC.status, [...OPEN_NOTE_STATUSES]),
  ) as SQL;
}

/**
 * Stamp the clock if — and only if — the note has none and is still open. Idempotent (a second delivery or a
 * lost race matches no row), never overwrites, and does not bump `version`/`updated_at`: the clock is not an
 * edit the author's optimistic lock should see. Returns whether this call stamped.
 */
export async function stampClockIfNull(tx: DbClient, input: StampClockInput): Promise<boolean> {
  const stamped = await tx
    .update(ENC)
    .set({ clockStartedAt: input.at, clockStartSource: input.source })
    .where(clockStampWhere(input))
    .returning({ id: ENC.id });
  return stamped.length > 0;
}

/**
 * ADR-0113: a seeded draft that never got an M17 start event gets its documentation clock on the AUTHOR's first authoring write
 * (and at sign, so a signed note always has one). Only the author's own write counts: the clock is the author's duty, so an edit by
 * anyone else (a supervisor on an `is_author_or_supervisor` route) never starts it, and a legacy (pre-deploy, clockless) draft is not
 * clocked by someone else touching it (D9). A `null` `actorMembershipId` (a caller with no acting member) stamps nothing.
 * Write-once and open-notes-only in the UPDATE itself; the row's own `clockStartedAt` just skips the round trip once it is set.
 * A GET never calls this. The one implementation behind every authoring write (selections, vitals, mileage, ADLs, nutrition).
 */
export async function stampDraftOpened(
  tx: DbClient,
  input: {
    readonly organizationId: string;
    readonly row: {
      readonly id: string;
      readonly clockStartedAt: Date | null;
      readonly authoredByMembershipId: string;
    };
    readonly actorMembershipId: string | null;
    readonly at: Date;
  },
): Promise<void> {
  const { row, actorMembershipId } = input;
  if (row.clockStartedAt !== null) return;
  if (actorMembershipId === null || actorMembershipId !== row.authoredByMembershipId) return;
  await stampClockIfNull(tx, {
    orgId: input.organizationId,
    encounterId: row.id,
    at: input.at,
    source: "draft_opened",
  });
}
