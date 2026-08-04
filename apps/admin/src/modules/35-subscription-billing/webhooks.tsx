import { EmptyState, LoadingSpinner, PageHeader, StatusPill, useApiClient } from "@wardenx/ui";
import type { operations } from "@wardenx/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Stripe webhooks (`/admin/webhooks/stripe`,
// stripe.admin.read). Recent inbound webhook receipts over GET /api/admin/webhooks/stripe/recent, searchable
// by event id / type client-side, with a per-event Replay (stripe.admin.replay — step-up + Idempotency-Key)
// that re-enqueues processing through the existing outbox path (vendor SDK OFF). Cursor-paged.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { formatDate, idempotencyKey } from "./status";
import {
  LoadMore,
  actionButtonStyle,
  bodyRow,
  cell,
  cellRight,
  inputStyle,
  tableStyle,
  theadRow,
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
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);

  const load = useCallback(
    async (nextCursor: string | null, append: boolean) => {
      setLoading(true);
      setError(null);
      const query: Record<string, string> = {};
      if (nextCursor) query.cursor = nextCursor;
      const res = await client.GET("/api/admin/webhooks/stripe/recent", { params: { query } });
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
    [client],
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
        const c = (res.error as { code?: string })?.code;
        setOutcome({
          ok: false,
          message:
            c === "STEP_UP_REQUIRED"
              ? "Step-up required — re-verify and retry."
              : "Could not replay this event.",
        });
      } else {
        setOutcome({ ok: true, message: `Event ${eventId} re-enqueued.` });
        await load(null, false);
      }
      setBusyId(null);
    },
    [client, load],
  );

  return (
    <div
      style={{ padding: "1.5rem 1.75rem", display: "flex", flexDirection: "column", gap: "1rem" }}
    >
      <PageHeader
        title="Stripe webhooks"
        breadcrumb="Platform Ops"
        actions={
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search event id / type"
            style={{ ...inputStyle, width: "18rem" }}
            aria-label="Search webhooks"
          />
        }
      />
      {outcome ? (
        <output aria-live="polite">
          <StatusPill label={outcome.message} tone={outcome.ok ? "success" : "error"} />
        </output>
      ) : null}
      {loading && rows.length === 0 ? (
        <LoadingSpinner />
      ) : error ? (
        <EmptyState title={error} description="Retry shortly." />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No webhook receipts"
          description={search ? "No receipts match this search." : "No recent webhooks."}
        />
      ) : (
        <>
          <table style={tableStyle}>
            <thead>
              <tr style={theadRow}>
                <th style={cell}>Event</th>
                <th style={cell}>Type</th>
                <th style={cell}>Received</th>
                <th style={cell}>Processed</th>
                <th style={cellRight}>Attempts</th>
                <th style={cell} />
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.stripeEventId} style={bodyRow}>
                  <td style={cell}>
                    <span style={{ fontSize: "0.78rem" }}>{r.stripeEventId}</span>
                  </td>
                  <td style={cell}>{r.eventType}</td>
                  <td style={cell} className="tabular-nums">
                    {formatDate(r.receivedAt)}
                  </td>
                  <td style={cell}>
                    {r.processedAt ? (
                      <StatusPill label="Processed" tone="success" />
                    ) : (
                      <StatusPill label="Pending" tone="progress" />
                    )}
                  </td>
                  <td style={cellRight} className="tabular-nums">
                    {r.processingAttemptCount}
                  </td>
                  <td style={cell}>
                    <button
                      type="button"
                      onClick={() => void replay(r.stripeEventId)}
                      disabled={busyId === r.stripeEventId}
                      style={actionButtonStyle(false, busyId === r.stripeEventId)}
                    >
                      Replay
                    </button>
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
