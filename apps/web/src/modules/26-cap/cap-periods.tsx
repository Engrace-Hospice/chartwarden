import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/26-cap — M26, CAP PERIOD MANAGEMENT (R2, §5.1.3). The current + historical cap periods
// with status badges (open/active/in_settlement/settled/reopened). Open/close/reopen/lock-methodology are
// server-authoritative mutations gated on cap.period.manage + step-up (D12); this read surface gates nav
// visibility only (ADR-0030). Lantern: WorkQueueLayout + No-Line table + §6.6 StatusPill; CSS-var tokens only.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { PERIOD_STATUS_TONE, humanize, money, shortDate, toneOf } from "./cap-status";

interface Period {
  id: string;
  capYear: string;
  ccn: string;
  startDate: string;
  endDate: string;
  status: string;
  methodology: string | null;
  graceWindowDays: number;
  aggregateCapAmountCents: number;
}

const cell = { padding: "0.55rem 0.75rem", textAlign: "left" as const };
const head = {
  ...cell,
  fontSize: "0.72rem",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "var(--color-on-surface-variant)",
  fontWeight: 600,
};
const row = { borderTop: "1px solid var(--color-surface-container)" };

export function CapPeriods(): JSX.Element {
  const client = useApiClient();
  const [periods, setPeriods] = useState<Period[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/cap/periods");
    if (res.error) {
      setError("Cap periods are unavailable — you may lack cap visibility.");
      setLoading(false);
      return;
    }
    setPeriods((res.data as unknown as Period[]) ?? []);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  return (
    <WorkQueueLayout
      header={<PageHeader title="Cap Periods" breadcrumb="Revenue Cycle — cap-year lifecycle" />}
      table={
        periods.length === 0 ? (
          <EmptyState
            title="No cap periods"
            description="Open a cap period for the current cap year to begin tracking."
          />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
            <thead>
              <tr>
                <th style={head}>Cap year</th>
                <th style={head}>Window</th>
                <th style={head}>Methodology</th>
                <th style={head}>Per-beneficiary cap</th>
                <th style={head}>Grace</th>
                <th style={head}>Status</th>
              </tr>
            </thead>
            <tbody>
              {periods.map((p) => (
                <tr key={p.id} style={row}>
                  <td style={{ ...cell, fontVariantNumeric: "tabular-nums" }}>{p.capYear}</td>
                  <td style={cell}>
                    {shortDate(p.startDate)} – {shortDate(p.endDate)}
                  </td>
                  <td style={cell}>{humanize(p.methodology)}</td>
                  <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {money(p.aggregateCapAmountCents)}
                  </td>
                  <td style={{ ...cell, textAlign: "right" }}>{p.graceWindowDays}d</td>
                  <td style={cell}>
                    <StatusPill
                      tone={toneOf(PERIOD_STATUS_TONE, p.status)}
                      label={humanize(p.status)}
                    />
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
