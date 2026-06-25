// @wardenx/db — `platform_tenant_baa_record` (M34 SaaS Tenant Platform §3.8). The
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
import { organizations } from "../organizations";

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
  },
  (t) => ({
    tenantAddendumUnique: uniqueIndex("platform_tenant_baa_unique").on(
      t.tenantAccountId,
      t.addendumVersion,
    ),
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

export type PlatformTenantBaaRecord = typeof platformTenantBaaRecord.$inferSelect;
export type NewPlatformTenantBaaRecord = typeof platformTenantBaaRecord.$inferInsert;
