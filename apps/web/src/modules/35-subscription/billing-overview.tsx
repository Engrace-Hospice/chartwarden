import {
  DetailPageLayout,
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/35-subscription — M35 Subscription overview (§5.1 `/billing`).
// The billing home: plan name, subscription status, current period, and — when the org is in dunning —
// the §5.5 dunning banner (assertive alert for the day_28_suspend+ stages). Composed client-side from
// GET /api/v1/subscription (the lifecycle row) + GET /api/v1/billing/status (the block posture the global
// chrome banner also polls). Reads run under withOrgContext server-side (RLS-scoped); the server is the
// authoritative enforcer, this only presents. Lantern: CSS-var tokens, tabular-nums, §6.6 StatusPill.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
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
      header={<PageHeader title="Billing" breadcrumb="Subscription overview" />}
      aside={
        <div style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
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

      <KpiStrip>
        <KpiCard label="Plan" value={sub.planName} />
        <KpiCard label="Payment method" value={pm} />
        <KpiCard label="Renews" value={formatDate(sub.currentPeriodEnd)} />
      </KpiStrip>

      <section
        style={{ marginTop: "1.5rem", display: "flex", flexDirection: "column", gap: "1rem" }}
      >
        <Row label="Status">
          <StatusPill label={cap(sub.status)} tone={subscriptionTone(sub.status)} />
        </Row>
        {sub.status === "trialing" ? (
          <Row label="Trial ends">
            <span className="tabular-nums">{formatDate(sub.trialEndsAt)}</span>
          </Row>
        ) : null}
        <Row label="Current period">
          <span className="tabular-nums">
            {formatDate(sub.currentPeriodStart)} — {formatDate(sub.currentPeriodEnd)}
          </span>
        </Row>
        {sub.cancelAtPeriodEnd ? (
          <Row label="Scheduled">
            <StatusPill label="Cancels at period end" tone="warning" />
          </Row>
        ) : null}
      </section>
    </DetailPageLayout>
  );
}

function Row({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
      <span
        style={{
          minWidth: "10rem",
          fontSize: "0.8rem",
          color: "var(--color-on-surface-variant)",
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function QuickLink({ to, label }: { to: string; label: string }): JSX.Element {
  return (
    <Link
      to={to}
      style={{
        color: "var(--color-primary)",
        textDecoration: "none",
        fontSize: "0.9rem",
        fontWeight: 500,
      }}
    >
      {label} →
    </Link>
  );
}
