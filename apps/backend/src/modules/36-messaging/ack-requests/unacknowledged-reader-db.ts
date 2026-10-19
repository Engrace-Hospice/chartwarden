// apps/backend/src/modules/36-messaging/ack-requests/unacknowledged-reader-db.ts - WP 4.9 (ADR-0076): the SQL half of the supervisor's
// unacknowledged queue. Read-only, as the signed-in user inside their organisation (RLS on app.org_id; every statement also names the
// organisation). It lists EVERY request that still waits for a human (`pending`, `escalated`, `failed_unreachable`) in deadline order,
// oldest deadline first, so what is overdue longest is first. The two filters (status, overdue) only narrow; there is no other.
//
// Paging is keyset on (deadline_at, tie) where `tie` is the SHA-256 of the request id: unique in practice, stable, and the cursor never
// carries a request id (a restricted row's id must not leave the server, not even inside an opaque cursor). The counts are computed
// without the page limit and without the cursor, so the page can always be checked against them.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import {
  ACK_QUEUE_STATUSES,
  type AckEscalationNote,
  type AckQueueCounts,
  type AckQueueStatus,
  WardenXError,
} from "@wardenx/types";
import { and, asc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import type { AckRow } from "./ack-types";

const R = schema.messageAckRequests;
const E = schema.messageAckEvents;

const TIE = sql<string>`encode(sha256(convert_to(${R.id}::text, 'UTF8')), 'hex')`;

export interface QueueQuery {
  readonly status: AckQueueStatus | null;
  readonly overdueOnly: boolean;
  readonly cursor: string | null;
  readonly limit: number;
  readonly now: Date;
}

export interface QueueRow {
  readonly row: AckRow;
  readonly note: AckEscalationNote | null;
}

export interface QueuePage {
  readonly rows: readonly QueueRow[];
  readonly nextCursor: string | null;
  readonly counts: AckQueueCounts;
}

export type UnacknowledgedReader = (
  orgId: string,
  userId: string,
  query: QueueQuery,
) => Promise<QueuePage>;

const CURSOR_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:?\d{2})?$/;
const CURSOR_TIE = /^[0-9a-f]{64}$/;
const invalidCursor = (): WardenXError =>
  new WardenXError("INVALID_CURSOR", "the cursor is not valid", 400);

export function encodeQueueCursor(deadlineAtText: string, tie: string): string {
  return Buffer.from(`${deadlineAtText}|${tie}`, "utf8").toString("base64url");
}

/** Anything this service did not issue is the caller's mistake: a 400, never a cast error and never a silent first page. */
export function decodeQueueCursor(cursor: string): { deadlineAt: string; tie: string } {
  const parts = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const [deadlineAt, tie] = parts;
  if (
    parts.length !== 2 ||
    !deadlineAt ||
    !tie ||
    !CURSOR_TIME.test(deadlineAt) ||
    !CURSOR_TIE.test(tie)
  ) {
    throw invalidCursor();
  }
  return { deadlineAt, tie };
}

const toRow = (r: typeof R.$inferSelect): AckRow => ({
  id: r.id,
  organizationId: r.organizationId,
  messageId: r.messageId,
  channelId: r.channelId,
  patientId: r.patientId,
  ackClass: r.ackClass,
  status: r.status,
  requesterUserId: r.requesterUserId,
  assignedUserId: r.assignedUserId,
  requestedAt: r.requestedAt,
  windowStartedAt: r.windowStartedAt,
  deadlineAt: r.deadlineAt,
  currentTier: r.currentTier,
  acknowledgedAt: r.acknowledgedAt,
  acknowledgedByUserId: r.acknowledgedByUserId,
  resolvedAt: r.resolvedAt,
  resolvedByUserId: r.resolvedByUserId,
  cancelledAt: r.cancelledAt,
  version: r.version,
});

/** The escalation note of each overdue waiting request: the newest unroutable record written inside its CURRENT window (as ack-escalation-note.ts). */
async function notesFor(
  db: DbClient,
  orgId: string,
  userId: string,
  rows: readonly AckRow[],
  now: Date,
): Promise<ReadonlyMap<string, AckEscalationNote>> {
  if (rows.length === 0) return new Map();
  const overdue = rows.filter(
    (r) => r.status !== "failed_unreachable" && r.deadlineAt.getTime() <= now.getTime(),
  );
  if (overdue.length === 0) return new Map();
  return withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
    const rowsOut = await tx
      .select({
        requestId: E.requestId,
        eventType: E.eventType,
        createdAt: E.createdAt,
      })
      .from(E)
      .where(
        and(
          eq(E.organizationId, orgId),
          inArray(
            E.requestId,
            overdue.map((r) => r.id),
          ),
          inArray(E.eventType, ["route_unavailable", "ladder_exhausted"]),
        ),
      )
      .orderBy(asc(E.createdAt));
    const windowStart = new Map(overdue.map((r) => [r.id, r.windowStartedAt.getTime()]));
    const notes = new Map<string, AckEscalationNote>();
    // Newest record inside the CURRENT window wins (rows are oldest first, so the last write per request is the newest).
    for (const e of rowsOut) {
      if (e.createdAt.getTime() < (windowStart.get(e.requestId) ?? 0)) continue;
      notes.set(e.requestId, e.eventType as AckEscalationNote);
    }
    return notes;
  });
}

export function createDbUnacknowledgedReader(db: DbClient): UnacknowledgedReader {
  return async (orgId, userId, q) => {
    const keyset = q.cursor ? decodeQueueCursor(q.cursor) : null;
    const nowIso = q.now.toISOString();
    const filters = [
      eq(R.organizationId, orgId),
      inArray(R.status, [...ACK_QUEUE_STATUSES]),
      ...(q.status ? [eq(R.status, q.status)] : []),
      ...(q.overdueOnly ? [lte(R.deadlineAt, q.now)] : []),
    ];
    const page = await withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
      const [counts] = await tx
        .select({
          unfiltered: sql<number>`count(*)::int`,
          matching: sql<number>`(count(*) FILTER (WHERE ${and(...filters)}))::int`,
          overdue: sql<number>`(count(*) FILTER (WHERE ${R.deadlineAt} <= ${nowIso}::timestamptz))::int`,
          failed: sql<number>`(count(*) FILTER (WHERE ${R.status} = 'failed_unreachable'))::int`,
        })
        .from(R)
        .where(and(eq(R.organizationId, orgId), inArray(R.status, [...ACK_QUEUE_STATUSES])));
      const rows = await tx
        .select({ r: R, deadlineText: sql<string>`${R.deadlineAt}::text`, tie: TIE })
        .from(R)
        .where(
          and(
            ...filters,
            ...(keyset
              ? [
                  or(
                    gt(R.deadlineAt, sql`${keyset.deadlineAt}::timestamptz`),
                    and(
                      eq(R.deadlineAt, sql`${keyset.deadlineAt}::timestamptz`),
                      sql`${TIE} > ${keyset.tie}`,
                    ),
                  ),
                ]
              : []),
          ),
        )
        .orderBy(asc(R.deadlineAt), asc(TIE))
        .limit(q.limit + 1);
      return { counts, rows };
    });
    const more = page.rows.length > q.limit;
    const window = page.rows.slice(0, q.limit);
    const last = window[window.length - 1];
    const rows = window.map((w) => toRow(w.r));
    const notes = await notesFor(db, orgId, userId, rows, q.now);
    return {
      rows: rows.map((row) => ({ row, note: notes.get(row.id) ?? null })),
      nextCursor: more && last ? encodeQueueCursor(last.deadlineText, last.tie) : null,
      counts: {
        unfiltered: page.counts?.unfiltered ?? 0,
        matching: page.counts?.matching ?? 0,
        overdue: page.counts?.overdue ?? 0,
        failed_unreachable: page.counts?.failed ?? 0,
      },
    };
  };
}
