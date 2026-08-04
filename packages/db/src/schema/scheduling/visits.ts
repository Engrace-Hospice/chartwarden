import { sql } from "drizzle-orm";
// @wardenx/db — `visit` (M17 §3.3 / §2.2.1 D3). The central scheduling aggregate: one row per scheduled
// patient visit, carrying the §2.2.1/D3 (M17-F03-reconciled) eight-state lifecycle (proposed → published →
// en_route → in_visit → completed | no_show | cancelled | rescheduled), the EVV-bracket flag (D9, reuses the
// shared `evv_bracket_state` enum — M18 is authoritative for en_route/in_visit when present, else the
// clinician self-attests with a documented evv_missing_reason), the route-optimizer cache, and the cancel/
// reschedule/no-show lineage. PHI-bearing (patient_id / admission_id / encounter_id) → M17-F01 (BLOCKER,
// ARCH-010/ARCH-011): scheduling is the Location-scoped module, so the three tenancy columns are present and
// provider_entity_id + location_id are NOT NULL (location drives day-views/rosters + the site-of-service
// Q-code context). Cross-module logical FKs (M5 patient / patient_address, M6 admission, M8 encounter, M40
// facility, M18 evv_event, M31 telehealth) are plain uuid app-validated; only the tenancy spine + the M1
// membership assignment carry SQL FKs.
//
// PARTITION BY RANGE (service_date) monthly (D14 — matches the M4 PHI-retention cadence + the M11/M13
// precedent): the Drizzle definition here is the LOGICAL shape (composite PK incl. the partition key); the
// PARTITION BY + monthly children + DEFAULT catch-all, plus the D6 GiST exclusion-constraint backstop, land
// in the RLS migration (M17-T02), which drops the plain table drizzle-kit emits and re-creates it
// partitioned. Because it is partitioned, every reference TO it (visit_state_history.visit_id, the
// route_segment from/to visit refs, the reschedule self-refs) carries NO SQL FK — they are plain uuid
// app-validated. RLS + grants + the M4 write-audit trigger land in M17-T02.
import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { evvBracketState, visitPurpose, visitSetting, visitStatus } from "../../enums";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const visit = pgTable(
  "visit",
  {
    id: uuid("id").notNull().defaultRandom(), // composite PK with service_date (the partition key, D14)
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // M17-F01 (BLOCKER): NOT NULL — `visit` is patient-scoped and location-bound.
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),

    patientId: uuid("patient_id").notNull(), // M5 patient (app-validated; no cross-module FK)
    admissionId: uuid("admission_id").notNull(), // M6 admission (app-validated; no cross-module FK)
    patientAddressId: uuid("patient_address_id"), // M5 patient_address — NULL for telephonic
    externalFacilityId: uuid("external_facility_id"), // M40 facility — for facility visits

    assignedMembershipId: uuid("assigned_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    assignedDisciplineAtAssignment: text("assigned_discipline_at_assignment").notNull(),

    visitPurpose: visitPurpose("visit_purpose").notNull(),
    visitSetting: visitSetting("visit_setting").notNull(),

    scheduledStartedAt: timestamp("scheduled_started_at", { withTimezone: true }).notNull(),
    scheduledEndedAt: timestamp("scheduled_ended_at", { withTimezone: true }).notNull(),
    serviceDate: date("service_date").notNull(), // org-tz date — monthly partition key (D14)

    actualStartedAt: timestamp("actual_started_at", { withTimezone: true }),
    actualEndedAt: timestamp("actual_ended_at", { withTimezone: true }),

    status: visitStatus("status").notNull().default("proposed"),
    evvBracketState: evvBracketState("evv_bracket_state"),
    evvCheckInEventId: uuid("evv_check_in_event_id"), // M18 evv_event (app-validated; no FK)
    evvCheckOutEventId: uuid("evv_check_out_event_id"), // M18 evv_event (app-validated; no FK)
    evvMissingReason: text("evv_missing_reason"), // DENYLISTED (§3.6)

    parentRecurringVisitId: uuid("parent_recurring_visit_id"), // logical to recurring_visit.id
    parentProposalId: uuid("parent_proposal_id"), // logical to visit_proposal.id

    encounterId: uuid("encounter_id"), // M8 encounter; set on m8.encounter.signed
    telehealthRoomId: uuid("telehealth_room_id"), // M31 telehealth_visit; set by M31

    schedulerInternalNotes: text("scheduler_internal_notes"), // not portal-visible; DENYLISTED (§3.6)

    cancelledByMembershipId: uuid("cancelled_by_membership_id"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancellationReason: text("cancellation_reason"), // DENYLISTED (§3.6)
    cancellationReasonCode: text("cancellation_reason_code"), // from M38-backed value set

    rescheduledIntoVisitId: uuid("rescheduled_into_visit_id"), // self-ref logical FK
    rescheduledFromVisitId: uuid("rescheduled_from_visit_id"),
    rescheduleReason: text("reschedule_reason"), // DENYLISTED (§3.6)

    noShowDetectedAt: timestamp("no_show_detected_at", { withTimezone: true }),
    noShowReason: text("no_show_reason"), // DENYLISTED (§3.6)

    // Route-optimizer outputs cached on the row for fast day-view rendering:
    proposedRouteSequenceIndex: integer("proposed_route_sequence_index"),
    proposedInboundMiles: integer("proposed_inbound_miles"), // tenths-of-mile integer
    proposedInboundDriveMinutes: integer("proposed_inbound_drive_minutes"),

    caregiverReminderOptIn: boolean("caregiver_reminder_opt_in").notNull().default(false),
    caregiverReminderSentAt: timestamp("caregiver_reminder_sent_at", { withTimezone: true }),

    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.serviceDate] }), // partition key must be in the PK (D14)
    // M17-F01 composite: location-scoped day-view / roster hot path.
    orgLocationServiceDate: index("visit_org_location_service_date_idx").on(
      t.organizationId,
      t.locationId,
      t.serviceDate,
    ),
    orgServiceDate: index("visit_org_service_date_idx").on(t.organizationId, t.serviceDate),
    orgPatient: index("visit_org_patient_idx").on(t.organizationId, t.patientId),
    // The day-view hot path: "today's visits for clinician X".
    orgMembership: index("visit_org_membership_idx").on(
      t.organizationId,
      t.assignedMembershipId,
      t.serviceDate,
    ),
    orgAdmission: index("visit_org_admission_idx").on(t.organizationId, t.admissionId),
    // Proposal/active inbox — partial index on the non-terminal states.
    orgStatus: index("visit_org_status_idx")
      .on(t.organizationId, t.status)
      .where(sql`status IN ('proposed','published','en_route','in_visit')`),
    // D6 GiST exclusion-constraint backstop (no two non-terminal visits overlap per clinician) lands in
    // the SQL migration (M17-T02) — drizzle cannot generate EXCLUDE constraints. Partition-legal form
    // prepends the partition key: EXCLUDE USING gist (service_date WITH =, assigned_membership_id WITH =,
    // tstzrange(scheduled_started_at, scheduled_ended_at) WITH &&) WHERE status IN
    // ('published','en_route','in_visit').
  }),
);

export type Visit = typeof visit.$inferSelect;
export type NewVisit = typeof visit.$inferInsert;
