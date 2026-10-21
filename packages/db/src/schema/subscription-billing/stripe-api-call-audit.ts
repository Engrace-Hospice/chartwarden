// @chartwarden/db — `stripe_api_call_audit` (M35 §3.3). PLATFORM-ONLY append-only ledger of every outbound
// Stripe API call. It DOES carry an `organization_id` column (nullable — some ops are platform-wide), so
// the phi-guards gate treats it as org-scoped and it gets RLS-enable + a write-audit trigger (0143), but
// it is written by the platform Stripe dispatcher, not by tenant requests. The request/response envelopes
// are stored ALREADY redacted (the §8.7 redactor strips secrets before they reach this row).
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const stripeApiCallAudit = pgTable(
  "stripe_api_call_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stripeIdempotencyKey: text("stripe_idempotency_key").notNull(),
    operation: text("operation").notNull(),
    targetResourceId: text("target_resource_id"),
    organizationId: uuid("organization_id"),
    requestEnvelopeRedacted: jsonb("request_envelope_redacted").notNull(),
    responseStatusCode: integer("response_status_code"),
    responseEnvelopeRedacted: jsonb("response_envelope_redacted"),
    calledAt: timestamp("called_at", { withTimezone: true }).notNull().defaultNow(),
    latencyMs: integer("latency_ms"),
    attemptIndex: integer("attempt_index").notNull().default(0),
    errorText: text("error_text"),
  },
  (t) => ({
    idemKeyUq: uniqueIndex("stripe_api_call_audit_idem_uq").on(t.stripeIdempotencyKey),
    operationCalledIx: index("stripe_api_call_audit_op_called_ix").on(t.operation, t.calledAt),
    orgIx: index("stripe_api_call_audit_org_ix").on(t.organizationId, t.calledAt),
  }),
);

export type StripeApiCallAuditRow = typeof stripeApiCallAudit.$inferSelect;
export type NewStripeApiCallAuditRow = typeof stripeApiCallAudit.$inferInsert;
