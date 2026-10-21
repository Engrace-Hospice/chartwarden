import {
  Button,
  CursorPagination,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  type StatusTone,
  WorkQueueLayout,
  humanizeIdentifier,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/04-audit — Audit Log Viewer (M4, Track A).
// Spec: docs/design/screens/admin/WARDENX_UI_AUDIT_LOG_VIEWER.md — "Use Work Queue."
// Filterable, cursor-paginated audit-event table with a right detail panel, over the real route
// GET /api/v1/audit/events via the generated typed client. Imports only leaves (@chartwarden/ui).
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
const AUDIT_PAGE_SIZES = [25, 50, 100] as const;

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
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AuditEvent | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      const query: Record<string, string | number> = { limit: pageSize };
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
    [client, filters, pageSize],
  );

  useEffect(() => {
    setSelected(null);
    void load();
  }, [load]);

  const hasActiveFilters =
    filters.eventType !== "" ||
    filters.resourceKind !== "" ||
    filters.outcome !== "" ||
    filters.severity !== "";

  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Audit Log" breadcrumb="Admin / Compliance">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review append-only access, authorization, data-change, and platform-operation events.
          </div>
        </PageHeader>
      }
      filters={
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
            padding: "0 1.5rem 0.75rem",
          }}
        >
          {error ? (
            <div role="alert" style={errorBannerStyle}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <Glyph name="alert" size={16} />
                <span>{error}</span>
              </div>
              <button type="button" onClick={() => setError(null)} style={dismissButtonStyle}>
                x
              </button>
            </div>
          ) : null}

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "1rem",
            }}
          >
            <span className="wx-toolbar-count">Event ledger · {items.length}</span>

            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
              <label className="wx-search-field">
                <Glyph name="search" size={16} />
                <input
                  type="search"
                  aria-label="Action / event type"
                  placeholder="Search action..."
                  value={filters.eventType}
                  onChange={(e) => setFilters((f) => ({ ...f, eventType: e.target.value }))}
                />
              </label>

              <input
                aria-label="Entity type"
                placeholder="Entity"
                value={filters.resourceKind}
                onChange={(e) => setFilters((f) => ({ ...f, resourceKind: e.target.value }))}
                style={{ minWidth: "9rem", height: "2.25rem", fontSize: "0.85rem" }}
              />
              <label className="wx-filter-field">
                <span>Outcome</span>
                <select
                  className="wx-select"
                  aria-label="Outcome"
                  value={filters.outcome}
                  onChange={(e) => setFilters((f) => ({ ...f, outcome: e.target.value }))}
                  style={{ height: "2.25rem", fontSize: "0.85rem", cursor: "pointer" }}
                >
                  <option value="">All</option>
                  <option value="success">Success</option>
                  <option value="failure">Failure</option>
                  <option value="denied">Denied</option>
                </select>
              </label>
              <label className="wx-filter-field">
                <span>Severity</span>
                <select
                  className="wx-select"
                  aria-label="Severity"
                  value={filters.severity}
                  onChange={(e) => setFilters((f) => ({ ...f, severity: e.target.value }))}
                  style={{ height: "2.25rem", fontSize: "0.85rem", cursor: "pointer" }}
                >
                  <option value="">All</option>
                  <option value="info">Info</option>
                  <option value="warn">Warn</option>
                  <option value="critical">Critical</option>
                </select>
              </label>
              <select
                aria-label="Events per page"
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
                style={{ height: "2.25rem", fontSize: "0.85rem", cursor: "pointer" }}
              >
                {AUDIT_PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size} per page
                  </option>
                ))}
              </select>
              {hasActiveFilters ? (
                <Button size="sm" tone="tertiary" onClick={clearFilters}>
                  Clear
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      }
      table={
        <AuditTable
          items={items}
          loading={loading}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
          onLoadMore={nextCursor ? () => load(nextCursor) : undefined}
          hasActiveFilters={hasActiveFilters}
        />
      }
      detail={selected ? <EventDetail event={selected} onClose={() => setSelected(null)} /> : null}
      fullPageScroll
    />
  );
}

function AuditTable({
  items,
  loading,
  selectedId,
  onSelect,
  onLoadMore,
  hasActiveFilters,
}: {
  items: AuditEvent[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (e: AuditEvent) => void;
  onLoadMore?: () => void;
  hasActiveFilters: boolean;
}): JSX.Element {
  if (loading && items.length === 0)
    return (
      <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
        <LoadingSpinner />
      </div>
    );
  if (items.length === 0)
    return (
      <div style={{ padding: "2rem 1.5rem" }}>
        <EmptyState
          title={hasActiveFilters ? "No matching audit events" : "No audit events"}
          description={
            hasActiveFilters
              ? "Try adjusting the action, entity, outcome, or severity filters."
              : "Audit events will appear here once the organization has recorded activity."
          }
        />
      </div>
    );
  return (
    <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem 1.5rem" }}>
      <table
        style={{
          display: "table",
          width: "100%",
          borderCollapse: "collapse",
          fontSize: "0.875rem",
        }}
      >
        <thead>
          <tr
            style={{
              textAlign: "left",
              color: "var(--color-on-surface-variant)",
              borderBottom:
                "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
              background: "var(--color-surface-low)",
            }}
          >
            <th style={{ ...thStyle, width: "18%" }}>Timestamp</th>
            <th style={{ ...thStyle, width: "18%" }}>Actor</th>
            <th style={{ ...thStyle, width: "25%" }}>Action</th>
            <th style={{ ...thStyle, width: "17%" }}>Entity</th>
            <th style={{ ...thStyle, width: "11%" }}>Outcome</th>
            <th style={{ ...thStyle, width: "11%" }}>Severity</th>
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
                borderBottom:
                  "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
                cursor: "pointer",
                background: e.id === selectedId ? "var(--color-primary-tint)" : undefined,
                transition: "background 0.15s ease",
              }}
              className="wx-data-row-interactive"
            >
              <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                {formatDateTime(e.createdAt)}
              </td>
              <td style={tdStyle}>
                <ActorCell event={e} />
              </td>
              <td style={tdStyle}>
                <div style={{ fontWeight: 600, color: "var(--color-on-surface)" }}>
                  {humanizeIdentifier(e.eventType)}
                </div>
                <div className="wx-data-md" style={mutedCodeStyle}>
                  {e.id}
                </div>
              </td>
              <td style={tdStyle}>
                <EntityCell event={e} />
              </td>
              <td style={tdStyle}>
                <StatusPill label={label(e.outcome)} tone={OUTCOME_TONE[e.outcome] ?? "neutral"} />
              </td>
              <td style={tdStyle}>
                <StatusPill
                  label={label(e.severity)}
                  tone={SEVERITY_TONE[e.severity] ?? "neutral"}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <CursorPagination
        loadedCount={items.length}
        hasNextPage={Boolean(onLoadMore)}
        onNextPage={onLoadMore}
        loading={loading}
        noun="audit events"
      />
    </div>
  );
}

function ActorCell({ event }: { event: AuditEvent }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
      <span style={{ fontWeight: 600, color: "var(--color-on-surface)" }}>
        {event.actorUserId ? (
          <span className="wx-data-md">{event.actorUserId}</span>
        ) : (
          label(event.actorKind)
        )}
      </span>
      <span style={{ fontSize: "0.75rem", color: "var(--color-on-surface-variant)" }}>
        {event.actorRole ? label(event.actorRole) : label(event.actorKind)}
      </span>
    </div>
  );
}

function EntityCell({ event }: { event: AuditEvent }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
      <span style={{ fontWeight: 500, color: "var(--color-on-surface)" }}>
        {humanizeIdentifier(event.resourceKind)}
      </span>
      {event.resourceId ? (
        <span className="wx-data-md" style={mutedCodeStyle}>
          {event.resourceId}
        </span>
      ) : (
        <span style={{ fontSize: "0.75rem", color: "var(--color-on-surface-variant)" }}>
          No resource id
        </span>
      )}
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
      {row("Action", humanizeIdentifier(event.eventType))}
      {row(
        "Entity",
        <>
          {humanizeIdentifier(event.resourceKind)}
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

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const thStyle = {
  padding: "0.625rem 1rem",
  fontWeight: 600,
  fontSize: "0.75rem",
};

const tdStyle = {
  padding: "0.75rem 1rem",
  verticalAlign: "middle" as const,
};

const errorBannerStyle = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  color: "var(--color-error)",
  fontSize: "0.85rem",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};

const dismissButtonStyle = {
  border: "none",
  background: "none",
  color: "inherit",
  cursor: "pointer",
  fontWeight: 600,
};

const mutedCodeStyle = {
  display: "block",
  marginTop: "0.2rem",
  maxWidth: "18rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
};
