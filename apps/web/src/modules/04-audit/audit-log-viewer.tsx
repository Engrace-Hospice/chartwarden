import {
  EmptyState,
  FilterBar,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  type StatusTone,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/04-audit — Audit Log Viewer (M4, Track A).
// Spec: docs/design/screens/admin/WARDENX_UI_AUDIT_LOG_VIEWER.md — "Use Work Queue."
// Filterable, cursor-paginated audit-event table with a right detail panel, over the real route
// GET /api/v1/audit/events via the generated typed client. Imports only leaves (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

// Wire shape mirrored from apps/backend/.../audit-typebox.ts AuditEventSchema (UI owns its copy).
interface AuditEvent {
  id: string;
  createdAt: string;
  organizationId: string | null;
  actorUserId: string | null;
  actorKind: string;
  actorRole: string | null;
  eventType: string;
  resourceKind: string;
  resourceId: string | null;
  outcome: "success" | "failure" | "denied";
  severity: "info" | "warn" | "critical";
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  context: Record<string, unknown>;
  retentionClass: string;
}

interface Filters {
  eventType: string;
  resourceKind: string;
  outcome: string;
  severity: string;
}
const EMPTY_FILTERS: Filters = { eventType: "", resourceKind: "", outcome: "", severity: "" };

// §6.6 status taxonomy: audit outcome + severity → tone. `denied` is a deliberate guard block (warning,
// not a crash); `failure` is an operational error; audit `critical` severity maps to the error tone (the
// gold `critical` StatusPill tone is reserved for controlled-substance, §10).
const OUTCOME_TONE: Record<string, StatusTone> = {
  success: "success",
  denied: "warning",
  failure: "error",
};
const SEVERITY_TONE: Record<string, StatusTone> = {
  info: "neutral",
  warn: "warning",
  critical: "error",
};
const label = (s: string): string => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function AuditLogViewer(): JSX.Element {
  const client = useApiClient();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [items, setItems] = useState<AuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AuditEvent | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      const query: Record<string, string | number> = { limit: 50 };
      if (filters.eventType) query.eventType = filters.eventType;
      if (filters.resourceKind) query.resourceKind = filters.resourceKind;
      if (filters.outcome) query.outcome = filters.outcome;
      if (filters.severity) query.severity = filters.severity;
      if (cursor) query.cursor = cursor;

      const { data, error: err } = await client.GET("/api/v1/audit/events", { params: { query } });
      if (err) {
        setError("Could not load audit events.");
        setLoading(false);
        return;
      }
      const page = (data?.items ?? []) as AuditEvent[];
      setItems((prev) => (cursor ? [...prev, ...page] : page));
      setNextCursor(data?.nextCursor ?? null);
      setLoading(false);
    },
    [client, filters],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <WorkQueueLayout
      header={<PageHeader title="Audit Log" />}
      filters={
        <FilterBar
          actions={
            <button type="button" onClick={() => setFilters(EMPTY_FILTERS)}>
              Clear
            </button>
          }
        >
          <input
            aria-label="Action / event type"
            placeholder="Action"
            value={filters.eventType}
            onChange={(e) => setFilters((f) => ({ ...f, eventType: e.target.value }))}
          />
          <input
            aria-label="Entity type"
            placeholder="Entity"
            value={filters.resourceKind}
            onChange={(e) => setFilters((f) => ({ ...f, resourceKind: e.target.value }))}
          />
          <select
            aria-label="Outcome"
            value={filters.outcome}
            onChange={(e) => setFilters((f) => ({ ...f, outcome: e.target.value }))}
          >
            <option value="">Any outcome</option>
            <option value="success">Success</option>
            <option value="failure">Failure</option>
            <option value="denied">Denied</option>
          </select>
          <select
            aria-label="Severity"
            value={filters.severity}
            onChange={(e) => setFilters((f) => ({ ...f, severity: e.target.value }))}
          >
            <option value="">Any severity</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="critical">Critical</option>
          </select>
        </FilterBar>
      }
      table={
        <AuditTable
          items={items}
          loading={loading}
          error={error}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
          onLoadMore={nextCursor ? () => load(nextCursor) : undefined}
        />
      }
      detail={
        selected ? <EventDetail event={selected} onClose={() => setSelected(null)} /> : undefined
      }
    />
  );
}

function AuditTable({
  items,
  loading,
  error,
  selectedId,
  onSelect,
  onLoadMore,
}: {
  items: AuditEvent[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (e: AuditEvent) => void;
  onLoadMore?: () => void;
}): JSX.Element {
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (loading && items.length === 0) return <LoadingSpinner />;
  if (items.length === 0)
    return (
      <EmptyState title="No audit events" description="No events match the current filters." />
    );
  return (
    <div style={{ padding: "0 1.5rem 1.5rem" }}>
      <table>
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Entity</th>
            <th>Outcome</th>
            <th>Severity</th>
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr
              key={e.id}
              // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
              role="button"
              tabIndex={0}
              aria-pressed={e.id === selectedId}
              onClick={() => onSelect(e)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onSelect(e);
                }
              }}
              style={{
                cursor: "pointer",
                background: e.id === selectedId ? "var(--color-primary-tint)" : undefined,
              }}
            >
              <td className="tabular-nums">{new Date(e.createdAt).toLocaleString()}</td>
              <td className={e.actorUserId ? "wx-data-md" : undefined}>
                {e.actorUserId ?? label(e.actorKind)}
              </td>
              <td>{e.eventType}</td>
              <td>{e.resourceKind}</td>
              <td>
                <StatusPill label={label(e.outcome)} tone={OUTCOME_TONE[e.outcome] ?? "neutral"} />
              </td>
              <td>
                <StatusPill
                  label={label(e.severity)}
                  tone={SEVERITY_TONE[e.severity] ?? "neutral"}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {onLoadMore ? (
        <div style={{ marginTop: "1rem", textAlign: "center" }}>
          <button type="button" onClick={onLoadMore} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function EventDetail({ event, onClose }: { event: AuditEvent; onClose: () => void }): JSX.Element {
  const row = (fieldLabel: string, value: JSX.Element | string) => (
    <div style={{ marginBottom: "0.5rem" }}>
      <div style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>
        {fieldLabel}
      </div>
      <div
        style={{ fontSize: "0.85rem", wordBreak: "break-word", color: "var(--color-on-surface)" }}
      >
        {value}
      </div>
    </div>
  );
  return (
    <RightDetailPanel title="Event detail" onClose={onClose}>
      {row(
        "Timestamp",
        <span className="tabular-nums">{new Date(event.createdAt).toLocaleString()}</span>,
      )}
      {row(
        "Actor",
        <>
          {event.actorUserId ? <span className="wx-data-md">{event.actorUserId}</span> : "—"} (
          {label(event.actorKind)}
          {event.actorRole ? `, ${label(event.actorRole)}` : ""})
        </>,
      )}
      {row("Action", event.eventType)}
      {row(
        "Entity",
        <>
          {event.resourceKind}
          {event.resourceId ? (
            <>
              {" · "}
              <span className="wx-data-md">{event.resourceId}</span>
            </>
          ) : null}
        </>,
      )}
      {row(
        "Outcome",
        <StatusPill label={label(event.outcome)} tone={OUTCOME_TONE[event.outcome] ?? "neutral"} />,
      )}
      {row(
        "Severity",
        <StatusPill
          label={label(event.severity)}
          tone={SEVERITY_TONE[event.severity] ?? "neutral"}
        />,
      )}
      {row("Retention", label(event.retentionClass))}
      <details style={{ marginTop: "0.75rem" }}>
        <summary
          style={{
            cursor: "pointer",
            fontSize: "0.8rem",
            color: "var(--color-on-surface-variant)",
          }}
        >
          Context / changes
        </summary>
        <pre
          className="wx-data-md"
          style={{
            fontSize: "0.7rem",
            overflowX: "auto",
            background: "var(--color-surface-low)",
            color: "var(--color-on-surface)",
            padding: "0.5rem",
            borderRadius: "var(--radius-md)",
          }}
        >
          {JSON.stringify(
            { before: event.before, after: event.after, context: event.context },
            null,
            2,
          )}
        </pre>
      </details>
    </RightDetailPanel>
  );
}
