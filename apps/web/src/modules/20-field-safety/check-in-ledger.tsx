// apps/web/src/modules/20-field-safety — §5.1 "CHECK-IN LEDGER" (`/safety/check-ins`, Track B/ADR-0030).
//
// ── §4.1 PUBLISHES NO ORG-WIDE CHECK-IN LIST, AND THIS SCREEN SAYS SO RATHER THAN FAKING ONE ─────────
//
// §5.1 asks for a "searchable check-in ledger; filter by clinician, date range, status, kind". The four
// check-in routes are: POST one, GET one BY ID, PATCH one, and GET **my own** day. There is no
// supervisor-facing list of `safety_check_in` rows anywhere in the §4.1 inventory, and inventing one here
// is not something a screen task may do — a route is a permission surface, an audit surface and an RLS
// surface, and adding one from the UI side would create all three unreviewed.
//
// So this screen is built from the two reads that DO exist, and is explicit about which question each
// answers:
//
//   1. **The board's check-in column, widened.** `GET /safety/dashboard` returns, per clinician, her last
//      check-in, its status, her next expected one and her D4 overdue rung. That is a CURRENT-STATE
//      ledger — "who is behind right now" — and it is the question a supervisor actually opens this page
//      with. It is filterable by clinician name, status and rung, all page-local over one snapshot.
//   2. **One row, by id.** `GET /safety/check-ins/:id` is the only way to read an individual check-in,
//      including its `concernNote` (§3.6-denylisted free text, audited on read) and its five-minute
//      amendment grace. The lookup box is here because §7.2's suppression review is exactly this: a
//      supervisor sees a suppression on the board and clicks through for the reason.
//
// What is NOT here, and would be the lie: a date-ranged HISTORY of everybody's check-ins. Rendering the
// snapshot under a "history" heading would let a reviewer conclude that a clinician posted nothing last
// Tuesday when in fact nobody asked.
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import {
  type SafetyCheckInView,
  type SafetyDashboardView,
  errorMessage,
  getCheckIn,
  getDashboard,
} from "./safety-api";
import {
  dateTime,
  durationLabel,
  humanize,
  minutesSince,
  shortId,
} from "./safety-status";
import {
  Card,
  CheckInStatusPill,
  CountGrid,
  Field,
  FilterRow,
  Notice,
  OverduePill,
  SelectField,
  SummaryGrid,
  TextField,
  columnStyle,
  disabledButtonStyle,
  ghostButtonStyle,
  linkStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  th,
} from "./safety-ui";

const ANY = "";

export function CheckInLedgerScreen(): JSX.Element {
  const client = useApiClient();
  const [board, setBoard] = useState<SafetyDashboardView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [status, setStatus] = useState(ANY);
  const [rung, setRung] = useState(ANY);

  // The by-id lookup (read 2 in the header).
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
          "No check-in with that id is readable by you. The server does not distinguish 'absent' from 'out of reach'.",
        ),
      );
      return;
    }
    setFound(res.checkIn);
  }, [client, lookupId]);

  const rows = useMemo(() => {
    const needle = name.trim().toLowerCase();
    return [...(board?.clinicians ?? [])]
      .filter((c) => (needle ? c.displayName.toLowerCase().includes(needle) : true))
      .filter((c) => (status ? c.lastCheckInStatus === status : true))
      .filter((c) => (rung ? c.overdueState === rung : true))
      .sort(
        (a, b) =>
          Number(b.overdueState !== "on_time") - Number(a.overdueState !== "on_time") ||
          a.displayName.localeCompare(b.displayName),
      );
  }, [board, name, rung, status]);

  if (loading) return <LoadingSpinner />;
  if (!board)
    return (
      <EmptyState
        title="Check-in ledger unavailable"
        description={
          error ??
          "The read did not answer. Treat this as unknown — an empty check-in ledger and an unreachable one look identical and mean opposite things."
        }
      />
    );

  const concerned = rows.filter(
    (r) => r.lastCheckInStatus === "concerned_continue" || r.lastCheckInStatus === "concerned_stop",
  ).length;
  const never = rows.filter((r) => r.lastCheckInAt === null).length;

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Check-in status</span>}
        breadcrumb="Field safety"
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <Link to="/safety" style={ghostButtonStyle}>
              Safety board
            </Link>
            <button type="button" onClick={() => void load()} style={ghostButtonStyle}>
              Refresh
            </button>
          </div>
        }
      />

      <Notice tone="info" live>
        This page answers <strong>"who is behind right now"</strong>, not "who checked in last Tuesday".
        M20 publishes no org-wide check-in history route — the four §4.1 check-in rows are post, read-one,
        amend, and each clinician's own day — so a date-ranged ledger would have to be invented, and a
        snapshot presented as history is how a reviewer concludes somebody posted nothing when in fact
        nobody asked. Individual rows are readable by id below.
      </Notice>

      <Card title="Snapshot">
        <CountGrid
          entries={[
            { label: "Clinicians", value: rows.length },
            {
              label: "Overdue (server count)",
              value: board.overdueCount,
              tone: board.overdueCount > 0 ? "error" : undefined,
            },
            {
              label: "Last check-in was a concern",
              value: concerned,
              tone: concerned > 0 ? "warning" : undefined,
            },
            {
              label: "No check-in on record",
              value: never,
              tone: never > 0 ? "warning" : undefined,
            },
          ]}
        />
        <span style={mutedStyle}>
          As of {dateTime(board.fetchedAt)}. The overdue figure is the SERVER's, over the same snapshot as
          the rows; the other three count the rows shown after the filters below.
        </span>
      </Card>

      <Card title="Filters">
        <FilterRow>
          <TextField label="Clinician name contains" value={name} onChange={setName} />
          <SelectField
            label="Last status"
            value={status}
            options={[
              { value: ANY, label: "Any" },
              { value: "ok", label: "I'm OK" },
              { value: "concerned_continue", label: "Concerned — continuing" },
              { value: "concerned_stop", label: "Not OK — stopping" },
            ]}
            onChange={setStatus}
          />
          <SelectField
            label="Overdue rung"
            value={rung}
            options={[
              { value: ANY, label: "Any" },
              { value: "on_time", label: "On time" },
              { value: "reminder", label: "Reminder" },
              { value: "overdue", label: "Overdue" },
              { value: "escalated", label: "Escalated" },
            ]}
            onChange={setRung}
          />
        </FilterRow>
        <span style={mutedStyle}>
          All three narrow the snapshot in the browser. None of them re-queries, because the board read
          takes no such parameter — they are honest about being a view over one answer rather than a
          search.
        </span>
      </Card>

      <Card title="Clinicians">
        {rows.length === 0 ? (
          <span style={mutedStyle}>No clinician matches these filters in the current snapshot.</span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Clinician</th>
                <th style={th}>Last check-in</th>
                <th style={th}>Status</th>
                <th style={th}>Next expected</th>
                <th style={th}>Rung</th>
                <th style={th}>Currently</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.membershipId} style={rowLine}>
                  <td style={td}>
                    {r.displayName}
                    <div style={{ ...mutedStyle, fontFamily: t.fontMono }}>
                      {shortId(r.membershipId)}
                    </div>
                  </td>
                  <td style={td}>
                    {r.lastCheckInAt ? (
                      <>
                        {dateTime(r.lastCheckInAt)}
                        <div style={mutedStyle}>
                          {durationLabel(minutesSince(r.lastCheckInAt))} ago
                        </div>
                      </>
                    ) : (
                      <span style={mutedStyle}>None on record</span>
                    )}
                  </td>
                  <td style={td}>
                    {r.lastCheckInStatus ? (
                      <CheckInStatusPill status={r.lastCheckInStatus} />
                    ) : (
                      <span style={mutedStyle}>—</span>
                    )}
                  </td>
                  <td style={td}>{dateTime(r.nextExpectedCheckInAt)}</td>
                  <td style={td}>
                    <OverduePill state={r.overdueState} />
                  </td>
                  <td style={td}>
                    {r.activeSosAlert ? (
                      <Link to={`/safety/sos/${r.activeSosAlert.id}`} style={linkStyle}>
                        <StatusPill label="Active SOS" tone="critical" />
                      </Link>
                    ) : r.currentVisitId ? (
                      <span style={{ fontFamily: t.fontMono }}>{shortId(r.currentVisitId)}</span>
                    ) : (
                      <span style={mutedStyle}>Not on a visit</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Read one check-in">
        <FilterRow>
          <TextField
            label="Check-in id"
            value={lookupId}
            onChange={setLookupId}
            mono
            hint="From a §7.2 suppression on the board, or from an incident review."
          />
          <button
            type="button"
            onClick={() => void lookup()}
            disabled={lookingUp || lookupId.trim().length === 0}
            style={lookingUp || lookupId.trim().length === 0 ? disabledButtonStyle : primaryButtonStyle}
          >
            {lookingUp ? "Reading…" : "Read"}
          </button>
        </FilterRow>
        <Notice tone="warning">
          Reading one check-in writes an <strong>audit entry naming you</strong>, and it can return the
          clinician's own <code>concernNote</code> — including a §7.2 suppression reason ("patient
          sleeping; don't disturb"). That text is denylisted from the write-audit trail precisely so it is
          not copied around; reading it here is the audited path §7.2 describes, not a way around it.
        </Notice>
        {lookupError ? (
          <Notice tone="error" assertive>
            {lookupError}
          </Notice>
        ) : null}
        {found ? (
          <>
            <SummaryGrid>
              <Field label="Check-in" value={shortId(found.id)} mono />
              <Field label="Posted" value={dateTime(found.postedAt)} />
              <Field label="Kind" value={humanize(found.kind)} />
              <Field label="Status" value={<CheckInStatusPill status={found.status} />} />
              <Field label="Posted by" value={shortId(found.postedByMembershipId)} mono />
              <Field
                label="Visit"
                value={found.visitId ? shortId(found.visitId) : "None"}
                mono={found.visitId !== null}
              />
              <Field
                label="Coordinate captured"
                value={found.coordinatesCaptured ? "Yes (not shown here)" : "No"}
              />
              <Field label="Part of an SOS bracket" value={found.isPartOfSosBracket ? "Yes" : "No"} />
              <Field
                label="Amendable until"
                value={found.amendableUntil ? dateTime(found.amendableUntil) : "Grace has closed"}
              />
              <Field
                label="Superseded"
                value={
                  found.supersededAt
                    ? `${dateTime(found.supersededAt)} by ${shortId(found.supersededByCheckInId)}`
                    : "No"
                }
              />
              <Field
                label="Corrects"
                value={found.correctsCheckInId ? shortId(found.correctsCheckInId) : "—"}
                mono={found.correctsCheckInId !== null}
              />
            </SummaryGrid>
            {found.concernNote ? (
              <Notice tone="warning">
                <strong>Her note:</strong> {found.concernNote}
              </Notice>
            ) : (
              <span style={mutedStyle}>No note on this check-in.</span>
            )}
            {found.coordinatesCaptured ? (
              <span style={mutedStyle}>
                A coordinate was captured with this check-in and is NOT shown: no check-in read on the
                platform returns one. D11 keeps non-SOS coordinates out of every projection, so the only
                coordinate surface in M20 is an SOS's own stream, behind its own permission.
              </span>
            ) : null}
          </>
        ) : null}
      </Card>
    </div>
  );
}
