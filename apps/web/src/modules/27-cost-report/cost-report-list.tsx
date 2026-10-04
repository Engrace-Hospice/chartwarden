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
// apps/web/src/modules/27-cost-report — the COST REPORTS list (R2, §5.1). The primary surface for finance
// staff + compliance officers: every cost report by (ProviderEntity, fiscal year) with its lifecycle state
// and reopen count. Reads are org-scoped server-side (RLS); the server is the only authz point (ADR-0030).
// Lantern: WorkQueueLayout + KpiStrip + No-Line table + §6.6 StatusPill via cost-report-status.ts.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { Link } from "react-router-dom";
import {
  cellStyle,
  headStyle,
  numStyle,
  rowLinkStyle,
  rowStyle,
  tableStyle,
} from "./cost-report-shared";
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

const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function CostReportList(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [stateFilter, setStateFilter] = useState("");
  const [wageFilter, setWageFilter] = useState("");
  const [badDebtFilter, setBadDebtFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/cost-reports");
    if (res.error) {
      setError("Cost reports could not be loaded — you may lack cost-report visibility.");
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

  const stateOptions = useMemo(
    () => [
      { value: "", label: "Any state" },
      ...Array.from(new Set(rows.map((r) => r.state)))
        .sort()
        .map((value) => ({ value, label: humanize(value) })),
    ],
    [rows],
  );
  const wageOptions = useMemo(
    () => [
      { value: "", label: "Any wage source" },
      ...Array.from(new Set(rows.map((r) => r.wageSource)))
        .sort()
        .map((value) => ({ value, label: humanize(value) })),
    ],
    [rows],
  );
  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return rows
      .filter((r) => {
        const matchesState = !stateFilter || r.state === stateFilter;
        const matchesWage = !wageFilter || r.wageSource === wageFilter;
        const matchesBadDebt =
          !badDebtFilter || (badDebtFilter === "claimed" ? r.badDebtClaimed : !r.badDebtClaimed);
        const matchesSearch =
          !q ||
          [
            r.costReportId,
            r.providerEntityId,
            r.fiscalYearStartDate,
            r.fiscalYearEndDate,
            r.state,
            r.wageSource,
            String(r.reopenCount),
          ].some((value) => value.toLowerCase().includes(q));
        return matchesState && matchesWage && matchesBadDebt && matchesSearch;
      })
      .sort((a, b) => b.fiscalYearEndDate.localeCompare(a.fiscalYearEndDate));
  }, [badDebtFilter, rows, searchQuery, stateFilter, wageFilter]);

  const open = rows.filter((r) => !["accepted", "closed"].includes(r.state)).length;
  const submitted = rows.filter((r) => ["submitted", "accepted"].includes(r.state)).length;
  const badDebtCount = rows.filter((r) => r.badDebtClaimed).length;
  const reopenedCount = rows.filter((r) => r.reopenCount > 0).length;
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = filteredRows.slice((activePage - 1) * pageSize, activePage * pageSize);
  const hasActiveFilters =
    stateFilter !== "" || wageFilter !== "" || badDebtFilter !== "" || searchQuery !== "";

  return (
    <WorkQueueLayout
      fullPageScroll
      header={
        <PageHeader
          title="Cost Reports"
          breadcrumb="Revenue Cycle — CMS-1984-14 hospice cost reports"
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Track fiscal-year cost reports, filing state, wage source, bad-debt exposure, and reopen
            history.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Reports"
            value={loading || error ? "—" : rows.length}
            detail="Total records"
            tone="info"
            accentColor="var(--color-primary)"
          />
          <KpiCard
            label="Open"
            value={loading || error ? "—" : open}
            detail="Pre-acceptance"
            tone={open > 0 ? "warning" : "neutral"}
            accentColor={open > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"}
          />
          <KpiCard
            label="Submitted"
            value={loading || error ? "—" : submitted}
            detail="Submitted / accepted"
            tone="success"
            accentColor="var(--color-success)"
          />
          <KpiCard
            label="Bad Debt"
            value={loading || error ? "—" : badDebtCount}
            detail="Claimed reports"
            tone={badDebtCount > 0 ? "warning" : "neutral"}
            accentColor={badDebtCount > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"}
            selected={badDebtFilter === "claimed"}
            onSelect={() => {
              setBadDebtFilter("claimed");
              setPage(1);
            }}
          />
          <KpiCard
            label="Reopened"
            value={loading || error ? "—" : reopenedCount}
            detail="Reopen count > 0"
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
                placeholder="Search provider, FYE, report..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                aria-label="Search cost reports"
              />
            </label>
            <label style={filterLabelStyle}>
              <span style={mutedStyle}>State</span>
              <select
                aria-label="Filter by state"
                value={stateFilter}
                onChange={(e) => {
                  setStateFilter(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                {stateOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label style={filterLabelStyle}>
              <span style={mutedStyle}>Wage</span>
              <select
                aria-label="Filter by wage source"
                value={wageFilter}
                onChange={(e) => {
                  setWageFilter(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                {wageOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label style={filterLabelStyle}>
              <span style={mutedStyle}>Bad debt</span>
              <select
                aria-label="Filter by bad debt"
                value={badDebtFilter}
                onChange={(e) => {
                  setBadDebtFilter(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="">Any</option>
                <option value="claimed">Claimed</option>
                <option value="not_claimed">Not claimed</option>
              </select>
            </label>
            {hasActiveFilters ? (
              <Button
                size="sm"
                tone="tertiary"
                onClick={() => {
                  setSearchQuery("");
                  setStateFilter("");
                  setWageFilter("");
                  setBadDebtFilter("");
                  setPage(1);
                }}
              >
                Clear
              </Button>
            ) : null}
            <span style={mutedStyle}>
              {filteredRows.length} of {rows.length} reports
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
        ) : filteredRows.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No cost reports"
              description={
                hasActiveFilters
                  ? "No cost report matches these filters."
                  : "Create a cost report for a ProviderEntity + fiscal year to begin."
              }
              action={
                hasActiveFilters ? (
                  <Button
                    tone="secondary"
                    size="sm"
                    onClick={() => {
                      setSearchQuery("");
                      setStateFilter("");
                      setWageFilter("");
                      setBadDebtFilter("");
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
          <>
            <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem" }}>
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
                  {pagedRows.map((r) => (
                    <tr key={r.costReportId} style={rowStyle}>
                      <td style={cellStyle}>
                        <Link
                          to={`/cost-reports/workspace?reportId=${r.costReportId}`}
                          style={rowLinkStyle}
                        >
                          {shortDate(r.fiscalYearEndDate)}
                        </Link>
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
            </div>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={filteredRows.length}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
              pageSizeOptions={PAGE_SIZES}
              noun="reports"
            />
          </>
        )
      }
    />
  );
}

const filterPanelStyle: CSSProperties = {
  padding: "0 1.5rem 0.75rem",
};

const filterRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "end",
  gap: "0.75rem",
};

const filterLabelStyle: CSSProperties = {
  display: "grid",
  gap: "0.25rem",
};

const mutedStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8125rem",
};

const selectStyle: CSSProperties = {
  minHeight: "2.35rem",
  padding: "0.45rem 0.65rem",
  borderRadius: "0.5rem",
  border: "1px solid var(--color-surface-container)",
  background: "var(--color-surface)",
  color: "var(--color-on-surface)",
  fontSize: "0.875rem",
};

const errorBannerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  marginBottom: "0.75rem",
  padding: "0.65rem 0.75rem",
  borderRadius: "0.5rem",
  border: "1px solid var(--color-error)",
  color: "var(--color-error)",
  background: "color-mix(in srgb, var(--color-error) 8%, var(--color-surface))",
  fontSize: "0.875rem",
};
