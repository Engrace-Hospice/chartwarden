// @chartwarden/db — `qapi_indicator` (M30 §3.3; non-partitioned; retention class `compliance`).
// A tracked QAPI indicator under a program (data_path binds it to a measure or a custom source), with
// a tenant target + baseline and soft-delete. Real intra-M30 FK to qapi_program. ORG-SCOPED:
// organization_id NOT NULL (canonical app.org_id RLS). No PHI; no audit denylist.
import { integer, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { qapiProgram } from "./qapi-program";

export const qapiIndicator = pgTable("qapi_indicator", {
  id: uuid("id").primaryKey().defaultRandom(),
  qapiProgramId: uuid("qapi_program_id")
    .notNull()
    .references(() => qapiProgram.id),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  indicatorName: text("indicator_name").notNull(),
  dataPath: text("data_path").notNull(), // V-9 — 'measure:hci_composite'|'custom:...'
  tenantTargetValue: numeric("tenant_target_value", { precision: 10, scale: 4 }), // V-10
  baselineValue: numeric("baseline_value", { precision: 10, scale: 4 }),
  baselineAt: timestamp("baseline_at", { withTimezone: true }),
  trackingFrequency: text("tracking_frequency").notNull().default("monthly"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }), // soft-delete
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type QapiIndicator = typeof qapiIndicator.$inferSelect;
export type NewQapiIndicator = typeof qapiIndicator.$inferInsert;
