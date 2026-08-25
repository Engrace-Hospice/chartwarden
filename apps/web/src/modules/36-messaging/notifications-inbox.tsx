import {
  Button,
  EmptyState,
  Glyph,
  type GlyphName,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  type StatusTone,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/36-messaging — Notifications & Tasks / Worklist (M36, Track A).
// Spec: docs/design/screens/core/WARDENX_UI_NOTIFICATIONS_TASKS.md — "Use Work Queue."
// Matched to the P0 Pencil frame (wardenx-P0-foundation.pen `mK4co`): a Fraunces title, a pill
// tab-strip (Notifications / Tasks / Mentions) with an inline stats summary, and a §6.2 No-Line card
// listing rows (severity glyph + summary + source chip + status pill + relative time). The REAL data
// is the caller's alert inbox (GET /api/v1/alerts/inbox) → the Notifications tab. Tasks & Mentions are
// honest placeholders until the Tasks/worklist module lands — present, never fabricated.
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";

interface AlertItem {
  alertId: string;
  eventType: string;
  category: string;
  severity: string;
  summary: string;
  createdAt: string;
  deliveryStatus: "delivered" | "partial" | "failed" | "pending";
}

type Tab = "notifications" | "tasks" | "mentions";

const NOTIFICATION_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

// §6.6 — alert severity → tone. An *alert* severity of "critical" is operational urgency (→ error),
// NOT the reserved gold `critical` tone (safety / controlled-substance only), same call as M04 audit.
const SEVERITY_TONE: Record<string, StatusTone> = {
  critical: "error",
  high: "error",
  warn: "warning",
  info: "neutral",
};
const DELIVERY_TONE: Record<AlertItem["deliveryStatus"], StatusTone> = {
  delivered: "success",
  partial: "warning",
  failed: "error",
  pending: "progress",
};
const SEVERITY_GLYPH: Record<string, GlyphName> = {
  critical: "alert",
  high: "alert",
  warn: "alert",
  info: "info",
};
const cap = (s: string): string => s.replace(/\b\w/g, (c) => c.toUpperCase());

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function NotificationsInbox(): JSX.Element {
  const client = useApiClient();
  const [alerts, setAlerts] = useState<AlertItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("notifications");
  const [searchQuery, setSearchQuery] = useState("");
  const [severityFilter, setSeverityFilter] = useState<
    "all" | "critical" | "high" | "warn" | "info"
  >("all");
  const [deliveryFilter, setDeliveryFilter] = useState<"all" | AlertItem["deliveryStatus"]>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error: err } = await client.GET("/api/v1/alerts/inbox");
      if (!active) return;
      if (err) {
        setError("Could not load notifications.");
        setAlerts([]);
        return;
      }
      setAlerts((data?.alerts ?? []) as AlertItem[]);
    })();
    return () => {
      active = false;
    };
  }, [client]);

  const filteredAlerts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return (alerts ?? []).filter((alert) => {
      const matchesSearch =
        q.length === 0 ||
        alert.summary.toLowerCase().includes(q) ||
        alert.category.toLowerCase().includes(q) ||
        alert.eventType.toLowerCase().includes(q) ||
        alert.alertId.toLowerCase().includes(q);
      const matchesSeverity = severityFilter === "all" || alert.severity === severityFilter;
      const matchesDelivery = deliveryFilter === "all" || alert.deliveryStatus === deliveryFilter;
      return matchesSearch && matchesSeverity && matchesDelivery;
    });
  }, [alerts, deliveryFilter, searchQuery, severityFilter]);

  const total = alerts?.length ?? 0;
  const hasActiveFilters =
    searchQuery.trim() !== "" || severityFilter !== "all" || deliveryFilter !== "all";
  const pageCount = Math.max(1, Math.ceil(filteredAlerts.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedAlerts = filteredAlerts.slice((activePage - 1) * pageSize, activePage * pageSize);

  const clearFilters = (): void => {
    setSearchQuery("");
    setSeverityFilter("all");
    setDeliveryFilter("all");
    setPage(1);
  };

  const selectTab = (next: Tab): void => {
    setTab(next);
    setPage(1);
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Notifications & Tasks" breadcrumb="General / Notifications">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review alert delivery, operational notifications, and upcoming worklist scopes.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          {error ? (
            <div role="alert" style={errorBannerStyle}>
              <Glyph name="alert" size={16} />
              <span>{error}</span>
            </div>
          ) : null}
          <div style={toolbarStyle}>
            <div style={tabWrapStyle} role="tablist" aria-label="Notification scope">
              <TabButton
                label={`Notifications (${total})`}
                active={tab === "notifications"}
                onClick={() => selectTab("notifications")}
              />
              <TabButton
                label="Tasks"
                active={tab === "tasks"}
                onClick={() => selectTab("tasks")}
              />
              <TabButton
                label="Mentions"
                active={tab === "mentions"}
                onClick={() => selectTab("mentions")}
              />
            </div>

            {tab === "notifications" ? (
              <div style={controlGroupStyle}>
                <div style={searchBoxStyle}>
                  <Glyph name="eye" size={14} />
                  <input
                    type="search"
                    placeholder="Search summary, source, event..."
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setPage(1);
                    }}
                    aria-label="Search notifications"
                    style={searchInputStyle}
                  />
                </div>
                <select
                  value={severityFilter}
                  onChange={(e) => {
                    setSeverityFilter(e.target.value as typeof severityFilter);
                    setPage(1);
                  }}
                  aria-label="Filter notifications by severity"
                  style={selectStyle}
                >
                  <option value="all">Severity: All</option>
                  <option value="critical">Critical</option>
                  <option value="high">High</option>
                  <option value="warn">Warning</option>
                  <option value="info">Info</option>
                </select>
                <select
                  value={deliveryFilter}
                  onChange={(e) => {
                    setDeliveryFilter(e.target.value as typeof deliveryFilter);
                    setPage(1);
                  }}
                  aria-label="Filter notifications by delivery status"
                  style={selectStyle}
                >
                  <option value="all">Delivery: All</option>
                  <option value="delivered">Delivered</option>
                  <option value="partial">Partial</option>
                  <option value="failed">Failed</option>
                  <option value="pending">Pending</option>
                </select>
                {hasActiveFilters ? (
                  <Button size="sm" tone="tertiary" onClick={clearFilters}>
                    Clear
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      }
      table={
        tab !== "notifications" ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title={tab === "tasks" ? "Tasks" : "Mentions"}
              description={
                tab === "tasks"
                  ? "Your task worklist arrives with the Tasks module."
                  : "@-mentions arrive with the messaging worklist."
              }
            />
          </div>
        ) : alerts === null ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : filteredAlerts.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title={hasActiveFilters ? "No matching notifications" : "All clear"}
              description={
                hasActiveFilters
                  ? "Try adjusting the notification filters."
                  : "You have no notifications."
              }
              action={
                hasActiveFilters ? (
                  <Button tone="secondary" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div style={tableWrapStyle}>
            <table style={tableStyle}>
              <thead>
                <tr style={headRowStyle}>
                  <th style={{ ...thStyle, width: "44%" }}>Notification</th>
                  <th style={{ ...thStyle, width: "18%" }}>Source</th>
                  <th style={{ ...thStyle, width: "14%" }}>Severity</th>
                  <th style={{ ...thStyle, width: "14%" }}>Delivery</th>
                  <th style={{ ...thStyle, width: "10%", textAlign: "right" }}>Age</th>
                </tr>
              </thead>
              <tbody>
                {pagedAlerts.map((alert) => (
                  <tr key={alert.alertId} style={rowStyle}>
                    <td style={tdStyle}>
                      <NotificationCell alert={alert} />
                    </td>
                    <td style={tdStyle}>
                      <span style={sourceChipStyle}>{cap(alert.category.replace(/_/g, " "))}</span>
                    </td>
                    <td style={tdStyle}>
                      <StatusPill
                        label={cap(alert.severity)}
                        tone={SEVERITY_TONE[alert.severity] ?? "neutral"}
                      />
                    </td>
                    <td style={tdStyle}>
                      <StatusPill
                        label={cap(alert.deliveryStatus)}
                        tone={DELIVERY_TONE[alert.deliveryStatus]}
                      />
                    </td>
                    <td
                      style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                    >
                      {relTime(alert.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={filteredAlerts.length}
              onPageChange={setPage}
              onPageSizeChange={(nextPageSize) => {
                setPageSize(nextPageSize);
                setPage(1);
              }}
              pageSizeOptions={NOTIFICATION_PAGE_SIZES}
              noun="notifications"
            />
          </div>
        )
      }
      fullPageScroll
    />
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={tabButtonStyle(active)}
    >
      {label}
    </button>
  );
}

function NotificationCell({ alert }: { alert: AlertItem }): JSX.Element {
  return (
    <div style={notificationCellStyle}>
      <span
        style={{
          ...severityIconStyle,
          color:
            alert.severity === "info" ? "var(--color-on-surface-variant)" : "var(--color-error)",
        }}
      >
        <Glyph name={SEVERITY_GLYPH[alert.severity] ?? "info"} size={18} />
      </span>
      <div style={cellTextStyle}>
        <span style={primaryTextStyle}>{alert.summary}</span>
        <code className="wx-data-md" style={secondaryCodeStyle}>
          {alert.eventType}
        </code>
      </div>
    </div>
  );
}

const filterShellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};
const toolbarStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
};
const tabWrapStyle: CSSProperties = {
  display: "flex",
  gap: "0.25rem",
  background: "var(--color-surface-container)",
  padding: "0.2rem",
  borderRadius: "var(--radius-md)",
};
const tabButtonStyle = (active: boolean): CSSProperties => ({
  border: "none",
  background: active ? "var(--color-surface-lowest)" : "transparent",
  color: active ? "var(--color-primary)" : "var(--color-on-surface-variant)",
  boxShadow: active ? "var(--shadow-soft)" : "none",
  fontWeight: active ? 600 : 500,
  fontSize: "0.85rem",
  padding: "0.35rem 0.75rem",
  borderRadius: "var(--radius-md)",
  cursor: "pointer",
});
const controlGroupStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap",
};
const searchBoxStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.45rem",
  minWidth: "15rem",
  height: "2.25rem",
  padding: "0 0.65rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface-variant)",
};
const searchInputStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  border: "none",
  background: "transparent",
  outline: "none",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
};
const selectStyle: CSSProperties = {
  height: "2.25rem",
  fontSize: "0.85rem",
  cursor: "pointer",
};
const errorBannerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  color: "var(--color-error)",
  fontSize: "0.85rem",
};
const tableWrapStyle: CSSProperties = {
  width: "100%",
  overflowX: "auto",
  padding: "0 1.5rem 1.5rem",
};
const tableStyle: CSSProperties = {
  display: "table",
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.875rem",
};
const headRowStyle: CSSProperties = {
  textAlign: "left",
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};
const rowStyle: CSSProperties = {
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
};
const thStyle: CSSProperties = {
  padding: "0.625rem 1rem",
  fontWeight: 600,
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};
const tdStyle: CSSProperties = {
  padding: "0.75rem 1rem",
  verticalAlign: "middle",
};
const notificationCellStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
};
const severityIconStyle: CSSProperties = {
  display: "inline-flex",
  flexShrink: 0,
};
const cellTextStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.15rem",
  minWidth: 0,
};
const primaryTextStyle: CSSProperties = {
  fontWeight: 600,
  color: "var(--color-on-surface)",
};
const secondaryCodeStyle: CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
};
const sourceChipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  fontSize: "0.72rem",
  fontWeight: 600,
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container)",
  borderRadius: "9999px",
  padding: "0.1rem 0.55rem",
};
