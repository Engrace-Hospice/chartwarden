import {
  Button,
  EmptyState,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/18-evv — EVV Event Ledger (M18 §5.1 `/app/evv/events`, Track B / ADR-0030).
// A searchable, caseload-scoped capture ledger. Coordinates are NEVER shown here (D10 — evv.read_coords
// is a separate path). Server query params keep clinician / patient / visit narrowing authoritative.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { EVV_QUALITY_TONE, stateLabel } from "./evv-shared";

interface EvvEventRow {
  id: string;
  visitId: string;
  patientId: string;
  kind: string;
  postingMembershipId: string;
  capturedAt: string;
  gpsQuality: string;
}

const EVENT_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function EvvEvents(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const clinician = params.get("clinician") ?? undefined;
  const patient = params.get("patient") ?? undefined;
  const visit = params.get("visit") ?? undefined;
  const [events, setEvents] = useState<EvvEventRow[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [kindFilter, setKindFilter] = useState("all");
  const [qualityFilter, setQualityFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/evv/events", {
      params: {
        query: {
          ...(clinician ? { clinician } : {}),
          ...(patient ? { patient } : {}),
          ...(visit ? { visit } : {}),
        },
      },
    });
    if (err) {
      setError("Could not load the EVV event ledger.");
      setLoading(false);
      return;
    }
    setEvents(((data ?? []) as EvvEventRow[]) ?? []);
    setLoading(false);
  }, [client, clinician, patient, visit]);

  useEffect(() => {
    void load();
  }, [load]);

  const kindOptions = useMemo(
    () => [...new Set(events.map((event) => event.kind))].sort(),
    [events],
  );
  const qualityOptions = useMemo(
    () => [...new Set(events.map((event) => event.gpsQuality))].sort(),
    [events],
  );
  const filteredEvents = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return events.filter((event) => {
      const matchesKind = kindFilter === "all" || event.kind === kindFilter;
      const matchesQuality = qualityFilter === "all" || event.gpsQuality === qualityFilter;
      const matchesSearch =
        !q ||
        event.id.toLowerCase().includes(q) ||
        event.visitId.toLowerCase().includes(q) ||
        event.patientId.toLowerCase().includes(q) ||
        event.postingMembershipId.toLowerCase().includes(q) ||
        event.kind.toLowerCase().includes(q) ||
        event.gpsQuality.toLowerCase().includes(q);
      return matchesKind && matchesQuality && matchesSearch;
    });
  }, [events, kindFilter, qualityFilter, searchQuery]);
  const sortedEvents = useMemo(
    () => [...filteredEvents].sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt)),
    [filteredEvents],
  );
  const activePage = Math.min(page, Math.max(1, Math.ceil(sortedEvents.length / pageSize)));
  const pagedEvents = sortedEvents.slice((activePage - 1) * pageSize, activePage * pageSize);
  const activeFilters = [
    searchQuery.trim() !== "",
    kindFilter !== "all",
    qualityFilter !== "all",
    clinician,
    patient,
    visit,
  ].filter(Boolean).length;

  const clearFilters = (): void => {
    setSearchQuery("");
    setKindFilter("all");
    setQualityFilter("all");
    setPage(1);
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="EVV Event Ledger"
          breadcrumb="Admin / EVV"
          actions={
            <Button type="button" tone="secondary" onClick={() => void load()} loading={loading}>
              Refresh
            </Button>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review capture events without exposing latitude or longitude.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          {error ? (
            <div role="alert" style={errorBannerStyle}>
              <span>{error}</span>
              <button type="button" onClick={() => setError(null)} style={dismissButtonStyle}>
                x
              </button>
            </div>
          ) : null}
          <div style={toolbarStyle}>
            <div style={toolbarTitleStyle}>
              <span style={toolbarEyebrowStyle}>Capture ledger</span>
              <strong>{sortedEvents.length} matching events</strong>
            </div>
            <div style={controlGroupStyle}>
              <div style={searchWrapStyle}>
                <input
                  type="search"
                  placeholder="Search event, visit, patient, clinician..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setPage(1);
                  }}
                  aria-label="Search EVV events"
                  style={searchInputStyle}
                />
              </div>
              <select
                aria-label="Event kind"
                value={kindFilter}
                onChange={(e) => {
                  setKindFilter(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="all">Kind: All</option>
                {kindOptions.map((kind) => (
                  <option key={kind} value={kind}>
                    {stateLabel(kind)}
                  </option>
                ))}
              </select>
              <select
                aria-label="GPS quality"
                value={qualityFilter}
                onChange={(e) => {
                  setQualityFilter(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="all">GPS: All</option>
                {qualityOptions.map((quality) => (
                  <option key={quality} value={quality}>
                    {stateLabel(quality)}
                  </option>
                ))}
              </select>
              {activeFilters > 0 ? (
                <Button size="sm" tone="tertiary" onClick={clearFilters}>
                  Clear
                </Button>
              ) : null}
            </div>
          </div>
          {clinician || patient || visit ? (
            <div role="note" style={noteStyle}>
              <StatusPill label="Server scoped" tone="progress" />
              <span>
                Query filters from the URL are still applied by the server before the ledger reaches
                this page.
              </span>
            </div>
          ) : null}
        </div>
      }
      table={
        error && events.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={error} />
          </div>
        ) : loading ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : sortedEvents.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title={activeFilters > 0 ? "No matching events" : "No events"}
              description={
                activeFilters > 0
                  ? "Try adjusting the local ledger filters."
                  : "No EVV capture events match your server-scoped request."
              }
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
                  <th style={{ ...thStyle, width: "20%" }}>Captured</th>
                  <th style={{ ...thStyle, width: "18%" }}>Kind</th>
                  <th style={{ ...thStyle, width: "20%" }}>Clinician</th>
                  <th style={{ ...thStyle, width: "20%" }}>Visit</th>
                  <th style={{ ...thStyle, width: "10%" }}>Patient</th>
                  <th style={{ ...thStyle, width: "12%", textAlign: "right" }}>GPS quality</th>
                </tr>
              </thead>
              <tbody>
                {pagedEvents.map((event) => (
                  <tr
                    key={event.id}
                    // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
                    role="button"
                    tabIndex={0}
                    onClick={() => navigate(`/evv/events/${event.id}`)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter" || ev.key === " ") {
                        ev.preventDefault();
                        navigate(`/evv/events/${event.id}`);
                      }
                    }}
                    style={rowStyle}
                    className="wx-data-row-interactive"
                  >
                    <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                      {formatDate(event.capturedAt)}
                    </td>
                    <td style={tdStyle}>
                      <div style={primaryCellStyle}>
                        <span style={primaryTextStyle}>{stateLabel(event.kind)}</span>
                        <code className="wx-data-md" style={codeStyle}>
                          {shortId(event.id)}
                        </code>
                      </div>
                    </td>
                    <td style={tdStyle}>
                      <code className="wx-data-md" style={codeStyle}>
                        {shortId(event.postingMembershipId)}
                      </code>
                    </td>
                    <td style={tdStyle}>
                      <code className="wx-data-md" style={codeStyle}>
                        {shortId(event.visitId)}
                      </code>
                    </td>
                    <td style={tdStyle}>
                      <code className="wx-data-md" style={codeStyle}>
                        {shortId(event.patientId)}
                      </code>
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      <StatusPill
                        label={stateLabel(event.gpsQuality)}
                        tone={EVV_QUALITY_TONE[event.gpsQuality] ?? "neutral"}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={sortedEvents.length}
              onPageChange={setPage}
              onPageSizeChange={(nextPageSize) => {
                setPageSize(nextPageSize);
                setPage(1);
              }}
              pageSizeOptions={EVENT_PAGE_SIZES}
              noun="events"
            />
          </div>
        )
      }
      fullPageScroll
    />
  );
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 8)}...${id.slice(-6)}` : id;
}

const filterShellStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
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
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
};
const controlGroupStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap" as const,
};
const searchWrapStyle = { minWidth: "16rem" };
const searchInputStyle = { width: "100%", height: "2.25rem", fontSize: "0.85rem" };
const selectStyle = { height: "2.25rem", fontSize: "0.85rem", cursor: "pointer" };
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
const errorBannerStyle = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  color: "var(--color-error-pill-fg)",
  fontSize: "0.85rem",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};
const dismissButtonStyle = {
  border: "none",
  background: "none",
  color: "inherit",
  cursor: "pointer",
  fontWeight: 600,
};
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
  cursor: "pointer",
  transition: "background 0.15s ease",
};
const thStyle = {
  padding: "0.625rem 1rem",
  fontWeight: 600,
  fontSize: "0.75rem",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
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
const primaryTextStyle = { fontWeight: 600, color: "var(--color-on-surface)" };
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
