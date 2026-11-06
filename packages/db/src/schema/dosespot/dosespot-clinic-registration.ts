// @chartwarden/db — `dosespot_clinic_registration` (M12 DoseSpot; tenant onboarding slice 4, ADR-0110; migration 1380).
// The DoseSpot clinic a tenant registered: its environment (sandbox | production, never a URL), clinic id, service clinician,
// its sealed credential, and where the registration is in draft -> registered -> verified -> active. One row per organization.
// The CHECKs in the migration are the authority on which column combinations are legal; this file mirrors the shape for Drizzle.
//
// `secret_cipher` is write-only: no service view ever returns it (a `hasSecret` flag is derived). The membership ids are
// logical FKs (a platform operator's membership lives in the platform org). Only `organization_id` has a real FK. There is
// deliberately no EPCS column: EPCS stays under the D18 certification gate.
import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const dosespotClinicRegistrations = pgTable(
  "dosespot_clinic_registration",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    environment: text("environment").notNull(),
    status: text("status").notNull().default("draft"),
    clinicId: text("clinic_id"),
    serviceClinicianId: text("service_clinician_id"),
    secretCipher: text("secret_cipher"),
    secretDekRef: text("secret_dek_ref"),
    registeredAt: timestamp("registered_at", { withTimezone: true }),
    registeredByMembershipId: uuid("registered_by_membership_id"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedByMembershipId: uuid("verified_by_membership_id"),
    lastTestAt: timestamp("last_test_at", { withTimezone: true }),
    lastTestOutcome: text("last_test_outcome"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    activatedByMembershipId: uuid("activated_by_membership_id"),
    setByMembershipId: uuid("set_by_membership_id").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("dosespot_clinic_registration_org_uq").on(t.organizationId)],
);

export type DosespotClinicRegistrationRow = typeof dosespotClinicRegistrations.$inferSelect;
export type NewDosespotClinicRegistrationRow = typeof dosespotClinicRegistrations.$inferInsert;
