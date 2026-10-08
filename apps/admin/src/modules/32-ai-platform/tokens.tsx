import { Button, StatusPill, useApiClient } from "@wardenx/ui";
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
  EmptyListState,
  ErrorState,
  LoadingState,
  PageHead,
  SectionTitle,
  formatDate,
  formatInt,
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
  const stats = [
    { label: "Input tokens (window)", value: formatInt(windowInput) },
    { label: "Output tokens (window)", value: formatInt(windowOutput) },
    { label: "Accrual rows shown", value: formatInt(entries.length) },
    { label: "Capabilities projected to breach", value: String(projectedBreaches) },
  ];

  return (
    <div className="wx-list-drawer">
      <div className="wx-list-drawer-main">
        <PageHead
          title="Token ledger"
          description="Token spend so far this window, and where each capability's burn rate is heading against its caps."
        >
          <Button tone="secondary" onClick={() => void load()}>
            Refresh
          </Button>
        </PageHead>
        {loading && forecasts.length === 0 ? (
          <LoadingState label="Loading token ledger…" />
        ) : error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : (
          <>
            <div className="wx-stat-grid" aria-label="Token summary">
              {stats.map((s) => (
                <div key={s.label} className="wx-stat-card">
                  <div>
                    <span className="wx-stat-label">{s.label}</span>
                    <span className="wx-stat-value wx-nums">{s.value}</span>
                  </div>
                </div>
              ))}
            </div>

            <SectionTitle>Forecast by capability</SectionTitle>
            {forecasts.length === 0 ? (
              <EmptyListState
                title="No spend in the current window"
                description="No capability has accrued tokens yet."
              />
            ) : (
              <div className="wx-list-table-wrap">
                <table className="wx-list-table wx-list-table-static">
                  <caption className="wx-sr-only">Forecast by capability</caption>
                  <thead>
                    <tr>
                      <th scope="col">Capability</th>
                      <th scope="col">Window</th>
                      <th scope="col" className="wx-num-col">
                        Spent
                      </th>
                      <th scope="col" className="wx-num-col">
                        Burn / h
                      </th>
                      <th scope="col" className="wx-num-col">
                        Projected
                      </th>
                      <th scope="col" className="wx-num-col">
                        Soft cap
                      </th>
                      <th scope="col" className="wx-num-col">
                        Hard cap
                      </th>
                      <th scope="col">Status</th>
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
                        <tr key={f.capabilityId}>
                          <td className="wx-data-md">{f.capabilityKey}</td>
                          <td className="wx-nums">
                            {formatDate(f.windowStart)} → {formatDate(f.windowEnd)}
                          </td>
                          <td className="wx-num-col wx-nums">{formatInt(f.spentTokens)}</td>
                          <td className="wx-num-col wx-nums">
                            {Math.round(f.burnRatePerHour).toLocaleString()}
                          </td>
                          <td className="wx-num-col wx-nums">
                            {formatInt(Math.round(f.projectedWindowTotal))}
                          </td>
                          <td className="wx-num-col wx-nums">
                            {f.softCap === null ? "—" : formatInt(f.softCap)}
                          </td>
                          <td className="wx-num-col wx-nums">
                            {f.hardCap === null ? "—" : formatInt(f.hardCap)}
                          </td>
                          <td>
                            <StatusPill label={status.label} tone={status.tone} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {forecasts.length > 0 && capped.length === 0 ? (
              // Worth saying out loud: every row will read "Within caps" forever when no cap is set.
              <p className="wx-source-line">
                No capability in this window has a soft or hard cap configured, so no spend can
                breach one.
              </p>
            ) : null}

            <SectionTitle>Recent accruals</SectionTitle>
            {entries.length === 0 ? (
              <EmptyListState
                title="No accruals"
                description="No token accrual rows in this window."
              />
            ) : (
              <div className="wx-list-table-wrap">
                <table className="wx-list-table wx-list-table-static">
                  <caption className="wx-sr-only">Recent accruals</caption>
                  <thead>
                    <tr>
                      <th scope="col">Accrued at</th>
                      <th scope="col" className="wx-num-col">
                        Input
                      </th>
                      <th scope="col" className="wx-num-col">
                        Output
                      </th>
                      <th scope="col" className="wx-num-col">
                        Cloud cost
                      </th>
                      <th scope="col">Local attribution</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((e) => (
                      <tr key={e.ledgerId}>
                        <td className="wx-nums">{formatDate(e.accruedAt)}</td>
                        <td className="wx-num-col wx-nums">{formatInt(e.inputTokens)}</td>
                        <td className="wx-num-col wx-nums">{formatInt(e.outputTokens)}</td>
                        <td className="wx-num-col wx-nums">{formatUsd(e.cloudCostUsd)}</td>
                        <td>{e.localComputeAttribution ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
