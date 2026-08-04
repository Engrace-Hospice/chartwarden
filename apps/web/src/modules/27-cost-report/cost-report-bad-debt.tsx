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
// apps/web/src/modules/27-cost-report — the BAD-DEBT log (R2, §5 / D7). Pick a report → its Medicare
// bad-debt entries (deductible / coinsurance) with the CMS-allowability signal (collection efforts
// documented + supporting docs). Read-only; the server is the only authz point (ADR-0030).
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { humanize, money, shortDate } from "./cost-report-status";

interface BadDebtRow {
  recordId: string;
  periodLabel: string;
  debtKind: string;
  amountCents: number;
  collectionEffortsDocumented: boolean;
  supportingDocumentIds: string[];
  addedAt: string;
}

export function CostReportBadDebt(): JSX.Element {
  const client = useApiClient();
  const {
    reports,
    selectedId,
    setSelectedId,
    loading: picking,
    error: pickErr,
  } = useReportPicker();
  const [rows, setRows] = useState<BadDebtRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!selectedId) return;
    setLoading(true);
    const res = await client.GET("/api/v1/cost-reports/{id}/bad-debt", {
      params: { path: { id: selectedId } },
    });
    const d = res.error ? null : (res.data as unknown as { items?: BadDebtRow[] });
    setRows(d?.items ?? (res.error ? [] : (res.data as unknown as BadDebtRow[])) ?? []);
    setLoading(false);
  }, [client, selectedId]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalCents = useMemo(() => rows.reduce((s, r) => s + r.amountCents, 0), [rows]);
  const documented = rows.filter((r) => r.collectionEffortsDocumented).length;

  if (picking) return <LoadingSpinner />;
  if (pickErr)
    return <EmptyState title="Unavailable" description="Cost reports could not be loaded." />;
  if (!selectedId)
    return (
      <EmptyState title="No cost reports" description="Create a cost report to log bad debt." />
    );

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Bad-Debt Log"
          breadcrumb="Revenue Cycle — Medicare bad-debt reimbursement (D7)"
          actions={
            <ReportPicker reports={reports} selectedId={selectedId} onChange={setSelectedId} />
          }
        />
      }
      kpis={
        <KpiStrip>
          <KpiCard label="Entries" value={String(rows.length)} />
          <KpiCard label="Total claimed" value={money(totalCents)} />
          <KpiCard label="Efforts documented" value={`${documented} / ${rows.length}`} />
        </KpiStrip>
      }
      table={
        loading ? (
          <LoadingSpinner />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No bad-debt entries"
            description="No Medicare bad debt has been logged for this cost report."
          />
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={headStyle}>Period</th>
                <th style={headStyle}>Kind</th>
                <th style={{ ...headStyle, textAlign: "right" }}>Amount</th>
                <th style={headStyle}>Collection efforts</th>
                <th style={{ ...headStyle, textAlign: "right" }}>Supporting docs</th>
                <th style={headStyle}>Added</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.recordId} style={rowStyle}>
                  <td style={cellStyle}>{r.periodLabel}</td>
                  <td style={cellStyle}>{humanize(r.debtKind)}</td>
                  <td style={numStyle}>{money(r.amountCents)}</td>
                  <td style={cellStyle}>
                    <StatusPill
                      tone={r.collectionEffortsDocumented ? "success" : "warning"}
                      label={r.collectionEffortsDocumented ? "Documented" : "Missing"}
                    />
                  </td>
                  <td style={numStyle}>{r.supportingDocumentIds.length}</td>
                  <td style={cellStyle}>{shortDate(r.addedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    />
  );
}
