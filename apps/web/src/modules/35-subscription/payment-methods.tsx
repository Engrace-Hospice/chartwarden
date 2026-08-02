import {
  EmptyState,
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
            <button
              type="button"
              style={{
                padding: "0.5rem 1rem",
                borderRadius: "var(--radius-md, 0.5rem)",
                border: "none",
                background: "var(--color-primary)",
                color: "var(--color-on-primary)",
                fontSize: "0.875rem",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Add card
            </button>
          }
        />
      }
      table={
        methods.length === 0 ? (
          <EmptyState
            title="No payment methods"
            description="Add a card to keep your subscription active."
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "0 1.5rem 1.5rem" }}>
            {methods.map((m) => (
              <MethodRow key={m.id} method={m} />
            ))}
          </div>
        )
      }
    />
  );
}

function MethodRow({ method }: { method: PaymentMethod }): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "1rem",
        background: "var(--color-surface-lowest)",
        borderRadius: "var(--radius-lg, 0.75rem)",
        boxShadow: "var(--shadow-soft)",
        padding: "1rem 1.25rem",
        opacity: method.isActive ? 1 : 0.6,
      }}
    >
      <span className="wx-data-md" style={{ fontSize: "1rem", fontWeight: 600 }}>
        {method.brand ?? "Card"} ····{method.last4 ?? "----"}
      </span>
      <span style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
        Expires {formatDate(method.expiresAt)}
      </span>
      {method.isDefault ? <StatusPill label="Default" tone="success" /> : null}
      {!method.isActive ? <StatusPill label="Inactive" tone="neutral" /> : null}
      <div style={{ marginLeft: "auto", display: "flex", gap: "0.75rem" }}>
        {!method.isDefault && method.isActive ? (
          <button type="button" style={linkBtn}>
            Set default
          </button>
        ) : null}
        <button type="button" style={{ ...linkBtn, color: "var(--color-error)" }}>
          Detach
        </button>
      </div>
    </div>
  );
}

const linkBtn: CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--color-primary)",
  fontSize: "0.85rem",
  fontWeight: 500,
  cursor: "pointer",
  padding: 0,
};
