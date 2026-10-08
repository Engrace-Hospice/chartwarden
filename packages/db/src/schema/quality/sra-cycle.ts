// @wardenx/db — `sra_cycle` (M30 §3.3; non-partitioned; retention class `compliance`).
// The annual HIPAA Security Risk Assessment cycle (NIST 800-66r2 template), with dual cosign (security
// officer + compliance officer) gating closure (V-12 CHECK) and a reopen trail. Parent of sra_finding
// (real intra-M30 FK). ORG-SCOPED: organization_id NOT NULL (canonical app.org_id RLS). document_id is
// an M22 back-ref (logical). No PHI; no audit denylist.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const m30SraCycleStatus = pgEnum("m30_sra_cycle_status", [
  "chartered",
  "in_progress",
  "review",
  "closed",
  "reopened",
]);

export const sraCycle = pgTable(
  "sra_cycle",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    cycleYear: integer("cycle_year").notNull(),
    status: m30SraCycleStatus("status").notNull().default("chartered"),
    templateVersion: text("template_version").notNull().default("nist_800_66_r2"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    openedByMembershipId: uuid("opened_by_membership_id").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    cosignSecurityOfficerAt: timestamp("cosign_security_officer_at", { withTimezone: true }),
    cosignSecurityOfficerMembershipId: uuid("cosign_security_officer_membership_id"),
    cosignComplianceOfficerAt: timestamp("cosign_compliance_officer_at", { withTimezone: true }),
    cosignComplianceOfficerMembershipId: uuid("cosign_compliance_officer_membership_id"),
    // 0335 (GAP-088): nominee-based one-step close — see qapi_pip.
    closureClosedByMembershipId: uuid("closure_closed_by_membership_id"),
    closureNomineeMembershipId: uuid("closure_nominee_membership_id"),
    closureCosignAttested: boolean("closure_cosign_attested").notNull().default(true),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    reopenedAt: timestamp("reopened_at", { withTimezone: true }),
    reopenReason: text("reopen_reason"), // ≥100 chars on reopen
    reopenCount: integer("reopen_count").notNull().default(0),
    documentId: uuid("document_id"), // M22 back-ref (SRA artifact PDF)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    uniqYear: uniqueIndex("uq_sra_cycle_year").on(t.organizationId, t.cycleYear),
    // 0701 (GAP-046): see qapi-pip.ts — both slots stamped by two distinct members; pending shape pinned.
    closureGuard: check(
      "chk_sra_cycle_closure_cosign", // V-12
      sql`(${t.closedAt} IS NULL)
        OR (${t.closureCosignAttested} AND ${t.cosignSecurityOfficerAt} IS NOT NULL AND ${t.cosignComplianceOfficerAt} IS NOT NULL
          AND ${t.cosignSecurityOfficerMembershipId} <> ${t.cosignComplianceOfficerMembershipId})`,
    ),
    pendingGuard: check(
      "chk_sra_cycle_close_pending",
      sql`(${t.closedAt} IS NOT NULL) OR (${t.closureNomineeMembershipId} IS NULL)
        OR (NOT ${t.closureCosignAttested} AND ${t.closureClosedByMembershipId} IS NOT NULL
          AND ((${t.closureClosedByMembershipId} = ${t.cosignSecurityOfficerMembershipId} AND ${t.cosignSecurityOfficerAt} IS NOT NULL
                AND ${t.closureNomineeMembershipId} = ${t.cosignComplianceOfficerMembershipId} AND ${t.cosignComplianceOfficerAt} IS NULL)
            OR (${t.closureClosedByMembershipId} = ${t.cosignComplianceOfficerMembershipId} AND ${t.cosignComplianceOfficerAt} IS NOT NULL
                AND ${t.closureNomineeMembershipId} = ${t.cosignSecurityOfficerMembershipId} AND ${t.cosignSecurityOfficerAt} IS NULL)))`,
    ),
  }),
);

export type SraCycle = typeof sraCycle.$inferSelect;
export type NewSraCycle = typeof sraCycle.$inferInsert;
