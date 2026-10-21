import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/35-subscription — M35 invoices list (§5.1 `/billing/invoices`).
// Cursor-paged invoice list over GET /api/v1/invoices with a status filter (open/paid/void); each row
// links to the invoice detail and (where present) the Stripe-hosted page. Amounts are integer cents from
// the wire, formatted once at the boundary. Lantern: Work Queue pattern, tabular-nums, §6.6 pills.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
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
      header={
        <PageHeader title="Invoices" breadcrumb="Billing">
          <div style={headerDescriptionStyle}>
            Review issued invoices, payment state, due dates, and detailed invoice records.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filtersStyle}>
          <div className="wx-subtabs wx-subtabs-inline" role="tablist">
            {STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                aria-selected={statusFilter === s}
              >
                {cap(s)}
              </button>
            ))}
          </div>
          <span style={filterHintStyle}>Showing latest 50 invoices for the selected status.</span>
        </div>
      }
      table={
        loading ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : error ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={error} />
          </div>
        ) : invoices.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="No invoices" description="No invoices match this filter." />
          </div>
        ) : (
          <div style={tableWrapStyle}>
            <table style={tableStyle}>
              <thead>
                <tr style={tableHeadRowStyle}>
                  <Th width="23%">Invoice</Th>
                  <Th width="14%">Status</Th>
                  <Th width="27%">Period</Th>
                  <Th width="14%">Issued</Th>
                  <Th width="12%" align="right">
                    Total
                  </Th>
                  <Th width="10%" align="right">
                    Actions
                  </Th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} style={tableRowStyle}>
                    <Td>
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
                        <Link
                          to={`/subscription/invoices/${inv.id}`}
                          className="wx-data-md"
                          style={invoiceLinkStyle}
                        >
                          {inv.invoiceNumber ?? inv.id.slice(0, 8)}
                        </Link>
                        <code className="wx-data-md" style={invoiceIdStyle}>
                          {inv.id}
                        </code>
                      </div>
                    </Td>
                    <Td>
                      <StatusPill label={cap(inv.status)} tone={invoiceTone(inv.status)} />
                    </Td>
                    <Td>
                      <span className="tabular-nums">
                        {formatDate(inv.periodStart)} - {formatDate(inv.periodEnd)}
                      </span>
                    </Td>
                    <Td>
                      <span className="tabular-nums">{formatDate(inv.issuedAt)}</span>
                    </Td>
                    <Td align="right">
                      <span className="tabular-nums" style={amountStyle}>
                        {formatCents(inv.totalCents, inv.currencyCode)}
                      </span>
                    </Td>
                    <Td align="right">
                      <Link to={`/subscription/invoices/${inv.id}`} style={viewLinkStyle}>
                        View
                      </Link>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
    />
  );
}

function Th({
  children,
  align,
  width,
}: { children?: JSX.Element | string; align?: "right"; width?: string }): JSX.Element {
  return <th style={{ ...thStyle, textAlign: align ?? "left", width }}>{children ?? null}</th>;
}
function Td({ children, align }: { children: JSX.Element | string; align?: "right" }): JSX.Element {
  return <td style={{ ...tdStyle, textAlign: align ?? "left" }}>{children}</td>;
}

const headerDescriptionStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.875rem",
};

const filtersStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "0 1.5rem 1rem",
};

const filterHintStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8rem",
};

const tableWrapStyle: CSSProperties = {
  width: "100%",
  overflowX: "auto",
  padding: "0 1.5rem 1.5rem",
};

const tableStyle: CSSProperties = {
  display: "table",
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.875rem",
};

const tableHeadRowStyle: CSSProperties = {
  textAlign: "left",
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};

const tableRowStyle: CSSProperties = {
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
};

const thStyle: CSSProperties = {
  padding: "0.625rem 1rem",
  fontWeight: 600,
  fontSize: "0.75rem",
};

const tdStyle: CSSProperties = {
  padding: "0.75rem 1rem",
  verticalAlign: "middle",
};

const invoiceLinkStyle: CSSProperties = {
  color: "var(--color-primary)",
  textDecoration: "none",
  fontWeight: 650,
};

const invoiceIdStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.72rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const amountStyle: CSSProperties = {
  color: "var(--color-on-surface)",
  fontWeight: 650,
};

const viewLinkStyle: CSSProperties = {
  display: "inline-flex",
  justifyContent: "center",
  minWidth: "3.25rem",
  padding: "0.35rem 0.6rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-container)",
  color: "var(--color-primary)",
  textDecoration: "none",
  fontSize: "0.8rem",
  fontWeight: 600,
};
