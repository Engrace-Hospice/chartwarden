import { sql } from "drizzle-orm";
// @wardenx/db — `evv_aggregator_submission` (M18 §3.3 / §2.2.5 D7). The per-state aggregator submission state
// machine (pending → queued → submitting → submitted → accepted | rejected | timeout | cancelled); resubmit
// only from rejected/timeout, cancel only from non-terminal states. Idempotency on (state_code, visit_id,
// event_pair_hash). Org-scoped (no `patient_id` column — joinable to PHI only via `visit_id`). The submission
// `payload_cipher` / `aggregator_response_cipher` (large, encrypted) and the free-text
// `aggregator_rejection_reason` / `cancellation_reason` are DENYLISTED from audit (§3.6). RLS + grants + M4
// write-audit trigger land in the RLS migration (M18-T02 / 0047).
import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { evvAggregatorSubmissionStatus } from "../../enums";
import { organizations } from "../organizations";

export const evvAggregatorSubmission = pgTable(
  "evv_aggregator_submission",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),

    visitId: uuid("visit_id").notNull(), // M17 visit (app-validated; no cross-module FK)
    checkInEventId: uuid("check_in_event_id"), // logical FK to evv_event (partitioned → plain uuid)
    checkOutEventId: uuid("check_out_event_id"),
    eventPairHash: text("event_pair_hash"), // SHA-256(check_in_id || check_out_id); set at submission-prep

    stateCode: text("state_code").notNull(), // 'WI', 'NY', etc.; resolved via M40
    aggregatorVendor: text("aggregator_vendor").notNull(), // 'sandata' | 'hhaexchange' | 'open_model' | …

    status: evvAggregatorSubmissionStatus("status").notNull().default("pending"),
    payloadCipher: text("payload_cipher"), // submission body, encrypted at rest; DENYLISTED (§3.6)
    payloadDekVersion: integer("payload_dek_version"),

    // Adapter call instrumentation:
    attemptCount: integer("attempt_count").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),

    // Vendor response:
    aggregatorTransactionId: text("aggregator_transaction_id"),
    aggregatorResponseCipher: text("aggregator_response_cipher"), // last response, encrypted; DENYLISTED (§3.6)
    aggregatorResponseAt: timestamp("aggregator_response_at", { withTimezone: true }),
    aggregatorRejectionCode: text("aggregator_rejection_code"),
    aggregatorRejectionReason: text("aggregator_rejection_reason"), // free-text; DENYLISTED (§3.6)

    // Operator action audit:
    cancelledByMembershipId: uuid("cancelled_by_membership_id"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancellationReason: text("cancellation_reason"), // DENYLISTED (§3.6)

    resubmitTriggeredByMembershipId: uuid("resubmit_triggered_by_membership_id"),
    resubmitTriggeredAt: timestamp("resubmit_triggered_at", { withTimezone: true }),

    version: bigint("version", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One active submission per (state, visit) (§3.2 Phase E).
    stateVisitActive: uniqueIndex("evv_aggregator_submission_state_visit_active_uidx")
      .on(t.organizationId, t.stateCode, t.visitId)
      .where(sql`status != 'cancelled'`),
    // The BullMQ worker's retry-due pickup query (§3.4).
    orgStatusRetry: index("evv_aggregator_submission_org_status_retry_idx")
      .on(t.organizationId, t.status, t.nextRetryAt)
      .where(sql`status IN ('queued', 'rejected', 'timeout')`),
    orgVendorState: index("evv_aggregator_submission_org_vendor_state_idx").on(
      t.organizationId,
      t.aggregatorVendor,
      t.status,
    ),
  }),
);

export type EvvAggregatorSubmission = typeof evvAggregatorSubmission.$inferSelect;
export type NewEvvAggregatorSubmission = typeof evvAggregatorSubmission.$inferInsert;
