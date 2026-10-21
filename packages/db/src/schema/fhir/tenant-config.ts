// @chartwarden/db — `tenant_fhir_config` (M28 §3.3). One row per tenant: the FHIR host, the identifier-URI
// base (D9), the per-tenant HMAC cursor-signing key (DEK-encrypted), and the review/dedup knobs.
//
// TENANT-SCOPED, and its own scope: `organization_id` IS the primary key — a tenant has exactly one FHIR
// config — with a REAL FK to `organization` (the M1 spine). RLS keys on app.org_id like every other
// tenant table (§3.5). Not PHI-bearing, but `cursor_signing_key_cipher` is a per-tenant secret, so it is
// DEK-encrypted at rest and §3.6-denylisted from the audit value_capture (see `M28_AUDIT_DENYLIST`).
import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { bytea } from "./cipher-column";

export const tenantFhirConfig = pgTable("tenant_fhir_config", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "restrict" }),
  tenantFhirHost: text("tenant_fhir_host").notNull(),
  /** e.g. 'https://engrace.fhir.wardenx.com/sid' (D9). */
  identifierUriBase: text("identifier_uri_base").notNull(),
  /** Per-tenant DEK-encrypted HMAC key for the search-cursor signature (§3.6). */
  cursorSigningKeyCipher: bytea("cursor_signing_key_cipher").notNull(),
  capabilityOverrides: jsonb("capability_overrides").notNull().default("{}"),
  inboundReviewSlaHours: integer("inbound_review_sla_hours").notNull().default(72),
  exportDedupWindowMinutes: integer("export_dedup_window_minutes").notNull().default(10),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TenantFhirConfigRow = typeof tenantFhirConfig.$inferSelect;
export type NewTenantFhirConfigRow = typeof tenantFhirConfig.$inferInsert;
