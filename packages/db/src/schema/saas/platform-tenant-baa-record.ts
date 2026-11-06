// @chartwarden/db — `platform_tenant_baa_record` (M34 SaaS Tenant Platform §3.8). The
// platform↔tenant Business Associate Agreement execution state: one row per
// (tenant_account, addendum_version) capturing BAA status, executed/effective/expires
// dates, breach-notification contacts, the subcontractor disclosure set, and the
// compliance-officer attestation. `document_id` points at the executed PDF (M22 doc id).
//
// Tenancy (§3.10 M34-F02 / ADR-0010): ORG-SCOPED — carries its own `organization_id` NOT NULL
// so the canonical app.org_id RLS predicate applies directly. RLS + grants + the M4 write-audit
// trigger land in the RLS/audit migrations (0052/0053). Not a PHI table (BAA status + references
// only, no patient field).
//
// `tenant_account_id` is an app-validated uuid (not a SQL FK) because the intra-M34
// `tenant_account` table lands in a sibling file/migration; the FK constraint is added in
// the 0051 tables migration. The org spine carries a SQL FK. Cross-module refs (document_id, the
// attestation membership) are plain app-validated uuids per the repo cross-module convention.
import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { businessRule } from "../../business-rules";
import { organizations } from "../organizations";

// One record per (tenant, addendum version): a concurrent duplicate reads as a 409 (the service's own check is racy). Declared
// outside `pgTable`'s lazily-invoked config callback so the registration runs on import.
const BAA_ADDENDUM_IDX = businessRule(
  "platform_tenant_baa_unique",
  "A BAA record for this addendum version already exists for this tenant.",
);

export const platformTenantBaaStatus = pgEnum("platform_tenant_baa_status", [
  "executed",
  "pending",
  "terminated",
  "missing",
]);

export const platformTenantBaaRecord = pgTable(
  "platform_tenant_baa_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // M34-F02 / ADR-0010: tenant-scoping key (canonical app.org_id RLS).
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // app-validated ref to the intra-M34 `tenant_account` (FK added in the 0051 migration).
    tenantAccountId: uuid("tenant_account_id").notNull(),
    addendumVersion: text("addendum_version").notNull(),
    baaStatus: platformTenantBaaStatus("baa_status").notNull(),
    executedOn: date("executed_on"),
    effectiveOn: date("effective_on"),
    expiresOn: date("expires_on"),
    breachNotificationContactEmail: text("breach_notification_contact_email"),
    breachNotificationContactPhone: text("breach_notification_contact_phone"),
    subcontractorDisclosureSet: jsonb("subcontractor_disclosure_set").notNull().default([]),
    complianceOfficerAttestationMembershipId: uuid("compliance_officer_attestation_membership_id"),
    attestedAt: timestamp("attested_at", { withTimezone: true }),
    documentId: uuid("document_id"), // M22 — the executed PDF
    // Migration 1332: who filed the record and who last changed it (plain user uuids, no SQL FK). Go-live approval refuses an
    // approver who wrote the governing record. NULL on rows written before the migration.
    recordedByUserId: uuid("recorded_by_user_id"),
    updatedByUserId: uuid("updated_by_user_id"),
  },
  (t) => ({
    tenantAddendumUnique: uniqueIndex(BAA_ADDENDUM_IDX).on(t.tenantAccountId, t.addendumVersion),
    tenantStatusIdx: index("platform_tenant_baa_tenant_status_idx").on(
      t.tenantAccountId,
      t.baaStatus,
    ),
    expiresIdx: index("platform_tenant_baa_expires_idx")
      .on(t.expiresOn)
      .where(sql`expires_on IS NOT NULL`),
    dateOrderCheck: check(
      "platform_tenant_baa_dates_check",
      sql`executed_on IS NULL OR effective_on IS NULL OR expires_on IS NULL
        OR (executed_on <= effective_on AND effective_on <= expires_on)`,
    ),
  }),
);

/**
 * The columns the platform carrier may INSERT (migration 1332's column-level grant), as a narrower table object over the same
 * table. Drizzle lists EVERY column of the table it inserts into (`values (default, $1, default, ...)`) and `DEFAULT` still
 * needs INSERT privilege on its column, so a column-level grant is only usable through an insert that names just these:
 * not the subcontractor disclosure set, not the tenant compliance officer's attestation, not `id` (it has a default).
 */
export const platformTenantBaaRecordCreate = pgTable("platform_tenant_baa_record", {
  organizationId: uuid("organization_id").notNull(),
  tenantAccountId: uuid("tenant_account_id").notNull(),
  addendumVersion: text("addendum_version").notNull(),
  baaStatus: platformTenantBaaStatus("baa_status").notNull(),
  executedOn: date("executed_on"),
  effectiveOn: date("effective_on"),
  expiresOn: date("expires_on"),
  breachNotificationContactEmail: text("breach_notification_contact_email"),
  breachNotificationContactPhone: text("breach_notification_contact_phone"),
  documentId: uuid("document_id"),
  recordedByUserId: uuid("recorded_by_user_id"),
});
export type NewPlatformTenantBaaRecordCreate = typeof platformTenantBaaRecordCreate.$inferInsert;

export type PlatformTenantBaaRecord = typeof platformTenantBaaRecord.$inferSelect;
export type NewPlatformTenantBaaRecord = typeof platformTenantBaaRecord.$inferInsert;
