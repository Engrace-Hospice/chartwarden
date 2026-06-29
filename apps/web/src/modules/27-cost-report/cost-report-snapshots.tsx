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
// apps/web/src/modules/27-cost-report — the SNAPSHOTS & ECR surface (R2, §5 / D10). Pick a report → its
// content-hashed submit/reopen snapshot chain (the lockdown that survives reopens). Read-only; the server
// is the only authz point (ADR-0030). The snapshot detail read is itself audit-logged at the route.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { humanize, shortDate, toneOf } from "./cost-report-status";
import { ReportPicker, cellStyle, headStyle, rowStyle, tableStyle, useReportPicker } from "./cost-report-shared";
import type { StatusTone } from "@wardenx/ui";

interface SnapshotRow {
  snapshotId: string;
  priorSnapshotId: string | null;
  contentHashSha256: string;
  reason: string;
  createdAt: string;
}

const REASON_TONE: Record<string, StatusTone> = {
  submit: "progress",
  reopen: "warning",
  mac_revision_request: "warning",
  admin_audit: "neutral",
};

export function CostReportSnapshots(): JSX.Element {
  const client = useApiClient();
  const { reports, selectedId, setSelectedId, loading: picking, error: pickErr } = useReportPicker();
  const [rows, setRows] = useState<SnapshotRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!selectedId) return;
    setLoading(true);
    const res = await client.GET("/api/v1/cost-reports/{id}/snapshots", { params: { path: { id: selectedId } } });
    const d = res.error ? null : (res.data as unknown as { items?: SnapshotRow[] });
    setRows(d?.items ?? (res.error ? [] : (res.data as unknown as SnapshotRow[])) ?? []);
    setLoading(false);
  }, [client, selectedId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (picking) return <LoadingSpinner />;
  if (pickErr) return <EmptyState title="Unavailable" description="Cost reports could not be loaded." />;
  if (!selectedId) return <EmptyState title="No cost reports" description="Create + submit a cost report to build a snapshot." />;

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Snapshots & ECR"
          breadcrumb="Revenue Cycle — content-hashed submit-lockdown (D10)"
          actions={<ReportPicker reports={reports} selectedId={selectedId} onChange={setSelectedId} />}
        />
      }
      kpis={
        <KpiStrip>
          <KpiCard label="Snapshots" value={String(rows.length)} />
          <KpiCard label="Reopens" value={String(rows.filter((r) => r.reason === "reopen").length)} />
          <KpiCard label="Latest reason" value={rows[0] ? humanize(rows[0].reason) : "—"} />
        </KpiStrip>
      }
      table={
        loading ? (
          <LoadingSpinner />
        ) : rows.length === 0 ? (
          <EmptyState title="No snapshots" description="A content-hashed snapshot is built on submit (and on each reopen)." />
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={headStyle}>Created</th>
                <th style={headStyle}>Reason</th>
                <th style={headStyle}>Content hash</th>
                <th style={headStyle}>Prior</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.snapshotId} style={rowStyle}>
                  <td style={cellStyle}>{shortDate(r.createdAt)}</td>
                  <td style={cellStyle}>
                    <StatusPill tone={toneOf(REASON_TONE, r.reason)} label={humanize(r.reason)} />
                  </td>
                  <td style={{ ...cellStyle, fontVariantNumeric: "tabular-nums" }}>{r.contentHashSha256.slice(0, 12)}…</td>
                  <td style={cellStyle}>{r.priorSnapshotId ? `${r.priorSnapshotId.slice(0, 8)}…` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    />
  );
}
