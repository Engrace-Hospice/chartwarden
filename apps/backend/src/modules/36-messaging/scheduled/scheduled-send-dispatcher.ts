// apps/backend/src/modules/36-messaging/scheduled/scheduled-send-dispatcher.ts — WP 2.6: the dispatch half of scheduled
// send. NOT a request: it runs from the `messaging.scheduled_send` sweep, so it never reads request context. The org is
// explicit (`dispatchDueForOrg`), the listing runs as the system actor, and each row is processed under its OWNER's
// context (RLS pins the row to org + owner).
//
// Per due row, the sender's right to send is re-decided NOW, not when the message was scheduled:
//   - messaging.send (and messaging.announce for the announcement channel) still held, via the M3 resolver;
//   - the sender can still see the channel (`canViewChannel`: active user, live membership, Part 2 gate) and, inside
//     the send transaction, is still an active member of it;
//   - the channel is not archived. M36 closes a patient's care-team channel when the patient is discharged or dies
//     (outbox-consumers/channel-membership-sync.ts), so an archived channel IS the patient-status signal; no M6/M5
//     table is read from here;
//   - a reply's root is still live.
// A failed re-check does NOT send: the row flips to `blocked` with a reason code and `m36.message.schedule_blocked` is
// published in the same transaction (the sender then gets one generic in-app notification). Otherwise the message goes
// through the same write core as a live send (`insertEncryptedMessage`) with client_message_id = the row id, and the row
// is deleted in the SAME transaction, so a crash, a retry or an overlapping tick can never send twice.
import { type DbClient, schema } from "@wardenx/db";
import {
  MAX_DISPATCH_ATTEMPTS,
  type ScheduleBlockReason,
  scheduleBlockReasonFor,
} from "@wardenx/messaging";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { publishMessageHint } from "../message-hint-events";
import type { MessagingOutboxPort } from "../messaging-route-service-db";
import {
  type MessageBodyCipher,
  type Tx,
  channelOr404,
  insertEncryptedMessage,
} from "../messaging-write-core";

const SM = schema.scheduledMessages;
const CM = schema.channelMembers;
const MSG = schema.messages;

export const SCHEDULE_BLOCKED_EVENT = "m36.message.schedule_blocked";
/** Due rows one org tick handles; the rest wait for the next minute. */
export const DISPATCH_BATCH_LIMIT = 100;

export interface ScheduledSendDispatcherDeps {
  readonly db: DbClient;
  readonly cipher: MessageBodyCipher;
  /** The real catalog-validating publisher; the block event and the sent-hint ride the dispatch transaction. */
  readonly outbox: MessagingOutboxPort;
  /** The route service's visibility rule (active user + live membership + Part 2 gate). */
  readonly canViewChannel: (orgId: string, userId: string, channelId: string) => Promise<boolean>;
  /** The sender's effective permission keys NOW (the M3 resolver at boot). */
  readonly permissionsFor: (orgId: string, userId: string) => Promise<ReadonlySet<string>>;
  /** Per-row failure sink (ids only, no body). */
  readonly onRowError?: (
    context: { organizationId: string; scheduledMessageId: string },
    error: unknown,
  ) => void;
}

export interface DispatchResult {
  readonly sent: number;
  readonly blocked: number;
  /** Unexpected errors counted against the row's attempts (the row stays pending until the limit). */
  readonly failed: number;
}

export interface ScheduledSendDispatcher {
  dispatchDueForOrg(orgId: string, opts?: { limit?: number }): Promise<DispatchResult>;
}

type RowOutcome = "sent" | "blocked" | "skipped";
interface DueRow {
  readonly id: string;
  readonly userId: string;
  readonly channelId: string;
}

export function createScheduledSendDispatcher(
  deps: ScheduledSendDispatcherDeps,
): ScheduledSendDispatcher {
  const { db, cipher, outbox } = deps;

  async function listDue(orgId: string, limit: number): Promise<DueRow[]> {
    // System actor, no owner: lists ids and owners only (never the cipher). Each row is then handled under its owner.
    return withOrgContext(db, systemOrgContext(orgId), (tx) =>
      tx
        .select({ id: SM.id, userId: SM.userId, channelId: SM.channelId })
        .from(SM)
        .where(
          and(
            eq(SM.organizationId, orgId),
            eq(SM.status, "pending"),
            sql`${SM.scheduledFor} <= now()`,
          ),
        )
        .orderBy(asc(SM.scheduledFor), asc(SM.id))
        .limit(limit),
    );
  }

  /** Flip a row to blocked and tell the sender (one event, same transaction). */
  async function block(
    tx: Tx,
    orgId: string,
    row: DueRow,
    reason: ScheduleBlockReason,
  ): Promise<void> {
    await tx
      .update(SM)
      .set({ status: "blocked", blockedReason: reason, updatedAt: new Date() })
      .where(and(eq(SM.organizationId, orgId), eq(SM.id, row.id)));
    await outbox.publish(tx, {
      eventName: SCHEDULE_BLOCKED_EVENT,
      organizationId: orgId,
      aggregateKind: "scheduled_message",
      aggregateId: row.id,
      payload: {
        organizationId: orgId,
        scheduledMessageId: row.id,
        channelId: row.channelId,
        senderUserId: row.userId,
        reason,
      },
    });
  }

  async function dispatchOne(orgId: string, row: DueRow): Promise<RowOutcome> {
    // Decisions that need other services come first, outside the transaction (they open their own).
    const permissions = await deps.permissionsFor(orgId, row.userId);
    const canView = await deps.canViewChannel(orgId, row.userId, row.channelId);
    return withOrgContext(db, { organizationId: orgId, userId: row.userId }, async (tx) => {
      // Claim: still ours, still pending, still due. A cancel/reschedule/other tick that got there first leaves nothing.
      const [claimed] = await tx
        .select()
        .from(SM)
        .where(
          and(
            eq(SM.organizationId, orgId),
            eq(SM.id, row.id),
            eq(SM.userId, row.userId),
            eq(SM.status, "pending"),
            sql`${SM.scheduledFor} <= now()`,
          ),
        )
        .limit(1)
        .for("update", { skipLocked: true });
      if (!claimed) return "skipped";

      const channel = await channelOr404(tx, orgId, claimed.channelId);
      const isAnnouncement = channel.kind === "announcement";
      // Closes the window between canViewChannel and now: the announcement channel has no member rows, every other
      // channel needs a live one.
      const [liveMember] = isAnnouncement
        ? [true]
        : await tx
            .select({ userId: CM.userId })
            .from(CM)
            .where(
              and(
                eq(CM.organizationId, orgId),
                eq(CM.channelId, claimed.channelId),
                eq(CM.userId, claimed.userId),
                isNull(CM.removedAt),
              ),
            )
            .limit(1);
      let reason = scheduleBlockReasonFor({
        member: canView && Boolean(liveMember),
        permission: permissions.has("messaging.send"),
        archived: channel.isArchived,
        announce: !isAnnouncement || permissions.has("messaging.announce"),
      });
      if (!reason && claimed.parentMessageId) {
        const [root] = await tx
          .select({ status: MSG.status })
          .from(MSG)
          .where(and(eq(MSG.organizationId, orgId), eq(MSG.id, claimed.parentMessageId)))
          .limit(1);
        if (!root || root.status === "deleted") reason = "parent_unavailable";
      }
      if (reason) {
        await block(tx, orgId, row, reason);
        return "blocked";
      }

      const sent = await insertEncryptedMessage(tx, cipher, {
        orgId,
        channelId: claimed.channelId,
        authorUserId: claimed.userId,
        body: cipher.open(orgId, claimed.bodyCipher),
        bodyKind: "plain",
        parentMessageId: claimed.parentMessageId,
        // The DB backstop: a send that already committed (row survived some other way) returns the original message.
        clientMessageId: claimed.id,
      });
      await tx.delete(SM).where(and(eq(SM.organizationId, orgId), eq(SM.id, claimed.id)));
      if (!sent.replayed) {
        await publishMessageHint(outbox, tx, "sent", {
          orgId,
          channelId: claimed.channelId,
          messageId: sent.messageId,
          parentMessageId: claimed.parentMessageId,
          at: sent.createdAt,
        });
      }
      return "sent";
    });
  }

  /** An unexpected error: count it, and after the limit stop retrying and tell the sender. */
  async function recordFailure(orgId: string, row: DueRow): Promise<"failed" | "blocked"> {
    return withOrgContext(db, { organizationId: orgId, userId: row.userId }, async (tx) => {
      const [bumped] = await tx
        .update(SM)
        .set({ attempts: sql`${SM.attempts} + 1`, updatedAt: new Date() })
        .where(and(eq(SM.organizationId, orgId), eq(SM.id, row.id), eq(SM.status, "pending")))
        .returning({ attempts: SM.attempts });
      if (!bumped || bumped.attempts < MAX_DISPATCH_ATTEMPTS) return "failed";
      await block(tx, orgId, row, "dispatch_failed");
      return "blocked";
    });
  }

  return {
    async dispatchDueForOrg(orgId, opts = {}) {
      const due = await listDue(orgId, opts.limit ?? DISPATCH_BATCH_LIMIT);
      let sent = 0;
      let blocked = 0;
      let failed = 0;
      for (const row of due) {
        try {
          const outcome = await dispatchOne(orgId, row);
          if (outcome === "sent") sent += 1;
          if (outcome === "blocked") blocked += 1;
        } catch (error) {
          deps.onRowError?.({ organizationId: orgId, scheduledMessageId: row.id }, error);
          // The failed transaction rolled back, so the row is untouched: count the failure in a fresh one.
          const outcome = await recordFailure(orgId, row);
          if (outcome === "blocked") blocked += 1;
          else failed += 1;
        }
      }
      return { sent, blocked, failed };
    },
  };
}
