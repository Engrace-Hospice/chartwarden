// apps/web/src/modules/19-oncall — S19.13 "MY ON-CALL" (`/me/oncall`, §5.1 / §5.2, Track B / ADR-0030).
//
// The on-call clinician's own screen, and the one M19 surface designed mobile-first: §5.2 makes this the
// primary mobile view of a 12–24-hour shift. One question above the fold — am I on call right now? — then
// the queue, then the next window.
//
// "AM I ON CALL?" IS ANSWERED FROM THE LIVE COVERAGE READ, NOT FROM THE SCHEDULE. `GET /oncall/current`
// returns the actors the SERVER resolves as covering right now, per ProviderEntity; a shift row that says
// `active` is a schedule fact, and the two can disagree (a cron that did not run, a shift cancelled after
// the roster was fetched). The banner therefore reads the live verdict and falls back to the schedule only
// to say what is NEXT.
//
// THE BANNER HAS THREE STATES, NOT TWO. §5.2 sketches green-ON and grey-OFF; there is a third, and it is
// the one that matters: the read FAILED. "Off call" and "we could not tell you" are different facts, and
// a clinician who reads an outage as "off" turns their phone face-down. The third state is amber and says
// so.
//
// WHAT IS NOT BUILT, and why: §5.2's push notification, Do-Not-Disturb bypass and one-tap device dialer
// are Capacitor capabilities, not web ones — the native shell owns them (ADR-0035), and a web button
// labelled "call supervisor now" that opened nothing would be worse than its absence. The queue below is
// the same server-side board the supervisor sees, narrowed to what is open; M19 publishes no "assigned to
// me" filter because a triage call has no assignee column — the covering SHIFT is the assignment.
import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  t,
  useApiClient,
} from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { Link } from "react-router-dom";
import {
  type CurrentOnCallView,
  type OnCallShiftView,
  type TriageCallListItem,
  errorMessage,
  getCurrentOnCall,
  listShifts,
  listTriageCalls,
} from "./oncall-api";
import {
  dateTime,
  disciplineLabel,
  durationLabel,
  humanize,
  isWithinWindow,
  minutesSince,
  shortId,
} from "./oncall-status";
import {
  CallStatePill,
  Card,
  CountGrid,
  Field,
  Notice,
  SummaryGrid,
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
} from "./oncall-ui";

/** The banner's three states — the third is the point (see the header). */
type Coverage = "on" | "off" | "unknown";

export function MyOnCallScreen(): JSX.Element {
  const client = useApiClient();
  const [current, setCurrent] = useState<CurrentOnCallView | null>(null);
  const [coverage, setCoverage] = useState<Coverage>("unknown");
  const [shifts, setShifts] = useState<OnCallShiftView[]>([]);
  const [calls, setCalls] = useState<TriageCallListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [now, roster, board] = await Promise.all([
      getCurrentOnCall(client, {}),
      listShifts(client, { limit: 200 }),
      listTriageCalls(client, { openOnly: true, limit: 100 }),
    ]);
    if (now.error && roster.error) {
      setError(errorMessage(now.error, "Your on-call status could not be read."));
      setLoading(false);
      return;
    }
    setCurrent(now.current);
    // An UNREADABLE verdict stays `unknown`; only a successful read may say "off".
    setCoverage(
      now.current
        ? now.current.perProviderEntity.some((p) => p.actors.length > 0)
          ? "on"
          : "off"
        : "unknown",
    );
    setShifts(roster.page?.data ?? []);
    setCalls(board.page?.data ?? []);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  const activeShift =
    shifts.find((s) => s.status === "active" && isWithinWindow(s.shiftStartsAt, s.shiftEndsAt)) ??
    null;
  const nextShift =
    [...shifts]
      .filter((s) => s.status === "scheduled" && Date.parse(s.shiftStartsAt) > Date.now())
      .sort((a, b) => a.shiftStartsAt.localeCompare(b.shiftStartsAt))[0] ?? null;

  const board = [...calls].sort(
    (a, b) =>
      b.openEscalationCount - a.openEscalationCount ||
      b.redFlagAnswerCount - a.redFlagAnswerCount ||
      a.openedAt.localeCompare(b.openedAt),
  );

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="My on-call"
          breadcrumb="On-call triage"
          actions={
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <Link to="/triage/intake" style={primaryLinkButtonStyle}>
                Take a call
              </Link>
              <Link to="/triage" style={linkButtonStyle}>
                Full queue
              </Link>
            </div>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Live coverage, current shift context, and the open triage board for your on-call window.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          {coverage === "on" ? (
            <Notice tone="success" live>
              <strong>On call</strong>
              {activeShift ? ` until ${dateTime(activeShift.shiftEndsAt)}` : ""} — the server
              resolves a covering actor for your scope as of {dateTime(current?.asOf)}.
            </Notice>
          ) : coverage === "off" ? (
            <Notice tone="info" live>
              <strong>OFF</strong> — no actor is covering in your scope right now. That is the
              server's answer, read at {dateTime(current?.asOf)}, not an absence of data.
            </Notice>
          ) : (
            <Notice tone="warning" live>
              <strong>Coverage status unknown.</strong> The live read did not answer. This is NOT
              "off call" — do not treat it as one. Check the roster, and assume you are reachable
              until you know otherwise.
            </Notice>
          )}
        </div>
      }
      table={
        <div style={contentShellStyle}>
          <Card title={activeShift ? "Active shift" : nextShift ? "Next shift" : "Shift"}>
            {activeShift ? (
              <SummaryGrid>
                <Field
                  label="Shift"
                  value={
                    <Link to={`/triage/shifts/${activeShift.id}`} style={linkStyle}>
                      {shortId(activeShift.id)}
                    </Link>
                  }
                />
                <Field label="Discipline" value={disciplineLabel(activeShift.discipline)} />
                <Field
                  label="Started"
                  value={dateTime(activeShift.openedAt ?? activeShift.shiftStartsAt)}
                />
                <Field label="Ends" value={dateTime(activeShift.shiftEndsAt)} />
                <Field
                  label="On shift for"
                  value={durationLabel(
                    minutesSince(activeShift.openedAt ?? activeShift.shiftStartsAt),
                  )}
                />
              </SummaryGrid>
            ) : nextShift ? (
              <SummaryGrid>
                <Field
                  label="Next shift"
                  value={
                    <Link to={`/triage/shifts/${nextShift.id}`} style={linkStyle}>
                      {shortId(nextShift.id)}
                    </Link>
                  }
                />
                <Field label="Discipline" value={disciplineLabel(nextShift.discipline)} />
                <Field label="Starts" value={dateTime(nextShift.shiftStartsAt)} />
                <Field label="Ends" value={dateTime(nextShift.shiftEndsAt)} />
                <Field
                  label="Status"
                  value={<StatusPill label={humanize(nextShift.status)} tone="progress" />}
                />
              </SummaryGrid>
            ) : (
              <span style={mutedStyle}>
                No active or upcoming shift is on the roster in this window. The roster read is
                scoped by the server; a shift belonging to a colleague is simply absent.
              </span>
            )}
            <span style={mutedStyle}>
              The roster shows what is scheduled for your scope, not "assigned to me" — M19
              publishes no per-membership roster filter, and a triage call has no assignee at all:
              the covering shift is the assignment.
            </span>
          </Card>

          <Card title="Open now">
            {board.length === 0 ? (
              <span style={mutedStyle}>Nothing is open. A quiet night.</span>
            ) : (
              <div style={{ width: "100%", overflowX: "auto" }}>
                <table style={tableStyle}>
                  <thead>
                    <tr style={tableHeadRowStyle}>
                      <th style={th}>Call</th>
                      <th style={th}>State</th>
                      <th style={th}>Protocol</th>
                      <th style={thNum}>Escalations</th>
                      <th style={thNum}>Open</th>
                    </tr>
                  </thead>
                  <tbody>
                    {board.map((c) => (
                      <tr key={c.id} style={rowLine}>
                        <td style={td}>
                          <Link to={`/triage/calls/${c.id}`} style={linkStyle}>
                            {shortId(c.id)}
                          </Link>
                        </td>
                        <td style={td}>
                          <CallStatePill state={c.state} />
                        </td>
                        <td style={td}>{c.protocolLabel ?? "—"}</td>
                        <td style={tdNum}>{c.openEscalationCount}</td>
                        <td style={tdNum}>{durationLabel(minutesSince(c.openedAt))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Working a call away from a desk">
            <span style={mutedStyle}>
              The triage panel is <strong>online-only</strong>. If connectivity drops mid-call,
              finish on paper and re-enter it when service is restored — no partial triage state is
              kept on the device, because a disposition gate that can be reconstructed offline is
              not a gate. The paper re-entry path is a separate, permissioned screen and it
              back-dates the call honestly, inside the outage window it is filed against. Push
              notification, Do-Not-Disturb bypass and one-tap dialling belong to the native shell
              rather than to this web view.
            </span>
          </Card>
        </div>
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

const contentShellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  padding: "0 1.5rem 1.5rem",
};

const tableHeadRowStyle: CSSProperties = {
  background: "var(--color-surface-low)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
};

const linkButtonStyle: CSSProperties = {
  ...ghostButtonStyle,
  minHeight: "2.25rem",
  padding: "0.5rem 0.85rem",
};

const primaryLinkButtonStyle: CSSProperties = {
  ...linkButtonStyle,
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
};
