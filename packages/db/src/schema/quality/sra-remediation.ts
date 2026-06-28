// @wardenx/db — `sra_remediation` (M30 §3.3; non-partitioned; retention class `compliance`).
// A remediation action for an SRA finding: owner, description, target date, status, and the evidence
// document required to mark it completed. Real intra-M30 FK to sra_finding. ORG-SCOPED:
// organization_id NOT NULL (canonical app.org_id RLS). `description_text` may name staff →
// audit-denylisted (§3.6). evidence_document_id is an M22 back-ref (logical). No PHI.
import {
  date,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { sraFinding } from "./sra-finding";

export const m30SraRemediationStatus = pgEnum("m30_sra_remediation_status", [
  "proposed",
  "in_progress",
  "completed",
  "abandoned",
]);

export const sraRemediation = pgTable("sra_remediation", {
  id: uuid("id").primaryKey().defaultRandom(),
  sraFindingId: uuid("sra_finding_id")
    .notNull()
    .references(() => sraFinding.id),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  remediationNumber: integer("remediation_number").notNull(),
  ownerMembershipId: uuid("owner_membership_id").notNull(),
  descriptionText: text("description_text").notNull(), // DENYLISTED (§3.6)
  targetDate: date("target_date").notNull(),
  status: m30SraRemediationStatus("status").notNull().default("proposed"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  evidenceDocumentId: uuid("evidence_document_id"), // required for 'completed' status
  abandonReason: text("abandon_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  version: integer("version").notNull().default(1),
});

export type SraRemediation = typeof sraRemediation.$inferSelect;
export type NewSraRemediation = typeof sraRemediation.$inferInsert;
