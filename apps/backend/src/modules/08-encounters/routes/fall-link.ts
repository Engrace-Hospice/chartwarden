// apps/backend/src/modules/08-encounters/routes/fall-link.ts — the fall a "follow-up after a fall" visit follows up (WF09).
//
// A clinician choosing that reason may link the recorded fall (an M30 `incident_report` of kind `fall`) it follows up. The note then
// states the fall's date. M8 consumes no M30 module: it reads the patient's falls through M30's published `IncidentRegisterProvider`
// seam, behind the narrow {@link FallIncidentReader} port below, and COPIES the date onto the encounter when the link is made, so a
// signed note keeps saying what it said whatever later happens to the incident report.
//
// Everything here is pure, so the in-memory service the route tests run on and the Drizzle service apply the same rules.
import { FALL_FOLLOWUP_CODE } from "@chartwarden/narrative-vocab";
import { EncounterStateError } from "../lifecycle/errors";

/** The part of a selections section this module reads (structural, so it needs nothing from `./service`, which imports it). */
interface SectionCodes {
  readonly sectionId: string;
  readonly entries: readonly { readonly code: string }[];
}

/** How far back from the visit's service date a recorded fall can be linked. A follow-up older than this is a different visit. */
export const FALL_LOOKBACK_DAYS = 90;

/** One recorded fall as M30's seam returns it. */
export interface RecordedFall {
  readonly incidentId: string;
  readonly occurredAt: Date;
  readonly severity: string;
}

/** The recorded falls of one patient, newest window first; the seam adapter implements it, tests fake it. */
export interface FallIncidentReader {
  recentFalls(args: {
    readonly organizationId: string;
    readonly patientId: string;
    readonly actorMembershipId: string | null;
    readonly occurredAfter: Date;
  }): Promise<readonly RecordedFall[]>;
}

/** A recorded fall as the author is offered it: the org-local date it happened and how severe it was. No narrative. */
export interface FallChoice {
  readonly incidentId: string;
  readonly occurredOn: string;
  readonly severity: string;
}

/** The fall a note is linked to, as stored on the encounter. */
export interface FallLink {
  readonly incidentId: string;
  readonly occurredOn: string;
}

const DAY_MS = 86_400_000;

/** The instant from which to ask the seam for falls: the lookback before the service date, with a day of slack for time zones. */
export function fallLookbackStart(serviceDate: string): Date {
  return new Date(Date.parse(`${serviceDate}T00:00:00Z`) - (FALL_LOOKBACK_DAYS + 1) * DAY_MS);
}

/**
 * The falls a visit on `serviceDate` can follow up: those in the lookback window that happened on or before that day, newest first.
 * `toLocalDate` is the org-local calendar day of an instant (the same day the note's service date is measured on).
 */
export function fallChoicesFor(
  falls: readonly RecordedFall[],
  serviceDate: string,
  toLocalDate: (at: Date) => string,
): readonly FallChoice[] {
  const earliest = new Date(Date.parse(`${serviceDate}T00:00:00Z`) - FALL_LOOKBACK_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
  return falls
    .map((f) => ({
      incidentId: f.incidentId,
      occurredOn: toLocalDate(f.occurredAt),
      severity: f.severity,
    }))
    .filter((f) => f.occurredOn >= earliest && f.occurredOn <= serviceDate)
    .sort((a, b) => (a.occurredOn === b.occurredOn ? 0 : a.occurredOn < b.occurredOn ? 1 : -1));
}

/** True when the Reason for Visit holds the follow-up-after-a-fall reason: the only reason a fall can be linked to. */
export function isFallFollowup(sections: readonly SectionCodes[]): boolean {
  return sections.some(
    (s) => s.sectionId === "chief_concern" && s.entries.some((e) => e.code === FALL_FOLLOWUP_CODE),
  );
}

/**
 * What the encounter's fall link becomes after a selections write.
 *
 *  - The reason is not a fall follow-up: the link is cleared (a note must not carry a fall beside another reason), and asking to
 *    link one is refused.
 *  - `requested` undefined: the link is kept. null: it is cleared. The id already linked: kept as is, date included.
 *  - Another id: it must be one of `choices` (a fall recorded for THIS patient inside the window), and its date is copied.
 */
export function nextFallLink(args: {
  readonly sections: readonly SectionCodes[];
  readonly requested: string | null | undefined;
  readonly current: FallLink | null;
  /** The falls this visit may link; only consulted when a different fall is being linked. */
  readonly choices: readonly FallChoice[];
}): FallLink | null {
  const { requested, current } = args;
  if (!isFallFollowup(args.sections)) {
    if (typeof requested === "string") {
      throw new EncounterStateError(
        "INVALID_SELECTION",
        "a fall can only be linked when the reason for the visit is a follow-up after a fall",
      );
    }
    return null;
  }
  if (requested === undefined) return current;
  if (requested === null) return null;
  if (current?.incidentId === requested) return current;
  const chosen = args.choices.find((c) => c.incidentId === requested);
  if (chosen === undefined) {
    throw new EncounterStateError(
      "INVALID_SELECTION",
      "that fall is not recorded for this patient in the days before this visit",
    );
  }
  return { incidentId: chosen.incidentId, occurredOn: chosen.occurredOn };
}
