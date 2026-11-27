// @chartwarden/audit — the Drizzle reader behind the security review (CW-MON-01). `audit_event` is HELPER-ONLY, so the only
// sanctioned reader of its rows is this package; the review job (apps/backend/.../04-audit/jobs/security-review-job.ts)
// opens the transaction and hands it here, and never selects the table.
//
// TWO SCOPES, TWO DOORS. The org scope runs on a `withOrgContext` transaction (the NOBYPASSRLS `chartwarden_app`
// role: RLS scopes the read, and the explicit `organization_id = …` predicate says the same thing again). The platform scope
// (`organizationId: null`) runs on the audited `withPlatformContext` transaction of the platform login, which is BYPASSRLS and
// holds NO SELECT on `audit_event`: it reads the org-less authentication rows only through the three bounded SECURITY DEFINER
// readers `m4_review_platform_signals`, `_cursor` and `_raised_alerts` (migration 1566), whose owner can see org-less rows and
// nothing else. A platform-scope read that does not go through one of them is refused by the database (42501).
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
type IsoColumn = "created_at" | "min(created_at)" | "max(created_at)" | "occurred_at" | "row_at";
const isoOf = (column: IsoColumn): SQL =>
  sql`to_char(${sql.raw(column)} AT TIME ZONE 'UTC', ${sql.raw(`'${ISO_UTC_MS}'`)})`;

/** The org scope's predicate. There is deliberately no org-less twin: the platform login reads those rows only through the definer readers. */
const orgIs = (organizationId: string): SQL => sql`organization_id = ${organizationId}::uuid`;

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

interface SignalQuery {
  readonly eventTypes: readonly string[];
  readonly from: Date;
  readonly to: Date;
  readonly limit: number;
  /**
   * Keep the NEWEST `limit` rows instead of the oldest. The look-back overlap reads this way: the rows that stitch a burst
   * straddling the cursor are the ones nearest it, and a cap must not drop those. Rows are returned oldest first either way.
   */
  readonly newestFirst?: boolean;
}

/** The org scope: a direct read of the organization's own rows, under RLS. One extra row is fetched to learn about truncation. */
function orgSignalRows(db: ReviewSqlExecutor, organizationId: string, query: SignalQuery) {
  const order = query.newestFirst ? sql`ORDER BY created_at DESC, id DESC` : sql`ORDER BY created_at, id`;
  return db.execute<SignalRow>(sql`
    SELECT id::text AS id,
           ${isoOf("created_at")} AS created_at,
           event_type,
           actor_user_id::text AS actor_user_id,
           context->>'userId' AS context_user_id,
           context->>'ipPrefix' AS ip_prefix,
           context->>'emailHash' AS account_hash
      FROM audit_event
     WHERE ${orgIs(organizationId)}
       AND event_type IN (${inList(query.eventTypes)})
       AND created_at >= ${query.from.toISOString()}::timestamptz
       AND created_at < ${query.to.toISOString()}::timestamptz
     ${order}
     LIMIT ${query.limit + 1}
  `);
}

/**
 * The platform scope: the org-less sign-in events through the bounded SECURITY DEFINER reader (migration 1566), which raises 22023
 * for an event type, window or row limit outside its bounds. The outer ORDER BY states the order the caller relies on.
 */
function platformSignalRows(db: ReviewSqlExecutor, query: SignalQuery) {
  const order = query.newestFirst
    ? sql`ORDER BY occurred_at DESC, event_id DESC`
    : sql`ORDER BY occurred_at, event_id`;
  return db.execute<SignalRow>(sql`
    SELECT event_id::text AS id,
           ${isoOf("occurred_at")} AS created_at,
           event_kind AS event_type,
           actor_id::text AS actor_user_id,
           context_user_id,
           ip_prefix,
           account_hash
      FROM public.m4_review_platform_signals(
             ARRAY[${inList(query.eventTypes)}]::text[],
             ${query.from.toISOString()}::timestamptz,
             ${query.to.toISOString()}::timestamptz,
             ${query.limit + 1}::integer,
             ${query.newestFirst === true}::boolean)
     ${order}
  `);
}

/**
 * The rows the always / burst / distinct rules look at: `eventTypes` events in `[from, to)`, oldest first, at most `limit`.
 * One extra row is fetched to learn whether the read was cut short.
 */
export async function readSignalEvents(
  db: ReviewSqlExecutor,
  scope: ReviewScope,
  query: SignalQuery,
): Promise<SignalRead> {
  if (query.eventTypes.length === 0) return { events: [], truncated: false };
  const result =
    scope.organizationId === null
      ? await platformSignalRows(db, query)
      : await orgSignalRows(db, scope.organizationId, query);
  const kept = result.rows.slice(0, query.limit);
  const rows = query.newestFirst ? [...kept].reverse() : kept;
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
  if (scope.organizationId === null) {
    // No rule of the platform lane aggregates reads, and the platform login cannot read `audit_event` (migration 1566): failing
    // here is the honest answer to a rule that was added without a reader, never an empty "all clear".
    throw new Error("CW-MON-01: the platform lane has no bulk-access reader (add a bounded definer reader, never a direct read)");
  }
  const bucketSeconds = Math.max(1, Math.floor(query.bucketMs / 1000));
  const result = await db.execute<BulkRow>(sql`
    SELECT actor_user_id::text AS actor,
           to_char(to_timestamp(floor(extract(epoch FROM created_at) / ${bucketSeconds}) * ${bucketSeconds}) AT TIME ZONE 'UTC', ${sql.raw(`'${ISO_UTC_MS}'`)}) AS bucket_start,
           count(DISTINCT (resource_kind, resource_id))::int AS distinct_records,
           ${isoOf("min(created_at)")} AS first_at,
           ${isoOf("max(created_at)")} AS last_at,
           (array_agg(id::text ORDER BY created_at, id))[1:5] AS sample_ids
      FROM audit_event
     WHERE ${orgIs(scope.organizationId)}
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

/**
 * A run writes its row at the end of the transaction it started, with `windowTo` taken at its start, so `windowTo` is never more
 * than a delivery budget (30 s) plus clock skew behind the row's own `created_at` — and never after it. This is the slack allowed
 * before a `windowTo` that claims otherwise is treated as forged or corrupt.
 */
const CURSOR_SLACK_MS = 10 * 60_000;

/**
 * Where the previous review of this scope got to: the `windowTo` of its newest run that finished clean (`status: ok`), or null on the
 * first run. The review's state lives in audit rows that any writer of the audit trail could append, so the cursor is bounded by
 * what a real run could have written: rows stamped in the future are ignored, and `windowTo` is clamped to a few minutes past the
 * row's own `created_at`. A forged "reviewed up to next week" row therefore cannot blind the review (a forged "reviewed up to just
 * now" row still can skip the gap before it: that needs a writer of the audit trail, and is a stated limit).
 */
export async function readReviewCursor(
  db: ReviewSqlExecutor,
  scope: ReviewScope,
): Promise<Date | null> {
  type CursorRow = { window_to: string; row_at: string } & Record<string, unknown>;
  const result =
    scope.organizationId === null
      ? await db.execute<CursorRow>(sql`
          SELECT window_to, ${isoOf("row_at")} AS row_at FROM public.m4_review_platform_cursor()
        `)
      : await db.execute<CursorRow>(sql`
          SELECT context->>'windowTo' AS window_to,
                 ${isoOf("created_at")} AS row_at
            FROM audit_event
           WHERE ${orgIs(scope.organizationId)}
             AND event_type = ${SECURITY_REVIEW_COMPLETED_EVENT}
             AND context->>'status' = 'ok'
             AND created_at <= now()
           ORDER BY created_at DESC, id DESC
           LIMIT 1
        `);
  const row = result.rows[0];
  if (row === undefined) return null;
  const windowTo = Date.parse(row.window_to);
  const rowAt = Date.parse(row.row_at);
  if (Number.isNaN(windowTo) || Number.isNaN(rowAt)) return null;
  return new Date(Math.min(windowTo, rowAt + CURSOR_SLACK_MS));
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
  const result =
    scope.organizationId === null
      ? await db.execute<RaisedRow>(sql`
          SELECT fingerprint, rule_id, subject_kind, subject_ref, window_to
            FROM public.m4_review_platform_raised_alerts(
                   ${since.toISOString()}::timestamptz,
                   ARRAY[${inList(TERMINAL_DELIVERY_STATUSES)}]::text[])
        `)
      : await db.execute<RaisedRow>(sql`
          SELECT context->>'fingerprint' AS fingerprint,
                 context->>'ruleId' AS rule_id,
                 context->'subject'->>'kind' AS subject_kind,
                 context->'subject'->>'ref' AS subject_ref,
                 context->>'windowTo' AS window_to
            FROM audit_event
           WHERE ${orgIs(scope.organizationId)}
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
