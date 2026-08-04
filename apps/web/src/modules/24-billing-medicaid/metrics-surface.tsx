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
// apps/web/src/modules/24-billing-medicaid — M24, the METRICS SURFACE (R2, §5.1 #18). The billing manager's
// M33-fed read: denial rate, open AR aging, MCO breakdown, and per-state channel availability. Channel
// availability is derived from the trading-partner credentials (a state with no active credential cannot be
// submitted to) and is read best-effort — a manager without org-admin access sees the metrics without the
// channel panel rather than an error. Backed by GET /api/v1/medicaid-ar-dashboard/metrics (+ the credential
// read). Lantern: DashboardLayout + KpiStrip + No-Line tables (§6.7); CSS-var tokens only.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { channelLabel, money, pct, shortDate, shortId } from "./medicaid-status";
import {
  Card,
  linkStyle,
  mutedStyle,
  rowLine,
  sectionTitleStyle,
  tableStyle,
  td,
  tdMono,
  tdNum,
  th,
  thNum,
} from "./medicaid-ui";

interface AgingBucket {
  bucket: string;
  count: number;
  chargesCents: number;
}

interface ArMetrics {
  denialRate: number;
  openCount: number;
  byMco: Array<{ mcoId: string | null; count: number }>;
  aging: AgingBucket[];
}

interface Credential {
  id: string;
  serviceState: string;
  channel: string;
  activeTo: string | null;
  lastSandboxTestAt: string | null;
  lastSandboxTestResult: string | null;
}

export function MedicaidMetricsSurface(): JSX.Element {
  const client = useApiClient();
  const [metrics, setMetrics] = useState<ArMetrics | null>(null);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [channelsDegraded, setChannelsDegraded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setChannelsDegraded(false);
    const [metricsRes, credRes] = await Promise.all([
      client.GET("/api/v1/medicaid-ar-dashboard/metrics", {}),
      client.GET("/api/v1/state-medicaid-trading-partner-credentials", {}),
    ]);
    if (metricsRes.error) {
      setError("Medicaid metrics are unavailable — you may lack the billing metrics permission.");
      setLoading(false);
      return;
    }
    setMetrics(metricsRes.data as unknown as ArMetrics);
    if (credRes.error) setChannelsDegraded(true);
    else setCredentials((credRes.data as unknown as Credential[]) ?? []);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error || !metrics)
    return <EmptyState title="Unavailable" description={error ?? "No metrics."} />;

  const totalCharges = metrics.aging.reduce((acc, b) => acc + b.chargesCents, 0);
  const mcoAttributed = metrics.byMco.filter((m) => m.mcoId).reduce((acc, m) => acc + m.count, 0);
  const nowIso = new Date().toISOString().slice(0, 10);
  const activeChannels = credentials.filter((c) => !c.activeTo || c.activeTo >= nowIso);
  const states = [...new Set(activeChannels.map((c) => c.serviceState))].sort();

  return (
    <DashboardLayout
      header={
        <PageHeader
          title="Medicaid Metrics"
          breadcrumb="Billing — Medicaid · denial rate, aging, channels"
          actions={
            <a href="/medicaid/billing/ar-dashboard" style={linkStyle}>
              AR dashboard →
            </a>
          }
        />
      }
      kpis={
        <KpiStrip>
          <KpiCard label="Denial rate" value={pct(metrics.denialRate)} />
          <KpiCard label="Open claims" value={metrics.openCount.toLocaleString()} />
          <KpiCard label="Open AR" value={money(totalCharges)} />
          <KpiCard
            label="MCO-routed"
            value={metrics.openCount > 0 ? pct(mcoAttributed / metrics.openCount) : "—"}
          />
        </KpiStrip>
      }
      table={
        <section style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          <div>
            <h2 style={sectionTitleStyle}>AR aging</h2>
            {metrics.aging.length === 0 ? (
              <EmptyState
                title="No open AR"
                description="No Medicaid claim is currently outstanding."
              />
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={th}>Bucket</th>
                    <th style={thNum}>Claims</th>
                    <th style={thNum}>Charges</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.aging.map((b) => (
                    <tr key={b.bucket} style={rowLine}>
                      <td style={td}>{b.bucket}</td>
                      <td style={tdNum}>{b.count.toLocaleString()}</td>
                      <td style={tdNum}>{money(b.chargesCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div>
            <h2 style={sectionTitleStyle}>Channel availability</h2>
            {channelsDegraded ? (
              <span style={mutedStyle}>
                Channel availability requires trading-partner access — ask your administrator.
              </span>
            ) : states.length === 0 ? (
              <EmptyState
                title="No active channels"
                description="No state trading-partner credential is active — Medicaid submission is unavailable."
              />
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={th}>State</th>
                    <th style={th}>Channels</th>
                    <th style={th}>Last verified</th>
                    <th style={th}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {states.map((s) => {
                    const forState = activeChannels.filter((c) => c.serviceState === s);
                    const lastTest = forState
                      .map((c) => c.lastSandboxTestAt)
                      .filter((v): v is string => Boolean(v))
                      .sort()
                      .pop();
                    const anyFailing = forState.some(
                      (c) =>
                        c.lastSandboxTestResult === "fail" || c.lastSandboxTestResult === "error",
                    );
                    return (
                      <tr key={s} style={rowLine}>
                        <td style={td}>{s}</td>
                        <td style={td}>
                          {[...new Set(forState.map((c) => channelLabel(c.channel)))].join(", ")}
                        </td>
                        <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>
                          {lastTest ? shortDate(lastTest) : "Never tested"}
                        </td>
                        <td style={td}>
                          <StatusPill
                            label={anyFailing ? "Verify" : lastTest ? "Available" : "Untested"}
                            tone={anyFailing ? "error" : lastTest ? "success" : "warning"}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>
      }
      aside={
        <Card title="MCO breakdown">
          {metrics.byMco.length === 0 ? (
            <span style={mutedStyle}>No open claims to attribute.</span>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={th}>MCO</th>
                  <th style={thNum}>Claims</th>
                </tr>
              </thead>
              <tbody>
                {metrics.byMco.map((m) => (
                  <tr key={m.mcoId ?? "fee-for-service"} style={rowLine}>
                    <td style={m.mcoId ? tdMono : td}>
                      {m.mcoId ? shortId(m.mcoId) : "Fee-for-service"}
                    </td>
                    <td style={tdNum}>{m.count.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      }
    />
  );
}
