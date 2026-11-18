// apps/web/src/modules/20-field-safety — §5.1 "SOS DETAIL" (`/safety/sos/:sosAlertId`, Track B/ADR-0030).
//
// One alert, end to end: the §2.2.2 lifecycle ledger a deposition reads line by line, the §2.2.6
// acknowledgment chain, the resolve ceremony, the incident-link CTA, and — behind its own gate — the D6
// coordinate stream.
//
// ── THE COORDINATE REVEAL IS THE POINT OF THIS FILE ──────────────────────────────────────────────────
//
// Everything else here is a read of facts about time and people. The location stream is the one thing on
// the platform where LOOKING is itself a disclosure, so it is behind a deliberate, spelled-out act:
//
//   1. It is NOT fetched on page load. Rendering the page must never trip the read. A tab left open on a
//      supervisor's second monitor would otherwise write a warn-severity audit row every refresh.
//   2. The reveal is a two-step: the §5.4 error-prevention banner ("this access is audited and SHE will
//      see it") is shown BEFORE the request, not beside the result.
//   3. Once the alert has closed, §6 requires a ≥40-character reason. The form asks for it and the SERVER
//      enforces it; the field is not offered as optional-when-closed, because a reason typed after the
//      coordinates were already on screen is not a reason, it is a caption.
//   4. The banner text rendered above the samples is `auditWarningBanner` FROM THE RESPONSE, verbatim.
//      The promise the screen makes and the audit row the server wrote are one decision, not two copies.
//
// ── RESOLVE AND OPEN-AN-INCIDENT ARE ONE FORM AND TWO OUTCOMES ───────────────────────────────────────
//
// §2.2.2 makes `resolved` and `incident_opened` different terminal states reached by different commands.
// The route dispatches on `openIncidentFromOutcome`, so the form carries one checkbox and says plainly
// which of the two it will produce — rather than making a supervisor at 3 a.m. choose between two buttons
// whose difference is invisible until afterwards.
import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  Panel,
  StatusPill,
  t,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { FormDrawer } from "../../shell/form-drawer";
import {
  type SafetySosAcknowledgeOutcome,
  type SafetySosAlertView,
  type SafetySosResolveOutcome,
  type SosLocationStreamPage,
  acknowledgeSos,
  errorMessage,
  getLocationStream,
  getSosAlert,
  resolveSos,
  writeErrorMessage,
} from "./safety-api";
import {
  ACKNOWLEDGMENT_OUTCOMES,
  ACK_ACTION_TAKEN_MIN_CHARS,
  COORD_ACCESS_REASON_MIN_CHARS,
  DEFAULT_ACK_OUTCOME,
  DEFAULT_SOS_OUTCOME,
  SOS_OPEN_STATES,
  SOS_OUTCOMES,
  SOS_RESOLUTION_MIN_CHARS,
  dateTime,
  durationLabel,
  humanize,
  meetsMinChars,
  minutesSince,
  shortId,
  sosStateLabel,
} from "./safety-status";
import {
  CheckboxField,
  CipherText,
  Field,
  Notice,
  SelectField,
  SosStatePill,
  SummaryGrid,
  TextAreaField,
  Timeline,
  ghostButtonStyle,
  linkStyle,
  pageTitleStyle,
} from "./safety-ui";
import { TerminusPanel } from "./terminus-panel";

type Ceremony = "none" | "acknowledge" | "resolve" | "coordinates";

export function SosDetailScreen(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { sosAlertId = "" } = useParams();

  const [alert, setAlert] = useState<SafetySosAlertView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ceremony, setCeremony] = useState<Ceremony>("none");
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  // acknowledge
  const [actionTaken, setActionTaken] = useState("");
  const [ackOutcome, setAckOutcome] = useState(DEFAULT_ACK_OUTCOME);
  // resolve
  const [narrative, setNarrative] = useState("");
  const [outcome, setOutcome] = useState(DEFAULT_SOS_OUTCOME);
  const [openIncident, setOpenIncident] = useState(false);
  // coordinates (D6 / §8.7)
  const [accessReason, setAccessReason] = useState("");
  const [stream, setStream] = useState<SosLocationStreamPage | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getSosAlert(client, sosAlertId);
    if (res.error || !res.alert) {
      setError(errorMessage(res.error, "That alert could not be read."));
      setAlert(null);
    } else {
      setAlert(res.alert);
      setError(null);
    }
    setLoading(false);
  }, [client, sosAlertId]);

  useEffect(() => {
    void load();
  }, [load]);

  const closeCeremony = useCallback(() => {
    setCeremony("none");
    setModalError(null);
  }, []);

  // A write's success closes only the ceremony it submitted, never whichever one is open by then.
  const closeIfStill = useCallback((submitted: Ceremony) => {
    setCeremony((current) => (current === submitted ? "none" : current));
  }, []);

  // Every write below runs through `.catch(() => null)`: the client REJECTS on a network failure, and `saving` must
  // reset on every path or the drawer can never be dismissed. `null` is that failure.
  const submitAck = useCallback(async () => {
    if (!alert) return;
    setSaving(true);
    setModalError(null);
    const res = await acknowledgeSos(client, alert.id, alert.version, {
      actionTaken,
      // `ackOutcome` is always one of the closed vocabulary the SelectField below offers.
      outcome: ackOutcome as SafetySosAcknowledgeOutcome,
    }).catch(() => null);
    setSaving(false);
    if (!res || res.error) {
      setModalError(writeErrorMessage(res, "The acknowledgment was not recorded."));
      return;
    }
    closeIfStill("acknowledge");
    setActionTaken("");
    await load();
  }, [ackOutcome, actionTaken, alert, client, closeIfStill, load]);

  const submitResolve = useCallback(async () => {
    if (!alert) return;
    setSaving(true);
    setModalError(null);
    const res = await resolveSos(client, alert.id, alert.version, {
      resolutionNarrative: narrative,
      // `outcome` is always one of the closed vocabulary the SelectField below offers.
      outcome: outcome as SafetySosResolveOutcome,
      openIncidentFromOutcome: openIncident,
    }).catch(() => null);
    setSaving(false);
    if (!res || res.error) {
      setModalError(writeErrorMessage(res, "The alert was not closed."));
      return;
    }
    closeIfStill("resolve");
    setNarrative("");
    // The write may have produced an incident; the reload is what tells us its id, so the CTA below can
    // link to a real row rather than to one this screen assumed into existence.
    await load();
  }, [alert, client, closeIfStill, load, narrative, openIncident, outcome]);

  /** The D6 reveal. See rule 2 in the module header: the banner precedes the request, never the result. */
  const revealCoordinates = useCallback(async () => {
    if (!alert) return;
    setSaving(true);
    setStreamError(null);
    const res = await getLocationStream(client, alert.id, {
      ...(accessReason.trim() ? { accessReason: accessReason.trim() } : {}),
    }).catch(() => null);
    setSaving(false);
    if (!res || res.error || !res.stream) {
      setStreamError(
        res
          ? errorMessage(
              res.error,
              "The coordinate stream was refused. Nothing was decrypted and nothing was disclosed.",
            )
          : "No answer came back, so no coordinates were shown. Check your connection, then retry.",
      );
      return;
    }
    setStream(res.stream);
    closeIfStill("coordinates");
  }, [accessReason, alert, client, closeIfStill]);

  if (loading) return <LoadingSpinner />;
  if (!alert)
    return (
      <EmptyState
        title="Alert unavailable"
        description={error ?? "This alert does not exist, or it is outside your reach."}
      />
    );

  const isOpen = SOS_OPEN_STATES.includes(alert.lifecycleState);
  const rejectedCancel = alert.cancelStatus === "cancel_attempted_but_rejected";
  const canAcknowledge = isOpen && alert.acknowledgedAt === null;
  const canResolve = isOpen && alert.acknowledgedAt !== null;
  // §6: once the alert has closed, a coordinate read needs a written reason. While it is live, the
  // responder's own predicate is the gate and no narrative is demanded — she is answering it right now.
  const reasonRequired = !isOpen;

  const ledger = alert.stateHistory.map((h) => ({
    label: `${h.fromState ? `${sosStateLabel(h.fromState)} → ` : ""}${sosStateLabel(h.toState)}`,
    at: dateTime(h.transitionedAt),
    by: h.transitionedByMembershipId ? shortId(h.transitionedByMembershipId) : "system",
  }));

  return (
    <div className={`wx-list-drawer${ceremony !== "none" ? " has-drawer" : ""}`}>
      <div className="wx-list-drawer-main wx-kit-column">
        <PageHeader
          title={<span style={pageTitleStyle}>SOS {shortId(alert.id)}</span>}
          actions={
            <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
              <Link to="/safety/sos" style={ghostButtonStyle}>
                Back to active SOS
              </Link>
              <Button tone="secondary" size="lg" type="button" onClick={() => void load()}>
                Reload
              </Button>
            </div>
          }
        />

        {rejectedCancel ? (
          <Notice tone="error" assertive>
            <strong>A cancel was attempted on this alert and REJECTED.</strong> The biometric check
            did not pass at {dateTime(alert.cancelAttemptedAt)}, and the alert proceeded exactly as
            if no cancel had happened. That is D5 working: a phone taken from a clinician cannot be
            used to silence her call for help. Treat this as a stronger signal than an ordinary SOS,
            not a weaker one.
          </Notice>
        ) : null}

        {isOpen ? (
          <Notice tone="error" assertive>
            <strong>{sosStateLabel(alert.lifecycleState)}</strong> — open for{" "}
            {durationLabel(minutesSince(alert.postedAt))}.
            {alert.acknowledgedAt === null
              ? " Nobody has acknowledged this yet; the escalation ladder is still climbing."
              : ` Acknowledged at ${dateTime(alert.acknowledgedAt)}, not yet resolved.`}
          </Notice>
        ) : (
          <Notice tone={alert.lifecycleState === "resolved" ? "success" : "info"} live>
            <strong>{sosStateLabel(alert.lifecycleState)}</strong>
            {alert.resolvedAt ? ` at ${dateTime(alert.resolvedAt)}` : ""}. This alert is closed; the
            record below is what a review reads.
          </Notice>
        )}

        {alert.lifecycleState === "emergency_terminus" ? (
          <TerminusPanel sosAlertId={alert.id} />
        ) : null}

        <Panel
          stack
          headingLevel={3}
          title="Alert"
          action={
            <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
              {canAcknowledge ? (
                <Button
                  tone="primary"
                  size="lg"
                  type="button"
                  onClick={() => setCeremony("acknowledge")}
                >
                  Acknowledge
                </Button>
              ) : null}
              {canResolve ? (
                <Button
                  tone="primary"
                  size="lg"
                  type="button"
                  onClick={() => setCeremony("resolve")}
                >
                  Resolve
                </Button>
              ) : null}
            </div>
          }
        >
          <SummaryGrid>
            <Field label="Alert" value={shortId(alert.id)} mono />
            <Field label="State" value={<SosStatePill state={alert.lifecycleState} />} />
            <Field label="Raised by" value={shortId(alert.postedByMembershipId)} mono />
            <Field label="Raised at" value={dateTime(alert.postedAt)} />
            <Field label="Cancel window closed" value={dateTime(alert.cancelWindowExpiredAt)} />
            <Field
              label="Cancel status"
              value={
                <StatusPill
                  label={humanize(alert.cancelStatus)}
                  tone={rejectedCancel ? "critical" : "neutral"}
                />
              }
            />
            <Field
              label="Visit at the time"
              value={alert.lastKnownVisitId ? shortId(alert.lastKnownVisitId) : "None recorded"}
              mono={alert.lastKnownVisitId !== null}
            />
            <Field label="Acknowledged" value={dateTime(alert.acknowledgedAt)} />
            <Field label="Resolved" value={dateTime(alert.resolvedAt)} />
            <Field label="Outcome" value={alert.outcome ? humanize(alert.outcome) : "—"} />
            <Field label="Row version" value={String(alert.version)} mono />
          </SummaryGrid>
          {alert.coordinatesCaptured ? null : (
            <Notice tone="info">
              <strong>No coordinate was captured with this press</strong>, and the alert fanned out
              anyway (M20-F16). Declining location consent never disables the SOS button — it only
              means the people who were paged were told there is no position. Do not read this as a
              failed press.
            </Notice>
          )}
        </Panel>

        <Panel stack headingLevel={3} title="Lifecycle ledger">
          {ledger.length === 0 ? (
            <span className="wx-text-muted">No transitions recorded yet.</span>
          ) : (
            <Timeline entries={ledger} />
          )}
          <span className="wx-text-muted">
            Every row is one <code>safety_sos_alert_state_history</code> entry, in order, with the
            membership that caused it or "system" for a worker. This is the ledger a deposition
            reads end to end; it is append-only in the database, so nothing here can be tidied up
            after the fact.
          </span>
        </Panel>

        <Panel stack headingLevel={3} title="Who answered">
          {alert.acknowledgments.length === 0 ? (
            <Notice tone={isOpen ? "error" : "warning"} live>
              <strong>Nobody has signed on to this alert.</strong>{" "}
              {isOpen
                ? "The ladder keeps climbing until somebody does."
                : "This alert reached a terminal state without an acknowledgment — that is worth a look."}
            </Notice>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Responder</th>
                  <th>At</th>
                  <th>Outcome</th>
                  <th>What was done</th>
                </tr>
              </thead>
              <tbody>
                {alert.acknowledgments.map((a) => (
                  <tr key={a.id}>
                    <td className="wx-data-md">{shortId(a.acknowledgedByMembershipId)}</td>
                    <td>{dateTime(a.acknowledgedAt)}</td>
                    <td>{a.outcome ? humanize(a.outcome) : "—"}</td>
                    <td>{a.actionTaken}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel stack headingLevel={3} title="Resolution">
          <CipherText
            value={alert.resolutionNarrative}
            available={alert.resolutionNarrativeAvailable}
            emptyLabel="No resolution narrative — this alert has not been resolved."
          />
          {alert.linkedIncidentId ? (
            <Link to={`/safety/incidents/${alert.linkedIncidentId}`} style={linkStyle}>
              Open the linked incident ({shortId(alert.linkedIncidentId)})
            </Link>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
              <span className="wx-text-muted">No incident is linked to this alert.</span>
              <Button
                tone="secondary"
                size="lg"
                type="button"
                onClick={() => navigate(`/safety/incidents/new?sosAlertId=${alert.id}`)}
              >
                Open an incident from this alert
              </Button>
            </div>
          )}
        </Panel>

        {/* ── the D6 coordinate boundary ─────────────────────────────────────────────────────────────── */}
        <Panel
          stack
          headingLevel={3}
          title="Location stream"
          action={
            stream === null ? (
              <Button
                tone="secondary"
                size="lg"
                type="button"
                onClick={() => {
                  setAccessReason("");
                  setStreamError(null);
                  setCeremony("coordinates");
                }}
              >
                Request coordinate access
              </Button>
            ) : null
          }
        >
          {stream === null ? (
            <>
              <Notice tone="warning">
                <strong>
                  Coordinates are not loaded, and opening this page did not read them.
                </strong>{" "}
                The stream is behind its own permission (<code>safety.sos.read_coords</code>), its
                own predicate and a <strong>warn-severity audit entry naming you</strong>. The
                clinician who raised this alert can see that access on her own consent surface. Ask
                for it only when you need it.
              </Notice>
              {/* While the coordinates drawer is open it announces the refusal beside its own button. */}
              {streamError && ceremony !== "coordinates" ? (
                <Notice tone="error" assertive>
                  {streamError}
                </Notice>
              ) : null}
              {alert.coordinatesCaptured ? null : (
                <span className="wx-text-muted">
                  This alert carries no press-time coordinate, so a stream read will most likely
                  return nothing even if you are entitled to it.
                </span>
              )}
            </>
          ) : (
            <>
              {/* VERBATIM from the response — see rule 4 in the module header. */}
              <Notice tone="warning" assertive>
                {stream.auditWarningBanner}
              </Notice>
              {stream.samples.length === 0 ? (
                <span className="wx-text-muted">
                  No samples were recorded for this alert. Continuous streaming requires BOTH the
                  tenant's opt-in and this clinician's own consent (D6); absent either, the
                  press-time coordinate is all that exists and it is not part of this stream.
                </span>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Sampled</th>
                      <th style={{ textAlign: "right" }}>Latitude</th>
                      <th style={{ textAlign: "right" }}>Longitude</th>
                      <th style={{ textAlign: "right" }}>Accuracy (m)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stream.samples.map((s) => (
                      <tr key={s.id}>
                        <td>{dateTime(s.sampledAt)}</td>
                        <td className="tabular-nums" style={{ textAlign: "right" }}>
                          {s.latitude.toFixed(5)}
                        </td>
                        <td className="tabular-nums" style={{ textAlign: "right" }}>
                          {s.longitude.toFixed(5)}
                        </td>
                        <td className="tabular-nums" style={{ textAlign: "right" }}>
                          {s.accuracyM}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {stream.has_more ? (
                <span className="wx-text-muted">
                  More samples exist beyond this page. Paging fetches them through the same audited
                  route — each page is another disclosure, which is why this screen does not page
                  automatically.
                </span>
              ) : null}
              <span className="wx-text-muted">
                Coordinates are rendered as numbers rather than plotted. A map tile request would
                send this clinician's position to a third-party tile server, which is a disclosure
                nobody consented to and one this module has no agreement covering.
              </span>
            </>
          )}
        </Panel>
      </div>

      {ceremony === "acknowledge" ? (
        <FormDrawer
          title="Acknowledge this SOS"
          busy={saving}
          onClose={closeCeremony}
          save={
            <Button
              tone="primary"
              size="lg"
              type="button"
              onClick={() => void submitAck()}
              disabled={saving || !meetsMinChars(actionTaken, ACK_ACTION_TAKEN_MIN_CHARS)}
            >
              {saving ? "Recording…" : "Record acknowledgment"}
            </Button>
          }
        >
          <TextAreaField
            label="What did you do?"
            value={actionTaken}
            onChange={setActionTaken}
            rows={4}
            minChars={ACK_ACTION_TAKEN_MIN_CHARS}
            hint="Who you reached and what you asked them to do. This does not close the alert."
          />
          <SelectField
            label="Outcome of your action"
            value={ackOutcome}
            options={ACKNOWLEDGMENT_OUTCOMES.map((v) => ({ value: v, label: humanize(v) }))}
            onChange={setAckOutcome}
          />
          {modalError ? (
            <Notice tone="error" assertive>
              {modalError}
            </Notice>
          ) : null}
        </FormDrawer>
      ) : null}

      {ceremony === "resolve" ? (
        <FormDrawer
          title="Resolve this SOS"
          busy={saving}
          onClose={closeCeremony}
          save={
            <Button
              tone="primary"
              size="lg"
              type="button"
              onClick={() => void submitResolve()}
              disabled={saving || !meetsMinChars(narrative, SOS_RESOLUTION_MIN_CHARS)}
            >
              {saving
                ? "Closing…"
                : openIncident
                  ? "Close and open an incident"
                  : "Close this alert"}
            </Button>
          }
        >
          <TextAreaField
            label="What happened, and how did it end?"
            value={narrative}
            onChange={setNarrative}
            rows={6}
            minChars={SOS_RESOLUTION_MIN_CHARS}
            hint="This is the account a review reads. It is stored encrypted under the tenant key."
          />
          <SelectField
            label="Outcome"
            value={outcome}
            options={SOS_OUTCOMES.map((v) => ({ value: v, label: humanize(v) }))}
            onChange={setOutcome}
          />
          <CheckboxField
            label="Open a safety incident from this alert"
            checked={openIncident}
            onChange={setOpenIncident}
          />
          <span className="wx-text-muted">
            The checkbox chooses between two <em>different</em> terminal states, not between two
            ways of saying the same thing: unticked closes the alert as <strong>resolved</strong>
            {"; "}
            ticked closes it as <strong>incident opened</strong> and creates the incident the
            workers-comp timeline hangs off. Neither can be undone from here.
          </span>
          {modalError ? (
            <Notice tone="error" assertive>
              {modalError}
            </Notice>
          ) : null}
        </FormDrawer>
      ) : null}

      {ceremony === "coordinates" ? (
        <FormDrawer
          title="Read this clinician's coordinates"
          busy={saving}
          onClose={closeCeremony}
          save={
            <Button
              tone="primary"
              size="lg"
              type="button"
              onClick={() => void revealCoordinates()}
              disabled={
                saving ||
                (reasonRequired && !meetsMinChars(accessReason, COORD_ACCESS_REASON_MIN_CHARS))
              }
            >
              {saving ? "Requesting…" : "I understand — show the coordinates"}
            </Button>
          }
        >
          {/* SC 3.3.1 error prevention, adapted for a privacy-sensitive READ: the consequence is stated
              before the act, not after it. */}
          <Notice tone="warning" assertive>
            You are about to view this clinician's location. The access is written to the audit log
            at <strong>warn</strong> severity with your name on it, and{" "}
            <strong>she can see it</strong> on her own consent surface. This is not reversible and
            it is not anonymous.
          </Notice>
          {reasonRequired ? (
            <TextAreaField
              label="Why do you need this, now that the alert has closed?"
              value={accessReason}
              onChange={setAccessReason}
              rows={3}
              minChars={COORD_ACCESS_REASON_MIN_CHARS}
              hint="Required by §6 once an alert is no longer active. The text is stored with the audit entry and is what she will read."
            />
          ) : (
            <span className="wx-text-muted">
              This alert is still active, so no written reason is required — you are responding to
              it right now, and the predicate that let you open this page is the gate. The audit
              entry is written either way.
            </span>
          )}
          {streamError ? (
            <Notice tone="error" assertive>
              {streamError}
            </Notice>
          ) : null}
        </FormDrawer>
      ) : null}
    </div>
  );
}
