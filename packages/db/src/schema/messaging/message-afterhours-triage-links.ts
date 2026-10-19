// M36 WP 4.13 slice S1 (ADR-0082 decision 7) - the link between an after-hours send and the M19 triage call it asked for. See migration
// 1130: org RLS (FORCEd), a UNIQUE message and source event, an update guard that lets only triage_call_id and outcome move, once.
// Ids, one closed outcome and instants only. No FK to M19 (M36 never references M19 tables) and none to the purged outbox row.
import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { messageAckRequests } from "./message-acknowledgments";

export const messageAfterhoursTriageLinks = pgTable(
  "message_afterhours_triage_link",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    messageId: uuid("message_id").notNull(),
    requestId: uuid("request_id").notNull(),
    sourceOutboxEventId: uuid("source_outbox_event_id").notNull(),
    triageCallId: uuid("triage_call_id"),
    /** 'opened' | 'coalesced' | 'no_coverage' (AFTERHOURS_TRIAGE_OUTCOMES in @wardenx/types); NULL until M19 replies. */
    outcome: text("outcome"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    messageUq: unique("message_afterhours_triage_link_message_uq").on(t.messageId),
    eventUq: unique("message_afterhours_triage_link_event_uq").on(t.sourceOutboxEventId),
    byRequest: index("message_afterhours_triage_link_org_request_idx").on(
      t.organizationId,
      t.requestId,
    ),
    requestFk: foreignKey({
      name: "message_afterhours_triage_link_request_fk",
      columns: [t.organizationId, t.requestId],
      foreignColumns: [messageAckRequests.organizationId, messageAckRequests.id],
    }).onDelete("cascade"),
    outcomeCheck: check(
      "message_afterhours_triage_link_outcome",
      sql`${t.outcome} IS NULL OR ${t.outcome} IN ('opened', 'coalesced', 'no_coverage')`,
    ),
    callCheck: check(
      "message_afterhours_triage_link_call",
      sql`(${t.outcome} IS NULL AND ${t.triageCallId} IS NULL) OR (${t.outcome} IN ('opened', 'coalesced') AND ${t.triageCallId} IS NOT NULL) OR (${t.outcome} = 'no_coverage' AND ${t.triageCallId} IS NULL)`,
    ),
  }),
);

export type MessageAfterhoursTriageLink = typeof messageAfterhoursTriageLinks.$inferSelect;
export type NewMessageAfterhoursTriageLink = typeof messageAfterhoursTriageLinks.$inferInsert;
