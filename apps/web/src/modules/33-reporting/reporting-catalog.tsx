import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/33-reporting — M33 Reporting & Analytics, the LANDING / CATALOG (R2).
// Spec §5.1.2 (`/reports`) — the reporting home: a system-health strip (replica-lag tier + MV-failure
// count) over the dashboard catalog. The spec names a `GET /landing` aggregate that is not yet
// implemented, so landing is composed client-side from GET /api/v1/reporting/dashboards (catalog) +
// GET /api/v1/reporting/admin/lag (the freshness anchor). Reads run under withReportSession server-side
// (the read replica, RLS-scoped). Catalog is metadata only — no PHI (D6).
// Lantern: No-Line cards, primary-tint hover, mono identifiers (wx-data-md), tabular-nums, CSS-var
// tokens only. Status/freshness pills resolve through the shared §6.6 tone map (reporting-status.ts).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { cap, lagLabel, lagTone, statusLabel } from "./reporting-status";

interface DashboardSummary {
  dashboardId: string;
  displayName: string;
  authorship: "system" | "tenant";
  tileCount: number;
  shareScope: "private" | "role" | "org";
  isOrgDefault: boolean;
}

interface DashboardPage {
  items: DashboardSummary[];
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

export function ReportingCatalog(): JSX.Element {
  const client = useApiClient();
  const [dashboards, setDashboards] = useState<DashboardSummary[]>([]);
  const [lag, setLag] = useState<ReplicaLag | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [dashRes, lagRes] = await Promise.all([
      client.GET("/api/v1/reporting/dashboards", { params: { query: { limit: 100 } } }),
      client.GET("/api/v1/reporting/admin/lag"),
    ]);
    if (dashRes.error) {
      setError("Reporting catalog unavailable.");
      setLoading(false);
      return;
    }
    const page = dashRes.data as unknown as DashboardPage | undefined;
    setDashboards((page?.items ?? []) as DashboardSummary[]);
    // The replica-lag posture is best-effort (gated on report.admin.lag_read); a 403 leaves the strip absent.
    setLag(lagRes.error ? null : (lagRes.data as unknown as ReplicaLag));
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  const featured = dashboards.filter((d) => d.isOrgDefault).slice(0, 6);
  const rest = dashboards.filter((d) => !d.isOrgDefault);

  return (
    <WorkQueueLayout
      header={<PageHeader title="Reports" breadcrumb="Reporting & Analytics" />}
      filters={<SystemHealthStrip lag={lag} dashboardCount={dashboards.length} />}
      table={
        dashboards.length === 0 ? (
          <EmptyState
            title="No dashboards"
            description="No reporting dashboards are available in your scope yet."
          />
        ) : (
          <div
            style={{
              padding: "0 1.5rem 1.5rem",
              display: "flex",
              flexDirection: "column",
              gap: "1.5rem",
            }}
          >
            {featured.length > 0 ? <CatalogSection title="Featured" dashboards={featured} /> : null}
            <CatalogSection
              title="All dashboards"
              dashboards={rest.length > 0 ? rest : dashboards}
            />
          </div>
        )
      }
    />
  );
}

// ── system-health strip (§5.1.2 — replica-lag tier is the page freshness anchor) ──────────────────────
function SystemHealthStrip({
  lag,
  dashboardCount,
}: { lag: ReplicaLag | null; dashboardCount: number }): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "1.5rem",
        padding: "0.75rem 1.5rem",
        background: "var(--color-surface-lowest)",
        borderRadius: "var(--radius-lg, 0.75rem)",
        boxShadow: "var(--shadow-soft)",
        margin: "0 1.5rem 1rem",
      }}
    >
      <Metric label="Dashboards" value={dashboardCount} />
      {lag ? (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            <span style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>
              Replica freshness
            </span>
            <StatusPill
              label={lagLabel(lag.lagSeconds, lag.breakerOpen)}
              tone={lagTone(lag.lagSeconds, lag.breakerOpen)}
            />
          </div>
          <Metric label="Lag" value={`${Math.round(lag.lagSeconds)}s`} mono />
        </>
      ) : (
        <span style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
          Replica posture unavailable
        </span>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  mono,
}: { label: string; value: string | number; mono?: boolean }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <span style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>{label}</span>
      <span
        className={mono ? "wx-data-md" : "tabular-nums"}
        style={{ fontSize: "1.1rem", fontWeight: 600, color: "var(--color-on-surface)" }}
      >
        {value}
      </span>
    </div>
  );
}

// ── catalog section + cards (metadata only, no PHI) ──────────────────────────────────────────────────
function CatalogSection({
  title,
  dashboards,
}: { title: string; dashboards: DashboardSummary[] }): JSX.Element {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <h2
        style={{
          margin: 0,
          fontSize: "0.6875rem",
          fontWeight: 600,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--color-on-surface-variant)",
        }}
      >
        {title}
      </h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(18rem, 1fr))",
          gap: "1rem",
        }}
      >
        {dashboards.map((d) => (
          <CatalogCard key={d.dashboardId} dashboard={d} />
        ))}
      </div>
    </section>
  );
}

function CatalogCard({ dashboard }: { dashboard: DashboardSummary }): JSX.Element {
  const href = `/reports/dashboards/${dashboard.dashboardId}`;
  return (
    <a
      href={href}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        background: "var(--color-surface-lowest)",
        borderRadius: "var(--radius-xl, 1rem)",
        boxShadow: "var(--shadow-soft)",
        padding: "1rem 1.25rem",
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.5rem",
        }}
      >
        <span style={{ fontFamily: "var(--font-display)", fontSize: "1rem", fontWeight: 500 }}>
          {dashboard.displayName}
        </span>
        <StatusPill
          label={cap(dashboard.authorship)}
          tone={dashboard.authorship === "system" ? "neutral" : "progress"}
        />
      </div>
      <div
        style={{
          display: "flex",
          gap: "1rem",
          fontSize: "0.8rem",
          color: "var(--color-on-surface-variant)",
        }}
      >
        <span className="tabular-nums">{dashboard.tileCount} tiles</span>
        <span>{statusLabel(dashboard.shareScope)}</span>
        {dashboard.isOrgDefault ? <span>Org default</span> : null}
      </div>
    </a>
  );
}
