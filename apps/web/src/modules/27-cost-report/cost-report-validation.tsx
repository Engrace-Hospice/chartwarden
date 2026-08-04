import {
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/27-cost-report — the VALIDATION worklist (R2, §5 / §11.B). Pick a report → its
// validation runs with the per-run pass/fail/warn/skip roll-up (the cost-report version of the M23 claim
// worklist). Read-only; the server is the only authz point (ADR-0030).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import {
  ReportPicker,
  cellStyle,
  headStyle,
  numStyle,
  rowStyle,
  tableStyle,
  useReportPicker,
} from "./cost-report-shared";
import { RUN_TONE, humanize, shortDate, toneOf } from "./cost-report-status";

interface RunRow {
  validationId: string;
  status: string;
  ruleSetVersion: number;
  passedCount: number;
  failedCount: number;
  warningCount: number;
  skippedCount: number;
  overriddenCount: number;
  runStartedAt: string;
  runCompletedAt: string | null;
}

export function CostReportValidation(): JSX.Element {
  const client = useApiClient();
  const {
    reports,
    selectedId,
    setSelectedId,
    loading: picking,
    error: pickErr,
  } = useReportPicker();
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!selectedId) return;
    setLoading(true);
    const res = await client.GET("/api/v1/cost-reports/{id}/validations", {
      params: { path: { id: selectedId } },
    });
    const d = res.error ? null : (res.data as unknown as { items?: RunRow[] });
    setRuns(d?.items ?? (res.error ? [] : (res.data as unknown as RunRow[])) ?? []);
    setLoading(false);
  }, [client, selectedId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (picking) return <LoadingSpinner />;
  if (pickErr)
    return <EmptyState title="Unavailable" description="Cost reports could not be loaded." />;
  if (!selectedId)
    return (
      <EmptyState title="No cost reports" description="Create a cost report to run validation." />
    );

  const latest = runs[0];

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Validation Worklist"
          breadcrumb="Revenue Cycle — pre-submission rule library (§11.B)"
          actions={
            <ReportPicker reports={reports} selectedId={selectedId} onChange={setSelectedId} />
          }
        />
      }
      kpis={
        <KpiStrip>
          <KpiCard label="Latest — passed" value={latest ? String(latest.passedCount) : "—"} />
          <KpiCard label="Latest — failed" value={latest ? String(latest.failedCount) : "—"} />
          <KpiCard label="Latest — skipped" value={latest ? String(latest.skippedCount) : "—"} />
        </KpiStrip>
      }
      table={
        loading ? (
          <LoadingSpinner />
        ) : runs.length === 0 ? (
          <EmptyState
            title="No validation runs"
            description="Run validation on this cost report to populate the worklist."
          />
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={headStyle}>Started</th>
                <th style={headStyle}>Status</th>
                <th style={{ ...headStyle, textAlign: "right" }}>Rule set</th>
                <th style={{ ...headStyle, textAlign: "right" }}>Passed</th>
                <th style={{ ...headStyle, textAlign: "right" }}>Failed</th>
                <th style={{ ...headStyle, textAlign: "right" }}>Warned</th>
                <th style={{ ...headStyle, textAlign: "right" }}>Skipped</th>
                <th style={{ ...headStyle, textAlign: "right" }}>Overridden</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.validationId} style={rowStyle}>
                  <td style={cellStyle}>{shortDate(r.runStartedAt)}</td>
                  <td style={cellStyle}>
                    <StatusPill tone={toneOf(RUN_TONE, r.status)} label={humanize(r.status)} />
                  </td>
                  <td style={numStyle}>v{r.ruleSetVersion}</td>
                  <td style={numStyle}>{r.passedCount}</td>
                  <td style={numStyle}>{r.failedCount}</td>
                  <td style={numStyle}>{r.warningCount}</td>
                  <td style={numStyle}>{r.skippedCount}</td>
                  <td style={numStyle}>{r.overriddenCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    />
  );
}
