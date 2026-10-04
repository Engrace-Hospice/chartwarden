import {
  Button,
  EmptyState,
  Glyph,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/26-cap — M26, the SETTLEMENT WORKSHEET (R2, §5.1.6). The final cap calculation for the
// period in settlement: final paid, final cap, overage/underage, and the owed direction. Resolves the period
// currently in_settlement (or the latest), then reads its worksheet. Propose/finalize are server-authoritative
// mutations gated on cap.settlement.manage + step-up (D12); this read surface gates nav visibility only.
// Lantern: WorkQueueLayout + summary rows + §6.6 StatusPill; CSS-var tokens only.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import {
  PERIOD_STATUS_TONE,
  SETTLEMENT_STATUS_TONE,
  humanize,
  money,
  shortDate,
  toneOf,
} from "./cap-status";

interface Period {
  id: string;
  capYear: string;
  status: string;
}
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

interface SettlementLine {
  label: string;
  value: JSX.Element | string;
}

const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;
const directionOf = (overage: number): string =>
  overage > 0
    ? "Overpayment owed to CMS"
    : overage < 0
      ? "Underpayment owed to provider"
      : "Balanced";
const directionTone = (overage: number): "error" | "warning" | "success" =>
  overage > 0 ? "error" : overage < 0 ? "warning" : "success";

export function CapSettlement(): JSX.Element {
  const client = useApiClient();
  const [periods, setPeriods] = useState<Period[]>([]);
  const [periodId, setPeriodId] = useState("");
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [linePage, setLinePage] = useState(1);
  const [linePageSize, setLinePageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [settlementLoading, setSettlementLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSettlement = useCallback(
    async (targetPeriodId: string) => {
      if (!targetPeriodId) {
        setSettlement(null);
        return;
      }
      setSettlementLoading(true);
      const sRes = await client.GET("/api/v1/cap/settlements/{periodId}", {
        params: { path: { periodId: targetPeriodId } },
      } as never);
      setSettlement(sRes.error ? null : (sRes.data as unknown as Settlement | null));
      setSettlementLoading(false);
    },
    [client],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const periodsRes = await client.GET("/api/v1/cap/periods");
    if (periodsRes.error) {
      setError("Cap settlement is unavailable — you may lack cap visibility.");
      setLoading(false);
      return;
    }
    const nextPeriods = (periodsRes.data as unknown as Period[]) ?? [];
    setPeriods(nextPeriods);
    const target =
      nextPeriods.find((p) => p.status === "in_settlement") ??
      nextPeriods.find((p) => p.status === "settled") ??
      nextPeriods[0] ??
      null;
    setPeriodId(target?.id ?? "");
    if (target) await loadSettlement(target.id);
    else setSettlement(null);
    setLoading(false);
  }, [client, loadSettlement]);

  useEffect(() => {
    void load();
  }, [load]);

  const period = periods.find((p) => p.id === periodId) ?? null;
  const periodOptions = useMemo(
    () =>
      periods.map((p) => ({
        value: p.id,
        label: `${p.capYear} · ${humanize(p.status)}`,
      })),
    [periods],
  );
  const settlementLines = useMemo<SettlementLine[]>(() => {
    if (!settlement) return [];
    return [
      { label: "Beneficiary count", value: settlement.beneficiaryCount.toLocaleString() },
      { label: "Total paid", value: money(settlement.paidTotalCents) },
      { label: "Aggregate cap", value: money(settlement.aggregateCapAmountCents) },
      {
        label: "Aggregate variance",
        value: (
          <StatusPill
            tone={directionTone(settlement.aggregateOverageCents)}
            label={`${money(Math.abs(settlement.aggregateOverageCents))} · ${directionOf(settlement.aggregateOverageCents)}`}
          />
        ),
      },
      {
        label: "Inpatient days",
        value: `${settlement.inpatientTotalDays.toLocaleString()} total / ${settlement.inpatientOverageDays.toLocaleString()} overage`,
      },
      { label: "Inpatient overage", value: money(settlement.inpatientOverageCents) },
      { label: "Finalized", value: shortDate(settlement.finalizedAt) },
    ];
  }, [settlement]);
  const linePageCount = Math.max(1, Math.ceil(settlementLines.length / linePageSize));
  const activeLinePage = Math.min(linePage, linePageCount);
  const pagedLines = settlementLines.slice(
    (activeLinePage - 1) * linePageSize,
    activeLinePage * linePageSize,
  );

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Settlement Worksheet"
          breadcrumb={
            period ? `Revenue Cycle — ${period.capYear}` : "Revenue Cycle — Cap settlement"
          }
          actions={
            settlement ? (
              <StatusPill
                tone={toneOf(SETTLEMENT_STATUS_TONE, settlement.status)}
                label={humanize(settlement.status)}
              />
            ) : period ? (
              <StatusPill
                tone={toneOf(PERIOD_STATUS_TONE, period.status)}
                label={humanize(period.status)}
              />
            ) : null
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review final paid totals, aggregate cap variance, inpatient overage, and finalization
            state.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Period"
            value={loading || error || !period ? "—" : period.capYear}
            detail={period ? humanize(period.status) : "No period"}
            tone={period ? "info" : "neutral"}
            accentColor={period ? "var(--color-primary)" : "var(--color-outline-variant)"}
          />
          <KpiCard
            label="Paid Total"
            value={loading || error || !settlement ? "—" : money(settlement.paidTotalCents)}
            detail="Final worksheet"
            tone="neutral"
            accentColor="var(--color-outline-variant)"
          />
          <KpiCard
            label="Beneficiaries"
            value={
              loading || error || !settlement ? "—" : settlement.beneficiaryCount.toLocaleString()
            }
            detail="Settlement count"
            tone="neutral"
            accentColor="var(--color-outline-variant)"
          />
          <KpiCard
            label="Aggregate Variance"
            value={
              loading || error || !settlement
                ? "—"
                : money(Math.abs(settlement.aggregateOverageCents))
            }
            detail={settlement ? directionOf(settlement.aggregateOverageCents) : "No worksheet"}
            tone={
              settlement
                ? settlement.aggregateOverageCents > 0
                  ? "danger"
                  : settlement.aggregateOverageCents < 0
                    ? "warning"
                    : "success"
                : "neutral"
            }
            accentColor={
              settlement?.aggregateOverageCents
                ? settlement.aggregateOverageCents > 0
                  ? "var(--color-error)"
                  : "var(--color-warning)"
                : "var(--color-success)"
            }
          />
          <KpiCard
            label="IP Overage"
            value={loading || error || !settlement ? "—" : money(settlement.inpatientOverageCents)}
            detail={`${settlement?.inpatientOverageDays ?? 0} overage days`}
            tone={settlement && settlement.inpatientOverageCents > 0 ? "warning" : "neutral"}
            accentColor={
              settlement && settlement.inpatientOverageCents > 0
                ? "var(--color-warning)"
                : "var(--color-outline-variant)"
            }
          />
        </KpiStrip>
      }
      filters={
        <div style={filterPanelStyle}>
          {error ? (
            <div role="alert" style={errorBannerStyle}>
              <Glyph name="alert" size={16} />
              <span>{error}</span>
            </div>
          ) : null}
          <div style={filterRowStyle}>
            <label style={filterLabelStyle}>
              <span style={mutedStyle}>Cap period</span>
              <select
                aria-label="Cap period"
                value={periodId}
                onChange={(e) => {
                  const next = e.target.value;
                  setPeriodId(next);
                  setLinePage(1);
                  void loadSettlement(next);
                }}
                style={selectStyle}
                disabled={loading || periods.length === 0}
              >
                {periodOptions.length === 0 ? (
                  <option value="">No periods</option>
                ) : (
                  periodOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))
                )}
              </select>
            </label>
            {settlementLoading ? <span style={mutedStyle}>Loading worksheet...</span> : null}
          </div>
        </div>
      }
      table={
        loading ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : error ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={error} />
          </div>
        ) : !period ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="No cap period" description="No cap period exists yet." />
          </div>
        ) : !settlement ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No settlement proposed"
              description={
                period.status === "in_settlement"
                  ? "Propose a settlement worksheet to compute the final cap calculation."
                  : "Close the cap year to begin the settlement workflow."
              }
            />
          </div>
        ) : (
          <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem" }}>
            <table style={tableStyle}>
              <thead>
                <tr style={headerRowStyle}>
                  <th style={headStyle}>Metric</th>
                  <th style={headStyle}>Value</th>
                </tr>
              </thead>
              <tbody>
                {pagedLines.map((line) => (
                  <tr key={line.label} style={rowStyle}>
                    <td style={cellStyle}>{line.label}</td>
                    <td style={valueStyle}>{line.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <OffsetPagination
              page={activeLinePage}
              pageSize={linePageSize}
              totalItems={settlementLines.length}
              onPageChange={setLinePage}
              onPageSizeChange={(next) => {
                setLinePageSize(next);
                setLinePage(1);
              }}
              pageSizeOptions={PAGE_SIZES}
              noun="worksheet rows"
            />
          </div>
        )
      }
      detail={
        <span style={mutedStyle}>
          Settlement mutations remain server-authoritative and step-up gated. This surface is the
          read worksheet for final review.
        </span>
      }
      fullPageScroll
    />
  );
}

const tableStyle = { width: "100%", borderCollapse: "collapse" as const, fontSize: "0.875rem" };
const cellStyle = {
  padding: "0.55rem 0.75rem",
  textAlign: "left" as const,
  verticalAlign: "middle" as const,
  color: "var(--color-on-surface)",
};
const valueStyle = {
  ...cellStyle,
  fontVariantNumeric: "tabular-nums" as const,
  fontWeight: 600,
};
const headStyle = {
  ...cellStyle,
  fontSize: "0.72rem",
  color: "var(--color-on-surface-variant)",
  fontWeight: 600,
};
const rowStyle = { borderTop: "1px solid var(--color-surface-container)" };
const headerRowStyle = {
  textAlign: "left" as const,
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};
const filterPanelStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};
const filterRowStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
  gap: "0.75rem",
  alignItems: "flex-end",
};
const filterLabelStyle = { display: "flex", flexDirection: "column" as const, gap: "0.25rem" };
const selectStyle = {
  height: "2.25rem",
  fontSize: "0.85rem",
  cursor: "pointer",
};
const mutedStyle = { fontSize: "0.8rem", color: "var(--color-on-surface-variant)" };
const errorBannerStyle = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  color: "var(--color-error)",
  fontSize: "0.85rem",
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
};
