// @wardenx/db — M26 Cap Management §3.3 — the PS&R reconciliation cluster (CSV import + per-line variance
// queue) + the cap-year settlement (one-per-period). All NON-partitioned, all org-scoped (organization_id
// NOT NULL → canonical app.org_id RLS). The raw PS&R file is encrypted at rest via M1 per-tenant DEK (the
// file_storage_key points at MinIO); MBI / patient-identifiable payment detail never lands in a column here.
//
// CROSS-MODULE FK POLICY (architecture wins): organization_id → organization, cap_period_id → cap_period,
// and psr_import_id → cap_psr_import (intra-M26 parents) are real FKs. patient_id (M5), imported_by /
// resolved_by / proposed_by / finalized_by / step_up_session_id (M2) are LOGICAL uuid.
import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { capPeriod } from "./cap-period";
import {
  m26MacRegion,
  m26PsrParseStatus,
  m26PsrReconScope,
  m26PsrReconStatus,
  m26PsrVarianceReason,
  m26SettlementStatus,
} from "./enums";

// ---- cap_psr_import — one row per uploaded MAC PS&R CSV (dedupe by file_sha256 within org+period) ----
export const capPsrImport = pgTable(
  "cap_psr_import",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    capPeriodId: uuid("cap_period_id")
      .notNull()
      .references(() => capPeriod.id, { onDelete: "restrict" }),
    macRegion: m26MacRegion("mac_region").notNull(),
    psrPeriodFrom: date("psr_period_from").notNull(),
    psrPeriodTo: date("psr_period_to").notNull(),
    fileStorageKey: text("file_storage_key").notNull(), // MinIO object key (DEK-encrypted at rest)
    fileSha256: char("file_sha256", { length: 64 }).notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
    importedBy: uuid("imported_by").notNull(),
    parseStatus: m26PsrParseStatus("parse_status").notNull().default("queued"),
    parseError: text("parse_error"),
    beneficiaryCountPsr: integer("beneficiary_count_psr"),
    paidTotalCentsPsr: bigint("paid_total_cents_psr", { mode: "number" }),
    inpatientDaysPsr: integer("inpatient_days_psr"),
  },
  (t) => ({
    uniqFile: unique("cap_psr_import_file_uq").on(t.organizationId, t.capPeriodId, t.fileSha256),
  }),
);

// ---- cap_psr_reconciliation — per-line variance (M26 ledger vs MAC PS&R figure) ----
export const capPsrReconciliation = pgTable(
  "cap_psr_reconciliation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    capPeriodId: uuid("cap_period_id")
      .notNull()
      .references(() => capPeriod.id, { onDelete: "restrict" }),
    psrImportId: uuid("psr_import_id")
      .notNull()
      .references(() => capPsrImport.id, { onDelete: "cascade" }),
    scope: m26PsrReconScope("scope").notNull(),
    patientId: uuid("patient_id"),
    m26AccrualCents: bigint("m26_accrual_cents", { mode: "number" }),
    m26InpatientDays: integer("m26_inpatient_days"),
    psrAmountCents: bigint("psr_amount_cents", { mode: "number" }),
    psrInpatientDays: integer("psr_inpatient_days"),
    varianceCents: bigint("variance_cents", { mode: "number" }),
    varianceDays: integer("variance_days"),
    varianceReason: m26PsrVarianceReason("variance_reason"),
    status: m26PsrReconStatus("status").notNull().default("open"),
    resolvedBy: uuid("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNotes: text("resolution_notes"),
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Reconciliation workbench load: open/investigating variance lines by recency (matches migration 0086).
    open: index("cap_psr_reconciliation_open_ix")
      .on(t.organizationId, t.status, t.raisedAt)
      .where(sql`status IN ('open', 'investigating')`),
  }),
);

// ---- cap_settlement — one row per cap_period; the year-close settlement worksheet ----
export const capSettlement = pgTable(
  "cap_settlement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    capPeriodId: uuid("cap_period_id")
      .notNull()
      .references(() => capPeriod.id, { onDelete: "restrict" }),
    paidTotalCents: bigint("paid_total_cents", { mode: "number" }).notNull(),
    beneficiaryCount: integer("beneficiary_count").notNull(),
    aggregateCapAmountCents: bigint("aggregate_cap_amount_cents", { mode: "number" }).notNull(),
    aggregateOverageCents: bigint("aggregate_overage_cents", { mode: "number" }).notNull(), // signed; + = owed back
    inpatientTotalDays: integer("inpatient_total_days").notNull(),
    inpatientOverageDays: integer("inpatient_overage_days").notNull(),
    inpatientOverageCents: bigint("inpatient_overage_cents", { mode: "number" }).notNull(), // RHC differential
    status: m26SettlementStatus("status").notNull().default("proposed"),
    proposedAt: timestamp("proposed_at", { withTimezone: true }).notNull().defaultNow(),
    proposedBy: uuid("proposed_by").notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    finalizedBy: uuid("finalized_by"),
    stepUpSessionId: uuid("step_up_session_id"), // M2 evidence at finalize per D12 (logical)
    notes: text("notes"),
  },
  (t) => ({
    uniqPerPeriod: unique("cap_settlement_period_uq").on(t.capPeriodId),
  }),
);
