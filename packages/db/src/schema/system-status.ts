// @chartwarden/db — `system_status` (M1 Foundation §3.10). Platform/global operational
// status per component (id = 'system' or '<component>' e.g. 'dosespot'). Not tenant
// scoped: NON_ORG_SCOPED in check-tenancy.ts, with its own global read policy added
// in the initial migration (M1-T04). Drives the degraded-mode banner (M1-T11).
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { systemStatusValue } from "../enums";
import { users } from "./users";

export const systemStatus = pgTable("system_status", {
  id: text("id").primaryKey(), // 'system' or '<component>' e.g. 'dosespot'
  status: systemStatusValue("status").notNull().default("operational"),
  headline: text("headline"),
  details: text("details"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => users.id),
});

export type SystemStatus = typeof systemStatus.$inferSelect;
export type NewSystemStatus = typeof systemStatus.$inferInsert;
