// apps/web/src/modules/20-field-safety — §5.1 "SAFETY DASHBOARD" (`/safety`, Track B / ADR-0030).
//
// The supervisor live-awareness board. This screen remains coordinate-free by DTO shape: it renders source
// and age, never lat/lng. An unreadable board is UNKNOWN, not "everyone is fine".
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
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import {
  type SafetyClinicianStatusView,
  type SafetyDashboardView,
  errorMessage,
  getDashboard,
} from "./safety-api";
import {
  LOCATION_STALE_MINUTES,
  dateTime,
  durationLabel,
  humanize,
  isLocationStale,
  locationSourceLabel,
  shortId,
} from "./safety-status";
import { CheckInStatusPill, Notice, OverduePill, SosStatePill } from "./safety-ui";

const POLL_MS = 30_000;
const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

type BoardState = "ready" | "unknown";
type FlagFilter = "all" | "active_sos" | "high_risk" | "gps_spoof" | "stale" | "no_position";

export function SafetyDashboardScreen(): JSX.Element {
  const client = useApiClient();
  const [board, setBoard] = useState<SafetyDashboardView | null>(null);
  const [state, setState] = useState<BoardState>("unknown");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [locationId, setLocationId] = useState("");
  const [supervisorMembershipId, setSupervisorMembershipId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [flagFilter, setFlagFilter] = useState<FlagFilter>("all");
  const [overdueFilter, setOverdueFilter] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const load = useCallback(
    async (background = false) => {
      if (!background) setLoading(true);
      const res = await getDashboard(client, {
        ...(locationId.trim() ? { locationId: locationId.trim() } : {}),
        ...(supervisorMembershipId.trim()
          ? { supervisorMembershipId: supervisorMembershipId.trim() }
          : {}),
      });
      if (res.error || !res.board) {
        setState("unknown");
        setError(errorMessage(res.error, "The safety board could not be read."));
      } else {
        setBoard(res.board);
        setState("ready");
        setError(null);
      }
      setLoading(false);
    },
    [client, locationId, supervisorMembershipId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => void load(true), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const orderedRows = useMemo(() => {
    const list = [...(board?.clinicians ?? [])];
    const rung = (s: string) =>
      s === "escalated" ? 3 : s === "overdue" ? 2 : s === "reminder" ? 1 : 0;
    return list.sort(
      (x, y) =>
        Number(y.activeSosAlert !== null) - Number(x.activeSosAlert !== null) ||
        rung(y.overdueState) - rung(x.overdueState) ||
        (y.lastKnownLocation?.ageMinutes ?? -1) - (x.lastKnownLocation?.ageMinutes ?? -1) ||
        x.displayName.localeCompare(y.displayName),
    );
  }, [board]);

  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return orderedRows.filter((row) => {
      const matchesSearch =
        !q ||
        row.displayName.toLowerCase().includes(q) ||
        row.membershipId.toLowerCase().includes(q) ||
        (row.currentVisitId?.toLowerCase().includes(q) ?? false) ||
        (row.currentPatientFirstName?.toLowerCase().includes(q) ?? false) ||
        row.overdueState.toLowerCase().includes(q);
      const matchesOverdue = !overdueFilter || row.overdueState === overdueFilter;
      const matchesFlag =
        flagFilter === "all" ||
        (flagFilter === "active_sos" && row.activeSosAlert !== null) ||
        (flagFilter === "high_risk" && row.inHighRiskArea !== null) ||
        (flagFilter === "gps_spoof" && row.gpsSpoofSuspected) ||
        (flagFilter === "stale" && isLocationStale(row.lastKnownLocation?.ageMinutes)) ||
        (flagFilter === "no_position" && row.lastKnownLocation === null);
      return matchesSearch && matchesOverdue && matchesFlag;
    });
  }, [flagFilter, orderedRows, overdueFilter, searchQuery]);

  const activePage = Math.min(page, Math.max(1, Math.ceil(filteredRows.length / pageSize)));
  const pagedRows = filteredRows.slice((activePage - 1) * pageSize, activePage * pageSize);
  const activeFilters = [
    searchQuery.trim() !== "",
    flagFilter !== "all",
    overdueFilter !== "",
  ].filter(Boolean).length;

  const clearFilters = (): void => {
    setSearchQuery("");
    setFlagFilter("all");
    setOverdueFilter("");
    setPage(1);
  };

  if (loading && board === null) {
    return (
      <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
        <LoadingSpinner />
      </div>
    );
  }

  if (board === null) {
    return (
      <div style={{ padding: "2rem 1.5rem" }}>
        <EmptyState
          title="Safety board unavailable"
          description={
            error ??
            "The board did not answer. This is not everyone is fine; treat it as unknown and check by phone."
          }
        />
      </div>
    );
  }

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Field Safety Board"
          breadcrumb="Field safety"
          actions={
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              <Link to="/safety/sos" style={linkButtonStyle}>
                Active SOS
              </Link>
              <Link to="/safety/incidents" style={linkButtonStyle}>
                Incidents
              </Link>
              <Button type="button" tone="secondary" onClick={() => void load()} loading={loading}>
                Refresh
              </Button>
            </div>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Server snapshot at {dateTime(board.fetchedAt)}. Polls every {POLL_MS / 1000} seconds.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          {state === "unknown" ? (
            <Notice tone="warning" assertive>
              <strong>This board did not refresh.</strong> {error} The rows below are the last
              snapshot that answered, taken at {dateTime(board.fetchedAt)}.
            </Notice>
          ) : null}
          <div role="note" style={noteStyle}>
            <StatusPill label="Coordinate-free" tone="success" />
            <span>
              This board shows last-heard source and age only. SOS coordinates live on the
              individual alert detail behind the separate coordinate permission.
            </span>
          </div>
          <div style={toolbarStyle}>
            <div style={toolbarTitleStyle}>
              <span style={toolbarEyebrowStyle}>Supervisor scope</span>
              <strong>
                {filteredRows.length} matching clinicians · {board.activeSosCount} active SOS ·{" "}
                {board.overdueCount} overdue
              </strong>
            </div>
            <div style={controlGroupStyle}>
              <input
                type="search"
                placeholder="Search clinician, visit, patient..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                aria-label="Search safety board"
                style={searchInputStyle}
              />
              <select
                aria-label="Safety flag"
                value={flagFilter}
                onChange={(e) => {
                  setFlagFilter(e.target.value as FlagFilter);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="all">Flag: All</option>
                <option value="active_sos">Active SOS</option>
                <option value="high_risk">High-risk area</option>
                <option value="gps_spoof">GPS spoof</option>
                <option value="stale">Position &gt; 1h old</option>
                <option value="no_position">No position</option>
              </select>
              <select
                aria-label="Overdue state"
                value={overdueFilter}
                onChange={(e) => {
                  setOverdueFilter(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="">Overdue: All</option>
                <option value="on_time">On time</option>
                <option value="reminder">Reminder</option>
                <option value="overdue">Overdue</option>
                <option value="escalated">Escalated</option>
              </select>
              {activeFilters > 0 ? (
                <Button size="sm" tone="tertiary" onClick={clearFilters}>
                  Clear
                </Button>
              ) : null}
            </div>
          </div>
          <div style={scopeRowStyle}>
            <input
              type="text"
              placeholder="Location id"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              aria-label="Location id"
              style={scopeInputStyle}
            />
            <input
              type="text"
              placeholder="Supervisor membership id"
              value={supervisorMembershipId}
              onChange={(e) => setSupervisorMembershipId(e.target.value)}
              aria-label="Supervisor membership id"
              style={scopeInputStyle}
            />
            <Button size="sm" tone="secondary" onClick={() => void load()}>
              Apply scope
            </Button>
          </div>
        </div>
      }
      table={
        filteredRows.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title={activeFilters > 0 ? "No matching clinicians" : "No clinicians on the board"}
              description={
                activeFilters > 0
                  ? "Try adjusting the board filters."
                  : "The server returned no rows for this safety scope."
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
                  <th style={{ ...thStyle, width: "18%" }}>Clinician</th>
                  <th style={{ ...thStyle, width: "17%" }}>Visit</th>
                  <th style={{ ...thStyle, width: "16%" }}>Check-in</th>
                  <th style={{ ...thStyle, width: "14%" }}>Next due</th>
                  <th style={{ ...thStyle, width: "12%" }}>Overdue</th>
                  <th style={{ ...thStyle, width: "13%" }}>Last heard</th>
                  <th style={{ ...thStyle, width: "10%", textAlign: "right" }}>Flags</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((row) => (
                  <SafetyRow key={row.membershipId} row={row} />
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
              pageSizeOptions={PAGE_SIZES}
              noun="clinicians"
            />
          </div>
        )
      }
      fullPageScroll
    />
  );
}

function SafetyRow({ row }: { row: SafetyClinicianStatusView }): JSX.Element {
  return (
    <tr style={rowStyle}>
      <td style={tdStyle}>
        <div style={primaryCellStyle}>
          <span style={primaryTextStyle}>{row.displayName}</span>
          <code className="wx-data-md" style={codeStyle}>
            {shortId(row.membershipId)}
          </code>
        </div>
      </td>
      <td style={tdStyle}>
        {row.currentVisitId ? (
          <div style={primaryCellStyle}>
            <code className="wx-data-md" style={codeStyle}>
              {shortId(row.currentVisitId)}
            </code>
            {row.currentPatientFirstName ? (
              <span style={secondaryTextStyle}>{row.currentPatientFirstName}</span>
            ) : null}
          </div>
        ) : (
          <span style={secondaryTextStyle}>Not on a visit</span>
        )}
      </td>
      <td style={tdStyle}>
        {row.lastCheckInStatus ? (
          <CheckInStatusPill status={row.lastCheckInStatus} />
        ) : (
          "None today"
        )}
        {row.lastCheckInAt ? (
          <div style={secondaryTextStyle}>{dateTime(row.lastCheckInAt)}</div>
        ) : null}
      </td>
      <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
        {dateTime(row.nextExpectedCheckInAt)}
      </td>
      <td style={tdStyle}>
        <OverduePill state={row.overdueState} />
      </td>
      <td style={tdStyle}>
        {row.lastKnownLocation ? (
          <div style={primaryCellStyle}>
            <span>{locationSourceLabel(row.lastKnownLocation.source)}</span>
            <span
              style={
                isLocationStale(row.lastKnownLocation.ageMinutes)
                  ? { ...secondaryTextStyle, color: "var(--color-warning)" }
                  : secondaryTextStyle
              }
            >
              {durationLabel(row.lastKnownLocation.ageMinutes)}
            </span>
          </div>
        ) : (
          <span style={secondaryTextStyle}>No position on record</span>
        )}
      </td>
      <td style={{ ...tdStyle, textAlign: "right" }}>
        <div style={flagWrapStyle}>
          {row.activeSosAlert ? (
            <Link to={`/safety/sos/${row.activeSosAlert.id}`} style={{ textDecoration: "none" }}>
              <SosStatePill state={row.activeSosAlert.lifecycleState} />
            </Link>
          ) : null}
          {row.inHighRiskArea ? (
            <StatusPill
              label={`Flagged area - ${humanize(row.inHighRiskArea.riskCategory)}`}
              tone="warning"
            />
          ) : null}
          {row.gpsSpoofSuspected ? <StatusPill label="GPS spoof" tone="warning" /> : null}
          {!row.activeSosAlert && !row.inHighRiskArea && !row.gpsSpoofSuspected ? "—" : null}
        </div>
      </td>
    </tr>
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
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
};
const controlGroupStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap" as const,
};
const searchInputStyle = { minWidth: "16rem", height: "2.25rem", fontSize: "0.85rem" };
const selectStyle = { height: "2.25rem", fontSize: "0.85rem", cursor: "pointer" };
const scopeRowStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
  alignItems: "center",
  gap: "0.5rem",
};
const scopeInputStyle = {
  minWidth: "14rem",
  height: "2.25rem",
  fontFamily: "var(--font-mono)",
  fontSize: "0.8rem",
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
const flagWrapStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
  justifyContent: "flex-end",
  gap: "0.35rem",
};
