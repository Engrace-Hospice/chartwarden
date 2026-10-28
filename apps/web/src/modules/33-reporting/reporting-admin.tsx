import {
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/33-reporting — M33 Reporting & Analytics, the platform/compliance ADMIN CONSOLE (R2).
// Spec §5.1.7 (`/reports/admin`) — the materialized-view registry + replica-lag posture (D14). Backed by
// GET /api/v1/reporting/admin/mvs (refresh telemetry + status) + GET /api/v1/reporting/admin/lag (the
// D14 breaker + freshness gauge), via the generated typed client; reads run under withReportSession.
// "Refresh now" / "Suspend" are command (POST) routes (202 enqueue, rate-limited 1/min per mvKey) wired
// here over the typed client. Platform-admin gated (report.admin.mv_list / lag_read).
// This is a service-state board (not metric-led) → StatusBoardLayout: the replica-lag gauge is the
// page freshness anchor; each MV row carries its own last-refresh chip. Lantern: No-Line, CSS-var tokens.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import {
  asOfLabel,
  freshnessLabel,
  freshnessTone,
  lagLabel,
  lagTone,
  mvTone,
  statusLabel,
} from "./reporting-status";

interface MvMetadataView {
  id: string;
  mvKey: string;
  schemaName: string;
  refreshStrategy: "nightly" | "incremental" | "on_demand";
  status: "registered" | "active" | "suspended" | "retired";
  expectedFreshnessSeconds: number;
  debounceWindowSeconds: number;
  lastRefreshedAt: string | null;
  lastRefreshDurationMs: number | null;
  refreshFailureCount: number;
}

interface MvPage {
  items: MvMetadataView[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface ReplicaLag {
  lagSeconds: number;
  breakerOpen: boolean;
  thresholdSeconds: number;
  dataFreshnessSeconds: number;
  sampledAt: string;
}

export function ReportingAdmin(): JSX.Element {
  const client = useApiClient();
  const [mvs, setMvs] = useState<MvMetadataView[]>([]);
  const [lag, setLag] = useState<ReplicaLag | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [mvRes, lagRes] = await Promise.all([
      client.GET("/api/v1/reporting/admin/mvs", { params: { query: { limit: 100 } } }),
      client.GET("/api/v1/reporting/admin/lag"),
    ]);
    if (mvRes.error) {
      setError("Materialized-view registry unavailable.");
      setLoading(false);
      return;
    }
    const page = mvRes.data as unknown as MvPage | undefined;
    setMvs((page?.items ?? []) as MvMetadataView[]);
    setLag(lagRes.error ? null : (lagRes.data as unknown as ReplicaLag));
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(
    async (mvKey: string) => {
      setBusyKey(mvKey);
      await client.POST("/api/v1/reporting/admin/mvs/{mvKey}/refresh", {
        params: { path: { mvKey } },
      });
      setBusyKey(null);
      void load();
    },
    [client, load],
  );

  const suspend = useCallback(
    async (mvKey: string) => {
      setBusyKey(mvKey);
      await client.POST("/api/v1/reporting/admin/mvs/{mvKey}/suspend", {
        params: { path: { mvKey } },
      });
      setBusyKey(null);
      void load();
    },
    [client, load],
  );

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Reporting Admin">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Monitor materialized-view freshness, replica lag, refresh failures, and administrative
            controls.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          <LagGauge lag={lag} />
        </div>
      }
      table={
        <div style={tableShellStyle}>
          <MvCatalog
            mvs={mvs}
            busyKey={busyKey}
            onRefresh={(k) => void refresh(k)}
            onSuspend={(k) => void suspend(k)}
          />
        </div>
      }
      fullPageScroll
    />
  );
}

const filterShellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};

const tableShellStyle: CSSProperties = {
  width: "100%",
  overflowX: "auto",
  padding: "0 1.5rem 1.5rem",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.85rem",
};

const thStyle: CSSProperties = {
  padding: "0.5rem 0.75rem",
  textAlign: "left",
  fontSize: "0.7rem",
  fontWeight: 600,
  color: "var(--color-on-surface-variant)",
};

const tdStyle: CSSProperties = {
  padding: "0.55rem 0.75rem",
  verticalAlign: "top",
  color: "var(--color-on-surface)",
};

const rowStyle: CSSProperties = {
  borderTop: "1px solid var(--color-surface-container)",
};

const tableHeadRowStyle: CSSProperties = {
  background: "var(--color-surface-low)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
};

const actionButtonStyle: CSSProperties = {
  minHeight: "2.25rem",
  padding: "0.45rem 0.75rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  cursor: "pointer",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.75rem",
  fontWeight: 600,
};

const disabledActionButtonStyle: CSSProperties = {
  ...actionButtonStyle,
  cursor: "not-allowed",
  opacity: 0.5,
};

const cardShellStyle: CSSProperties = {
  background: "var(--color-surface-lowest)",
  borderRadius: "var(--radius-lg)",
  boxShadow: "var(--shadow-soft)",
};

const cardInsetStyle: CSSProperties = {
  padding: "1rem 1.25rem",
};

const emptyShellStyle: CSSProperties = {
  padding: "2rem 1.5rem",
};

const gaugeShellStyle: CSSProperties = {
  ...cardShellStyle,
  ...cardInsetStyle,
  display: "flex",
  alignItems: "center",
  gap: "2rem",
  flexWrap: "wrap",
};

const gaugeLabelStyle: CSSProperties = {
  fontSize: "0.6875rem",
  fontWeight: 600,
  color: "var(--color-on-surface-variant)",
};

const gaugeMetaStyle: CSSProperties = {
  fontSize: "0.7rem",
  color: "var(--color-on-surface-variant)",
};

const gaugeValueStyle: CSSProperties = {
  fontSize: "1.25rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
};

// ── replica-lag gauge (the page freshness anchor; D14 breaker) ────────────────────────────────────────
function LagGauge({ lag }: { lag: ReplicaLag | null }): JSX.Element {
  return (
    <section style={gaugeShellStyle}>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <span style={gaugeLabelStyle}>Read-replica posture</span>
        {lag ? (
          <StatusPill
            label={lagLabel(lag.lagSeconds, lag.breakerOpen)}
            tone={lagTone(lag.lagSeconds, lag.breakerOpen)}
          />
        ) : (
          <span style={{ fontSize: "0.85rem", color: "var(--color-on-surface-variant)" }}>
            Unavailable
          </span>
        )}
      </div>
      {lag ? (
        <>
          <Gauge label="Lag" value={`${Math.round(lag.lagSeconds)}s`} />
          <Gauge label="Threshold" value={`${Math.round(lag.thresholdSeconds)}s`} />
          <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            <span style={gaugeMetaStyle}>Breaker</span>
            <span
              style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.9rem" }}
            >
              <Glyph
                name={lag.breakerOpen ? "alert" : "check-circle"}
                size={16}
                label="breaker state"
              />
              {lag.breakerOpen ? "Open" : "Closed"}
            </span>
          </div>
          <span
            className="tabular-nums"
            style={{
              marginLeft: "auto",
              fontSize: "0.75rem",
              color: "var(--color-on-surface-variant)",
            }}
          >
            {asOfLabel(lag.sampledAt)}
          </span>
        </>
      ) : null}
    </section>
  );
}

function Gauge({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <span style={gaugeMetaStyle}>{label}</span>
      <span className="tabular-nums" style={gaugeValueStyle}>
        {value}
      </span>
    </div>
  );
}

// ── materialized-view registry table (each row a freshness/status chip) ───────────────────────────────
function MvCatalog({
  mvs,
  busyKey,
  onRefresh,
  onSuspend,
}: {
  mvs: MvMetadataView[];
  busyKey: string | null;
  onRefresh: (mvKey: string) => void;
  onSuspend: (mvKey: string) => void;
}): JSX.Element {
  if (mvs.length === 0)
    return (
      <div style={emptyShellStyle}>
        <EmptyState title="No materialized views" description="No MVs are registered." />
      </div>
    );
  return (
    <div style={cardShellStyle}>
      <table style={tableStyle}>
        <thead>
          <tr style={tableHeadRowStyle}>
            <th style={thStyle}>View</th>
            <th style={thStyle}>Strategy</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>Freshness</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Failures</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Refresh ms</th>
            <th style={thStyle}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {mvs.map((mv) => {
            const failedState = mv.refreshFailureCount > 0 ? "failed" : undefined;
            const busy = busyKey === mv.mvKey;
            return (
              <tr key={mv.id} style={rowStyle}>
                <td className="wx-data-md" style={tdStyle}>
                  {mv.mvKey}
                </td>
                <td style={tdStyle}>{statusLabel(mv.refreshStrategy)}</td>
                <td style={tdStyle}>
                  <StatusPill
                    label={statusLabel(mv.status)}
                    tone={mvTone(mv.status, mv.refreshFailureCount)}
                  />
                </td>
                <td style={tdStyle}>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
                    <StatusPill
                      label={freshnessLabel(mv.lastRefreshedAt, failedState)}
                      tone={freshnessTone(mv.lastRefreshedAt, failedState)}
                    />
                    <span
                      className="tabular-nums"
                      style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}
                    >
                      {asOfLabel(mv.lastRefreshedAt)}
                    </span>
                  </div>
                </td>
                <td className="tabular-nums" style={{ ...tdStyle, textAlign: "right" }}>
                  {mv.refreshFailureCount}
                </td>
                <td className="tabular-nums" style={{ ...tdStyle, textAlign: "right" }}>
                  {mv.lastRefreshDurationMs ?? "—"}
                </td>
                <td style={tdStyle}>
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => onRefresh(mv.mvKey)}
                      disabled={busy}
                      style={busy ? disabledActionButtonStyle : actionButtonStyle}
                    >
                      {busy ? "…" : "Refresh"}
                    </button>
                    <button
                      type="button"
                      onClick={() => onSuspend(mv.mvKey)}
                      disabled={busy || mv.status === "suspended"}
                      style={
                        busy || mv.status === "suspended"
                          ? disabledActionButtonStyle
                          : actionButtonStyle
                      }
                    >
                      Suspend
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
