// @wardenx/db — M26 Cap Management §3.3 — the per-beneficiary + inpatient accrual ledger. Each aggregate
// roll-up (cap_beneficiary_accrual one-per-(org,period,patient); cap_inpatient_accrual one-per-(org,period))
// is fed by an append-only line table. The two line tables are LIST-partitioned on cap_period_id (§3.2) so a
// settled cap year can be ATTACH/DETACH-archived without disturbing live data. The Drizzle pgTable carries
// LOGICAL shape only — the composite PK (id, cap_period_id), the LIST partition DDL + DEFAULT partition, the
// per-leaf unique backstops, RLS, grants, and the M4 write-audit triggers land in the SQL migrations 0086/0087.
//
// CROSS-MODULE FK POLICY (architecture wins): only organization_id → organization and cap_period_id →
// cap_period (non-partitioned parent) are real FKs. patient_id (M5), source_id (M25 remittance line / M23
// claim line), reversal_of_line_id (intra-M26 partitioned self-ref) are LOGICAL uuid. mbi_normalized is a
// canonicalized join key (M40), never an MBI value captured to the audit log (D13).
import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { capPeriod } from "./cap-period";
import { m26InpatientSourceKind, m26LineSourceKind } from "./enums";

// ---- cap_beneficiary_accrual — one row per (org, period, patient); the paid-to-date roll-up ----
export const capBeneficiaryAccrual = pgTable(
  "cap_beneficiary_accrual",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    capPeriodId: uuid("cap_period_id")
      .notNull()
      .references(() => capPeriod.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // M5 logical FK
    mbiNormalized: text("mbi_normalized").notNull(), // canonical via M40 (join key, not audit-captured)
    paidCents: bigint("paid_cents", { mode: "number" }).notNull().default(0),
    outstandingBilledCents: bigint("outstanding_billed_cents", { mode: "number" })
      .notNull()
      .default(0),
    methodologyWeight: numeric("methodology_weight", { precision: 7, scale: 6 })
      .notNull()
      .default("1.000000"),
    firstElectionInPeriod: date("first_election_in_period").notNull(),
    lastPaidThrough: date("last_paid_through"),
    deceasedAt: date("deceased_at"),
    lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqByPeriodPatient: unique("cap_ben_accrual_period_patient_uq").on(
      t.organizationId,
      t.capPeriodId,
      t.patientId,
    ),
  }),
);

// ---- cap_beneficiary_accrual_line — append-only; LIST-partitioned on cap_period_id ----
export const capBeneficiaryAccrualLine = pgTable(
  "cap_beneficiary_accrual_line",
  {
    id: uuid("id").primaryKey().defaultRandom(), // composite PK (id, cap_period_id) declared in SQL
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    capPeriodId: uuid("cap_period_id").notNull(), // partition key + logical FK → cap_period
    patientId: uuid("patient_id").notNull(),
    sourceKind: m26LineSourceKind("source_kind").notNull(),
    sourceId: uuid("source_id").notNull(), // M25 remittance_line.id / adjustment id (logical)
    sourceLineSeq: integer("source_line_seq").notNull().default(0),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(), // signed; reversal negative
    serviceFrom: date("service_from").notNull(),
    serviceTo: date("service_to").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    recordedBy: uuid("recorded_by"), // null for system; NOT NULL for manual_correction (CHECK)
    reversalOfLineId: uuid("reversal_of_line_id"), // intra-M26 logical self-ref
    reason: text("reason"),
  },
  (t) => ({
    uniqSource: unique("cap_ben_accrual_line_source_uq").on(
      t.capPeriodId,
      t.sourceKind,
      t.sourceId,
      t.sourceLineSeq,
    ),
    byPeriodPatient: index("cap_ben_accrual_line_period_patient_ix").on(
      t.capPeriodId,
      t.patientId,
      t.postedAt,
    ),
    ckServiceDates: check("cap_ben_accrual_line_dates_ck", sql`${t.serviceTo} >= ${t.serviceFrom}`),
    ckManualRequiresRecordedBy: check(
      "cap_ben_accrual_line_manual_ck",
      sql`${t.sourceKind} <> 'manual_correction' OR ${t.recordedBy} IS NOT NULL`,
    ),
  }),
);

// ---- cap_inpatient_accrual — one row per (org, period); GIP+IRC days over the 20% denominator ----
export const capInpatientAccrual = pgTable(
  "cap_inpatient_accrual",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    capPeriodId: uuid("cap_period_id")
      .notNull()
      .references(() => capPeriod.id, { onDelete: "restrict" }),
    gipDays: integer("gip_days").notNull().default(0),
    ircDays: integer("irc_days").notNull().default(0),
    totalPatientDays: integer("total_patient_days").notNull().default(0), // denominator: all LOC days
    inpatientPct: numeric("inpatient_pct", { precision: 7, scale: 4 }).notNull().default("0.0000"),
    lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqByOrgPeriod: unique("cap_inpatient_accrual_uq").on(t.organizationId, t.capPeriodId),
  }),
);

// ---- cap_inpatient_day_line — append-only; LIST-partitioned on cap_period_id ----
export const capInpatientDayLine = pgTable(
  "cap_inpatient_day_line",
  {
    id: uuid("id").primaryKey().defaultRandom(), // composite PK (id, cap_period_id) declared in SQL
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    capPeriodId: uuid("cap_period_id").notNull(), // partition key + logical FK → cap_period
    patientId: uuid("patient_id").notNull(),
    sourceKind: m26InpatientSourceKind("source_kind").notNull().default("claim_line"),
    sourceId: uuid("source_id").notNull(), // M23 claim_line.id (logical)
    revCode: char("rev_code", { length: 4 }).notNull(), // '0655' IRC | '0656' GIP
    days: smallint("days").notNull(),
    serviceFrom: date("service_from").notNull(),
    serviceTo: date("service_to").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    recordedBy: uuid("recorded_by"),
  },
  (t) => ({
    uniqSource: unique("cap_inp_day_line_source_uq").on(
      t.capPeriodId,
      t.sourceKind,
      t.sourceId,
      t.revCode,
    ),
    byPeriod: index("cap_inp_day_line_period_ix").on(t.capPeriodId, t.serviceFrom),
  }),
);
