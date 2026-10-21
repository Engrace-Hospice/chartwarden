import {
  Button,
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/24-billing-medicaid — M24, the MEDICAID AR DASHBOARD (R2, §5.1 #1). The billing
// manager's landing surface: open-AR totals, aging buckets, per-state AR balance, and the rolling denial
// rate + MCO breakdown from the metrics read. Backed by GET /api/v1/medicaid-ar-dashboard (+ /metrics);
// the metrics read is best-effort (a manager may hold claim.read_ar_dashboard without read_metrics), so it
// degrades to an inline note rather than failing the page. Lantern: DashboardLayout + KpiStrip + No-Line
// tables (§6.7), tabular-nums money, CSS-var tokens only. The server is the only authz point (ADR-0030).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { money, pct, shortId } from "./medicaid-status";
import {
  Card,
  cardStyle,
  linkStyle,
  mutedStyle,
  rowLine,
  sectionTitleStyle,
  tableStyle,
  td,
  tdNum,
  th,
  thNum,
} from "./medicaid-ui";

interface AgingBucket {
  bucket: string;
  count: number;
  chargesCents: number;
}

interface ArDashboard {
  totalOpen: number;
  buckets: AgingBucket[];
  byState: Array<{ state: string; count: number; chargesCents: number }>;
}

interface ArMetrics {
  denialRate: number;
  openCount: number;
  byMco: Array<{ mcoId: string | null; count: number }>;
  aging: AgingBucket[];
}

const sumCents = (rows: readonly { chargesCents: number }[]): number =>
  rows.reduce((acc, r) => acc + r.chargesCents, 0);

export function MedicaidArDashboard(): JSX.Element {
  const client = useApiClient();
  const [ar, setAr] = useState<ArDashboard | null>(null);
  const [metrics, setMetrics] = useState<ArMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metricsDegraded, setMetricsDegraded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setMetricsDegraded(false);
    const [arRes, metricsRes] = await Promise.all([
      client.GET("/api/v1/medicaid-ar-dashboard", {}),
      client.GET("/api/v1/medicaid-ar-dashboard/metrics", {}),
    ]);
    if (arRes.error) {
      setError(
        "Medicaid AR is unavailable — you may lack billing visibility for this organization.",
      );
      setLoading(false);
      return;
    }
    setAr(arRes.data as unknown as ArDashboard);
    // Best-effort: the metrics read carries its own permission key (§4.7).
    if (metricsRes.error) setMetricsDegraded(true);
    else setMetrics(metricsRes.data as unknown as ArMetrics);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error || !ar) return <EmptyState title="Unavailable" description={error ?? "No AR data."} />;

  const totalCharges = sumCents(ar.buckets);
  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Medicaid AR"
          breadcrumb="Billing / Medicaid / Open accounts receivable"
          actions={
            <>
              <a href="/billing" style={linkButtonStyle}>
                Medicare AR
              </a>
              <a href="/medicaid/billing/claims" style={primaryLinkButtonStyle}>
                Claim workbench
              </a>
            </>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review Medicaid open AR by aging bucket, service state, and MCO attribution.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Open claims"
            value={ar.totalOpen.toLocaleString()}
            detail="Backend AR dashboard"
            tone="info"
            accentColor="var(--color-primary)"
          />
          <KpiCard
            label="Metrics open"
            value={metrics ? metrics.openCount.toLocaleString() : metricsDegraded ? "—" : "…"}
            detail="Backend metrics read"
            tone="neutral"
            accentColor="var(--color-outline-variant)"
          />
          <KpiCard
            label="Denial rate (rolling)"
            value={metrics ? pct(metrics.denialRate) : metricsDegraded ? "—" : "…"}
            detail="Backend metrics read"
            tone={metrics && metrics.denialRate > 0 ? "warning" : "neutral"}
            accentColor={
              metrics && metrics.denialRate > 0
                ? "var(--color-warning)"
                : "var(--color-outline-variant)"
            }
          />
        </KpiStrip>
      }
      table={
        <section
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "1.25rem",
            padding: "1rem 1.5rem 1.5rem",
          }}
        >
          <div>
            <h2 style={sectionTitleStyle}>Aging</h2>
            {ar.buckets.length === 0 ? (
              <EmptyState
                title="No open AR"
                description="Every Medicaid claim has reached a terminal state."
              />
            ) : (
              <div style={tableWrapStyle}>
                <table style={enhancedTableStyle}>
                  <thead>
                    <tr style={headRowStyle}>
                      <th style={th}>Bucket</th>
                      <th style={thNum}>Claims</th>
                      <th style={thNum}>Charges</th>
                      <th style={thNum}>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ar.buckets.map((b) => (
                      <tr key={b.bucket} style={enhancedRowLine}>
                        <td style={td}>{b.bucket}</td>
                        <td style={tdNum}>{b.count.toLocaleString()}</td>
                        <td style={tdNum}>{money(b.chargesCents)}</td>
                        <td style={tdNum}>
                          {totalCharges > 0 ? pct(b.chargesCents / totalCharges) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div>
            <h2 style={sectionTitleStyle}>By service state</h2>
            {ar.byState.length === 0 ? (
              <EmptyState
                title="No state breakdown"
                description="No open claims to attribute to a state."
              />
            ) : (
              <div style={tableWrapStyle}>
                <table style={enhancedTableStyle}>
                  <thead>
                    <tr style={headRowStyle}>
                      <th style={th}>State</th>
                      <th style={thNum}>Claims</th>
                      <th style={thNum}>Charges</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ar.byState.map((s) => (
                      <tr key={s.state} style={enhancedRowLine}>
                        <td style={td}>{s.state}</td>
                        <td style={tdNum}>{s.count.toLocaleString()}</td>
                        <td style={tdNum}>{money(s.chargesCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      }
      detail={
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <Card title="MCO mix">
            {metricsDegraded ? (
              <span style={mutedStyle}>
                Metrics require the Medicaid metrics permission — ask your administrator for access.
              </span>
            ) : !metrics || metrics.byMco.length === 0 ? (
              <span style={mutedStyle}>No MCO-attributed open claims.</span>
            ) : (
              <table style={enhancedTableStyle}>
                <thead>
                  <tr style={headRowStyle}>
                    <th style={th}>MCO</th>
                    <th style={thNum}>Claims</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.byMco.map((m) => (
                    <tr key={m.mcoId ?? "fee-for-service"} style={enhancedRowLine}>
                      <td style={{ ...td, fontFamily: m.mcoId ? "var(--font-mono)" : undefined }}>
                        {m.mcoId ? shortId(m.mcoId) : "Fee-for-service"}
                      </td>
                      <td style={tdNum}>{m.count.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <nav aria-label="Medicaid billing surfaces" style={cardStyle}>
            <a href="/medicaid/billing/validation-worklist" style={linkStyle}>
              Validation worklist →
            </a>
            <a href="/medicaid/billing/rb-arrangements" style={linkStyle}>
              R&amp;B arrangements →
            </a>
            <a href="/medicaid/billing/eligibility" style={linkStyle}>
              Eligibility center →
            </a>
            <a href="/medicaid/billing/metrics" style={linkStyle}>
              Metrics →
            </a>
          </nav>
        </div>
      }
      fullPageScroll
    />
  );
}

const tableWrapStyle = { width: "100%", overflowX: "auto" } as const;
const enhancedTableStyle = { ...tableStyle, fontSize: "0.875rem" };
const headRowStyle = {
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};
const enhancedRowLine = {
  ...rowLine,
  borderTop: "none",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
};
const linkButtonStyle = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: "2rem",
  padding: "0.35rem 0.7rem",
  borderRadius: "9999px",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.75rem",
  fontWeight: 650,
  textDecoration: "none",
};
const primaryLinkButtonStyle = {
  ...linkButtonStyle,
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
};
