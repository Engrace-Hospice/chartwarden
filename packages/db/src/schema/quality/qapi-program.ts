// @chartwarden/db — `qapi_program` (M30 §3.3; non-partitioned; retention class `compliance`).
// The annual QAPI program record (CoP §418.58): one per (org, plan_year), carrying the governing-body
// roster and the year-end attestation. Parent of qapi_indicator / qapi_project / qapi_pip /
// qapi_governance_minutes (real intra-M30 FKs). ORG-SCOPED: organization_id NOT NULL (canonical
// app.org_id RLS). provider_entity_id is a logical FK to M40. No PHI; no audit denylist.
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import type { GoverningBodyRoster, YearEndAttestation } from "./types";

export const qapiProgram = pgTable(
  "qapi_program",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    planYear: integer("plan_year").notNull(), // calendar year
    programDescription: text("program_description").notNull(),
    governingBodyRoster: jsonb("governing_body_roster").$type<GoverningBodyRoster>().notNull(), // [{membershipId, role}]
    yearEndAttestation: jsonb("year_end_attestation").$type<YearEndAttestation>(), // {at, byMembershipId, summary}
    closed: boolean("closed").notNull().default(false),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    uniqYear: uniqueIndex("uq_qapi_program_year").on(t.organizationId, t.planYear), // V-8
  }),
);

export type QapiProgram = typeof qapiProgram.$inferSelect;
export type NewQapiProgram = typeof qapiProgram.$inferInsert;
