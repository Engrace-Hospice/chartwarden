// @chartwarden/db — `wound` (M9 longitudinal wounds, migration 1528). The identity of a wound a patient has: where it is,
// what caused it, whether it came with the patient, and whether it is still open. What was seen on each visit is
// `wound_observation` (1529). Everything is CODED (text + CHECK; the value sets live in @chartwarden/assessments), no free
// text. PHI-bearing → the three-column tenancy rule; provider_entity_id / location_id are nullable and unset for now
// (no published seam carries a patient-level siting — the clinical_assessment precedent). patient_id is the M5 patient
// (app-validated, no cross-module FK); the creator is an M1 `membership`. The application role can INSERT and can only
// close a wound (status / closed_on / updated_at, one-way); RLS + grants + the write-audit trigger are in migration 1528.
import { date, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const wounds = pgTable(
  "wound",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(),
    /** A code from the site vocabulary (`WOUND_SITES`). */
    siteCode: text("site_code").notNull(),
    /** `left` | `right` | `midline` | `bilateral` | `not_applicable`. */
    laterality: text("laterality").notNull(),
    /** One of `WOUND_ETIOLOGIES`. */
    etiology: text("etiology").notNull(),
    /** `present_on_admission` | `acquired_in_care` | `unknown`. */
    acquired: text("acquired").notNull().default("unknown"),
    onsetOn: date("onset_on"),
    /** `open` | `healed` | `resolved_other`; closing is one-way. */
    status: text("status").notNull().default("open"),
    closedOn: date("closed_on"),
    createdByMembershipId: uuid("created_by_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The target of wound_observation's composite FK: an observation names a wound of its own organisation AND patient.
    idOrgPatientUq: unique("wound_id_org_patient_uq").on(t.id, t.organizationId, t.patientId),
    patientStatusIdx: index("wound_patient_status_idx").on(
      t.organizationId,
      t.patientId,
      t.status,
      t.createdAt,
    ),
  }),
);

export type Wound = typeof wounds.$inferSelect;
export type NewWound = typeof wounds.$inferInsert;
