// @wardenx/db — `consent_record` (M39 Consent §3.3 #3). THE entity: one row per consent execution,
// APPEND-ONLY with explicit supersession chains (D1) — an "edit" inserts a new row pointing at the
// prior via supersedes_consent_record_id; the prior stays alive (`superseded`) for survey
// reconstruction. Three self-FKs (supersede / renewal / acting-consent chain-of-authority, D5) with
// no-self-cycle CHECKs. PHI-bearing (carries patient_id + encrypted internal notes) → the
// three-column tenancy rule (org NOT NULL + provider_entity_id / location_id nullable). patient_id /
// grantor / document refs are app-validated cross-module ids (no hard FK; M39 dependsOn M5/M40/M22
// via seams, not schema edges). RLS + the M4 write-audit trigger (scope_descriptor /
// capture_evidence_jsonb / internal_notes_cipher on the denylist) land in M39-T03 (§3.5–3.7).
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import {
  consentTypeKey,
  consentStatus,
  consentGrantorKind,
  consentCaptureMethod,
} from "../../enums";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";
import { consentTypeCatalog } from "./consent-type-catalog";

export const consentRecord = pgTable(
  "consent_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // M5 patient (app-validated; no cross-module FK)
    typeKey: consentTypeKey("type_key")
      .notNull()
      .references(() => consentTypeCatalog.typeKey, { onDelete: "restrict" }),
    scopeDescriptor: jsonb("scope_descriptor").notNull(),
    grantorKind: consentGrantorKind("grantor_kind").notNull(),
    grantorUserId: uuid("grantor_user_id"),
    grantorCaregiverId: uuid("grantor_caregiver_id"),
    grantorRelationshipText: text("grantor_relationship_text"),
    actingConsentId: uuid("acting_consent_id"), // self-FK; D5 chain-of-authority
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    status: consentStatus("status").notNull().default("draft"),
    supersedesConsentRecordId: uuid("supersedes_consent_record_id"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededByConsentRecordId: uuid("superseded_by_consent_record_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedViaId: uuid("revoked_via_id"),
    renewedFromConsentRecordId: uuid("renewed_from_consent_record_id"),
    captureMethod: consentCaptureMethod("capture_method").notNull(),
    captureEvidenceJsonb: jsonb("capture_evidence_jsonb").notNull(),
    jurisdictionCode: text("jurisdiction_code"),
    languageCode: text("language_code"),
    survivesDeath: boolean("survives_death").notNull().default(false),
    internalNotesCipher: text("internal_notes_cipher"), // PHI; per-tenant DEK envelope-encrypted
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: uuid("created_by_id").notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    signedById: uuid("signed_by_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(0),
  },
  (t) => ({
    selfSupersedeFk: foreignKey({
      columns: [t.supersedesConsentRecordId],
      foreignColumns: [t.id],
    }),
    selfSupersededByFk: foreignKey({
      columns: [t.supersededByConsentRecordId],
      foreignColumns: [t.id],
    }),
    selfRenewalFk: foreignKey({
      columns: [t.renewedFromConsentRecordId],
      foreignColumns: [t.id],
    }),
    selfActingFk: foreignKey({ columns: [t.actingConsentId], foreignColumns: [t.id] }),
    patientTypeStatusIdx: index("ix_cr_patient_type_status").on(
      t.organizationId,
      t.patientId,
      t.typeKey,
      t.status,
    ),
    expiringSoonIdx: index("ix_cr_expiring_soon")
      .on(t.expiresAt)
      .where(sql`status = 'active' AND expires_at IS NOT NULL`),
    activeByPatientIdx: index("ix_cr_active_by_patient")
      .on(t.organizationId, t.patientId)
      .where(sql`status = 'active'`),
    selfNoCycleCheck: check("cr_no_self_supersede", sql`supersedes_consent_record_id <> id`),
    selfNoCycleActingCheck: check("cr_no_self_acting", sql`acting_consent_id <> id`),
    selfNoCycleRenewalCheck: check("cr_no_self_renewal", sql`renewed_from_consent_record_id <> id`),
    expiresAfterEffective: check(
      "cr_expires_after_effective",
      sql`expires_at IS NULL OR expires_at > effective_at`,
    ),
    supersededConsistent: check(
      "cr_superseded_consistent",
      sql`(status <> 'superseded') OR (superseded_at IS NOT NULL AND superseded_by_consent_record_id IS NOT NULL)`,
    ),
    revokedConsistent: check(
      "cr_revoked_consistent",
      sql`(status <> 'revoked') OR (revoked_at IS NOT NULL AND revoked_via_id IS NOT NULL)`,
    ),
    signedConsistent: check(
      "cr_signed_consistent",
      sql`(status = 'draft') OR (signed_at IS NOT NULL AND signed_by_id IS NOT NULL)`,
    ),
  }),
);

export type ConsentRecord = typeof consentRecord.$inferSelect;
export type NewConsentRecord = typeof consentRecord.$inferInsert;
