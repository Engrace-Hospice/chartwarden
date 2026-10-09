// @wardenx/db — `dde_work_event` (M23 Billing-Medicare; ADR-0052 D4/D8; non-partitioned; retention class
// `compliance`). The APPEND-ONLY history of a `dde_work_item`: one row per transition (or reassignment), written
// in the same transaction as the item change. UPDATE and DELETE are refused by a trigger (only the destruction
// role may erase). `detail` is PHI-free by contract: codes, ids and dates only — never notes or names.
// ORG-SCOPED: organization_id NOT NULL (canonical app.org_id RLS, ENABLED + FORCEd).
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { ddeWorkItem } from "./dde-work-item";

export const ddeWorkEvent = pgTable(
  "dde_work_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    workItemId: uuid("work_item_id")
      .notNull()
      .references(() => ddeWorkItem.id, { onDelete: "restrict" }), // intra-M23 parent
    event: text("event").notNull(), // 'create'|'assign'|'unassign'|'start'|'submit'|'accept'|'return'|'retry'|'close'|'cancel'|'reassign'
    fromState: text("from_state"), // NULL on the creation row
    toState: text("to_state").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    actorMembershipId: uuid("actor_membership_id"), // logical FK → core membership; NULL for the watchdog
    actorKind: text("actor_kind").notNull(), // 'user'|'system'
    detail: jsonb("detail").$type<Record<string, string | number | null>>().notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    itemTimelineIdx: index("dde_work_event_item_idx").on(t.workItemId, t.occurredAt),
    orgIdx: index("dde_work_event_org_idx").on(t.organizationId, t.occurredAt),
  }),
);

export type DdeWorkEvent = typeof ddeWorkEvent.$inferSelect;
export type NewDdeWorkEvent = typeof ddeWorkEvent.$inferInsert;
