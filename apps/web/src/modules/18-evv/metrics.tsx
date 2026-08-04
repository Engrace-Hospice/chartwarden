import {
  DashboardLayout,
  EmptyState,
  KpiCard,
  LoadingSpinner,
  PageHeader,
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
    <DashboardLayout
      header={<PageHeader title={title} />}
      kpis={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading || !metrics ? (
          <LoadingSpinner />
        ) : (
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", padding: "1rem 1.5rem" }}>
            {/* UI-003 containment (production-readiness audit 2026-08-03): the backend HARDCODES
                complianceRate:1 / lateCheckoutRate:0 (evv-route-service-db.ts metrics()) — a
                CMS-mandated program was showing a fixed perfect score. Render "—" until a real
                numerator exists; never print a fabricated 100%. The three computed rates are real
                rows but the service ignores the from/to window, so they are all-time, not 30d —
                the labels say so. */}
            <KpiCard label="Compliant rate (not yet measured)" value="—" />
            <KpiCard label="Late-checkout rate (not yet measured)" value="—" />
            <KpiCard
              label="Geofence-deviation rate (all time)"
              value={pct(metrics.geofenceDeviationRate)}
            />
            <KpiCard
              label="GPS-spoof rate (all time)"
              value={pct(metrics.gpsSpoofingDetectedRate)}
            />
            <KpiCard
              label="Aggregator acceptance (all time)"
              value={pct(metrics.aggregatorSubmissionSuccessRate)}
            />
          </div>
        )
      }
    />
  );
}

export function EvvDashboard(): JSX.Element {
  return <EvvMetricsDashboard title="EVV Dashboard" />;
}

export function EvvMetrics(): JSX.Element {
  return <EvvMetricsDashboard title="EVV Metrics" />;
}
