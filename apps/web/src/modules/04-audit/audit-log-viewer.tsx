// apps/web/src/modules/04-audit — Audit Log Viewer (M4, Track A).
// Spec: docs/ui/screens/admin/WARDENX_UI_AUDIT_LOG_VIEWER.md — "Use Work Queue."
// Filterable, cursor-paginated audit-event table with a right detail panel, over the real route
// GET /api/v1/audit/events via the generated typed client. Imports only leaves (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import {
  EmptyState,
  FilterBar,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";

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

const severityColor: Record<AuditEvent["severity"], string> = {
  info: "#6b7280",
  warn: "#b45309",
  critical: "#b91c1c",
};

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
          <select aria-label="Outcome" value={filters.outcome} onChange={(e) => setFilters((f) => ({ ...f, outcome: e.target.value }))}>
            <option value="">Any outcome</option>
            <option value="success">success</option>
            <option value="failure">failure</option>
            <option value="denied">denied</option>
          </select>
          <select aria-label="Severity" value={filters.severity} onChange={(e) => setFilters((f) => ({ ...f, severity: e.target.value }))}>
            <option value="">Any severity</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="critical">critical</option>
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
      detail={selected ? <EventDetail event={selected} onClose={() => setSelected(null)} /> : undefined}
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
  if (items.length === 0) return <EmptyState title="No audit events" description="No events match the current filters." />;
  return (
    <div style={{ padding: "0 1.5rem 1.5rem" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#6b7280" }}>
            <th style={th}>Timestamp</th>
            <th style={th}>Actor</th>
            <th style={th}>Action</th>
            <th style={th}>Entity</th>
            <th style={th}>Outcome</th>
            <th style={th}>Severity</th>
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr
              key={e.id}
              onClick={() => onSelect(e)}
              style={{ cursor: "pointer", background: e.id === selectedId ? "#eff6ff" : undefined, borderTop: "1px solid #f3f4f6" }}
            >
              <td style={td}>{new Date(e.createdAt).toLocaleString()}</td>
              <td style={td}>{e.actorUserId ?? e.actorKind}</td>
              <td style={td}>{e.eventType}</td>
              <td style={td}>{e.resourceKind}</td>
              <td style={td}>{e.outcome}</td>
              <td style={{ ...td, color: severityColor[e.severity] }}>{e.severity}</td>
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
  const row = (label: string, value: string) => (
    <div style={{ marginBottom: "0.5rem" }}>
      <div style={{ fontSize: "0.7rem", color: "#6b7280" }}>{label}</div>
      <div style={{ fontSize: "0.85rem", wordBreak: "break-word" }}>{value}</div>
    </div>
  );
  return (
    <RightDetailPanel title="Event detail" onClose={onClose}>
      {row("Timestamp", new Date(event.createdAt).toLocaleString())}
      {row("Actor", `${event.actorUserId ?? "—"} (${event.actorKind}${event.actorRole ? `, ${event.actorRole}` : ""})`)}
      {row("Action", event.eventType)}
      {row("Entity", `${event.resourceKind}${event.resourceId ? ` · ${event.resourceId}` : ""}`)}
      {row("Outcome", event.outcome)}
      {row("Severity", event.severity)}
      {row("Retention", event.retentionClass)}
      <details style={{ marginTop: "0.75rem" }}>
        <summary style={{ cursor: "pointer", fontSize: "0.8rem" }}>Context / changes</summary>
        <pre style={{ fontSize: "0.7rem", overflowX: "auto", background: "#f9fafb", padding: "0.5rem", borderRadius: "0.375rem" }}>
          {JSON.stringify({ before: event.before, after: event.after, context: event.context }, null, 2)}
        </pre>
      </details>
    </RightDetailPanel>
  );
}

const th = { padding: "0.5rem 0.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem 0.5rem" } as const;
