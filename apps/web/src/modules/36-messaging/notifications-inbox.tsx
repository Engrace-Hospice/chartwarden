import {
  cardSurface,
  EmptyState,
  ghostBorder,
  Glyph,
  type GlyphName,
  LoadingSpinner,
  StatusPill,
  type StatusTone,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/36-messaging — Notifications & Tasks / Worklist (M36, Track A).
// Spec: docs/design/screens/core/WARDENX_UI_NOTIFICATIONS_TASKS.md — "Use Work Queue."
// Matched to the P0 Pencil frame (wardenx-P0-foundation.pen `mK4co`): a Fraunces title, a pill
// tab-strip (Notifications / Tasks / Mentions) with an inline stats summary, and a §6.2 No-Line card
// listing rows (severity glyph + summary + source chip + status pill + relative time). The REAL data
// is the caller's alert inbox (GET /api/v1/alerts/inbox) → the Notifications tab. Tasks & Mentions are
// honest placeholders until the Tasks/worklist module lands — present, never fabricated.
import { useEffect, useState } from "react";
import type { JSX } from "react";

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

// §6.6 — alert severity → tone. An *alert* severity of "critical" is operational urgency (→ error),
// NOT the reserved gold `critical` tone (safety / controlled-substance only), same call as M04 audit.
const SEVERITY_TONE: Record<string, StatusTone> = {
  critical: "error",
  high: "error",
  warn: "warning",
  info: "neutral",
};
const SEVERITY_GLYPH: Record<string, GlyphName> = {
  critical: "alert",
  high: "alert",
  warn: "alert",
  info: "info",
};
const cap = (s: string): string => s.replace(/\b\w/g, (c) => c.toUpperCase());

// Compact relative time ("2m" / "1h" / "3d") from an ISO timestamp.
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

  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error: err } = await client.GET("/api/v1/alerts/inbox");
      if (!active) return;
      if (err) return setError("Could not load notifications.");
      setAlerts((data?.alerts ?? []) as AlertItem[]);
    })();
    return () => {
      active = false;
    };
  }, [client]);

  const total = alerts?.length ?? 0;
  const urgent = (alerts ?? []).filter((a) => a.severity === "critical" || a.severity === "high")
    .length;
  const failed = (alerts ?? []).filter((a) => a.deliveryStatus === "failed").length;

  return (
    <div style={{ height: "100%", overflow: "auto", background: t.background }}>
      <div style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
        <h1
          style={{
            margin: 0,
            fontFamily: t.fontDisplay,
            fontWeight: 500,
            fontSize: "1.5rem",
            color: t.onSurface,
          }}
        >
          Notifications &amp; Tasks
        </h1>

        <div style={tabsRow}>
          <Pill
            label="Notifications"
            count={total}
            active={tab === "notifications"}
            onClick={() => setTab("notifications")}
          />
          <Pill
            label="Tasks"
            active={tab === "tasks"}
            onClick={() => setTab("tasks")}
            title="Task worklist arrives with the Tasks module"
          />
          <Pill
            label="Mentions"
            active={tab === "mentions"}
            onClick={() => setTab("mentions")}
            title="@-mentions arrive with the Tasks / messaging worklist"
          />
          <span style={{ flex: 1 }} />
          {tab === "notifications" && alerts ? (
            <div style={statStrip}>
              <Stat value={total} label="Unread" tone={t.onSurface} />
              <Stat value={urgent} label="Urgent" tone={t.error} />
              {failed > 0 ? <Stat value={failed} label="Failed" tone={t.warning} /> : null}
            </div>
          ) : null}
        </div>

        {tab !== "notifications" ? (
          <EmptyState
            title={tab === "tasks" ? "Tasks" : "Mentions"}
            description={
              tab === "tasks"
                ? "Your task worklist (sign / co-sign / resolve, with due dates and assignees) arrives with the Tasks module."
                : "@-mentions across notes and messages arrive with the messaging worklist."
            }
          />
        ) : error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : alerts === null ? (
          <LoadingSpinner />
        ) : alerts.length === 0 ? (
          <EmptyState title="All clear" description="You have no notifications." />
        ) : (
          <div style={{ ...cardSurface, padding: "0 1.25rem" }}>
            {alerts.map((a, i) => (
              <div key={a.alertId} style={{ ...rowStyle, borderTop: i === 0 ? "none" : ghostBorder }}>
                <span
                  style={{
                    color: a.severity === "info" ? t.muted : t.error,
                    display: "inline-flex",
                    flexShrink: 0,
                  }}
                >
                  <Glyph name={SEVERITY_GLYPH[a.severity] ?? "info"} size={18} />
                </span>
                <span style={{ flex: 1, minWidth: 0, color: t.onSurface }}>{a.summary}</span>
                <span style={sourceChip}>{cap(a.category.replace(/_/g, " "))}</span>
                <StatusPill label={cap(a.severity)} tone={SEVERITY_TONE[a.severity] ?? "neutral"} />
                <span style={{ color: t.muted, fontSize: "0.78rem", width: "2.5rem", textAlign: "right" }}>
                  {relTime(a.createdAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Pill({
  label,
  count,
  active,
  onClick,
  title,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
  title?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.4rem",
        padding: "0.4rem 0.9rem",
        border: "none",
        borderRadius: "9999px",
        cursor: "pointer",
        fontSize: "0.8125rem",
        fontWeight: 600,
        background: active ? t.primaryTint : "transparent",
        color: active ? t.primary : t.onSurfaceVariant,
      }}
    >
      {label}
      {count != null ? (
        <span style={{ color: active ? t.primary : t.muted, fontWeight: 600 }}>{count}</span>
      ) : null}
    </button>
  );
}

function Stat({ value, label, tone }: { value: number; label: string; tone: string }): JSX.Element {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: "0.3rem" }}>
      <span className="tabular-nums" style={{ fontWeight: 700, color: tone }}>
        {value}
      </span>
      <span style={{ color: t.onSurfaceVariant, fontSize: "0.8125rem" }}>{label}</span>
    </span>
  );
}

const tabsRow = {
  display: "flex",
  alignItems: "center",
  gap: "0.4rem",
  flexWrap: "wrap" as const,
} as const;
const statStrip = { display: "flex", alignItems: "center", gap: "1.25rem" } as const;
const rowStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.875rem",
  padding: "0.875rem 0",
} as const;
const sourceChip = {
  flexShrink: 0,
  fontSize: "0.72rem",
  fontWeight: 600,
  color: t.onSurfaceVariant,
  background: t.surfaceContainer,
  borderRadius: "9999px",
  padding: "0.1rem 0.55rem",
} as const;
