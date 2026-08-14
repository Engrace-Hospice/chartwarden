import {
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
import type { operations } from "@wardenx/ui";
// apps/admin/src/modules/32-ai-platform — §5.1.6 token ledger + forecast
// (`/admin/ai-platform/tokens`, `ai.tokens.read`).
//
// TWO ROUTES, TWO QUESTIONS. `GET /tokens/ledger` answers "what has been spent" (accrual rows + the
// window totals); `GET /tokens/forecast` answers "where is this heading" (burn rate, projected window
// total, the caps). The page leads with the forecast, because a spend number without a cap beside it
// tells an operator nothing actionable.
//
// STATUS READS THE PROJECTION, NOT THE SPEND (status.ts `forecastStatus`): a tenant at 40% of its cap on
// day 3 of a 30-day window is not green, and colouring it green is how a hard cap gets hit unannounced.
//
// NO COST TOTAL, deliberately. §5.1.6 asks for "total estimated cost (per the M35 cost mapping)". The
// ledger serves `cloudCostUsd` PER ACCRUAL as an exact decimal STRING (a Postgres NUMERIC — the money
// kernel's whole point is that it never becomes a float), and it serves token totals for the window but
// no cost total. Summing the page in the browser would produce a figure that is both float-rounded and
// only the hundred rows shown, presented next to server-computed token totals — the exact shape of two
// dashboards disagreeing about the same month. Per-row cost is rendered verbatim; the window total is a
// server-side aggregate that does not exist yet.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { forecastStatus } from "./status";
import {
  bodyRow,
  cell,
  cellRight,
  formatDate,
  formatInt,
  pageStyle,
  tableStyle,
  theadRow,
} from "./ui";

type LedgerPage =
  operations["getApiV1AiTokensLedger"]["responses"][200]["content"]["application/json"];
type ForecastPage =
  operations["getApiV1AiTokensForecast"]["responses"][200]["content"]["application/json"];
type Forecast = ForecastPage["forecasts"][number];
type LedgerEntry = LedgerPage["entries"][number];

/**
 * Render the ledger's exact-decimal cost STRING as-is behind a `$`. Not parsed to a number: the value is
 * a Postgres NUMERIC and re-formatting it through a float is how exact money stops being exact. `null`
 * (a local-compute accrual has no cloud cost) renders an em dash, never `$0.00` — those are different
 * facts.
 */
function formatUsd(v: string | null | undefined): string {
  return v === null || v === undefined ? "—" : `$${v}`;
}

export function TokenLedger(): JSX.Element {
  const client = useApiClient();
  const [forecasts, setForecasts] = useState<Forecast[]>([]);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [windowInput, setWindowInput] = useState(0);
  const [windowOutput, setWindowOutput] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [f, l] = await Promise.all([
      client.GET("/api/v1/ai/tokens/forecast", { params: { query: {} } }),
      client.GET("/api/v1/ai/tokens/ledger", { params: { query: { limit: 100 } } }),
    ]);
    if (f.error || l.error) {
      setError("Token ledger unavailable.");
      setLoading(false);
      return;
    }
    setForecasts(f.data.forecasts);
    setEntries(l.data.entries);
    setWindowInput(l.data.windowInputTokens);
    setWindowOutput(l.data.windowOutputTokens);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const capped = forecasts.filter((f) => f.softCap !== null || f.hardCap !== null);
  const projectedBreaches = forecasts.filter((f) => f.projectedBreach !== null).length;

  return (
    <div style={pageStyle}>
      <PageHeader title="Token ledger" breadcrumb="AI Platform" />
      {loading && forecasts.length === 0 ? (
        <LoadingSpinner />
      ) : error ? (
        <EmptyState title={error} description="Retry shortly." />
      ) : (
        <>
          <KpiStrip>
            <KpiCard label="Input tokens (window)" value={formatInt(windowInput)} />
            <KpiCard label="Output tokens (window)" value={formatInt(windowOutput)} />
            <KpiCard label="Accrual rows shown" value={formatInt(entries.length)} />
            <KpiCard label="Capabilities projected to breach" value={String(projectedBreaches)} />
          </KpiStrip>

          <section>
            <h2 style={{ fontSize: "0.95rem", fontWeight: 600, padding: "0.5rem 0" }}>
              Forecast by capability
            </h2>
            {forecasts.length === 0 ? (
              <EmptyState
                title="No spend in the current window"
                description="No capability has accrued tokens yet."
              />
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr style={theadRow}>
                    <th style={cell}>Capability</th>
                    <th style={cell}>Window</th>
                    <th style={cellRight}>Spent</th>
                    <th style={cellRight}>Burn / h</th>
                    <th style={cellRight}>Projected</th>
                    <th style={cellRight}>Soft cap</th>
                    <th style={cellRight}>Hard cap</th>
                    <th style={cell}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {forecasts.map((f) => {
                    const status = forecastStatus(
                      f.projectedWindowTotal,
                      f.softCap ?? null,
                      f.hardCap ?? null,
                    );
                    return (
                      <tr key={f.capabilityId} style={bodyRow}>
                        <td style={cell}>
                          <code>{f.capabilityKey}</code>
                        </td>
                        <td style={cell} className="tabular-nums">
                          {formatDate(f.windowStart)} → {formatDate(f.windowEnd)}
                        </td>
                        <td style={cellRight} className="tabular-nums">
                          {formatInt(f.spentTokens)}
                        </td>
                        <td style={cellRight} className="tabular-nums">
                          {Math.round(f.burnRatePerHour).toLocaleString()}
                        </td>
                        <td style={cellRight} className="tabular-nums">
                          {formatInt(Math.round(f.projectedWindowTotal))}
                        </td>
                        <td style={cellRight} className="tabular-nums">
                          {f.softCap === null ? "—" : formatInt(f.softCap)}
                        </td>
                        <td style={cellRight} className="tabular-nums">
                          {f.hardCap === null ? "—" : formatInt(f.hardCap)}
                        </td>
                        <td style={cell}>
                          <StatusPill label={status.label} tone={status.tone} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {forecasts.length > 0 && capped.length === 0 ? (
              // Worth saying out loud: every row will read "Within caps" forever when no cap is set.
              <p style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
                No capability in this window has a soft or hard cap configured, so no spend can
                breach one.
              </p>
            ) : null}
          </section>

          <section>
            <h2 style={{ fontSize: "0.95rem", fontWeight: 600, padding: "0.5rem 0" }}>
              Recent accruals
            </h2>
            {entries.length === 0 ? (
              <EmptyState title="No accruals" description="No token accrual rows in this window." />
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr style={theadRow}>
                    <th style={cell}>Accrued at</th>
                    <th style={cellRight}>Input</th>
                    <th style={cellRight}>Output</th>
                    <th style={cellRight}>Cloud cost</th>
                    <th style={cell}>Local attribution</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.ledgerId} style={bodyRow}>
                      <td style={cell} className="tabular-nums">
                        {formatDate(e.accruedAt)}
                      </td>
                      <td style={cellRight} className="tabular-nums">
                        {formatInt(e.inputTokens)}
                      </td>
                      <td style={cellRight} className="tabular-nums">
                        {formatInt(e.outputTokens)}
                      </td>
                      <td style={cellRight} className="tabular-nums">
                        {formatUsd(e.cloudCostUsd)}
                      </td>
                      <td style={cell}>{e.localComputeAttribution ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
