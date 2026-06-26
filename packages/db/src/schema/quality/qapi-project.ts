// @wardenx/db — `qapi_project` (M30 §3.3; non-partitioned; retention class `compliance`).
// A QAPI improvement project under a program, optionally linked to an indicator, with a baseline/target
// and a lifecycle status. Real intra-M30 FKs to qapi_program + qapi_indicator. ORG-SCOPED:
// organization_id NOT NULL (canonical app.org_id RLS). owner_membership_id is a logical FK to M2. No
// PHI; no audit denylist.
import {
  date,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { qapiIndicator } from "./qapi-indicator";
import { qapiProgram } from "./qapi-program";

export const m30QapiProjectStatus = pgEnum("m30_qapi_project_status", [
  "proposed",
  "active",
  "corrective_action",
  "completed",
  "abandoned",
]);

export const qapiProject = pgTable("qapi_project", {
  id: uuid("id").primaryKey().defaultRandom(),
  qapiProgramId: uuid("qapi_program_id")
    .notNull()
    .references(() => qapiProgram.id),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  title: text("title").notNull(),
  goalText: text("goal_text").notNull(),
  ownerMembershipId: uuid("owner_membership_id").notNull(), // logical FK to M2
  linkedIndicatorId: uuid("linked_indicator_id").references(() => qapiIndicator.id),
  baselineValue: numeric("baseline_value", { precision: 10, scale: 4 }),
  targetValue: numeric("target_value", { precision: 10, scale: 4 }), // V-10
  timelineStart: date("timeline_start"),
  timelineTargetEnd: date("timeline_target_end"),
  status: m30QapiProjectStatus("status").notNull().default("proposed"),
  outcomeText: text("outcome_text"),
  abandonReason: text("abandon_reason"), // ≥60 chars if status=abandoned
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  version: integer("version").notNull().default(1),
});

export type QapiProject = typeof qapiProject.$inferSelect;
export type NewQapiProject = typeof qapiProject.$inferInsert;
