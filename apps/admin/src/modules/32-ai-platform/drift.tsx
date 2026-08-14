import { EmptyState, LoadingSpinner, PageHeader, StatusPill, useApiClient } from "@wardenx/ui";
import type { operations } from "@wardenx/ui";
// apps/admin/src/modules/32-ai-platform — §5.1.8 drift overview (`/admin/ai-platform/drift`,
// `ai.capability.read`).
//
// WHAT THE ROUTE ACTUALLY SERVES. `GET /api/v1/ai/drift/recent` returns recent `drift_response`-stage
// EVALUATION RUNS with their capability key — i.e. "which capabilities have had a drift investigation
// opened lately", each carrying that run's opaque `summaryMetrics`. It does NOT serve a metric-by-metric
// baseline delta series.
//
// So this is a heat-map over WHAT EXISTS: rows are capabilities, columns are the union of metric names
// found across the returned runs, and a cell is that run's value toned against the D11 10/20/30%
// thresholds (status.ts `driftTone`). A metric a capability does not report renders blank rather than
// zero — an absent measurement and a measured zero are opposite facts, and colouring the first green is
// how a monitoring gap reads as health.
//
// The §5.1.8 sketch also asks for a 30-day line chart per metric with a threshold band. That needs a
// time series the API does not expose (one run per finding, not a series), so it is not drawn. A chart
// interpolated from a single point would be a picture of nothing.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { driftTone } from "./status";
import {
  StandingNotice,
  bodyRow,
  cell,
  cellRight,
  formatDate,
  inputStyle,
  pageStyle,
  tableStyle,
  theadRow,
} from "./ui";

type DriftPage =
  operations["getApiV1AiDriftRecent"]["responses"][200]["content"]["application/json"];
type Finding = DriftPage["findings"][number];

const WINDOWS = [24, 72, 168, 720] as const;

/** Numeric metrics only — a string-valued entry is provenance (a model pin, a dataset ref), not drift. */
export function numericMetrics(metrics: unknown): Record<string, number> {
  if (metrics === null || typeof metrics !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(metrics as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export function DriftOverview(): JSX.Element {
  const client = useApiClient();
  const [findings, setFindings] = useState<Finding[]>([]);
  const [source, setSource] = useState("");
  const [withinHours, setWithinHours] = useState<number>(168);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/ai/drift/recent", {
      params: { query: { withinHours } },
    });
    if (res.error) {
      setError("Drift feed unavailable.");
      setLoading(false);
      return;
    }
    setFindings(res.data.findings);
    setSource(res.data.source);
    setLoading(false);
  }, [client, withinHours]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Column set = the union of numeric metric names across every finding, sorted for stability. */
  const columns = useMemo(() => {
    const names = new Set<string>();
    for (const f of findings)
      for (const k of Object.keys(numericMetrics(f.run.summaryMetrics))) names.add(k);
    return [...names].sort();
  }, [findings]);

  return (
    <div style={pageStyle}>
      <PageHeader
        title="Drift overview"
        breadcrumb="AI Platform"
        actions={
          <select
            value={String(withinHours)}
            onChange={(e) => setWithinHours(Number(e.target.value))}
            style={inputStyle}
            aria-label="Lookback window"
          >
            {WINDOWS.map((h) => (
              <option key={h} value={h}>
                Last {h < 168 ? `${h}h` : `${Math.round(h / 24)}d`}
              </option>
            ))}
          </select>
        }
      />
      {loading && findings.length === 0 ? (
        <LoadingSpinner />
      ) : error ? (
        <EmptyState title={error} description="Retry shortly." />
      ) : (
        <>
          <StandingNotice tone="warning">
            Cells are the metric values reported by each capability's most recent drift-response
            evaluation run ({source}), toned against the D11 10% / 20% / 30% thresholds. A blank
            cell means the capability did not report that metric — not that it measured zero.
          </StandingNotice>
          {findings.length === 0 ? (
            <EmptyState
              title="No drift investigations in this window"
              description="No drift-response evaluation run has been recorded. This is the expected steady state."
            />
          ) : (
            <>
              <table style={tableStyle}>
                <thead>
                  <tr style={theadRow}>
                    <th style={cell}>Capability</th>
                    {columns.map((c) => (
                      <th key={c} style={cellRight}>
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {findings.map((f) => {
                    const metrics = numericMetrics(f.run.summaryMetrics);
                    return (
                      <tr key={f.run.id} style={bodyRow}>
                        <td style={cell}>
                          <Link to={`/admin/ai-platform/capabilities/${f.run.capabilityId}`}>
                            <code>{f.capabilityKey}</code>
                          </Link>
                        </td>
                        {columns.map((c) => (
                          <td key={c} style={cellRight}>
                            {c in metrics ? (
                              <StatusPill
                                label={metrics[c]?.toFixed(3) ?? "—"}
                                tone={driftTone(metrics[c] ?? 0)}
                              />
                            ) : null}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <section>
                <h2 style={{ fontSize: "0.95rem", fontWeight: 600, padding: "0.5rem 0" }}>
                  Recent breach feed
                </h2>
                <table style={tableStyle}>
                  <thead>
                    <tr style={theadRow}>
                      <th style={cell}>Detected</th>
                      <th style={cell}>Capability</th>
                      <th style={cell}>Run status</th>
                      <th style={cell}>Golden set</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...findings]
                      .sort((a, b) => (a.run.createdAt < b.run.createdAt ? 1 : -1))
                      .map((f) => (
                        <tr key={`feed-${f.run.id}`} style={bodyRow}>
                          <td style={cell} className="tabular-nums">
                            {formatDate(f.run.createdAt)}
                          </td>
                          <td style={cell}>
                            <Link to={`/admin/ai-platform/capabilities/${f.run.capabilityId}`}>
                              <code>{f.capabilityKey}</code>
                            </Link>
                          </td>
                          <td style={cell}>{f.run.status}</td>
                          <td style={cell}>
                            <code>{f.run.datasetVersionRef}</code>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
