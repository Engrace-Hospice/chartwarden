import { EmptyState, LoadingSpinner, PageHeader, StatusPill, useApiClient } from "@wardenx/ui";
import type { operations } from "@wardenx/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Subscriptions list (`/admin/subscriptions`,
// subscription.admin.read). The cross-tenant subscription roster over GET /api/admin/subscriptions, filtered
// by status (server) with the org DISPLAY NAME (M35A-T03 seam) rendered instead of a raw UUID, plus plan,
// dunning stage, and payment-method context. Cursor-paged. Each row links to the subscription detail.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { SUBSCRIPTION_STATUSES, cap, dunningTone, orgLabel, subscriptionTone } from "./status";
import { LoadMore, actionButtonStyle, bodyRow, cell, inputStyle, tableStyle, theadRow } from "./ui";

type SubscriptionsPage =
  operations["getApiAdminSubscriptions"]["responses"][200]["content"]["application/json"];
type AdminSub = SubscriptionsPage["items"][number];

export function SubscriptionsList(): JSX.Element {
  const client = useApiClient();
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

  return (
    <div
      style={{ padding: "1.5rem 1.75rem", display: "flex", flexDirection: "column", gap: "1rem" }}
    >
      <PageHeader
        title="Subscriptions"
        breadcrumb="Platform Ops"
        actions={
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            style={inputStyle}
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            {SUBSCRIPTION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {cap(s)}
              </option>
            ))}
          </select>
        }
      />
      {loading && rows.length === 0 ? (
        <LoadingSpinner />
      ) : error || rows.length === 0 ? (
        <EmptyState
          title={error ?? "No subscriptions"}
          description={error ? "Retry shortly." : "No subscriptions match this filter."}
        />
      ) : (
        <>
          <table style={tableStyle}>
            <thead>
              <tr style={theadRow}>
                <th style={cell}>Organization</th>
                <th style={cell}>Plan</th>
                <th style={cell}>Status</th>
                <th style={cell}>Dunning</th>
                <th style={cell}>Card</th>
                <th style={cell} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={bodyRow}>
                  <td style={cell}>
                    <span style={{ fontWeight: 600 }}>
                      {orgLabel(r.organizationName, r.organizationId)}
                    </span>
                  </td>
                  <td style={cell}>
                    {r.planName}{" "}
                    <span style={{ color: "var(--color-on-surface-variant)", fontSize: "0.75rem" }}>
                      {cap(r.planTier)}
                    </span>
                  </td>
                  <td style={cell}>
                    <StatusPill label={cap(r.status)} tone={subscriptionTone(r.status)} />
                  </td>
                  <td style={cell}>
                    {r.dunningStage === "none" ? (
                      "—"
                    ) : (
                      <StatusPill label={cap(r.dunningStage)} tone={dunningTone(r.dunningStage)} />
                    )}
                  </td>
                  <td style={cell} className="tabular-nums">
                    {r.defaultPaymentMethodLast4 ? `•••• ${r.defaultPaymentMethodLast4}` : "—"}
                  </td>
                  <td style={cell}>
                    <Link to={`/admin/subscriptions/${r.id}`} style={actionButtonStyle(false)}>
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <LoadMore hasMore={hasMore} loading={loading} onMore={() => void load(cursor, true)} />
        </>
      )}
    </div>
  );
}
