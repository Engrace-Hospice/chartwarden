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
} from "@chartwarden/ui";
// apps/web/src/modules/26-cap — M26, CAP PERIOD MANAGEMENT (R2, §5.1.3). The current + historical cap periods
// with status badges (open/active/in_settlement/settled/reopened). GAP-079 wires close (open/active/reopened) and
// reopen (settled; step-up + a recorded reason) here; the server stays authoritative for cap.period.manage, the
// cap_period_* predicates and step-up (D12). Lantern: WorkQueueLayout + No-Line table + §6.6 StatusPill; CSS-var tokens only.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { CapActionDialog, sendCapMutation } from "./cap-actions";
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

const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function CapPeriods(): JSX.Element {
  const client = useApiClient();
  const [periods, setPeriods] = useState<Period[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<{ kind: "close" | "reopen"; period: Period } | null>(null);

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

  const statusOptions = useMemo(
    () => [
      { value: "", label: "Any status" },
      ...Array.from(new Set(periods.map((p) => p.status)))
        .sort()
        .map((value) => ({ value, label: humanize(value) })),
    ],
    [periods],
  );
  const filteredPeriods = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return periods
      .filter((p) => {
        const matchesStatus = !statusFilter || p.status === statusFilter;
        const matchesSearch =
          !q ||
          [
            p.id,
            p.capYear,
            p.ccn,
            p.status,
            p.methodology ?? "",
            p.startDate,
            p.endDate,
            String(p.aggregateCapAmountCents),
          ].some((value) => value.toLowerCase().includes(q));
        return matchesStatus && matchesSearch;
      })
      .sort((a, b) => b.capYear.localeCompare(a.capYear));
  }, [periods, searchQuery, statusFilter]);

  const activeCount = periods.filter((p) => p.status === "open" || p.status === "active").length;
  const settlementCount = periods.filter((p) => p.status === "in_settlement").length;
  const settledCount = periods.filter((p) => p.status === "settled").length;
  const reopenedCount = periods.filter((p) => p.status === "reopened").length;
  const pageCount = Math.max(1, Math.ceil(filteredPeriods.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedPeriods = filteredPeriods.slice((activePage - 1) * pageSize, activePage * pageSize);
  const hasActiveFilters = searchQuery !== "" || statusFilter !== "";

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader title="Cap Periods" breadcrumb="Revenue Cycle — cap-year lifecycle">
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Review current and historical cap periods, methodology state, grace windows, and caps.
            </div>
          </PageHeader>
        }
        kpis={
          <KpiStrip>
            <KpiCard
              label="Periods"
              value={loading || error ? "—" : periods.length}
              detail="Total records"
              tone="info"
              accentColor="var(--color-primary)"
            />
            <KpiCard
              label="Open/Active"
              value={loading || error ? "—" : activeCount}
              detail="Current lifecycle"
              tone={activeCount > 0 ? "success" : "neutral"}
              accentColor={
                activeCount > 0 ? "var(--color-success)" : "var(--color-outline-variant)"
              }
            />
            <KpiCard
              label="In Settlement"
              value={loading || error ? "—" : settlementCount}
              detail="Needs closeout"
              tone={settlementCount > 0 ? "warning" : "neutral"}
              accentColor={
                settlementCount > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"
              }
              selected={statusFilter === "in_settlement"}
              onSelect={() => {
                setStatusFilter("in_settlement");
                setPage(1);
              }}
            />
            <KpiCard
              label="Settled"
              value={loading || error ? "—" : settledCount}
              detail="Terminal periods"
              tone="neutral"
              accentColor="var(--color-outline-variant)"
            />
            <KpiCard
              label="Reopened"
              value={loading || error ? "—" : reopenedCount}
              detail="Audit-heavy"
              tone={reopenedCount > 0 ? "warning" : "neutral"}
              accentColor={
                reopenedCount > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"
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
              <label className="wx-search-field">
                <Glyph name="search" size={16} />
                <input
                  type="search"
                  placeholder="Search year, CCN, methodology..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setPage(1);
                  }}
                  aria-label="Search cap periods"
                />
              </label>
              <label style={filterLabelStyle}>
                <span style={mutedStyle}>Status</span>
                <select
                  aria-label="Filter by status"
                  value={statusFilter}
                  onChange={(e) => {
                    setStatusFilter(e.target.value);
                    setPage(1);
                  }}
                  style={selectStyle}
                >
                  {statusOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              {hasActiveFilters ? (
                <Button
                  size="sm"
                  tone="tertiary"
                  onClick={() => {
                    setSearchQuery("");
                    setStatusFilter("");
                    setPage(1);
                  }}
                >
                  Clear
                </Button>
              ) : null}
              <span style={mutedStyle}>
                {filteredPeriods.length} of {periods.length} periods
              </span>
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
          ) : filteredPeriods.length === 0 ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState
                title="No cap periods"
                description={
                  hasActiveFilters
                    ? "No cap period matches these filters."
                    : "Open a cap period for the current cap year to begin tracking."
                }
                action={
                  hasActiveFilters ? (
                    <Button
                      tone="secondary"
                      size="sm"
                      onClick={() => {
                        setSearchQuery("");
                        setStatusFilter("");
                        setPage(1);
                      }}
                    >
                      Clear filters
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem" }}>
              <table style={tableStyle}>
                <thead>
                  <tr style={headerRowStyle}>
                    <th style={headStyle}>Cap year</th>
                    <th style={headStyle}>CCN</th>
                    <th style={headStyle}>Window</th>
                    <th style={headStyle}>Methodology</th>
                    <th style={headNumStyle}>Per-beneficiary cap</th>
                    <th style={headNumStyle}>Grace</th>
                    <th style={headStyle}>Status</th>
                    <th style={headStyle}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedPeriods.map((p) => (
                    <tr key={p.id} style={rowStyle}>
                      <td style={tdCodeStyle}>{p.capYear}</td>
                      <td style={tdCodeStyle}>{p.ccn}</td>
                      <td style={cellStyle}>
                        {shortDate(p.startDate)} – {shortDate(p.endDate)}
                      </td>
                      <td style={cellStyle}>{humanize(p.methodology)}</td>
                      <td style={numStyle}>{money(p.aggregateCapAmountCents)}</td>
                      <td style={numStyle}>{p.graceWindowDays}d</td>
                      <td style={cellStyle}>
                        <StatusPill
                          tone={toneOf(PERIOD_STATUS_TONE, p.status)}
                          label={humanize(p.status)}
                        />
                      </td>
                      <td style={cellStyle}>
                        {CLOSABLE.has(p.status) ? (
                          <Button
                            size="sm"
                            tone="secondary"
                            onClick={() => setAction({ kind: "close", period: p })}
                          >
                            Close year
                          </Button>
                        ) : p.status === "settled" ? (
                          <Button
                            size="sm"
                            tone="secondary"
                            onClick={() => setAction({ kind: "reopen", period: p })}
                          >
                            Reopen
                          </Button>
                        ) : (
                          <span style={mutedStyle}>—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <OffsetPagination
                page={activePage}
                pageSize={pageSize}
                totalItems={filteredPeriods.length}
                onPageChange={setPage}
                onPageSizeChange={(next) => {
                  setPageSize(next);
                  setPage(1);
                }}
                pageSizeOptions={PAGE_SIZES}
                noun="periods"
              />
            </div>
          )
        }
        fullPageScroll
      />
      <CapActionDialog
        open={action?.kind === "close"}
        title={`Close cap year ${action?.period.capYear ?? ""}`}
        hint="Closing ends accrual for this cap year and moves it to settlement, where a worksheet is proposed and finalized."
        submitLabel="Close cap year"
        tone="danger"
        onClose={() => setAction(null)}
        onSubmit={() =>
          sendCapMutation(client, "PATCH", "/api/v1/cap/periods/{periodId}/close", {
            periodId: action?.period.id ?? "",
          })
        }
        onDone={() => {
          setAction(null);
          void load();
        }}
      />
      <CapActionDialog
        open={action?.kind === "reopen"}
        title={`Reopen cap year ${action?.period.capYear ?? ""}`}
        hint="Reopening a settled period needs a fresh step-up and a recorded reason; the settlement stays on the audit trail."
        submitLabel="Reopen"
        tone="danger"
        textLabel="Reason"
        onClose={() => setAction(null)}
        onSubmit={({ text }) =>
          sendCapMutation(
            client,
            "PATCH",
            "/api/v1/cap/periods/{periodId}/reopen",
            { periodId: action?.period.id ?? "" },
            { reason: text },
          )
        }
        onDone={() => {
          setAction(null);
          void load();
        }}
      />
    </>
  );
}

/** Statuses the server's `cap_period_open` predicate accepts for close. */
const CLOSABLE: ReadonlySet<string> = new Set(["open", "active", "reopened"]);

const tableStyle = { width: "100%", borderCollapse: "collapse" as const, fontSize: "0.875rem" };
const cellStyle = {
  padding: "0.55rem 0.75rem",
  textAlign: "left" as const,
  verticalAlign: "middle" as const,
  color: "var(--color-on-surface)",
};
const tdCodeStyle = {
  ...cellStyle,
  fontVariantNumeric: "tabular-nums" as const,
  fontFamily: "var(--font-mono)",
};
const numStyle = {
  ...cellStyle,
  textAlign: "right" as const,
  fontVariantNumeric: "tabular-nums" as const,
};
const headStyle = {
  ...cellStyle,
  fontSize: "0.72rem",
  color: "var(--color-on-surface-variant)",
  fontWeight: 600,
};
const headNumStyle = { ...headStyle, textAlign: "right" as const };
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
