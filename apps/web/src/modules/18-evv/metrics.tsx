import {
  Button,
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/18-evv — EVV Dashboard + Metrics (M18 §5.1 `/app/evv/dashboard` + `/app/evv/metrics`,
// Track B / ADR-0030). Spec: docs/design/screens — "Use Dashboard". Org-wide EVV health over a trailing-30-day
// window: compliant-event rate, late-checkout rate, geofence-deviation rate, GPS-spoof rate, aggregator
// acceptance rate (the §4.3 EvvMetricsProvider seam computes them SERVER-side; ADR-0030 — no frontend authz).
// The request still sends a 30-day window, but the currently measured backend rows are all-time.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";

interface EvvMetrics {
  complianceRate: number;
  lateCheckoutRate: number;
  geofenceDeviationRate: number;
  gpsSpoofingDetectedRate: number;
  aggregatorSubmissionSuccessRate: number;
}

interface MetricRow {
  id: string;
  label: string;
  value: string;
  detail: string;
  tone: "success" | "warning" | "error" | "neutral";
  measured: boolean;
}

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

function EvvMetricsDashboard({ title }: { title: string }): JSX.Element {
  const client = useApiClient();
  const [metrics, setMetrics] = useState<EvvMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const window = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    return { from: from.toISOString(), to: to.toISOString() };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/evv/metrics", {
      params: { query: { from: window.from, to: window.to } },
    });
    if (err) {
      setError("Could not load EVV metrics.");
      setLoading(false);
      return;
    }
    setMetrics((data ?? null) as EvvMetrics | null);
    setLoading(false);
  }, [client, window]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo<MetricRow[]>(() => {
    if (!metrics) return [];
    return [
      {
        id: "compliance",
        label: "Compliant rate",
        value: "—",
        detail: "Backend does not expose a real numerator yet",
        tone: "neutral",
        measured: false,
      },
      {
        id: "late_checkout",
        label: "Late-checkout rate",
        value: "—",
        detail: "Backend does not expose a real numerator yet",
        tone: "neutral",
        measured: false,
      },
      {
        id: "geofence",
        label: "Geofence-deviation rate",
        value: pct(metrics.geofenceDeviationRate),
        detail: "All-time measured rows",
        tone: metrics.geofenceDeviationRate > 0.05 ? "warning" : "success",
        measured: true,
      },
      {
        id: "gps_spoof",
        label: "GPS-spoof rate",
        value: pct(metrics.gpsSpoofingDetectedRate),
        detail: "All-time measured rows",
        tone: metrics.gpsSpoofingDetectedRate > 0 ? "error" : "success",
        measured: true,
      },
      {
        id: "aggregator",
        label: "Aggregator acceptance",
        value: pct(metrics.aggregatorSubmissionSuccessRate),
        detail: "All-time measured rows",
        tone: metrics.aggregatorSubmissionSuccessRate >= 0.95 ? "success" : "warning",
        measured: true,
      },
    ];
  }, [metrics]);

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title={title}
          actions={
            <Button type="button" tone="secondary" onClick={() => void load()} loading={loading}>
              Refresh
            </Button>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review server-provided EVV health indicators without exposing visit coordinates.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Geofence deviation"
            value={loading || error || !metrics ? "—" : pct(metrics.geofenceDeviationRate)}
            detail="All-time measured"
            tone={metrics && metrics.geofenceDeviationRate > 0.05 ? "warning" : "success"}
            accentColor={
              metrics && metrics.geofenceDeviationRate > 0.05
                ? "var(--color-warning)"
                : "var(--color-success)"
            }
          />
          <KpiCard
            label="GPS spoof"
            value={loading || error || !metrics ? "—" : pct(metrics.gpsSpoofingDetectedRate)}
            detail="All-time measured"
            tone={metrics && metrics.gpsSpoofingDetectedRate > 0 ? "danger" : "success"}
            accentColor={
              metrics && metrics.gpsSpoofingDetectedRate > 0
                ? "var(--color-error)"
                : "var(--color-success)"
            }
          />
          <KpiCard
            label="Aggregator acceptance"
            value={
              loading || error || !metrics ? "—" : pct(metrics.aggregatorSubmissionSuccessRate)
            }
            detail="All-time measured"
            tone={
              metrics && metrics.aggregatorSubmissionSuccessRate >= 0.95 ? "success" : "warning"
            }
            accentColor={
              metrics && metrics.aggregatorSubmissionSuccessRate >= 0.95
                ? "var(--color-success)"
                : "var(--color-warning)"
            }
          />
        </KpiStrip>
      }
      filters={
        <div style={filterShellStyle}>
          {error ? (
            <div role="alert" style={errorBannerStyle}>
              <span>{error}</span>
              <button type="button" onClick={() => setError(null)} style={dismissButtonStyle}>
                x
              </button>
            </div>
          ) : null}
          <div role="note" style={noteStyle}>
            <StatusPill label="Partial" tone="warning" />
            <span>
              Compliance and late-checkout values stay blank until backend numerators are available.
              The UI does not print hardcoded perfect scores.
            </span>
          </div>
        </div>
      }
      table={
        error && !metrics ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={error} />
          </div>
        ) : loading || !metrics ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : (
          <div style={tableWrapStyle}>
            <table style={tableStyle}>
              <thead>
                <tr style={headerRowStyle}>
                  <th style={{ ...thStyle, width: "28%" }}>Metric</th>
                  <th style={{ ...thStyle, width: "16%" }}>Value</th>
                  <th style={{ ...thStyle, width: "16%" }}>Status</th>
                  <th style={{ ...thStyle, width: "20%" }}>Window</th>
                  <th style={{ ...thStyle, width: "20%", textAlign: "right" }}>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} style={rowStyle}>
                    <td style={tdStyle}>
                      <div style={primaryCellStyle}>
                        <span style={primaryTextStyle}>{row.label}</span>
                        <span style={secondaryTextStyle}>{row.detail}</span>
                      </div>
                    </td>
                    <td className="tabular-nums" style={{ ...tdStyle, fontWeight: 700 }}>
                      {row.value}
                    </td>
                    <td style={tdStyle}>
                      <StatusPill
                        label={row.measured ? statusLabel(row.tone) : "Not measured"}
                        tone={row.measured ? row.tone : "neutral"}
                      />
                    </td>
                    <td style={tdStyle}>{row.measured ? "All time" : "Pending backend support"}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      {row.measured ? "Server computed" : "Suppressed"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
      detail={
        <div style={detailStyle}>
          <section style={railSectionStyle}>
            <h3 style={railTitleStyle}>Measurement Notes</h3>
            <p style={railTextStyle}>
              The request sends a trailing-30-day window, but measured EVV rates currently come back
              from the service as all-time values.
            </p>
          </section>
          <section style={railSectionStyle}>
            <h3 style={railTitleStyle}>Privacy Boundary</h3>
            <p style={railTextStyle}>
              This dashboard summarizes EVV health only. Coordinate reads remain isolated behind the
              separate EVV coordinate permission.
            </p>
          </section>
        </div>
      }
      fullPageScroll
    />
  );
}

function statusLabel(tone: MetricRow["tone"]): string {
  if (tone === "success") return "Healthy";
  if (tone === "warning") return "Watch";
  if (tone === "error") return "Exception";
  return "Observed";
}

export function EvvDashboard(): JSX.Element {
  return <EvvMetricsDashboard title="EVV Dashboard" />;
}

export function EvvMetrics(): JSX.Element {
  return <EvvMetricsDashboard title="EVV Metrics" />;
}

const filterShellStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};
const noteStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.85rem",
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
const tableWrapStyle = {
  width: "100%",
  overflowX: "auto" as const,
  padding: "0 1.5rem 1.5rem 1.5rem",
};
const tableStyle = {
  display: "table",
  width: "100%",
  borderCollapse: "collapse" as const,
  fontSize: "0.875rem",
};
const headerRowStyle = {
  textAlign: "left" as const,
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};
const rowStyle = {
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
};
const thStyle = {
  padding: "0.625rem 1rem",
  fontWeight: 600,
  fontSize: "0.75rem",
};
const tdStyle = {
  padding: "0.75rem 1rem",
  verticalAlign: "middle" as const,
};
const primaryCellStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.25rem",
  minWidth: 0,
};
const primaryTextStyle = { fontWeight: 600, color: "var(--color-on-surface)" };
const secondaryTextStyle = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};
const detailStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
};
const railSectionStyle = {
  padding: "1rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-lowest)",
};
const railTitleStyle = {
  margin: "0 0 0.5rem",
  fontSize: "0.875rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
};
const railTextStyle = {
  margin: 0,
  color: "var(--color-on-surface-variant)",
  fontSize: "0.85rem",
  lineHeight: 1.45,
};
