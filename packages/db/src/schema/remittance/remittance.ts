import { sql } from "drizzle-orm";
// @chartwarden/db — M25 Remittance & Denials §3.3 — the four-level X12 5010 835 posting hierarchy:
//   remittance_advice (envelope, one per 835 transaction)
//     └─ remittance_line (one per CLP claim-payment segment; auto-matched to an M23 claim)
//          ├─ remittance_service_line (one per SVC sub-segment)
//          ├─ remittance_adjustment (one per CAS segment — claim- OR service-line level)
//          └─ remittance_remark (one per LQ/MIA/MOA segment)
//
// PARTITIONING (D11): remittance_line / remittance_service_line / remittance_adjustment /
// remittance_remark are MONTHLY RANGE-partitioned on received_at. The Drizzle pgTable below carries the
// LOGICAL shape only — the composite PK `(id, received_at)`, the RANGE partition DDL, per-leaf unique
// backstops, and the monthly rotation land in the SQL migration (0081+), mirroring the M30
// incident_report precedent. remittance_advice is NON-partitioned (low row count, the envelope head).
//
// CROSS-MODULE FK POLICY (architecture WINS over the spec DDL): only `organization_id` → organizations
// gets a real `.references(...)`. `provider_entity_id` (M40/M2), `payer_id` (M40), `claim_id` (M23),
// and the partitioned-table parent ids (remittance_advice_id / remittance_line_id /
// remittance_service_line_id) are LOGICAL uuid FKs — a real FK onto a RANGE-partitioned parent would
// have to carry the partition key, so those constraints live (where safe) in SQL, not Drizzle.
// No MBI is ever stored (D13); free_text / patient-identifier columns are audit-denylisted (§3.6).
import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import {
  m25CasGroupCode,
  m25MatchState,
  m25MatchStrategy,
  m25ParseStatus,
  m25PayerKind,
  m25PaymentMethodKind,
  m25PostAction,
  m25RemarkKind,
  m25TaxonomyStatus,
} from "./enums";

// ---- remittance_advice (envelope) — NON-partitioned ----
export const remittanceAdvice = pgTable(
  "remittance_advice",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(), // logical FK → M40/M2
    payerId: uuid("payer_id").notNull(), // logical FK → M40 PayerEntity
    payerKind: m25PayerKind("payer_kind").notNull(),
    interchangeControlNumber: varchar("interchange_control_number", { length: 9 }).notNull(), // ISA13
    transactionSetControlNumber: varchar("transaction_set_control_number", { length: 9 }).notNull(), // ST02
    checkOrEftTraceNumber: varchar("check_or_eft_trace_number", { length: 50 }), // TRN02
    paymentMethod: m25PaymentMethodKind("payment_method").notNull(),
    totalPaymentAmount: numeric("total_payment_amount", { precision: 12, scale: 2 }).notNull(),
    productionDate: timestamp("production_date", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    minioObjectKey: varchar("minio_object_key", { length: 500 }).notNull(),
    fileSha256: varchar("file_sha256", { length: 64 }).notNull(),
    parseStatus: m25ParseStatus("parse_status").notNull().default("queued"),
    parseSummary: jsonb("parse_summary"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // 835 envelope uniqueness — duplicate file delivery rejected at insert (§2.3, §2.6)
    envelopeUnique: unique("ux_remittance_envelope_dedupe").on(
      t.interchangeControlNumber,
      t.transactionSetControlNumber,
      t.providerEntityId,
    ),
    byProviderEntity: index("ix_remittance_advice_pe_received").on(
      t.providerEntityId,
      t.receivedAt,
    ),
    byPayer: index("ix_remittance_advice_payer").on(t.payerId, t.receivedAt),
    byParseStatus: index("ix_remittance_advice_parse_status")
      .on(t.parseStatus)
      .where(sql`parse_status <> 'posted'`),
  }),
);

// ---- remittance_line (monthly partitioned by received_at) ----
export const remittanceLine = pgTable(
  "remittance_line",
  {
    id: uuid("id").primaryKey().defaultRandom(), // composite PK (id, received_at) declared in SQL
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    remittanceAdviceId: uuid("remittance_advice_id").notNull(), // logical FK → remittance_advice
    claimId: uuid("claim_id"), // M23 logical FK (nullable until matched)
    clp01PatientControlNumber: varchar("clp01_patient_control_number", { length: 38 }),
    clp07PayerIcn: varchar("clp07_payer_icn", { length: 38 }),
    clp02StatusCode: smallint("clp02_status_code").notNull(),
    clp03TotalChargeAmount: numeric("clp03_total_charge_amount", {
      precision: 12,
      scale: 2,
    }).notNull(),
    clp04TotalPaymentAmount: numeric("clp04_total_payment_amount", {
      precision: 12,
      scale: 2,
    }).notNull(),
    clp05PatientResponsibilityAmount: numeric("clp05_patient_responsibility_amount", {
      precision: 12,
      scale: 2,
    })
      .notNull()
      .default("0"),
    matchState: m25MatchState("match_state").notNull().default("unmatched"),
    matchStrategy: m25MatchStrategy("match_strategy"),
    matchConfidence: smallint("match_confidence"),
    matchedAt: timestamp("matched_at", { withTimezone: true }),
    matchedByMembershipId: uuid("matched_by_membership_id"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(), // partition key (denormalized from advice)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byAdvice: index("ix_remittance_line_advice").on(t.remittanceAdviceId),
    byClaim: index("ix_remittance_line_claim").on(t.claimId).where(sql`claim_id IS NOT NULL`),
    byPayerIcn: index("ix_remittance_line_payer_icn")
      .on(t.clp07PayerIcn)
      .where(sql`clp07_payer_icn IS NOT NULL`),
    byMatchState: index("ix_remittance_line_match_state").on(t.matchState),
  }),
);

// ---- remittance_service_line (monthly partitioned by received_at) ----
export const remittanceServiceLine = pgTable(
  "remittance_service_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    remittanceLineId: uuid("remittance_line_id").notNull(), // logical FK → remittance_line (partitioned)
    svc01ProcedureCode: varchar("svc01_procedure_code", { length: 12 }), // HCPCS
    svc01RevenueCode: varchar("svc01_revenue_code", { length: 4 }), // UB-04 revenue code
    svc02ChargeAmount: numeric("svc02_charge_amount", { precision: 12, scale: 2 }).notNull(),
    svc03PaidAmount: numeric("svc03_paid_amount", { precision: 12, scale: 2 }).notNull(),
    svc05PaidUnits: smallint("svc05_paid_units"),
    svc07SubmittedUnits: smallint("svc07_submitted_units"),
    claimLineRef: jsonb("claim_line_ref"), // { claim_id, line_seq } — M23 forward composite
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(), // partition key
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byLine: index("ix_remittance_svcline_line").on(t.remittanceLineId),
  }),
);

// ---- remittance_adjustment (monthly partitioned by received_at) ----
export const remittanceAdjustment = pgTable(
  "remittance_adjustment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    remittanceLineId: uuid("remittance_line_id"), // claim-level CAS (xor with svc-line)
    remittanceServiceLineId: uuid("remittance_service_line_id"), // service-line-level CAS
    casGroupCode: m25CasGroupCode("cas_group_code").notNull(),
    casReasonCode: varchar("cas_reason_code", { length: 8 }).notNull(), // CARC
    adjustmentAmount: numeric("adjustment_amount", { precision: 12, scale: 2 }).notNull(),
    adjustmentQuantity: smallint("adjustment_quantity"),
    postAction: m25PostAction("post_action").notNull(),
    taxonomyStatus: m25TaxonomyStatus("taxonomy_status").notNull(),
    denialCaseId: uuid("denial_case_id"), // logical FK → denial_case (if seeded)
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(), // partition key
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byLine: index("ix_adjustment_line")
      .on(t.remittanceLineId)
      .where(sql`remittance_line_id IS NOT NULL`),
    bySvcLine: index("ix_adjustment_svcline")
      .on(t.remittanceServiceLineId)
      .where(sql`remittance_service_line_id IS NOT NULL`),
    byCarc: index("ix_adjustment_carc").on(t.casReasonCode),
    byDenialCase: index("ix_adjustment_denial_case")
      .on(t.denialCaseId)
      .where(sql`denial_case_id IS NOT NULL`),
    // CHECK ((remittance_line_id IS NULL) <> (remittance_service_line_id IS NULL)) in SQL (xor)
  }),
);

// ---- remittance_remark (monthly partitioned by received_at) ----
export const remittanceRemark = pgTable(
  "remittance_remark",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    remittanceLineId: uuid("remittance_line_id"),
    remittanceServiceLineId: uuid("remittance_service_line_id"),
    remarkKind: m25RemarkKind("remark_kind").notNull(),
    remarkCode: varchar("remark_code", { length: 8 }).notNull(), // RARC
    freeText: varchar("free_text", { length: 2000 }), // denylisted in audit (§3.6)
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(), // partition key
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byLine: index("ix_remark_line")
      .on(t.remittanceLineId)
      .where(sql`remittance_line_id IS NOT NULL`),
    byRarc: index("ix_remark_rarc").on(t.remarkCode),
  }),
);
