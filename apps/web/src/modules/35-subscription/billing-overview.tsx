import {
  DetailPageLayout,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/35-subscription — M35 Subscription overview (§5.1 `/billing`).
// The billing home: plan name, subscription status, current period, and — when the org is in dunning —
// the §5.5 dunning banner (assertive alert for the day_28_suspend+ stages). Composed client-side from
// GET /api/v1/subscription (the lifecycle row) + GET /api/v1/billing/status (the block posture the global
// chrome banner also polls). Reads run under withOrgContext server-side (RLS-scoped); the server is the
// authoritative enforcer, this only presents. Lantern: CSS-var tokens, tabular-nums, §6.6 StatusPill.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { Link } from "react-router-dom";
import { cap, formatDate, subscriptionTone } from "./billing-status";
import { DunningBanner } from "./dunning-banner";

interface Subscription {
  planName: string;
  planSlug: string;
  status: string;
  trialEndsAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  defaultPaymentMethodBrand: string | null;
  defaultPaymentMethodLast4: string | null;
  dunningStage: string;
}

interface BillingStatus {
  status: string;
  isBlockedByBilling: boolean;
  dunningStage: string;
  daysUntilSuspension: number | null;
  hasValidPaymentMethod: boolean;
}

export function BillingOverview(): JSX.Element {
  const client = useApiClient();
  const [sub, setSub] = useState<Subscription | null>(null);
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [subRes, statusRes] = await Promise.all([
      client.GET("/api/v1/subscription"),
      client.GET("/api/v1/billing/status"),
    ]);
    if (subRes.error) {
      setError("Subscription unavailable.");
      setLoading(false);
      return;
    }
    setSub(subRes.data as unknown as Subscription);
    setStatus(statusRes.error ? null : (statusRes.data as unknown as BillingStatus));
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error || !sub)
    return <EmptyState title="Unavailable" description={error ?? "No active subscription."} />;

  const pm =
    sub.defaultPaymentMethodLast4 != null
      ? `${sub.defaultPaymentMethodBrand ?? "Card"} ····${sub.defaultPaymentMethodLast4}`
      : "None on file";

  return (
    <DetailPageLayout
      header={
        <PageHeader title="Billing">
          <div style={headerDescriptionStyle}>
            Review the current subscription, renewal window, payment method, and related billing
            workspaces.
          </div>
        </PageHeader>
      }
      aside={
        <div style={asideStyle}>
          <div style={asideHeaderStyle}>
            <span style={sectionEyebrowStyle}>Billing tools</span>
            <span style={asideHintStyle}>Open the workspace you need next.</span>
          </div>
          <QuickLink to="/subscription/plan" label="Change plan" />
          <QuickLink to="/subscription/payment_methods" label="Payment methods" />
          <QuickLink to="/subscription/invoices" label="Invoices" />
          <QuickLink to="/subscription/usage" label="Usage" />
          <QuickLink to="/subscription/promos" label="Promo codes" />
        </div>
      }
    >
      {status && status.dunningStage !== "none" && status.dunningStage !== "resolved" ? (
        <div style={{ marginBottom: "1.25rem" }}>
          <DunningBanner
            stage={status.dunningStage}
            daysUntilSuspension={status.daysUntilSuspension}
            isBlocked={status.isBlockedByBilling}
          />
        </div>
      ) : null}

      <div style={overviewGridStyle}>
        <section style={primaryCardStyle}>
          <div style={cardHeaderStyle}>
            <div>
              <span style={sectionEyebrowStyle}>Current plan</span>
              <h2 style={planTitleStyle}>{sub.planName}</h2>
            </div>
            <StatusPill label={cap(sub.status)} tone={subscriptionTone(sub.status)} />
          </div>
          <div style={planSlugStyle}>{sub.planSlug}</div>
          <div style={summaryListStyle}>
            <SummaryItem label="Payment method" value={pm} />
            <SummaryItem label="Renews" value={formatDate(sub.currentPeriodEnd)} mono />
            {sub.status === "trialing" ? (
              <SummaryItem label="Trial ends" value={formatDate(sub.trialEndsAt)} mono />
            ) : null}
          </div>
          {sub.cancelAtPeriodEnd ? (
            <div style={warningNoticeStyle}>
              <Glyph name="alert" size={16} />
              <span>This subscription is scheduled to cancel at the period end.</span>
            </div>
          ) : null}
        </section>

        <section style={tableCardStyle}>
          <div style={sectionHeaderStyle}>
            <span style={sectionEyebrowStyle}>Subscription details</span>
          </div>
          <div style={{ width: "100%", overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead>
                <tr style={tableHeadRowStyle}>
                  <th style={{ ...thStyle, width: "34%" }}>Field</th>
                  <th style={{ ...thStyle, width: "66%" }}>Value</th>
                </tr>
              </thead>
              <tbody>
                <DetailRow label="Status">
                  <StatusPill label={cap(sub.status)} tone={subscriptionTone(sub.status)} />
                </DetailRow>
                <DetailRow label="Current period">
                  <span className="tabular-nums">
                    {formatDate(sub.currentPeriodStart)} - {formatDate(sub.currentPeriodEnd)}
                  </span>
                </DetailRow>
                <DetailRow label="Payment method">
                  <span>{pm}</span>
                </DetailRow>
                <DetailRow label="Plan slug">
                  <code className="wx-data-md" style={codeStyle}>
                    {sub.planSlug}
                  </code>
                </DetailRow>
                <DetailRow label="Dunning stage">
                  <span>{cap(sub.dunningStage)}</span>
                </DetailRow>
                {sub.cancelAtPeriodEnd ? (
                  <DetailRow label="Scheduled">
                    <StatusPill label="Cancels at period end" tone="warning" />
                  </DetailRow>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </DetailPageLayout>
  );
}

function DetailRow({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <tr
      style={{
        borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
      }}
    >
      <td style={tdStyle}>{label}</td>
      <td style={{ ...tdStyle, color: "var(--color-on-surface)" }}>{children}</td>
    </tr>
  );
}

function SummaryItem({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <div style={summaryItemStyle}>
      <span style={summaryLabelStyle}>{label}</span>
      <span className={mono ? "tabular-nums" : undefined} style={summaryValueStyle}>
        {value}
      </span>
    </div>
  );
}

function QuickLink({ to, label }: { to: string; label: string }): JSX.Element {
  return (
    <Link to={to} style={quickLinkStyle}>
      <span>{label}</span>
      <span aria-hidden>{"->"}</span>
    </Link>
  );
}

const headerDescriptionStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.875rem",
};

const asideStyle: CSSProperties = {
  padding: "1.5rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.625rem",
};

const asideHeaderStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
  paddingBottom: "0.5rem",
};

const asideHintStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8rem",
};

const overviewGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(18rem, 0.9fr) minmax(24rem, 1.4fr)",
  gap: "1.25rem",
};

const primaryCardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  minWidth: 0,
  background: "var(--color-surface-lowest)",
  borderRadius: "var(--radius-xl)",
  boxShadow: "var(--shadow-soft)",
  padding: "1.25rem",
};

const tableCardStyle: CSSProperties = {
  ...primaryCardStyle,
  padding: 0,
  overflow: "hidden",
};

const cardHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1rem",
};

const sectionHeaderStyle: CSSProperties = {
  padding: "1rem 1rem 0.25rem",
};

const sectionEyebrowStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
  fontWeight: 600,
};

const planTitleStyle: CSSProperties = {
  margin: "0.2rem 0 0",
  color: "var(--color-on-surface)",
  fontFamily: "var(--font-display)",
  fontSize: "1.6rem",
  fontWeight: 600,
};

const planSlugStyle: CSSProperties = {
  alignSelf: "flex-start",
  padding: "0.2rem 0.5rem",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface-variant)",
  fontFamily: "var(--font-mono)",
  fontSize: "0.75rem",
};

const summaryListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.65rem",
  padding: "0.75rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
};

const summaryItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
};

const summaryLabelStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8rem",
};

const summaryValueStyle: CSSProperties = {
  color: "var(--color-on-surface)",
  fontSize: "0.875rem",
  fontWeight: 600,
  textAlign: "right",
};

const warningNoticeStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  padding: "0.625rem 0.75rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-warning) 12%, transparent)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
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
  color: "var(--color-on-surface-variant)",
};

const codeStyle: CSSProperties = {
  padding: "0.15rem 0.4rem",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};

const quickLinkStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  minHeight: "2.25rem",
  padding: "0.35rem 0.6rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-lowest)",
  color: "var(--color-primary)",
  textDecoration: "none",
  fontSize: "0.875rem",
  fontWeight: 600,
  boxShadow: "var(--shadow-soft)",
};
