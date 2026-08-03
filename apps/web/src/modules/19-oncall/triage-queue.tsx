// apps/web/src/modules/19-oncall — S19.3 ACTIVE TRIAGE QUEUE (`/triage`, §5.1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_ON_CALL_TRIAGE.md — "Use Work Queue + Documentation
// Workspace." This screen is the Work-Queue half; the Documentation-Workspace half is the triage panel.
//
// THE BOARD IS SORTED BY WHAT IS UNANSWERED, NOT BY WHAT IS NEWEST. An open escalation outranks a red-flag
// answer, which outranks age. A queue sorted by arrival puts the suicidal-ideation call that came in at
// 01:40 below the medication question that came in at 02:10, and the whole D7 ladder exists so that does
// not happen.
//
// THE KPI TILES ARE PAGE-DERIVED, AND THE SCREEN SAYS SO. §4.1 publishes no aggregate route and §4.1.1
// forbids `total_count` on a PHI list (a count is an enumeration oracle — a caller who cannot READ another
// ProviderEntity's calls could still learn how many there were). So every tile counts the page it was
// given. When the page is truncated the row carries an explicit "at least" notice rather than a number that
// reads like a census.
//
// §5.1's "ack / take / re-route actions" are NOT rendered as queue-row buttons. §4.1 publishes no assign,
// no claim and no re-route route — a triage call has no assignee column at all; the covering SHIFT is the
// assignment, and it is resolved server-side at open. A button here would have to invent a write, so the
// row links to the panel, which is where every published action lives.
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import {
  type TriageCallListItem,
  type TriageCallState,
  errorMessage,
  listTriageCalls,
} from "./oncall-api";
import {
  CALL_STATES,
  CALL_SOURCE_TONE,
  dateTime,
  dispositionLabel,
  durationLabel,
  humanize,
  minutesSince,
  shortId,
  toneOf,
} from "./oncall-status";
import {
  CallStatePill,
  Card,
  CountGrid,
  FilterRow,
  Notice,
  SelectField,
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

/** §4.1.1's `triageCalls` hard max. Named so the "at least" copy and the request agree — a literal in the
 *  query and a different literal in the sentence is how a KPI starts lying. */
const QUEUE_PAGE = 100;

const STATE_FILTERS = [{ value: "", label: "open (default)" }].concat(
  CALL_STATES.map((s) => ({ value: s, label: humanize(s) })),
);

/** The board's rank: unacknowledged escalations first, then red flags, then age. */
function boardRank(a: TriageCallListItem, b: TriageCallListItem): number {
  if (a.openEscalationCount !== b.openEscalationCount) {
    return b.openEscalationCount - a.openEscalationCount;
  }
  if (a.redFlagAnswerCount !== b.redFlagAnswerCount) {
    return b.redFlagAnswerCount - a.redFlagAnswerCount;
  }
  return a.openedAt.localeCompare(b.openedAt);
}

export function TriageQueueScreen(): JSX.Element {
  const client = useApiClient();
  const [state, setState] = useState("");
  const [calls, setCalls] = useState<TriageCallListItem[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // `state` and `openOnly` are mutually exclusive server-side semantics: naming a state IS the filter, so
    // `openOnly` only rides along when no explicit state was picked.
    const res = await listTriageCalls(client, {
      limit: QUEUE_PAGE,
      // `state` is always "" (open-only) or one of CALL_STATES — the SelectField below offers no other value.
      ...(state ? { state: state as TriageCallState } : { openOnly: true }),
    });
    if (res.error) {
      setError(errorMessage(res.error, "The triage queue could not be loaded."));
      setLoading(false);
      return;
    }
    setCalls(res.page?.data ?? []);
    setTruncated(res.page?.has_more ?? false);
    setLoading(false);
  }, [client, state]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  const sorted = [...calls].sort(boardRank);
  const escalated = calls.filter((c) => c.openEscalationCount > 0).length;
  const awaitingCallback = calls.filter((c) => c.state === "awaiting_callback").length;
  const pendingEncounter = calls.filter(
    (c) => c.state === "documented_pending_encounter",
  ).length;
  const unresolved = calls.filter((c) => c.state === "escalated_unresolved").length;
  const redFlagged = calls.filter((c) => c.redFlagAnswerCount > 0).length;

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Triage queue</span>}
        breadcrumb="On-call triage"
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <Link to="/triage/intake" style={ghostButtonStyle}>
              Take a call
            </Link>
            <Link to="/triage/escalations" style={ghostButtonStyle}>
              Escalations
            </Link>
            <Link to="/me/oncall" style={ghostButtonStyle}>
              My on-call
            </Link>
          </div>
        }
      />

      {unresolved > 0 ? (
        <Notice tone="error" assertive>
          {unresolved} call{unresolved === 1 ? " is" : "s are"} parked in{" "}
          <strong>escalated — unresolved</strong>: a named human has been paged and has not answered. Until
          the escalation is acknowledged, §7.2 permits no disposition other than the hand-off.
        </Notice>
      ) : null}

      {truncated ? (
        <Notice tone="info">
          More than {QUEUE_PAGE} calls match this filter. The counts below are therefore "at least" — §4.1
          publishes no aggregate route and §4.1.1 forbids a total count on a PHI list, so a tile counts the
          page it was given, never the whole tenant. Narrow the filter for an exact figure.
        </Notice>
      ) : null}

      <Card title="Board">
        <CountGrid
          entries={[
            { label: "On the board", value: calls.length },
            { label: "With an open escalation", value: escalated, tone: escalated > 0 ? "error" : undefined },
            { label: "Red-flag answers", value: redFlagged, tone: redFlagged > 0 ? "error" : undefined },
            { label: "Awaiting callback", value: awaitingCallback },
            { label: "Awaiting encounter signature", value: pendingEncounter },
            { label: "Escalated — unresolved", value: unresolved, tone: unresolved > 0 ? "error" : undefined },
          ]}
        />
        <span style={mutedStyle}>
          "Documented — pending encounter" stays ON the board deliberately (M19-F06 / ADR-0022): a call
          stranded by an unreachable M8 encounter seam must remain visible to the supervisor, not drop off
          because its disposition was picked.
        </span>
      </Card>

      <FilterRow>
        <SelectField label="State" value={state} options={STATE_FILTERS} onChange={setState} />
      </FilterRow>

      <Card title="Calls">
        {sorted.length === 0 ? (
          <span style={mutedStyle}>
            Nothing is open on this board. A quiet night is the ordinary outcome — this is not an error, and
            it is not the same as "you cannot see these calls": a call outside your reach is absent, and the
            server does not distinguish the two.
          </span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Call</th>
                <th style={th}>State</th>
                <th style={th}>Patient</th>
                <th style={th}>Caller</th>
                <th style={th}>Protocol</th>
                <th style={th}>Disposition</th>
                <th style={th}>Source</th>
                <th style={thNum}>Escalations</th>
                <th style={thNum}>Red flags</th>
                <th style={thNum}>Open</th>
                <th style={th}>Received</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((c) => (
                <tr key={c.id} style={rowLine}>
                  <td style={td}>
                    <Link to={`/triage/calls/${c.id}`} style={linkStyle}>
                      {shortId(c.id)}
                    </Link>
                  </td>
                  <td style={td}>
                    <CallStatePill state={c.state} />
                  </td>
                  {/* An unidentified caller is the ORDINARY case at 2 a.m.: `patient_id` is nullable until
                      route 4 resolves the caller to a served person, and rendering "—" is the honest state,
                      not a data fault. */}
                  <td style={td}>{c.patientId ? shortId(c.patientId) : "not yet identified"}</td>
                  <td style={td}>
                    {humanize(c.callerKind)} · {humanize(c.inboundChannel)}
                  </td>
                  <td style={td}>{c.protocolLabel ?? "—"}</td>
                  <td style={td}>{c.disposition ? dispositionLabel(c.disposition) : "—"}</td>
                  <td style={td}>
                    <StatusPill label={humanize(c.source)} tone={toneOf(CALL_SOURCE_TONE, c.source)} />
                  </td>
                  <td style={tdNum}>{c.openEscalationCount}</td>
                  <td style={tdNum}>{c.redFlagAnswerCount}</td>
                  <td style={tdNum}>
                    {c.closedAt ? "—" : durationLabel(minutesSince(c.openedAt))}
                  </td>
                  <td style={td}>{dateTime(c.openedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="What this board does not offer">
        <span style={mutedStyle}>
          §5.1 sketches "ack / take / re-route" row actions. None is built, because §4.1 publishes no
          assign, claim or re-route route and `triage_call` has no assignee column: the covering SHIFT is
          the assignment and the server resolves it at open. A row action here would have had to invent a
          write nobody can audit. Acknowledging an escalation is a real write and lives on the escalation
          inbox, where the row it acts on is.
        </span>
      </Card>
    </div>
  );
}
