// @wardenx/db — `idg_discipline_note` (M14 spec extension: per-discipline note taking in the live meeting).
// One free-text note written DURING a `live` meeting on behalf of ONE discipline, either about ONE agenda
// patient (`patient_id` set) or for the meeting as a whole (`patient_id` NULL = a meeting-level note for that
// discipline). Same shape as `idg_agenda_item`: a PHI-bearing child of `idg_meeting` (cascade FK + the
// tenancy spine) whose three-column tenancy (provider_entity_id + location_id) is NULLABLE because
// meeting-level notes carry no patient; both are denormalized from the meeting/agenda when present.
// `discipline` is the SAME free-text vocabulary `idg_attendance.discipline` records (no DB enum — the
// attendance roster is the source of truth, and the CoP does not close the set). Cross-module refs
// (`patient_id` → M5, `author_membership_id` → M1 membership) are plain uuid, app-validated. `body_text` is
// free-text PHI → DENYLISTED in the M4 write-audit trigger (§3.3). The app role has no DELETE grant
// (append/edit-only, like the agenda); edits bump `version` (If-Match). RLS + grants + trigger: migration 0282; late-addendum columns + CHECK + trigger scrub: migration 0283; `reason` rename + relaxed CHECK + trigger scrub: migration 0284.
import { boolean, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { idgMeeting } from "./idg-meetings";

export const idgDisciplineNote = pgTable(
  "idg_discipline_note",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    idgMeetingId: uuid("idg_meeting_id")
      .notNull()
      .references(() => idgMeeting.id, { onDelete: "cascade" }),
    patientId: uuid("patient_id"), // M5 patient (app-validated; no cross-module FK) — null = meeting-level note
    discipline: text("discipline").notNull(), // same vocabulary as idg_attendance.discipline
    bodyText: text("body_text").notNull(), // DENYLISTED
    authorMembershipId: uuid("author_membership_id").notNull(), // M1 membership (no cross-module FK)
    version: integer("version").notNull().default(0),
    // Late addendum (migration 0283): a note written AFTER the meeting was adjourned. Append-only, never part of
    // the frozen minutes snapshot. Migration 0284: `reason` (was `addendum_reason`) is an OPTIONAL context field on
    // every note and REQUIRED on an addendum (CHECK). Free text => DENYLISTED in the M4 audit trigger.
    isAddendum: boolean("is_addendum").notNull().default(false),
    addendumRecordedAt: timestamp("addendum_recorded_at", { withTimezone: true }),
    reason: text("reason"), // DENYLISTED (optional on originals, required on addenda)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byMeeting: index("idg_discipline_note_meeting_idx").on(
      t.organizationId,
      t.idgMeetingId,
      t.patientId,
      t.createdAt,
    ),
  }),
);

export type IdgDisciplineNote = typeof idgDisciplineNote.$inferSelect;
export type NewIdgDisciplineNote = typeof idgDisciplineNote.$inferInsert;
