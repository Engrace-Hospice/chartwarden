import { EmptyState, LoadingSpinner, PageHeader, StatusPill, useApiClient } from "@wardenx/ui";
// apps/admin/src/modules/01-ops — Outbox status (`/admin/ops/outbox`, WX-PR-020/OPS-004). The M1
// operator recovery view over `outbox_event` (apps/backend/src/bootstrap/routes/ops-outbox.ts) —
// read-only: the dispatcher already retries on its own backoff clock, so this is for diagnosing
// what's stuck and why, not manual intervention.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { Link } from "react-router-dom";

type OutboxStatus = "pending" | "dispatching" | "dispatched" | "failed";
interface OutboxRow {
  id: string;
  eventType: string;
  aggregateKind: string;
  aggregateId: string;
  status: OutboxStatus;
  attemptCount: number;
  createdAt: string;
  dispatchedAt: string | null;
  nextAttemptAt: string | null;
}

const STATUS_FILTERS: readonly OutboxStatus[] = ["pending", "dispatching", "dispatched", "failed"];

function toneFor(status: OutboxStatus): "success" | "progress" | "warning" | "error" {
  if (status === "dispatched") return "success";
  if (status === "dispatching") return "progress";
  if (status === "failed") return "error";
  return "warning";
}

export function OutboxList(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<OutboxRow[]>([]);
  const [status, setStatus] = useState<OutboxStatus | "">("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/ops/outbox", {
      params: { query: status ? { status } : {} },
    });
    if (err || !data) {
      setError("Could not load outbox status.");
      setLoading(false);
      return;
    }
    setRows(data.data as OutboxRow[]);
    setLoading(false);
  }, [client, status]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={columnStyle}>
      <PageHeader
        title="Outbox"
        breadcrumb="Platform Ops"
        actions={
          <select
            value={status}
            onChange={(ev) => setStatus(ev.target.value as OutboxStatus | "")}
            style={inputStyle}
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        }
      />
      {loading ? (
        <LoadingSpinner />
      ) : error ? (
        <EmptyState title={error} description="Retry shortly." />
      ) : rows.length === 0 ? (
        <EmptyState title="No outbox events" description="Nothing matches this filter." />
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={theadRow}>
              <th style={cell}>Event type</th>
              <th style={cell}>Aggregate</th>
              <th style={cell}>Status</th>
              <th style={cellRight}>Attempts</th>
              <th style={cell}>Created</th>
              <th style={cell} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={bodyRow}>
                <td style={cell}>{r.eventType}</td>
                <td style={cell}>
                  {r.aggregateKind} · {r.aggregateId.slice(0, 8)}
                </td>
                <td style={cell}>
                  <StatusPill label={r.status} tone={toneFor(r.status)} />
                </td>
                <td style={cellRight}>{r.attemptCount}</td>
                <td style={cell}>{new Date(r.createdAt).toLocaleString()}</td>
                <td style={cell}>
                  <Link to={`/admin/ops/outbox/${r.id}`} style={linkStyle}>
                    View
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const columnStyle: CSSProperties = {
  padding: "1.5rem 1.75rem",
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
};
const inputStyle: CSSProperties = {
  padding: "0.4rem 0.6rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--color-outline-variant)",
};
const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.85rem",
};
const theadRow: CSSProperties = {
  textAlign: "left",
  borderBottom: "1px solid var(--color-outline-variant)",
};
const bodyRow: CSSProperties = { borderBottom: "1px solid var(--color-outline-variant)" };
const cell: CSSProperties = { padding: "0.5rem 0.6rem" };
const cellRight: CSSProperties = { ...cell, textAlign: "right" };
const linkStyle: CSSProperties = { color: "var(--color-primary)", fontWeight: 600 };
