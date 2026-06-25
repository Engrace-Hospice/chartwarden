// @wardenx/db — `support_consent_grant` (M34 §3.6). The tenant-issued, time-boxed grant that
// authorizes a platform-ops support session into a tenant's data. Tenancy (§3.10 M34-F02 / ADR-0010):
// ORG-SCOPED — carries its own `organization_id` NOT NULL so the canonical app.org_id RLS predicate
// applies directly. `scope` selects organization- vs patient-scoped access; when patient-scoped,
// `patient_ids_in_scope` enumerates the in-scope M5 patients (app-validated uuids). The ≤72h expiry
// window and the scope↔patient-ids coupling are CHECK invariants. The grantor is a tenant
// compliance_officer membership (ABAC). RLS + grants + the M4 write-audit trigger land in 0052/0053.
import { sql } from "drizzle-orm";
import { check, index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const supportConsentGrantScope = pgEnum("support_consent_grant_scope", [
  "organization_scoped",
  "patient_scoped",
]);

export const supportConsentGrant = pgTable(
  "support_consent_grant",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // M34-F02 / ADR-0010: tenant-scoping key (canonical app.org_id RLS).
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // Intra-M34 parent: tenant_account (app-validated; tenant_account.ts is a sibling M34 file).
    tenantAccountId: uuid("tenant_account_id").notNull(),
    scope: supportConsentGrantScope("scope").notNull(),
    patientIdsInScope: uuid("patient_ids_in_scope").array(), // populated only when scope=patient_scoped (M5 patient ids)
    grantReason: text("grant_reason").notNull(),
    grantorMembershipId: uuid("grantor_membership_id").notNull(), // tenant compliance_officer per ABAC (M1 membership)
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByMembershipId: uuid("revoked_by_membership_id"),
    revocationReason: text("revocation_reason"),
  },
  (t) => ({
    tenantIssuedIdx: index("support_grant_tenant_issued_idx").on(t.tenantAccountId, t.issuedAt),
    expiresAtCheck: check(
      "support_grant_expires_check",
      sql`${t.expiresAt} <= ${t.issuedAt} + interval '72 hours'`,
    ),
    patientScopeCheck: check(
      "support_grant_patient_scope_check",
      sql`(${t.scope} = 'patient_scoped') = (${t.patientIdsInScope} IS NOT NULL AND array_length(${t.patientIdsInScope}, 1) > 0)`,
    ),
  }),
);

export type SupportConsentGrant = typeof supportConsentGrant.$inferSelect;
export type NewSupportConsentGrant = typeof supportConsentGrant.$inferInsert;
