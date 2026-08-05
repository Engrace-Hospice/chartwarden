// M18-owned snapshot of the M17 visit publication contract.
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const evvVisitRegistrations = pgTable(
  "evv_visit_registration",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    visitId: uuid("visit_id").notNull(),
    patientId: uuid("patient_id").notNull(),
    admissionId: uuid("admission_id").notNull(),
    assignedMembershipId: uuid("assigned_membership_id").notNull(),
    assignedDiscipline: text("assigned_discipline").notNull(),
    serviceTypeCode: text("service_type_code").notNull(),
    patientAddressId: uuid("patient_address_id"),
    externalFacilityId: uuid("external_facility_id"),
    scheduledStartedAt: timestamp("scheduled_started_at", { withTimezone: true }).notNull(),
    scheduledEndedAt: timestamp("scheduled_ended_at", { withTimezone: true }).notNull(),
    sourceOutboxEventId: uuid("source_outbox_event_id").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    visitUnique: uniqueIndex("evv_visit_registration_org_visit_unique").on(
      t.organizationId,
      t.visitId,
    ),
    patientSchedule: index("evv_visit_registration_patient_schedule_idx").on(
      t.organizationId,
      t.patientId,
      t.scheduledStartedAt,
    ),
  }),
);

export type EvvVisitRegistration = typeof evvVisitRegistrations.$inferSelect;
