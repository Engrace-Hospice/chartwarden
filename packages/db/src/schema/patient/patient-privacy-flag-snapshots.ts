// @chartwarden/db — `patient_privacy_flag_snapshot` (M5 §3.5, M5 D10). A denormalized snapshot of a
// patient's active privacy flags (sud/hiv/mental_health/genetic/minor_restricted/abuse_victim),
// recomputed from M39 `m39.consent.*` events (M5-T10 consumer — inert until M39 ships). The §7.6 SUD
// read-enforcement reads THIS (fast path) rather than re-deriving from consent each read. One row per
// patient (patient_id PK). PHI-bearing → three-column tenancy rule.
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { patients } from "./patients";

export const patientPrivacyFlagSnapshots = pgTable(
  "patient_privacy_flag_snapshot",
  {
    patientId: uuid("patient_id")
      .primaryKey()
      .references(() => patients.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    flags: text("flags").array().notNull(), // subset of sud|hiv|mental_health|genetic|minor_restricted|abuse_victim
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    sourceConsentVersion: uuid("source_consent_version"), // M39 ref; nullable until M39 ships
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    // F-237 (0308) — `m22_intake_unconfirmed` | `m22_intake_confirmed` when the `sud` flag was put here by
    // a DocLens detection (M22 §7.4 W4); NULL when it came from M39 consent state. A false-positive
    // rejection retires the flag only when DocLens put it there.
    sudFlagOrigin: text("sud_flag_origin"),
  },
  (t) => ({
    orgIdx: index("patient_privacy_flag_snapshot_org_idx").on(t.organizationId),
  }),
);

export type PatientPrivacyFlagSnapshot = typeof patientPrivacyFlagSnapshots.$inferSelect;
export type NewPatientPrivacyFlagSnapshot = typeof patientPrivacyFlagSnapshots.$inferInsert;
