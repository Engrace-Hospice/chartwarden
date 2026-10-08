import { Button, StatusPill, useApiClient } from "@wardenx/ui";
import type { operations } from "@wardenx/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Subscriptions list (`/admin/subscriptions`,
// subscription.admin.read). The cross-tenant subscription roster over GET /api/admin/subscriptions, filtered
// by status (server) with the org DISPLAY NAME (M35A-T03 seam) rendered instead of a raw UUID, plus plan,
// dunning stage, and payment-method context. Cursor-paged. Redesign list + right drawer: a row opens the
// subscription in the drawer (`?subscription=<id>`), whose actions lead to its detail, pause and apply-promo pages.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { SUBSCRIPTION_STATUSES, cap, dunningTone, orgLabel, subscriptionTone } from "./status";
import {
  DrawerHead,
  LoadMore,
  StateEmpty,
  StateError,
  StateLoading,
  selectableRowProps,
} from "./ui";

type SubscriptionsPage =
  operations["getApiAdminSubscriptions"]["responses"][200]["content"]["application/json"];
type AdminSub = SubscriptionsPage["items"][number];

export function SubscriptionsList(): JSX.Element {
  const client = useApiClient();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("subscription");
  const [rows, setRows] = useState<AdminSub[]>([]);
  const [status, setStatus] = useState<string>("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (nextCursor: string | null, append: boolean) => {
      setLoading(true);
      setError(null);
      const query: Record<string, string> = {};
      if (status) query.status = status;
      if (nextCursor) query.cursor = nextCursor;
      const res = await client.GET("/api/admin/subscriptions", { params: { query } });
      if (res.error) {
        setError("Subscriptions unavailable.");
        setLoading(false);
        return;
      }
      const page = res.data;
      setRows((prev) => (append ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
      setLoading(false);
    },
    [client, status],
  );

  useEffect(() => {
    void load(null, false);
  }, [load]);

  const selected = selectedId ? (rows.find((r) => r.id === selectedId) ?? null) : null;

  return (
    <div className={`wx-list-drawer${selected ? " has-drawer" : ""}`}>
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Subscriptions</h1>
            <p>Every tenant's subscription, its plan and where it stands in dunning.</p>
          </div>
          <div className="wx-list-toolbar-end">
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              {SUBSCRIPTION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {cap(s)}
                </option>
              ))}
            </select>
          </div>
        </header>
        {loading && rows.length === 0 ? (
          <StateLoading label="Loading subscriptions…" />
        ) : error ? (
          <StateError message={error} onRetry={() => void load(null, false)} />
        ) : rows.length === 0 ? (
          <StateEmpty icon="receipt">No subscriptions match this filter.</StateEmpty>
        ) : (
          <>
            <SubscriptionsTable
              rows={rows}
              selectedId={selectedId}
              onOpen={(id) => setParams({ subscription: id })}
            />
            <LoadMore hasMore={hasMore} loading={loading} onMore={() => void load(cursor, true)} />
          </>
        )}
      </div>
      {selected ? <SubscriptionDrawer sub={selected} onClose={() => setParams({})} /> : null}
    </div>
  );
}

function DunningCell({ stage }: { stage: string }): JSX.Element {
  return stage === "none" ? <>—</> : <StatusPill label={cap(stage)} tone={dunningTone(stage)} />;
}

const cardText = (last4: string | null | undefined): string => (last4 ? `•••• ${last4}` : "—");

function SubscriptionsTable({
  rows,
  selectedId,
  onOpen,
}: {
  rows: readonly AdminSub[];
  selectedId: string | null;
  onOpen: (id: string) => void;
}): JSX.Element {
  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table">
        <caption className="wx-sr-only">Subscriptions</caption>
        <thead>
          <tr>
            <th scope="col">Organization</th>
            <th scope="col">Plan</th>
            <th scope="col">Status</th>
            <th scope="col">Dunning</th>
            <th scope="col">Card</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} {...selectableRowProps(r.id === selectedId, () => onOpen(r.id))}>
              <td>
                <span className="wx-row-title">
                  {orgLabel(r.organizationName, r.organizationId)}
                </span>
              </td>
              <td>
                <span className="wx-row-title">{r.planName}</span>
                <span className="wx-row-sub">{cap(r.planTier)}</span>
              </td>
              <td>
                <StatusPill label={cap(r.status)} tone={subscriptionTone(r.status)} />
              </td>
              <td>
                <DunningCell stage={r.dunningStage} />
              </td>
              <td className="wx-nums">{cardText(r.defaultPaymentMethodLast4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SubscriptionDrawer({ sub, onClose }: { sub: AdminSub; onClose: () => void }): JSX.Element {
  const navigate = useNavigate();
  return (
    <aside className="wx-admission-drawer" aria-label="Subscription">
      <DrawerHead
        icon="receipt"
        title={orgLabel(sub.organizationName, sub.organizationId)}
        sub={`${sub.planName} · ${cap(sub.planTier)}`}
        onClose={onClose}
      />
      <div className="wx-drawer-body">
        <section className="wx-drawer-card">
          <div className="wx-drawer-card-head">
            <h3>Subscription</h3>
            <StatusPill label={cap(sub.status)} tone={subscriptionTone(sub.status)} />
          </div>
          <dl className="wx-kv">
            <dt>Plan</dt>
            <dd>
              {sub.planName} · {cap(sub.planTier)}
            </dd>
            <dt>Dunning</dt>
            <dd>
              <DunningCell stage={sub.dunningStage} />
            </dd>
            <dt>Card</dt>
            <dd className="wx-nums">{cardText(sub.defaultPaymentMethodLast4)}</dd>
          </dl>
          <div className="wx-drawer-actions">
            <Button onClick={() => navigate(`/admin/subscriptions/${sub.id}`)}>
              Open subscription
            </Button>
            <Button
              tone="secondary"
              onClick={() => navigate(`/admin/subscriptions/${sub.id}/apply_promo`)}
            >
              Apply promo
            </Button>
            <Button
              tone="secondary"
              onClick={() => navigate(`/admin/subscriptions/${sub.id}/pause`)}
            >
              Pause
            </Button>
          </div>
        </section>
      </div>
    </aside>
  );
}
