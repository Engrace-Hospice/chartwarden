// apps/web/src/modules/37-ipu — M37 IPU units board (§5, ADR-0030). Lists the org's inpatient units with
// their bed count + RN-coverage horizon. Composed client-side from GET /api/v1/inpatient-units (RLS-scoped
// server-side; the server is the authoritative enforcer, this only presents). Lantern: UI components +
// CSS-var tokens only.
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

interface Unit {
  id: string;
  displayName: string;
  bedCount: number;
  isActive: boolean;
  rnCoverageHorizonHours: number;
  turnoverSlaMinutes: number;
}

type StatusFilter = "all" | "active" | "inactive";
type CoverageFilter = "all" | "covered" | "short";

const IPU_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;
const RN_HORIZON_TARGET_HOURS = 24;

const formatInt = (value: number): string => new Intl.NumberFormat().format(value);

export function IpuUnits(): JSX.Element {
  const client = useApiClient();
  const [units, setUnits] = useState<Unit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [coverageFilter, setCoverageFilter] = useState<CoverageFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const load = useCallback(async () => {
    const res = await client.GET("/api/v1/inpatient-units");
    if (res.error) {
      setError("Units unavailable.");
      setUnits([]);
      return;
    }
    setError(null);
    setUnits((res.data as unknown as { items: Unit[] }).items ?? []);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredUnits = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return (units ?? []).filter((unit) => {
      const matchesSearch =
        q.length === 0 ||
        unit.displayName.toLowerCase().includes(q) ||
        unit.id.toLowerCase().includes(q);
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "active" && unit.isActive) ||
        (statusFilter === "inactive" && !unit.isActive);
      const matchesCoverage =
        coverageFilter === "all" ||
        (coverageFilter === "covered" && unit.rnCoverageHorizonHours >= RN_HORIZON_TARGET_HOURS) ||
        (coverageFilter === "short" && unit.rnCoverageHorizonHours < RN_HORIZON_TARGET_HOURS);

      return matchesSearch && matchesStatus && matchesCoverage;
    });
  }, [coverageFilter, searchQuery, statusFilter, units]);

  const hasActiveFilters =
    searchQuery.trim() !== "" || statusFilter !== "all" || coverageFilter !== "all";
  const pageCount = Math.max(1, Math.ceil(filteredUnits.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedUnits = filteredUnits.slice((activePage - 1) * pageSize, activePage * pageSize);

  const clearFilters = (): void => {
    setSearchQuery("");
    setStatusFilter("all");
    setCoverageFilter("all");
    setPage(1);
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Inpatient units" breadcrumb="IPU / Bed capacity">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Monitor unit readiness, bed capacity, RN coverage horizon, and turnover expectations.
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
            <label className="wx-search-field">
              <Glyph name="search" size={16} />
              <input
                type="search"
                placeholder="Search unit name or ID..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                aria-label="Search inpatient units"
              />
            </label>
            <label className="wx-filter-field">
              <span>Status</span>
              <select
                className="wx-select"
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value as StatusFilter);
                  setPage(1);
                }}
                aria-label="Filter units by status"
              >
                <option value="all">All</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </label>
            <label className="wx-filter-field">
              <span>RN coverage</span>
              <select
                className="wx-select"
                value={coverageFilter}
                onChange={(e) => {
                  setCoverageFilter(e.target.value as CoverageFilter);
                  setPage(1);
                }}
                aria-label="Filter units by RN coverage"
              >
                <option value="all">All</option>
                <option value="covered">24h+ covered</option>
                <option value="short">Under 24h</option>
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
        units === null ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : filteredUnits.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title={hasActiveFilters ? "No matching units" : "No units"}
              description={
                hasActiveFilters
                  ? "Adjust the search or clear filters to see the full IPU capacity board."
                  : "No inpatient units are configured for this organization yet."
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
                  <th style={{ ...thStyle, width: "34%" }}>Unit</th>
                  <th style={{ ...thStyle, width: "14%" }}>Beds</th>
                  <th style={{ ...thStyle, width: "20%" }}>RN horizon</th>
                  <th style={{ ...thStyle, width: "18%" }}>Turnover SLA</th>
                  <th style={{ ...thStyle, width: "14%" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {pagedUnits.map((unit) => (
                  <tr key={unit.id} style={rowStyle}>
                    <td style={tdStyle}>
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
                        <span style={{ color: "var(--color-on-surface)", fontWeight: 650 }}>
                          {unit.displayName}
                        </span>
                        <code className="wx-data-md" style={codeStyle}>
                          {unit.id}
                        </code>
                      </div>
                    </td>
                    <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums", fontWeight: 650 }}>
                      {formatInt(unit.bedCount)}
                    </td>
                    <td style={tdStyle}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                        <StatusPill
                          tone={
                            unit.rnCoverageHorizonHours >= RN_HORIZON_TARGET_HOURS
                              ? "success"
                              : "warning"
                          }
                          label={`${unit.rnCoverageHorizonHours}h`}
                        />
                        <span style={{ color: "var(--color-on-surface-variant)" }}>
                          {unit.rnCoverageHorizonHours >= RN_HORIZON_TARGET_HOURS
                            ? "Covered"
                            : "Review"}
                        </span>
                      </div>
                    </td>
                    <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                      {unit.turnoverSlaMinutes}m
                    </td>
                    <td style={tdStyle}>
                      <StatusPill
                        tone={unit.isActive ? "success" : "neutral"}
                        label={unit.isActive ? "Active" : "Inactive"}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={filteredUnits.length}
              onPageChange={setPage}
              onPageSizeChange={(nextPageSize) => {
                setPageSize(nextPageSize);
                setPage(1);
              }}
              pageSizeOptions={IPU_PAGE_SIZES}
              noun="units"
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
