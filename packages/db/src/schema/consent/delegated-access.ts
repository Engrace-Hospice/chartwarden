// @chartwarden/db — `delegated_access` (M39 Consent §3.3 #8). The query-optimized PROJECTION from
// family_caregiver_access consent records (D10): one row per named family member + scope tier; the
// consent record stays the source of truth, this is rebuilt transactionally on sign/supersede/revoke
// by the projector service. M31's portal session-minter consults it (forward seam). PHI-bearing
// (carries patient_id) → the three-column tenancy rule (org NOT NULL + provider_entity_id /
// location_id nullable). RLS + the M4 write-audit trigger land in M39-T03 (§3.5–3.7).
import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { consentDelegatedAccessScope } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { consentRecord } from "./consent-record";
import { consentRecordRecipient } from "./consent-record-recipient";

export const delegatedAccess = pgTable(
  "delegated_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // M5 patient (app-validated)
    consentRecordId: uuid("consent_record_id")
      .notNull()
      .references(() => consentRecord.id, { onDelete: "restrict" }),
    consentRecordRecipientId: uuid("consent_record_recipient_id")
      .notNull()
      .references(() => consentRecordRecipient.id, { onDelete: "restrict" }),
    delegateUserId: uuid("delegate_user_id"),
    delegateCaregiverId: uuid("delegate_caregiver_id").notNull(),
    scopeKind: consentDelegatedAccessScope("scope_kind").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveUntil: timestamp("effective_until", { withTimezone: true }),
    portalSessionClass: text("portal_session_class").notNull(), // 'caregiver_portal' | 'bereaved_portal'
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    patientCaregiverIdx: index("ix_da_patient_caregiver")
      .on(t.patientId, t.delegateCaregiverId)
      .where(sql`revoked_at IS NULL`),
    // Partial index predicate must be IMMUTABLE — `now()` is STABLE and Postgres rejects it here.
    // The index covers the not-revoked rows; the effective_until window is filtered at query time.
    activeByPatientIdx: index("ix_da_active_by_patient")
      .on(t.organizationId, t.patientId)
      .where(sql`revoked_at IS NULL`),
  }),
);

export type DelegatedAccess = typeof delegatedAccess.$inferSelect;
export type NewDelegatedAccess = typeof delegatedAccess.$inferInsert;
