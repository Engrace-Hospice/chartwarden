// apps/backend/src/modules/36-messaging/snooze-reminders/snooze-reminder-store-db.ts - WP 4.10 (ADR-0077): the Drizzle stores.
// Every statement runs under withOrgContext with the CALLER as the context user, so RLS (migration 1125) pins rows to organisation AND
// owner, and each query also names the owner. The sweep's store lists due rows through the narrow SECURITY DEFINER lister
// (`message_reminder_due`) and acts on each row under its owner's context.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ACK_OPEN_STATUSES } from "@chartwarden/types";
import { and, asc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Tx } from "../messaging-write-core";
import type { Actor, ReminderRow, SnoozeReminderStore } from "./snooze-reminder-service";

const SN = schema.messageSnoozes;
const RM = schema.messageReminders;
const ACK = schema.messageAckRequests;
const MSG = schema.messages;

const OPEN = [...ACK_OPEN_STATUSES];
/** Most rows one list returns (the per-user cap is far below it). */
const LIST_LIMIT = 100;

/** A Postgres error (or one wrapped by the driver) that carries SQLSTATE 23514 and the trigger's marker text. */
export function isTriggerRefusal(err: unknown, marker: string): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const e = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (e.code === "23514" && typeof e.message === "string" && e.message.includes(marker)) {
      return true;
    }
    current = e.cause;
  }
  return false;
}

const asRow = (r: typeof RM.$inferSelect): ReminderRow => ({
  id: r.id,
  channelId: r.channelId,
  messageId: r.messageId,
  remindAt: r.remindAt,
});

export function createDbSnoozeReminderStore(db: DbClient): SnoozeReminderStore {
  const ctx = (a: Actor) => ({ organizationId: a.orgId, userId: a.userId });

  const openRequestIn = async (tx: Tx, a: Actor, channelId: string) => {
    const [row] = await tx
      .select({ id: ACK.id })
      .from(ACK)
      .where(
        and(
          eq(ACK.organizationId, a.orgId),
          eq(ACK.channelId, channelId),
          inArray(ACK.status, OPEN),
          or(eq(ACK.assignedUserId, a.userId), eq(ACK.requesterUserId, a.userId)),
        ),
      )
      .limit(1);
    return row !== undefined;
  };

  return {
    activeSnooze: (a, channelId, at) =>
      withOrgContext(db, ctx(a), async (tx) => {
        const [row] = await tx
          .select({ until: SN.snoozedUntil })
          .from(SN)
          .where(
            and(
              eq(SN.organizationId, a.orgId),
              eq(SN.userId, a.userId),
              eq(SN.channelId, channelId),
              gt(SN.snoozedUntil, at),
            ),
          )
          .limit(1);
        return row?.until ?? null;
      }),

    hasOpenRequest: (a, channelId) =>
      withOrgContext(db, ctx(a), (tx) => openRequestIn(tx, a, channelId)),

    setSnooze: (a, channelId, window) =>
      withOrgContext(db, ctx(a), async (tx) => {
        if (await openRequestIn(tx, a, channelId)) return "blocked" as const;
        try {
          // A savepoint, so a trigger refusal (a request opened since the check) leaves the transaction usable.
          await tx.transaction((inner) =>
            inner
              .insert(SN)
              .values({
                organizationId: a.orgId,
                userId: a.userId,
                channelId,
                snoozedAt: window.at,
                snoozedUntil: window.until,
              })
              .onConflictDoUpdate({
                target: [SN.organizationId, SN.userId, SN.channelId],
                set: { snoozedAt: window.at, snoozedUntil: window.until, updatedAt: window.at },
              }),
          );
        } catch (err) {
          if (isTriggerRefusal(err, "message_snooze_urgent")) return "blocked" as const;
          throw err;
        }
        return "ok" as const;
      }),

    clearSnooze: (a, channelId) =>
      withOrgContext(db, ctx(a), async (tx) => {
        const removed = await tx
          .delete(SN)
          .where(
            and(
              eq(SN.organizationId, a.orgId),
              eq(SN.userId, a.userId),
              eq(SN.channelId, channelId),
            ),
          )
          .returning({ id: SN.id });
        return removed.length > 0;
      }),

    messageFacts: (a, messageId) =>
      withOrgContext(db, ctx(a), async (tx) => {
        const [row] = await tx
          .select({ channelId: MSG.channelId })
          .from(MSG)
          .where(
            and(
              eq(MSG.organizationId, a.orgId),
              eq(MSG.id, messageId),
              isNull(MSG.deletedAt),
              ne(MSG.status, "deleted"),
            ),
          )
          .limit(1);
        return row ?? null;
      }),

    setReminder: (a, input) =>
      withOrgContext(db, ctx(a), async (tx) => {
        const [msg] = await tx
          .select({ urgency: MSG.urgency })
          .from(MSG)
          .where(and(eq(MSG.organizationId, a.orgId), eq(MSG.id, input.messageId)))
          .limit(1);
        if (!msg || msg.urgency !== "routine") return { outcome: "urgent" as const };
        const [open] = await tx
          .select({ id: ACK.id })
          .from(ACK)
          .where(
            and(
              eq(ACK.organizationId, a.orgId),
              eq(ACK.messageId, input.messageId),
              inArray(ACK.status, OPEN),
            ),
          )
          .limit(1);
        if (open) return { outcome: "urgent" as const };
        // Serialise this user's sets so the cap cannot be raced past, then count (this user only: RLS).
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`reminder:${a.orgId}:${a.userId}`}, 36))`,
        );
        const [{ n }] = (await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(RM)
          .where(
            and(
              eq(RM.organizationId, a.orgId),
              eq(RM.userId, a.userId),
              ne(RM.messageId, input.messageId),
            ),
          )) as [{ n: number }];
        if (Number(n) >= input.max) return { outcome: "limit" as const };
        try {
          const [row] = await tx.transaction((inner) =>
            inner
              .insert(RM)
              .values({
                organizationId: a.orgId,
                userId: a.userId,
                channelId: input.channelId,
                messageId: input.messageId,
                setAt: input.at,
                remindAt: input.remindAt,
              })
              .onConflictDoUpdate({
                target: [RM.organizationId, RM.userId, RM.messageId],
                set: { setAt: input.at, remindAt: input.remindAt, updatedAt: input.at },
              })
              .returning(),
          );
          return { outcome: "ok" as const, reminder: asRow(row as typeof RM.$inferSelect) };
        } catch (err) {
          if (isTriggerRefusal(err, "message_reminder_urgent"))
            return { outcome: "urgent" as const };
          throw err;
        }
      }),

    clearReminder: (a, messageId) =>
      withOrgContext(db, ctx(a), async (tx) => {
        const removed = await tx
          .delete(RM)
          .where(
            and(
              eq(RM.organizationId, a.orgId),
              eq(RM.userId, a.userId),
              eq(RM.messageId, messageId),
            ),
          )
          .returning({ id: RM.id });
        return removed.length > 0;
      }),

    listReminders: (a) =>
      withOrgContext(db, ctx(a), async (tx) => {
        const rows = await tx
          .select()
          .from(RM)
          .where(and(eq(RM.organizationId, a.orgId), eq(RM.userId, a.userId)))
          .orderBy(asc(RM.remindAt), asc(RM.id))
          .limit(LIST_LIMIT);
        return rows.map(asRow);
      }),
  };
}

export interface DueReminder extends ReminderRow {
  readonly userId: string;
}

/** What the reminder sweep needs; the sweep itself (reminder-sweep.ts) is pure over this. */
export interface ReminderSweepStore {
  /** Due rows of one organisation, oldest first, ids and instants only. */
  listDue(orgId: string, limit: number, offset?: number): Promise<readonly DueReminder[]>;
  /** Is the message still there (not deleted) and in the same channel? */
  messageLive(orgId: string, row: DueReminder): Promise<boolean>;
  /** Delete one reminder under its owner's context. */
  remove(orgId: string, row: DueReminder): Promise<void>;
}

type DueSqlRow = {
  id: string;
  user_id: string;
  channel_id: string;
  message_id: string;
  remind_at: Date | string;
};

export function createDbReminderSweepStore(db: DbClient): ReminderSweepStore {
  return {
    listDue: (orgId, limit, offset = 0) =>
      withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const result = await tx.execute<DueSqlRow>(
          sql`SELECT * FROM message_reminder_due(${orgId}, ${limit}, ${offset})`,
        );
        return result.rows.map((r) => ({
          id: r.id,
          userId: r.user_id,
          channelId: r.channel_id,
          messageId: r.message_id,
          remindAt: new Date(r.remind_at),
        }));
      }),

    messageLive: (orgId, row) =>
      withOrgContext(db, { organizationId: orgId, userId: row.userId }, async (tx) => {
        const [m] = await tx
          .select({ id: MSG.id })
          .from(MSG)
          .where(
            and(
              eq(MSG.organizationId, orgId),
              eq(MSG.channelId, row.channelId),
              eq(MSG.id, row.messageId),
              isNull(MSG.deletedAt),
              ne(MSG.status, "deleted"),
            ),
          )
          .limit(1);
        return m !== undefined;
      }),

    remove: (orgId, row) =>
      withOrgContext(db, { organizationId: orgId, userId: row.userId }, async (tx) => {
        await tx
          .delete(RM)
          .where(and(eq(RM.organizationId, orgId), eq(RM.userId, row.userId), eq(RM.id, row.id)));
      }),
  };
}
