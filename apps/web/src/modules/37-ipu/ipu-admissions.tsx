// apps/web/src/modules/37-ipu — M37 IPU admissions worklist (§5). Lists the org's IPU admissions with
// their level of care + lifecycle state. GET /api/v1/ipu-admissions (RLS-scoped server-side). Lantern:
// UI components + CSS-var tokens only.
import {
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  type StatusTone,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";

interface Admission {
  id: string;
  kind: string;
  state: string;
  unitId: string | null;
  remoteFacilityId: string | null;
  openedAt: string;
}

type LocationFilter = "all" | "own" | "arranged" | "unplaced";

const IPU_ADMISSION_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

const tone = (state: string): StatusTone =>
  state === "active"
    ? "success"
    : state === "closed" || state === "discharged"
      ? "neutral"
      : "warning";

const titleCase = (value: string): string =>
  value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();

const formatDate = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

const locationLabel = (admission: Admission): string => {
  if (admission.unitId) return "Own unit";
  if (admission.remoteFacilityId) return "Arranged";
  return "Unplaced";
};

const locationMatches = (admission: Admission, filter: LocationFilter): boolean =>
  filter === "all" ||
  (filter === "own" && Boolean(admission.unitId)) ||
  (filter === "arranged" && Boolean(admission.remoteFacilityId)) ||
  (filter === "unplaced" && !admission.unitId && !admission.remoteFacilityId);

export function IpuAdmissions(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<Admission[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [kindFilter, setKindFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");
  const [locationFilter, setLocationFilter] = useState<LocationFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const load = useCallback(async () => {
    const res = await client.GET("/api/v1/ipu-admissions");
    if (res.error) {
      setError("Admissions unavailable.");
      setRows([]);
      return;
    }
    setError(null);
    setRows((res.data as unknown as { items: Admission[] }).items ?? []);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const kindOptions = useMemo(
    () => Array.from(new Set((rows ?? []).map((admission) => admission.kind))).sort(),
    [rows],
  );
  const stateOptions = useMemo(
    () => Array.from(new Set((rows ?? []).map((admission) => admission.state))).sort(),
    [rows],
  );

  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return (rows ?? []).filter((admission) => {
      const location = locationLabel(admission);
      const matchesSearch =
        q.length === 0 ||
        admission.id.toLowerCase().includes(q) ||
        admission.kind.toLowerCase().includes(q) ||
        admission.state.toLowerCase().includes(q) ||
        location.toLowerCase().includes(q) ||
        (admission.unitId ?? "").toLowerCase().includes(q) ||
        (admission.remoteFacilityId ?? "").toLowerCase().includes(q);
      const matchesKind = kindFilter === "all" || admission.kind === kindFilter;
      const matchesState = stateFilter === "all" || admission.state === stateFilter;
      return (
        matchesSearch && matchesKind && matchesState && locationMatches(admission, locationFilter)
      );
    });
  }, [kindFilter, locationFilter, rows, searchQuery, stateFilter]);

  const hasActiveFilters =
    searchQuery.trim() !== "" ||
    kindFilter !== "all" ||
    stateFilter !== "all" ||
    locationFilter !== "all";
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = filteredRows.slice((activePage - 1) * pageSize, activePage * pageSize);

  const clearFilters = (): void => {
    setSearchQuery("");
    setKindFilter("all");
    setStateFilter("all");
    setLocationFilter("all");
    setPage(1);
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="IPU admissions" breadcrumb="IPU / Admissions">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Track General Inpatient and Inpatient Respite stays by lifecycle state and placement.
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
            <div style={searchBoxStyle}>
              <Glyph name="eye" size={14} />
              <input
                type="search"
                placeholder="Search level, state, location, ID..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                aria-label="Search IPU admissions"
                style={searchInputStyle}
              />
            </div>
            <select
              value={kindFilter}
              onChange={(e) => {
                setKindFilter(e.target.value);
                setPage(1);
              }}
              aria-label="Filter admissions by level of care"
              style={selectStyle}
            >
              <option value="all">Level: All</option>
              {kindOptions.map((kind) => (
                <option key={kind} value={kind}>
                  {kind.toUpperCase()}
                </option>
              ))}
            </select>
            <select
              value={stateFilter}
              onChange={(e) => {
                setStateFilter(e.target.value);
                setPage(1);
              }}
              aria-label="Filter admissions by state"
              style={selectStyle}
            >
              <option value="all">State: All</option>
              {stateOptions.map((state) => (
                <option key={state} value={state}>
                  {titleCase(state)}
                </option>
              ))}
            </select>
            <select
              value={locationFilter}
              onChange={(e) => {
                setLocationFilter(e.target.value as LocationFilter);
                setPage(1);
              }}
              aria-label="Filter admissions by location"
              style={selectStyle}
            >
              <option value="all">Location: All</option>
              <option value="own">Own unit</option>
              <option value="arranged">Arranged</option>
              <option value="unplaced">Unplaced</option>
            </select>
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
              title={hasActiveFilters ? "No matching admissions" : "No admissions"}
              description={
                hasActiveFilters
                  ? "Adjust the search or clear filters to return to the full admissions worklist."
                  : "No active IPU admissions."
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
                  <th style={{ ...thStyle, width: "22%" }}>Admission</th>
                  <th style={{ ...thStyle, width: "16%" }}>Level</th>
                  <th style={{ ...thStyle, width: "18%" }}>State</th>
                  <th style={{ ...thStyle, width: "24%" }}>Location</th>
                  <th style={{ ...thStyle, width: "20%" }}>Opened</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((admission) => (
                  <tr key={admission.id} style={rowStyle}>
                    <td style={tdStyle}>
                      <code className="wx-data-md" style={codeStyle}>
                        {admission.id}
                      </code>
                    </td>
                    <td style={tdStyle}>
                      <span style={levelBadgeStyle}>{admission.kind.toUpperCase()}</span>
                    </td>
                    <td style={tdStyle}>
                      <StatusPill tone={tone(admission.state)} label={titleCase(admission.state)} />
                    </td>
                    <td style={tdStyle}>
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
                        <span style={{ color: "var(--color-on-surface)", fontWeight: 600 }}>
                          {locationLabel(admission)}
                        </span>
                        {admission.unitId || admission.remoteFacilityId ? (
                          <code className="wx-data-md" style={codeStyle}>
                            {admission.unitId ?? admission.remoteFacilityId}
                          </code>
                        ) : null}
                      </div>
                    </td>
                    <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                      {formatDate(admission.openedAt)}
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
              pageSizeOptions={IPU_ADMISSION_PAGE_SIZES}
              noun="admissions"
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

const searchBoxStyle: CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  minWidth: "min(100%, 18rem)",
  color: "var(--color-on-surface-variant)",
};

const searchInputStyle: CSSProperties = {
  width: "100%",
  height: "2.25rem",
  paddingLeft: "2rem",
  fontSize: "0.85rem",
};

const selectStyle: CSSProperties = {
  height: "2.25rem",
  fontSize: "0.85rem",
  cursor: "pointer",
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
  textTransform: "uppercase",
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

const levelBadgeStyle: CSSProperties = {
  display: "inline-block",
  padding: "0.2rem 0.5rem",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-primary-tint)",
  color: "var(--color-primary)",
  fontSize: "0.75rem",
  fontWeight: 650,
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
