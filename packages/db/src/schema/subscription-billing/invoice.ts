// @wardenx/db — `invoice` (M35 §3.3). TENANT-SCOPED, RLS on app.org_id (0143). Stripe-authoritative
// mirror. `organization_id` is a logical uuid (M35-F04). `subscription_id` is a REAL FK (nullable —
// one-off invoices). On tenant offboarding the eraser COPIES these rows into `platform_retained_invoice`
// (7-year retention) then deletes them (§3.7, copy-then-delete).
import { bigint, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { invoiceStatus } from "../../enums";
import { subscriptionRow } from "./subscription";

export const invoice = pgTable(
  "invoice",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    subscriptionId: uuid("subscription_id").references(() => subscriptionRow.id, {
      onDelete: "restrict",
    }),
    stripeInvoiceId: text("stripe_invoice_id").notNull(),
    invoiceNumber: text("invoice_number"),
    status: invoiceStatus("status").notNull().default("draft"),
    subtotalCents: bigint("subtotal_cents", { mode: "number" }).notNull().default(0),
    taxCents: bigint("tax_cents", { mode: "number" }).notNull().default(0),
    totalCents: bigint("total_cents", { mode: "number" }).notNull().default(0),
    amountPaidCents: bigint("amount_paid_cents", { mode: "number" }).notNull().default(0),
    amountDueCents: bigint("amount_due_cents", { mode: "number" }).notNull().default(0),
    currencyCode: text("currency_code").notNull().default("USD"),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    hostedInvoiceUrl: text("hosted_invoice_url"),
    invoicePdfUrl: text("invoice_pdf_url"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    stripeInvoiceUq: uniqueIndex("invoice_stripe_invoice_uq").on(t.stripeInvoiceId),
    orgStatusIx: index("invoice_org_status_ix").on(t.organizationId, t.status),
    invoiceNumberIx: index("invoice_number_ix").on(t.invoiceNumber),
  }),
);

export type InvoiceRow = typeof invoice.$inferSelect;
export type NewInvoiceRow = typeof invoice.$inferInsert;
