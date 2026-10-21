// @chartwarden/db — `membership_elevated_approval` (M2 Identity §3.7, GAP-043). The per-tenant, per-membership
// NAMED APPROVAL AUTHORITY registry: "this tenant has designated this membership as authorized to certify a
// cost-report filing."
//
// WHY IT IS NOT THE RBAC PERMISSION. M27's §4.7 `cost_report_approver_for_provider` predicate is specified
// as three independent conjuncts — the membership holds `cost_report.approve_for_submit` (M3 RBAC, checked
// by `requirePermission` at the route), is in scope for the report's ProviderEntity (M40 provider scope),
// AND "the elevated-approval flag is set on the membership (per-tenant policy)". The third is deliberately
// NOT derivable from the first: a permission travels with whatever role carries it, so a tenant that grants
// `cost_report.approve_for_submit` to a broad finance role would silently make every member of that role a
// signatory. Certifying a CMS-1984-14 cost report is a named-officer act under 42 CFR §413.24 — the tenant
// names the individuals, and that naming has to be a separate, auditable record.
//
// Before this table the fact had no home at all, so `hasElevatedApproval` was hardcoded `false` in the
// PRODUCTION Drizzle resolver and the entire cost-report approve / submit / reopen / override-validation
// lifecycle was unreachable in every tenant (GAP-043).
//
// SHAPE follows `membership_credential` (GAP-093) — the repo's existing per-membership named-grant table:
// one CURRENT row per (membership, kind) via a partial unique index, with revoked rows retained in place as
// the audit trail rather than deleted. Owned by M2 because the subject is a membership, not a cost report;
// M27 reads it through the `ElevatedApprovalReader` seam, never directly.
//
// TENANCY (ADR-0010 / ARCH-011): a STAFF-authority row, not a patient row — `organization_id` only, no
// provider_entity_id/location_id (the three-column rule scopes PHI-bearing tables). The grant is
// org-wide by design: the per-ProviderEntity narrowing is the SEPARATE scope conjunct in the predicate.
import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { elevatedApprovalKind } from "../enums";
import { memberships } from "./memberships";
import { organizations } from "./organizations";

export const membershipElevatedApprovals = pgTable(
  "membership_elevated_approval",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    approvalKind: elevatedApprovalKind("approval_kind").notNull(),

    /** Who designated this membership. NOT NULL — an authority nobody granted is not an authority. */
    grantedByMembershipId: uuid("granted_by_membership_id")
      .notNull()
      .references(() => memberships.id),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    /** The tenant's stated reason (e.g. "CFO, per board resolution 2026-04"). Required at the boundary. */
    grantReason: text("grant_reason").notNull(),

    /** Set on revoke; the row stays as history. `revoked_at IS NULL` IS the live grant. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByMembershipId: uuid("revoked_by_membership_id").references(() => memberships.id),
    revokedReason: text("revoked_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // At most one LIVE grant per (membership, kind); revoked rows accumulate as the trail.
    liveUq: uniqueIndex("membership_elevated_approval_live_uq")
      .on(t.organizationId, t.membershipId, t.approvalKind)
      .where(sql`revoked_at IS NULL`),
    // The predicate's hot path: "does membership X hold a live grant of kind Y?"
    liveLookupIdx: index("membership_elevated_approval_live_lookup_idx")
      .on(t.organizationId, t.membershipId, t.approvalKind)
      .where(sql`revoked_at IS NULL`),
  }),
);

export type MembershipElevatedApproval = typeof membershipElevatedApprovals.$inferSelect;
export type NewMembershipElevatedApproval = typeof membershipElevatedApprovals.$inferInsert;
