// @wardenx/db — `cost_report_snapshot` (M27 §3.3, D10; non-partitioned; retention class `compliance`).
// Content-hashed snapshot-on-submit lockdown: every seam-derived input + worksheet state materialized
// at submit/reopen with a SHA-256 content hash. INSERT-ONLY (RLS write policy is system-only, §3.5).
// `prior_snapshot_id` chains snapshots through reopens; `cost_report.latest_snapshot_id` is the head.
// `materialized_inputs` + `worksheet_snapshot` are audit-denylisted (§3.6). ORG-SCOPED. No PHI (D18).
import { index, jsonb, pgEnum, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { costReport } from "./cost-report";
import type { SnapshotMaterializedInputs, WorksheetSnapshot } from "./types";

export const m27SnapshotReason = pgEnum("m27_snapshot_reason", [
  "submit",
  "reopen",
  "mac_revision_request",
  "admin_audit",
]);

export const costReportSnapshot = pgTable(
  "cost_report_snapshot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    costReportId: uuid("cost_report_id")
      .notNull()
      .references(() => costReport.id),
    priorSnapshotId: uuid("prior_snapshot_id"), // self-FK enforced in migration phase 3
    contentHashSha256: varchar("content_hash_sha256", { length: 64 }).notNull(),
    materializedInputs: jsonb("materialized_inputs").$type<SnapshotMaterializedInputs>().notNull(),
    worksheetSnapshot: jsonb("worksheet_snapshot").$type<WorksheetSnapshot>().notNull(),
    reason: m27SnapshotReason("reason").notNull(),
    createdByMembershipId: uuid("created_by_membership_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxOrgReport: index("idx_snapshot_org_report").on(
      t.organizationId,
      t.costReportId,
      t.createdAt,
    ),
    idxContentHash: index("idx_snapshot_content_hash").on(t.contentHashSha256),
  }),
);

export type CostReportSnapshot = typeof costReportSnapshot.$inferSelect;
export type NewCostReportSnapshot = typeof costReportSnapshot.$inferInsert;
