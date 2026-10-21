import {
  Button,
  ConfirmDialog,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  humanizeIdentifier,
  useApiClient,
  useToast,
} from "@chartwarden/ui";
// apps/web/src/modules/35-subscription — M35 payment methods (§5.1 `/billing/payment_methods`).
// The stored payment methods over GET /api/v1/payment_methods, with "Set default"/"Detach" affordances
// and the "Add card" CTA. Card entry itself is the Stripe Payment Element (the only iframe-mounted,
// WCAG-2.1-AA component per §5.5) mounted against a setup-intent client secret (POST
// /api/v1/payment_methods/setup_intent) — the raw PAN never touches ChartWarden (§4.13). This surface lists +
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
  const toast = useToast();
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** The row whose action is in flight — disables that row's controls without freezing the table. */
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Detach is irreversible from this screen, so it goes through a confirm step (UI-005). */
  const [confirmDetach, setConfirmDetach] = useState<PaymentMethod | null>(null);

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

  // Action failures surface as a toast rather than through `setError`: `error` short-circuits the
  // whole render into an EmptyState, so reusing it here would delete the table the user is acting on.
  // The server is the authority on permission — a caller without `payment_method.write` gets a 403,
  // which lands here as a message, matching how the staff-management roster handles the same case.
  async function setDefault(method: PaymentMethod): Promise<void> {
    setBusyId(method.id);
    const { error: err } = await client.PATCH("/api/v1/payment_methods/{id}/set_default", {
      params: { path: { id: method.id } },
    });
    setBusyId(null);
    if (err) {
      toast.show("Could not set that card as the default.", { tone: "error" });
      return;
    }
    toast.show(`${cardLabel(method)} is now the default payment method.`, { tone: "success" });
    void load();
  }

  async function performDetach(): Promise<void> {
    if (!confirmDetach) return;
    setBusyId(confirmDetach.id);
    const { error: err } = await client.DELETE("/api/v1/payment_methods/{id}", {
      params: { path: { id: confirmDetach.id } },
    });
    setBusyId(null);
    if (err) {
      toast.show("Could not detach that card.", { tone: "error" });
      setConfirmDetach(null);
      return;
    }
    toast.show(`Detached ${cardLabel(confirmDetach)}.`, { tone: "success" });
    setConfirmDetach(null);
    void load();
  }

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader
            title="Payment methods"
            breadcrumb="Billing"
            actions={
              // Card entry needs the Stripe Payment Element to mint a payment-method id, and the
              // outbound Stripe integration is not wired yet: there is no Stripe SDK dependency, and
              // `POST /api/v1/payment_methods/setup_intent` answers `{clientSecret: null,
              // status: "pending"}` because the stripe-dispatcher worker that would provision it is
              // deferred. Wiring this button would replace a dead control with a spinner that never
              // resolves, so it states the blocker instead (#27).
              <Button
                type="button"
                tone="primary"
                disabled
                title="Card entry requires the Stripe payment element, which is not enabled yet. Contact support to add a card."
              >
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
              {/* A `title` on a DISABLED button is unreachable by keyboard and unread by screen
                readers (a disabled control takes no focus), so the blocker is also stated here in
                the visible copy. The previous wording described card entry as if it worked. */}
              <span>
                Card entry is handled by the Stripe payment element, so raw card data stays off
                ChartWarden. Adding a card is not enabled yet — contact support to add or replace one.
                Existing cards can still be set as default or detached below.
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
                    <MethodRow
                      key={m.id}
                      method={m}
                      busy={busyId === m.id}
                      onSetDefault={() => void setDefault(m)}
                      onDetach={() => setConfirmDetach(m)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      />
      <ConfirmDialog
        open={confirmDetach !== null}
        title="Detach this card?"
        description={
          confirmDetach?.isDefault
            ? `${cardLabel(confirmDetach)} is the DEFAULT payment method. Detaching it leaves the subscription with no card for renewal and dunning recovery until another is set as default.`
            : `${confirmDetach ? cardLabel(confirmDetach) : "This card"} will no longer be available for subscription renewal or dunning recovery.`
        }
        tone="danger"
        confirmLabel="Detach card"
        pending={busyId !== null && busyId === confirmDetach?.id}
        onConfirm={() => void performDetach()}
        onCancel={() => setConfirmDetach(null)}
      />
    </>
  );
}

/** "Visa ....4242" — the human-readable handle used in confirmations and toasts. */
function cardLabel(method: PaymentMethod): string {
  return `${method.brand ?? "Card"} ....${method.last4 ?? "----"}`;
}

function MethodRow({
  method,
  busy,
  onSetDefault,
  onDetach,
}: {
  method: PaymentMethod;
  busy: boolean;
  onSetDefault: () => void;
  onDetach: () => void;
}): JSX.Element {
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
        <span style={softChipStyle}>{humanizeIdentifier(method.kind)}</span>
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
            <button
              type="button"
              style={linkBtn}
              disabled={busy}
              onClick={onSetDefault}
              aria-label={`Set default — ${cardLabel(method)}`}
            >
              Set default
            </button>
          ) : null}
          <button
            type="button"
            style={{ ...linkBtn, color: "var(--color-error)" }}
            disabled={busy}
            onClick={onDetach}
            aria-label={`Detach — ${cardLabel(method)}`}
          >
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
