// apps/backend/src/modules/27-cost-report/outbox-consumers/m21-vendor-invoice.ts — F-207 (#248): the
// M21 vendor-invoice forward seam (M21 spec §1.1 D16). `m21.supply_request.invoice_accrued`/
// `.invoice_reconciled` declared m27 a consumer since M21 locked; nothing ever subscribed
// (`scripts/outbox-deferred-consumers.ts`, m27 `handlers-unbound` group).
//
// THE 4TH COST-BASIS PRECEDENCE TIER. D17 (M27 spec) already ranks M13 administration ▸ M12 ordered ▸
// manual entry for drug-cost lines. An M21 vendor invoice (DME/comfort-kit restock/general supply) is a
// real, EHR-tracked cost fact that none of those three cover — it is not an administration or an order,
// and it is not yet reflected in the Xero-derived trial balance either (the invoice was just accrued in
// M21, independent of when/whether it lands in the GL). `vendor_invoice_line` (migration 0276) is the
// durable SOURCE row for this 4th, LAST-ranked tier: a lump per-supply-request invoice total cannot be
// attributed to a specific patient's specific dose the way M13/M12 can, so it only fills the residual
// gap the other three leave — it is a reference source a human preparer consults when populating
// Worksheet A/B (no worksheet in this codebase auto-computes from ANY source today, confirmed directly:
// `putWorksheet` accepts caller-supplied data wholesale), the same "layered, never overwritten" shape
// D17 already uses for the drug-cost source tooltip.
//
// FISCAL-YEAR RESOLUTION. Both events carry `providerEntityId` + a fact date but no `costReportId` —
// they fire continuously all year, unlike `bad_debt_record`'s human entry against an already-open
// report. Resolved here to the `cost_report` row whose `[fiscal_year_start_date, fiscal_year_end_date]`
// window contains the fact date, scoped by `provider_entity_id` (D1's composite-uniqueness anchor). A
// fact landing outside every existing cost report's window (no report open yet for that year) THROWS —
// a dead letter, not a guess; there is nothing honest to attach the fact to yet.
//
// IDEMPOTENT BY CONSTRUCTION. One row per `(organization_id, supply_request_id)`. `.invoice_accrued`
// INSERTs `ON CONFLICT DO NOTHING` (the accrual fact never changes once written — a redelivery is a
// no-op). `.invoice_reconciled` UPDATEs the same row guarded on `status = 'accrued'` (the F-158
// `WHERE ... IS NULL` idempotency-guard shape restated on an enum): a redelivery after reconciliation
// already landed matches zero rows and does nothing; one that arrives before the matching accrual has
// been consumed throws, same as an unresolvable fiscal year — the dispatcher's retry catches up once
// the accrual lands (outbox delivery is at-least-once, not ordered across aggregates).
//
// No cross-module import: M27's manifest carries no `dependsOn` edge to 21 (`architecture/module-
// manifest.ts`), so both event names are STRING literals and the payload is read structurally, the
// `buildM27DocumentBackrefConsumer` precedent for a module M27 has no compile edge to.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, gte, lte } from "drizzle-orm";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";

const CR = schema.costReport;
const VIL = schema.vendorInvoiceLine;

export const M27_VENDOR_INVOICE_CONSUMER = {
  eventNames: [
    "m21.supply_request.invoice_accrued",
    "m21.supply_request.invoice_reconciled",
  ] as const,
  consumerName: "m27.m21-vendor-invoice",
} as const;

interface InvoiceAccruedPayload {
  readonly providerEntityId?: unknown;
  readonly supplyRequestId?: unknown;
  readonly vendorId?: unknown;
  readonly invoiceTotalCents?: unknown;
  readonly accruedAt?: unknown;
}

interface InvoiceReconciledPayload {
  readonly providerEntityId?: unknown;
  readonly supplyRequestId?: unknown;
  readonly invoiceTotalCents?: unknown;
  readonly varianceCents?: unknown;
  readonly reconciledAt?: unknown;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `${M27_VENDOR_INVOICE_CONSUMER.consumerName}: '${field}' must be a non-empty string`,
    );
  }
  return value;
}

function requireInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${M27_VENDOR_INVOICE_CONSUMER.consumerName}: '${field}' must be an integer`);
  }
  return value;
}

function requireIsoDate(value: unknown, field: string): { date: Date; dateOnly: string } {
  const s = requireString(value, field);
  const date = new Date(s);
  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `${M27_VENDOR_INVOICE_CONSUMER.consumerName}: '${field}' must be a valid ISO instant`,
    );
  }
  return { date, dateOnly: date.toISOString().slice(0, 10) };
}

export interface M27VendorInvoiceDeps {
  readonly db: DbClient;
}

export function buildM27VendorInvoiceConsumer(deps: M27VendorInvoiceDeps): OutboxConsumerBinding {
  return {
    consumerName: M27_VENDOR_INVOICE_CONSUMER.consumerName,
    consumerModule: "m27",
    eventTypes: [...M27_VENDOR_INVOICE_CONSUMER.eventNames],
    async handle(event): Promise<void> {
      const organizationId = event.organizationId;
      await withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
        const tx = scoped as unknown as DbClient;

        if (event.eventType === "m21.supply_request.invoice_accrued") {
          const p = (event.payload ?? {}) as InvoiceAccruedPayload;
          const providerEntityId = requireString(p.providerEntityId, "providerEntityId");
          const supplyRequestId = requireString(p.supplyRequestId, "supplyRequestId");
          const vendorId = typeof p.vendorId === "string" ? p.vendorId : null;
          const invoiceTotalCents = requireInt(p.invoiceTotalCents, "invoiceTotalCents");
          const { date: accruedAt, dateOnly } = requireIsoDate(p.accruedAt, "accruedAt");

          const [report] = await tx
            .select({ id: CR.id })
            .from(CR)
            .where(
              and(
                eq(CR.organizationId, organizationId),
                eq(CR.providerEntityId, providerEntityId),
                lte(CR.fiscalYearStartDate, dateOnly),
                gte(CR.fiscalYearEndDate, dateOnly),
              ),
            )
            .limit(1);
          if (!report) {
            throw new Error(
              `${M27_VENDOR_INVOICE_CONSUMER.consumerName}: no cost_report open for providerEntityId=${providerEntityId} covering ${dateOnly}`,
            );
          }

          await tx
            .insert(VIL)
            .values({
              organizationId,
              costReportId: report.id,
              supplyRequestId,
              vendorId,
              status: "accrued",
              accruedAmountCents: invoiceTotalCents,
              accruedAt,
            })
            .onConflictDoNothing({ target: [VIL.organizationId, VIL.supplyRequestId] });
          return;
        }

        // m21.supply_request.invoice_reconciled
        const p = (event.payload ?? {}) as InvoiceReconciledPayload;
        requireString(p.providerEntityId, "providerEntityId"); // validated, not needed for the lookup below
        const supplyRequestId = requireString(p.supplyRequestId, "supplyRequestId");
        const invoiceTotalCents = requireInt(p.invoiceTotalCents, "invoiceTotalCents");
        const varianceCents = requireInt(p.varianceCents, "varianceCents");
        const { date: reconciledAt } = requireIsoDate(p.reconciledAt, "reconciledAt");

        const [updated] = await tx
          .update(VIL)
          .set({
            status: "reconciled",
            reconciledAmountCents: invoiceTotalCents,
            varianceCents,
            reconciledAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(VIL.organizationId, organizationId),
              eq(VIL.supplyRequestId, supplyRequestId),
              eq(VIL.status, "accrued"),
            ),
          )
          .returning({ id: VIL.id });
        if (updated) return;

        const [existing] = await tx
          .select({ id: VIL.id, status: VIL.status })
          .from(VIL)
          .where(
            and(eq(VIL.organizationId, organizationId), eq(VIL.supplyRequestId, supplyRequestId)),
          )
          .limit(1);
        if (existing && existing.status === "reconciled") return; // idempotent redelivery, already applied

        throw new Error(
          `${M27_VENDOR_INVOICE_CONSUMER.consumerName}: no accrued vendor_invoice_line for supplyRequestId=${supplyRequestId} to reconcile`,
        );
      });
    },
  };
}
