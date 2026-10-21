// @chartwarden/hope — the timepoint window calculator (M10-T03; §2.2.1, §2.3, D2). PURE, IO-free: given an
// admission/LOC anchor date (the SOC start-of-care date, resolved from M6's admission readers) and the
// org timezone, it computes the [window_opens_at, window_closes_at, late_deadline_at] instants for each
// CMS HOPE timepoint, and classifies a candidate `target_date` against a stored schedule's window (the
// soft-window + hard-cutoff D2 model). The scheduling worker (M10-T06) composes `windowFor` over the M6
// `admission.activated` outbox event; the recording service (M10-T06) composes `classifyCapture` to set
// `was_late` and gate the hard cutoff.
import type { HopeRfaKind, IsoInstant, LocalDate } from "@chartwarden/types";
import { addCalendarDays, endOfOrgDayInstant, startOfOrgDayInstant } from "./time";

/** The §3.3 schedule window for a timepoint: org-local day boundaries materialized as UTC instants. */
export interface TimepointWindow {
  readonly windowOpensAt: IsoInstant;
  readonly windowClosesAt: IsoInstant;
  readonly lateDeadlineAt: IsoInstant;
}

/** The CMS HOPE day-offset spec for an admission-anchored RFA, counted from the SOC date as **day 1**
 * (so `openDayOffset` 0 = day 1). The closed soft window is `[anchor + openDayOffset, anchor +
 * closeDayOffset]` inclusive org-local days. */
interface RfaDayWindow {
  readonly openDayOffset: number;
  readonly closeDayOffset: number;
}

/**
 * The §2 / task #6 admission-anchored CMS HOPE windows (SOC counted as day 1):
 *   • Admission — days 1–5   (`[+0, +4]`)
 *   • HUV1      — days 6–15  (`[+5, +14]`)
 *   • HUV2      — days 16–30 (`[+15, +29]`)
 * The §7.1 acceptance ("Admission HOPE captured on day 3") falls inside the Admission window. The
 * Discharge RFA is NOT admission-anchored — it is materialized from M6's `admission.discharged` event
 * (D9) via {@link dischargeWindow}; the SFV (RFA 04) is signed-at-anchored (D3) and has no fixed window.
 */
export const ADMISSION_ANCHORED_WINDOWS: {
  readonly "01_admission": RfaDayWindow;
  readonly "02_huv1": RfaDayWindow;
  readonly "03_huv2": RfaDayWindow;
} = {
  "01_admission": { openDayOffset: 0, closeDayOffset: 4 },
  "02_huv1": { openDayOffset: 5, closeDayOffset: 14 },
  "03_huv2": { openDayOffset: 15, closeDayOffset: 29 },
} as const;

/** The RFA kinds {@link windowFor} understands as admission-anchored (Admission / HUV1 / HUV2). */
export type AdmissionAnchoredRfaKind = keyof typeof ADMISSION_ANCHORED_WINDOWS;

/** D2 — tenant grace (calendar days) between `window_closes_at` and `late_deadline_at`; capture in the
 * grace span requires a typed `late_reason_code`, capture past it is rejected. Default 7 days. */
export const DEFAULT_LATE_GRACE_DAYS = 7;

/** The §3.3 Discharge RFA window length: 7 calendar days from the discharge date (D9). */
export const DISCHARGE_WINDOW_DAYS = 7;

/** Build a {@link TimepointWindow} from a closed org-local day span + the grace late-deadline. */
function windowFromDays(
  anchorDate: LocalDate,
  span: RfaDayWindow,
  timeZone: string,
  graceDays: number,
): TimepointWindow {
  const opensDate = addCalendarDays(anchorDate, span.openDayOffset);
  const closesDate = addCalendarDays(anchorDate, span.closeDayOffset);
  const lateDate = addCalendarDays(closesDate, graceDays);
  return {
    windowOpensAt: startOfOrgDayInstant(opensDate, timeZone),
    windowClosesAt: endOfOrgDayInstant(closesDate, timeZone),
    lateDeadlineAt: endOfOrgDayInstant(lateDate, timeZone),
  };
}

/**
 * §2 / D2 — the admission-anchored window for an Admission / HUV1 / HUV2 timepoint, computed from the SOC
 * `anchorDate` (org-local `yyyy-mm-dd`) in the org `timeZone`. `graceDays` (default {@link
 * DEFAULT_LATE_GRACE_DAYS}) sets the late-deadline span.
 */
export function windowFor(
  rfaKind: AdmissionAnchoredRfaKind,
  anchorDate: LocalDate,
  timeZone: string,
  graceDays: number = DEFAULT_LATE_GRACE_DAYS,
): TimepointWindow {
  return windowFromDays(anchorDate, ADMISSION_ANCHORED_WINDOWS[rfaKind], timeZone, graceDays);
}

/**
 * D9 — the Discharge RFA window: a 7-calendar-day window from the `dischargeDate` (org-local) plus the
 * standard grace late-deadline. Materialized by the discharge listener (M10-T06) off `m6.discharge.*`.
 */
export function dischargeWindow(
  dischargeDate: LocalDate,
  timeZone: string,
  graceDays: number = DEFAULT_LATE_GRACE_DAYS,
): TimepointWindow {
  return windowFromDays(
    dischargeDate,
    { openDayOffset: 0, closeDayOffset: DISCHARGE_WINDOW_DAYS - 1 },
    timeZone,
    graceDays,
  );
}

/** D2 — where a candidate `target_date` instant falls relative to a stored schedule window:
 *   • `before_open` → reject (`M10_TIMEPOINT_NOT_OPEN`)
 *   • `in_window`   → normal capture (`was_late=false`)
 *   • `late`        → capture allowed with a typed `late_reason_code` (`was_late=true`)
 *   • `expired`     → reject unless an admin override extends the deadline (`M10_TIMEPOINT_EXPIRED`) */
export type CaptureWindowVerdict = "before_open" | "in_window" | "late" | "expired";

/**
 * §2.3 / D2 — classify a `target_date` capture instant against the stored schedule window. This is the
 * single source the recording service uses to set `was_late` and decide the hard cutoff; it does NOT
 * throw (the throwing guard is {@link assertCaptureAllowed} in `timepoint-gate.ts`, so the service can
 * branch on the verdict before raising).
 */
export function classifyCapture(
  targetDate: IsoInstant,
  window: TimepointWindow,
): CaptureWindowVerdict {
  const t = Date.parse(targetDate);
  if (t < Date.parse(window.windowOpensAt)) return "before_open";
  if (t <= Date.parse(window.windowClosesAt)) return "in_window";
  if (t <= Date.parse(window.lateDeadlineAt)) return "late";
  return "expired";
}
