// @wardenx/db — `invoice_line` (M35 §3.3). TENANT-SCOPED, RLS on app.org_id (0143). `organization_id`
// is a logical uuid (M35-F04). `invoice_id` is a REAL FK; `plan_meter_id` is a REAL FK (set null on meter
// deletion). Copied to `platform_retained_invoice_line` on offboarding (§3.7).
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
import { invoiceLineKind, usageEventType } from "../../enums";
import { invoice } from "./invoice";
import { planMeter } from "./plan-meter";

export const invoiceLine = pgTable(
  "invoice_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoice.id, { onDelete: "restrict" }),
    stripeLineId: text("stripe_line_id").notNull(),
    kind: invoiceLineKind("kind").notNull(),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull().default(1),
    unitAmountCents: bigint("unit_amount_cents", { mode: "number" }).notNull().default(0),
    totalCents: bigint("total_cents", { mode: "number" }).notNull().default(0),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    meterEventType: usageEventType("meter_event_type"),
    planMeterId: uuid("plan_meter_id").references(() => planMeter.id, { onDelete: "set null" }),
  },
  (t) => ({
    stripeLineUq: uniqueIndex("invoice_line_stripe_line_uq").on(t.stripeLineId),
    invoiceIx: index("invoice_line_invoice_ix").on(t.invoiceId),
  }),
);

export type InvoiceLineRow = typeof invoiceLine.$inferSelect;
export type NewInvoiceLineRow = typeof invoiceLine.$inferInsert;
