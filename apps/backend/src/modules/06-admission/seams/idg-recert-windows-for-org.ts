// apps/backend/src/modules/06-admission/seams/idg-recert-windows-for-org.ts — the org-explicit, BATCHED
// recert / face-to-face window read the M14 IDG meeting screen's right pane needs (M14 spec §1.1 "recert/F2F
// windows shown on the packet cover" — "recert/F2F windows via M6 readers"; §2.4 `patientCover.nextRecertDueAt`
// / `f2fWindowState`). M6's own reads are keyed by ADMISSION (`/admissions/:id/election-periods`,
// `/admissions/:id/compliance-windows`, `/face-to-face/:id`); an IDG meeting has PATIENTS on its agenda, so this
// resolves each patient's current admission and answers the window question for the whole set in one
// round-trip per table (never N+1).
//
// SEAM PULL, not outbox push: M14's spec names an M6 READER for these facts and M6's own outbox consumer list
// records `m14` as declared-not-needed for CTI/F2F events (`events-by-m6.ts`, F-129). The window MATH is not
// re-derived here — it is M6's own pure `computeF2fWindow` / `decideF2fWindowStatus` (window-math.ts, the
// CMS 418.22 prior-to window `[period_start − 30, period_start]` in ORG-LOCAL calendar days, D8), the same
// functions the `admission.window_alert` cron uses to raise `m6.f2f.window_missed`. What is new is only the
// per-patient projection.
//
// SEMANTICS (stated, never guessed):
//   • CURRENT benefit period = the admission's `active` election period (highest sequence if several), else the
//     dated period whose `[effective_at, scheduled_end_at]` contains org-local today. No such period ⇒ every
//     date is null and `f2fWindowState` is null ("unknown" — never a fabricated compliance judgment).
//   • `nextRecertDueDate` = the calendar day the NEXT benefit period starts = `scheduled_end_at + 1` — the date
//     by which the recertification CTI must be in force (the cron's own `periodStartDate` rule).
//   • F2F is required only for a period whose sequence ≥ 3 (42 CFR 418.22(a)(4) / R-F2F-04); the window that
//     matters is the one for the NEXT period. Next sequence < 3 ⇒ `not_required`. An `attested` F2F for the
//     next period closes it.
//   • `f2fWindowState` maps to the M14 §2.4 packet-cover enum: `not_due` = nothing outstanding (not required,
//     attested, or the window has not opened yet), `window_open` = inside `[start, end]` and unattested,
//     `overdue` = past `windowEnd` and unattested (the cron's `missed`), `null` = unknown.
//   • Only NON-terminal admissions (`discharged` / `bereavement` / `closed` excluded, the cron's own rule) are
//     answered; a patient with none is absent from the result (post-discharge wrap-up patients have no live
//     recert cycle).
// Non-narrative: dates + enums only — no CTI/F2F narrative, clinician or diagnosis crosses this seam.
import { type DbClient, organizationTimezone, schema } from "@wardenx/db";
import { localDateInTimeZone } from "@wardenx/shared/dates";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import {
  addCalendarDays,
  computeF2fWindow,
  decideF2fWindowStatus,
} from "../certification/window-math";

const ADM = schema.admissions;
const EP = schema.electionPeriods;
const F2F = schema.faceToFaceEncounters;

/** A read with no acting human (the `ADMISSION_READER_SYSTEM_USER_ID` convention). */
const RECERT_WINDOW_SYSTEM_USER_ID = "";

/** 42 CFR 418.22(a)(4) / R-F2F-04 — F2F starts with the 3rd benefit period. */
const F2F_REQUIRED_FROM_SEQUENCE = 3;

/** Admission statuses whose recert cycle is over (mirrors `F2F_TERMINAL_ADMISSION_STATUSES` in ../jobs/cron-store). */
const TERMINAL_ADMISSION_STATUSES = ["discharged", "bereavement", "closed"] as const;

/** A patient id list this long is a caller bug (an IDG caseload is dozens). */
export const IDG_RECERT_WINDOWS_MAX_PATIENTS = 500;

export type IdgRecertF2fStatus =
  | "not_required"
  | "not_yet_open"
  | "window_open"
  | "attested"
  | "missed"
  | "unknown";

export interface IdgRecertWindow {
  readonly patientId: string;
  readonly admissionId: string;
  /** Sequence of the current benefit period, or null when none resolves. */
  readonly currentPeriodSequence: number | null;
  /** Org-local `yyyy-mm-dd`. */
  readonly benefitPeriodStart: string | null;
  /** Org-local `yyyy-mm-dd` — the current period's `scheduled_end_at`. */
  readonly benefitPeriodEnd: string | null;
  /** Org-local `yyyy-mm-dd` — the next benefit period's start (recertification takes effect). */
  readonly nextRecertDueDate: string | null;
  readonly nextPeriodSequence: number | null;
  /** Whole calendar days from org-local today to `nextRecertDueDate` (negative = past); null when unknown. */
  readonly daysUntilNextRecert: number | null;
  readonly f2fRequired: boolean | null;
  /** Org-local `yyyy-mm-dd` bounds of the CMS prior-to window for the NEXT period; null when not required/unknown. */
  readonly f2fWindowStart: string | null;
  readonly f2fWindowEnd: string | null;
  readonly f2fStatus: IdgRecertF2fStatus;
  /** The M14 §2.4 packet-cover enum. */
  readonly f2fWindowState: "not_due" | "window_open" | "overdue" | null;
  /** The next period's not-yet-attested F2F's scheduled date, when one is booked. */
  readonly f2fScheduledDate: string | null;
}

const ymd = (d: Date | string | null): string | null =>
  d === null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : d.slice(0, 10);

const dayDiff = (fromYmd: string, toYmd: string): number =>
  Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86_400_000);

interface PeriodRow {
  readonly id: string;
  readonly admissionId: string;
  readonly sequence: number;
  readonly status: string;
  readonly start: string | null;
  readonly end: string | null;
}

/** Pure per-admission projection (exported for unit tests — no DB). */
export function projectIdgRecertWindow(input: {
  readonly patientId: string;
  readonly admissionId: string;
  readonly periods: readonly PeriodRow[];
  /** F2F rows keyed by election period id (only the fields the projection reads). */
  readonly f2fByPeriodId: ReadonlyMap<
    string,
    readonly { readonly status: string; readonly scheduledDate: string | null }[]
  >;
  readonly today: string;
  readonly timeZone: string;
}): IdgRecertWindow {
  const { patientId, admissionId, periods, f2fByPeriodId, today, timeZone } = input;
  const active = periods
    .filter((p) => p.status === "active")
    .sort((a, b) => b.sequence - a.sequence)[0];
  const current =
    active ??
    periods.find((p) => p.start !== null && p.end !== null && p.start <= today && today <= p.end);
  const unknown: IdgRecertWindow = {
    patientId,
    admissionId,
    currentPeriodSequence: null,
    benefitPeriodStart: null,
    benefitPeriodEnd: null,
    nextRecertDueDate: null,
    nextPeriodSequence: null,
    daysUntilNextRecert: null,
    f2fRequired: null,
    f2fWindowStart: null,
    f2fWindowEnd: null,
    f2fStatus: "unknown",
    f2fWindowState: null,
    f2fScheduledDate: null,
  };
  if (!current || current.end === null) {
    return current
      ? { ...unknown, currentPeriodSequence: current.sequence, benefitPeriodStart: current.start }
      : unknown;
  }

  const nextSequence = current.sequence + 1;
  const nextStart = addCalendarDays(current.end, 1);
  const base = {
    ...unknown,
    currentPeriodSequence: current.sequence,
    benefitPeriodStart: current.start,
    benefitPeriodEnd: current.end,
    nextRecertDueDate: nextStart,
    nextPeriodSequence: nextSequence,
    daysUntilNextRecert: dayDiff(today, nextStart),
  };

  if (nextSequence < F2F_REQUIRED_FROM_SEQUENCE) {
    return { ...base, f2fRequired: false, f2fStatus: "not_required", f2fWindowState: "not_due" };
  }

  const window = computeF2fWindow(nextStart, timeZone);
  const nextPeriod = periods.find((p) => p.sequence === nextSequence);
  const f2fRows = nextPeriod ? (f2fByPeriodId.get(nextPeriod.id) ?? []) : [];
  const attested = f2fRows.some((r) => r.status === "attested");
  const scheduled = f2fRows.find((r) => r.status !== "attested" && r.scheduledDate !== null);
  const verdict = decideF2fWindowStatus({ today, window, attested });

  let f2fStatus: IdgRecertF2fStatus;
  let f2fWindowState: "not_due" | "window_open" | "overdue";
  if (verdict === "attested") {
    f2fStatus = "attested";
    f2fWindowState = "not_due";
  } else if (verdict === "missed") {
    f2fStatus = "missed";
    f2fWindowState = "overdue";
  } else if (today >= window.windowStart) {
    f2fStatus = "window_open";
    f2fWindowState = "window_open";
  } else {
    f2fStatus = "not_yet_open";
    f2fWindowState = "not_due";
  }
  return {
    ...base,
    f2fRequired: true,
    f2fWindowStart: window.windowStart,
    f2fWindowEnd: window.windowEnd,
    f2fStatus,
    f2fWindowState,
    f2fScheduledDate: scheduled?.scheduledDate ?? null,
  };
}

/**
 * Resolve the recert/F2F window for each patient in `patientIds` (their current non-terminal admission) as of
 * `asOf` (default: now, evaluated in the ORG's timezone). Patients with no live admission are absent from the
 * map. ONE query each for admissions, election periods and F2F rows — never per patient.
 */
export async function idgRecertWindowsForOrg(
  db: DbClient,
  organizationId: string,
  patientIds: readonly string[],
  asOf: Date = new Date(),
): Promise<ReadonlyMap<string, IdgRecertWindow>> {
  const ids = [...new Set(patientIds)];
  if (ids.length === 0) return new Map();
  if (ids.length > IDG_RECERT_WINDOWS_MAX_PATIENTS) {
    throw new Error(
      `idgRecertWindowsForOrg: ${ids.length} patients exceeds the ${IDG_RECERT_WINDOWS_MAX_PATIENTS} cap`,
    );
  }
  return withOrgContext(
    db,
    { organizationId, userId: RECERT_WINDOW_SYSTEM_USER_ID },
    async (tx) => {
      const t = tx as unknown as DbClient;
      const timeZone = await organizationTimezone(t, organizationId);
      const today = localDateInTimeZone(asOf, timeZone);

      const admissions = await t
        .select({
          id: ADM.id,
          patientId: ADM.patientId,
          status: ADM.status,
          activatedAt: ADM.activatedAt,
        })
        .from(ADM)
        .where(
          and(
            eq(ADM.organizationId, organizationId),
            inArray(ADM.patientId, ids),
            notInArray(ADM.status, [...TERMINAL_ADMISSION_STATUSES]),
          ),
        );
      if (admissions.length === 0) return new Map();

      // One admission per patient: an `active` one wins, else the most recently activated.
      const chosen = new Map<string, (typeof admissions)[number]>();
      for (const a of admissions) {
        const prior = chosen.get(a.patientId);
        const rank = (x: typeof a): number =>
          (x.status === "active" ? 1_000_000_000_000_000 : 0) +
          (x.activatedAt ? new Date(x.activatedAt).getTime() : 0);
        if (!prior || rank(a) > rank(prior)) chosen.set(a.patientId, a);
      }
      const admissionIds = [...chosen.values()].map((a) => a.id);

      const periodRows = await t
        .select({
          id: EP.id,
          admissionId: EP.admissionId,
          sequence: EP.sequenceNumber,
          status: EP.status,
          start: EP.effectiveAt,
          end: EP.scheduledEndAt,
        })
        .from(EP)
        .where(and(eq(EP.organizationId, organizationId), inArray(EP.admissionId, admissionIds)));
      const periods: PeriodRow[] = periodRows.map((p) => ({
        id: p.id,
        admissionId: p.admissionId,
        sequence: Number(p.sequence),
        status: String(p.status),
        start: ymd(p.start),
        end: ymd(p.end),
      }));

      const periodIds = periods
        .filter((p) => p.sequence >= F2F_REQUIRED_FROM_SEQUENCE)
        .map((p) => p.id);
      const f2fRows =
        periodIds.length === 0
          ? []
          : await t
              .select({
                electionPeriodId: F2F.electionPeriodId,
                status: F2F.status,
                scheduledDate: F2F.scheduledDate,
              })
              .from(F2F)
              .where(
                and(
                  eq(F2F.organizationId, organizationId),
                  inArray(F2F.electionPeriodId, periodIds),
                ),
              );
      const f2fByPeriodId = new Map<string, { status: string; scheduledDate: string | null }[]>();
      for (const r of f2fRows) {
        const bucket = f2fByPeriodId.get(r.electionPeriodId) ?? [];
        bucket.push({ status: String(r.status), scheduledDate: ymd(r.scheduledDate) });
        f2fByPeriodId.set(r.electionPeriodId, bucket);
      }

      const out = new Map<string, IdgRecertWindow>();
      for (const [patientId, adm] of chosen) {
        out.set(
          patientId,
          projectIdgRecertWindow({
            patientId,
            admissionId: adm.id,
            periods: periods.filter((p) => p.admissionId === adm.id),
            f2fByPeriodId,
            today,
            timeZone,
          }),
        );
      }
      return out;
    },
  );
}
