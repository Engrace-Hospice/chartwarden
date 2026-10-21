import {
  Button,
  Glyph,
  InlineAlert,
  LoadingSpinner,
  StatusPill,
  useApiClient,
  useDrawerA11y,
} from "@chartwarden/ui";
// apps/admin/src/modules/01-ops — one outbox event in the Outbox screen's right drawer (WX-PR-020/OPS-004), opened by
// `?event=<id>`; the old detail route `/admin/ops/outbox/:id` redirects there.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { type OutboxStatus, outboxStatusTone } from "./outbox-status";

interface OutboxEvent {
  id: string;
  eventType: string;
  aggregateKind: string;
  aggregateId: string;
  status: OutboxStatus;
  attemptCount: number;
  lastError: string | null;
  payload: unknown;
  createdAt: string;
  dispatchedAt: string | null;
  nextAttemptAt: string | null;
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

export function OutboxEventDrawer({
  id,
  onClose,
}: { id: string; onClose: () => void }): JSX.Element {
  const client = useApiClient();
  const drawer = useDrawerA11y<HTMLElement>(onClose);
  const [event, setEvent] = useState<OutboxEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    (async () => {
      const { data, error: err } = await client.GET("/api/v1/ops/outbox/{id}", {
        params: { path: { id } },
      });
      if (!active) return;
      if (err || !data) setError("This outbox event could not be found.");
      else setEvent(data as unknown as OutboxEvent);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [id, client]);

  return (
    <aside className="wx-admission-drawer" aria-label="Outbox event" {...drawer}>
      <header className="wx-drawer-head">
        <span className="wx-rail-icon" aria-hidden>
          <Glyph name="send" size={16} />
        </span>
        <div className="wx-drawer-head-main">
          <h2>{event?.eventType ?? "Outbox event"}</h2>
          <span className="wx-row-sub wx-data-md">{id}</span>
        </div>
        <Button tone="tertiary" size="sm" aria-label="Close" onClick={onClose}>
          <Glyph name="close" size={16} />
        </Button>
      </header>
      <div className="wx-drawer-body">
        {loading ? (
          <LoadingSpinner label="Loading event…" />
        ) : error || !event ? (
          <InlineAlert tone="error">{error ?? "This outbox event could not be found."}</InlineAlert>
        ) : (
          <>
            <section className="wx-drawer-card">
              <div className="wx-drawer-card-head">
                <h3>Delivery</h3>
                <StatusPill label={event.status} tone={outboxStatusTone(event.status)} />
              </div>
              <dl className="wx-kv">
                <dt>Aggregate</dt>
                <dd>
                  {event.aggregateKind} · <span className="wx-data-md">{event.aggregateId}</span>
                </dd>
                <dt>Attempts</dt>
                <dd className="wx-nums">{event.attemptCount}</dd>
                <dt>Created</dt>
                <dd className="wx-nums">{when(event.createdAt)}</dd>
                <dt>Dispatched</dt>
                <dd className="wx-nums">{when(event.dispatchedAt)}</dd>
                <dt>Next attempt</dt>
                <dd className="wx-nums">{when(event.nextAttemptAt)}</dd>
              </dl>
            </section>
            {event.lastError ? (
              <section className="wx-drawer-card">
                <h3>Last error</h3>
                <pre className="wx-code-block">{event.lastError}</pre>
              </section>
            ) : null}
            <section className="wx-drawer-card">
              <h3>Payload</h3>
              <pre className="wx-code-block">{JSON.stringify(event.payload, null, 2)}</pre>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
