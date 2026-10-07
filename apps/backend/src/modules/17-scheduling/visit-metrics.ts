// apps/backend/src/modules/17-scheduling/visit-metrics.ts — GAP-131 (M17 §5.1) the visit-metrics rates, computed from real rows.
//
// `GET /metrics/visits` used to return a hard-coded `onTimeRate: 1` and ignore its window. These are the real rates over
// the window: no-show / reschedule over every visit scheduled in it, and on-time over the visits that actually STARTED
// (a visit that never started has no arrival to be on time for). A started visit is on time when it began no later
// than `ON_TIME_GRACE_MINUTES` after its scheduled start. No started visit in the window => `onTimeRate: 0`, never a
// fabricated 1 (the dashboard shows the gap instead of a perfect score).

/** Minutes after the scheduled start a visit may begin and still count as on time. */
export const ON_TIME_GRACE_MINUTES = 15;

const MS_PER_MINUTE = 60_000;

export interface VisitMetricRow {
  readonly scheduledStartedAt: string;
  /** When the clinician actually arrived / started (M18); null until the visit starts. */
  readonly actualStartedAt: string | null;
  readonly status: string;
}

export interface VisitMetrics {
  readonly onTimeRate: number;
  readonly noShowRate: number;
  readonly rescheduleRate: number;
}

export function computeVisitMetrics(
  rows: readonly VisitMetricRow[],
  window: { readonly from: string; readonly to: string },
  graceMinutes: number = ON_TIME_GRACE_MINUTES,
): VisitMetrics {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  const inWindow = rows.filter((r) => {
    const at = Date.parse(r.scheduledStartedAt);
    return at >= from && at < to;
  });
  const total = inWindow.length || 1;
  const noShow = inWindow.filter((r) => r.status === "no_show").length;
  const rescheduled = inWindow.filter((r) => r.status === "rescheduled").length;
  const started = inWindow.filter((r) => r.actualStartedAt !== null);
  const onTime = started.filter(
    (r) =>
      Date.parse(r.actualStartedAt as string) <=
      Date.parse(r.scheduledStartedAt) + graceMinutes * MS_PER_MINUTE,
  ).length;
  return {
    onTimeRate: started.length === 0 ? 0 : onTime / started.length,
    noShowRate: noShow / total,
    rescheduleRate: rescheduled / total,
  };
}
