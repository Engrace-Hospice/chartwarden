// apps/backend/src/modules/19-oncall/lifecycle/paper-reentry.ts — M19-T03 (§2.7, M19-F08, DR-013/066).
//
// THE BCP RE-ENTRY PATH. When the platform is down, after-hours calls are taken on paper. On recovery two
// things must happen and neither can be left to memory: the paper calls must land in the record with their
// ORIGINAL timestamps, and the DON must get a bounded list of which nights are still missing.
//
// §2.7 step 3 detects the outage by its ABSENCE: the window where no `triage_call_state_history` row was
// written. That is an inference, not a fact the platform recorded — a platform that is down does not write
// "I am down" — so `detectOutageWindows` walks the transition timeline and reports gaps wider than a floor.
// The floor matters: an agency with three calls a night has hours of legitimate quiet between them, and a
// detector with no floor would declare every quiet Tuesday an outage and hand the DON a worklist of
// phantom nights. `OUTAGE_GAP_FLOOR_MINUTES` is the tuning knob and it is deliberately conservative.
//
// TWO FAIL DIRECTIONS, PICKED SEPARATELY:
//   • `assertPaperOriginCoherent` fails CLOSED. `paper_origin_flag`, `source='paper_origin'` and
//     `paper_original_opened_at` are one fact in three columns (two §3.3 CHECKs bind them), and a row
//     that carries the audit-visible flag while the outbox payload downstream consumers order by says
//     `manual` is a call M14/M30 will sort as if it happened after the outage it happened during.
//   • `detectOutageWindows` fails OPEN — it reports a candidate window and nothing more. A missed outage
//     costs a DON nudge; a fabricated one costs the DON a worklist of nights that do not exist, and a
//     worklist that cries wolf is a worklist nobody works.
import type {
  IsoInstant,
  MembershipId,
  OnCallShiftId,
  TriageCallSource,
  TriagePaperReentryWorklistId,
} from "@chartwarden/types";
import { TRIAGE_PAPER_REENTRY_WORKLIST_TTL_HOURS } from "@chartwarden/types";
import { type TriageSideEffect, withAudit } from "./effects";
import { require_ } from "./errors";

/**
 * §2.7 step 3 — the quiet stretch below which a gap is normal after-hours silence, not an outage.
 *
 * Six hours is the shape of the problem rather than a round number: a covered night runs roughly 18:00 to
 * 07:00, and a 13-hour shift with no transition at all means either nobody called (possible) or nothing
 * could be written (the case worth flagging). Six hours is long enough that a merely quiet evening does not
 * trip it and short enough that a genuine overnight outage cannot hide inside it. The DON confirms or
 * dismisses the candidate window; nothing here writes a worklist unilaterally.
 */
export const OUTAGE_GAP_FLOOR_MINUTES = 360;

/** One `triage_call_state_history` transition instant, org-wide, ascending. The §2.7 detector needs no
 *  other column: the question is only "was ANYTHING written". */
export type TransitionInstant = IsoInstant;

/** A candidate outage window inferred from the gap. */
export interface OutageWindow {
  readonly startsAt: IsoInstant;
  readonly endsAt: IsoInstant;
  readonly durationMinutes: number;
}

/**
 * §2.7 step 3 — walk the org's transition timeline and report every gap wider than the floor.
 *
 * `scanUntil` closes the trailing gap: an outage that is still running has no transition after it, and
 * without an explicit right edge the most important window — the one happening now — would be the one the
 * detector could not see.
 */
export function detectOutageWindows(
  transitions: readonly TransitionInstant[],
  scanUntil: IsoInstant,
  floorMinutes: number = OUTAGE_GAP_FLOOR_MINUTES,
): readonly OutageWindow[] {
  const times = [...transitions].map((t) => new Date(t).getTime()).sort((a, b) => a - b);
  const until = new Date(scanUntil).getTime();
  const bounds = [...times, until];
  const windows: OutageWindow[] = [];

  for (let i = 0; i < bounds.length - 1; i += 1) {
    const from = bounds[i] as number;
    const to = bounds[i + 1] as number;
    const durationMinutes = (to - from) / 60_000;
    if (durationMinutes > floorMinutes) {
      windows.push({
        startsAt: new Date(from).toISOString(),
        endsAt: new Date(to).toISOString(),
        durationMinutes,
      });
    }
  }
  return windows;
}

/** One `on_call_shift` row the worklist builder considers. */
export interface WorklistShiftFacts {
  readonly shiftId: OnCallShiftId;
  readonly shiftStartsAt: IsoInstant;
  readonly shiftEndsAt: IsoInstant;
  readonly assignedToMembershipId: MembershipId | null;
}

/** One row to write into `triage_paper_reentry_worklist`. */
export interface PaperReentryWorklistRowInput {
  readonly shiftId: OnCallShiftId;
  readonly shiftStartsAt: IsoInstant;
  readonly shiftEndsAt: IsoInstant;
  readonly assignedToMembershipId: MembershipId | null;
  readonly expiresAt: IsoInstant;
}

/** §2.7 step 3 — half-open overlap. A shift that ENDS exactly when the outage starts was never affected by
 *  it, and one that STARTS exactly when the outage ends was not either; using closed bounds would put two
 *  untouched nights on the DON's list at every outage boundary. */
function overlaps(shift: WorklistShiftFacts, window: OutageWindow): boolean {
  const shiftStart = new Date(shift.shiftStartsAt).getTime();
  const shiftEnd = new Date(shift.shiftEndsAt).getTime();
  const outageStart = new Date(window.startsAt).getTime();
  const outageEnd = new Date(window.endsAt).getTime();
  return shiftStart < outageEnd && shiftEnd > outageStart;
}

/** §2.7 — the worklist's operational lifetime: outage end + 72 hours. */
export function worklistExpiryFor(window: OutageWindow): IsoInstant {
  return new Date(
    new Date(window.endsAt).getTime() + TRIAGE_PAPER_REENTRY_WORKLIST_TTL_HOURS * 3_600_000,
  ).toISOString();
}

/**
 * §2.7 step 3 — the shifts that overlapped the outage, one worklist row each.
 *
 * The list is the DON's answer to "which nights are not in the record yet". It is computed from the SHIFT
 * roster rather than from the missing calls, because a night with zero calls and a night whose calls are
 * all on paper look identical from the call table — and only the roster knows a nurse was on duty at all.
 */
export function buildPaperReentryWorklist(
  window: OutageWindow,
  shifts: readonly WorklistShiftFacts[],
): {
  readonly rows: readonly PaperReentryWorklistRowInput[];
  readonly effects: ReadonlyArray<TriageSideEffect>;
} {
  const expiresAt = worklistExpiryFor(window);
  const rows = shifts
    .filter((shift) => overlaps(shift, window))
    .map((shift) => ({
      shiftId: shift.shiftId,
      shiftStartsAt: shift.shiftStartsAt,
      shiftEndsAt: shift.shiftEndsAt,
      assignedToMembershipId: shift.assignedToMembershipId,
      expiresAt,
    }));

  // §2.7 step 3 — the DON gets a `critical` alert with the count. Emitted only when there IS something to
  // work: an alert saying "0 nights outstanding" trains the DON to dismiss the one that says 4.
  const effects =
    rows.length === 0
      ? []
      : withAudit([{ kind: "alert", alert: "m19.oncall.coverage_gap_detected" } as const]);

  return { rows, effects };
}

/** The paper-origin fields a re-entry claims. */
export interface PaperOriginClaim {
  readonly source: TriageCallSource;
  readonly paperOriginFlag: boolean;
  readonly paperOriginalOpenedAt: IsoInstant | null;
  /** §2.7 step 2 — `opened_at` is set to the ORIGINAL call time, not the re-entry wall clock. */
  readonly openedAt: IsoInstant;
}

/**
 * §2.7 steps 1–2 — the three columns are one fact, and the API's `opened_at` is the original call time.
 *
 * The §3.3 CHECKs already bind `(source='paper_origin') = paper_origin_flag` and
 * `paper_origin_flag = (paper_original_opened_at IS NOT NULL)`. Restating them here is not redundancy: a
 * constraint violation surfaces as a 500 from the driver with a constraint name, while this is a 422 that
 * names the field the re-entering clinician got wrong — and the re-entry screen is being used at the worst
 * moment an agency has, on the morning after an outage.
 */
export function assertPaperOriginCoherent(claim: PaperOriginClaim, now: Date): void {
  require_(
    (claim.source === "paper_origin") === claim.paperOriginFlag,
    "PAPER_ORIGIN_FIELDS_INCOHERENT",
    "source='paper_origin' and paper_origin_flag move together (§3.3 m19_triage_call_paper_origin_pair)",
  );
  require_(
    claim.paperOriginFlag === (claim.paperOriginalOpenedAt !== null),
    "PAPER_ORIGIN_FIELDS_INCOHERENT",
    "a paper-origin call records the original call time (§2.7 step 5 — downstream consumers order by it)",
  );
  if (!claim.paperOriginFlag) return;

  require_(
    new Date(claim.openedAt).getTime() <= now.getTime(),
    "PAPER_REENTRY_OPENED_AT_IN_FUTURE",
    "the original call time cannot be in the future",
  );
  require_(
    claim.openedAt === claim.paperOriginalOpenedAt,
    "PAPER_ORIGIN_FIELDS_INCOHERENT",
    "opened_at IS the original call time on a paper-origin row (§2.7 step 2), not the re-entry clock",
  );
}

/** §2.7 step 3 — the claimed original time must fall inside the outage the re-entry is being filed
 *  against. Outside it, the platform was UP and the call belongs on the ordinary late-entry path, where
 *  M8's late-entry tier records the delay honestly instead of attributing it to an outage. */
export function assertWithinOutageWindow(originalOpenedAt: IsoInstant, window: OutageWindow): void {
  const t = new Date(originalOpenedAt).getTime();
  require_(
    t >= new Date(window.startsAt).getTime() && t <= new Date(window.endsAt).getTime(),
    "PAPER_REENTRY_OUTSIDE_OUTAGE_WINDOW",
    `${originalOpenedAt} is outside the outage window ${window.startsAt} → ${window.endsAt}`,
  );
}

/** One `triage_paper_reentry_worklist` row as the linker sees it. */
export interface PaperReentryWorklistFacts {
  readonly worklistId: TriagePaperReentryWorklistId;
  readonly expiresAt: IsoInstant;
  readonly reenteredAt: IsoInstant | null;
  readonly linkedTriageCallId: string | null;
}

/**
 * §2.7 step 3 — close one worklist row against the call that was re-entered for it.
 *
 * `reentered_at` and `linked_triage_call_id` are written together (the §3.3 `m19_triage_paper_reentry_pair`
 * CHECK): a `reentered_at` with no linked call marks the night done while it is still missing from the
 * record, which is precisely the failure the worklist exists to prevent.
 */
export function linkPaperReentry(input: {
  readonly worklist: PaperReentryWorklistFacts;
  readonly triageCallId: string;
  readonly at: IsoInstant;
}): ReadonlyArray<TriageSideEffect> {
  require_(
    input.worklist.linkedTriageCallId === null,
    "PAPER_REENTRY_ALREADY_LINKED",
    `worklist row ${input.worklist.worklistId} is already linked to call ${input.worklist.linkedTriageCallId}`,
  );
  require_(
    new Date(input.at).getTime() < new Date(input.worklist.expiresAt).getTime(),
    "PAPER_REENTRY_WORKLIST_EXPIRED",
    `the 72-hour re-entry worklist expired at ${input.worklist.expiresAt}`,
  );

  return withAudit([
    { kind: "link_paper_reentry_worklist", worklistId: input.worklist.worklistId },
    { kind: "set_timestamp", field: "reentered_at", at: input.at },
  ]);
}

/** §2.7 — the outstanding rows the DON's `/app/admin/triage-audit?mode=paper_reentry` surface renders, and
 *  the count the `critical` M36 alert carries. An expired row stops nagging (§2.7's own wording) but is
 *  never deleted: the M4 audit of the outage is a 7-year question (`compliance` retention). */
export function outstandingWorklistRows(
  rows: readonly PaperReentryWorklistFacts[],
  now: Date,
): readonly PaperReentryWorklistFacts[] {
  return rows.filter(
    (r) => r.reenteredAt === null && new Date(r.expiresAt).getTime() > now.getTime(),
  );
}
