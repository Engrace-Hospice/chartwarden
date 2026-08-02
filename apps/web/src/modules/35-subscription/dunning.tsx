import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/35-subscription — M35 dunning (§5.1 `/billing/dunning`).
// Visible only when the org is in dunning: the current stage, the next-retry / suspension countdown, and
// the "Update payment method" remediation CTA (via the shared §5.5 DunningBanner). Composed from GET
// /api/v1/billing/status. When not in dunning the screen states the account is in good standing rather
// than 404-ing (the route is always reachable to an org_admin/billing_admin). Lantern: Detail pattern.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { DunningBanner } from "./dunning-banner";
import { cap, dunningTone } from "./billing-status";

interface BillingStatus {
  status: string;
  isBlockedByBilling: boolean;
  dunningStage: string;
  daysUntilSuspension: number | null;
  hasValidPaymentMethod: boolean;
}

const IN_DUNNING = (stage: string): boolean => stage !== "none" && stage !== "resolved";

export function Dunning(): JSX.Element {
  const client = useApiClient();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/billing/status");
    if (res.error) {
      setError("Billing status unavailable.");
      setLoading(false);
      return;
    }
    setStatus(res.data as unknown as BillingStatus);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error || !status) return <EmptyState title="Unavailable" description={error ?? "No status."} />;

  if (!IN_DUNNING(status.dunningStage)) {
    return (
      <DetailPageLayout header={<PageHeader title="Dunning" breadcrumb="Billing" />}>
        <EmptyState
          title="Account in good standing"
          description="Your account is not in dunning. There is nothing to resolve."
        />
      </DetailPageLayout>
    );
  }

  return (
    <DetailPageLayout
      header={<PageHeader title="Dunning" breadcrumb="Billing" />}
      aside={
        <div style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <Kv label="Stage">
            <StatusPill label={cap(status.dunningStage)} tone={dunningTone(status.dunningStage)} />
          </Kv>
          <Kv label="Days until suspension">
            <span className="tabular-nums">{status.daysUntilSuspension ?? "—"}</span>
          </Kv>
          <Kv label="Payment method on file">
            <StatusPill
              label={status.hasValidPaymentMethod ? "Valid" : "Missing / expired"}
              tone={status.hasValidPaymentMethod ? "success" : "error"}
            />
          </Kv>
        </div>
      }
    >
      <DunningBanner
        stage={status.dunningStage}
        daysUntilSuspension={status.daysUntilSuspension}
        isBlocked={status.isBlockedByBilling}
      />
      <p style={{ marginTop: "1.25rem", fontSize: "0.9rem", color: "var(--color-on-surface-variant)" }}>
        Your subscription has an overdue balance. Update your payment method to clear the balance and
        restore your account. If the balance is not resolved, access will be suspended and — after the
        final stage — the subscription will be canceled.
      </p>
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
