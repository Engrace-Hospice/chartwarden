import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/35-subscription — M35 invoice detail (§5.1 `/billing/invoices/:id`).
// One invoice over GET /api/v1/invoices/:id with its line breakdown (subtotal/tax/paid), plus the
// "Download PDF" (GET :id/pdf) and "View on Stripe" (GET :id/hosted_url, a signed redirect) CTAs. All
// amounts are integer cents formatted once. Lantern: Detail pattern, tabular-nums, §6.6 pill.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useParams } from "react-router-dom";
import { cap, formatCents, formatDate, invoiceTone } from "./billing-status";

interface InvoiceLine {
  id: string;
  kind: string;
  description: string;
  quantity: number;
  unitAmountCents: number;
  totalCents: number;
}
interface InvoiceDetail {
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
  subtotalCents: number;
  taxCents: number;
  amountPaidCents: number;
  lines: InvoiceLine[];
}

export function InvoiceDetail(): JSX.Element {
  const client = useApiClient();
  const { id } = useParams<{ id: string }>();
  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [hostedUrl, setHostedUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) {
      setError("No invoice selected.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/invoices/{id}", { params: { path: { id } } });
    if (res.error) {
      setError("Invoice unavailable.");
      setLoading(false);
      return;
    }
    setInvoice(res.data as unknown as InvoiceDetail);
    setLoading(false);
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const openHosted = useCallback(async () => {
    if (!id) return;
    const res = await client.GET("/api/v1/invoices/{id}/hosted_url", { params: { path: { id } } });
    const url = res.error ? null : (res.data as unknown as { url: string | null }).url;
    if (url) {
      setHostedUrl(url);
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }, [client, id]);

  if (loading) return <LoadingSpinner />;
  if (error || !invoice)
    return <EmptyState title="Unavailable" description={error ?? "Invoice not found."} />;

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title={`Invoice ${invoice.invoiceNumber ?? invoice.id.slice(0, 8)}`}
          breadcrumb="Billing / Invoices"
          actions={
            <div style={{ display: "flex", gap: "0.75rem" }}>
              <a
                href={`/api/v1/invoices/${invoice.id}/pdf`}
                style={ctaStyle(false)}
                target="_blank"
                rel="noopener noreferrer"
              >
                Download PDF
              </a>
              <button type="button" onClick={() => void openHosted()} style={ctaStyle(true)}>
                View on Stripe
              </button>
            </div>
          }
        />
      }
      aside={
        <div style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <Kv label="Status">
            <StatusPill label={cap(invoice.status)} tone={invoiceTone(invoice.status)} />
          </Kv>
          <Kv label="Period">
            <span className="tabular-nums">
              {formatDate(invoice.periodStart)} — {formatDate(invoice.periodEnd)}
            </span>
          </Kv>
          <Kv label="Issued">
            <span className="tabular-nums">{formatDate(invoice.issuedAt)}</span>
          </Kv>
          <Kv label="Due">
            <span className="tabular-nums">{formatDate(invoice.dueAt)}</span>
          </Kv>
          <Kv label="Paid">
            <span className="tabular-nums">{formatDate(invoice.paidAt)}</span>
          </Kv>
          {hostedUrl ? (
            <span style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>
              Opened Stripe-hosted page in a new tab.
            </span>
          ) : null}
        </div>
      }
    >
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--color-on-surface-variant)" }}>
            <th style={cell}>Description</th>
            <th style={{ ...cell, textAlign: "right" }}>Qty</th>
            <th style={{ ...cell, textAlign: "right" }}>Unit</th>
            <th style={{ ...cell, textAlign: "right" }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((l) => (
            <tr key={l.id} style={{ borderTop: "1px solid var(--color-outline-variant)" }}>
              <td style={cell}>{l.description}</td>
              <td style={{ ...cell, textAlign: "right" }} className="tabular-nums">
                {l.quantity.toLocaleString()}
              </td>
              <td style={{ ...cell, textAlign: "right" }} className="tabular-nums">
                {formatCents(l.unitAmountCents, invoice.currencyCode)}
              </td>
              <td style={{ ...cell, textAlign: "right" }} className="tabular-nums">
                {formatCents(l.totalCents, invoice.currencyCode)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <TotalRow label="Subtotal" value={formatCents(invoice.subtotalCents, invoice.currencyCode)} />
          <TotalRow label="Tax" value={formatCents(invoice.taxCents, invoice.currencyCode)} />
          <TotalRow label="Total" value={formatCents(invoice.totalCents, invoice.currencyCode)} strong />
          <TotalRow label="Paid" value={formatCents(invoice.amountPaidCents, invoice.currencyCode)} />
        </tfoot>
      </table>
    </DetailPageLayout>
  );
}

function Kv({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <span style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>{label}</span>
      {children}
    </div>
  );
}

function TotalRow({
  label,
  value,
  strong,
}: { label: string; value: string; strong?: boolean }): JSX.Element {
  return (
    <tr style={{ borderTop: "1px solid var(--color-outline-variant)" }}>
      <td style={cell} colSpan={3}>
        <span style={{ fontWeight: strong ? 700 : 400 }}>{label}</span>
      </td>
      <td style={{ ...cell, textAlign: "right" }} className="tabular-nums">
        <span style={{ fontWeight: strong ? 700 : 400 }}>{value}</span>
      </td>
    </tr>
  );
}

const cell = { padding: "0.6rem 0.75rem" } as const;
function ctaStyle(primary: boolean): CSSProperties {
  return {
    padding: "0.5rem 1rem",
    borderRadius: "var(--radius-md, 0.5rem)",
    border: primary ? "none" : "1px solid var(--color-outline)",
    background: primary ? "var(--color-primary)" : "transparent",
    color: primary ? "var(--color-on-primary)" : "var(--color-primary)",
    textDecoration: "none",
    fontSize: "0.85rem",
    fontWeight: 600,
    cursor: "pointer",
  };
}
