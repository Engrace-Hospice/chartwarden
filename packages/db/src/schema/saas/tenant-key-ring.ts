// @chartwarden/db — `tenant_key_ring` (M34 SaaS Tenant Platform §3.5). The per-tenant envelope-encryption
// key ring: holds the current DEK ciphertext wrapped by the platform KEK plus prior versions retained
// for decrypt-only during rotation windows. The cryptographic-shred state is `current_dek_kek_wrapped_ciphertext
// IS NULL` (DEK zeroized) — enforced by the destroyed-consistency CHECK. The DEK is destroyed only via the
// `m34_destroy_tenant_key_ring` SECURITY DEFINER function (lands in migration 0055); the destruction-cert /
// MinIO / eraser-receipt sequence is logged to `tenant_key_destruction_log`.
//
// Tenancy (§3.10 M34-F02 / ADR-0010): ORG-SCOPED — carries its own `organization_id` NOT NULL so the canonical
// app.org_id RLS predicate applies directly (base-table SELECT is REVOKED from wardenx_app; reads go through the
// `tenant_key_ring_metadata_v` view, which also filters on organization_id). `tenant_account_id` is a plain uuid
// app-validated reference to the sibling `tenant_account` row (authored separately); the org spine takes a SQL FK.
// RLS + grants + the M4 write-audit trigger land in migrations 0052/0053. `destruction_certificate_id` is an M4
// cross-module ref (plain uuid, app-side).
import { sql } from "drizzle-orm";
import {
  customType,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

// DEK ciphertext (current DEK wrapped by the platform KEK), stored as PostgreSQL bytea. AEAD-encrypted.
// NULL when destroyed_at IS NOT NULL — the cryptographic-shred state.
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const tenantKeyRing = pgTable(
  "tenant_key_ring",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // M34-F02 / ADR-0010: tenant-scoping key (canonical app.org_id RLS via the metadata view).
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // Sibling `tenant_account` row (M34) — plain uuid app-validated (intra-M34 ref).
    tenantAccountId: uuid("tenant_account_id").notNull(),
    // Monotonic version label; 'v1' at creation, 'v2' after first rotation, etc.
    currentDekVersion: text("current_dek_version").notNull(),
    // The DEK ciphertext wrapped by the platform KEK. NULL when destroyed (cryptographic shred).
    currentDekKekWrappedCiphertext: bytea("current_dek_kek_wrapped_ciphertext"),
    // The KEK identifier used to wrap the current DEK; supports KEK rotation.
    currentDekKekId: text("current_dek_kek_id"),
    // Prior DEK versions retained for decrypt-only during rotation windows.
    // Shape: [{version, kekWrappedCiphertext (base64), kekId, rotatedAt}]. NULL'd entirely on destruction.
    priorDekVersions: jsonb("prior_dek_versions").notNull().default([]),
    dekCreatedAt: timestamp("dek_created_at", { withTimezone: true }),
    dekLastRotatedAt: timestamp("dek_last_rotated_at", { withTimezone: true }),
    destroyedAt: timestamp("destroyed_at", { withTimezone: true }),
    destroyedByMembershipId: uuid("destroyed_by_membership_id"),
    destructionCertificateId: uuid("destruction_certificate_id"), // M4 FK; cross-module FK is app-side
  },
  (t) => ({
    tenantUnique: uniqueIndex("tenant_key_ring_tenant_unique").on(t.tenantAccountId),
    // CHECK: ciphertext NULL iff destroyed.
    destroyedConsistency: sql`CONSTRAINT tenant_key_ring_destroyed_consistency CHECK (
      (destroyed_at IS NOT NULL) = (current_dek_kek_wrapped_ciphertext IS NULL)
    )`,
  }),
);

export type TenantKeyRing = typeof tenantKeyRing.$inferSelect;
export type NewTenantKeyRing = typeof tenantKeyRing.$inferInsert;
