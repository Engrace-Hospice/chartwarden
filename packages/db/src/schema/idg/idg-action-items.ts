import { sql } from "drizzle-orm";
// @wardenx/db — `idg_action_item` (M14 §3.3.1 / D8). One row per follow-up task from an IDG decision: the
// open → in_progress → completed/cancelled/auto_closed lifecycle, the carry-forward counter (overdue items
// re-surface on the next meeting's cover), and the linked downstream artifact (care_plan_version / order /
// encounter / medication_order) whose signing auto-closes it. PHI-bearing when patient-scoped (`patient_id`)
// → the three-column tenancy rule (provider_entity_id + location_id), nullable for non-patient tasks. FK to
// the meeting (cascade) + the originating decision + the tenancy spine; cross-module (M5 patient), the
// polymorphic linked_artifact_id, and actor refs (assigned_to_membership_id → M1 membership) are plain uuid
// app-validated, NOT cross-module FKs. `body_text` is free-text → denylisted in the M4 write-audit trigger
// (§3.3). RLS + grants + trigger land in the RLS migration (M14-T02).
import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { idgActionItemLinkedKind, idgActionItemStatus } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { idgDecision } from "./idg-decisions";
import { idgMeeting } from "./idg-meetings";

export const idgActionItem = pgTable(
  "idg_action_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // Three-column rule — nullable: present for patient-scoped tasks, null for non-patient ones.
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    idgMeetingId: uuid("idg_meeting_id")
      .notNull()
      .references(() => idgMeeting.id, { onDelete: "cascade" }),
    idgDecisionId: uuid("idg_decision_id").references(() => idgDecision.id),
    patientId: uuid("patient_id"), // M5 patient (app-validated; no cross-module FK)
    assignedToMembershipId: uuid("assigned_to_membership_id").notNull(), // M1 membership (no cross-module FK)
    assignedToDiscipline: text("assigned_to_discipline"),
    title: text("title").notNull(),
    bodyText: text("body_text"), // DENYLISTED
    dueDate: timestamp("due_date", { withTimezone: true }),
    status: idgActionItemStatus("status").notNull().default("open"),
    linkedArtifactKind: idgActionItemLinkedKind("linked_artifact_kind"),
    linkedArtifactId: uuid("linked_artifact_id"), // polymorphic cross-module ref (app-validated; no FK)
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closeReason: text("close_reason"),
    meetingCarryForwardCount: integer("meeting_carry_forward_count").notNull().default(0),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Hot path: "open action items by assignee".
    byAssigneeOpen: index("idg_action_item_assignee_open_idx")
      .on(t.organizationId, t.assignedToMembershipId, t.dueDate)
      .where(sql`status IN ('open', 'in_progress')`),
  }),
);

export type IdgActionItem = typeof idgActionItem.$inferSelect;
export type NewIdgActionItem = typeof idgActionItem.$inferInsert;
