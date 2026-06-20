// @wardenx/db — `consent_renewal_cycle` (M39 Consent §3.3 #11). One row per expiring/expired consent
// record (D8/D13): opened when the first 30-day reminder fires, drives the re-capture workflow, and
// closes when a new record is signed (renewed_from = source) or the source expires unrenewed. The
// renewal chain is distinct from the supersession chain. PHI-bearing (carries patient_id) → the
// three-column tenancy rule. At most one OPEN cycle per source record (partial unique index). RLS +
// the M4 write-audit trigger land in M39-T03 (§3.5–3.7).
import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { consentRenewalCycleStatus } from "../../enums";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";
import { consentRecord } from "./consent-record";

export const consentRenewalCycle = pgTable(
  "consent_renewal_cycle",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    sourceConsentRecordId: uuid("source_consent_record_id")
      .notNull()
      .references(() => consentRecord.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // M5 patient (app-validated)
    status: consentRenewalCycleStatus("status").notNull().default("open"),
    cycleStartedAt: timestamp("cycle_started_at", { withTimezone: true }).notNull().defaultNow(),
    nextActionDueAt: timestamp("next_action_due_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedReason: text("closed_reason"),
    resolvedConsentRecordId: uuid("resolved_consent_record_id").references(
      () => consentRecord.id,
      { onDelete: "restrict" },
    ),
    assignedToMembershipId: uuid("assigned_to_membership_id"),
  },
  (t) => ({
    sourceUniq: uniqueIndex("uq_crc_source_open")
      .on(t.sourceConsentRecordId)
      .where(sql`status = 'open'`),
    openByPatientIdx: index("ix_crc_open_by_patient")
      .on(t.organizationId, t.patientId)
      .where(sql`status = 'open'`),
  }),
);

export type ConsentRenewalCycle = typeof consentRenewalCycle.$inferSelect;
export type NewConsentRenewalCycle = typeof consentRenewalCycle.$inferInsert;
