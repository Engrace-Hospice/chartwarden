// apps/web/src/modules/20-field-safety — §5.1 "CHECK-IN LEDGER" (`/safety/check-ins`, Track B/ADR-0030).
//
// M20 publishes no org-wide check-in history route. This screen shows the current dashboard snapshot and
// offers the one audited by-id check-in read.
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
import type { JSX, ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  type SafetyCheckInView,
  type SafetyClinicianStatusView,
  type SafetyDashboardView,
  errorMessage,
  getCheckIn,
  getDashboard,
} from "./safety-api";
import { dateTime, durationLabel, humanize, minutesSince, shortId } from "./safety-status";
import { CheckInStatusPill, Notice, OverduePill } from "./safety-ui";

const ANY = "";
const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function CheckInLedgerScreen(): JSX.Element {
  const client = useApiClient();
  const [board, setBoard] = useState<SafetyDashboardView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [status, setStatus] = useState(ANY);
  const [rung, setRung] = useState(ANY);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [lookupId, setLookupId] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const [found, setFound] = useState<SafetyCheckInView | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getDashboard(client, {});
    if (res.error || !res.board) {
      setError(errorMessage(res.error, "The check-in ledger could not be read."));
      setBoard(null);
    } else {
      setBoard(res.board);
      setError(null);
    }
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const lookup = useCallback(async () => {
    const id = lookupId.trim();
    if (!id) return;
    setLookingUp(true);
    setLookupError(null);
    const res = await getCheckIn(client, id);
    setLookingUp(false);
    if (res.error || !res.checkIn) {
      setFound(null);
      setLookupError(
        errorMessage(
          res.error,
          "No check-in with that id is readable by you. The server does not distinguish absent from out of reach.",
        ),
      );
      return;
    }
    setFound(res.checkIn);
  }, [client, lookupId]);

  const rows = useMemo(() => {
    const needle = name.trim().toLowerCase();
    return [...(board?.clinicians ?? [])]
      .filter((row) => (needle ? row.displayName.toLowerCase().includes(needle) : true))
      .filter((row) => (status ? row.lastCheckInStatus === status : true))
      .filter((row) => (rung ? row.overdueState === rung : true))
      .sort(
        (a, b) =>
          Number(b.overdueState !== "on_time") - Number(a.overdueState !== "on_time") ||
          a.displayName.localeCompare(b.displayName),
      );
  }, [board, name, rung, status]);

  const activePage = Math.min(page, Math.max(1, Math.ceil(rows.length / pageSize)));
  const pagedRows = rows.slice((activePage - 1) * pageSize, activePage * pageSize);
  const activeFilters = [name.trim() !== "", status !== ANY, rung !== ANY].filter(Boolean).length;

  const clearFilters = (): void => {
    setName("");
    setStatus(ANY);
    setRung(ANY);
    setPage(1);
  };

  if (loading && !board) {
    return (
      <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
        <LoadingSpinner />
      </div>
    );
  }

  if (!board) {
    return (
      <div style={{ padding: "2rem 1.5rem" }}>
        <EmptyState
          title="Check-in ledger unavailable"
          description={
            error ??
            "The read did not answer. Treat this as unknown; an empty check-in ledger and an unreachable one mean opposite things."
          }
        />
      </div>
    );
  }

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Check-in Status"
          breadcrumb="Field safety"
          actions={
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              <Link to="/safety" style={linkButtonStyle}>
                Safety board
              </Link>
              <Button type="button" tone="secondary" onClick={() => void load()} loading={loading}>
                Refresh
              </Button>
            </div>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Current board snapshot as of {dateTime(board.fetchedAt)}. Individual check-ins are read
            by ID below.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          {error ? (
            <Notice tone="warning" live>
              {error} The table below is the last snapshot that answered.
            </Notice>
          ) : null}
          <div role="note" style={noteStyle}>
            <StatusPill label="Snapshot only" tone="neutral" />
            <span>
              This answers who is behind right now. M20 has no supervisor-facing historical check-in
              list route.
            </span>
          </div>
          <div style={toolbarStyle}>
            <div style={toolbarTitleStyle}>
              <span style={toolbarEyebrowStyle}>Clinician snapshot</span>
              <strong>
                {rows.length} matching clinicians · {board.overdueCount} overdue by server snapshot
              </strong>
            </div>
            <div style={controlGroupStyle}>
              <input
                type="search"
                placeholder="Search clinician..."
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setPage(1);
                }}
                aria-label="Search clinician"
                style={searchInputStyle}
              />
              <select
                aria-label="Last check-in status"
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value={ANY}>Status: Any</option>
                <option value="ok">I'm OK</option>
                <option value="concerned_continue">Concerned - continuing</option>
                <option value="concerned_stop">Not OK - stopping</option>
              </select>
              <select
                aria-label="Overdue rung"
                value={rung}
                onChange={(event) => {
                  setRung(event.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value={ANY}>Rung: Any</option>
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
        </div>
      }
      table={
        <div style={tableWrapStyle}>
          {rows.length === 0 ? (
            <div style={{ padding: "2rem 0" }}>
              <EmptyState
                title="No matching clinicians"
                description="No clinician matches these filters in the current snapshot."
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
            <>
              <table style={tableStyle}>
                <thead>
                  <tr style={headerRowStyle}>
                    <th style={{ ...thStyle, width: "22%" }}>Clinician</th>
                    <th style={{ ...thStyle, width: "18%" }}>Last check-in</th>
                    <th style={{ ...thStyle, width: "16%" }}>Status</th>
                    <th style={{ ...thStyle, width: "18%" }}>Next expected</th>
                    <th style={{ ...thStyle, width: "12%" }}>Rung</th>
                    <th style={{ ...thStyle, width: "14%", textAlign: "right" }}>Currently</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map((row) => (
                    <CheckInSnapshotRow key={row.membershipId} row={row} />
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
                pageSizeOptions={PAGE_SIZES}
                noun="clinicians"
              />
            </>
          )}
          <LookupPanel
            lookupId={lookupId}
            onLookupIdChange={setLookupId}
            lookingUp={lookingUp}
            onLookup={lookup}
            lookupError={lookupError}
            found={found}
          />
        </div>
      }
      fullPageScroll
    />
  );
}

function CheckInSnapshotRow({ row }: { row: SafetyClinicianStatusView }): JSX.Element {
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
        {row.lastCheckInAt ? (
          <div style={primaryCellStyle}>
            <span>{dateTime(row.lastCheckInAt)}</span>
            <span style={secondaryTextStyle}>
              {durationLabel(minutesSince(row.lastCheckInAt))} ago
            </span>
          </div>
        ) : (
          <span style={secondaryTextStyle}>None on record</span>
        )}
      </td>
      <td style={tdStyle}>
        {row.lastCheckInStatus ? (
          <CheckInStatusPill status={row.lastCheckInStatus} />
        ) : (
          <span style={secondaryTextStyle}>—</span>
        )}
      </td>
      <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
        {dateTime(row.nextExpectedCheckInAt)}
      </td>
      <td style={tdStyle}>
        <OverduePill state={row.overdueState} />
      </td>
      <td style={{ ...tdStyle, textAlign: "right" }}>
        {row.activeSosAlert ? (
          <Link to={`/safety/sos/${row.activeSosAlert.id}`} style={{ textDecoration: "none" }}>
            <StatusPill label="Active SOS" tone="critical" />
          </Link>
        ) : row.currentVisitId ? (
          <code className="wx-data-md" style={codeStyle}>
            {shortId(row.currentVisitId)}
          </code>
        ) : (
          <span style={secondaryTextStyle}>Not on a visit</span>
        )}
      </td>
    </tr>
  );
}

function LookupPanel({
  lookupId,
  onLookupIdChange,
  lookingUp,
  onLookup,
  lookupError,
  found,
}: {
  lookupId: string;
  onLookupIdChange: (value: string) => void;
  lookingUp: boolean;
  onLookup: () => void;
  lookupError: string | null;
  found: SafetyCheckInView | null;
}): JSX.Element {
  return (
    <section style={lookupSectionStyle}>
      <div style={toolbarStyle}>
        <div style={toolbarTitleStyle}>
          <span style={toolbarEyebrowStyle}>Read one check-in</span>
          <strong>Audited by-id lookup</strong>
        </div>
        <div style={controlGroupStyle}>
          <input
            type="text"
            placeholder="Check-in id"
            value={lookupId}
            onChange={(event) => onLookupIdChange(event.target.value)}
            aria-label="Check-in id"
            style={monoInputStyle}
          />
          <Button
            size="sm"
            tone="secondary"
            disabled={lookingUp || lookupId.trim().length === 0}
            onClick={() => onLookup()}
          >
            {lookingUp ? "Reading..." : "Read"}
          </Button>
        </div>
      </div>
      <Notice tone="warning">
        Reading one check-in can return the clinician's own concern note. That read is the audited
        path for suppression review.
      </Notice>
      {lookupError ? (
        <Notice tone="error" assertive>
          {lookupError}
        </Notice>
      ) : null}
      {found ? (
        <div style={detailGridStyle}>
          <DetailField label="Check-in" value={shortId(found.id)} mono />
          <DetailField label="Posted" value={dateTime(found.postedAt)} />
          <DetailField label="Kind" value={humanize(found.kind)} />
          <DetailField label="Status" value={<CheckInStatusPill status={found.status} />} />
          <DetailField label="Posted by" value={shortId(found.postedByMembershipId)} mono />
          <DetailField label="Visit" value={found.visitId ? shortId(found.visitId) : "None"} mono />
          <DetailField
            label="Coordinate captured"
            value={found.coordinatesCaptured ? "Yes (not shown here)" : "No"}
          />
          <DetailField label="SOS bracket" value={found.isPartOfSosBracket ? "Yes" : "No"} />
          <DetailField
            label="Amendable until"
            value={found.amendableUntil ? dateTime(found.amendableUntil) : "Grace has closed"}
          />
          <DetailField
            label="Superseded"
            value={
              found.supersededAt
                ? `${dateTime(found.supersededAt)} by ${
                    found.supersededByCheckInId ? shortId(found.supersededByCheckInId) : "unknown"
                  }`
                : "No"
            }
          />
          {found.concernNote ? (
            <div style={{ gridColumn: "1 / -1" }}>
              <Notice tone="warning">
                <strong>Her note:</strong> {found.concernNote}
              </Notice>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function DetailField({
  label,
  value,
  mono,
}: { label: string; value: ReactNode; mono?: boolean }): JSX.Element {
  return (
    <div style={primaryCellStyle}>
      <span style={detailLabelStyle}>{label}</span>
      <span style={mono ? { fontFamily: "var(--font-mono)" } : undefined}>{value}</span>
    </div>
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
const monoInputStyle = {
  minWidth: "16rem",
  height: "2.25rem",
  fontSize: "0.85rem",
  fontFamily: "var(--font-mono)",
};
const selectStyle = { height: "2.25rem", fontSize: "0.85rem", cursor: "pointer" };
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
const lookupSectionStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
  paddingTop: "1rem",
};
const detailGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))",
  gap: "0.75rem 1rem",
};
const detailLabelStyle = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.7rem",
  fontWeight: 650,
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
};
