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
// apps/web/src/modules/27-cost-report — the COST REPORTS list (R2, §5.1). The primary surface for finance
// staff + compliance officers: every cost report by (ProviderEntity, fiscal year) with its lifecycle state
// and reopen count. Reads are org-scoped server-side (RLS); the server is the only authz point (ADR-0030).
// Lantern: WorkQueueLayout + KpiStrip + No-Line table + §6.6 StatusPill via cost-report-status.ts.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { cellStyle, headStyle, numStyle, rowStyle, tableStyle } from "./cost-report-shared";
import { STATE_TONE, humanize, shortDate, toneOf } from "./cost-report-status";

interface ReportRow {
  costReportId: string;
  providerEntityId: string;
  fiscalYearStartDate: string;
  fiscalYearEndDate: string;
  state: string;
  reopenCount: number;
  badDebtClaimed: boolean;
  wageSource: string;
}

export function CostReportList(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const res = await client.GET("/api/v1/cost-reports");
    if (res.error) {
      setError(true);
      setLoading(false);
      return;
    }
    const d = res.data as unknown as { items?: ReportRow[] };
    setRows(d.items ?? (res.data as unknown as ReportRow[]) ?? []);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error)
    return (
      <EmptyState
        title="Unavailable"
        description="Cost reports could not be loaded — you may lack cost-report visibility."
      />
    );

  const open = rows.filter((r) => !["accepted", "closed"].includes(r.state)).length;
  const submitted = rows.filter((r) => ["submitted", "accepted"].includes(r.state)).length;

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Cost Reports"
          breadcrumb="Revenue Cycle — CMS-1984-14 hospice cost reports"
        />
      }
      kpis={
        <KpiStrip>
          <KpiCard label="Total reports" value={String(rows.length)} />
          <KpiCard label="Open (pre-acceptance)" value={String(open)} />
          <KpiCard label="Submitted / accepted" value={String(submitted)} />
        </KpiStrip>
      }
      table={
        rows.length === 0 ? (
          <EmptyState
            title="No cost reports"
            description="Create a cost report for a ProviderEntity + fiscal year to begin."
          />
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={headStyle}>Fiscal year end</th>
                <th style={headStyle}>Provider entity</th>
                <th style={headStyle}>State</th>
                <th style={headStyle}>Wage source</th>
                <th style={headStyle}>Bad debt</th>
                <th style={{ ...headStyle, textAlign: "right" }}>Reopens</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.costReportId} style={rowStyle}>
                  <td style={{ ...cellStyle, fontVariantNumeric: "tabular-nums" }}>
                    {shortDate(r.fiscalYearEndDate)}
                  </td>
                  <td style={{ ...cellStyle, fontVariantNumeric: "tabular-nums" }}>
                    {r.providerEntityId.slice(0, 8)}
                  </td>
                  <td style={cellStyle}>
                    <StatusPill tone={toneOf(STATE_TONE, r.state)} label={humanize(r.state)} />
                  </td>
                  <td style={cellStyle}>{humanize(r.wageSource)}</td>
                  <td style={cellStyle}>{r.badDebtClaimed ? "Claimed" : "—"}</td>
                  <td style={numStyle}>{r.reopenCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    />
  );
}
