import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/35-subscription — M35 usage (§5.1 `/billing/usage`).
// Current-period metered usage over GET /api/v1/usage/current — each meter as a progress bar (% of the
// included quantity) with its threshold pill (ok/warning/breached) + projected overage cost — over the
// historical periods from GET /api/v1/usage/history. Usage is metered on pseudonymized keys server-side
// (M35 privacy, §4.13); this surface shows only aggregate counts, never patient identity. Lantern: Work
// Queue, tabular-nums, §6.6 pills.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { USAGE_THRESHOLD_TONE, cap, formatCents, formatDate } from "./billing-status";

interface UsageMeter {
  eventType: string;
  label: string;
  totalQuantity: number;
  inclusiveQuantity: number;
  overageQuantity: number;
  overageUnitPriceCents: number;
  projectedOverageCostCents: number;
  thresholdState: string;
}
interface CurrentUsage {
  periodStart: string;
  periodEnd: string;
  meters: UsageMeter[];
}
interface UsagePeriod {
  periodStart: string;
  periodEnd: string;
  totalQuantity: number;
  inclusiveQuantity: number;
  overageQuantity: number;
}
interface HistoryPage {
  items: UsagePeriod[];
  nextCursor: string | null;
  hasMore: boolean;
}

export function Usage(): JSX.Element {
  const client = useApiClient();
  const [current, setCurrent] = useState<CurrentUsage | null>(null);
  const [history, setHistory] = useState<UsagePeriod[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [curRes, histRes] = await Promise.all([
      client.GET("/api/v1/usage/current"),
      client.GET("/api/v1/usage/history", { params: { query: { limit: 12 } } }),
    ]);
    if (curRes.error) {
      setError("Usage unavailable.");
      setLoading(false);
      return;
    }
    setCurrent(curRes.data as unknown as CurrentUsage);
    const page = histRes.error ? undefined : (histRes.data as unknown as HistoryPage);
    setHistory(page?.items ?? []);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error || !current)
    return <EmptyState title="Unavailable" description={error ?? "No usage."} />;

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Usage"
          breadcrumb={`Billing / ${formatDate(current.periodStart)} — ${formatDate(current.periodEnd)}`}
        />
      }
      table={
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "1.25rem",
            padding: "0 1.5rem 1.5rem",
          }}
        >
          {current.meters.length === 0 ? (
            <EmptyState title="No metered usage" description="This plan has no usage meters." />
          ) : (
            current.meters.map((m) => <MeterBar key={m.eventType} meter={m} />)
          )}

          {history.length > 0 ? (
            <section style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              <h2 style={sectionTitle}>Historical periods</h2>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--color-on-surface-variant)" }}>
                    <th style={hCell}>Period</th>
                    <th style={{ ...hCell, textAlign: "right" }}>Total</th>
                    <th style={{ ...hCell, textAlign: "right" }}>Included</th>
                    <th style={{ ...hCell, textAlign: "right" }}>Overage</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((p) => (
                    <tr
                      key={`${p.periodStart}-${p.periodEnd}`}
                      style={{ borderTop: "1px solid var(--color-outline-variant)" }}
                    >
                      <td style={hCell} className="tabular-nums">
                        {formatDate(p.periodStart)} — {formatDate(p.periodEnd)}
                      </td>
                      <td style={{ ...hCell, textAlign: "right" }} className="tabular-nums">
                        {p.totalQuantity.toLocaleString()}
                      </td>
                      <td style={{ ...hCell, textAlign: "right" }} className="tabular-nums">
                        {p.inclusiveQuantity.toLocaleString()}
                      </td>
                      <td style={{ ...hCell, textAlign: "right" }} className="tabular-nums">
                        {p.overageQuantity.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}
        </div>
      }
    />
  );
}

function MeterBar({ meter }: { meter: UsageMeter }): JSX.Element {
  const pct =
    meter.inclusiveQuantity > 0
      ? Math.min(100, Math.round((meter.totalQuantity / meter.inclusiveQuantity) * 100))
      : meter.totalQuantity > 0
        ? 100
        : 0;
  const tone = USAGE_THRESHOLD_TONE[meter.thresholdState] ?? "neutral";
  const barColor =
    tone === "error"
      ? "var(--color-error)"
      : tone === "warning"
        ? "var(--color-warning)"
        : "var(--color-primary)";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        background: "var(--color-surface-lowest)",
        borderRadius: "var(--radius-lg, 0.75rem)",
        boxShadow: "var(--shadow-soft)",
        padding: "1rem 1.25rem",
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
        <span style={{ fontWeight: 600 }}>{meter.label}</span>
        <StatusPill label={cap(meter.thresholdState)} tone={tone} />
      </div>
      <div
        style={{
          height: "0.5rem",
          borderRadius: "999px",
          background: "var(--color-surface-container)",
          overflow: "hidden",
        }}
      >
        <div style={{ width: `${pct}%`, height: "100%", background: barColor }} />
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "0.8rem",
          color: "var(--color-on-surface-variant)",
        }}
      >
        <span className="tabular-nums">
          {meter.totalQuantity.toLocaleString()} / {meter.inclusiveQuantity.toLocaleString()}{" "}
          included ({pct}%)
        </span>
        {meter.overageQuantity > 0 ? (
          <span className="tabular-nums">
            {meter.overageQuantity.toLocaleString()} overage ·{" "}
            {formatCents(meter.projectedOverageCostCents)} projected
          </span>
        ) : (
          <span>No overage</span>
        )}
      </div>
    </div>
  );
}

const sectionTitle = {
  margin: 0,
  fontSize: "0.6875rem",
  fontWeight: 600,
  color: "var(--color-on-surface-variant)",
} as const;
const hCell = { padding: "0.5rem 0.75rem" } as const;
