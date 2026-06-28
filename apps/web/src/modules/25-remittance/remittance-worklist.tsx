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
// apps/web/src/modules/25-remittance — M25, the REMITTANCE WORKLIST (R2, §5). The 835 envelope surface: the
// posted/queued/failed advices and the manual-match backlog of unmatched lines. Reads are org-scoped
// server-side (RLS); the server is the only authz point (ADR-0030) — this gates nav visibility only. Lantern:
// WorkQueueLayout + KpiStrip + No-Line table + §6.6 StatusPill via remittance-status.ts; CSS-var tokens only.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { MATCH_STATE_TONE, PARSE_STATUS_TONE, humanize, money, toneOf } from "./remittance-status";

interface AdviceRow {
  id: string;
  payerKind: string;
  paymentMethod: string;
  totalPaymentAmount: string;
  parseStatus: string;
  receivedAt: string;
}
interface LineRow {
  id: string;
  claimId: string | null;
  clp03TotalChargeAmount: string;
  clp04TotalPaymentAmount: string;
  matchState: string;
  receivedAt: string;
}
interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

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

export function RemittanceWorklist(): JSX.Element {
  const client = useApiClient();
  const [advices, setAdvices] = useState<AdviceRow[]>([]);
  const [unmatched, setUnmatched] = useState<LineRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [adviceRes, unmatchedRes] = await Promise.all([
      client.GET("/api/v1/remittance/advices"),
      client.GET("/api/v1/remittance/unmatched"),
    ]);
    if (adviceRes.error) {
      setError("Remittance worklist unavailable — you may lack provider scope, or the read seam is unbound.");
      setLoading(false);
      return;
    }
    setAdvices(((adviceRes.data as unknown as Page<AdviceRow>)?.items ?? []) as AdviceRow[]);
    setUnmatched(
      unmatchedRes.error ? [] : (((unmatchedRes.data as unknown as Page<LineRow>)?.items ?? []) as LineRow[]),
    );
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  const failed = advices.filter((a) => a.parseStatus === "failed").length;

  return (
    <WorkQueueLayout
      header={<PageHeader title="Remittance" breadcrumb="Revenue Cycle — 835 / ERA" />}
      kpis={
        <KpiStrip>
          <KpiCard label="835 advices" value={advices.length} />
          <KpiCard label="Unmatched lines" value={unmatched.length} />
          <KpiCard label="Failed parses" value={failed} />
        </KpiStrip>
      }
      table={
        <div style={{ display: "flex", flexDirection: "column", gap: "1.75rem" }}>
          <section>
            <h2 style={sectionTitle}>835 envelopes</h2>
            {advices.length === 0 ? (
              <EmptyState title="No remittances" description="No 835 advices have been received yet." />
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={headStyle}>Received</th>
                    <th style={headStyle}>Payer</th>
                    <th style={headStyle}>Method</th>
                    <th style={headStyle}>Paid</th>
                    <th style={headStyle}>Parse</th>
                  </tr>
                </thead>
                <tbody>
                  {advices.map((a) => (
                    <tr key={a.id} style={rowStyle}>
                      <td style={cellStyle}>{new Date(a.receivedAt).toLocaleDateString()}</td>
                      <td style={cellStyle}>{humanize(a.payerKind)}</td>
                      <td style={cellStyle}>{humanize(a.paymentMethod)}</td>
                      <td style={{ ...cellStyle }} className="tabular-nums">
                        {money(a.totalPaymentAmount)}
                      </td>
                      <td style={cellStyle}>
                        <StatusPill label={humanize(a.parseStatus)} tone={toneOf(PARSE_STATUS_TONE, a.parseStatus)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section>
            <h2 style={sectionTitle}>Manual-match backlog</h2>
            {unmatched.length === 0 ? (
              <EmptyState title="Nothing to match" description="Every posted line is matched to a claim." />
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={headStyle}>Received</th>
                    <th style={headStyle}>Charge</th>
                    <th style={headStyle}>Paid</th>
                    <th style={headStyle}>State</th>
                  </tr>
                </thead>
                <tbody>
                  {unmatched.map((l) => (
                    <tr key={l.id} style={rowStyle}>
                      <td style={cellStyle}>{new Date(l.receivedAt).toLocaleDateString()}</td>
                      <td style={cellStyle} className="tabular-nums">
                        {money(l.clp03TotalChargeAmount)}
                      </td>
                      <td style={cellStyle} className="tabular-nums">
                        {money(l.clp04TotalPaymentAmount)}
                      </td>
                      <td style={cellStyle}>
                        <StatusPill label={humanize(l.matchState)} tone={toneOf(MATCH_STATE_TONE, l.matchState)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      }
    />
  );
}

const sectionTitle = {
  margin: "0 0 0.5rem",
  fontFamily: "var(--font-display)",
  fontSize: "1rem",
  fontWeight: 500,
  color: "var(--color-on-surface)",
};
