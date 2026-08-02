import {
  EmptyState,
  FilterBar,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/35-subscription — M35 invoices list (§5.1 `/billing/invoices`).
// Cursor-paged invoice list over GET /api/v1/invoices with a status filter (open/paid/void); each row
// links to the invoice detail and (where present) the Stripe-hosted page. Amounts are integer cents from
// the wire, formatted once at the boundary. Lantern: Work Queue pattern, tabular-nums, §6.6 pills.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { cap, formatCents, formatDate, invoiceTone } from "./billing-status";

interface Invoice {
  id: string;
  invoiceNumber: string | null;
  status: string;
  totalCents: number;
  currencyCode: string;
  periodStart: string | null;
  periodEnd: string | null;
  issuedAt: string | null;
  dueAt: string | null;
  paidAt: string | null;
}
interface InvoicePage {
  items: Invoice[];
  nextCursor: string | null;
  hasMore: boolean;
}

const STATUSES = ["all", "open", "paid", "void"] as const;

export function Invoices(): JSX.Element {
  const client = useApiClient();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const query: Record<string, string | number> = { limit: 50 };
    if (statusFilter !== "all") query.status = statusFilter;
    const res = await client.GET("/api/v1/invoices", { params: { query } });
    if (res.error) {
      setError("Invoices unavailable.");
      setLoading(false);
      return;
    }
    const page = res.data as unknown as InvoicePage | undefined;
    setInvoices(page?.items ?? []);
    setLoading(false);
  }, [client, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <WorkQueueLayout
      header={<PageHeader title="Invoices" breadcrumb="Billing" />}
      filters={
        <FilterBar>
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              style={{
                padding: "0.35rem 0.85rem",
                borderRadius: "var(--radius-md, 0.5rem)",
                border: "none",
                background:
                  statusFilter === s ? "var(--color-primary)" : "var(--color-surface-lowest)",
                color: statusFilter === s ? "var(--color-on-primary)" : "var(--color-on-surface)",
                fontSize: "0.8rem",
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              {cap(s)}
            </button>
          ))}
        </FilterBar>
      }
      table={
        loading ? (
          <LoadingSpinner />
        ) : error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : invoices.length === 0 ? (
          <EmptyState title="No invoices" description="No invoices match this filter." />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--color-on-surface-variant)" }}>
                <Th>Invoice</Th>
                <Th>Status</Th>
                <Th>Period</Th>
                <Th>Issued</Th>
                <Th align="right">Total</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} style={{ borderTop: "1px solid var(--color-outline-variant)" }}>
                  <Td>
                    <Link
                      to={`/subscription/invoices/${inv.id}`}
                      className="wx-data-md"
                      style={{ color: "var(--color-primary)", textDecoration: "none" }}
                    >
                      {inv.invoiceNumber ?? inv.id.slice(0, 8)}
                    </Link>
                  </Td>
                  <Td>
                    <StatusPill label={cap(inv.status)} tone={invoiceTone(inv.status)} />
                  </Td>
                  <Td>
                    <span className="tabular-nums">
                      {formatDate(inv.periodStart)} — {formatDate(inv.periodEnd)}
                    </span>
                  </Td>
                  <Td>
                    <span className="tabular-nums">{formatDate(inv.issuedAt)}</span>
                  </Td>
                  <Td align="right">
                    <span className="tabular-nums">{formatCents(inv.totalCents, inv.currencyCode)}</span>
                  </Td>
                  <Td align="right">
                    <Link
                      to={`/subscription/invoices/${inv.id}`}
                      style={{ color: "var(--color-primary)", textDecoration: "none", fontSize: "0.8rem" }}
                    >
                      View →
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    />
  );
}

function Th({ children, align }: { children?: JSX.Element | string; align?: "right" }): JSX.Element {
  return (
    <th style={{ padding: "0.6rem 1rem", fontWeight: 600, textAlign: align ?? "left" }}>
      {children ?? null}
    </th>
  );
}
function Td({
  children,
  align,
}: { children: JSX.Element | string; align?: "right" }): JSX.Element {
  return <td style={{ padding: "0.6rem 1rem", textAlign: align ?? "left" }}>{children}</td>;
}
