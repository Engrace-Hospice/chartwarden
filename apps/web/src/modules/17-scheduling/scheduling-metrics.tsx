// apps/web/src/modules/17-scheduling — Scheduling Metrics (M17 §5.1 `/app/admin/scheduling-metrics`, Track B / ADR-0030).
// Spec: docs/design/screens — "Use Dashboard". Org-wide scheduling metrics: on-time rate, no-show rate, reschedule
// rate (the visit-metrics provider) over a trailing-30-day window. The route-efficiency drill-down is a
// per-clinician read surfaced from `?membership=`. The SERVER computes the aggregates (the §4.3
// VisitMetricsProvider seam); ADR-0030 — no frontend authz. Reads GET /api/v1/metrics/visits via the typed
// client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { DashboardLayout, EmptyState, KpiCard, LoadingSpinner, PageHeader, useApiClient } from "@wardenx/ui";

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
    <DashboardLayout
      header={<PageHeader title="Scheduling Metrics" />}
      kpis={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading || !metrics ? (
          <LoadingSpinner />
        ) : (
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", padding: "1rem 1.5rem" }}>
            <KpiCard label="On-time rate (30d)" value={pct(metrics.onTimeRate)} />
            <KpiCard label="No-show rate (30d)" value={pct(metrics.noShowRate)} />
            <KpiCard label="Reschedule rate (30d)" value={pct(metrics.rescheduleRate)} />
          </div>
        )
      }
    />
  );
}
