// @chartwarden/db — `election_period` (M6 §3.3). The benefit-period ledger hanging off an admission
// (90/90/60/60…). Org-scoped (no direct patient identifier; tenancy via the admission FK).
// `election_statement_id` / `cti_id` are deferred FKs installed in the migration once both child
// tables exist (avoids a TS import cycle); `completed_by_event_id` is a logical FK whose target
// varies by cause. RLS + the M4 write-audit trigger land in M6-T03 (§3.6–3.7).
import {
  bigint,
  date,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { businessRule } from "../../business-rules";
import {
  electionPeriodCompletionCause,
  electionPeriodKind,
  electionPeriodStatus,
} from "../../enums";
import { organizations } from "../organizations";
import { admissions } from "./admissions";

// Registered business rules (Bug 4): a `23505` on these indexes — two writers racing past the service's
// own pre-check — answers 409 with this sentence instead of a bare 500 (the F-022 / #55 convention).
// Declared outside `pgTable`'s lazily-invoked config callback so the error handler can see them.
const ELECTION_PERIOD_ADMISSION_SEQ_IDX = businessRule(
  "election_period_admission_seq_idx",
  "This admission already has a benefit period with that sequence number. Reload the admission and review its benefit periods.",
);

export const electionPeriods = pgTable(
  "election_period",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    admissionId: uuid("admission_id")
      .notNull()
      .references(() => admissions.id, { onDelete: "restrict" }),
    sequenceNumber: smallint("sequence_number").notNull(),
    periodKind: electionPeriodKind("period_kind").notNull(),
    effectiveAt: date("effective_at"),
    scheduledEndAt: date("scheduled_end_at"),
    actualEndAt: date("actual_end_at"),
    status: electionPeriodStatus("status").notNull().default("pending"),
    // Deferred FKs to election_statement / cti — enforced in the migration after both tables exist.
    electionStatementId: uuid("election_statement_id"),
    ctiId: uuid("cti_id"),
    completedByCause: electionPeriodCompletionCause("completed_by_cause"),
    completedByEventId: uuid("completed_by_event_id"), // FK varies by cause; left logical, not enforced
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0),
    // F-223 — the triggering M11 `order_record.id` (logical uuid, no SQL FK: M6's dependsOn excludes M11).
    // NULL for every period opened by the HTTP route; only the order-triggered consumer sets it.
    sourceOrderId: uuid("source_order_id"),
    // F-226 — the benefit period's EXPECTED first day (org-local calendar date): the preceding period's
    // `scheduled_end_at` + 1 day, stamped when a PENDING period is opened (benefit periods are contiguous,
    // 42 CFR 418.21(a); M6 §2.3.2 `setActive`: "previous period.actual_end_at + 1 day"). A pending period
    // has no `effective_at` until activation, so this is the only anchor the F2F prior-to window
    // [start-30, start-1] (R-F2F-02) can be computed against at F2F-completion time. NULL when the
    // preceding period has no scheduled end yet (not derivable) and for every activated/legacy period.
    expectedStart: date("expected_start"),
    // Migration 0373 — how an admission's FIRST period number was established (readmission workflow). A new
    // admission elects into the next AVAILABLE benefit period (42 CFR 418.21 / 418.24; per beneficiary across all
    // hospices, Claims Processing Manual ch. 11 §20.1.6), so staff enter it — confirmed against HETS / ELGA / ELGH
    // where possible — with our own history only as the suggestion. NULL on every later period and historic rows.
    benefitPeriodSource: text("benefit_period_source", {
      enum: ["hets_confirmed", "staff_entered_unverified", "internal_history"],
    }),
    benefitPeriodSuggested: smallint("benefit_period_suggested"),
    benefitPeriodConfirmedBy: uuid("benefit_period_confirmed_by"), // acting user (logical)
    benefitPeriodConfirmedOn: date("benefit_period_confirmed_on"), // hets_confirmed only
    // Migration 0373 — MBPM ch. 9 §20.1(5)(d): a NEW admission in period 3+ with documented exceptional
    // circumstances may have its F2F within 2 days after admission (a death within them deems it complete).
    f2fExceptionReason: text("f2f_exception_reason"),
    f2fExceptionDocumentedBy: uuid("f2f_exception_documented_by"), // acting user (logical)
    f2fExceptionDocumentedAt: timestamp("f2f_exception_documented_at", { withTimezone: true }),
  },
  (t) => ({
    admSeqUnique: uniqueIndex(ELECTION_PERIOD_ADMISSION_SEQ_IDX).on(
      t.admissionId,
      t.sequenceNumber,
    ),
    admIdx: index("election_period_admission_idx").on(t.admissionId, t.sequenceNumber),
    sourceOrderUq: unique("election_period_source_order_id_uq").on(
      t.organizationId,
      t.sourceOrderId,
    ),
  }),
);

export type ElectionPeriod = typeof electionPeriods.$inferSelect;
export type NewElectionPeriod = typeof electionPeriods.$inferInsert;
