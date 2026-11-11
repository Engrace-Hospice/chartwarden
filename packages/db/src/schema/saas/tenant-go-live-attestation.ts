// @chartwarden/db — `tenant_go_live_attestation` (M34, migration 1328). The two-party go-live record: the tenant's
// compliance officer ATTESTS readiness (pending), a platform operator then APPROVES (the tenant goes active) or
// REVOKES the pending attestation. One row per attempt, never deleted, so a revoked attestation stays as history.
// ORG-SCOPED (`organization_id` NOT NULL, canonical app.org_id RLS). The tenant role may only INSERT a pending row and
// read its own, and VOID its own pending one (a column-level UPDATE under a pending -> revoked policy: how a write to the
// onboarding data revokes a stale attestation in the same transaction); approval and revocation are written on the platform
// carrier (column-level UPDATE). `status` is a
// text + CHECK (no pg enum) so the code-side mirror is the exported union below.
// Both parties are recorded as a membership and as the USER behind it: the two-person rule compares users (a person has
// a different membership in every organisation). The SQL also carries a composite FK (tenant_account_id,
// organization_id) -> tenant_account, so a row can never name another organisation's tenant.
import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { businessRule } from "../../business-rules";
import { organizations } from "../organizations";

// A business rule the database is the authority for (two officers attesting at once): a 23505 reads as a 409, not a 500.
// Declared outside `pgTable`'s lazily-invoked config callback so the registration runs on import and the error handler sees it.
const PENDING_ATTESTATION_IDX = businessRule(
  "tenant_go_live_attestation_pending_uq",
  "Readiness is already attested and awaiting platform approval for this tenant.",
);

export type TenantGoLiveStatus = "pending" | "approved" | "revoked";

export const tenantGoLiveAttestation = pgTable(
  "tenant_go_live_attestation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // Intra-M34 parent; the composite SQL FK (tenant_account_id, organization_id) lands in the migration.
    tenantAccountId: uuid("tenant_account_id").notNull(),
    status: text("status").$type<TenantGoLiveStatus>().notNull().default("pending"),
    attestedByMembershipId: uuid("attested_by_membership_id").notNull(),
    // Plain uuid like every M34 cross-module reference (no SQL FK to the M2 user); the INSERT policy checks it against the
    // membership it claims to be.
    attestedByUserId: uuid("attested_by_user_id").notNull(),
    attestedAt: timestamp("attested_at", { withTimezone: true }).notNull().defaultNow(),
    attestationNote: text("attestation_note"),
    approvedByMembershipId: uuid("approved_by_membership_id"),
    approvedByUserId: uuid("approved_by_user_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvalReason: text("approval_reason"),
    revokedByMembershipId: uuid("revoked_by_membership_id"),
    // The user who revoked it: always recorded (the SQL state CHECK requires it); the membership is only where the caller has one.
    revokedByUserId: uuid("revoked_by_user_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokeReason: text("revoke_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // At most one open (pending) attestation per tenant; a revoked one is history.
    pendingUnique: uniqueIndex(PENDING_ATTESTATION_IDX)
      .on(t.tenantAccountId)
      .where(sql`status = 'pending'`),
    // Leads with the composite FK's columns (fk-index-coverage); the attested_at tail serves "newest first".
    tenantIdx: index("tenant_go_live_attestation_tenant_ix").on(
      t.tenantAccountId,
      t.organizationId,
      t.attestedAt,
    ),
  }),
);

/**
 * The columns the tenant role may INSERT (migration 1328's column-level grant), as a narrower table object over the same table:
 * the attester and the note. Drizzle lists EVERY column of the table it inserts into (`values (default, $1, default, ...)`) and
 * `DEFAULT` still needs INSERT privilege on its column, so a column grant is only usable through an insert that names just these;
 * `status`, `attested_at` and the approve/revoke columns then take their database defaults.
 */
export const tenantGoLiveAttestationCreate = pgTable("tenant_go_live_attestation", {
  organizationId: uuid("organization_id").notNull(),
  tenantAccountId: uuid("tenant_account_id").notNull(),
  attestedByMembershipId: uuid("attested_by_membership_id").notNull(),
  attestedByUserId: uuid("attested_by_user_id").notNull(),
  attestationNote: text("attestation_note"),
});
export type NewTenantGoLiveAttestationCreate = typeof tenantGoLiveAttestationCreate.$inferInsert;

export type TenantGoLiveAttestation = typeof tenantGoLiveAttestation.$inferSelect;
export type NewTenantGoLiveAttestation = typeof tenantGoLiveAttestation.$inferInsert;
