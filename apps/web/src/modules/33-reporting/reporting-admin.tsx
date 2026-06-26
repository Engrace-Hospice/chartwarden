import {
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusBoardLayout,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/33-reporting — M33 Reporting & Analytics, the platform/compliance ADMIN CONSOLE (R2).
// Spec §5.1.7 (`/reports/admin`) — the materialized-view registry + replica-lag posture (D14). Backed by
// GET /api/v1/reporting/admin/mvs (refresh telemetry + status) + GET /api/v1/reporting/admin/lag (the
// D14 breaker + freshness gauge), via the generated typed client; reads run under withReportSession.
// "Refresh now" / "Suspend" are command (POST) routes (202 enqueue, rate-limited 1/min per mvKey) wired
// here over the typed client. Platform-admin gated (report.admin.mv_list / lag_read).
// This is a service-state board (not metric-led) → StatusBoardLayout: the replica-lag gauge is the
// page freshness anchor; each MV row carries its own last-refresh chip. Lantern: No-Line, CSS-var tokens.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
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
      client.GET("/api/v1/reporting/admin/mvs", { params: { query: { limit: 100 } } as never }),
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
    <StatusBoardLayout
      header={<PageHeader title="Reporting Admin" breadcrumb="Platform · Materialized Views" />}
      services={
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <LagGauge lag={lag} />
          <MvCatalog
            mvs={mvs}
            busyKey={busyKey}
            onRefresh={(k) => void refresh(k)}
            onSuspend={(k) => void suspend(k)}
          />
        </div>
      }
    />
  );
}

// ── replica-lag gauge (the page freshness anchor; D14 breaker) ────────────────────────────────────────
function LagGauge({ lag }: { lag: ReplicaLag | null }): JSX.Element {
  return (
    <section
      style={{
        background: "var(--color-surface-lowest)",
        borderRadius: "var(--radius-xl, 1rem)",
        boxShadow: "var(--shadow-soft)",
        padding: "1rem 1.25rem",
        display: "flex",
        alignItems: "center",
        gap: "2rem",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <span style={{ fontSize: "0.6875rem", fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--color-on-surface-variant)" }}>
          Read-replica posture
        </span>
        {lag ? (
          <StatusPill label={lagLabel(lag.lagSeconds, lag.breakerOpen)} tone={lagTone(lag.lagSeconds, lag.breakerOpen)} />
        ) : (
          <span style={{ fontSize: "0.85rem", color: "var(--color-on-surface-variant)" }}>Unavailable</span>
        )}
      </div>
      {lag ? (
        <>
          <Gauge label="Lag" value={`${Math.round(lag.lagSeconds)}s`} />
          <Gauge label="Threshold" value={`${Math.round(lag.thresholdSeconds)}s`} />
          <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            <span style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>Breaker</span>
            <span style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.9rem" }}>
              <Glyph name={lag.breakerOpen ? "alert" : "check-circle"} size={16} label="breaker state" />
              {lag.breakerOpen ? "Open" : "Closed"}
            </span>
          </div>
          <span className="tabular-nums" style={{ marginLeft: "auto", fontSize: "0.75rem", color: "var(--color-on-surface-variant)" }}>
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
      <span style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>{label}</span>
      <span className="tabular-nums" style={{ fontSize: "1.25rem", fontWeight: 600, color: "var(--color-on-surface)" }}>
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
    return <EmptyState title="No materialized views" description="No MVs are registered." />;
  return (
    <section
      style={{
        background: "var(--color-surface-lowest)",
        borderRadius: "var(--radius-xl, 1rem)",
        boxShadow: "var(--shadow-soft)",
        padding: "1rem 1.25rem",
      }}
    >
      <table>
        <thead>
          <tr>
            <th>View</th>
            <th>Strategy</th>
            <th>Status</th>
            <th>Freshness</th>
            <th>Failures</th>
            <th>Refresh ms</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {mvs.map((mv) => {
            const failedState = mv.refreshFailureCount > 0 ? "failed" : undefined;
            const busy = busyKey === mv.mvKey;
            return (
              <tr key={mv.id}>
                <td className="wx-data-md">{mv.mvKey}</td>
                <td>{statusLabel(mv.refreshStrategy)}</td>
                <td>
                  <StatusPill
                    label={statusLabel(mv.status)}
                    tone={mvTone(mv.status, mv.refreshFailureCount)}
                  />
                </td>
                <td>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
                    <StatusPill
                      label={freshnessLabel(mv.lastRefreshedAt, failedState)}
                      tone={freshnessTone(mv.lastRefreshedAt, failedState)}
                    />
                    <span className="tabular-nums" style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>
                      {asOfLabel(mv.lastRefreshedAt)}
                    </span>
                  </div>
                </td>
                <td className="tabular-nums">{mv.refreshFailureCount}</td>
                <td className="tabular-nums">{mv.lastRefreshDurationMs ?? "—"}</td>
                <td>
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <button type="button" onClick={() => onRefresh(mv.mvKey)} disabled={busy} style={{ fontSize: "0.75rem" }}>
                      {busy ? "…" : "Refresh"}
                    </button>
                    <button
                      type="button"
                      onClick={() => onSuspend(mv.mvKey)}
                      disabled={busy || mv.status === "suspended"}
                      style={{ fontSize: "0.75rem" }}
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
    </section>
  );
}
