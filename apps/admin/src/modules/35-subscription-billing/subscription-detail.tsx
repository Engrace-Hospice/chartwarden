import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
import type { operations } from "@wardenx/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Subscription detail (`/admin/subscriptions/:id`,
// subscription.admin.read). One tenant subscription over GET /api/admin/subscriptions/:id, with its current
// dunning state (on the row), a usage drill-down (GET /api/admin/usage/:orgId/current), and its refund
// history (GET /api/admin/refunds, narrowed to this org). Links to the pause + apply-promo gated actions.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import {
  cap,
  dunningTone,
  formatCents,
  formatDate,
  orgLabel,
  refundTone,
  subscriptionTone,
  usageThresholdTone,
} from "./status";
import { Kv, actionButtonStyle, bodyRow, cell, cellRight, tableStyle, theadRow } from "./ui";

type AdminSub =
  operations["getApiAdminSubscriptionsById"]["responses"][200]["content"]["application/json"];
type UsageMeter =
  operations["getApiAdminUsageByOrganizationIdCurrent"]["responses"][200]["content"]["application/json"]["meters"][number];
type Refund =
  operations["getApiAdminRefunds"]["responses"][200]["content"]["application/json"]["items"][number];

export function SubscriptionDetail(): JSX.Element {
  const client = useApiClient();
  const { id } = useParams<{ id: string }>();
  const [sub, setSub] = useState<AdminSub | null>(null);
  const [usage, setUsage] = useState<UsageMeter[] | null>(null);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) {
      setError("No subscription selected.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/admin/subscriptions/{id}", { params: { path: { id } } });
    if (res.error) {
      setError("Subscription unavailable.");
      setLoading(false);
      return;
    }
    const s = res.data;
    setSub(s);
    // Usage drill-down + refund history are best-effort side reads (a missing usage row is not an error).
    const usageRes = await client.GET("/api/admin/usage/{organizationId}/current", {
      params: { path: { organizationId: s.organizationId } },
    });
    setUsage(usageRes.error ? [] : usageRes.data.meters);
    const refundRes = await client.GET("/api/admin/refunds", { params: { query: {} } });
    const allRefunds = refundRes.error ? [] : refundRes.data.items;
    setRefunds(allRefunds.filter((r) => r.organizationId === s.organizationId));
    setLoading(false);
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error || !sub)
    return <EmptyState title="Unavailable" description={error ?? "Subscription not found."} />;

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title={orgLabel(sub.organizationName, sub.organizationId)}
          breadcrumb="Platform Ops / Subscriptions"
          actions={
            <div style={{ display: "flex", gap: "0.75rem" }}>
              <Link
                to={`/admin/subscriptions/${sub.id}/apply_promo`}
                style={actionButtonStyle(false)}
              >
                Apply promo
              </Link>
              <Link to={`/admin/subscriptions/${sub.id}/pause`} style={actionButtonStyle(true)}>
                Pause
              </Link>
            </div>
          }
        />
      }
      aside={
        <div style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "0.9rem" }}>
          <Kv label="Status">
            <StatusPill label={cap(sub.status)} tone={subscriptionTone(sub.status)} />
          </Kv>
          <Kv label="Dunning">
            {sub.dunningStage === "none" ? (
              "—"
            ) : (
              <StatusPill label={cap(sub.dunningStage)} tone={dunningTone(sub.dunningStage)} />
            )}
          </Kv>
          <Kv label="Plan">
            {sub.planName} · {cap(sub.planTier)}
          </Kv>
          <Kv label="Started">
            <span className="tabular-nums">{formatDate(sub.startedAt)}</span>
          </Kv>
          <Kv label="Current period">
            <span className="tabular-nums">
              {formatDate(sub.currentPeriodStart)} — {formatDate(sub.currentPeriodEnd)}
            </span>
          </Kv>
          <Kv label="Cancel at period end">{sub.cancelAtPeriodEnd ? "Yes" : "No"}</Kv>
          <Kv label="Stripe subscription">{sub.stripeSubscriptionId ?? "— (pending sync)"}</Kv>
        </div>
      }
    >
      <section style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
        <div>
          <h2 style={{ fontSize: "1rem", fontWeight: 600, margin: "0 0 0.5rem" }}>
            Usage this period
          </h2>
          {!usage || usage.length === 0 ? (
            <p style={{ fontSize: "0.85rem", color: "var(--color-on-surface-variant)" }}>
              No metered usage recorded for the current period.
            </p>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr style={theadRow}>
                  <th style={cell}>Meter</th>
                  <th style={cellRight}>Used</th>
                  <th style={cellRight}>Included</th>
                  <th style={cellRight}>Overage</th>
                  <th style={cellRight}>Proj. cost</th>
                  <th style={cell}>State</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((m) => (
                  <tr key={m.eventType} style={bodyRow}>
                    <td style={cell}>{m.label}</td>
                    <td style={cellRight} className="tabular-nums">
                      {m.totalQuantity.toLocaleString()}
                    </td>
                    <td style={cellRight} className="tabular-nums">
                      {m.inclusiveQuantity.toLocaleString()}
                    </td>
                    <td style={cellRight} className="tabular-nums">
                      {m.overageQuantity.toLocaleString()}
                    </td>
                    <td style={cellRight} className="tabular-nums">
                      {formatCents(m.projectedOverageCostCents)}
                    </td>
                    <td style={cell}>
                      <StatusPill
                        label={cap(m.thresholdState)}
                        tone={usageThresholdTone(m.thresholdState)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div>
          <h2 style={{ fontSize: "1rem", fontWeight: 600, margin: "0 0 0.5rem" }}>
            Refund history
          </h2>
          {refunds.length === 0 ? (
            <p style={{ fontSize: "0.85rem", color: "var(--color-on-surface-variant)" }}>
              No refunds requested for this organization.
            </p>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr style={theadRow}>
                  <th style={cell}>Requested</th>
                  <th style={cellRight}>Amount</th>
                  <th style={cell}>Reason</th>
                  <th style={cell}>Status</th>
                </tr>
              </thead>
              <tbody>
                {refunds.map((r) => (
                  <tr key={r.id} style={bodyRow}>
                    <td style={cell} className="tabular-nums">
                      {formatDate(r.requestedAt)}
                    </td>
                    <td style={cellRight} className="tabular-nums">
                      {formatCents(r.amountCents)}
                    </td>
                    <td style={cell}>{cap(r.reasonCode)}</td>
                    <td style={cell}>
                      <StatusPill label={cap(r.status)} tone={refundTone(r.status)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <p style={{ fontSize: "0.75rem", color: "var(--color-on-surface-variant)" }}>
          A full state-transition history is retained server-side; it is not yet exposed as a read
          surface here.
        </p>
      </section>
    </DetailPageLayout>
  );
}
