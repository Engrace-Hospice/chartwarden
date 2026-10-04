// apps/web/src/modules/20-field-safety — §5.1 "INCIDENT LEDGER" (`/safety/incidents`, Track B/ADR-0030).
//
// Server filters: lifecycleState + oshaReportable. Category, severity, date and search are local to the
// fetched rows because §4.1 publishes no query parameters for them.
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
} from "@wardenx/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import {
  type SafetyIncidentLifecycleState,
  type SafetyIncidentView,
  errorMessage,
  listIncidents,
} from "./safety-api";
import {
  INCIDENT_CATEGORIES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATES,
  dateTime,
  humanize,
  incidentCategoryLabel,
  shortDate,
  shortId,
} from "./safety-status";
import { IncidentStatePill, Notice, SeverityPill } from "./safety-ui";

const ANY = "";
const SERVER_LIMIT = 100;
const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function IncidentLedgerScreen(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<SafetyIncidentView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [lifecycleState, setLifecycleState] = useState(ANY);
  const [oshaOnly, setOshaOnly] = useState(ANY);
  const [searchQuery, setSearchQuery] = useState("");
  const [category, setCategory] = useState(ANY);
  const [severity, setSeverity] = useState(ANY);
  const [occurredFrom, setOccurredFrom] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const serverQuery = useMemo(
    () => ({
      limit: SERVER_LIMIT,
      ...(lifecycleState ? { lifecycleState: lifecycleState as SafetyIncidentLifecycleState } : {}),
      ...(oshaOnly ? { oshaReportable: oshaOnly === "yes" } : {}),
    }),
    [lifecycleState, oshaOnly],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await listIncidents(client, serverQuery);
    if (res.error || !res.page) {
      setError(errorMessage(res.error, "The incident ledger could not be read."));
      setRows([]);
      setCursor(null);
      setHasMore(false);
    } else {
      setRows(res.page.data);
      setCursor(res.page.next_cursor);
      setHasMore(res.page.has_more);
    }
    setLoading(false);
  }, [client, serverQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setPaging(true);
    const res = await listIncidents(client, { ...serverQuery, cursor });
    setPaging(false);
    if (res.error || !res.page) {
      setError(errorMessage(res.error, "The next page could not be read."));
      return;
    }
    setRows((prev) => [...prev, ...res.page!.data]);
    setCursor(res.page.next_cursor);
    setHasMore(res.page.has_more);
  }, [client, cursor, serverQuery]);

  const shown = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const fromMs = occurredFrom ? Date.parse(occurredFrom) : Number.NaN;
    return rows
      .filter((row) => (category ? row.category === category : true))
      .filter((row) => (severity ? row.severity === severity : true))
      .filter((row) => (Number.isNaN(fromMs) ? true : Date.parse(row.occurredAt) >= fromMs))
      .filter((row) => {
        if (!q) return true;
        return (
          row.id.toLowerCase().includes(q) ||
          row.category.toLowerCase().includes(q) ||
          row.severity.toLowerCase().includes(q) ||
          row.lifecycleState.toLowerCase().includes(q) ||
          row.affectedClinicianMembershipId.toLowerCase().includes(q) ||
          row.reportedByMembershipId.toLowerCase().includes(q) ||
          (row.workersCompClaimReference?.toLowerCase().includes(q) ?? false)
        );
      })
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  }, [category, occurredFrom, rows, searchQuery, severity]);

  const activePage = Math.min(page, Math.max(1, Math.ceil(shown.length / pageSize)));
  const pagedRows = shown.slice((activePage - 1) * pageSize, activePage * pageSize);
  const activeFilters = [
    lifecycleState !== "",
    oshaOnly !== "",
    searchQuery.trim() !== "",
    category !== "",
    severity !== "",
    occurredFrom !== "",
  ].filter(Boolean).length;

  const clearFilters = (): void => {
    setLifecycleState(ANY);
    setOshaOnly(ANY);
    setSearchQuery("");
    setCategory(ANY);
    setSeverity(ANY);
    setOccurredFrom("");
    setPage(1);
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Safety Incidents"
          breadcrumb="Field safety"
          actions={
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              <Link to="/safety/incidents/new" style={linkButtonStyle}>
                Report an incident
              </Link>
              <Link to="/safety" style={linkButtonStyle}>
                Safety board
              </Link>
            </div>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review workforce-safety incidents without exposing encrypted narratives in the ledger.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          {error ? (
            <Notice tone="warning" live>
              {error} The rows below are the last page that did answer.
            </Notice>
          ) : null}
          <div role="note" style={noteStyle}>
            <StatusPill label="No total count" tone="neutral" />
            <span>
              Server filters re-query. Category, severity, date and search narrow only the fetched
              rows because the safety API exposes no total-count oracle.
            </span>
          </div>
          <div style={toolbarStyle}>
            <div style={toolbarTitleStyle}>
              <span style={toolbarEyebrowStyle}>Incident ledger</span>
              <strong>{shown.length} matching loaded rows</strong>
            </div>
            <div style={controlGroupStyle}>
              <label className="wx-search-field">
                <Glyph name="search" size={16} />
                <input
                  type="search"
                  placeholder="Search incident, clinician, category..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setPage(1);
                  }}
                  aria-label="Search safety incidents"
                />
              </label>
              <label className="wx-filter-field">
                <span>State</span>
                <select
                  className="wx-select"
                  aria-label="Lifecycle state"
                  value={lifecycleState}
                  onChange={(e) => {
                    setLifecycleState(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value={ANY}>All</option>
                  {INCIDENT_STATES.map((value) => (
                    <option key={value} value={value}>
                      {humanize(value)}
                    </option>
                  ))}
                </select>
              </label>
              <select
                aria-label="OSHA reportable"
                value={oshaOnly}
                onChange={(e) => {
                  setOshaOnly(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value={ANY}>OSHA: Either</option>
                <option value="yes">Reportable only</option>
                <option value="no">Not reportable</option>
              </select>
              <label className="wx-filter-field">
                <span>Category</span>
                <select
                  className="wx-select"
                  aria-label="Incident category"
                  value={category}
                  onChange={(e) => {
                    setCategory(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value={ANY}>All</option>
                  {INCIDENT_CATEGORIES.map((value) => (
                    <option key={value} value={value}>
                      {incidentCategoryLabel(value)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="wx-filter-field">
                <span>Severity</span>
                <select
                  className="wx-select"
                  aria-label="Incident severity"
                  value={severity}
                  onChange={(e) => {
                    setSeverity(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value={ANY}>All</option>
                  {INCIDENT_SEVERITIES.map((value) => (
                    <option key={value} value={value}>
                      {humanize(value)}
                    </option>
                  ))}
                </select>
              </label>
              <input
                type="date"
                value={occurredFrom}
                onChange={(e) => {
                  setOccurredFrom(e.target.value);
                  setPage(1);
                }}
                aria-label="Occurred on or after"
                style={dateInputStyle}
              />
              {activeFilters > 0 ? (
                <Button size="sm" tone="tertiary" onClick={clearFilters}>
                  Clear
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      }
      table={
        loading ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : error && rows.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Incident ledger unavailable" description={error} />
          </div>
        ) : shown.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No matching incidents"
              description="If a local filter is set, widen it or load another server page."
              action={
                activeFilters > 0 ? (
                  <Button size="sm" tone="secondary" onClick={clearFilters}>
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
                  <th style={{ ...thStyle, width: "15%" }}>Occurred</th>
                  <th style={{ ...thStyle, width: "18%" }}>Category</th>
                  <th style={{ ...thStyle, width: "12%" }}>Severity</th>
                  <th style={{ ...thStyle, width: "15%" }}>State</th>
                  <th style={{ ...thStyle, width: "16%" }}>Affected</th>
                  <th style={{ ...thStyle, width: "14%" }}>OSHA</th>
                  <th style={{ ...thStyle, width: "10%", textAlign: "right" }}>Incident</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((row) => (
                  <tr key={row.id} style={rowStyle}>
                    <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                      {dateTime(row.occurredAt)}
                    </td>
                    <td style={tdStyle}>{incidentCategoryLabel(row.category)}</td>
                    <td style={tdStyle}>
                      <SeverityPill severity={row.severity} />
                    </td>
                    <td style={tdStyle}>
                      <IncidentStatePill state={row.lifecycleState} />
                    </td>
                    <td style={tdStyle}>
                      <div style={primaryCellStyle}>
                        <code className="wx-data-md" style={codeStyle}>
                          {shortId(row.affectedClinicianMembershipId)}
                        </code>
                        {row.affectedClinicianMembershipId !== row.reportedByMembershipId ? (
                          <span style={secondaryTextStyle}>filed on her behalf</span>
                        ) : null}
                      </div>
                    </td>
                    <td style={tdStyle}>
                      {row.oshaReportable ? (
                        <StatusPill
                          label={
                            row.oshaReportableSignedOffAt
                              ? "Reportable - signed"
                              : "Reportable - unsigned"
                          }
                          tone={row.oshaReportableSignedOffAt ? "critical" : "error"}
                        />
                      ) : (
                        <span style={secondaryTextStyle}>No</span>
                      )}
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      <Link to={`/safety/incidents/${row.id}`} style={linkStyle}>
                        {shortId(row.id)}
                      </Link>
                      <div style={secondaryTextStyle}>reported {shortDate(row.reportedAt)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={shown.length}
              onPageChange={setPage}
              onPageSizeChange={(nextPageSize) => {
                setPageSize(nextPageSize);
                setPage(1);
              }}
              pageSizeOptions={PAGE_SIZES}
              noun="loaded incidents"
            />
            <div style={loadMoreRowStyle}>
              {hasMore ? (
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={paging}
                  onClick={() => void loadMore()}
                >
                  {paging ? "Loading..." : "Load more"}
                </Button>
              ) : (
                <span style={secondaryTextStyle}>
                  Every row returned by the server for these filters has been loaded.
                </span>
              )}
            </div>
          </div>
        )
      }
      fullPageScroll
    />
  );
}

const linkButtonStyle = {
  minHeight: "2.25rem",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0 0.75rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
  fontWeight: 600,
  textDecoration: "none",
};
const linkStyle = {
  color: "var(--color-primary)",
  textDecoration: "none",
  fontFamily: "var(--font-mono)",
};
const filterShellStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};
const noteStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.85rem",
};
const toolbarStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
};
const toolbarTitleStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.125rem",
  color: "var(--color-on-surface)",
  fontSize: "0.875rem",
};
const toolbarEyebrowStyle = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};
const controlGroupStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap" as const,
};
const searchInputStyle = { minWidth: "16rem", height: "2.25rem", fontSize: "0.85rem" };
const selectStyle = { height: "2.25rem", fontSize: "0.85rem", cursor: "pointer" };
const dateInputStyle = { height: "2.25rem", fontSize: "0.85rem" };
const tableWrapStyle = {
  width: "100%",
  overflowX: "auto" as const,
  padding: "0 1.5rem 1.5rem 1.5rem",
};
const tableStyle = {
  display: "table",
  width: "100%",
  borderCollapse: "collapse" as const,
  fontSize: "0.875rem",
};
const headerRowStyle = {
  textAlign: "left" as const,
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};
const rowStyle = {
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
};
const thStyle = {
  padding: "0.625rem 1rem",
  fontWeight: 600,
  fontSize: "0.75rem",
};
const tdStyle = {
  padding: "0.75rem 1rem",
  verticalAlign: "middle" as const,
};
const primaryCellStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.25rem",
  minWidth: 0,
};
const secondaryTextStyle = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};
const codeStyle = {
  display: "inline-block",
  maxWidth: "13rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container)",
  borderRadius: "var(--radius-sm)",
  padding: "0.1rem 0.3rem",
  fontSize: "0.75rem",
};
const loadMoreRowStyle = {
  display: "flex",
  justifyContent: "flex-end",
  padding: "0 1.5rem 1rem",
};
