// @chartwarden/db — `idg_attendance` (M14 §3.3.1). One row per attendee per meeting: the §2.7 participation
// status (present/tardy/partial/absent/excused) + check-in/out timestamps, the substrate the §4.7
// `quorate_decision` ABAC predicate reads. Org-scoped child of idg_meeting (NOT patient-bearing). FK to the
// meeting (cascade) + the tenancy spine (organization); membership_id → M1 membership is plain uuid
// app-validated. `absence_note` is free-text → denylisted in the M4 write-audit trigger (§3.3). RLS +
// grants + trigger land in the RLS migration (M14-T02).
import { boolean, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { idgAttendanceStatus } from "../../enums";
import { organizations } from "../organizations";
import { idgMeeting } from "./idg-meetings";

export const idgAttendance = pgTable(
  "idg_attendance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    idgMeetingId: uuid("idg_meeting_id")
      .notNull()
      .references(() => idgMeeting.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id").notNull(), // M1 membership (no cross-module FK)
    discipline: text("discipline").notNull(),
    // Attendance trust (0286): who wrote the row (null = legacy, pre-0286) and whether a coordinator ATTESTED a
    // discipline the member's roles do not confer. Grandfathered rows: null / false.
    recordedByMembershipId: uuid("recorded_by_membership_id"),
    disciplineAttested: boolean("discipline_attested").notNull().default(false),
    status: idgAttendanceStatus("status").notNull().default("absent"),
    checkInAt: timestamp("check_in_at", { withTimezone: true }),
    checkOutAt: timestamp("check_out_at", { withTimezone: true }),
    absenceNote: text("absence_note"), // DENYLISTED
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Quorum quick lookup: present disciplines for a meeting.
    byMeetingDiscipline: index("idg_attendance_meeting_discipline_idx").on(
      t.organizationId,
      t.idgMeetingId,
      t.discipline,
      t.status,
    ),
  }),
);

export type IdgAttendance = typeof idgAttendance.$inferSelect;
export type NewIdgAttendance = typeof idgAttendance.$inferInsert;
