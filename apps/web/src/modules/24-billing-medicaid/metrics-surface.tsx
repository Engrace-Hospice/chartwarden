import {
  Button,
  DashboardLayout,
  EmptyState,
  Glyph,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
// apps/web/src/modules/24-billing-medicaid — M24, the METRICS SURFACE (R2, §5.1 #18). The billing manager's
// M33-fed read: denial rate, open AR aging, MCO breakdown, and per-state channel availability. Channel
// availability is derived from the trading-partner credentials (a state with no active credential cannot be
// submitted to) and is read best-effort — a manager without org-admin access sees the metrics without the
// channel panel rather than an error. Backed by GET /api/v1/medicaid-ar-dashboard/metrics (+ the credential
// read). Lantern: DashboardLayout + KpiStrip + No-Line tables (§6.7); CSS-var tokens only.
import { MedicaidBillingTabs } from "../../shell/medicaid-billing-tabs";
import { channelLabel, money, pct, shortDate, shortId } from "./medicaid-status";
import {
  FilterRow,
  SelectFilter,
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

interface ChannelRow {
  state: string;
  channels: string[];
  lastTest: string | null;
  anyFailing: boolean;
}

const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function MedicaidMetricsSurface(): JSX.Element {
  const client = useApiClient();
  const [metrics, setMetrics] = useState<ArMetrics | null>(null);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [channelsDegraded, setChannelsDegraded] = useState(false);
  const [channelStateFilter, setChannelStateFilter] = useState("");
  const [channelSearch, setChannelSearch] = useState("");
  const [channelPage, setChannelPage] = useState(1);
  const [channelPageSize, setChannelPageSize] = useState(10);
  const [mcoPage, setMcoPage] = useState(1);
  const [mcoPageSize, setMcoPageSize] = useState(10);
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

  const nowIso = new Date().toISOString().slice(0, 10);
  const totalCharges = metrics?.aging.reduce((acc, b) => acc + b.chargesCents, 0) ?? 0;
  const mcoAttributed =
    metrics?.byMco.filter((m) => m.mcoId).reduce((acc, m) => acc + m.count, 0) ?? 0;
  const activeChannels = useMemo(
    () => credentials.filter((c) => !c.activeTo || c.activeTo >= nowIso),
    [credentials, nowIso],
  );
  const channelRows = useMemo<ChannelRow[]>(() => {
    const states = [...new Set(activeChannels.map((c) => c.serviceState))].sort();
    return states.map((state) => {
      const forState = activeChannels.filter((c) => c.serviceState === state);
      const lastTest = forState
        .map((c) => c.lastSandboxTestAt)
        .filter((v): v is string => Boolean(v))
        .sort()
        .pop();
      const anyFailing = forState.some(
        (c) => c.lastSandboxTestResult === "fail" || c.lastSandboxTestResult === "error",
      );
      return {
        state,
        channels: [...new Set(forState.map((c) => channelLabel(c.channel)))],
        lastTest: lastTest ?? null,
        anyFailing,
      };
    });
  }, [activeChannels]);
  const channelStateOptions = useMemo(
    () => [
      { value: "", label: "Any state" },
      ...channelRows.map((row) => ({ value: row.state, label: row.state })),
    ],
    [channelRows],
  );
  const filteredChannelRows = useMemo(() => {
    const q = channelSearch.trim().toLowerCase();
    return channelRows.filter((row) => {
      const matchesState = !channelStateFilter || row.state === channelStateFilter;
      const matchesSearch =
        !q ||
        [
          row.state,
          row.channels.join(", "),
          row.lastTest ?? "",
          row.anyFailing ? "verify" : "available",
        ].some((value) => value.toLowerCase().includes(q));
      return matchesState && matchesSearch;
    });
  }, [channelRows, channelSearch, channelStateFilter]);

  const channelPageCount = Math.max(1, Math.ceil(filteredChannelRows.length / channelPageSize));
  const activeChannelPage = Math.min(channelPage, channelPageCount);
  const pagedChannelRows = filteredChannelRows.slice(
    (activeChannelPage - 1) * channelPageSize,
    activeChannelPage * channelPageSize,
  );
  const mcoRows = metrics?.byMco ?? [];
  const mcoPageCount = Math.max(1, Math.ceil(mcoRows.length / mcoPageSize));
  const activeMcoPage = Math.min(mcoPage, mcoPageCount);
  const pagedMcoRows = mcoRows.slice(
    (activeMcoPage - 1) * mcoPageSize,
    activeMcoPage * mcoPageSize,
  );
  const channelsNeedVerification = channelRows.filter(
    (row) => row.anyFailing || !row.lastTest,
  ).length;
  const hasChannelFilters = channelSearch !== "" || channelStateFilter !== "";

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
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Monitor denial pressure, open AR exposure, MCO routing, and state channel readiness.
          </div>
          <div style={{ marginTop: "0.75rem" }}>
            <MedicaidBillingTabs />
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Denial Rate"
            value={loading || error || !metrics ? "—" : pct(metrics.denialRate)}
            detail="Validated claims"
            tone={metrics && metrics.denialRate > 0 ? "warning" : "neutral"}
            accentColor={
              metrics && metrics.denialRate > 0
                ? "var(--color-warning)"
                : "var(--color-outline-variant)"
            }
          />
          <KpiCard
            label="Open Claims"
            value={loading || error || !metrics ? "—" : metrics.openCount.toLocaleString()}
            detail="Outstanding"
            tone="info"
            accentColor="var(--color-primary)"
          />
          <KpiCard
            label="Open AR"
            value={loading || error || !metrics ? "—" : money(totalCharges)}
            detail="Charges in aging"
            tone={totalCharges > 0 ? "warning" : "neutral"}
            accentColor={totalCharges > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"}
          />
          <KpiCard
            label="MCO-Routed"
            value={
              loading || error || !metrics || metrics.openCount === 0
                ? "—"
                : pct(mcoAttributed / metrics.openCount)
            }
            detail="Open claim mix"
            tone="neutral"
            accentColor="var(--color-outline-variant)"
          />
          <KpiCard
            label="Channel Review"
            value={loading || error || channelsDegraded ? "—" : channelsNeedVerification}
            detail={channelsDegraded ? "Unavailable" : "Need verification"}
            tone={channelsNeedVerification > 0 ? "warning" : "success"}
            accentColor={
              channelsNeedVerification > 0 ? "var(--color-warning)" : "var(--color-success)"
            }
          />
        </KpiStrip>
      }
      charts={
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {error ? (
            <div role="alert" style={errorBannerStyle}>
              <Glyph name="alert" size={16} />
              <span>{error}</span>
            </div>
          ) : channelsDegraded ? (
            <output style={warningBannerStyle}>
              <Glyph name="alert" size={16} />
              <span>Channel availability requires trading-partner access.</span>
            </output>
          ) : null}
          <FilterRow>
            <label className="wx-search-field">
              <Glyph name="search" size={16} />
              <input
                type="search"
                placeholder="Search channel state or status..."
                value={channelSearch}
                onChange={(e) => {
                  setChannelSearch(e.target.value);
                  setChannelPage(1);
                }}
                aria-label="Search channel availability"
              />
            </label>
            <SelectFilter
              label="Channel state"
              value={channelStateFilter}
              options={channelStateOptions}
              onChange={(next) => {
                setChannelStateFilter(next);
                setChannelPage(1);
              }}
            />
            {hasChannelFilters ? (
              <Button
                size="sm"
                tone="tertiary"
                onClick={() => {
                  setChannelSearch("");
                  setChannelStateFilter("");
                  setChannelPage(1);
                }}
              >
                Clear
              </Button>
            ) : null}
            <span style={mutedStyle}>
              {filteredChannelRows.length} of {channelRows.length} channels
            </span>
          </FilterRow>
        </div>
      }
      table={
        loading ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : error || !metrics ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={error ?? "No metrics."} />
          </div>
        ) : (
          <section style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
            <div>
              <h2 style={sectionTitleStyle}>AR aging</h2>
              {metrics.aging.length === 0 ? (
                <div style={{ padding: "2rem 0" }}>
                  <EmptyState
                    title="No open AR"
                    description="No Medicaid claim is currently outstanding."
                  />
                </div>
              ) : (
                <div style={{ width: "100%", overflowX: "auto" }}>
                  <table style={tableStyle}>
                    <thead>
                      <tr style={headerRowStyle}>
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
                </div>
              )}
            </div>

            <div>
              <h2 style={sectionTitleStyle}>Channel availability</h2>
              {channelsDegraded ? (
                <span style={mutedStyle}>
                  Channel availability requires trading-partner access — ask your administrator.
                </span>
              ) : filteredChannelRows.length === 0 ? (
                <div style={{ padding: "2rem 0" }}>
                  <EmptyState
                    title="No active channels"
                    description={
                      hasChannelFilters
                        ? "No active state channel matches these filters."
                        : "No state trading-partner credential is active — Medicaid submission is unavailable."
                    }
                    action={
                      hasChannelFilters ? (
                        <Button
                          tone="secondary"
                          size="sm"
                          onClick={() => {
                            setChannelSearch("");
                            setChannelStateFilter("");
                            setChannelPage(1);
                          }}
                        >
                          Clear filters
                        </Button>
                      ) : undefined
                    }
                  />
                </div>
              ) : (
                <div style={{ width: "100%", overflowX: "auto" }}>
                  <table style={tableStyle}>
                    <thead>
                      <tr style={headerRowStyle}>
                        <th style={th}>State</th>
                        <th style={th}>Channels</th>
                        <th style={th}>Last verified</th>
                        <th style={th}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedChannelRows.map((row) => (
                        <tr key={row.state} style={rowLine}>
                          <td style={td}>{row.state}</td>
                          <td style={td}>{row.channels.join(", ")}</td>
                          <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>
                            {row.lastTest ? shortDate(row.lastTest) : "Never tested"}
                          </td>
                          <td style={td}>
                            <StatusPill
                              label={
                                row.anyFailing ? "Verify" : row.lastTest ? "Available" : "Untested"
                              }
                              tone={row.anyFailing ? "error" : row.lastTest ? "success" : "warning"}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <OffsetPagination
                    page={activeChannelPage}
                    pageSize={channelPageSize}
                    totalItems={filteredChannelRows.length}
                    onPageChange={setChannelPage}
                    onPageSizeChange={(next) => {
                      setChannelPageSize(next);
                      setChannelPage(1);
                    }}
                    pageSizeOptions={PAGE_SIZES}
                    noun="channels"
                  />
                </div>
              )}
            </div>
          </section>
        )
      }
      aside={
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <h2 style={sectionTitleStyle}>MCO breakdown</h2>
          {loading ? (
            <LoadingSpinner />
          ) : !metrics || metrics.byMco.length === 0 ? (
            <span style={mutedStyle}>No open claims to attribute.</span>
          ) : (
            <div style={{ width: "100%", overflowX: "auto" }}>
              <table style={tableStyle}>
                <thead>
                  <tr style={headerRowStyle}>
                    <th style={th}>MCO</th>
                    <th style={thNum}>Claims</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedMcoRows.map((m) => (
                    <tr key={m.mcoId ?? "fee-for-service"} style={rowLine}>
                      <td style={m.mcoId ? tdMono : td}>
                        {m.mcoId ? shortId(m.mcoId) : "Fee-for-service"}
                      </td>
                      <td style={tdNum}>{m.count.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <OffsetPagination
                page={activeMcoPage}
                pageSize={mcoPageSize}
                totalItems={mcoRows.length}
                onPageChange={setMcoPage}
                onPageSizeChange={(next) => {
                  setMcoPageSize(next);
                  setMcoPage(1);
                }}
                pageSizeOptions={PAGE_SIZES}
                noun="MCO rows"
              />
            </div>
          )}
        </div>
      }
    />
  );
}

const headerRowStyle = {
  textAlign: "left" as const,
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
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
  gap: "0.5rem",
};

const warningBannerStyle = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-warning) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-warning) 30%, transparent)",
  color: "var(--color-warning)",
  fontSize: "0.85rem",
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
};
