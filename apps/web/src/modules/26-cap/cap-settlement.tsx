import { EmptyState, LoadingSpinner, PageHeader, StatusPill, WorkQueueLayout, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/26-cap — M26, the SETTLEMENT WORKSHEET (R2, §5.1.6). The final cap calculation for the
// period in settlement: final paid, final cap, overage/underage, and the owed direction. Resolves the period
// currently in_settlement (or the latest), then reads its worksheet. Propose/finalize are server-authoritative
// mutations gated on cap.settlement.manage + step-up (D12); this read surface gates nav visibility only.
// Lantern: WorkQueueLayout + summary rows + §6.6 StatusPill; CSS-var tokens only.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { SETTLEMENT_STATUS_TONE, humanize, money, shortDate, toneOf } from "./cap-status";

interface Period { id: string; capYear: string; status: string }
interface Settlement {
  status: string;
  paidTotalCents: number;
  beneficiaryCount: number;
  aggregateCapAmountCents: number;
  aggregateOverageCents: number;
  inpatientTotalDays: number;
  inpatientOverageDays: number;
  inpatientOverageCents: number;
  finalizedAt: string | null;
}

const directionOf = (overage: number): string =>
  overage > 0 ? "Overpayment owed to CMS" : overage < 0 ? "Underpayment owed to provider" : "Balanced";
const directionTone = (overage: number): "error" | "warning" | "success" =>
  overage > 0 ? "error" : overage < 0 ? "warning" : "success";

const rowStyle = { display: "flex", justifyContent: "space-between", padding: "0.6rem 0", borderTop: "1px solid var(--color-surface-container)" };
const labelStyle = { color: "var(--color-on-surface-variant)", fontSize: "0.85rem" };
const valStyle = { fontVariantNumeric: "tabular-nums" as const, fontWeight: 600 };

export function CapSettlement(): JSX.Element {
  const client = useApiClient();
  const [period, setPeriod] = useState<Period | null>(null);
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const periodsRes = await client.GET("/api/v1/cap/periods");
    if (periodsRes.error) {
      setError("Cap settlement is unavailable — you may lack cap visibility.");
      setLoading(false);
      return;
    }
    const periods = (periodsRes.data as unknown as Period[]) ?? [];
    const target = periods.find((p) => p.status === "in_settlement") ?? periods.find((p) => p.status === "settled") ?? periods[0] ?? null;
    setPeriod(target);
    if (target) {
      const sRes = await client.GET("/api/v1/cap/settlements/{periodId}", { params: { path: { periodId: target.id } } } as never);
      setSettlement(sRes.error ? null : (sRes.data as unknown as Settlement | null));
    }
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (!period) return <EmptyState title="No cap period" description="No cap period exists yet." />;

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Settlement Worksheet"
          breadcrumb={`Revenue Cycle — ${period.capYear}`}
          actions={settlement ? <StatusPill tone={toneOf(SETTLEMENT_STATUS_TONE, settlement.status)} label={humanize(settlement.status)} /> : undefined}
        />
      }
      table={
      !settlement ? (
        <EmptyState
          title="No settlement proposed"
          description={period.status === "in_settlement" ? "Propose a settlement worksheet to compute the final cap calculation." : "Close the cap year to begin the settlement workflow."}
        />
      ) : (
        <div style={{ maxWidth: "32rem" }}>
          <div style={rowStyle}><span style={labelStyle}>Beneficiary count</span><span style={valStyle}>{settlement.beneficiaryCount}</span></div>
          <div style={rowStyle}><span style={labelStyle}>Total paid</span><span style={valStyle}>{money(settlement.paidTotalCents)}</span></div>
          <div style={rowStyle}><span style={labelStyle}>Aggregate cap</span><span style={valStyle}>{money(settlement.aggregateCapAmountCents)}</span></div>
          <div style={rowStyle}>
            <span style={labelStyle}>Aggregate variance</span>
            <span><StatusPill tone={directionTone(settlement.aggregateOverageCents)} label={`${money(Math.abs(settlement.aggregateOverageCents))} · ${directionOf(settlement.aggregateOverageCents)}`} /></span>
          </div>
          <div style={rowStyle}><span style={labelStyle}>Inpatient days (total / overage)</span><span style={valStyle}>{settlement.inpatientTotalDays} / {settlement.inpatientOverageDays}</span></div>
          <div style={rowStyle}><span style={labelStyle}>Inpatient overage (recoupment)</span><span style={valStyle}>{money(settlement.inpatientOverageCents)}</span></div>
          <div style={rowStyle}><span style={labelStyle}>Finalized</span><span style={valStyle}>{shortDate(settlement.finalizedAt)}</span></div>
        </div>
      )
      }
    />
  );
}
