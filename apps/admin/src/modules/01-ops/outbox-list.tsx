import { Button, Glyph, InlineAlert, LoadingSpinner, StatusPill, useApiClient } from "@wardenx/ui";
// apps/admin/src/modules/01-ops — Outbox status (`/admin/ops/outbox`, WX-PR-020/OPS-004). The M1
// operator recovery view over `outbox_event` (apps/backend/src/bootstrap/routes/ops-outbox.ts) —
// read-only: the dispatcher already retries on its own backoff clock, so this is for diagnosing
// what's stuck and why, not manual intervention.
//
// The redesign's list + right drawer: a row opens the event in the drawer, kept in `?event=<id>` so the filter
// survives and an event can be linked to (the old detail route, `/admin/ops/outbox/:id`, redirects here).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { OutboxEventDrawer } from "./outbox-detail";
import { type OutboxStatus, outboxStatusTone } from "./outbox-status";

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
const LIST_PATH = "/admin/ops/outbox";

export function OutboxList(): JSX.Element {
  const client = useApiClient();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("event");
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

  const counts = STATUS_FILTERS.map((s) => ({ s, n: rows.filter((r) => r.status === s).length }));

  return (
    <div className={`wx-list-drawer${selectedId ? " has-drawer" : ""}`}>
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Outbox</h1>
            <p>Domain events waiting for, or already through, the outbox dispatcher.</p>
          </div>
          <div className="wx-list-toolbar-end">
            <select
              value={status}
              onChange={(ev) => setStatus(ev.target.value as OutboxStatus | "")}
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              {STATUS_FILTERS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <Button tone="secondary" onClick={() => void load()}>
              Refresh
            </Button>
          </div>
        </header>

        {!loading && !error ? (
          <>
            <div className="wx-stat-grid" aria-label="Outbox summary">
              {counts.map(({ s, n }) => (
                <div key={s} className="wx-stat-card">
                  <div>
                    <span className="wx-stat-label">
                      {s[0]?.toUpperCase()}
                      {s.slice(1)}
                    </span>
                    <span className="wx-stat-value wx-nums">{n}</span>
                  </div>
                </div>
              ))}
            </div>
            <p className="wx-row-sub">
              Counts cover the {rows.length} most recent events in this view, not the whole outbox.
            </p>
          </>
        ) : null}

        {loading ? (
          <div className="wx-list-state">
            <LoadingSpinner label="Loading outbox…" />
          </div>
        ) : error ? (
          <div className="wx-list-state" role="alert">
            <InlineAlert tone="error">{error}</InlineAlert>
            <Button tone="secondary" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="wx-list-state">
            <Glyph name="check-circle" size={24} />
            <span>No outbox events match this filter.</span>
          </div>
        ) : (
          <div className="wx-list-table-wrap">
            <table className="wx-list-table">
              <caption className="wx-sr-only">Outbox events</caption>
              <thead>
                <tr>
                  <th scope="col">Event</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="wx-num-col">
                    Attempts
                  </th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isSelected = r.id === selectedId;
                  const open = (): void => setParams({ event: r.id });
                  return (
                    <tr
                      key={r.id}
                      className={
                        isSelected
                          ? "is-selected wx-data-row-interactive"
                          : "wx-data-row-interactive"
                      }
                      tabIndex={0}
                      aria-selected={isSelected}
                      onClick={open}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          open();
                        }
                      }}
                    >
                      <td>
                        <span className="wx-row-title">{r.eventType}</span>
                        <span className="wx-row-sub wx-data-md">
                          {r.aggregateKind} · {r.aggregateId.slice(0, 8)}
                        </span>
                      </td>
                      <td>
                        <StatusPill label={r.status} tone={outboxStatusTone(r.status)} />
                      </td>
                      <td className="wx-num-col wx-nums">{r.attemptCount}</td>
                      <td className="wx-nums">{new Date(r.createdAt).toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {selectedId ? (
        <OutboxEventDrawer key={selectedId} id={selectedId} onClose={() => setParams({})} />
      ) : null}
    </div>
  );
}

/** `/admin/ops/outbox/:id` — the Outbox list with that event's drawer open. */
export function OutboxEventRedirect(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={id ? `${LIST_PATH}?event=${encodeURIComponent(id)}` : LIST_PATH} replace />;
}
