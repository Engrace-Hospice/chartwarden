import { Glyph, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useNavigate } from "react-router-dom";

interface AlertItem {
  alertId: string;
  eventType: string;
  category: string;
  severity: string;
  summary: string;
  createdAt: string;
  deliveryStatus: "delivered" | "partial" | "failed" | "pending";
  readAt: string | null;
}

type AlertReadPost = (
  path: string,
  options: {
    params: {
      path: {
        id: string;
      };
    };
  },
) => Promise<{
  data?: unknown;
  error?: unknown;
  response?: Response;
}>;

async function postAlertRead(
  client: ReturnType<typeof useApiClient>,
  alertId: string,
): Promise<{ error?: unknown }> {
  const post = client.POST as unknown as AlertReadPost;

  return post("/api/v1/alerts/{id}/read", {
    params: {
      path: {
        id: alertId,
      },
    },
  });
}

function relativeTime(value: string): string {
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "";

  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));

  if (seconds < 60) return "Just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function categoryLabel(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function NotificationBell(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);

    const { data, error } = await client.GET("/api/v1/alerts/inbox");

    setLoading(false);

    if (error) {
      setLoadFailed(true);
      return;
    }

    setLoadFailed(false);
    setAlerts((data?.alerts ?? []) as AlertItem[]);
  }, [client]);

  useEffect(() => {
    void load();

    const interval = window.setInterval(() => {
      void load();
    }, 60_000);

    function handleFocus(): void {
      void load();
    }

    window.addEventListener("focus", handleFocus);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const unreadCount = useMemo(
    () => alerts.filter((alert) => alert.readAt === null).length,
    [alerts],
  );

  const recentAlerts = useMemo(() => alerts.slice(0, 5), [alerts]);

  async function markRead(alert: AlertItem): Promise<void> {
    if (alert.readAt !== null) return;

    // Optimistic UI: remove the badge immediately.
    const readAt = new Date().toISOString();

    setAlerts((current) =>
      current.map((item) =>
        item.alertId === alert.alertId ? { ...item, readAt } : item,
      ),
    );

    const { error } = await postAlertRead(client, alert.alertId);

    if (error) {
      // Restore canonical server state if the mutation failed.
      void load();
    }
  }

  function openAllNotifications(): void {
    setOpen(false);
    navigate("/notifications");
  }

  return (
    <div ref={rootRef} style={rootStyle}>
      <button
        type="button"
        className="wx-icon-btn"
        onClick={() => {
          setOpen((value) => !value);

          if (!open) {
            void load();
          }
        }}
        aria-label={
          unreadCount > 0
            ? `${unreadCount} unread notifications`
            : "Notifications"
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Notifications"
        style={triggerStyle}
      >
        <Glyph
          name="bell"
          size={20}
          strokeWidth={1.75}
          style={{
            color: "var(--color-on-surface-variant)",
          }}
        />

        {unreadCount > 0 ? (
          <span style={badgeStyle}>
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div role="dialog" aria-label="Notifications" style={popoverStyle}>
          <div style={headerStyle}>
            <div>
              <div style={titleStyle}>Notifications</div>

              <div style={subtitleStyle}>
                {unreadCount > 0
                  ? `${unreadCount} unread`
                  : "You're all caught up"}
              </div>
            </div>

            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close notifications"
              style={closeButtonStyle}
            >
              <Glyph name="close" size={16} />
            </button>
          </div>

          <div style={bodyStyle}>
            {loading && alerts.length === 0 ? (
              <div style={stateStyle}>Loading notifications…</div>
            ) : loadFailed && alerts.length === 0 ? (
              <div style={stateStyle}>Notifications could not be loaded.</div>
            ) : recentAlerts.length === 0 ? (
              <div style={emptyStyle}>
                <div style={emptyIconStyle}>
                  <Glyph name="bell" size={20} strokeWidth={1.75} />
                </div>

                <strong>No notifications</strong>

                <span style={emptyDescriptionStyle}>
                  New clinical and operational alerts will appear here.
                </span>
              </div>
            ) : (
              recentAlerts.map((alert) => {
                const unread = alert.readAt === null;

                return (
                  <button
                    key={alert.alertId}
                    type="button"
                    onClick={() => void markRead(alert)}
                    style={{
                      ...alertRowStyle,
                      ...(unread ? unreadRowStyle : {}),
                    }}
                  >
                    <span
                      style={{
                        ...severityMarkerStyle,
                        ...(alert.severity === "critical" ||
                        alert.severity === "warn"
                          ? severityMarkerWarningStyle
                          : {}),
                      }}
                    >
                      <Glyph
                        name={alert.severity === "info" ? "info" : "alert"}
                        size={16}
                      />
                    </span>

                    <span style={alertContentStyle}>
                      <span style={alertTitleLineStyle}>
                        <strong style={alertSummaryStyle}>
                          {alert.summary}
                        </strong>

                        {unread ? (
                          <span
                            aria-label="Unread"
                            title="Unread"
                            style={unreadDotStyle}
                          />
                        ) : null}
                      </span>

                      <span style={alertMetadataStyle}>
                        {categoryLabel(alert.category)}
                        <span aria-hidden> · </span>
                        {relativeTime(alert.createdAt)}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>

          <div style={footerStyle}>
            <button
              type="button"
              onClick={openAllNotifications}
              style={viewAllButtonStyle}
            >
              View all notifications
              <Glyph name="arrow-right" size={15} />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const rootStyle: CSSProperties = {
  position: "relative",
  display: "inline-flex",
  alignItems: "center",
  color: "var(--color-on-surface-variant)",
};

const triggerStyle: CSSProperties = {
  position: "relative",
  color: "var(--color-on-surface-variant)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

const badgeStyle: CSSProperties = {
  position: "absolute",
  top: "-0.3rem",
  right: "-0.35rem",
  minWidth: "1rem",
  height: "1rem",
  padding: "0 0.25rem",
  borderRadius: "9999px",
  background: "var(--color-error)",
  color: "white",
  border: "2px solid var(--color-surface-lowest)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: "0.58rem",
  lineHeight: 1,
  fontWeight: 700,
  fontVariantNumeric: "tabular-nums",
};

const popoverStyle: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 0.65rem)",
  right: 0,
  zIndex: 1000,
  width: "22rem",
  maxWidth: "calc(100vw - 2rem)",
  borderRadius: "var(--radius-lg)",
  background: "var(--color-surface-lowest)",
  border:
    "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)",
  boxShadow: "var(--shadow-elevated)",
  overflow: "hidden",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "1rem",
  borderBottom:
    "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)",
};

const titleStyle: CSSProperties = {
  color: "var(--color-on-surface)",
  fontSize: "0.95rem",
  fontWeight: 700,
};

const subtitleStyle: CSSProperties = {
  marginTop: "0.15rem",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.72rem",
};

const closeButtonStyle: CSSProperties = {
  width: "1.75rem",
  height: "1.75rem",
  border: 0,
  borderRadius: "var(--radius-md)",
  background: "transparent",
  color: "var(--color-on-surface-variant)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
};

const bodyStyle: CSSProperties = {
  maxHeight: "24rem",
  overflowY: "auto",
};

const stateStyle: CSSProperties = {
  padding: "1.5rem",
  textAlign: "center",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8rem",
};

const emptyStyle: CSSProperties = {
  padding: "2rem 1.25rem",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "0.4rem",
  textAlign: "center",
  color: "var(--color-on-surface)",
};

const emptyIconStyle: CSSProperties = {
  width: "2.25rem",
  height: "2.25rem",
  borderRadius: "9999px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface-variant)",
  marginBottom: "0.25rem",
};

const emptyDescriptionStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
  lineHeight: 1.45,
};

const alertRowStyle: CSSProperties = {
  width: "100%",
  border: 0,
  borderBottom:
    "1px solid color-mix(in srgb, var(--color-outline-variant) 25%, transparent)",
  background: "transparent",
  padding: "0.8rem 1rem",
  display: "flex",
  alignItems: "flex-start",
  gap: "0.7rem",
  textAlign: "left",
  cursor: "pointer",
  color: "inherit",
};

const unreadRowStyle: CSSProperties = {
  background: "color-mix(in srgb, var(--color-primary) 6%, transparent)",
};

const severityMarkerStyle: CSSProperties = {
  width: "1.8rem",
  height: "1.8rem",
  flexShrink: 0,
  borderRadius: "9999px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface-variant)",
};

const severityMarkerWarningStyle: CSSProperties = {
  background: "color-mix(in srgb, var(--color-error) 10%, transparent)",
  color: "var(--color-error)",
};

const alertContentStyle: CSSProperties = {
  minWidth: 0,
  flex: 1,
  display: "flex",
  flexDirection: "column",
  gap: "0.2rem",
};

const alertTitleLineStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.5rem",
};

const alertSummaryStyle: CSSProperties = {
  minWidth: 0,
  color: "var(--color-on-surface)",
  fontSize: "0.8rem",
  lineHeight: 1.35,
};

const unreadDotStyle: CSSProperties = {
  width: "0.45rem",
  height: "0.45rem",
  flexShrink: 0,
  borderRadius: "9999px",
  background: "var(--color-primary)",
};

const alertMetadataStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.68rem",
};

const footerStyle: CSSProperties = {
  padding: "0.65rem",
  background: "var(--color-surface-low)",
};

const viewAllButtonStyle: CSSProperties = {
  width: "100%",
  border: 0,
  borderRadius: "var(--radius-md)",
  background: "transparent",
  color: "var(--color-primary)",
  minHeight: "2.25rem",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.4rem",
  cursor: "pointer",
  fontWeight: 650,
  fontSize: "0.75rem",
};
