// apps/web/src/modules/37-ipu — M37 IPU daily census (§5/§2.13). Reads census snapshot rows and
// surfaces the GIP/IRC head-counts + bed-days + incident counts. GET /api/v1/ipu-census/:date. Lantern:
// WorkQueueLayout + CSS-var tokens only.
import {
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";

interface CensusRow {
  unitId: string | null;
  censusCountGip: number;
  censusCountIrc: number;
  bedDaysGip: number;
  bedDaysIrc: number;
  roomTurnoverCount: number;
  restraintIncidentCount: number;
}

type ActivityFilter = "all" | "occupied" | "incidents";

const CENSUS_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

const today = (): string => new Date().toISOString().slice(0, 10);

const formatInt = (value: number): string => new Intl.NumberFormat().format(value);

const rowCensusTotal = (row: CensusRow): number => row.censusCountGip + row.censusCountIrc;
const rowBedDayTotal = (row: CensusRow): number => row.bedDaysGip + row.bedDaysIrc;
const rowIncidentTotal = (row: CensusRow): number =>
  row.roomTurnoverCount + row.restraintIncidentCount;

export function IpuCensus(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<CensusRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState(today);
  const [searchQuery, setSearchQuery] = useState("");
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const load = useCallback(async () => {
    const res = await client.GET("/api/v1/ipu-census/{date}", { params: { path: { date } } });
    if (res.error) {
      setError("Census unavailable.");
      setRows([]);
      return;
    }
    setError(null);
    setRows((res.data as unknown as { items: CensusRow[] }).items ?? []);
  }, [client, date]);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return (rows ?? []).filter((row) => {
      const location = row.unitId ?? "arranged / external";
      const matchesSearch = q.length === 0 || location.toLowerCase().includes(q);
      const matchesActivity =
        activityFilter === "all" ||
        (activityFilter === "occupied" && rowCensusTotal(row) > 0) ||
        (activityFilter === "incidents" && rowIncidentTotal(row) > 0);

      return matchesSearch && matchesActivity;
    });
  }, [activityFilter, rows, searchQuery]);

  const occupiedRows = (rows ?? []).filter((row) => rowCensusTotal(row) > 0).length;
  const incidentRows = (rows ?? []).filter((row) => rowIncidentTotal(row) > 0).length;

  const hasActiveFilters = searchQuery.trim() !== "" || activityFilter !== "all";
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = filteredRows.slice((activePage - 1) * pageSize, activePage * pageSize);

  const clearFilters = (): void => {
    setSearchQuery("");
    setActivityFilter("all");
    setPage(1);
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="IPU census" breadcrumb="IPU / Daily snapshot">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review the daily GIP/IRC census, bed-day totals, room turnover, and restraint activity.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          {error ? (
            <div role="alert" style={errorBannerStyle}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <Glyph name="alert" size={16} />
                <span>{error}</span>
              </div>
              <button
                type="button"
                onClick={() => setError(null)}
                style={dismissButtonStyle}
                aria-label="Dismiss error"
              >
                x
              </button>
            </div>
          ) : null}
          <div style={toolbarStyle}>
            <label style={dateLabelStyle}>
              <span>Date</span>
              <input
                type="date"
                value={date}
                onChange={(event) => {
                  setDate(event.target.value || today());
                  setPage(1);
                }}
                style={dateInputStyle}
              />
            </label>
            <label className="wx-search-field">
              <Glyph name="search" size={16} />
              <input
                type="search"
                placeholder="Search unit or arranged rows..."
                value={searchQuery}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  setPage(1);
                }}
                aria-label="Search IPU census rows"
              />
            </label>
            <label className="wx-filter-field">
              <span>Activity</span>
              <select
                className="wx-select"
                value={activityFilter}
                onChange={(event) => {
                  setActivityFilter(event.target.value as ActivityFilter);
                  setPage(1);
                }}
                aria-label="Filter census rows by activity"
              >
                <option value="all">All</option>
                <option value="occupied">Occupied only ({occupiedRows})</option>
                <option value="incidents">Turnover/restraint ({incidentRows})</option>
              </select>
            </label>
            {hasActiveFilters ? (
              <Button size="sm" tone="tertiary" onClick={clearFilters}>
                Clear
              </Button>
            ) : null}
          </div>
        </div>
      }
      table={
        rows === null ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : filteredRows.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title={hasActiveFilters ? "No matching census rows" : "No snapshot"}
              description={
                hasActiveFilters
                  ? "Adjust the search or clear filters to return to the full daily census."
                  : "No census snapshot has been materialized for this date yet."
              }
              action={
                hasActiveFilters ? (
                  <Button tone="secondary" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div style={tableWrapStyle}>
            <table style={tableStyle}>
              <thead>
                <tr style={headerRowStyle}>
                  <th style={{ ...thStyle, width: "28%" }}>Unit</th>
                  <th style={{ ...thStyle, width: "14%" }}>GIP</th>
                  <th style={{ ...thStyle, width: "14%" }}>IRC</th>
                  <th style={{ ...thStyle, width: "16%" }}>Bed-days</th>
                  <th style={{ ...thStyle, width: "14%" }}>Turnovers</th>
                  <th style={{ ...thStyle, width: "14%" }}>Restraints</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((row, index) => (
                  <tr key={`${row.unitId ?? "arranged"}-${index}`} style={rowStyle}>
                    <td style={tdStyle}>
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
                        <span style={{ color: "var(--color-on-surface)", fontWeight: 650 }}>
                          {row.unitId ? "Own unit" : "Arranged / external"}
                        </span>
                        <code className="wx-data-md" style={codeStyle}>
                          {row.unitId ?? "no-unit-id"}
                        </code>
                      </div>
                    </td>
                    <td style={{ ...tdStyle, fontWeight: 650 }}>{formatInt(row.censusCountGip)}</td>
                    <td style={{ ...tdStyle, fontWeight: 650 }}>{formatInt(row.censusCountIrc)}</td>
                    <td style={tdStyle}>
                      <StatusPill
                        tone={rowBedDayTotal(row) > 0 ? "success" : "neutral"}
                        label={formatInt(rowBedDayTotal(row))}
                      />
                    </td>
                    <td style={tdStyle}>{formatInt(row.roomTurnoverCount)}</td>
                    <td style={tdStyle}>
                      <StatusPill
                        tone={row.restraintIncidentCount > 0 ? "error" : "success"}
                        label={formatInt(row.restraintIncidentCount)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={filteredRows.length}
              onPageChange={setPage}
              onPageSizeChange={(nextPageSize) => {
                setPageSize(nextPageSize);
                setPage(1);
              }}
              pageSizeOptions={CENSUS_PAGE_SIZES}
              noun="census rows"
            />
          </div>
        )
      }
      fullPageScroll
    />
  );
}

const filterShellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};

const toolbarStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "0.5rem",
};

const dateLabelStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.85rem",
  fontWeight: 600,
};

const dateInputStyle: CSSProperties = {
  height: "2.25rem",
  fontSize: "0.85rem",
};

const tableWrapStyle: CSSProperties = {
  width: "100%",
  overflowX: "auto",
  padding: "0 1.5rem 1.5rem",
};

const tableStyle: CSSProperties = {
  display: "table",
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.875rem",
  fontVariantNumeric: "tabular-nums",
};

const headerRowStyle: CSSProperties = {
  textAlign: "left",
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};

const thStyle: CSSProperties = {
  padding: "0.75rem 1rem",
  fontWeight: 600,
  fontSize: "0.75rem",
};

const tdStyle: CSSProperties = {
  padding: "0.875rem 1rem",
  verticalAlign: "middle",
  color: "var(--color-on-surface-variant)",
  fontVariantNumeric: "tabular-nums",
};

const rowStyle: CSSProperties = {
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
};

const codeStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};

const errorBannerStyle: CSSProperties = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  color: "var(--color-error)",
  fontSize: "0.85rem",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
};

const dismissButtonStyle: CSSProperties = {
  border: "none",
  background: "none",
  color: "inherit",
  cursor: "pointer",
  fontWeight: 600,
};
