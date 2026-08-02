// @wardenx/db — `refund` (M35 §3.3, D16). TENANT-SCOPED, RLS on app.org_id (0143). The §D16 four-stage
// refund workflow (request → approve/deny → execute) with a step-up-audit link on approval. `organization_id`
// and every `*_by_membership_id` are logical uuids (M35-F04); `invoice_id` is a REAL FK. CHECKs enforce a
// positive amount and a ≥40-char reason detail.
import { bigint, check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { refundKind, refundStatus } from "../../enums";
import { invoice } from "./invoice";

export const refund = pgTable(
  "refund",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoice.id, { onDelete: "restrict" }),
    stripeRefundId: text("stripe_refund_id"),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    kind: refundKind("kind").notNull(),
    reasonCode: text("reason_code").notNull(),
    reasonDetail: text("reason_detail").notNull(),
    requestedByMembershipId: uuid("requested_by_membership_id").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    approvedByMembershipId: uuid("approved_by_membership_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approverStepUpAuditEventId: uuid("approver_step_up_audit_event_id"),
    deniedByMembershipId: uuid("denied_by_membership_id"),
    deniedAt: timestamp("denied_at", { withTimezone: true }),
    deniedReason: text("denied_reason"),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    status: refundStatus("status").notNull().default("requested"),
    stripeFailureCode: text("stripe_failure_code"),
  },
  (t) => ({
    invoiceIx: index("refund_invoice_ix").on(t.invoiceId),
    statusIx: index("refund_status_ix").on(t.status),
    reasonDetailMinLen: check("refund_reason_detail_min_len", sql`length(reason_detail) >= 40`),
    amountPositive: check("refund_amount_positive", sql`amount_cents > 0`),
  }),
);

export type RefundRow = typeof refund.$inferSelect;
export type NewRefundRow = typeof refund.$inferInsert;
