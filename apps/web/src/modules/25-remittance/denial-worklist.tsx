import {
  EmptyState,
  FilterBar,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/25-remittance — M25, the DENIAL WORKLIST (R2, §5 / §1.1). The operational heart: the
// CARC/RARC denial cases with their plain-language action, assignee, aging bucket, and dollar value. Reads
// are org-scoped + provider-scoped server-side (RLS + provider_entity_scope); the server is the only authz
// point (ADR-0030). Lantern: WorkQueueLayout + FilterBar + No-Line table + §6.6 aging/category/state pills.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import {
  AGING_BUCKET_TONE,
  DENIAL_CATEGORY_TONE,
  DENIAL_STATE_TONE,
  humanize,
  money,
  toneOf,
} from "./remittance-status";

interface DenialRow {
  id: string;
  carcCode: string;
  rarcCode: string | null;
  category: string;
  source: string;
  state: string;
  assigneeMembershipId: string | null;
  agingBucketLabel: string;
  dollarValue: string;
  taxonomyStatus: string;
}
interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const STATE_FILTERS = ["all", "open", "in_progress", "escalated", "appealed", "resolved", "closed"];

const cellStyle = { padding: "0.55rem 0.75rem", textAlign: "left" as const, verticalAlign: "middle" as const };
const headStyle = {
  ...cellStyle,
  fontSize: "0.72rem",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "var(--color-on-surface-variant)",
  fontWeight: 600,
};
const rowStyle = { borderTop: "1px solid var(--color-surface-container)" };

export function DenialWorklist(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<DenialRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/denials");
    if (res.error) {
      setError("Denial worklist unavailable — you may lack provider scope.");
      setLoading(false);
      return;
    }
    setRows(((res.data as unknown as Page<DenialRow>)?.items ?? []) as DenialRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(
    () => (stateFilter === "all" ? rows : rows.filter((r) => r.state === stateFilter)),
    [rows, stateFilter],
  );
  const openValue = useMemo(
    () =>
      rows
        .filter((r) => r.state === "open" || r.state === "in_progress" || r.state === "escalated")
        .reduce((n, r) => n + Number(r.dollarValue), 0),
    [rows],
  );

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  return (
    <WorkQueueLayout
      header={<PageHeader title="Denials" breadcrumb="Revenue Cycle — Worklist" />}
      kpis={
        <KpiStrip>
          <KpiCard label="Total cases" value={rows.length} />
          <KpiCard label="Open (incl. escalated)" value={rows.filter((r) => r.state !== "resolved" && r.state !== "closed").length} />
          <KpiCard label="Open $ at risk" value={money(openValue)} />
          <KpiCard label="91+ days" value={rows.filter((r) => r.agingBucketLabel === "91+").length} />
        </KpiStrip>
      }
      filters={
        <FilterBar>
          <select
            aria-label="Filter by state"
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value)}
            style={selectStyle}
          >
            {STATE_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s === "all" ? "All states" : humanize(s)}
              </option>
            ))}
          </select>
        </FilterBar>
      }
      table={
        visible.length === 0 ? (
          <EmptyState title="No denials" description="No denial cases match this filter." />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={headStyle}>CARC / RARC</th>
                <th style={headStyle}>Category</th>
                <th style={headStyle}>Source</th>
                <th style={headStyle}>Aging</th>
                <th style={headStyle}>Value</th>
                <th style={headStyle}>State</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id} style={rowStyle}>
                  <td style={cellStyle} className="tabular-nums">
                    {r.carcCode}
                    {r.rarcCode ? ` / ${r.rarcCode}` : ""}
                  </td>
                  <td style={cellStyle}>
                    <StatusPill label={humanize(r.category)} tone={toneOf(DENIAL_CATEGORY_TONE, r.category)} />
                  </td>
                  <td style={cellStyle}>{humanize(r.source)}</td>
                  <td style={cellStyle}>
                    <StatusPill label={r.agingBucketLabel} tone={toneOf(AGING_BUCKET_TONE, r.agingBucketLabel)} />
                  </td>
                  <td style={cellStyle} className="tabular-nums">
                    {money(r.dollarValue)}
                  </td>
                  <td style={cellStyle}>
                    <StatusPill label={humanize(r.state)} tone={toneOf(DENIAL_STATE_TONE, r.state)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    />
  );
}

const selectStyle = {
  padding: "0.4rem 0.6rem",
  borderRadius: "var(--radius-md, 0.5rem)",
  border: "1px solid var(--color-surface-container-high)",
  background: "var(--color-surface-lowest)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
};
