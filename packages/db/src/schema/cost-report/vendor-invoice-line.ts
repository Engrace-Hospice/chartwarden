// @wardenx/db — `vendor_invoice_line` (M27, F-207 #248; non-partitioned; retention class `compliance`).
// The M21 vendor-invoice forward seam (M21 spec §1.1 D16), the 4th cost-basis precedence tier additive
// to D17's M13 administration -> M12 ordered -> manual entry chain: a vendor invoice for a supply_request
// (DME/comfort-kit/general supply) M21 accrued or reconciled, resolved to the cost_report whose fiscal
// year contains the fact date. One row per (organization_id, supply_request_id); `.invoice_accrued`
// inserts, `.invoice_reconciled` updates the same row. No cross-module FK to M21 (M27's manifest carries
// no dependsOn edge to 21) — `supply_request_id`/`vendor_id` are opaque uuids. ORG-SCOPED. No PHI (D18):
// the source events are patient-scoped but patientId is never carried onto this row.
import { bigint, index, integer, pgEnum, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { costReport } from "./cost-report";

export const m27VendorInvoiceStatus = pgEnum("m27_vendor_invoice_status", ["accrued", "reconciled"]);

export const vendorInvoiceLine = pgTable(
  "vendor_invoice_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    costReportId: uuid("cost_report_id")
      .notNull()
      .references(() => costReport.id, { onDelete: "cascade" }),
    supplyRequestId: uuid("supply_request_id").notNull(),
    vendorId: uuid("vendor_id"),
    status: m27VendorInvoiceStatus("status").notNull().default("accrued"),
    accruedAmountCents: bigint("accrued_amount_cents", { mode: "number" }).notNull(),
    reconciledAmountCents: bigint("reconciled_amount_cents", { mode: "number" }),
    varianceCents: integer("variance_cents"),
    accruedAt: timestamp("accrued_at", { withTimezone: true }).notNull(),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqOrgSupplyRequest: unique("uniq_vendor_invoice_line_org_supply_request").on(
      t.organizationId,
      t.supplyRequestId,
    ),
    idxOrgReport: index("idx_vendor_invoice_line_org_report").on(t.organizationId, t.costReportId),
  }),
);

export type VendorInvoiceLine = typeof vendorInvoiceLine.$inferSelect;
export type NewVendorInvoiceLine = typeof vendorInvoiceLine.$inferInsert;
