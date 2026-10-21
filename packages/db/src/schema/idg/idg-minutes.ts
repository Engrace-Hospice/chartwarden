// @chartwarden/db — `idg_minutes` (M14 §3.3.1 / D10). One row per meeting (uniqueIndex on org+meeting): the
// append-only-while-`in_progress`, immutable-on-`final` minutes record with attendance/decision/action-item
// snapshots frozen at finalize and the M22 rendered-PDF back-ref. Org-scoped child of idg_meeting (NOT
// patient-bearing — snapshots are structural jsonb). FK to the meeting (cascade) + the tenancy spine;
// finalized_by_membership_id → M1 membership is plain uuid app-validated. `closing_note` is free-text →
// denylisted in the M4 write-audit trigger (§3.3). Non-partitioned, so the per-meeting uniqueIndex is legal.
// RLS + grants + trigger land in the RLS migration (M14-T02).
import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { idgMinutesStatus } from "../../enums";
import { organizations } from "../organizations";
import { idgMeeting } from "./idg-meetings";

export const idgMinutes = pgTable(
  "idg_minutes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    idgMeetingId: uuid("idg_meeting_id")
      .notNull()
      .references(() => idgMeeting.id, { onDelete: "cascade" }),
    status: idgMinutesStatus("status").notNull().default("in_progress"),
    attendanceSnapshot: jsonb("attendance_snapshot"),
    decisionListSnapshot: jsonb("decision_list_snapshot"),
    actionItemListSnapshot: jsonb("action_item_list_snapshot"),
    // Per-discipline live-meeting notes frozen at adjournment (migration 0282). Free-text PHI: text is elided
    // for a Part 2 (SUD-flagged / undeterminable) patient at freeze time — see idg-route-service-db.ts.
    disciplineNoteSnapshot: jsonb("discipline_note_snapshot"),
    closingNote: text("closing_note"), // DENYLISTED
    finalizedByMembershipId: uuid("finalized_by_membership_id"), // M1 membership (no cross-module FK)
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    minutesDocumentId: uuid("minutes_document_id"), // M22 PDF back-ref (app-validated; no FK)
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    oneMinutesPerMeeting: uniqueIndex("idg_minutes_meeting_uniq").on(
      t.organizationId,
      t.idgMeetingId,
    ),
  }),
);

export type IdgMinutes = typeof idgMinutes.$inferSelect;
export type NewIdgMinutes = typeof idgMinutes.$inferInsert;
