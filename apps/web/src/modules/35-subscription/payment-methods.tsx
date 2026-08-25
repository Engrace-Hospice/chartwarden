import {
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/35-subscription — M35 payment methods (§5.1 `/billing/payment_methods`).
// The stored payment methods over GET /api/v1/payment_methods, with "Set default"/"Detach" affordances
// and the "Add card" CTA. Card entry itself is the Stripe Payment Element (the only iframe-mounted,
// WCAG-2.1-AA component per §5.5) mounted against a setup-intent client secret (POST
// /api/v1/payment_methods/setup_intent) — the raw PAN never touches WardenX (§4.13). This surface lists +
// presents the actions the server gates on payment_method.write. Lantern: CSS-var tokens, §6.6 pills.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { formatDate } from "./billing-status";

interface PaymentMethod {
  id: string;
  kind: string;
  brand: string | null;
  last4: string | null;
  expiresAt: string | null;
  isDefault: boolean;
  isActive: boolean;
}

export function PaymentMethods(): JSX.Element {
  const client = useApiClient();
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/payment_methods");
    if (res.error) {
      setError("Payment methods unavailable.");
      setLoading(false);
      return;
    }
    setMethods((res.data as unknown as PaymentMethod[]) ?? []);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Payment methods"
          breadcrumb="Billing"
          actions={
            <Button type="button" tone="primary">
              Add card
            </Button>
          }
        >
          <div style={headerDescriptionStyle}>
            Manage saved cards for subscription renewal, dunning recovery, and future invoices.
          </div>
        </PageHeader>
      }
      filters={
        <div style={toolbarStyle}>
          <div style={toolbarCopyStyle}>
            <Glyph name="shield" size={16} />
            <span>
              Card entry is handled by the Stripe payment element; raw card data stays off WardenX.
            </span>
          </div>
        </div>
      }
      table={
        methods.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No payment methods"
              description="Add a card to keep your subscription active."
            />
          </div>
        ) : (
          <div style={tableWrapStyle}>
            <table style={tableStyle}>
              <thead>
                <tr style={tableHeadRowStyle}>
                  <th style={{ ...thStyle, width: "38%" }}>Payment method</th>
                  <th style={{ ...thStyle, width: "18%" }}>Kind</th>
                  <th style={{ ...thStyle, width: "18%" }}>Expires</th>
                  <th style={{ ...thStyle, width: "14%" }}>Status</th>
                  <th style={{ ...thStyle, width: "12%", textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {methods.map((m) => (
                  <MethodRow key={m.id} method={m} />
                ))}
              </tbody>
            </table>
          </div>
        )
      }
    />
  );
}

function MethodRow({ method }: { method: PaymentMethod }): JSX.Element {
  return (
    <tr
      style={{
        opacity: method.isActive ? 1 : 0.6,
        borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
      }}
    >
      <td style={tdStyle}>
        <div style={methodCellStyle}>
          <div aria-hidden style={cardGlyphStyle}>
            <Glyph name="shield" size={16} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem", minWidth: 0 }}>
            <span className="wx-data-md" style={methodNameStyle}>
              {method.brand ?? "Card"} ....{method.last4 ?? "----"}
            </span>
            <code className="wx-data-md" style={methodIdStyle}>
              {method.id}
            </code>
          </div>
        </div>
      </td>
      <td style={tdStyle}>
        <span style={softChipStyle}>{method.kind}</span>
      </td>
      <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
        {formatDate(method.expiresAt)}
      </td>
      <td style={tdStyle}>
        <div style={statusStackStyle}>
          {method.isDefault ? <StatusPill label="Default" tone="success" /> : null}
          {!method.isActive ? <StatusPill label="Inactive" tone="neutral" /> : null}
          {!method.isDefault && method.isActive ? (
            <StatusPill label="Active" tone="progress" />
          ) : null}
        </div>
      </td>
      <td style={{ ...tdStyle, textAlign: "right" }}>
        <div style={actionsStyle}>
          {!method.isDefault && method.isActive ? (
            <button type="button" style={linkBtn}>
              Set default
            </button>
          ) : null}
          <button type="button" style={{ ...linkBtn, color: "var(--color-error)" }}>
            Detach
          </button>
        </div>
      </td>
    </tr>
  );
}

const headerDescriptionStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.875rem",
};

const toolbarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "0 1.5rem 1rem",
  flexWrap: "wrap",
};

const toolbarCopyStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.85rem",
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

const thStyle: CSSProperties = {
  padding: "0.625rem 1rem",
  fontWeight: 600,
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const tdStyle: CSSProperties = {
  padding: "0.75rem 1rem",
  verticalAlign: "middle",
};

const methodCellStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  minWidth: 0,
};

const cardGlyphStyle: CSSProperties = {
  width: "2.25rem",
  height: "2.25rem",
  borderRadius: "9999px",
  background: "var(--color-primary-tint)",
  color: "var(--color-primary)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

const methodNameStyle: CSSProperties = {
  color: "var(--color-on-surface)",
  fontSize: "0.95rem",
  fontWeight: 650,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const methodIdStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.72rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const softChipStyle: CSSProperties = {
  display: "inline-block",
  padding: "0.2rem 0.5rem",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
  fontWeight: 600,
};

const statusStackStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.35rem",
  flexWrap: "wrap",
};

const actionsStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.75rem",
  whiteSpace: "nowrap",
};

const linkBtn: CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--color-primary)",
  fontSize: "0.85rem",
  fontWeight: 500,
  cursor: "pointer",
  padding: 0,
};
