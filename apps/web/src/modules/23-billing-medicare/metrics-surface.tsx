import {
  DashboardLayout,
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/23-billing-medicare — M23 Billing — Medicare, the METRICS SURFACE (R2, §5.1 #22 /
// §4.6 `billing.claim.read_metrics`). The per-window aggregate drill-down behind the AR dashboard: the
// claim-state mix the M33 reporting consumer projects, narrowable to a single ProviderEntity ("window").
//   GET /api/v1/billing/metrics[?providerEntityId=] → { buckets: { key=claimState, count, amountCents }[] }
// Aggregate-only (no row-level PHI); org-scoped server-side (RLS). The server is the only authz point
// (ADR-0030) — a 503 (seam unbound) degrades the surface to an EmptyState. Each state row drills into the
// Claim Workbench filtered to that state. Lantern: DashboardLayout + KpiStrip (Fraunces eyebrow / Inter
// tabular figure) + No-Line table (§6.7), tabular-nums, CSS-var tokens only; state tones resolve through
// billing-status.ts (§6.6).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { claimStateTone, dollars, statusLabel } from "./billing-status";

interface MetricsBucket {
  key: string;
  count: number;
  amountCents: number;
}

// openapi marks the metrics query as `never`; build + cast it. providerEntityId narrows the rollup window.
function metricsInit(providerEntityId: string): unknown {
  if (!providerEntityId) return undefined;
  return { params: { query: { providerEntityId } } };
}

export function MetricsSurface(): JSX.Element {
  const client = useApiClient();
  const [providerEntityId, setProviderEntityId] = useState("");
  const [applied, setApplied] = useState("");
  const [buckets, setBuckets] = useState<MetricsBucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const init = metricsInit(applied);
    const res = init
      ? await client.GET("/api/v1/billing/metrics", init as never)
      : await client.GET("/api/v1/billing/metrics");
    if (res.error) {
      setError("Metrics unavailable — the billing read seam is not bound, or you lack scope.");
      setLoading(false);
      return;
    }
    setBuckets(
      ((res.data as unknown as { buckets?: MetricsBucket[] })?.buckets ?? []) as MetricsBucket[],
    );
    setLoading(false);
  }, [client, applied]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => {
    const totalCount = buckets.reduce((n, b) => n + b.count, 0);
    const totalCents = buckets.reduce((n, b) => n + b.amountCents, 0);
    const byKey = new Map(buckets.map((b) => [b.key, b]));
    const denied = byKey.get("denied")?.count ?? 0;
    const paidCents =
      (byKey.get("paid")?.amountCents ?? 0) + (byKey.get("partial_paid")?.amountCents ?? 0);
    const denialRate = totalCount > 0 ? Math.round((denied / totalCount) * 100) : null;
    return { totalCount, totalCents, denied, paidCents, denialRate };
  }, [buckets]);

  return (
    <DashboardLayout
      header={<PageHeader title="Billing Metrics" breadcrumb="Billing — Medicare" />}
      kpis={
        <KpiStrip>
          <KpiCard label="Claims (all states)" value={totals.totalCount} />
          <KpiCard label="Total billed" value={dollars(totals.totalCents)} />
          <KpiCard
            label="Denial rate"
            value={totals.denialRate === null ? "—" : `${totals.denialRate}%`}
          />
          <KpiCard label="Denied claims" value={totals.denied} />
          <KpiCard label="Paid amount" value={dollars(totals.paidCents)} />
        </KpiStrip>
      }
      charts={
        <section
          style={{ display: "flex", alignItems: "flex-end", gap: "0.5rem", flexWrap: "wrap" }}
        >
          <label style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
            <span style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>
              Provider entity window
            </span>
            <input
              aria-label="Provider entity id"
              placeholder="All provider entities…"
              value={providerEntityId}
              onChange={(e) => setProviderEntityId(e.target.value)}
              style={inputStyle}
            />
          </label>
          <button
            type="button"
            onClick={() => setApplied(providerEntityId)}
            style={primaryButtonStyle}
          >
            Apply
          </button>
          {applied ? (
            <button
              type="button"
              onClick={() => {
                setProviderEntityId("");
                setApplied("");
              }}
              style={ghostButtonStyle}
            >
              Clear window
            </button>
          ) : null}
        </section>
      }
      table={
        loading ? (
          <LoadingSpinner />
        ) : error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : buckets.length === 0 ? (
          <EmptyState
            title="No metrics"
            description="No claim metrics are available for this window in your scope."
          />
        ) : (
          <StateMixTable buckets={buckets} totalCount={totals.totalCount} window={applied} />
        )
      }
    />
  );
}

// ── No-Line claim-state-mix table (§6.7) — each row drills into the filtered Claim Workbench ──────────
function StateMixTable({
  buckets,
  totalCount,
  window,
}: {
  buckets: MetricsBucket[];
  totalCount: number;
  window: string;
}): JSX.Element {
  const sorted = [...buckets].sort((a, b) => b.amountCents - a.amountCents);
  const drillHref = (state: string): string => {
    const q = new URLSearchParams({ state });
    if (window) q.set("providerEntityId", window);
    return `/billing/claims?${q.toString()}`;
  };
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
      <caption
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
        }}
      >
        Claim state mix
      </caption>
      <thead>
        <tr style={{ textAlign: "left", color: "var(--color-on-surface-variant)" }}>
          <th style={thStyle} scope="col">
            State
          </th>
          <th style={{ ...thStyle, textAlign: "right" }} scope="col">
            Claims
          </th>
          <th style={{ ...thStyle, textAlign: "right" }} scope="col">
            Share
          </th>
          <th style={{ ...thStyle, textAlign: "right" }} scope="col">
            Amount
          </th>
          <th style={thStyle} scope="col">
            Drill down
          </th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((b, i) => {
          const share = totalCount > 0 ? Math.round((b.count / totalCount) * 100) : 0;
          return (
            <tr
              key={b.key}
              style={{ background: i % 2 === 1 ? "var(--color-surface-low)" : "transparent" }}
            >
              <td style={tdStyle}>
                <StatusPill label={statusLabel(b.key)} tone={claimStateTone(b.key)} />
              </td>
              <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                {b.count}
              </td>
              <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                {share}%
              </td>
              <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                {dollars(b.amountCents)}
              </td>
              <td style={tdStyle}>
                <a
                  href={drillHref(b.key)}
                  style={{ fontSize: "0.8rem", color: "var(--color-primary)" }}
                >
                  Open in workbench →
                </a>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const thStyle = {
  padding: "0.5rem 0.75rem",
  fontSize: "0.7rem",
  fontWeight: 600,
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
};
const tdStyle = { padding: "0.5rem 0.75rem", color: "var(--color-on-surface)" };
const inputStyle = {
  padding: "0.35rem 0.5rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
  minWidth: "14rem",
};
const primaryButtonStyle = {
  padding: "0.4rem 0.85rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  cursor: "pointer",
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
  fontSize: "0.8rem",
  fontWeight: 600,
};
const ghostButtonStyle = {
  padding: "0.4rem 0.85rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  cursor: "pointer",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.8rem",
  fontWeight: 600,
};
