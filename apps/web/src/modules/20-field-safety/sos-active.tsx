// apps/web/src/modules/20-field-safety — §5.1 "ACTIVE SOS CENTER" (`/safety/sos`, Track B / ADR-0030).
//
// Every alert still in an open lifecycle state, oldest-and-loudest first, with the one write §7.4 and
// §7.5 wait on: acknowledge.
//
// ── AN EMPTY BOARD IS RENDERED AS AN ANSWER, NOT AS NOTHING ──────────────────────────────────────────
//
// "No active SOS" is the normal, good state, and it says so in words. But a FAILED read is amber and says
// the opposite thing — the M19-T08 three-state rule, which matters more here than anywhere else in the
// platform: a supervisor who reads an outage as "quiet night" stops looking.
//
// ── ACKNOWLEDGE IS THE CEREMONY AND IT LIVES ON THIS PAGE ────────────────────────────────────────────
//
// §5.1 asks for "one-click acknowledge with an action-taken modal". It is one click to OPEN the modal and
// never one click to acknowledge: §2.2.6 puts a ≥40-character account of what was actually done on the
// row, because "ack" is what a supervisor types at 3 a.m. and an OSHA reviewer reads three years later.
// The modal is not a separate registry entry — it acts on the `version` this page already read, and a
// modal that had to re-read could act on a version that moved while the countdown ran.
//
// ── THE COUNTDOWN COUNTS UP, NOT DOWN ────────────────────────────────────────────────────────────────
//
// §5.1 says "countdown timer". There is no deadline to count down TO on this screen: the D5 cancel window
// belongs to the raiser's phone, and the §4.8 SLA rungs are the server's own clocks. What a responder
// needs is how long this person has been waiting, so the column is an ELAPSED time — the same number the
// SLA watchdog is escalating on — and the tier badge says which rung it has reached.
import { EmptyState, LoadingSpinner, PageHeader, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import {
  type ActiveSosView,
  type SafetySosAcknowledgeOutcome,
  acknowledgeSos,
  errorMessage,
  getSosAlert,
  listActiveSos,
} from "./safety-api";
import {
  ACKNOWLEDGMENT_OUTCOMES,
  ACK_ACTION_TAKEN_MIN_CHARS,
  DEFAULT_ACK_OUTCOME,
  dateTime,
  durationLabel,
  humanize,
  meetsMinChars,
  minutesSince,
  shortId,
} from "./safety-status";
import {
  Card,
  CountGrid,
  Modal,
  Notice,
  SelectField,
  SosStatePill,
  TextAreaField,
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
  tdNum,
  th,
  thNum,
} from "./safety-ui";

/** Faster than the board's poll: this page exists for the minutes in which somebody is waiting. */
const POLL_MS = 15_000;

type Board = "ready" | "unknown";

export function ActiveSosScreen(): JSX.Element {
  const client = useApiClient();
  const [active, setActive] = useState<ActiveSosView | null>(null);
  const [board, setBoard] = useState<Board>("unknown");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The acknowledge ceremony's own state. `version` is read at the moment the modal opens (see below).
  const [ackFor, setAckFor] = useState<{ id: string; who: string; version: number } | null>(null);
  const [ackOpening, setAckOpening] = useState<string | null>(null);
  const [actionTaken, setActionTaken] = useState("");
  const [outcome, setOutcome] = useState(DEFAULT_ACK_OUTCOME);
  const [phoneMasked, setPhoneMasked] = useState("");
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  const load = useCallback(
    async (background = false) => {
      if (!background) setLoading(true);
      const res = await listActiveSos(client);
      if (res.error || !res.active) {
        setBoard("unknown");
        setError(errorMessage(res.error, "The active-SOS board could not be read."));
      } else {
        setActive(res.active);
        setBoard("ready");
        setError(null);
      }
      setLoading(false);
    },
    [client],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => void load(true), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  /**
   * Open the ceremony by READING the alert first.
   *
   * The board's list projection carries no `version`, and §2.5's `If-Match` is that integer. Reading the
   * row here rather than guessing means the acknowledgment is stamped against the version the responder
   * is actually looking at — and a 409 on submit then genuinely means "somebody else answered while you
   * were typing", which is a sentence worth showing.
   */
  const openAck = useCallback(
    async (id: string, who: string) => {
      setAckOpening(id);
      setModalError(null);
      const res = await getSosAlert(client, id);
      setAckOpening(null);
      if (res.error || !res.alert) {
        setError(errorMessage(res.error, "That alert could not be opened."));
        return;
      }
      setActionTaken("");
      setOutcome(DEFAULT_ACK_OUTCOME);
      setPhoneMasked("");
      setAckFor({ id, who, version: res.alert.version });
    },
    [client],
  );

  const submitAck = useCallback(async () => {
    if (!ackFor) return;
    setSaving(true);
    setModalError(null);
    const res = await acknowledgeSos(client, ackFor.id, ackFor.version, {
      actionTaken,
      // `outcome` is always one of the closed vocabulary the SelectField below offers.
      outcome: outcome as SafetySosAcknowledgeOutcome,
      ...(phoneMasked.trim() ? { outreachPhoneNumberMasked: phoneMasked.trim() } : {}),
    });
    setSaving(false);
    if (res.error) {
      setModalError(errorMessage(res.error, "The acknowledgment was not recorded."));
      return;
    }
    setAckFor(null);
    await load(true);
  }, [ackFor, actionTaken, client, load, outcome, phoneMasked]);

  if (loading && active === null) return <LoadingSpinner />;
  if (active === null)
    return (
      <EmptyState
        title="Active-SOS board unavailable"
        description={
          error ??
          "The board did not answer. This is NOT 'no active alerts' — treat it as unknown and check by phone."
        }
      />
    );

  const alerts = [...active.alerts].sort(
    (a, b) =>
      Number(a.acknowledgedAt !== null) - Number(b.acknowledgedAt !== null) ||
      b.minutesOpen - a.minutesOpen,
  );
  const unacknowledged = alerts.filter((a) => a.acknowledgedAt === null).length;
  const oldest = alerts.reduce((m, a) => Math.max(m, a.minutesOpen), 0);

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Active SOS</span>}
        breadcrumb="Field safety"
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <Link to="/safety" style={ghostButtonStyle}>
              Safety board
            </Link>
            <button type="button" onClick={() => void load()} style={ghostButtonStyle}>
              Refresh now
            </button>
          </div>
        }
      />

      {board === "unknown" ? (
        <Notice tone="warning" assertive>
          <strong>This board did not refresh.</strong> {error} What follows is the last answer
          received, at {dateTime(active.fetchedAt)}. An unreadable board is not a quiet one.
        </Notice>
      ) : null}

      {alerts.length === 0 ? (
        <Notice tone="success" live>
          <strong>No SOS is open</strong> as of {dateTime(active.fetchedAt)}. That is the server's
          answer, not an absence of data — the read succeeded and returned nothing.
        </Notice>
      ) : (
        <Notice tone="error" assertive>
          <strong>
            {alerts.length} SOS {alerts.length === 1 ? "alert is" : "alerts are"} open
          </strong>
          {unacknowledged > 0
            ? ` — ${unacknowledged} with nobody signed on yet. Acknowledging is what stops the escalation ladder.`
            : " — all acknowledged; each still needs resolving."}
        </Notice>
      )}

      <Card title="Open now">
        <CountGrid
          entries={[
            {
              label: "Open alerts",
              value: alerts.length,
              tone: alerts.length > 0 ? "critical" : undefined,
            },
            {
              label: "Unacknowledged",
              value: unacknowledged,
              tone: unacknowledged > 0 ? "error" : undefined,
            },
            { label: "Longest open", value: durationLabel(alerts.length ? oldest : null) },
          ]}
        />
        {alerts.length === 0 ? null : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Clinician</th>
                <th style={th}>Alert</th>
                <th style={th}>State</th>
                <th style={th}>Raised</th>
                <th style={thNum}>Open for</th>
                <th style={th}>Acknowledged</th>
                <th style={th}>Action</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id} style={rowLine}>
                  {/* First name only — §1.3 minimum-necessary. The alert names the clinician, never the
                      patient she is with. */}
                  <td style={td}>{a.postedByFirstName}</td>
                  <td style={td}>
                    <Link to={`/safety/sos/${a.id}`} style={linkStyle}>
                      {shortId(a.id)}
                    </Link>
                  </td>
                  <td style={td}>
                    <SosStatePill state={a.lifecycleState} />
                  </td>
                  <td style={td}>{dateTime(a.postedAt)}</td>
                  <td style={tdNum}>
                    {/* The SERVER's own elapsed figure, not a client subtraction: it is the number the
                        §4.8 SLA watchdog is escalating on, and two clocks would disagree at the worst
                        possible moment. `minutesSince` is used only as a fallback when it is absent. */}
                    {durationLabel(a.minutesOpen ?? minutesSince(a.postedAt))}
                  </td>
                  <td style={td}>
                    {a.acknowledgedAt ? (
                      dateTime(a.acknowledgedAt)
                    ) : (
                      <span style={{ color: t.error }}>Nobody yet</span>
                    )}
                  </td>
                  <td style={td}>
                    <button
                      type="button"
                      onClick={() => void openAck(a.id, a.postedByFirstName)}
                      disabled={ackOpening === a.id}
                      style={ackOpening === a.id ? disabledButtonStyle : primaryButtonStyle}
                    >
                      {ackOpening === a.id ? "Opening…" : "Acknowledge"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <span style={mutedStyle}>
          Sorted with the unacknowledged first and the longest-waiting at the top. Acknowledging
          records a named human answering; RESOLVING is a separate act on the alert's own page,
          because "I saw it" and "she is safe" are different claims and only one of them closes the
          record.
        </span>
      </Card>

      <Card title="Who was paged">
        <span style={mutedStyle}>
          The dispatched-recipient list §5.1 sketches is <strong>not shown here</strong>, and not
          because it was skipped: the recipient set is resolved at the moment of the press by the
          §4.5 <code>field_safety_composed</code> resolver — M20's own supervisor subscriptions
          unioned with M19's on-call actors after hours — and M36 owns the delivery record. M20
          publishes no route that reads it back, so a list here would either be re-derived (and
          could differ from who was actually rung) or invented. The alert's own page shows the
          acknowledgment chain, which is the fact that matters: not who we tried, but who answered.
        </span>
      </Card>

      {ackFor ? (
        <Modal
          title={`Acknowledge ${ackFor.who}'s SOS`}
          onClose={() => setAckFor(null)}
          footer={
            <button
              type="button"
              onClick={() => void submitAck()}
              disabled={saving || !meetsMinChars(actionTaken, ACK_ACTION_TAKEN_MIN_CHARS)}
              style={
                saving || !meetsMinChars(actionTaken, ACK_ACTION_TAKEN_MIN_CHARS)
                  ? disabledButtonStyle
                  : primaryButtonStyle
              }
            >
              {saving ? "Recording…" : "Record acknowledgment"}
            </button>
          }
        >
          <Notice tone="warning">
            This records that <strong>you</strong> answered, at this moment, and what you did. It is
            written in the same transaction as the state change, so an acknowledged alert nobody
            signed cannot exist. It does not close the alert.
          </Notice>
          <TextAreaField
            label="What did you do?"
            value={actionTaken}
            onChange={setActionTaken}
            rows={4}
            minChars={ACK_ACTION_TAKEN_MIN_CHARS}
            hint="A sentence a reviewer three years from now can act on — who you reached, on what number, and what you asked them to do."
          />
          <SelectField
            label="Outcome of your action"
            value={outcome}
            options={ACKNOWLEDGMENT_OUTCOMES.map((v) => ({ value: v, label: humanize(v) }))}
            onChange={setOutcome}
          />
          <TextField
            label="Number you called (masked)"
            value={phoneMasked}
            onChange={setPhoneMasked}
            placeholder="•••-•••-4417"
            hint="Masked on purpose (§8.2): the record says that you called, never the number. Leave blank if you did not call."
          />
          {modalError ? (
            <Notice tone="error" assertive>
              {modalError}
            </Notice>
          ) : null}
          <span style={mutedStyle}>
            This acknowledgment is stamped against version {ackFor.version} of the alert, read when
            this dialog opened. If somebody else answers while you are typing, the save is refused
            rather than overwriting their account of it.
          </span>
        </Modal>
      ) : null}
    </div>
  );
}
