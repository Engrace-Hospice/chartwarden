import { EmptyState, LoadingSpinner, PageHeader, StatusPill, useApiClient } from "@wardenx/ui";
// apps/admin/src/modules/01-ops — Outbox event detail (`/admin/ops/outbox/:id`, WX-PR-020/OPS-004).
import { useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { Link, useParams } from "react-router-dom";

type OutboxStatus = "pending" | "dispatching" | "dispatched" | "failed";
interface OutboxDetail {
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

function toneFor(status: OutboxStatus): "success" | "progress" | "warning" | "error" {
  if (status === "dispatched") return "success";
  if (status === "dispatching") return "progress";
  if (status === "failed") return "error";
  return "warning";
}

export function OutboxDetail(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const client = useApiClient();
  const [event, setEvent] = useState<OutboxDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let active = true;
    (async () => {
      const { data, error: err } = await client.GET("/api/v1/ops/outbox/{id}", {
        params: { path: { id } },
      });
      if (!active) return;
      if (err || !data) {
        setError("Outbox event not found.");
        setLoading(false);
        return;
      }
      setEvent(data as unknown as OutboxDetail);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [id, client]);

  return (
    <div style={columnStyle}>
      <PageHeader
        title="Outbox event"
        breadcrumb="Platform Ops"
        actions={
          <Link to="/admin/ops/outbox" style={ghostBtn}>
            Back to outbox
          </Link>
        }
      />
      {loading ? (
        <LoadingSpinner />
      ) : error || !event ? (
        <EmptyState title={error ?? "Not found"} description="This event may not exist." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <StatusPill label={event.status} tone={toneFor(event.status)} />
            <span style={{ fontWeight: 600 }}>{event.eventType}</span>
          </div>
          <dl style={dlStyle}>
            <dt style={dtStyle}>Aggregate</dt>
            <dd style={ddStyle}>
              {event.aggregateKind} · {event.aggregateId}
            </dd>
            <dt style={dtStyle}>Attempts</dt>
            <dd style={ddStyle}>{event.attemptCount}</dd>
            <dt style={dtStyle}>Created</dt>
            <dd style={ddStyle}>{new Date(event.createdAt).toLocaleString()}</dd>
            <dt style={dtStyle}>Dispatched</dt>
            <dd style={ddStyle}>
              {event.dispatchedAt ? new Date(event.dispatchedAt).toLocaleString() : "—"}
            </dd>
            <dt style={dtStyle}>Next attempt</dt>
            <dd style={ddStyle}>
              {event.nextAttemptAt ? new Date(event.nextAttemptAt).toLocaleString() : "—"}
            </dd>
          </dl>
          {event.lastError ? (
            <div>
              <h2 style={h2Style}>Last error</h2>
              <pre style={preStyle}>{event.lastError}</pre>
            </div>
          ) : null}
          <div>
            <h2 style={h2Style}>Payload</h2>
            <pre style={preStyle}>{JSON.stringify(event.payload, null, 2)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

const columnStyle: CSSProperties = {
  padding: "1.5rem 1.75rem",
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  maxWidth: "48rem",
};
const dlStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "8rem 1fr",
  rowGap: "0.4rem",
  fontSize: "0.85rem",
  margin: 0,
};
const dtStyle: CSSProperties = { color: "var(--color-on-surface-variant)", fontWeight: 600 };
const ddStyle: CSSProperties = { margin: 0 };
const h2Style: CSSProperties = { fontSize: "0.85rem", fontWeight: 700, margin: "0 0 0.4rem" };
const preStyle: CSSProperties = {
  background: "var(--color-surface-container)",
  borderRadius: "var(--radius-md)",
  padding: "0.75rem",
  fontSize: "0.78rem",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  margin: 0,
};
const ghostBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "0.5rem 1rem",
  borderRadius: "9999px",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.8125rem",
  fontWeight: 600,
  textDecoration: "none",
};
