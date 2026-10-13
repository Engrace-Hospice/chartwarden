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
  humanizeIdentifier,
} from "@wardenx/ui";
// apps/web/src/modules/36-messaging — Notifications & Tasks / Worklist (M36, Track A).
// Spec: docs/design/screens/core/WARDENX_UI_NOTIFICATIONS_TASKS.md — "Use Work Queue."
// Matched to the P0 Pencil frame (wardenx-P0-foundation.pen `mK4co`): a Fraunces title, a pill
// tab-strip (Notifications / Tasks / Mentions) with an inline stats summary, and a §6.2 No-Line card
// listing rows (severity glyph + summary + source chip + status pill + relative time). The REAL data
// is the caller's alert inbox (GET /api/v1/alerts/inbox) → the Notifications tab. Tasks & Mentions are
// honest placeholders until the Tasks/worklist module lands — present, never fabricated.
import { useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import {
  type AlertInboxItem,
  isInternalAlertDeepLink,
  useAlertInbox,
} from "../../shell/alert-inbox";
import "./notifications-inbox.css";

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
const DELIVERY_TONE: Record<AlertInboxItem["deliveryStatus"], StatusTone> = {
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
  const navigate = useNavigate();
  const { alerts, loadFailed, markRead, activateAlert } = useAlertInbox();
  const [tab, setTab] = useState<Tab>("notifications");
  const [searchQuery, setSearchQuery] = useState("");
  const [severityFilter, setSeverityFilter] = useState<
    "all" | "critical" | "high" | "warn" | "info"
  >("all");
  const [deliveryFilter, setDeliveryFilter] = useState<"all" | AlertInboxItem["deliveryStatus"]>(
    "all",
  );
  const [readFilter, setReadFilter] = useState<"all" | "unread" | "read">("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const filteredAlerts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const scoped = (alerts ?? []).filter(
      (alert) => tab !== "mentions" || alert.eventType === "m36.message.mentioned",
    );
    return scoped.filter((alert) => {
      const matchesSearch =
        q.length === 0 ||
        alert.summary.toLowerCase().includes(q) ||
        alert.category.toLowerCase().includes(q) ||
        humanizeIdentifier(alert.category).toLowerCase().includes(q) ||
        alert.eventType.toLowerCase().includes(q) ||
        humanizeIdentifier(alert.eventType).toLowerCase().includes(q) ||
        alert.alertId.toLowerCase().includes(q);
      const matchesSeverity = severityFilter === "all" || alert.severity === severityFilter;
      const matchesDelivery = deliveryFilter === "all" || alert.deliveryStatus === deliveryFilter;
      const matchesRead =
        readFilter === "all" ||
        (readFilter === "unread" && alert.readAt === null) ||
        (readFilter === "read" && alert.readAt !== null);
      return matchesSearch && matchesSeverity && matchesDelivery && matchesRead;
    });
  }, [alerts, deliveryFilter, readFilter, searchQuery, severityFilter, tab]);

  const total = alerts?.length ?? 0;
  const unreadTotal = alerts?.filter((alert) => alert.readAt === null).length ?? 0;
  const hasActiveFilters =
    searchQuery.trim() !== "" ||
    severityFilter !== "all" ||
    deliveryFilter !== "all" ||
    readFilter !== "all";
  const pageCount = Math.max(1, Math.ceil(filteredAlerts.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedAlerts = filteredAlerts.slice((activePage - 1) * pageSize, activePage * pageSize);

  const clearFilters = (): void => {
    setSearchQuery("");
    setSeverityFilter("all");
    setDeliveryFilter("all");
    setReadFilter("all");
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
          <div className="wx-notif-subtitle">
            Review alert delivery, operational notifications, and upcoming worklist scopes.
          </div>
        </PageHeader>
      }
      filters={
        <div className="wx-notif-filter-shell">
          {loadFailed ? (
            <div role="alert" className="wx-notif-error">
              <Glyph name="alert" size={16} />
              <span>Could not load notifications.</span>
            </div>
          ) : null}
          <div className="wx-notif-toolbar">
            <div
              className="wx-subtabs wx-subtabs-inline"
              role="tablist"
              aria-label="Notification scope"
            >
              <TabButton
                label={
                  unreadTotal > 0
                    ? `Notifications (${unreadTotal} unread)`
                    : `Notifications (${total})`
                }
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

            {tab !== "tasks" ? (
              <div className="wx-notif-controls">
                <label className="wx-search-field">
                  <Glyph name="search" size={16} />
                  <input
                    type="search"
                    placeholder="Search summary, source, event..."
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setPage(1);
                    }}
                    aria-label="Search notifications"
                  />
                </label>
                <label className="wx-filter-field">
                  <span>Severity</span>
                  <select
                    className="wx-select"
                    value={severityFilter}
                    onChange={(e) => {
                      setSeverityFilter(e.target.value as typeof severityFilter);
                      setPage(1);
                    }}
                    aria-label="Filter notifications by severity"
                  >
                    <option value="all">All</option>
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="warn">Warning</option>
                    <option value="info">Info</option>
                  </select>
                </label>
                <label className="wx-filter-field">
                  <span>Delivery</span>
                  <select
                    className="wx-select"
                    value={deliveryFilter}
                    onChange={(e) => {
                      setDeliveryFilter(e.target.value as typeof deliveryFilter);
                      setPage(1);
                    }}
                    aria-label="Filter notifications by delivery status"
                  >
                    <option value="all">All</option>
                    <option value="delivered">Delivered</option>
                    <option value="partial">Partial</option>
                    <option value="failed">Failed</option>
                    <option value="pending">Pending</option>
                  </select>
                </label>
                <label className="wx-filter-field">
                  <span>Status</span>
                  <select
                    className="wx-select"
                    value={readFilter}
                    onChange={(e) => {
                      setReadFilter(e.target.value as typeof readFilter);
                      setPage(1);
                    }}
                    aria-label="Filter notifications by read status"
                  >
                    <option value="all">All</option>
                    <option value="unread">Unread</option>
                    <option value="read">Read</option>
                  </select>
                </label>
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
        tab === "tasks" ? (
          <div className="wx-notif-state">
            <EmptyState
              title="Tasks"
              description="Your task worklist arrives with the Tasks module."
            />
          </div>
        ) : alerts === null && !loadFailed ? (
          <div className="wx-notif-state wx-notif-state-loading">
            <LoadingSpinner />
          </div>
        ) : alerts === null ? (
          <div className="wx-notif-state">
            <EmptyState
              title="Notifications unavailable"
              description="Notifications could not be loaded. Try opening the notification bell again."
            />
          </div>
        ) : filteredAlerts.length === 0 ? (
          <div className="wx-notif-state">
            <EmptyState
              title={
                hasActiveFilters
                  ? `No matching ${tab === "mentions" ? "mentions" : "notifications"}`
                  : tab === "mentions"
                    ? "No mentions"
                    : "All clear"
              }
              description={
                hasActiveFilters
                  ? "Try adjusting the notification filters."
                  : tab === "mentions"
                    ? "You have not been mentioned in a secure conversation."
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
          <div className="wx-notif-table-wrap">
            <table className="wx-notif-table">
              <thead>
                <tr className="wx-notif-head-row">
                  <th className="wx-notif-th wx-notif-th-notification">Notification</th>
                  <th className="wx-notif-th wx-notif-th-source">Source</th>
                  <th className="wx-notif-th wx-notif-th-severity">Severity</th>
                  <th className="wx-notif-th wx-notif-th-delivery">Delivery</th>
                  <th className="wx-notif-th wx-notif-th-age">Age</th>
                  <th className="wx-notif-th wx-notif-th-action">Action</th>
                </tr>
              </thead>
              <tbody>
                {pagedAlerts.map((alert) => {
                  const unread = alert.readAt === null;

                  return (
                    <tr
                      key={alert.alertId}
                      // Native tables cannot contain a link spanning cells; link semantics plus keyboard activation preserve a whole-row target.
                      role={isInternalAlertDeepLink(alert.deepLink) ? "link" : undefined}
                      tabIndex={isInternalAlertDeepLink(alert.deepLink) ? 0 : undefined}
                      onClick={
                        isInternalAlertDeepLink(alert.deepLink)
                          ? () => activateAlert(alert, navigate)
                          : undefined
                      }
                      onKeyDown={
                        isInternalAlertDeepLink(alert.deepLink)
                          ? (event) => {
                              if (
                                event.target === event.currentTarget &&
                                (event.key === "Enter" || event.key === " ")
                              ) {
                                event.preventDefault();
                                activateAlert(alert, navigate);
                              }
                            }
                          : undefined
                      }
                      className={`wx-notif-row${unread ? " is-unread" : ""}${
                        isInternalAlertDeepLink(alert.deepLink) ? " is-link" : ""
                      }`}
                    >
                      <td className="wx-notif-td">
                        <div className="wx-notif-with-state">
                          {unread ? (
                            <>
                              <span aria-hidden="true" className="wx-notif-unread-dot" />
                              <span className="wx-sr-only">Unread</span>
                            </>
                          ) : null}

                          <NotificationCell alert={alert} />
                        </div>
                      </td>
                      <td className="wx-notif-td">
                        <span className="wx-notif-source-chip">
                          {humanizeIdentifier(alert.category)}
                        </span>
                      </td>
                      <td className="wx-notif-td">
                        <StatusPill
                          label={humanizeIdentifier(alert.severity)}
                          tone={SEVERITY_TONE[alert.severity] ?? "neutral"}
                        />
                      </td>
                      <td className="wx-notif-td">
                        <StatusPill
                          label={humanizeIdentifier(alert.deliveryStatus)}
                          tone={DELIVERY_TONE[alert.deliveryStatus]}
                        />
                      </td>
                      <td className="wx-notif-td wx-notif-td-age">{relTime(alert.createdAt)}</td>
                      <td className="wx-notif-td wx-notif-td-action">
                        {unread ? (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              markRead(alert);
                            }}
                            className="wx-notif-mark-read"
                          >
                            Mark read
                          </button>
                        ) : (
                          <span className="wx-notif-read-label">
                            <Glyph name="check" size={13} />
                            Read
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
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
    <button type="button" role="tab" aria-selected={active} onClick={onClick}>
      {label}
    </button>
  );
}

function NotificationCell({ alert }: { alert: AlertInboxItem }): JSX.Element {
  return (
    <div className="wx-notif-cell">
      <span className={`wx-notif-severity-icon${alert.severity === "info" ? " is-info" : ""}`}>
        <Glyph name={SEVERITY_GLYPH[alert.severity] ?? "info"} size={18} />
      </span>
      <div className="wx-notif-cell-text">
        <span className="wx-notif-primary">{alert.summary}</span>
        <span className="wx-notif-secondary">{humanizeIdentifier(alert.eventType)}</span>
      </div>
    </div>
  );
}
