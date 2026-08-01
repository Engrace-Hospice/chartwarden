// apps/web/src/modules/20-field-safety — §5.1 "SAFETY DASHBOARD" (`/safety`, Track B / ADR-0030).
//
// The supervisor live-awareness board: every field-eligible clinician with her last-known-location
// staleness, her last check-in, her next expected one, and the four badges §5.1 names — active SOS,
// high-risk area, GPS-spoof-suspected, and the D4 overdue rung.
//
// ── THERE ARE NO COORDINATES ON THIS SCREEN, AND THAT IS A TYPE FACT, NOT A CHOICE MADE HERE ─────────
//
// `SafetyLastKnownLocationDto` carries a SOURCE and an AGE and no latitude, so rendering this board can
// never trip the `safety.sos.read_coords` permission or its warn-severity audit row. D6's boundary is
// expressed as the shape of the DTO: there is no field on it to put a coordinate in. The map §5.1's UI
// sketch asks for is therefore NOT built — a map with no coordinates would be a decoration, and one with
// them would move the coordinate boundary from the type system into a component. The stream is reachable
// from a single SOS's own detail page, behind its own permission, its own predicate and its own audit row.
//
// ── THE THIRD STATE IS THE POINT (the M19-T08 rule) ──────────────────────────────────────────────────
//
// A failed board read renders as UNKNOWN, in amber, saying so. It does NOT render as an empty grid: an
// empty safety board reads identically to "everyone is fine", which is the one wrong answer a live-
// awareness surface must never give. `SafetyDashboardProvider`'s own §4.3 header states the same rule for
// the seam; this is that rule at the glass.
//
// ── AUTO-REFRESH IS A POLL, NOT A SOCKET, AND THE SCREEN SAYS WHICH ──────────────────────────────────
//
// §5.1 asks for Socket.IO `org:<orgId>` push. M20 publishes no socket channel to this client, so the
// board polls `/safety/dashboard` on a fixed interval and stamps every render with the server's own
// `fetchedAt`. Presenting a 30-second poll as "realtime" would be a claim the app cannot honour, and on a
// safety board the difference between "as of 30 seconds ago" and "now" is the whole product.
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { type SafetyDashboardView, errorMessage, getDashboard } from "./safety-api";
import {
  LOCATION_STALE_MINUTES,
  dateTime,
  durationLabel,
  humanize,
  isLocationStale,
  locationSourceLabel,
  minutesSince,
  shortId,
} from "./safety-status";
import {
  Card,
  CheckInStatusPill,
  CountGrid,
  FilterRow,
  Notice,
  OverduePill,
  SosStatePill,
  TextField,
  columnStyle,
  ghostButtonStyle,
  linkStyle,
  mutedStyle,
  pageTitleStyle,
  rowLine,
  tableStyle,
  td,
  tdNum,
  th,
  thNum,
} from "./safety-ui";

/** The poll cadence. Deliberately slower than §9.7's 200 ms realtime target and deliberately STATED on
 *  the screen — see the module header on why calling a poll "realtime" would be a lie. */
const POLL_MS = 30_000;

/** The board's three states. `unknown` is not an error state to be dismissed; it is a finding. */
type BoardState = "ready" | "unknown";

export function SafetyDashboardScreen(): JSX.Element {
  const client = useApiClient();
  const [board, setBoard] = useState<SafetyDashboardView | null>(null);
  const [state, setState] = useState<BoardState>("unknown");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [locationId, setLocationId] = useState("");
  const [supervisorMembershipId, setSupervisorMembershipId] = useState("");

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
        // An unreadable board stays UNKNOWN. The previous snapshot is kept on screen with its own
        // timestamp so a supervisor can see how old it is — but the banner above it says the refresh
        // failed, because a stale board presented as current is the same failure as an empty one.
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

  const rows = useMemo(() => {
    const list = [...(board?.clinicians ?? [])];
    // Sort by urgency, not by name: an active SOS, then the D4 rung, then a stale position. A board a
    // supervisor scans top-down must put the person in trouble at the top of it.
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

  if (loading && board === null) return <LoadingSpinner />;
  if (board === null)
    return (
      <EmptyState
        title="Safety board unavailable"
        description={
          error ??
          "The board did not answer. This is NOT 'everyone is fine' — treat it as unknown and check by phone."
        }
      />
    );

  const spoofed = rows.filter((r) => r.gpsSpoofSuspected).length;
  const inArea = rows.filter((r) => r.inHighRiskArea !== null).length;
  const stale = rows.filter((r) => isLocationStale(r.lastKnownLocation?.ageMinutes)).length;
  const noPosition = rows.filter((r) => r.lastKnownLocation === null).length;

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Field safety board</span>}
        breadcrumb="Field safety"
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <Link to="/safety/sos" style={ghostButtonStyle}>
              Active SOS
            </Link>
            <Link to="/safety/incidents" style={ghostButtonStyle}>
              Incidents
            </Link>
            <button type="button" onClick={() => void load()} style={ghostButtonStyle}>
              Refresh now
            </button>
          </div>
        }
      />

      {state === "unknown" ? (
        <Notice tone="warning" assertive>
          <strong>This board did not refresh.</strong> {error} What you see below is the last snapshot
          that DID answer, taken at {dateTime(board.fetchedAt)}. Do not read it as current, and do not read
          a quiet board as a safe one.
        </Notice>
      ) : null}

      <Card title="Right now">
        <CountGrid
          entries={[
            { label: "Clinicians on the board", value: rows.length },
            {
              label: "Active SOS",
              value: board.activeSosCount,
              tone: board.activeSosCount > 0 ? "critical" : undefined,
            },
            {
              label: "Overdue check-ins",
              value: board.overdueCount,
              tone: board.overdueCount > 0 ? "error" : undefined,
            },
            { label: "In a flagged area", value: inArea, tone: inArea > 0 ? "warning" : undefined },
            {
              label: "GPS spoof suspected",
              value: spoofed,
              tone: spoofed > 0 ? "warning" : undefined,
            },
            { label: "Position > 1h old", value: stale, tone: stale > 0 ? "warning" : undefined },
          ]}
        />
        <span style={mutedStyle}>
          Server snapshot at <strong>{dateTime(board.fetchedAt)}</strong>, refreshed every{" "}
          {POLL_MS / 1000} seconds by polling — this screen holds no live socket, so treat every figure as
          "as of" rather than "now". The SOS and overdue counts are the SERVER's, computed over the same
          snapshot as the grid, so the tiles and the rows can never disagree.
        </span>
      </Card>

      <Card title="Scope">
        <FilterRow>
          <TextField
            label="Location id"
            value={locationId}
            onChange={setLocationId}
            placeholder="all locations in reach"
            mono
          />
          <TextField
            label="Supervisor membership id"
            value={supervisorMembershipId}
            onChange={setSupervisorMembershipId}
            placeholder="my own subscriptions"
            mono
          />
          <button type="button" onClick={() => void load()} style={ghostButtonStyle}>
            Apply
          </button>
        </FilterRow>
        <span style={mutedStyle}>
          These two select which of §4.3's two board reads the server makes — by location, or by a
          supervisor's own subscription set. Neither WIDENS anything: a clinician outside your reach is
          absent from the answer whatever you type here, and a clinician with no supervisory grant sees
          exactly one row, her own. They are ids rather than pickers because M20 publishes no location or
          membership directory; M2/M40 own those and M20 holds no reader for either.
        </span>
      </Card>

      <Card title="Clinicians">
        {rows.length === 0 ? (
          <Notice tone="warning" live>
            The board came back with <strong>no rows</strong>. That is not the same as "nobody is in the
            field": it means nobody in your scope has a safety row right now. If you expect clinicians
            here, check the supervisor-subscription matrix — an unsubscribed clinician is exactly what the
            §7.8 coverage watchdog exists to find.
          </Notice>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Clinician</th>
                <th style={th}>Visit</th>
                <th style={th}>Check-in</th>
                <th style={th}>Next due</th>
                <th style={th}>Overdue</th>
                <th style={th}>Last heard</th>
                <th style={thNum}>Age</th>
                <th style={th}>Flags</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.membershipId} style={rowLine}>
                  <td style={td}>{r.displayName}</td>
                  <td style={td}>
                    {r.currentVisitId ? (
                      <>
                        <span style={{ fontFamily: t.fontMono }}>{shortId(r.currentVisitId)}</span>
                        {r.currentPatientFirstName ? ` · ${r.currentPatientFirstName}` : ""}
                      </>
                    ) : (
                      <span style={mutedStyle}>Not on a visit</span>
                    )}
                  </td>
                  <td style={td}>
                    {r.lastCheckInStatus ? (
                      <CheckInStatusPill status={r.lastCheckInStatus} />
                    ) : (
                      <span style={mutedStyle}>None today</span>
                    )}
                    {r.lastCheckInAt ? (
                      <div style={mutedStyle}>{dateTime(r.lastCheckInAt)}</div>
                    ) : null}
                  </td>
                  <td style={td}>{dateTime(r.nextExpectedCheckInAt)}</td>
                  <td style={td}>
                    <OverduePill state={r.overdueState} />
                  </td>
                  <td style={td}>
                    {r.lastKnownLocation ? (
                      <>
                        {locationSourceLabel(r.lastKnownLocation.source)}
                        <div style={mutedStyle}>{dateTime(r.lastKnownLocation.sampledAt)}</div>
                      </>
                    ) : (
                      // "No position" is NOT "an old position". A clinician who has never checked in
                      // today and one whose last ping was two hours ago need different phone calls.
                      <span style={mutedStyle}>No position on record</span>
                    )}
                  </td>
                  <td style={tdNum}>
                    {r.lastKnownLocation ? (
                      <span
                        style={
                          isLocationStale(r.lastKnownLocation.ageMinutes)
                            ? { color: t.warning }
                            : undefined
                        }
                      >
                        {durationLabel(r.lastKnownLocation.ageMinutes)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={td}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem" }}>
                      {r.activeSosAlert ? (
                        <Link to={`/safety/sos/${r.activeSosAlert.id}`} style={linkStyle}>
                          <SosStatePill state={r.activeSosAlert.lifecycleState} />
                        </Link>
                      ) : null}
                      {r.inHighRiskArea ? (
                        <StatusPill
                          label={`Flagged area — ${humanize(r.inHighRiskArea.riskCategory)}`}
                          tone="warning"
                        />
                      ) : null}
                      {r.gpsSpoofSuspected ? (
                        <StatusPill label="GPS spoof suspected" tone="warning" />
                      ) : null}
                      {!r.activeSosAlert && !r.inHighRiskArea && !r.gpsSpoofSuspected ? (
                        <span style={mutedStyle}>—</span>
                      ) : null}
                    </div>
                    {r.inHighRiskArea ? (
                      <div style={mutedStyle}>{r.inHighRiskArea.advisoryMessage}</div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <span style={mutedStyle}>
          A position older than {LOCATION_STALE_MINUTES} minutes is shown in amber; "No position on
          record" is a different fact and reads differently on purpose. {noPosition} row
          {noPosition === 1 ? " has" : "s have"} no position at all. The high-risk-area badge is{" "}
          <strong>advisory</strong> (D12) — it blocks no visit and never has; it exists so the person
          scanning this grid knows to ring first.
        </span>
      </Card>

      <Card title="What this board deliberately does not show">
        <span style={mutedStyle}>
          <strong>No coordinates, and no map.</strong> Every row answers "when did we last hear from her,
          and how" — which needs a timestamp and a source, not a latitude. The coordinate stream lives
          behind its own permission (<code>safety.sos.read_coords</code>), its own predicate, its own
          warn-severity audit row and — once an alert has closed — a written reason the clinician herself
          later sees on her consent surface. It is reachable from one SOS at a time, from that alert's
          page. A dot on a map here would have moved that boundary from the type system into a component.
        </span>
        <span style={mutedStyle}>
          <strong>No push.</strong> §5.1 sketches a Socket.IO room; M20 publishes none to this client, so
          this is a {POLL_MS / 1000}-second poll and says so above rather than claiming a realtime SLA it
          does not meet.
        </span>
      </Card>
    </div>
  );
}
