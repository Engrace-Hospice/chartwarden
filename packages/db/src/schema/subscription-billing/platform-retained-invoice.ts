// @wardenx/db — `platform_retained_invoice` (M35 §3.7, M35-F06 / ARCH-186/085/251). PLATFORM-ONLY, NOT
// tenant-scoped. Holds invoice rows COPIED out of the tenant-scoped `invoice` table on tenant offboarding
// (copy-then-delete, NEVER an in-place organization_id rewrite). `original_organization_id` is forensic
// traceability only (no `\borganization_id\b` word boundary → listed in NON_ORG_SCOPED; the phi-guards
// gate still sees the `organization_id` substring, so it gets RLS-enable + a write-audit trigger in 0143).
// 7-year IRS §6001 retention floor per D13.
import { bigint, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { invoiceStatus } from "../../enums";

export const platformRetainedInvoice = pgTable("platform_retained_invoice", {
  id: uuid("id").primaryKey().defaultRandom(),
  originalInvoiceId: uuid("original_invoice_id").notNull(),
  originalOrganizationId: uuid("original_organization_id").notNull(),
  transferredAt: timestamp("transferred_at", { withTimezone: true }).notNull().defaultNow(),
  retainUntil: timestamp("retain_until", { withTimezone: true }).notNull(),
  stripeInvoiceId: text("stripe_invoice_id").notNull(),
  invoiceNumber: text("invoice_number"),
  status: invoiceStatus("status").notNull(),
  subtotalCents: bigint("subtotal_cents", { mode: "number" }).notNull(),
  taxCents: bigint("tax_cents", { mode: "number" }).notNull(),
  totalCents: bigint("total_cents", { mode: "number" }).notNull(),
  amountPaidCents: bigint("amount_paid_cents", { mode: "number" }).notNull(),
  currencyCode: text("currency_code").notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }),
  periodEnd: timestamp("period_end", { withTimezone: true }),
  issuedAt: timestamp("issued_at", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
});

export type PlatformRetainedInvoiceRow = typeof platformRetainedInvoice.$inferSelect;
export type NewPlatformRetainedInvoiceRow = typeof platformRetainedInvoice.$inferInsert;
