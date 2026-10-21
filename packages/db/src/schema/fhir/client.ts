// @chartwarden/db — `fhir_client` (M28 §3.3). One row per external FHIR consumer (a SMART Backend Services
// app or an API-key integration). The §2.2 onboarding FSM lives in `status`; `pending_approval → active`
// needs TWO distinct approver memberships (D12 dual-approval), enforced by the service, not by DDL.
//
// TENANT-SCOPED: `organization_id` NOT NULL on canonical app.org_id RLS (§3.5). Operational metadata
// only — NO PHI and no secret — so the §3.6 denylist is empty and it audits through M1's baseline
// `chartwarden_audit_trigger()`. `credential_id` is a LOGICAL uuid pointing at `fhir_client_credential.id`
// (the reverse FK, credential → client, carries the real constraint; a real FK here too would be a
// circular pair). `approved_by_*_membership_id` are logical M2 references, validated at the write
// boundary.
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { fhirClientStatus, fhirClientTier, fhirClientType } from "../../enums";

export const fhirClient = pgTable(
  "fhir_client",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    name: text("name").notNull(),
    type: fhirClientType("type").notNull(),
    /** Present for `smart_backend_services` — the asymmetric-JWT verification key set. */
    jwksUri: text("jwks_uri"),
    /** Logical uuid → `fhir_client_credential.id`; present for `api_key`. */
    credentialId: uuid("credential_id"),
    /** string[] like ['system/Patient.read', 'system/Encounter.read']. */
    allowedScopes: jsonb("allowed_scopes").notNull(),
    tier: fhirClientTier("tier").notNull(),
    rateLimitRps: integer("rate_limit_rps").notNull(),
    /** string[] CIDR — the source-IP allowlist. */
    ipAllowlist: jsonb("ip_allowlist").notNull().default("[]"),
    /** The M34 BAA contract id — part of the §164.528 disclosure-accounting record. */
    baaContractReference: text("baa_contract_reference").notNull(),
    status: fhirClientStatus("status").notNull().default("pending_approval"),
    /** The two DISTINCT D12 approvers (Org Admin + Compliance Officer). Logical M2 references. */
    approvedByAdminMembershipId: uuid("approved_by_admin_membership_id"),
    approvedByComplianceMembershipId: uuid("approved_by_compliance_membership_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("fhir_client_org_idx").on(t.organizationId, t.status),
    nameUq: uniqueIndex("fhir_client_org_name_uq").on(t.organizationId, t.name),
  }),
);

export type FhirClientRow = typeof fhirClient.$inferSelect;
export type NewFhirClientRow = typeof fhirClient.$inferInsert;
