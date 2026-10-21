import { Button, StatusPill, useApiClient, useRequestGuard } from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Stripe webhooks (`/admin/webhooks/stripe`,
// stripe.admin.read). Recent inbound webhook receipts over GET /api/admin/webhooks/stripe/recent, searchable
// by event id / type client-side, with a per-event Replay (stripe.admin.replay — step-up + Idempotency-Key)
// that re-enqueues processing through the existing outbox path (vendor SDK OFF). Cursor-paged.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { formatDate, idempotencyKey } from "./status";
import {
  LoadMore,
  type Outcome,
  OutcomeBanner,
  StateEmpty,
  StateError,
  StateLoading,
  failureOutcome,
} from "./ui";

type WebhookReceiptsPage =
  operations["getApiAdminWebhooksStripeRecent"]["responses"][200]["content"]["application/json"];
type Receipt = WebhookReceiptsPage["items"][number];

export function Webhooks(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<Receipt[]>([]);
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const guard = useRequestGuard();

  const load = useCallback(
    async (nextCursor: string | null, append: boolean) => {
      const isCurrent = guard();
      setLoading(true);
      setError(null);
      const query: Record<string, string> = {};
      if (nextCursor) query.cursor = nextCursor;
      const res = await client.GET("/api/admin/webhooks/stripe/recent", { params: { query } });
      if (!isCurrent()) return;
      if (res.error) {
        setError("Webhook receipts unavailable.");
        setLoading(false);
        return;
      }
      const page = res.data;
      setRows((prev) => (append ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
      setLoading(false);
    },
    [client, guard],
  );

  useEffect(() => {
    void load(null, false);
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) => r.stripeEventId.toLowerCase().includes(q) || r.eventType.toLowerCase().includes(q),
    );
  }, [rows, search]);

  const replay = useCallback(
    async (eventId: string) => {
      setBusyId(eventId);
      setOutcome(null);
      const res = await client.POST("/api/admin/webhooks/stripe/replay/{eventId}", {
        params: { path: { eventId } },
        headers: { "Idempotency-Key": idempotencyKey() },
      });
      if (res.error) {
        setOutcome(failureOutcome(res.error, "Could not replay this event."));
      } else {
        setOutcome({ ok: true, message: `Event ${eventId} re-enqueued.` });
        await load(null, false);
      }
      setBusyId(null);
    },
    [client, load],
  );

  return (
    <div className="wx-list-drawer">
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Stripe webhooks</h1>
            <p>Recent inbound Stripe events. Replay re-enqueues one through the outbox.</p>
          </div>
          <div className="wx-list-toolbar-end">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search event id / type"
              aria-label="Search webhooks"
            />
          </div>
        </header>
        {outcome ? <OutcomeBanner {...outcome} /> : null}
        {loading && rows.length === 0 ? (
          <StateLoading label="Loading webhook receipts…" />
        ) : error ? (
          <StateError message={error} onRetry={() => void load(null, false)} />
        ) : filtered.length === 0 ? (
          <StateEmpty icon="send">
            {search ? "No receipts match this search." : "No recent webhooks."}
          </StateEmpty>
        ) : (
          <>
            <ReceiptsTable rows={filtered} busyId={busyId} onReplay={(id) => void replay(id)} />
            <LoadMore hasMore={hasMore} loading={loading} onMore={() => void load(cursor, true)} />
          </>
        )}
      </div>
    </div>
  );
}

function ReceiptsTable({
  rows,
  busyId,
  onReplay,
}: {
  rows: readonly Receipt[];
  busyId: string | null;
  onReplay: (eventId: string) => void;
}): JSX.Element {
  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table wx-list-table-static">
        <caption className="wx-sr-only">Stripe webhook receipts</caption>
        <thead>
          <tr>
            <th scope="col">Event</th>
            <th scope="col">Received</th>
            <th scope="col">Processed</th>
            <th scope="col" className="wx-num-col">
              Attempts
            </th>
            <th scope="col">
              <span className="wx-sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.stripeEventId}>
              <td>
                <span className="wx-row-title">{r.eventType}</span>
                <span className="wx-row-sub wx-data-md">{r.stripeEventId}</span>
              </td>
              <td className="wx-nums">{formatDate(r.receivedAt)}</td>
              <td>
                {r.processedAt ? (
                  <StatusPill label="Processed" tone="success" />
                ) : (
                  <StatusPill label="Pending" tone="progress" />
                )}
              </td>
              <td className="wx-num-col wx-nums">{r.processingAttemptCount}</td>
              <td>
                <div className="flex justify-end">
                  <Button
                    tone="secondary"
                    size="sm"
                    onClick={() => onReplay(r.stripeEventId)}
                    disabled={busyId === r.stripeEventId}
                  >
                    Replay
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
