// @wardenx/db — `support_session_event` (M34 §3.6). The append-only ledger of every action taken inside a
// platform-ops support session (the surveyor-facing audit trail; `support_record` retention class, 7 years).
// Tenancy (§3.10 M34-F02 / M34-F10 / ADR-0010): ORG-SCOPED — carries its own `organization_id` NOT NULL so
// the canonical app.org_id RLS predicate applies directly, and as the LIST co-partition key (the table
// co-partitions LIST organization_id → RANGE occurred_at). PHI-bearing (`patient_id`; sessions may touch
// 42 CFR Part 2 patients — heightened controls per §7.4/§8.2). `support_session_id` is a plain app-validated
// uuid (no SQL FK — the parent is read via the session table, mirroring the evv_event cross-ref convention);
// the org spine carries a SQL FK.
//
// PARTITION BY LIST (organization_id): the Drizzle definition here is the LOGICAL shape (composite PK incl.
// the LIST partition key + occurred_at); the PARTITION BY lands in the tables migration (0051). Per-org child
// partitions (and their monthly RANGE sub-partitions) are created by the provision worker / partition.rotate
// (OPS-021). Indexes that omit the partition key are declared plain here. RLS + grants + the M4 write-audit
// trigger land in 0052/0053.
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const supportSessionEvent = pgTable(
  "support_session_event",
  {
    id: uuid("id").notNull().defaultRandom(), // composite PK with the partition keys
    // M34-F02 / M34-F10 / ADR-0010: tenant-scoping key + LIST co-partition key.
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    supportSessionId: uuid("support_session_id").notNull(), // intra-M34 parent (app-validated; no SQL FK)
    eventKind: text("event_kind").notNull(),
    resourceKind: text("resource_kind"),
    resourceId: uuid("resource_id"),
    patientId: uuid("patient_id"), // M5 patient; surveyor query by patient_id + actor_kind='platform_ops_via_support_session'
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(), // the partition key
    actorIp: text("actor_ip"),
    context: jsonb("context").notNull().default({}),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.organizationId, t.occurredAt] }), // LIST + RANGE partition keys in the PK
    sessionEventIdx: index("support_session_event_session_idx").on(
      t.supportSessionId,
      t.occurredAt,
    ),
    patientEventIdx: index("support_session_event_patient_idx")
      .on(t.patientId, t.occurredAt)
      .where(sql`patient_id IS NOT NULL`),
  }),
);

export type SupportSessionEvent = typeof supportSessionEvent.$inferSelect;
export type NewSupportSessionEvent = typeof supportSessionEvent.$inferInsert;
