import { Button, StatusPill, type StatusTone, useApiClient } from "@wardenx/ui";
// apps/admin/src/modules/36-messaging — Alert deliveries (`/admin/messaging/alert-deliveries`, M36 §4.1, GAP-165).
// Platform-ops failures-and-audit drill over GET /api/v1/admin/messaging/alert-deliveries: delivery METADATA only
// (the server returns no recipient, destination or payload), cross-tenant, keyset-paginated via `nextBefore`.
import { useCallback, useState } from "react";
import type { JSX } from "react";
import { type ReadResult, StateEmpty, renderLoadFallback, toReadResult, useLoad } from "./ui";

export const DELIVERY_STATUSES = [
  "failed",
  "pending",
  "sent",
  "delivered",
  "skipped_quiet_hours",
  "forwarded",
  "all",
] as const;
export type DeliveryStatusFilter = (typeof DELIVERY_STATUSES)[number];

const PAGE_SIZE = 50;

interface DeliveryRow {
  readonly deliveryId: string;
  readonly organizationId: string;
  readonly alertId: string;
  readonly alertCategory: string;
  readonly alertSeverity: string;
  readonly channel: string;
  readonly status: string;
  readonly failReason: string | null;
  readonly queuedAt: string;
  readonly sentAt: string | null;
  readonly settledAt: string | null;
}
interface DeliveryPage {
  readonly items: readonly DeliveryRow[];
  readonly nextBefore: string | null;
}

export function deliveryTone(status: string): StatusTone {
  if (status === "failed") return "error";
  if (status === "pending") return "progress";
  if (status === "sent" || status === "delivered" || status === "forwarded") return "success";
  return "neutral";
}

export function AlertDeliveries(): JSX.Element {
  const client = useApiClient();
  const [status, setStatus] = useState<DeliveryStatusFilter>("failed");
  const [older, setOlder] = useState<{ rows: readonly DeliveryRow[]; next: string | null } | null>(
    null,
  );
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState(false);

  const fetchPage = useCallback(
    async (before?: string): Promise<ReadResult<DeliveryPage>> => {
      const { data, error, response } = await client.GET(
        "/api/v1/admin/messaging/alert-deliveries",
        { params: { query: { status, limit: PAGE_SIZE, ...(before ? { before } : {}) } } },
      );
      return toReadResult(response.status, data, Boolean(error));
    },
    [client, status],
  );
  const { state, reload } = useLoad(fetchPage);

  // A new filter or a reload starts again from the first page.
  const onFilter = (next: DeliveryStatusFilter): void => {
    setOlder(null);
    setMoreError(false);
    setStatus(next);
  };
  const onRefresh = (): void => {
    setOlder(null);
    setMoreError(false);
    reload();
  };

  const loadMore = async (cursor: string, prior: readonly DeliveryRow[]): Promise<void> => {
    setMoreLoading(true);
    setMoreError(false);
    const result = await fetchPage(cursor);
    setMoreLoading(false);
    if (result.kind !== "ok") return setMoreError(true);
    setOlder({ rows: [...prior, ...result.data.items], next: result.data.nextBefore });
  };

  const fallback = renderLoadFallback(state, {
    loading: "Loading alert deliveries…",
    error: "Could not load alert deliveries.",
    noAccess: "alert deliveries",
    retry: onRefresh,
  });
  const firstPage = state.kind === "ok" ? state.data : null;
  const rows = firstPage ? [...firstPage.items, ...(older?.rows ?? [])] : [];
  const nextCursor = older ? older.next : (firstPage?.nextBefore ?? null);

  return (
    <div className="wx-list-drawer-main">
      <header className="wx-page-head">
        <div>
          <h1>Alert deliveries</h1>
          <p>
            Notification delivery outcomes across tenants. Metadata only; every read is audited.
          </p>
        </div>
        <div className="wx-list-toolbar-end">
          <select
            value={status}
            onChange={(ev) => onFilter(ev.target.value as DeliveryStatusFilter)}
            aria-label="Filter by delivery status"
          >
            {DELIVERY_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s === "all" ? "All statuses" : s.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <Button tone="secondary" size="lg" onClick={onRefresh}>
            Refresh
          </Button>
        </div>
      </header>

      {fallback ??
        (rows.length === 0 ? (
          <StateEmpty>No deliveries match this filter.</StateEmpty>
        ) : (
          <>
            <div className="wx-list-table-wrap">
              <table className="wx-list-table">
                <caption className="wx-sr-only">Alert deliveries</caption>
                <thead>
                  <tr>
                    <th scope="col">Alert</th>
                    <th scope="col">Tenant</th>
                    <th scope="col">Channel</th>
                    <th scope="col">Status</th>
                    <th scope="col">Failure reason</th>
                    <th scope="col">Queued</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.deliveryId}>
                      <td>
                        <span className="wx-row-title">{r.alertCategory}</span>
                        <span className="wx-row-sub">{r.alertSeverity}</span>
                      </td>
                      <td className="wx-data-md">{r.organizationId.slice(0, 8)}</td>
                      <td>{r.channel}</td>
                      <td>
                        <StatusPill
                          label={r.status.replace(/_/g, " ")}
                          tone={deliveryTone(r.status)}
                        />
                      </td>
                      <td>{r.failReason ?? "—"}</td>
                      <td className="wx-nums">{new Date(r.queuedAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {moreError ? <p role="alert">Could not load more deliveries.</p> : null}
            {nextCursor ? (
              <div className="wx-list-state">
                <Button
                  tone="secondary"
                  size="lg"
                  loading={moreLoading}
                  onClick={() =>
                    void loadMore(nextCursor, rows.slice(firstPage?.items.length ?? 0))
                  }
                >
                  Load more
                </Button>
              </div>
            ) : null}
          </>
        ))}
    </div>
  );
}
