import {
  CountdownChip,
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/25-remittance — M25, the APPEAL TRACKER (R2, §5 / §1.1). The five-tier Medicare
// appeal hierarchy with its per-tier filing deadline — the §6.6 CountdownChip is the anchor (the most
// expensive billing mistake is a missed 60-day window). Reads org-scoped server-side (RLS); the hard T-0
// submit block is the `appeal_within_deadline` ABAC predicate on the server, surfaced here as the chip tone.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { APPEAL_OUTCOME_TONE, APPEAL_STATE_TONE, humanize, toneOf } from "./remittance-status";

interface AppealRow {
  id: string;
  tier: string;
  state: string;
  decisionOutcome: string | null;
  tierDeadlineAt: string;
}
interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const TIER_LABEL: Record<string, string> = {
  redetermination: "Redetermination",
  reconsideration: "Reconsideration (QIC)",
  alj: "ALJ Hearing",
  council: "Appeals Council",
  federal_court: "Federal Court",
};

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

const isOpen = (s: string): boolean => s === "draft" || s === "submitted" || s === "under_review";

export function AppealTracker(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<AppealRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/appeals");
    if (res.error) {
      setError("Appeal tracker unavailable — you may lack provider scope.");
      setLoading(false);
      return;
    }
    setRows(((res.data as unknown as Page<AppealRow>)?.items ?? []) as AppealRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  const open = rows.filter((r) => isOpen(r.state));
  const dueSoon = open.filter(
    (r) => new Date(r.tierDeadlineAt).getTime() - Date.now() < 7 * 86_400_000,
  ).length;

  return (
    <WorkQueueLayout
      header={<PageHeader title="Appeals" breadcrumb="Revenue Cycle — Appeals" />}
      kpis={
        <KpiStrip>
          <KpiCard label="Total appeals" value={rows.length} />
          <KpiCard label="In flight" value={open.length} />
          <KpiCard label="Deadline ≤ 7 days" value={dueSoon} />
          <KpiCard label="Favorable" value={rows.filter((r) => r.decisionOutcome === "favorable").length} />
        </KpiStrip>
      }
      table={
        rows.length === 0 ? (
          <EmptyState title="No appeals" description="No appeal cases have been opened." />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={headStyle}>Tier</th>
                <th style={headStyle}>State</th>
                <th style={headStyle}>Outcome</th>
                <th style={headStyle}>Filing deadline</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={rowStyle}>
                  <td style={cellStyle}>{TIER_LABEL[r.tier] ?? humanize(r.tier)}</td>
                  <td style={cellStyle}>
                    <StatusPill label={humanize(r.state)} tone={toneOf(APPEAL_STATE_TONE, r.state)} />
                  </td>
                  <td style={cellStyle}>
                    {r.decisionOutcome ? (
                      <StatusPill
                        label={humanize(r.decisionOutcome)}
                        tone={toneOf(APPEAL_OUTCOME_TONE, r.decisionOutcome)}
                      />
                    ) : (
                      <span style={{ color: "var(--color-on-surface-variant)" }}>—</span>
                    )}
                  </td>
                  <td style={cellStyle}>
                    {isOpen(r.state) ? (
                      <CountdownChip dueAt={r.tierDeadlineAt} label="files" warnWithinHours={14 * 24} alertWithinHours={3 * 24} />
                    ) : (
                      <span style={{ color: "var(--color-on-surface-variant)" }}>
                        {new Date(r.tierDeadlineAt).toLocaleDateString()}
                      </span>
                    )}
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
