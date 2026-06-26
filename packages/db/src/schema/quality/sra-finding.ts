// @wardenx/db — `sra_finding` (M30 §3.3; non-partitioned; retention class `compliance`).
// A finding within an SRA cycle: threat/vulnerability/impact narrative, 5x5 inherent + residual scores,
// status, and accepted-risk attestation with auto-reopen. Real intra-M30 FK to sra_cycle; parent of
// sra_remediation. ORG-SCOPED: organization_id NOT NULL (canonical app.org_id RLS). The vulnerability
// and impact narratives are security-posture sensitive → audit-denylisted (§3.6). No PHI.
import {
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { sraCycle } from "./sra-cycle";

export const m30SraFindingStatus = pgEnum("m30_sra_finding_status", [
  "identified",
  "analyzed",
  "mitigation_planned",
  "mitigation_in_progress",
  "mitigated",
  "accepted_risk",
]);

export const sraFinding = pgTable(
  "sra_finding",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sraCycleId: uuid("sra_cycle_id")
      .notNull()
      .references(() => sraCycle.id),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    findingNumber: integer("finding_number").notNull(), // sequential per-cycle
    threatDescription: text("threat_description").notNull(),
    vulnerabilityDescription: text("vulnerability_description").notNull(), // DENYLISTED (§3.6)
    impactDescription: text("impact_description").notNull(), // DENYLISTED (§3.6)
    affectedAssetCategory: text("affected_asset_category").notNull(), // 'admin'|'physical'|'technical'
    inherent5x5Score: integer("inherent_5x5_score").notNull(), // V-13
    residual5x5Score: integer("residual_5x5_score").notNull(), // V-13
    status: m30SraFindingStatus("status").notNull().default("identified"),
    acceptedRiskAttestationAt: timestamp("accepted_risk_attestation_at", { withTimezone: true }),
    acceptedRiskAttestationMembershipId: uuid("accepted_risk_attestation_membership_id"),
    acceptedRiskAutoReopenAt: timestamp("accepted_risk_auto_reopen_at", { withTimezone: true }),
    carriedFromPriorCycleId: uuid("carried_from_prior_cycle_id"), // seed-from-prior trace
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    uniqInCycle: uniqueIndex("uq_sra_finding_in_cycle").on(t.sraCycleId, t.findingNumber),
  }),
);

export type SraFinding = typeof sraFinding.$inferSelect;
export type NewSraFinding = typeof sraFinding.$inferInsert;
