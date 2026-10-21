// @chartwarden/db — `tenant_invitation` (M34 SaaS Tenant Platform §3.4, D18). The platform → first-admin
// invitation that precedes the organization being a usable entity: issued once at provisioning, its
// first acceptance triggers M2 user-creation + the initial org_admin membership grant (after which M2's
// `organization_invitation` is the canonical staff path — strictly different table, D18). Single-use:
// `token_hash` is the SHA256 of the one-time token (raw token NEVER persisted); 14-day platform-floor TTL.
// Tenancy (§3.10 M34-F02 / ADR-0010): ORG-SCOPED — the tenant_account / organization already exists at
// provisioning, so `organization_id` is available NOT NULL and the canonical app.org_id RLS predicate
// applies directly. `tenant_account_id` is the intra-M34 parent (plain uuid; SQL FK in the migration);
// `inviter_membership_id` / `consumed_by_user_id` are M2 refs (app-validated). The org spine carries a
// SQL FK. The 14-day TTL CHECK + RLS + grants + M4 write-audit trigger land in the migrations (0051/0052/0053).
import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const tenantInvitationStatus = pgEnum("tenant_invitation_status", [
  "pending",
  "consumed",
  "expired",
  "revoked",
]);

export const tenantInvitation = pgTable(
  "tenant_invitation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // M34-F02 / ADR-0010: tenant-scoping key (canonical app.org_id RLS).
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // Intra-M34 parent (tenant_account); SQL FK ON DELETE RESTRICT lands in the migration.
    tenantAccountId: uuid("tenant_account_id").notNull(),
    inviteeEmail: text("invitee_email").notNull(),
    inviteeFullName: text("invitee_full_name").notNull(),
    inviteePhone: text("invitee_phone"),
    tokenHash: text("token_hash").notNull(), // SHA256 of single-use token; raw never persisted
    status: tenantInvitationStatus("status").notNull().default("pending"),
    inviterMembershipId: uuid("inviter_membership_id").notNull(), // M2 membership (app-validated)
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    consumedByUserId: uuid("consumed_by_user_id"), // M2 user (app-validated)
  },
  (t) => ({
    tokenHashUnique: uniqueIndex("tenant_invitation_token_unique").on(t.tokenHash),
    // M34-F02 / ADR-0010: SD-028 composite index leads with organization_id.
    orgStatusIdx: index("tenant_invitation_org_status_idx").on(t.organizationId, t.status),
    tenantStatusIdx: index("tenant_invitation_tenant_status_idx").on(t.tenantAccountId, t.status),
  }),
);

export type TenantInvitation = typeof tenantInvitation.$inferSelect;
export type NewTenantInvitation = typeof tenantInvitation.$inferInsert;
