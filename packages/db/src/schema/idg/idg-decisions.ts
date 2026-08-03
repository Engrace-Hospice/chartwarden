// @wardenx/db — `idg_decision` (M14 §3.3.1 / §2.6 D4). One row per recorded IDG decision: the canonical
// discriminated `payload` (decision_kind discriminator), the quorum evidence captured at record-time
// (was_quorate + quorum_snapshot), and the §2.7/§2.8 supersede lineage. `status` runs open → emitted (in
// the adjournment outbox burst, M14-T06) → superseded. PHI-bearing when patient-scoped (`patient_id`) → the
// three-column tenancy rule (provider_entity_id + location_id), nullable for team-note/administrative
// decisions with no patient. FK to the meeting (cascade) + agenda item + the tenancy spine; cross-module
// (M5 patient, M7 care_plan — mig 0155), self (superseded_by_decision_id), and actor (recorded_by_membership_id → M1 membership)
// refs are plain uuid app-validated. Narrative free-text lives INSIDE the `payload` jsonb
// (rationaleText / noteText / narrative / recommendations / requestedOrders / mutations) → the M4 trigger
// re-scrubs those nested keys (§3.3). RLS + grants + trigger land in the RLS migration (M14-T02).
import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { idgDecisionKind, idgDecisionStatus } from "../../enums";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";
import { idgMeeting } from "./idg-meetings";
import { idgAgendaItem } from "./idg-agenda-items";

export const idgDecision = pgTable(
  "idg_decision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // Three-column rule — nullable: present for patient-scoped decisions, null for team-note/admin ones.
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    idgMeetingId: uuid("idg_meeting_id")
      .notNull()
      .references(() => idgMeeting.id, { onDelete: "cascade" }),
    patientId: uuid("patient_id"), // M5 patient (app-validated; no cross-module FK) — null for team notes
    // M7 care_plan (app-validated logical ref; no cross-module FK — M7 owns care_plan). Stamped at
    // record time for `care_plan_update` decisions from the patient's ACTIVE plan via M7's
    // CarePlanReader seam (the D4 payload's mutations carry element ids only — no plan id on the
    // wire); NULL when the decision updates no care plan or no active plan resolved. Backs the
    // IdgDecisionProvider by-care-plan read (mig 0155).
    carePlanId: uuid("care_plan_id"),
    agendaItemId: uuid("agenda_item_id").references(() => idgAgendaItem.id),
    decisionKind: idgDecisionKind("decision_kind").notNull(),
    payload: jsonb("payload").notNull(), // IdgDecisionPayload — nested narrative keys denylisted (§3.3)
    wasQuorate: boolean("was_quorate").notNull(),
    quorumSnapshot: jsonb("quorum_snapshot").notNull(),
    recordedByMembershipId: uuid("recorded_by_membership_id").notNull(), // M1 membership (no cross-module FK)
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    status: idgDecisionStatus("status").notNull().default("open"),
    supersededByDecisionId: uuid("superseded_by_decision_id"), // self-ref (app-validated; no FK)
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    emittedAt: timestamp("emitted_at", { withTimezone: true }),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Hot path: "decisions for meeting" + "open decisions for the adjournment emit".
    byMeetingStatus: index("idg_decision_meeting_status_idx").on(
      t.organizationId,
      t.idgMeetingId,
      t.status,
    ),
    // The seam's by-care-plan read (partial: most decisions carry no plan link; mig 0155).
    byCarePlan: index("idg_decision_care_plan_idx")
      .on(t.carePlanId)
      .where(sql`care_plan_id IS NOT NULL`),
  }),
);

export type IdgDecision = typeof idgDecision.$inferSelect;
export type NewIdgDecision = typeof idgDecision.$inferInsert;
