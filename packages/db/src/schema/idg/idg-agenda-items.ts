// @wardenx/db — `idg_agenda_item` (M14 §3.3.1 / §2.7). One ordered agenda row per meeting: a patient-review
// slot, a carried-forward overdue action item, or an administrative note. PHI-bearing when patient-scoped
// (`patient_id`) → the three-column tenancy rule (provider_entity_id + location_id), nullable here because
// administrative items are meeting/org-level (no patient), denormalized from the admission only for patient
// slots. FK to the meeting (cascade) + the tenancy spine; cross-module (M5 patient) and self/forward refs
// (carried_from_action_item_id) and actor refs (added_by_membership_id → M1 membership) are plain uuid
// app-validated, NOT cross-module FKs. `body_text` is free-text → denylisted in the M4 write-audit trigger
// (§3.3). RLS + grants + trigger land in the RLS migration (M14-T02).
import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { idgAgendaItemKind } from "../../enums";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";
import { idgMeeting } from "./idg-meetings";

export const idgAgendaItem = pgTable(
  "idg_agenda_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // Three-column rule — nullable: present (denormalized from the admission) for patient-review slots,
    // null for administrative/org-level items (which also carry no patient_id).
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    idgMeetingId: uuid("idg_meeting_id")
      .notNull()
      .references(() => idgMeeting.id, { onDelete: "cascade" }),
    patientId: uuid("patient_id"), // M5 patient (app-validated; no cross-module FK) — null for admin items
    sortOrder: integer("sort_order").notNull().default(0),
    title: text("title").notNull(),
    bodyText: text("body_text"), // DENYLISTED
    kind: idgAgendaItemKind("kind").notNull(),
    carriedFromActionItemId: uuid("carried_from_action_item_id"), // forward ref (app-validated; no FK)
    addedByMembershipId: uuid("added_by_membership_id").notNull(), // M1 membership (no cross-module FK)
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byMeeting: index("idg_agenda_item_meeting_idx").on(t.organizationId, t.idgMeetingId, t.sortOrder),
  }),
);

export type IdgAgendaItem = typeof idgAgendaItem.$inferSelect;
export type NewIdgAgendaItem = typeof idgAgendaItem.$inferInsert;
