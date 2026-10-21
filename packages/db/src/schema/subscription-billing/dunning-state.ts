import { sql } from "drizzle-orm";
// @chartwarden/db — `dunning_state` (M35 §3.3, §4.15). TENANT-SCOPED, RLS on app.org_id (0143). The §4.15
// dunning state machine (D7) row per subscription-in-dunning. `organization_id` is a logical uuid
// (M35-F04); `subscription_id` is a REAL FK. Exported as `dunningStateRow` (the enum `dunningStage`
// already owns the `dunningState`-ish name space in the central enums surface).
import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { dunningStage } from "../../enums";
import { subscriptionRow } from "./subscription";

export const dunningStateRow = pgTable(
  "dunning_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptionRow.id, { onDelete: "restrict" }),
    stage: dunningStage("stage").notNull(),
    enteredAt: timestamp("entered_at", { withTimezone: true }).notNull().defaultNow(),
    exitedAt: timestamp("exited_at", { withTimezone: true }),
    exitReason: text("exit_reason"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastAttemptFailureCode: text("last_attempt_failure_code"),
    triggerInvoiceId: uuid("trigger_invoice_id"),
  },
  (t) => ({
    subStageIx: index("dunning_state_sub_stage_ix").on(t.subscriptionId, t.stage),
    openDunningIx: index("dunning_state_open_ix")
      .on(t.subscriptionId)
      .where(sql`exited_at IS NULL`),
  }),
);

export type DunningStateRow = typeof dunningStateRow.$inferSelect;
export type NewDunningStateRow = typeof dunningStateRow.$inferInsert;
