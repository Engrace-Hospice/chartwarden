// apps/backend/src/modules/30-quality/jobs/alert-repeat-sweeps.ts - GAP-049.
//
// The REPEAT half of four M30 §4.9 cadences. M36's `quality-alerts` consumer raises the first page when the M30 event
// is published; the spec then promises (M30 §4.9, lines 2178-2182):
//   incident_sentinel          immediate, then every 4h   until triaged
//   incident_abuse_allegation  immediate, then every 6h   until triaged
//   outbreak_detected          immediate, then every 12h  until reviewed
//   measure_threshold_breached every 7d                   until a project is chartered
// and nothing repeated them: `alert_rule` has no interval and `alert` has no open/resolved state.
//
// MECHANISM (the cap-overdue / review-overdue pattern, plus origin-anchored buckets). A 15-minute tick reads each active
// org under its own RLS context, asks the OWNING module's tables which items are still open (the state change that ends a
// series simply removes the row from the scan), and raises the repeat through `AlertEmitter`. The correlation id
// carries the bucket `floor((now - origin) / interval)`; bucket 0 is the page the consumer already sent, bucket N >= 1 is
// `<original>:rN`. `alert` is UNIQUE on (organization_id, correlation_id), so re-running inside a bucket is idempotent and
// a missed run catches up to the CURRENT bucket only. The intervals, ceilings and the sentinel/abuse predicates come from
// @wardenx/types (m30-alert-cadence.ts), the same source the consumer reads. No migration, no new `alert_rule`: repeats
// re-use the seeded rules of the original alert types. Payloads are ids, enums and instants only - no PHI.
//
// Reopened incidents: a `reopened` incident was already triaged once, so the sentinel cadence does NOT restart (only
// `lifecycle = 'submitted' AND triaged_at IS NULL` is open). D4: no cap on the three safety pages; 90-day ceiling on the
// 7-day threshold series.
import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import {
  type M30RepeatCadence,
  M30_ABUSE_INCIDENT_KIND,
  M30_REPEAT_CADENCES,
  M30_SENTINEL_INCIDENT_SEVERITY,
  qualityAlertCorrelationId,
  repeatBucket,
} from "@wardenx/types";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { sql } from "drizzle-orm";

export const M30_ALERT_REPEAT_QUEUE = "m30.alert_repeat_sweep";
/** Every 15 minutes: the finest cadence is 4h, so a repeat lands within 15 minutes of its due instant. */
export const M30_ALERT_REPEAT_SCHEDULE = "*/15 * * * *";
const SYSTEM_USER_ID = "";

/** One still-open item the owning module says is unresolved, with the data a repeat page needs. */
export interface OpenAlertItem {
  readonly cadence: M30RepeatCadence;
  /** The same key the consumer used for the original page (`QualityAlertPlan.correlationKey`). */
  readonly key: string;
  /** When the original page was due: the series origin. */
  readonly originAt: Date;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface RepeatAlertInput {
  readonly eventType: string;
  readonly severity: "critical" | "warn";
  readonly correlationId: string;
  readonly payload: Record<string, unknown>;
}

/**
 * PURE - the repeat pages due at `now`. One page per distinct (alert type, key): items sharing a key (the same
 * measure breached for two provider entities) collapse onto the earliest origin so the shared correlation id is not
 * emitted twice. Bucket 0 and an exhausted ceiling emit nothing.
 */
export function repeatAlertsFor(
  items: readonly OpenAlertItem[],
  now: Date,
): readonly RepeatAlertInput[] {
  const earliest = new Map<string, OpenAlertItem>();
  for (const item of items) {
    const id = `${item.cadence.alertType}\u0000${item.key}`;
    const known = earliest.get(id);
    if (!known || item.originAt.getTime() < known.originAt.getTime()) earliest.set(id, item);
  }
  const due: RepeatAlertInput[] = [];
  for (const item of earliest.values()) {
    const bucket = repeatBucket(item.originAt, now, item.cadence);
    if (bucket === null || bucket < 1) continue;
    due.push({
      eventType: item.cadence.alertType,
      severity: item.cadence.severity,
      correlationId: qualityAlertCorrelationId(item.cadence.alertType, item.key, bucket),
      payload: { ...item.payload, eventType: item.cadence.alertType, repeatOrdinal: bucket },
    });
  }
  return due;
}

export interface AlertRepeatRunDeps {
  readonly listActiveOrgs: () => Promise<readonly { readonly organizationId: string }[]>;
  readonly scanOpenItems: (organizationId: string, now: Date) => Promise<readonly OpenAlertItem[]>;
  readonly emit: (organizationId: string, input: RepeatAlertInput) => Promise<unknown>;
  readonly now: () => Date;
  readonly warn?: (message: string, context: Record<string, string>) => void;
}

export interface AlertRepeatRunSummary {
  readonly orgs: number;
  readonly repeatsRaised: number;
  readonly failedOrgs: number;
}

/** One pass over every active org; a failing org is counted and never stops the rest. */
export async function runAlertRepeatSweeps(
  deps: AlertRepeatRunDeps,
): Promise<AlertRepeatRunSummary> {
  const now = deps.now();
  const orgs = await deps.listActiveOrgs();
  let repeatsRaised = 0;
  let failedOrgs = 0;
  for (const { organizationId } of orgs) {
    try {
      for (const input of repeatAlertsFor(await deps.scanOpenItems(organizationId, now), now)) {
        await deps.emit(organizationId, input);
        repeatsRaised += 1;
      }
    } catch (error) {
      failedOrgs += 1;
      deps.warn?.("m30.alert_repeat_sweep: org sweep failed", {
        organizationId,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  return { orgs: orgs.length, repeatsRaised, failedOrgs };
}

type Rows<T> = { rows?: T[] };
const rowsOf = <T>(res: unknown): T[] => (res as Rows<T>).rows ?? [];
const toDate = (value: unknown): Date => new Date(value as string | Date);
const iso = (value: unknown): string => toDate(value).toISOString();

interface OpenIncidentRow {
  readonly incidentId: string;
  readonly kind: string;
  readonly severity: string;
  readonly reportedAt: string | Date;
}

/** Submitted, not-yet-triaged incidents that the consumer would have paged (sentinel severity or an abuse allegation). */
async function scanOpenIncidents(
  db: DbClient,
  organizationId: string,
): Promise<readonly OpenAlertItem[]> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const res = await tx.execute(sql`
      SELECT id AS "incidentId", kind::text AS kind, severity::text AS severity, reported_at AS "reportedAt"
        FROM incident_report
       WHERE organization_id = ${organizationId}::uuid
         AND lifecycle = 'submitted'::m30_incident_lifecycle
         AND triaged_at IS NULL
         AND (severity = ${M30_SENTINEL_INCIDENT_SEVERITY}::m30_incident_severity
              OR kind = ${M30_ABUSE_INCIDENT_KIND}::m30_incident_kind)`);
    return rowsOf<OpenIncidentRow>(res).flatMap((row) => {
      const base = {
        incidentId: row.incidentId,
        kind: row.kind,
        severity: row.severity,
        reportedAt: iso(row.reportedAt),
        deepLink: `/quality/incidents/${row.incidentId}`,
      };
      const items: OpenAlertItem[] = [];
      if (row.severity === M30_SENTINEL_INCIDENT_SEVERITY) {
        items.push({
          cadence: M30_REPEAT_CADENCES.incident_sentinel,
          key: row.incidentId,
          originAt: toDate(row.reportedAt),
          payload: { ...base, message: "A sentinel-severity incident is still awaiting triage." },
        });
      }
      if (row.kind === M30_ABUSE_INCIDENT_KIND) {
        items.push({
          cadence: M30_REPEAT_CADENCES.incident_abuse_allegation,
          key: row.incidentId,
          originAt: toDate(row.reportedAt),
          payload: { ...base, message: "An abuse-allegation incident is still awaiting triage." },
        });
      }
      return items;
    });
  });
}

interface OpenOutbreakRow {
  readonly caseId: string;
  readonly pathogen: string;
  readonly bodySite: string;
  readonly eventCount: number;
  readonly windowStart: string | Date;
  readonly windowEnd: string | Date;
  readonly createdAt: string | Date;
}

/** Outbreak cases opened and not yet IDG-reviewed. */
async function scanOpenOutbreaks(
  db: DbClient,
  organizationId: string,
): Promise<readonly OpenAlertItem[]> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const res = await tx.execute(sql`
      SELECT id AS "caseId", pathogen, body_site AS "bodySite", triggering_event_count AS "eventCount",
             window_start AS "windowStart", window_end AS "windowEnd", created_at AS "createdAt"
        FROM infection_outbreak_case
       WHERE organization_id = ${organizationId}::uuid
         AND status = 'open'::m30_outbreak_status
         AND idg_reviewed_at IS NULL`);
    return rowsOf<OpenOutbreakRow>(res).map((row) => ({
      cadence: M30_REPEAT_CADENCES.outbreak_detected,
      key: row.caseId,
      originAt: toDate(row.createdAt),
      payload: {
        caseId: row.caseId,
        pathogen: row.pathogen,
        bodySite: row.bodySite,
        eventCount: Number(row.eventCount),
        firstEventAt: iso(row.windowStart),
        lastEventAt: iso(row.windowEnd),
        deepLink: "/quality/infection",
        message: "An infection outbreak is still awaiting IDG review.",
      },
    }));
  });
}

interface OpenBreachRow {
  readonly measureCode: string;
  readonly periodEnd: string | Date;
  readonly ratio: string | number | null;
  readonly originAt: string | Date;
}

/**
 * Measures whose LATEST period is currently red (the persisted band; rows that predate migration 1051 fall back to the
 * old threshold_met reading) and that no non-abandoned QAPI project is tracking. A project is "chartered" when it is
 * inserted (M30 spec §4.10 `m30.qapi.project_chartered`), so any project linked to a `measure:<code>` indicator that has
 * not been abandoned ends the series. The origin is the first red computation of that period.
 */
async function scanOpenBreaches(
  db: DbClient,
  organizationId: string,
): Promise<readonly OpenAlertItem[]> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const res = await tx.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (v.measure_code, v.provider_entity_id)
               v.measure_code, v.provider_entity_id, v.period_start, v.period_end, v.ratio, v.band_color, v.threshold_met
          FROM quality_measure_value v
         WHERE v.organization_id = ${organizationId}::uuid
           AND v.superseded_at IS NULL
         ORDER BY v.measure_code, v.provider_entity_id, v.period_end DESC
      )
      SELECT l.measure_code AS "measureCode", l.period_end AS "periodEnd", l.ratio AS ratio,
             (SELECT min(h.computed_at)
                FROM quality_measure_value h
               WHERE h.organization_id = ${organizationId}::uuid
                 AND h.measure_code = l.measure_code
                 AND h.provider_entity_id = l.provider_entity_id
                 AND h.period_start = l.period_start
                 AND h.period_end = l.period_end
                 AND (h.band_color = 'red'
                      OR (h.band_color IS NULL AND h.threshold_met = false AND h.ratio IS NOT NULL))) AS "originAt"
        FROM latest l
       WHERE (l.band_color = 'red' OR (l.band_color IS NULL AND l.threshold_met = false AND l.ratio IS NOT NULL))
         AND NOT EXISTS (
           SELECT 1
             FROM qapi_project p
             JOIN qapi_indicator i ON i.id = p.linked_indicator_id
            WHERE p.organization_id = ${organizationId}::uuid
              AND i.organization_id = ${organizationId}::uuid
              AND i.deleted_at IS NULL
              AND p.status <> 'abandoned'::m30_qapi_project_status
              AND i.data_path = 'measure:' || l.measure_code)`);
    return rowsOf<OpenBreachRow>(res).flatMap((row) => {
      const periodEnd = iso(row.periodEnd);
      return [
        {
          cadence: M30_REPEAT_CADENCES.measure_threshold_breached,
          key: `${row.measureCode}:${periodEnd}`,
          originAt: toDate(row.originAt),
          payload: {
            indicatorId: row.measureCode,
            measureId: row.measureCode,
            periodEnd,
            rate: row.ratio === null ? null : Number(row.ratio),
            severityBand: "red",
            deepLink: "/quality/qapi",
            message: "A QAPI indicator is still over its threshold with no improvement project.",
          },
        },
      ];
    });
  });
}

/** Every open item across the four cadences for one org (RLS-scoped, org-explicit). */
export async function scanOrgForOpenAlertItems(
  db: DbClient,
  organizationId: string,
): Promise<readonly OpenAlertItem[]> {
  const [incidents, outbreaks, breaches] = await Promise.all([
    scanOpenIncidents(db, organizationId),
    scanOpenOutbreaks(db, organizationId),
    scanOpenBreaches(db, organizationId),
  ]);
  return [...incidents, ...outbreaks, ...breaches];
}

export interface AlertRepeatWorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  readonly listActiveOrgs: AlertRepeatRunDeps["listActiveOrgs"];
  readonly emit: AlertRepeatRunDeps["emit"];
  readonly now?: () => Date;
  readonly warn?: AlertRepeatRunDeps["warn"];
}

/** Construct the `m30.alert_repeat_sweep` Worker over the real DB reads + the M36 emitter. */
export function registerM30AlertRepeatWorker(deps: AlertRepeatWorkerDeps): Worker {
  const now = deps.now ?? (() => new Date());
  return new Worker(
    M30_ALERT_REPEAT_QUEUE,
    async () =>
      runAlertRepeatSweeps({
        listActiveOrgs: deps.listActiveOrgs,
        scanOpenItems: (organizationId) => scanOrgForOpenAlertItems(deps.db, organizationId),
        emit: deps.emit,
        now,
        warn: deps.warn,
      }),
    { connection: deps.connection, concurrency: 1 },
  );
}

/** Register the 15-minute repeatable tick; returns the schedule `Queue` for the composition root to close. */
export async function scheduleM30AlertRepeatJob(connection: ConnectionOptions): Promise<Queue> {
  const queue = new Queue(M30_ALERT_REPEAT_QUEUE, { connection });
  await queue.add(
    "scheduled",
    {},
    { repeat: { pattern: M30_ALERT_REPEAT_SCHEDULE }, removeOnComplete: true },
  );
  return queue;
}
