import { randomUUID } from "node:crypto";
// apps/backend/src/modules/36-messaging/jobs/integrity-sampling.ts — WP 1.9: WHICH rows the nightly
// `messaging.hash_verify` run verifies for one org. Three bounded passes per table (message heads, revisions):
//
//   1. ROTATION   — the next `limit` rows in (created_at, id) order after the previous run's cursor, wrapping to the
//                   start when exhausted. Guarantees every row is verified once per ceil(rows / limit) runs.
//   2. RECENT     — rows created since the previous run started (minus an overlap), oldest first, bounded by `limit`.
//                   An edit inserts a `message_revision` row, so edits are covered too.
//   3. RANDOM     — `randomSize` rows by primary key from a random pivot (wrapping), which nobody can aim at.
//
// Worst-case latency for a tamper of an OLD row sitting just behind the rotation cursor is ceil(rows / limit) nights
// (e.g. 100k rows at 5000 per run = 20 nights); the random pass shortens the expected latency (each night it covers
// randomSize / rows of the table) but gives no guarantee. A NEW row (or edit) is verified on the next run unless more
// than `limit` rows arrived in between (`recentOverflow` in the run row) or its created_at precedes the overlap
// window (a transaction that stayed open longer than HASH_VERIFY_RECENT_OVERLAP_MS before committing: created_at is
// the transaction's start). Those fall back to the rotation and the random pass.
//
// The rotation cursor lives in the previous `m36.hash_verify.run` audit row (no table): read through the audit query
// helper as `wardenx_app`, validated strictly, and a missing or malformed cursor RESTARTS the rotation and says so.
import { createDbAuditQuery } from "@wardenx/audit";
import { type DbClient, schema } from "@wardenx/db";
import type { HashVerifySampleRow } from "@wardenx/messaging";
import { type SQL, and, asc, eq, sql } from "drizzle-orm";

type Db = DbClient;
const MSG = schema.messages;
const REV = schema.messageRevisions;

/** Rows verified per table per org per run, for each of the rotation and recent passes. */
export const HASH_VERIFY_SAMPLE_LIMIT = 5000;
/** Rows in the random page per table per run. */
export const HASH_VERIFY_RANDOM_SAMPLE_SIZE = 500;
/** The recent pass reaches this far before the previous run's start (covers commits that landed during that run). */
export const HASH_VERIFY_RECENT_OVERLAP_MS = 60 * 60 * 1000;
/** The audit event the cursor is read back from. */
export const HASH_VERIFY_RUN_EVENT = "m36.hash_verify.run";
/** Latest run rows scanned for the newest system-actor one (bounded; forged rows beyond it cannot hide the cursor cheaply). */
export const PREVIOUS_RUN_SCAN_LIMIT = 50;

export interface RowMeta {
  readonly cipherBytes: Buffer;
  readonly storedHash: string;
  readonly resourceKind: "message" | "message_revision";
  readonly resourceId: string;
  readonly revisionNo?: number;
}

/** Position in one table's (created_at, id) order; `createdAt` is Postgres' own text form (keeps microseconds). */
export interface RotationCursor {
  readonly createdAt: string;
  readonly id: string;
}

/** Where the next run resumes, per table; `null` = start from the beginning. */
export interface RotationCursors {
  readonly heads: RotationCursor | null;
  readonly revisions: RotationCursor | null;
}

export type CursorResetReason = "malformed_cursor" | "previous_run_without_cursor";

export interface PreviousRun {
  readonly cursors: RotationCursors;
  /** When the previous run started (its `detectedAt`); null when there was none or it is unreadable. */
  readonly startedAt: Date | null;
  /** Set when a previous run row exists but its cursor could not be used (the rotation restarted). */
  readonly cursorReset: CursorResetReason | null;
  /** Non-system `m36.hash_verify.run` rows seen among the latest {@link PREVIOUS_RUN_SCAN_LIMIT}: ignored, but reported. */
  readonly ignoredNonSystemRuns: number;
}

export interface SampleOptions {
  readonly limit: number;
  readonly randomSize: number;
  readonly recentOverlapMs: number;
}

export interface PassCounts {
  readonly rotation: number;
  readonly recent: number;
  readonly random: number;
}

export interface SampledRows {
  readonly rows: HashVerifySampleRow[];
  readonly meta: WeakMap<HashVerifySampleRow, RowMeta>;
  readonly cursorEnd: RotationCursors;
  readonly passCounts: PassCounts;
  /** More rows were created since the previous run than the recent pass may read. */
  readonly recentOverflow: boolean;
  /** Lower bound used by the recent pass (ISO), or null when it did not run. */
  readonly recentSince: string | null;
}

const FROM_START: RotationCursors = { heads: null, revisions: null };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Postgres `timestamptz::text`: "2026-10-12 19:00:37.779123+00" (T separator and Z tolerated).
const TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)$/;

const MALFORMED = Symbol("malformed");

/** `2026-10-12 19:00:37.779123+00` is not ISO-8601 for `Date.parse`: use `T` and a full `+hh:mm` offset. */
function isoOf(pgTimestamp: string): string {
  return pgTimestamp.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
}

/**
 * True for a timestamp Postgres will also accept. `Date.parse` alone lets "2026-02-31" through (it rolls over), and
 * the `::timestamptz` cast would then fail every night, so the calendar fields must survive a round trip.
 */
function isRealTimestamp(text: string): boolean {
  const m = TIMESTAMP_RE.exec(text);
  if (!m || Number.isNaN(Date.parse(isoOf(text)))) return false;
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const probe = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === mo - 1 &&
    probe.getUTCDate() === d &&
    probe.getUTCHours() === h &&
    probe.getUTCMinutes() === mi &&
    probe.getUTCSeconds() === sec
  );
}

function parseCursor(raw: unknown): RotationCursor | null | typeof MALFORMED {
  if (raw === null) return null;
  if (typeof raw !== "object" || raw === undefined) return MALFORMED;
  const { createdAt, id } = raw as Record<string, unknown>;
  if (typeof createdAt !== "string" || typeof id !== "string") return MALFORMED;
  if (!isRealTimestamp(createdAt)) return MALFORMED;
  return UUID_RE.test(id) ? { createdAt, id } : MALFORMED;
}

/** The previous run's start, clamped to `now`: a future-dated value must not switch the recent pass off. */
function parseStartedAt(raw: unknown, now: Date): Date | null {
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(Math.min(ms, now.getTime()));
}

/**
 * The previous run's end cursors and start time, from its `m36.hash_verify.run` audit row (a plain org-scoped SELECT
 * as `wardenx_app` through the audit query helper; reads write no audit row). Only the system actor's rows count.
 * No row at all is a first run; a row whose cursor is unusable restarts the rotation and reports why.
 */
export async function readPreviousRun(db: Db, orgId: string, now: Date): Promise<PreviousRun> {
  const page = await createDbAuditQuery(db).searchEvents(orgId, {
    eventType: HASH_VERIFY_RUN_EVENT,
    limit: PREVIOUS_RUN_SCAN_LIMIT,
  });
  const row = page.items.find((r) => r.actorKind === "system");
  const ignoredNonSystemRuns = page.items.filter((r) => r.actorKind !== "system").length;
  if (!row) {
    return { cursors: FROM_START, startedAt: null, cursorReset: null, ignoredNonSystemRuns };
  }
  const startedAt = parseStartedAt(row.context.detectedAt, now);
  const end = row.context.cursorEnd;
  if (!end || typeof end !== "object") {
    return {
      cursors: FROM_START,
      startedAt,
      cursorReset: "previous_run_without_cursor",
      ignoredNonSystemRuns,
    };
  }
  const { heads, revisions } = end as Record<string, unknown>;
  const parsedHeads = parseCursor(heads);
  const parsedRevisions = parseCursor(revisions);
  if (parsedHeads === MALFORMED || parsedRevisions === MALFORMED) {
    return {
      cursors: FROM_START,
      startedAt,
      cursorReset: "malformed_cursor",
      ignoredNonSystemRuns,
    };
  }
  return {
    cursors: { heads: parsedHeads, revisions: parsedRevisions },
    startedAt,
    cursorReset: null,
    ignoredNonSystemRuns,
  };
}

/** Keep `limit` rows; when the lookahead row proved more exist, resume after the last kept one, else wrap. */
function pageOf<T extends { readonly id: string; readonly createdAtText: string }>(
  fetched: readonly T[],
  limit: number,
): { page: readonly T[]; end: RotationCursor | null } {
  if (fetched.length <= limit) return { page: fetched, end: null };
  const page = fetched.slice(0, limit);
  const last = page[page.length - 1] as T;
  return { page, end: { createdAt: last.createdAtText, id: last.id } };
}

function pastCursor(createdAt: SQL, id: SQL, cursor: RotationCursor | null): SQL | undefined {
  return cursor
    ? sql`(${createdAt}, ${id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
    : undefined;
}

const headColumns = {
  id: MSG.id,
  createdAtText: sql<string>`${MSG.createdAt}::text`,
  channelId: MSG.channelId,
  bodyCipher: MSG.bodyCipher,
  bodySha256: MSG.bodySha256,
};
const revisionColumns = {
  id: REV.id,
  createdAtText: sql<string>`${REV.createdAt}::text`,
  messageId: REV.messageId,
  revisionNo: REV.revisionNo,
  channelId: MSG.channelId,
  bodyCipher: REV.bodyCipher,
  bodySha256: REV.bodySha256,
};

type HeadRow = {
  id: string;
  createdAtText: string;
  channelId: string;
  bodyCipher: Buffer;
  bodySha256: string;
};
type RevisionRow = HeadRow & { messageId: string; revisionNo: number };

/** One table's rows by the three passes, deduplicated (rotation first, then recent, then random). */
interface TableSample<T> {
  readonly rows: T[];
  readonly end: RotationCursor | null;
  readonly counts: PassCounts;
  readonly recentOverflow: boolean;
}

interface TableQueries<T extends HeadRow> {
  page(opts: { where: SQL | undefined; order: "created" | "id"; limit: number }): Promise<T[]>;
  orgId: string;
}

async function sampleTable<T extends HeadRow>(
  q: TableQueries<T>,
  col: { createdAt: SQL; id: SQL },
  from: RotationCursor | null,
  recentSince: Date | null,
  opts: SampleOptions,
): Promise<TableSample<T>> {
  const rotation = pageOf(
    await q.page({
      where: pastCursor(col.createdAt, col.id, from),
      order: "created",
      limit: opts.limit + 1,
    }),
    opts.limit,
  );
  const seen = new Set(rotation.page.map((r) => r.id));
  const rows = [...rotation.page];

  const recentFetched = recentSince
    ? await q.page({
        where: sql`${col.createdAt} > ${recentSince.toISOString()}::timestamptz`,
        order: "created",
        limit: opts.limit + 1,
      })
    : [];
  const recent = recentFetched.slice(0, opts.limit).filter((r) => !seen.has(r.id));
  for (const r of recent) seen.add(r.id);
  rows.push(...recent);

  const pivot = randomUUID();
  const upper = await q.page({
    where: sql`${col.id} >= ${pivot}::uuid`,
    order: "id",
    limit: opts.randomSize,
  });
  const wrapped =
    upper.length < opts.randomSize
      ? await q.page({
          where: sql`${col.id} < ${pivot}::uuid`,
          order: "id",
          limit: opts.randomSize - upper.length,
        })
      : [];
  const random = [...upper, ...wrapped].filter((r) => !seen.has(r.id));
  rows.push(...random);

  return {
    rows,
    end: rotation.end,
    counts: { rotation: rotation.page.length, recent: recent.length, random: random.length },
    recentOverflow: recentFetched.length > opts.limit,
  };
}

/** The rows to verify for one org (inside its RLS context) and where the rotation ended. */
export async function sampleRows(
  db: Db,
  orgId: string,
  previous: PreviousRun,
  opts: SampleOptions,
): Promise<SampledRows> {
  const recentSince = previous.startedAt
    ? new Date(previous.startedAt.getTime() - opts.recentOverlapMs)
    : null;
  const ordering = (order: "created" | "id", created: SQL, id: SQL) =>
    order === "created" ? [asc(created), asc(id)] : [asc(id)];

  const heads = await sampleTable<HeadRow>(
    {
      orgId,
      page: ({ where, order, limit }) =>
        db
          .select(headColumns)
          .from(MSG)
          .where(and(eq(MSG.organizationId, orgId), where))
          .orderBy(...ordering(order, sql`${MSG.createdAt}`, sql`${MSG.id}`))
          .limit(limit) as unknown as Promise<HeadRow[]>,
    },
    { createdAt: sql`${MSG.createdAt}`, id: sql`${MSG.id}` },
    previous.cursors.heads,
    recentSince,
    opts,
  );
  const revisions = await sampleTable<RevisionRow>(
    {
      orgId,
      page: ({ where, order, limit }) =>
        db
          .select(revisionColumns)
          .from(REV)
          .innerJoin(
            MSG,
            and(eq(MSG.organizationId, REV.organizationId), eq(MSG.id, REV.messageId)),
          )
          .where(and(eq(REV.organizationId, orgId), where))
          .orderBy(...ordering(order, sql`${REV.createdAt}`, sql`${REV.id}`))
          .limit(limit) as unknown as Promise<RevisionRow[]>,
    },
    { createdAt: sql`${REV.createdAt}`, id: sql`${REV.id}` },
    previous.cursors.revisions,
    recentSince,
    opts,
  );

  const meta = new WeakMap<HashVerifySampleRow, RowMeta>();
  const rows: HashVerifySampleRow[] = [];
  // Integrity is checked for held rows too: a hold blocks destruction, it never excuses tampering.
  for (const h of heads.rows) {
    const row: HashVerifySampleRow = {
      messageId: h.id,
      channelId: h.channelId,
      organizationId: orgId,
      storedHash: h.bodySha256,
      legalHold: false,
    };
    meta.set(row, {
      cipherBytes: h.bodyCipher,
      storedHash: h.bodySha256,
      resourceKind: "message",
      resourceId: h.id,
    });
    rows.push(row);
  }
  for (const r of revisions.rows) {
    const row: HashVerifySampleRow = {
      messageId: r.messageId,
      channelId: r.channelId,
      organizationId: orgId,
      storedHash: r.bodySha256,
      legalHold: false,
    };
    meta.set(row, {
      cipherBytes: r.bodyCipher,
      storedHash: r.bodySha256,
      resourceKind: "message_revision",
      resourceId: r.id,
      revisionNo: r.revisionNo,
    });
    rows.push(row);
  }
  return {
    rows,
    meta,
    cursorEnd: { heads: heads.end, revisions: revisions.end },
    passCounts: {
      rotation: heads.counts.rotation + revisions.counts.rotation,
      recent: heads.counts.recent + revisions.counts.recent,
      random: heads.counts.random + revisions.counts.random,
    },
    recentOverflow: heads.recentOverflow || revisions.recentOverflow,
    recentSince: recentSince ? recentSince.toISOString() : null,
  };
}
