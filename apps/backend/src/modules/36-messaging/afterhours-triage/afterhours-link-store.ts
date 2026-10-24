// apps/backend/src/modules/36-messaging/afterhours-triage/afterhours-link-store.ts - ADR-0082 slice S3: the only reader and writer of
// `message_afterhours_triage_link` (migration 1132). Ids, one closed outcome and instants only. The insert runs on the SEND transaction;
// the outcome write and the reads open their own org-scoped transaction. The table's update guard lets the reply move once.
import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import type { AfterHoursTriageOutcome } from "@chartwarden/types";
import { and, eq, inArray } from "drizzle-orm";

const LINK = schema.messageAfterhoursTriageLinks;
const MSG = schema.messages;

export interface NewAfterHoursLink {
  readonly orgId: string;
  readonly messageId: string;
  readonly requestId: string;
  readonly sourceOutboxEventId: string;
}

/**
 *  - applied    the outcome was recorded now.
 *  - converged  the same outcome was already recorded (a redelivery): nothing changed.
 *  - conflict   a DIFFERENT outcome is already recorded (the table keeps the first; this is surfaced, never overwritten).
 *  - unknown    no link row carries this source event id.
 */
export type RecordOutcomeResult = "applied" | "converged" | "conflict" | "unknown";

export interface AfterHoursLinkRow {
  readonly messageId: string;
  readonly outcome: AfterHoursTriageOutcome | null;
}

export interface AfterHoursLinkStore {
  /** Inside the send transaction; a failure fails the send whole. */
  insertInTx(tx: unknown, link: NewAfterHoursLink): Promise<void>;
  recordOutcome(
    orgId: string,
    sourceOutboxEventId: string,
    outcome: AfterHoursTriageOutcome,
    triageCallId: string | null,
  ): Promise<RecordOutcomeResult>;
  /** The links of these messages, ONLY those that belong to this channel (those that have none are absent). */
  findForChannel(
    orgId: string,
    channelId: string,
    messageIds: readonly string[],
  ): Promise<readonly AfterHoursLinkRow[]>;
}

type Tx = Pick<DbClient, "insert" | "update" | "select">;

export function createDbAfterHoursLinkStore(db: DbClient): AfterHoursLinkStore {
  return {
    async insertInTx(rawTx, link) {
      await (rawTx as Tx).insert(LINK).values({
        organizationId: link.orgId,
        messageId: link.messageId,
        requestId: link.requestId,
        sourceOutboxEventId: link.sourceOutboxEventId,
      });
    },

    async recordOutcome(orgId, sourceOutboxEventId, outcome, triageCallId) {
      return withOrgContext(db, systemOrgContext(orgId), async (rawTx) => {
        const tx = rawTx as unknown as Tx;
        const byEvent = and(
          eq(LINK.organizationId, orgId),
          eq(LINK.sourceOutboxEventId, sourceOutboxEventId),
        );
        const [row] = await tx.select({ outcome: LINK.outcome }).from(LINK).where(byEvent).limit(1);
        if (!row) return "unknown";
        if (row.outcome !== null) return row.outcome === outcome ? "converged" : "conflict";
        await tx.update(LINK).set({ outcome, triageCallId }).where(byEvent);
        return "applied";
      });
    },

    async findForChannel(orgId, channelId, messageIds) {
      if (messageIds.length === 0) return [];
      return withOrgContext(db, systemOrgContext(orgId), async (rawTx) => {
        const rows = await (rawTx as unknown as Tx)
          .select({ messageId: LINK.messageId, outcome: LINK.outcome })
          .from(LINK)
          .innerJoin(MSG, and(eq(MSG.organizationId, LINK.organizationId), eq(MSG.id, LINK.messageId)))
          .where(
            and(
              eq(LINK.organizationId, orgId),
              eq(MSG.channelId, channelId),
              inArray(LINK.messageId, [...messageIds]),
            ),
          );
        return rows.map((r) => ({
          messageId: r.messageId,
          outcome: (r.outcome as AfterHoursTriageOutcome | null) ?? null,
        }));
      });
    },
  };
}
