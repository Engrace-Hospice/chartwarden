// @wardenx/db — `patient_assignment` (M5 §3.5). The care-team membership that drives the
// CaseloadProvider seam (§4.1, M5-T07): a row links a clinician (M2 user) to a patient in a role,
// open while `unassigned_at IS NULL`. PHI-bearing → three-column tenancy rule. One active primary_rn
// per patient.
import { sql } from "drizzle-orm";
import { date, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { patientAssignmentRole } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { users } from "../users";
import { patients } from "./patients";

export const patientAssignments = pgTable(
  "patient_assignment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    clinicianUserId: uuid("clinician_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    role: patientAssignmentRole("role").notNull(),
    assignedAt: date("assigned_at").notNull(),
    unassignedAt: date("unassigned_at"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    patientIdx: index("patient_assignment_patient_idx").on(t.patientId),
    clinicianActiveIdx: index("patient_assignment_clinician_active_idx")
      .on(t.clinicianUserId)
      .where(sql`${t.unassignedAt} IS NULL`),
    primaryRnUnique: uniqueIndex("patient_assignment_primary_rn_unique")
      .on(t.patientId, t.role)
      .where(sql`${t.role} = 'primary_rn' AND ${t.unassignedAt} IS NULL`),
  }),
);

export type PatientAssignment = typeof patientAssignments.$inferSelect;
export type NewPatientAssignment = typeof patientAssignments.$inferInsert;
