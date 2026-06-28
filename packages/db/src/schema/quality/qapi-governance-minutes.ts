// @wardenx/db — `qapi_governance_minutes` (M30 §3.3; non-partitioned; retention class `compliance`).
// Governing-body / QAPI meeting minutes under a program: attendee roster, the minutes narrative, the
// reviewed project/PIP id lists, sign-off, and an append-only amendment log. Real intra-M30 FK to
// qapi_program. ORG-SCOPED: organization_id NOT NULL (canonical app.org_id RLS). `minutes_text` may
// name staff/patients → audit-denylisted (§3.6). document_id is an M22 back-ref (logical).
import { sql } from "drizzle-orm";
import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { qapiProgram } from "./qapi-program";
import type { AttendeeRoster, MinutesAmendmentLog } from "./types";

export const qapiGovernanceMinutes = pgTable("qapi_governance_minutes", {
  id: uuid("id").primaryKey().defaultRandom(),
  qapiProgramId: uuid("qapi_program_id")
    .notNull()
    .references(() => qapiProgram.id),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  meetingAt: timestamp("meeting_at", { withTimezone: true }).notNull(),
  attendeeRoster: jsonb("attendee_roster").$type<AttendeeRoster>().notNull(),
  minutesText: text("minutes_text").notNull(), // DENYLISTED (§3.6)
  reviewedProjectIds: jsonb("reviewed_project_ids").$type<string[]>().notNull(), // uuid[]
  reviewedPipIds: jsonb("reviewed_pip_ids").$type<string[]>().notNull(), // uuid[]
  signed: boolean("signed").notNull().default(false),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  signedByMembershipId: uuid("signed_by_membership_id"),
  documentId: uuid("document_id"), // M22 back-ref
  amendmentLog: jsonb("amendment_log")
    .$type<MinutesAmendmentLog>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type QapiGovernanceMinutes = typeof qapiGovernanceMinutes.$inferSelect;
export type NewQapiGovernanceMinutes = typeof qapiGovernanceMinutes.$inferInsert;
