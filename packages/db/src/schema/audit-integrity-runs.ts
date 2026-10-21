// @chartwarden/db — `audit_integrity_run` (M4 Audit §4.4, migration 0510). One append-only row per sampled
// audit hash-chain verification (or seal run): when, what was checked, and the result. The record behind
// `GET /api/v1/audit/integrity/report`'s `sealChain` / `integritySample` sections. Org-scoped, not PHI —
// `detail` holds partition names, reasons and counts only.
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const AUDIT_INTEGRITY_RESULTS = ["match", "mismatch", "skipped", "error"] as const;
export const AUDIT_INTEGRITY_KINDS = ["sample", "seal"] as const;
export type AuditIntegrityKind = (typeof AUDIT_INTEGRITY_KINDS)[number];
export type AuditIntegrityResult = (typeof AUDIT_INTEGRITY_RESULTS)[number];

export const auditIntegrityRuns = pgTable(
  "audit_integrity_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    kind: text("kind").$type<AuditIntegrityKind>().notNull().default("sample"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull().defaultNow(),
    result: text("result").$type<AuditIntegrityResult>().notNull(),
    partitionsSealed: integer("partitions_sealed").notNull().default(0),
    sealsTotal: integer("seals_total").notNull().default(0),
    sealsSampled: integer("seals_sampled").notNull().default(0),
    eventsHashed: integer("events_hashed").notNull().default(0),
    mismatches: integer("mismatches").notNull().default(0),
    backupCrossReference: text("backup_cross_reference")
      .notNull()
      .default("unavailable_no_backup_reader"),
    detail: jsonb("detail").notNull().default({}),
  },
  (t) => ({
    orgFinishedIdx: index("audit_integrity_run_org_finished_idx").on(
      t.organizationId,
      sql`${t.finishedAt} DESC`,
    ),
    kindChk: check("audit_integrity_run_kind_chk", sql`${t.kind} IN ('sample', 'seal')`),
    resultChk: check(
      "audit_integrity_run_result_chk",
      sql`${t.result} IN ('match', 'mismatch', 'skipped', 'error')`,
    ),
  }),
);

export type AuditIntegrityRun = typeof auditIntegrityRuns.$inferSelect;
export type NewAuditIntegrityRun = typeof auditIntegrityRuns.$inferInsert;
