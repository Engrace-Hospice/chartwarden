// apps/web/src/modules/10-hope — where a capture falls against its schedule window, and what a refusal of the server's asks for that this
// picture could not (split from the recording dialog, which is about the form). The SERVER judges the window; this decides only what to ASK for.

/**
 * The permission the server requires for `adminOverride` (hope-routes.ts `ADMIN_LATE_OVERRIDE`): a request that asks for the override
 * without it is refused 403, after the clinician has typed a justification. A session known to lack it is not offered the control.
 */
export const OVERRIDE_PERMISSION = "hope.admin.late_deadline_override";
/** What the refusal M10_TIMEPOINT_EXPIRED says to a clinician who cannot tick the override (instead of telling them to). */
export const OVERRIDE_NOT_PERMITTED_ASKED =
  "This visit is past the late deadline, so recording it needs an administrative override. Only an administrator with override permission can give one: ask your administrator how this visit should be recorded.";

/** The window a schedule row publishes; supplied when the capture completes a known timepoint. */
export interface RecordWindow {
  readonly id: string;
  readonly rfaKind: string;
  readonly windowOpensAt: string;
  readonly windowClosesAt: string;
  readonly lateDeadlineAt: string;
}

/** Where the capture falls against the window — used ONLY to decide what to ask for. */
export type CaptureSpan = "before_open" | "in_window" | "late" | "expired" | "unscheduled";

/**
 * Mirrors the server's capture gate (`assertCaptureAllowed`, GAP-015). A visit dated before the window opens is refused on
 * its own date; everything else is judged at the LATER of the visit date and now, so a visit dated inside the window but
 * entered after it closed is late (it needs a reason), and one entered after the late deadline needs the override. Judging
 * the typed date alone would never offer either control, and the server's 400 / 409 would have no way to be answered.
 */
export function spanOf(
  targetIso: string,
  window: RecordWindow | null,
  nowMs: number = Date.now(),
): CaptureSpan {
  if (window === null) return "unscheduled";
  const at = Date.parse(targetIso);
  if (Number.isNaN(at)) return "unscheduled";
  if (at < Date.parse(window.windowOpensAt)) return "before_open";
  const judgedAt = Math.max(at, nowMs);
  if (judgedAt <= Date.parse(window.windowClosesAt)) return "in_window";
  if (judgedAt <= Date.parse(window.lateDeadlineAt)) return "late";
  return "expired";
}

/**
 * What the SERVER's refusal asks for when the modal's own picture of the window could not (opened with no schedule, or a stored
 * window that looked in time): the late-reason control for M10_LATE_REASON_REQUIRED, the override for M10_TIMEPOINT_EXPIRED. Without
 * this the refusal would repeat over a form with nothing that answers it. Judged for the date and reason typed, so it is dropped
 * when either changes.
 */
export const SPAN_ASKED_BY_CODE: Readonly<
  Record<string, { readonly span: "late" | "expired"; readonly message: string }>
> = {
  M10_LATE_REASON_REQUIRED: {
    span: "late",
    message:
      "This visit is after the normal window, so a late completion reason is required. Choose one in the form (it has been added), then record again.",
  },
  M10_TIMEPOINT_EXPIRED: {
    span: "expired",
    message:
      "This visit is past the late deadline, so recording it needs an administrative override. Tick the override in the form (it has been added) and give its justification, then record again.",
  },
};

/** The explanations above, so one that describes a control that has since gone can be told from any other error. */
export const ASKED_MESSAGES: ReadonlySet<string> = new Set([
  ...Object.values(SPAN_ASKED_BY_CODE).map((asked) => asked.message),
  OVERRIDE_NOT_PERMITTED_ASKED,
]);

/** How strict a verdict is, to tell whether a refusal asks for more than the modal's own window did. */
const STRICTNESS: Readonly<Record<CaptureSpan, number>> = {
  before_open: -1,
  unscheduled: 0,
  in_window: 0,
  late: 1,
  expired: 2,
};

/**
 * Whether the server's refusal asks for more than the modal's own verdict offered (a client clock behind the server, a stored
 * window that has since moved, or no schedule at all): then the control it asks for is added. A visit the modal judged before the
 * window opened is a different refusal (M10_TIMEPOINT_NOT_OPEN), so nothing is added for it.
 */
export const asksForMore = (asked: "late" | "expired", own: CaptureSpan): boolean =>
  own !== "before_open" && STRICTNESS[asked] > STRICTNESS[own];
