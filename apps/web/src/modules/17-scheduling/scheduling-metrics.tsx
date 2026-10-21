import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/17-scheduling — Scheduling Metrics (M17 §5.1 `/app/admin/scheduling-metrics`, Track B / ADR-0030).
// Spec: docs/design/screens — "Use Dashboard". Org-wide scheduling metrics: on-time rate, no-show rate, reschedule
// rate (the visit-metrics provider) over a trailing-30-day window. The route-efficiency drill-down is a
// per-clinician read surfaced from `?membership=`. The SERVER computes the aggregates (the §4.3
// VisitMetricsProvider seam); ADR-0030 — no frontend authz. Reads GET /api/v1/metrics/visits via the typed
// client. Leaves only (@chartwarden/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";

interface VisitMetrics {
  onTimeRate: number;
  noShowRate: number;
  rescheduleRate: number;
}

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

export function SchedulingMetrics(): JSX.Element {
  const client = useApiClient();
  const [metrics, setMetrics] = useState<VisitMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const window = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000); // trailing 30 days
    return { from: from.toISOString(), to: to.toISOString() };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/metrics/visits", {
      params: { query: { from: window.from, to: window.to } },
    });
    if (err) {
      setError("Could not load scheduling metrics.");
      setLoading(false);
      return;
    }
    setMetrics((data ?? null) as VisitMetrics | null);
    setLoading(false);
  }, [client, window]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Scheduling Metrics"
          breadcrumb="Admin / Scheduling"
          actions={
            <Button type="button" tone="secondary" onClick={() => void load()} loading={loading}>
              Refresh
            </Button>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review server-computed visit performance over the trailing 30-day window.
          </div>
        </PageHeader>
      }
      table={
        error ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={error} />
          </div>
        ) : loading || !metrics ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : (
          <div style={contentStyle}>
            <section style={sectionStyle}>
              <div style={sectionHeaderStyle}>
                <div>
                  <h2 style={sectionTitleStyle}>Visit Metrics</h2>
                  <div style={sectionSubtitleStyle}>
                    {formatDate(window.from)} to {formatDate(window.to)}
                  </div>
                </div>
                <StatusPill label="Server computed" tone="success" />
              </div>
              <div style={factsGridStyle}>
                <MetricFact label="On-time rate" value={pct(metrics.onTimeRate)} />
                <MetricFact label="No-show rate" value={pct(metrics.noShowRate)} />
                <MetricFact label="Reschedule rate" value={pct(metrics.rescheduleRate)} />
              </div>
            </section>
          </div>
        )
      }
      detail={
        <div style={detailStyle}>
          <section style={railSectionStyle}>
            <h3 style={railTitleStyle}>Window</h3>
            <p style={railTextStyle}>
              The endpoint receives the exact trailing-30-day `from` and `to` timestamps. The UI
              does not recompute visit rates locally.
            </p>
          </section>
        </div>
      }
      fullPageScroll
    />
  );
}

function MetricFact({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div style={factStyle}>
      <div style={factLabelStyle}>{label}</div>
      <div className="tabular-nums" style={factValueStyle}>
        {value}
      </div>
    </div>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(value),
  );
}

const contentStyle = {
  padding: "0 1.5rem 1.5rem",
  maxWidth: "64rem",
};

const sectionStyle = {
  padding: "1rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-lowest)",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)",
};

const sectionHeaderStyle = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1rem",
  marginBottom: "1rem",
};

const sectionTitleStyle = {
  margin: 0,
  fontSize: "1rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
};

const sectionSubtitleStyle = {
  marginTop: "0.2rem",
  fontSize: "0.8rem",
  color: "var(--color-on-surface-variant)",
};

const factsGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))",
  gap: "0.75rem",
};

const factStyle = {
  padding: "0.75rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
};

const factLabelStyle = {
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
};

const factValueStyle = {
  marginTop: "0.35rem",
  fontSize: "1.35rem",
  fontWeight: 700,
  color: "var(--color-on-surface)",
};

const detailStyle = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
} as const;

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
  fontSize: "0.8rem",
  color: "var(--color-on-surface-variant)",
};
