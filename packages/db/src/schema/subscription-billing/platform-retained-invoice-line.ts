// @wardenx/db — `platform_retained_invoice_line` (M35 §3.7, M35-F06). PLATFORM-ONLY, NOT tenant-scoped.
// Line rows copied from the tenant-scoped `invoice_line` table alongside their parent invoice on tenant
// offboarding. `retained_invoice_id` is a REAL FK to the parent `platform_retained_invoice`. The
// `original_*` columns are forensic cross-refs only. 7-year IRS §6001 retention floor per D13.
import { bigint, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { invoiceLineKind, usageEventType } from "../../enums";
import { platformRetainedInvoice } from "./platform-retained-invoice";

export const platformRetainedInvoiceLine = pgTable(
  "platform_retained_invoice_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    originalInvoiceLineId: uuid("original_invoice_line_id").notNull(),
    retainedInvoiceId: uuid("retained_invoice_id")
      .notNull()
      .references(() => platformRetainedInvoice.id, { onDelete: "restrict" }),
    originalInvoiceId: uuid("original_invoice_id").notNull(),
    originalOrganizationId: uuid("original_organization_id").notNull(),
    transferredAt: timestamp("transferred_at", { withTimezone: true }).notNull().defaultNow(),
    retainUntil: timestamp("retain_until", { withTimezone: true }).notNull(),
    stripeLineId: text("stripe_line_id").notNull(),
    kind: invoiceLineKind("kind").notNull(),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull().default(1),
    unitAmountCents: bigint("unit_amount_cents", { mode: "number" }).notNull().default(0),
    totalCents: bigint("total_cents", { mode: "number" }).notNull().default(0),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    meterEventType: usageEventType("meter_event_type"),
  },
  (t) => ({
    retainedInvoiceIx: index("platform_retained_invoice_line_invoice_ix").on(t.retainedInvoiceId),
  }),
);

export type PlatformRetainedInvoiceLineRow = typeof platformRetainedInvoiceLine.$inferSelect;
export type NewPlatformRetainedInvoiceLineRow = typeof platformRetainedInvoiceLine.$inferInsert;
