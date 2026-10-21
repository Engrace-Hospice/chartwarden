import { Button, Glyph, StatusPill, useApiClient, useRequestGuard } from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Subscription detail (`/admin/subscriptions/:id`,
// subscription.admin.read). One tenant subscription over GET /api/admin/subscriptions/:id, with its current
// dunning state (on the row), a usage drill-down (GET /api/admin/usage/:orgId/current), and its refund
// history (GET /api/admin/refunds, narrowed to this org). Links to the pause + apply-promo gated actions.
// Redesign frame: usage + refunds in the main column, the subscription summary in the right drawer.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
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
import { DrawerHead, StateError, StateLoading } from "./ui";

type AdminSub =
  operations["getApiAdminSubscriptionsById"]["responses"][200]["content"]["application/json"];
type UsageMeter =
  operations["getApiAdminUsageByOrganizationIdCurrent"]["responses"][200]["content"]["application/json"]["meters"][number];
type Refund =
  operations["getApiAdminRefunds"]["responses"][200]["content"]["application/json"]["items"][number];

export function SubscriptionDetail(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [sub, setSub] = useState<AdminSub | null>(null);
  const [usage, setUsage] = useState<UsageMeter[] | null>(null);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const guard = useRequestGuard();
  const load = useCallback(async () => {
    const isCurrent = guard();
    if (!id) {
      setError("No subscription selected.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/admin/subscriptions/{id}", { params: { path: { id } } });
    if (!isCurrent()) return;
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
    if (!isCurrent()) return;
    setUsage(usageRes.error ? [] : usageRes.data.meters);
    const refundRes = await client.GET("/api/admin/refunds", { params: { query: {} } });
    if (!isCurrent()) return;
    const allRefunds = refundRes.error ? [] : refundRes.data.items;
    setRefunds(allRefunds.filter((r) => r.organizationId === s.organizationId));
    setLoading(false);
  }, [client, id, guard]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading || error || !sub)
    return (
      <div className="wx-list-drawer">
        <div className="wx-list-drawer-main">
          <header className="wx-page-head">
            <div>
              <h1>Subscription</h1>
              <p>One tenant's subscription, usage and refunds.</p>
            </div>
          </header>
          {loading ? (
            <StateLoading label="Loading subscription…" />
          ) : (
            <StateError message={error ?? "Subscription not found."} onRetry={() => void load()} />
          )}
        </div>
      </div>
    );

  return (
    <div className="wx-list-drawer has-drawer">
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>{orgLabel(sub.organizationName, sub.organizationId)}</h1>
            <p>
              {sub.planName} · {cap(sub.planTier)}
            </p>
          </div>
          <div className="wx-list-toolbar-end">
            <Button
              tone="secondary"
              onClick={() => navigate(`/admin/subscriptions/${sub.id}/apply_promo`)}
            >
              Apply promo
            </Button>
            <Button onClick={() => navigate(`/admin/subscriptions/${sub.id}/pause`)}>Pause</Button>
          </div>
        </header>
        <h2 className="m-0 text-base font-semibold">Usage this period</h2>
        {!usage || usage.length === 0 ? (
          <p className="m-0 text-sm">No metered usage recorded for the current period.</p>
        ) : (
          <UsageTable meters={usage} />
        )}
        <h2 className="m-0 text-base font-semibold">Refund history</h2>
        {refunds.length === 0 ? (
          <p className="m-0 text-sm">No refunds requested for this organization.</p>
        ) : (
          <RefundsTable refunds={refunds} />
        )}
        <p className="wx-source-line">
          <Glyph name="info" size={14} />
          <span className="wx-source-text">
            A full state-transition history is retained server-side; it is not yet exposed as a read
            surface here.
          </span>
        </p>
      </div>
      <SubscriptionSummary sub={sub} />
    </div>
  );
}

function UsageTable({ meters }: { meters: readonly UsageMeter[] }): JSX.Element {
  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table wx-list-table-static">
        <caption className="wx-sr-only">Usage this period</caption>
        <thead>
          <tr>
            <th scope="col">Meter</th>
            <th scope="col" className="wx-num-col">
              Used
            </th>
            <th scope="col" className="wx-num-col">
              Included
            </th>
            <th scope="col" className="wx-num-col">
              Overage
            </th>
            <th scope="col" className="wx-num-col">
              Proj. cost
            </th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {meters.map((m) => (
            <tr key={m.eventType}>
              <td>
                <span className="wx-row-title">{m.label}</span>
              </td>
              <td className="wx-num-col wx-nums">{m.totalQuantity.toLocaleString()}</td>
              <td className="wx-num-col wx-nums">{m.inclusiveQuantity.toLocaleString()}</td>
              <td className="wx-num-col wx-nums">{m.overageQuantity.toLocaleString()}</td>
              <td className="wx-num-col wx-nums">{formatCents(m.projectedOverageCostCents)}</td>
              <td>
                <StatusPill
                  label={cap(m.thresholdState)}
                  tone={usageThresholdTone(m.thresholdState)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RefundsTable({ refunds }: { refunds: readonly Refund[] }): JSX.Element {
  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table wx-list-table-static">
        <caption className="wx-sr-only">Refund history</caption>
        <thead>
          <tr>
            <th scope="col">Requested</th>
            <th scope="col" className="wx-num-col">
              Amount
            </th>
            <th scope="col">Reason</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {refunds.map((r) => (
            <tr key={r.id}>
              <td className="wx-nums">{formatDate(r.requestedAt)}</td>
              <td className="wx-num-col wx-nums">{formatCents(r.amountCents)}</td>
              <td>{cap(r.reasonCode)}</td>
              <td>
                <StatusPill label={cap(r.status)} tone={refundTone(r.status)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SubscriptionSummary({ sub }: { sub: AdminSub }): JSX.Element {
  return (
    <aside className="wx-admission-drawer" aria-label="Subscription summary">
      <DrawerHead
        icon="receipt"
        title={orgLabel(sub.organizationName, sub.organizationId)}
        sub={sub.planName}
      />
      <div className="wx-drawer-body">
        <section className="wx-drawer-card">
          <div className="wx-drawer-card-head">
            <h3>Subscription</h3>
            <StatusPill label={cap(sub.status)} tone={subscriptionTone(sub.status)} />
          </div>
          <dl className="wx-kv">
            <dt>Dunning</dt>
            <dd>
              {sub.dunningStage === "none" ? (
                "—"
              ) : (
                <StatusPill label={cap(sub.dunningStage)} tone={dunningTone(sub.dunningStage)} />
              )}
            </dd>
            <dt>Plan</dt>
            <dd>
              {sub.planName} · {cap(sub.planTier)}
            </dd>
            <dt>Started</dt>
            <dd className="wx-nums">{formatDate(sub.startedAt)}</dd>
            <dt>Current period</dt>
            <dd className="wx-nums">
              {formatDate(sub.currentPeriodStart)} — {formatDate(sub.currentPeriodEnd)}
            </dd>
            <dt>Cancel at period end</dt>
            <dd>{sub.cancelAtPeriodEnd ? "Yes" : "No"}</dd>
          </dl>
        </section>
        <section className="wx-drawer-card">
          <h3>Stripe</h3>
          <dl className="wx-kv">
            <dt>Subscription</dt>
            <dd className="wx-data-md">{sub.stripeSubscriptionId ?? "— (pending sync)"}</dd>
          </dl>
        </section>
      </div>
    </aside>
  );
}
