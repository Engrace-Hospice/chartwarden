// apps/web/src/modules/19-oncall — S19.12 SINGLE-CALL READ-ONLY HISTORY
// (`/triage/calls/:triageCallId/history`, §5.1, Track B / ADR-0030).
//
// §5.1 gives this its own row with a WIDER audience than the panel — caseload roles, supervisors, the DON
// and a SURVEYOR — and a narrower purpose: the full state timeline, every answer, every escalation, the
// linked encounter and the verbal-order link, with NO action anywhere on the page. It is a separate screen
// rather than a tab on the panel because the panel is a workspace whose every card ends in a write, and a
// surveyor reading a closed call must not be one mis-click from a state transition.
//
// IT SHARES THE PANEL'S PERMISSION (`triage.read`) AND THAT IS CORRECT, not laziness: the DTO is the same
// `GET /triage-calls/:id` read, and gating the same bytes behind a second key would suggest a boundary the
// server does not enforce. §5.1's "surveyor mode strips the internal-note field" is likewise NOT
// re-implemented here — the §3.6 denylist and the §8.2 redaction happen in SQL, and the response's
// `redactedCategories` marker (rendered below) is how the omission is disclosed. A second, client-side
// stripping pass would be a second copy of a rule the server already owns, and the one that drifts.
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import {
  type TriageCallDetail,
  type TriageCallProjection,
  errorMessage,
  getTriageCall,
  isStaffProjection,
} from "./oncall-api";
import {
  ESCALATION_STATE_TONE,
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
  Field,
  Notice,
  RedactionNotice,
  SummaryGrid,
  TierPill,
  Timeline,
  columnStyle,
  ghostButtonStyle,
  mutedStyle,
  pageTitleStyle,
  rowLine,
  tableStyle,
  td,
  th,
} from "./oncall-ui";

export function TriageCallHistoryScreen(): JSX.Element {
  const client = useApiClient();
  const { triageCallId = "" } = useParams<{ triageCallId: string }>();
  const [call, setCall] = useState<TriageCallProjection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getTriageCall(client, triageCallId);
    if (res.error || !res.call) {
      setError(errorMessage(res.error, "This call could not be loaded."));
      setLoading(false);
      return;
    }
    setCall(res.call);
    setLoading(false);
  }, [client, triageCallId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error || !call) {
    return (
      <EmptyState title="Unavailable" description={error ?? "This call could not be loaded."} />
    );
  }

  const staff = isStaffProjection(call) ? (call as TriageCallDetail) : null;
  const answers = [...call.answers].sort(
    (a, b) => a.answeredAt.localeCompare(b.answeredAt) || a.questionOrder - b.questionOrder,
  );

  return (
    <div className="wx-kit-column" style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Call history {shortId(call.id)}</span>}
        breadcrumb="On-call triage · read-only"
        actions={
          <Link to={`/triage/calls/${call.id}`} style={ghostButtonStyle}>
            Open the panel
          </Link>
        }
      />

      <Notice tone="info">
        Read-only. Nothing on this page writes. The timeline below is reconstructed from the call's
        OWN rows — the immutable access trail (who read what, refused reads, break-glass) belongs to
        the M4 audit surface and its own permission, and is not mirrored here.
      </Notice>

      {staff ? <RedactionNotice categories={staff.redactedCategories} /> : null}

      <Card title="Call">
        <SummaryGrid>
          <Field label="State" value={<CallStatePill state={call.state} />} />
          <Field label="Opened" value={dateTime(call.openedAt)} />
          {staff ? <Field label="Closed" value={dateTime(staff.closedAt)} /> : null}
          {staff ? (
            <Field
              label="Time to close"
              value={
                staff.closedAt
                  ? durationLabel(minutesSince(call.openedAt, Date.parse(staff.closedAt)))
                  : durationLabel(minutesSince(call.openedAt))
              }
            />
          ) : null}
          <Field label="Provider entity" value={shortId(call.providerEntityId)} mono />
          <Field label="Covering shift" value={shortId(call.onCallShiftId)} mono />
          <Field label="Channel" value={humanize(call.inboundChannel)} />
          <Field label="Caller kind" value={humanize(call.callerKind)} />
          {staff ? <Field label="Source" value={humanize(staff.source)} /> : null}
          {staff ? (
            <Field
              label="Disposition"
              value={staff.disposition ? dispositionLabel(staff.disposition) : "—"}
            />
          ) : null}
          {staff ? (
            <Field
              label="Linked encounter"
              value={staff.linkedEncounterId ? shortId(staff.linkedEncounterId) : "none"}
              mono={Boolean(staff.linkedEncounterId)}
            />
          ) : null}
          {staff ? (
            <Field
              label="Linked verbal orders"
              value={
                staff.linkedVerbalOrderIds.length === 0
                  ? "none"
                  : staff.linkedVerbalOrderIds.map(shortId).join(", ")
              }
              mono={staff.linkedVerbalOrderIds.length > 0}
            />
          ) : null}
          {staff ? (
            <Field
              label="Linked visit proposal"
              value={staff.linkedVisitProposalId ? shortId(staff.linkedVisitProposalId) : "none"}
              mono={Boolean(staff.linkedVisitProposalId)}
            />
          ) : null}
        </SummaryGrid>
      </Card>

      <Card title="State timeline">
        {!staff ? (
          <span style={mutedStyle}>
            The state narrative is a staff-projection field. The vendor projection does not declare
            it.
          </span>
        ) : staff.stateHistory.length === 0 ? (
          <span style={mutedStyle}>No transition has been recorded.</span>
        ) : (
          <Timeline
            entries={staff.stateHistory.map((h) => ({
              label: `${h.fromState ? `${humanize(h.fromState)} → ` : ""}${humanize(h.toState)}`,
              at: dateTime(h.transitionedAt),
              by: h.systemActor
                ? "system"
                : h.actorMembershipId
                  ? shortId(h.actorMembershipId)
                  : null,
            }))}
          />
        )}
      </Card>

      <Card title="Answers">
        {answers.length === 0 ? (
          <span style={mutedStyle}>No answer was recorded on this call.</span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>#</th>
                <th style={th}>Question</th>
                <th style={th}>Answer</th>
                <th style={th}>Red flag</th>
                <th style={th}>Recorded</th>
                <th style={th}>By</th>
              </tr>
            </thead>
            <tbody>
              {answers.map((a) => (
                <tr key={a.id} style={rowLine}>
                  <td style={td}>{a.questionOrder}</td>
                  <td style={td}>
                    {a.prompt}
                    {a.correctionOfAnswerId ? (
                      <>
                        <br />
                        <span style={mutedStyle}>corrects {shortId(a.correctionOfAnswerId)}</span>
                      </>
                    ) : null}
                  </td>
                  <td style={td}>
                    {a.valueBool !== null
                      ? a.valueBool
                        ? "Yes"
                        : "No"
                      : a.valueInt !== null
                        ? String(a.valueInt)
                        : (a.valueText ?? "—")}
                  </td>
                  <td style={td}>
                    {a.redFlagHit ? <StatusPill label="Red flag" tone="error" /> : "—"}
                  </td>
                  <td style={td}>{dateTime(a.answeredAt)}</td>
                  <td style={td}>{shortId(a.answeredByMembershipId)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <span style={mutedStyle}>
          Corrections are ROWS, not edits (§2.2.3). A "no" later corrected to "yes" leaves both
          rows, which is what a suppression investigation reads — and why the original is never
          overwritten.
        </span>
      </Card>

      <Card title="Escalations">
        {call.escalations.length === 0 ? (
          <span style={mutedStyle}>No escalation was raised on this call.</span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Tier</th>
                <th style={th}>Trigger</th>
                <th style={th}>State</th>
                <th style={th}>Mandatory</th>
                <th style={th}>Raised</th>
                <th style={th}>Acknowledged</th>
                <th style={th}>Resolved</th>
                <th style={th}>Resolved by</th>
              </tr>
            </thead>
            <tbody>
              {call.escalations.map((e) => (
                <tr key={e.id} style={rowLine}>
                  <td style={td}>
                    <TierPill tier={e.tier} />
                  </td>
                  <td style={td}>{humanize(e.triggerKind)}</td>
                  <td style={td}>
                    <StatusPill
                      label={humanize(e.state)}
                      tone={toneOf(ESCALATION_STATE_TONE, e.state)}
                    />
                  </td>
                  <td style={td}>
                    {e.mandatory ? <StatusPill label="Platform floor" tone="critical" /> : "—"}
                  </td>
                  <td style={td}>{dateTime(e.escalatedAt)}</td>
                  <td style={td}>{dateTime(e.acknowledgedAt)}</td>
                  <td style={td}>{dateTime(e.resolvedAt)}</td>
                  <td style={td}>{shortId(e.resolvedByMembershipId)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
