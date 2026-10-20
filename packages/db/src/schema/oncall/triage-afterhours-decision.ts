// M19 WP 4.13 slice S2 (ADR-0082 decision 4) - the durable "this after-hours request was already decided" record, written in the
// SAME transaction as the decision and its `m19.afterhours_triage.outcome` event so a redelivery replays nothing. See migration 1133.
// Ids, one closed outcome and an instant only. No FK to `triage_call` (the call may be erased; the row carries ids only).
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const triageAfterhoursDecisions = pgTable(
  "triage_afterhours_decision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    sourceOutboxEventId: uuid("source_outbox_event_id").notNull(),
    triageCallId: uuid("triage_call_id"),
    /** 'opened' | 'coalesced' | 'no_coverage'. */
    outcome: text("outcome").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    eventUq: unique("triage_afterhours_decision_event_uq").on(t.sourceOutboxEventId),
    byOrg: index("triage_afterhours_decision_org_idx").on(t.organizationId),
    outcomeCheck: check(
      "triage_afterhours_decision_outcome",
      sql`${t.outcome} IN ('opened', 'coalesced', 'no_coverage')`,
    ),
    callCheck: check(
      "triage_afterhours_decision_call",
      sql`(${t.outcome} IN ('opened', 'coalesced') AND ${t.triageCallId} IS NOT NULL) OR (${t.outcome} = 'no_coverage' AND ${t.triageCallId} IS NULL)`,
    ),
  }),
);

export type TriageAfterhoursDecision = typeof triageAfterhoursDecisions.$inferSelect;
