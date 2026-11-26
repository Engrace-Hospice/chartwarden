// @chartwarden/audit — the Drizzle reader behind the security review (CW-MON-01). `audit_event` is HELPER-ONLY, so the only
// sanctioned reader of its rows is this package; the review job (apps/backend/.../04-audit/jobs/security-review-job.ts)
// opens the transaction and hands it here, and never selects the table.
//
// TWO SCOPES, ONE SET OF QUERIES. The org scope runs on a `withOrgContext` transaction (the NOBYPASSRLS `chartwarden_app`
// role: RLS scopes the read, and the explicit `organization_id = …` predicate says the same thing again). The platform scope
// (`organizationId: null`) runs on the audited `withPlatformContext` transaction of the platform login, which carries
// BYPASSRLS and a COLUMN grant on `audit_event` (migration 1561 / scripts/db/provision-runtime-roles.ts), so the explicit
// `organization_id IS NULL` predicate is what keeps it to the org-less authentication rows.
//
// MINIMAL COLUMNS. Only what the rules need is selected, and from `context` only three scalar keys: `userId`, `ipPrefix`
// and `emailHash` (a hash). No `before`, `after`, free text or any other context key is ever read, so nothing the denylist
// would scrub can reach an alert.
import { type SQL, sql } from "drizzle-orm";
import type { BulkAccessHit, RaisedAlertRef, ReviewEvent } from "./evaluate";

/** The one thing the reader needs of a transaction: raw SQL in, rows out (a Drizzle tx satisfies it). */
export interface ReviewSqlExecutor {
  execute<T extends Record<string, unknown>>(query: SQL): Promise<{ readonly rows: T[] }>;
}

/** `organizationId: null` is the platform scope (org-less rows). */
export interface ReviewScope {
  readonly organizationId: string | null;
}

export const SECURITY_REVIEW_COMPLETED_EVENT = "m4.security_review.completed";
export const SECURITY_ALERT_RAISED_EVENT = "m4.security_review.alert_raised";

/** What `delivery` says about a raised alert: only `failed` is retried (the review cursor does not pass it). */
export type AlertDeliveryStatus = "delivered" | "failed" | "no_destination";
export const TERMINAL_DELIVERY_STATUSES: readonly AlertDeliveryStatus[] = [
  "delivered",
  "no_destination",
];

/** UTC ISO-8601 with milliseconds — what a JS Date round-trips. */
const ISO_UTC_MS = `YYYY-MM-DD"T"HH24:MI:SS.MS"Z"`;
/** The only expressions ever spliced raw into SQL: literals of this union, never a caller's string. */
type IsoColumn = "created_at" | "min(created_at)" | "max(created_at)";
const isoOf = (column: IsoColumn): SQL =>
  sql`to_char(${sql.raw(column)} AT TIME ZONE 'UTC', ${sql.raw(`'${ISO_UTC_MS}'`)})`;

const scopeIs = (scope: ReviewScope): SQL =>
  scope.organizationId === null
    ? sql`organization_id IS NULL`
    : sql`organization_id = ${scope.organizationId}::uuid`;

const inList = (values: readonly string[]): SQL =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );

interface SignalRow extends Record<string, unknown> {
  id: string;
  created_at: string;
  event_type: string;
  actor_user_id: string | null;
  context_user_id: string | null;
  ip_prefix: string | null;
  account_hash: string | null;
}

export interface SignalRead {
  readonly events: readonly ReviewEvent[];
  /** True when more rows matched than `limit`: the caller must not treat `to` as reviewed (see the job's cursor). */
  readonly truncated: boolean;
}

/**
 * The rows the always / burst / distinct rules look at: `eventTypes` events in `[from, to)`, oldest first, at most `limit`.
 * One extra row is fetched to learn whether the read was cut short.
 */
export async function readSignalEvents(
  db: ReviewSqlExecutor,
  scope: ReviewScope,
  query: {
    readonly eventTypes: readonly string[];
    readonly from: Date;
    readonly to: Date;
    readonly limit: number;
  },
): Promise<SignalRead> {
  if (query.eventTypes.length === 0) return { events: [], truncated: false };
  const result = await db.execute<SignalRow>(sql`
    SELECT id::text AS id,
           ${isoOf("created_at")} AS created_at,
           event_type,
           actor_user_id::text AS actor_user_id,
           context->>'userId' AS context_user_id,
           context->>'ipPrefix' AS ip_prefix,
           context->>'emailHash' AS account_hash
      FROM audit_event
     WHERE ${scopeIs(scope)}
       AND event_type IN (${inList(query.eventTypes)})
       AND created_at >= ${query.from.toISOString()}::timestamptz
       AND created_at < ${query.to.toISOString()}::timestamptz
     ORDER BY created_at, id
     LIMIT ${query.limit + 1}
  `);
  const rows = result.rows.slice(0, query.limit);
  return {
    truncated: result.rows.length > query.limit,
    events: rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      eventType: r.event_type,
      actorUserId: r.actor_user_id,
      contextUserId: r.context_user_id,
      ipPrefix: r.ip_prefix,
      accountHash: r.account_hash,
    })),
  };
}

interface BulkRow extends Record<string, unknown> {
  actor: string;
  bucket_start: string;
  distinct_records: number;
  first_at: string;
  last_at: string;
  sample_ids: string[];
}

/** Bounds the aggregate. More hits than this in one run is reported (`truncated`) and the run raises a notice for it. */
const BULK_HIT_LIMIT = 200;

export interface BulkAccessRead {
  readonly hits: readonly BulkAccessHit[];
  /** More buckets crossed the threshold than the cap: the later ones were not returned. */
  readonly truncated: boolean;
}

/**
 * Read-audit events (`<kind>.viewed` / `<kind>.disclosed`) are the bulk of the trail, so the per-actor count of DISTINCT
 * records is computed in SQL, per fixed `bucketMs` bucket, and only buckets at or over `threshold` come back.
 */
export async function readBulkAccessHits(
  db: ReviewSqlExecutor,
  scope: ReviewScope,
  query: {
    readonly from: Date;
    readonly to: Date;
    readonly bucketMs: number;
    readonly threshold: number;
  },
): Promise<BulkAccessRead> {
  const bucketSeconds = Math.max(1, Math.floor(query.bucketMs / 1000));
  const result = await db.execute<BulkRow>(sql`
    SELECT actor_user_id::text AS actor,
           to_char(to_timestamp(floor(extract(epoch FROM created_at) / ${bucketSeconds}) * ${bucketSeconds}) AT TIME ZONE 'UTC', ${sql.raw(`'${ISO_UTC_MS}'`)}) AS bucket_start,
           count(DISTINCT (resource_kind, resource_id))::int AS distinct_records,
           ${isoOf("min(created_at)")} AS first_at,
           ${isoOf("max(created_at)")} AS last_at,
           (array_agg(id::text ORDER BY created_at, id))[1:5] AS sample_ids
      FROM audit_event
     WHERE ${scopeIs(scope)}
       AND actor_user_id IS NOT NULL
       AND resource_id IS NOT NULL
       AND (event_type LIKE '%.viewed' OR event_type LIKE '%.disclosed')
       AND created_at >= ${query.from.toISOString()}::timestamptz
       AND created_at < ${query.to.toISOString()}::timestamptz
     GROUP BY 1, 2
    HAVING count(DISTINCT (resource_kind, resource_id)) >= ${query.threshold}
     ORDER BY 2, 1
     LIMIT ${BULK_HIT_LIMIT + 1}
  `);
  return {
    truncated: result.rows.length > BULK_HIT_LIMIT,
    hits: result.rows.slice(0, BULK_HIT_LIMIT).map((r) => ({
      actorUserId: r.actor,
      bucketStart: r.bucket_start,
      distinctRecords: r.distinct_records,
      firstAt: r.first_at,
      lastAt: r.last_at,
      sampleEventIds: r.sample_ids,
    })),
  };
}

/** Where the previous review of this scope got to: the `windowTo` of its newest run that finished clean (`status: ok`), or null on the first run. */
export async function readReviewCursor(
  db: ReviewSqlExecutor,
  scope: ReviewScope,
): Promise<Date | null> {
  const result = await db.execute<{ window_to: string } & Record<string, unknown>>(sql`
    SELECT context->>'windowTo' AS window_to
      FROM audit_event
     WHERE ${scopeIs(scope)}
       AND event_type = ${SECURITY_REVIEW_COMPLETED_EVENT}
       AND context->>'status' = 'ok'
     ORDER BY created_at DESC, id DESC
     LIMIT 1
  `);
  const at = result.rows[0]?.window_to;
  if (at === undefined) return null;
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

interface RaisedRow extends Record<string, unknown> {
  fingerprint: string | null;
  rule_id: string | null;
  subject_kind: string | null;
  subject_ref: string | null;
  window_to: string | null;
}

/**
 * The alerts raised since `since` that reached a terminal delivery status (delivered, or no destination configured): the review's
 * memory. A `failed` one is deliberately absent, so it is raised again. Used for the exact-repeat check (fingerprint) and the
 * cooldown (rule + subject + window end).
 */
export async function readRaisedAlerts(
  db: ReviewSqlExecutor,
  scope: ReviewScope,
  since: Date,
): Promise<readonly RaisedAlertRef[]> {
  const result = await db.execute<RaisedRow>(sql`
    SELECT context->>'fingerprint' AS fingerprint,
           context->>'ruleId' AS rule_id,
           context->'subject'->>'kind' AS subject_kind,
           context->'subject'->>'ref' AS subject_ref,
           context->>'windowTo' AS window_to
      FROM audit_event
     WHERE ${scopeIs(scope)}
       AND event_type = ${SECURITY_ALERT_RAISED_EVENT}
       AND created_at >= ${since.toISOString()}::timestamptz
       AND context->>'delivery' IN (${inList(TERMINAL_DELIVERY_STATUSES)})
  `);
  return result.rows.flatMap((r) => {
    const windowToMs = Date.parse(r.window_to ?? "");
    return r.fingerprint && r.rule_id && r.subject_kind && r.subject_ref && !Number.isNaN(windowToMs)
      ? [
          {
            fingerprint: r.fingerprint,
            ruleId: r.rule_id,
            subjectKind: r.subject_kind,
            subjectRef: r.subject_ref,
            windowToMs,
          },
        ]
      : [];
  });
}

/**
 * One review of one scope at a time. A transaction-scoped advisory lock keyed on the scope: a second run (a tick that outlasted its
 * 15 minutes, a second worker replica, a stalled-job re-run) finds it taken and skips, instead of reading the same cursor and
 * delivering every alert twice. It is released when the run's transaction ends, so a crashed run never holds it.
 */
export async function tryAcquireReviewLock(
  db: ReviewSqlExecutor,
  scope: ReviewScope,
): Promise<boolean> {
  const key = `m4.security_review:${scope.organizationId ?? "platform"}`;
  const result = await db.execute<{ locked: boolean } & Record<string, unknown>>(
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS locked`,
  );
  return result.rows[0]?.locked === true;
}
