// @chartwarden/types - the M30 §4.9 REPEAT cadences, in one table (GAP-049).
//
// The first page of a quality alert is raised by M36's `quality-alerts` outbox consumer when the M30 event is
// published. The spec then promises a repeat ("immediate, then every 4h until triaged"): that is raised by the
// M30 `alert_repeat_sweep` cron, which re-derives "still open" from the OWNING module's rows. Both halves read the
// predicates and intervals from here so the consumer and the sweep cannot disagree about what a sentinel is or how
// often it repeats (M30 spec §4.9, lines 2178-2182; the §13.6 minutes/maxRepeats sketch is older and loses).
//
// ORIGIN-ANCHORED BUCKETS. `alert` is UNIQUE on (organization_id, correlation_id), so a repeat is a new alert with
// a new correlation id. An epoch-aligned bucket (`floor(now / interval)`) would land the first repeat anywhere in
// (0, interval] after the original page; "immediate, then 4h" needs `floor((now - originAt) / interval)`. Bucket 0
// is the original page (its correlation id is unchanged); bucket N >= 1 is `<original>:rN`. A missed sweep catches up
// to the CURRENT bucket only - one page, never a burst.
//
// Pure data and arithmetic: no I/O, no PHI.

/** The incident severity the spec calls a "sentinel" event (`m30_incident_severity`). */
export const M30_SENTINEL_INCIDENT_SEVERITY = "critical";
/** The incident kind that raises the abuse-allegation alert (`m30_incident_kind`). */
export const M30_ABUSE_INCIDENT_KIND = "allegation_of_abuse";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export type M30RepeatCadenceKey =
  | "incident_sentinel"
  | "incident_abuse_allegation"
  | "outbreak_detected"
  | "measure_threshold_breached";

export interface M30RepeatCadence {
  /** The seeded platform `alert_rule` event type the repeat re-uses (no new rule is needed). */
  readonly alertType: string;
  /** Severity of the original page; repeats carry the same one. */
  readonly severity: "critical" | "warn";
  readonly intervalMs: number;
  /** Stop repeating this long after the origin; `null` = repeat until the condition clears (safety pages). */
  readonly ceilingMs: number | null;
  /** The owning-module state change that ends the series (documentation + test vocabulary). */
  readonly until: "triaged" | "reviewed" | "project_chartered";
}

/**
 * Spec §4.9. D4: no cap on the three safety pages (a sentinel / abuse allegation / outbreak must keep paging until a
 * person acts); the 7-day threshold series carries a 90-day ceiling so an abandoned indicator cannot page forever.
 */
export const M30_REPEAT_CADENCES: Readonly<Record<M30RepeatCadenceKey, M30RepeatCadence>> = {
  incident_sentinel: {
    alertType: "m30.alerts.incident_sentinel",
    severity: "critical",
    intervalMs: 4 * HOUR_MS,
    ceilingMs: null,
    until: "triaged",
  },
  incident_abuse_allegation: {
    alertType: "m30.alerts.incident_abuse_allegation",
    severity: "critical",
    intervalMs: 6 * HOUR_MS,
    ceilingMs: null,
    until: "triaged",
  },
  outbreak_detected: {
    alertType: "m30.alerts.outbreak_detected",
    severity: "warn",
    intervalMs: 12 * HOUR_MS,
    ceilingMs: null,
    until: "reviewed",
  },
  measure_threshold_breached: {
    alertType: "m30.alerts.measure_threshold_breached",
    severity: "warn",
    intervalMs: 7 * DAY_MS,
    ceilingMs: 90 * DAY_MS,
    until: "project_chartered",
  },
};

/**
 * The repeat bucket `now` falls in, or `null` when nothing is due: before the origin, past the series ceiling.
 * Bucket 0 (the original page) is returned as 0 - the sweep emits only buckets >= 1.
 */
export function repeatBucket(originAt: Date, now: Date, cadence: M30RepeatCadence): number | null {
  const elapsed = now.getTime() - originAt.getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  if (cadence.ceilingMs !== null && elapsed > cadence.ceilingMs) return null;
  return Math.floor(elapsed / cadence.intervalMs);
}

/**
 * The `alert.correlation_id` of a quality alert: the consumer's original page is bucket 0 (no suffix), repeats are
 * `:r<bucket>`. The ONE place the format lives.
 */
export function qualityAlertCorrelationId(alertType: string, key: string, bucket = 0): string {
  const base = `outbox:${alertType}:${key}`;
  return bucket === 0 ? base : `${base}:r${bucket}`;
}
