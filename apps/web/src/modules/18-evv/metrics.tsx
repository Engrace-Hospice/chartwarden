import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/18-evv — EVV Dashboard + Metrics (M18 §5.1 `/app/evv/dashboard` + `/app/evv/metrics`,
// Track B / ADR-0030). Spec: docs/design/screens — "Use Dashboard". Org-wide EVV health over a trailing-30-day
// window: compliant-event rate, late-checkout rate, geofence-deviation rate, GPS-spoof rate, aggregator
// acceptance rate (the §4.3 EvvMetricsProvider seam computes them SERVER-side; ADR-0030 — no frontend authz).
// The 7/30/90-day window selector + trend charts fill in as the metrics surface hardens. Reads
// GET /api/v1/evv/metrics via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";

interface EvvMetrics {
  complianceRate: number;
  lateCheckoutRate: number;
  geofenceDeviationRate: number;
  gpsSpoofingDetectedRate: number;
  aggregatorSubmissionSuccessRate: number;
}

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

function EvvMetricsDashboard({ title }: { title: string }): JSX.Element {
  const client = useApiClient();
  const [metrics, setMetrics] = useState<EvvMetrics | null>(null);
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

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title={title}
          breadcrumb="Admin / EVV"
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
            {/* UI-003 containment (production-readiness audit 2026-08-03): the backend HARDCODES
                complianceRate:1 / lateCheckoutRate:0 (evv-route-service-db.ts metrics()) — a
                CMS-mandated program was showing a fixed perfect score. Render "—" until a real
                numerator exists; never print a fabricated 100%. The three computed rates are real
                rows but the service ignores the from/to window, so they are all-time, not 30d —
                the labels say so. */}
            <section style={sectionStyle}>
              <div style={sectionHeaderStyle}>
                <div>
                  <h2 style={sectionTitleStyle}>EVV Health</h2>
                  <div style={sectionSubtitleStyle}>
                    Partial server metrics; measured rows are all-time.
                  </div>
                </div>
                <StatusPill label="Partial" tone="warning" />
              </div>
              <div style={factsGridStyle}>
                <MetricFact label="Compliant rate" value="—" detail="Not yet measured by backend" />
                <MetricFact
                  label="Late-checkout rate"
                  value="—"
                  detail="Not yet measured by backend"
                />
                <MetricFact
                  label="Geofence-deviation rate"
                  value={pct(metrics.geofenceDeviationRate)}
                  detail="All time"
                />
                <MetricFact
                  label="GPS-spoof rate"
                  value={pct(metrics.gpsSpoofingDetectedRate)}
                  detail="All time"
                />
                <MetricFact
                  label="Aggregator acceptance"
                  value={pct(metrics.aggregatorSubmissionSuccessRate)}
                  detail="All time"
                />
              </div>
            </section>
          </div>
        )
      }
      detail={
        <div style={detailStyle}>
          <section style={railSectionStyle}>
            <h3 style={railTitleStyle}>Measurement Notes</h3>
            <p style={railTextStyle}>
              Compliance and late-checkout values are intentionally blank until the backend exposes
              real numerators. The UI does not print hardcoded perfect scores.
            </p>
          </section>
          <section style={railSectionStyle}>
            <h3 style={railTitleStyle}>Window</h3>
            <p style={railTextStyle}>
              The request sends a trailing-30-day window, but the currently measured EVV rates are
              returned by the service as all-time values.
            </p>
          </section>
        </div>
      }
      fullPageScroll
    />
  );
}

function MetricFact({
  label,
  value,
  detail,
}: { label: string; value: string; detail: string }): JSX.Element {
  return (
    <div style={factStyle}>
      <div style={factLabelStyle}>{label}</div>
      <div className="tabular-nums" style={factValueStyle}>
        {value}
      </div>
      <div style={factDetailStyle}>{detail}</div>
    </div>
  );
}

export function EvvDashboard(): JSX.Element {
  return <EvvMetricsDashboard title="EVV Dashboard" />;
}

export function EvvMetrics(): JSX.Element {
  return <EvvMetricsDashboard title="EVV Metrics" />;
}

const contentStyle = {
  padding: "0 1.5rem 1.5rem",
  maxWidth: "72rem",
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

const factDetailStyle = {
  marginTop: "0.25rem",
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
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
