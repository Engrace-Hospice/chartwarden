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
// apps/web/src/modules/14-idg — IDG Schedule (per-location) (M14 §4.1/§5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_IDG_MEETING.md — "Use Work Queue + Documentation Workspace". The
// IDG Coordinator's per-location view of the next weeks of meetings: one row per scheduled meeting with its
// lifecycle chip (scheduled → packets_building → packets_ready → live → adjourned). The cancel / reschedule /
// edit-recurring-policy write surfaces fill in as their write paths harden; the SERVER owns the §2.2 lifecycle
// and the §4.7 idg_meeting_scope / per_patient_review_floor_clear ABAC (ADR-0030 — no frontend authz). The
// location is taken from the `?location=` query (location-scoped read); the range defaults to the next 8 weeks.
// Reads GET /api/v1/idg/schedule via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { MEETING_TONE, stateLabel } from "./idg-status";

interface MeetingRow {
  id: string;
  locationId: string;
  status: string;
  scheduledStart: string;
  scheduledEnd: string;
}

export function IdgSchedule(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const location = params.get("location") ?? undefined;
  const [meetings, setMeetings] = useState<MeetingRow[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const range = useMemo(() => {
    const from = new Date();
    const to = new Date(from.getTime() + 56 * 24 * 60 * 60 * 1000); // next 8 weeks
    return { from: from.toISOString(), to: to.toISOString() };
  }, []);

  const load = useCallback(async () => {
    if (!location) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/idg/schedule", {
      params: { query: { location, from: range.from, to: range.to } },
    });
    if (err) {
      setError("Could not load the IDG schedule for this location.");
      setLoading(false);
      return;
    }
    setMeetings((data ?? []) as MeetingRow[]);
    setLoading(false);
  }, [client, location, range]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const visible = meetings.filter((m) => {
      const matchesStatus = !status || m.status === status;
      const matchesSearch =
        !q ||
        m.id.toLowerCase().includes(q) ||
        m.locationId.toLowerCase().includes(q) ||
        m.status.toLowerCase().includes(q);
      return matchesStatus && matchesSearch;
    });
    return [...visible].sort((a, b) => Date.parse(a.scheduledStart) - Date.parse(b.scheduledStart));
  }, [meetings, searchQuery, status]);

  const activeFilters = [searchQuery.trim() !== "", status !== ""].filter(Boolean).length;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = rows.slice((activePage - 1) * pageSize, activePage * pageSize);

  const clearFilters = (): void => {
    setSearchQuery("");
    setStatus("");
    setPage(1);
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="IDG Schedule" breadcrumb="Clinical / IDG">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review upcoming interdisciplinary group meetings for the selected location.
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
              <span style={toolbarEyebrowStyle}>Schedule</span>
              <strong>{rows.length} matching meetings</strong>
            </div>
            <div style={controlGroupStyle}>
              <div style={searchWrapStyle}>
                <input
                  type="search"
                  placeholder="Search meeting or location..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setPage(1);
                  }}
                  aria-label="Search IDG schedule"
                  style={searchInputStyle}
                  disabled={!location}
                />
              </div>
              <select
                aria-label="Meeting status"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
                disabled={!location}
              >
                <option value="">Status: All</option>
                <option value="scheduled">Scheduled</option>
                <option value="packets_building">Packets building</option>
                <option value="packets_ready">Packets ready</option>
                <option value="live">Live</option>
                <option value="adjourned">Adjourned</option>
                <option value="cancelled">Cancelled</option>
                <option value="rescheduled">Rescheduled</option>
              </select>
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
        !location ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="Select a location"
              description="Open this schedule from a location context to view its IDG meetings."
            />
          </div>
        ) : error ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={error} />
          </div>
        ) : loading && meetings.length === 0 ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title={activeFilters > 0 ? "No matching meetings" : "No meetings scheduled"}
              description={
                activeFilters > 0
                  ? "Try adjusting the schedule filters."
                  : "No IDG meetings are scheduled for this location in the next 8 weeks."
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
                  <th style={{ ...thStyle, width: "32%" }}>Meeting</th>
                  <th style={{ ...thStyle, width: "22%" }}>Location</th>
                  <th style={{ ...thStyle, width: "16%" }}>Start</th>
                  <th style={{ ...thStyle, width: "16%" }}>End</th>
                  <th style={{ ...thStyle, width: "14%", textAlign: "right" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((m) => (
                  <tr
                    key={m.id}
                    // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
                    role="button"
                    tabIndex={0}
                    onClick={() => navigate(`/idg/meetings/${m.id}`)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter" || ev.key === " ") {
                        ev.preventDefault();
                        navigate(`/idg/meetings/${m.id}`);
                      }
                    }}
                    style={rowStyle}
                    className="wx-data-row-interactive"
                  >
                    <td style={tdStyle}>
                      <div style={primaryCellStyle}>
                        <span style={primaryTextStyle}>IDG meeting</span>
                        <code className="wx-data-md" style={codeStyle}>
                          {shortId(m.id)}
                        </code>
                      </div>
                    </td>
                    <td style={tdStyle}>
                      <code className="wx-data-md" style={codeStyle}>
                        {shortId(m.locationId)}
                      </code>
                    </td>
                    <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                      {formatDateTime(m.scheduledStart)}
                    </td>
                    <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                      {formatDateTime(m.scheduledEnd)}
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      <StatusPill
                        label={stateLabel(m.status)}
                        tone={MEETING_TONE[m.status] ?? "neutral"}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={rows.length}
              onPageChange={setPage}
              onPageSizeChange={(nextPageSize) => {
                setPageSize(nextPageSize);
                setPage(1);
              }}
              pageSizeOptions={IDG_PAGE_SIZES}
              noun="meetings"
            />
          </div>
        )
      }
      fullPageScroll
    />
  );
}

const IDG_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

function isWithinDays(iso: string, days: number): boolean {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) return false;
  const delta = value - Date.now();
  return delta >= 0 && delta <= days * 86_400_000;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
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

const searchWrapStyle = {
  minWidth: "15rem",
};

const searchInputStyle = {
  width: "100%",
  height: "2.25rem",
  fontSize: "0.85rem",
};

const selectStyle = {
  height: "2.25rem",
  fontSize: "0.85rem",
  cursor: "pointer",
};

const errorBannerStyle = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  color: "var(--color-error)",
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

const primaryTextStyle = {
  fontWeight: 600,
  color: "var(--color-on-surface)",
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
