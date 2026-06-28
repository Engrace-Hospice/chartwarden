// @wardenx/db — `ecr_submission` (M27 §3.3, D11; non-partitioned; retention class `compliance`). One row
// per submission attempt: ECR + PI files generated (via M22) and the manual MCReF upload/acknowledgment.
// The ECR/PI/supporting-docs are M22 document refs (M27 holds back-references; no MinIO code). CHECK:
// mcref_acknowledgment_number and mcref_rejection_code are mutually exclusive (added in migration).
// ORG-SCOPED. No PHI (D18) — the ECR file format carries no patient identifiers.
import { sql } from "drizzle-orm";
import { index, jsonb, pgEnum, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { costReport } from "./cost-report";
import { costReportSnapshot } from "./cost-report-snapshot";

export const m27EcrSubmissionStatus = pgEnum("m27_ecr_submission_status", [
  "generating",
  "generated",
  "uploaded",
  "accepted",
  "rejected",
]);

export const ecrSubmission = pgTable(
  "ecr_submission",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    costReportId: uuid("cost_report_id")
      .notNull()
      .references(() => costReport.id),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => costReportSnapshot.id),
    ecrFileDocumentId: uuid("ecr_file_document_id"), // M22 ref
    piFileDocumentId: uuid("pi_file_document_id"), // M22 ref
    supportingDocumentsDocumentIds: jsonb("supporting_documents_document_ids")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: m27EcrSubmissionStatus("status").notNull().default("generating"),
    mcrefAcknowledgmentNumber: varchar("mcref_acknowledgment_number", { length: 100 }),
    mcrefRejectionCode: varchar("mcref_rejection_code", { length: 100 }),
    mcrefRejectionDetail: varchar("mcref_rejection_detail", { length: 2000 }),
    uploadedByMembershipId: uuid("uploaded_by_membership_id"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxOrgReportStatus: index("idx_ecr_org_report_status").on(
      t.organizationId,
      t.costReportId,
      t.status,
    ),
  }),
);

export type EcrSubmission = typeof ecrSubmission.$inferSelect;
export type NewEcrSubmission = typeof ecrSubmission.$inferInsert;
