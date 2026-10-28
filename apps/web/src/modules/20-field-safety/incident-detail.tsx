// apps/web/src/modules/20-field-safety — §5.1 "INCIDENT DETAIL"
// (`/safety/incidents/:incidentId`, Track B / ADR-0030).
//
// One incident with its §2.2.3 ledger, the draft editor, the submit gate, the supervisor state machine,
// the action-plan capture, and §7.6 / D9's OSHA-equivalent sign-off.
//
// ── D9 IS THE REASON THIS SCREEN IS SHAPED THE WAY IT IS ─────────────────────────────────────────────
//
// OSHA-reportable is NOT a checkbox on the incident. It is a separate, step-up'd act by a supervisor, and
// §3.3's `m20_si_osha_signoff_required` CHECK makes a submitted reportable incident WITHOUT a sign-off
// unrepresentable. So:
//
//   • the submit form's `oshaReportable` can only ever say `false` when no sign-off exists — the form
//     says so instead of offering a `true` the database will refuse;
//   • the sign-off is its own ceremony, with its own permission, its own step-up and its own `warn`
//     audit entry, and it asks for the STATE and the REPORTING WINDOW because §7.6's whole point is that
//     the classification is state-specific and M20 holds no state-OSHA rule table;
//   • it REFUSES on a closed incident, and the screen says to reopen first (§6) rather than greying the
//     button with no explanation.
//
// ── THE AFFECTED CLINICIAN'S ACKNOWLEDGMENT IS AN OBLIGATION THIS SCREEN CANNOT DISCHARGE ────────────
//
// §6 requires the affected clinician to acknowledge a supervisor-filed incident before it may close, and
// that acknowledgment "cannot be coerced". §4.1 publishes no route for it — `safety_acknowledgment` rows
// with `target_kind='incident'` are written by the lifecycle layer, not by a request. The screen shows the
// obligation as an outstanding fact rather than offering a button that would post it on her behalf, which
// is the one thing §6 explicitly forbids.
import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  t,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import {
  type SafetyIncidentCategory,
  type SafetyIncidentSeverity,
  type SafetyIncidentStateTransition,
  type SafetyIncidentView,
  errorMessage,
  getIncident,
  oshaSignoff,
  patchIncident,
  submitIncident,
  transitionIncident,
} from "./safety-api";
import {
  DEFAULT_INCIDENT_TRANSITION,
  INCIDENT_CATEGORIES,
  INCIDENT_CLOSED_STATES,
  INCIDENT_NARRATIVE_MIN_CHARS,
  INCIDENT_SEVERITIES,
  INCIDENT_TRANSITION_REASON_MIN_CHARS,
  INCIDENT_TRANSITION_STATES,
  OSHA_REASON_MIN_CHARS,
  dateTime,
  humanize,
  incidentCategoryLabel,
  meetsMinChars,
  shortId,
} from "./safety-status";
import {
  Card,
  CheckboxField,
  CipherText,
  Field,
  IncidentStatePill,
  Modal,
  Notice,
  SelectField,
  SeverityPill,
  SummaryGrid,
  TextAreaField,
  TextField,
  Timeline,
  columnStyle,
  disabledButtonStyle,
  ghostButtonStyle,
  linkStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
} from "./safety-ui";

type Ceremony = "none" | "edit" | "submit" | "transition" | "osha";

const CLOSED_STATES = INCIDENT_CLOSED_STATES;

export function IncidentDetailScreen(): JSX.Element {
  const client = useApiClient();
  const { incidentId = "" } = useParams();

  const [incident, setIncident] = useState<SafetyIncidentView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ceremony, setCeremony] = useState<Ceremony>("none");
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  // edit (draft)
  const [category, setCategory] = useState("");
  const [severity, setSeverity] = useState("");
  const [locationDescription, setLocationDescription] = useState("");
  const [narrative, setNarrative] = useState("");
  const [witnesses, setWitnesses] = useState("");
  const [wcInitiated, setWcInitiated] = useState(false);
  const [wcReference, setWcReference] = useState("");
  // submit
  const [finalNarrative, setFinalNarrative] = useState("");
  // transition
  const [toState, setToState] = useState(DEFAULT_INCIDENT_TRANSITION);
  const [reason, setReason] = useState("");
  const [actionPlan, setActionPlan] = useState("");
  // osha
  const [oshaReportable, setOshaReportable] = useState(true);
  const [oshaReason, setOshaReason] = useState("");
  const [stateCode, setStateCode] = useState("");
  const [windowHours, setWindowHours] = useState("24");

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getIncident(client, incidentId);
    if (res.error || !res.incident) {
      setError(errorMessage(res.error, "That incident could not be read."));
      setIncident(null);
    } else {
      setIncident(res.incident);
      setError(null);
    }
    setLoading(false);
  }, [client, incidentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openEdit = useCallback(() => {
    if (!incident) return;
    setCategory(incident.category);
    setSeverity(incident.severity);
    setLocationDescription(incident.locationDescription ?? "");
    // The narrative field starts EMPTY when the cipher could not be opened, and the modal says so —
    // pre-filling it with "" and saving would silently replace a narrative nobody could read.
    setNarrative(incident.narrative ?? "");
    setWitnesses(incident.witnesses ?? "");
    setWcInitiated(incident.workersCompClaimInitiated);
    setWcReference(incident.workersCompClaimReference ?? "");
    setModalError(null);
    setCeremony("edit");
  }, [incident]);

  const submitEdit = useCallback(async () => {
    if (!incident) return;
    setSaving(true);
    setModalError(null);
    // `category`/`severity` are always one of the closed vocabularies the SelectFields below offer.
    const res = await patchIncident(client, incident.id, incident.version, {
      category: category as SafetyIncidentCategory,
      severity: severity as SafetyIncidentSeverity,
      ...(locationDescription.trim() ? { locationDescription: locationDescription.trim() } : {}),
      ...(narrative.trim() ? { narrative } : {}),
      ...(witnesses.trim() ? { witnesses } : {}),
      workersCompClaimInitiated: wcInitiated,
      ...(wcReference.trim() ? { workersCompClaimReference: wcReference.trim() } : {}),
    });
    setSaving(false);
    if (res.error) {
      setModalError(errorMessage(res.error, "The edit was not saved."));
      return;
    }
    setCeremony("none");
    await load();
  }, [
    category,
    client,
    incident,
    load,
    locationDescription,
    narrative,
    severity,
    wcInitiated,
    wcReference,
    witnesses,
  ]);

  const doSubmit = useCallback(async () => {
    if (!incident) return;
    setSaving(true);
    setModalError(null);
    const res = await submitIncident(client, incident.id, incident.version, {
      // D9: `true` here without an existing sign-off is refused by the server. The form only ever sends
      // the flag the incident already carries, so the clinician's Submit button cannot file with a state
      // agency on her own say-so.
      oshaReportable: incident.oshaReportable,
      ...(finalNarrative.trim() ? { finalNarrative } : {}),
    });
    setSaving(false);
    if (res.error) {
      setModalError(errorMessage(res.error, "The incident was not submitted."));
      return;
    }
    setCeremony("none");
    setFinalNarrative("");
    await load();
  }, [client, finalNarrative, incident, load]);

  const doTransition = useCallback(async () => {
    if (!incident) return;
    setSaving(true);
    setModalError(null);
    const res = await transitionIncident(client, incident.id, incident.version, {
      // `toState` is always one of the closed transition vocabulary the SelectField below offers.
      toState: toState as SafetyIncidentStateTransition,
      reason,
      ...(toState === "closed_with_action_plan" && actionPlan.trim() ? { actionPlan } : {}),
    });
    setSaving(false);
    if (res.error) {
      setModalError(errorMessage(res.error, "The transition was refused."));
      return;
    }
    setCeremony("none");
    setReason("");
    setActionPlan("");
    await load();
  }, [actionPlan, client, incident, load, reason, toState]);

  const doOsha = useCallback(async () => {
    if (!incident) return;
    setSaving(true);
    setModalError(null);
    const res = await oshaSignoff(client, incident.id, incident.version, {
      oshaReportable,
      reason: oshaReason,
      stateCode: stateCode.trim().toUpperCase(),
      reportingWindowHours: Number(windowHours),
    });
    setSaving(false);
    if (res.error) {
      setModalError(errorMessage(res.error, "The sign-off was refused."));
      return;
    }
    setCeremony("none");
    setOshaReason("");
    await load();
  }, [client, incident, load, oshaReason, oshaReportable, stateCode, windowHours]);

  if (loading) return <LoadingSpinner />;
  if (!incident)
    return (
      <EmptyState
        title="Incident unavailable"
        description={error ?? "This incident does not exist, or it is outside your reach."}
      />
    );

  const isDraft = incident.lifecycleState === "draft";
  const isClosed = CLOSED_STATES.includes(incident.lifecycleState);
  const filedOnBehalf = incident.affectedClinicianMembershipId !== incident.reportedByMembershipId;
  const reportableUnsigned = incident.oshaReportable && incident.oshaReportableSignedOffAt === null;

  const ledger = incident.stateHistory.map((h) => ({
    label: `${h.fromState ? `${humanize(h.fromState)} → ` : ""}${humanize(h.toState)}`,
    at: dateTime(h.transitionedAt),
    by: h.transitionedByMembershipId ? shortId(h.transitionedByMembershipId) : "system",
    detail: h.reason ? <span style={mutedStyle}>{h.reason}</span> : undefined,
  }));

  return (
    <div className="wx-kit-column" style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Incident {shortId(incident.id)}</span>}
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <Link to="/safety/incidents" style={ghostButtonStyle}>
              Back to ledger
            </Link>
            <button type="button" onClick={() => void load()} style={ghostButtonStyle}>
              Reload
            </button>
          </div>
        }
      />

      {reportableUnsigned ? (
        <Notice tone="error" assertive>
          <strong>Marked OSHA-reportable with no sign-off on record.</strong> A supervisor must sign
          off before this incident can leave draft — the database refuses the combination outright,
          so this is not a warning that can be worked around.
        </Notice>
      ) : null}

      {filedOnBehalf && !isClosed ? (
        <Notice tone="warning" live>
          <strong>This incident was filed on the affected clinician's behalf.</strong> §6 requires
          HER acknowledgment before it may close, and that acknowledgment cannot be coerced — if she
          declines, the row stays under review and a compliance flag fires. There is no button here
          to record it for her, deliberately: M20 publishes no route that would let one person post
          another's acknowledgment.
        </Notice>
      ) : null}

      <Card
        title="Incident"
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            {isDraft ? (
              <>
                <button type="button" onClick={openEdit} style={ghostButtonStyle}>
                  Edit draft
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setModalError(null);
                    setCeremony("submit");
                  }}
                  style={primaryButtonStyle}
                >
                  Submit for review
                </button>
              </>
            ) : null}
            {!isDraft ? (
              <button
                type="button"
                onClick={() => {
                  setToState(DEFAULT_INCIDENT_TRANSITION);
                  setModalError(null);
                  setCeremony("transition");
                }}
                style={ghostButtonStyle}
              >
                Change state
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setOshaReportable(!incident.oshaReportable);
                setModalError(null);
                setCeremony("osha");
              }}
              disabled={isClosed}
              style={isClosed ? disabledButtonStyle : ghostButtonStyle}
            >
              OSHA sign-off
            </button>
          </div>
        }
      >
        <SummaryGrid>
          <Field label="State" value={<IncidentStatePill state={incident.lifecycleState} />} />
          <Field label="Category" value={incidentCategoryLabel(incident.category)} />
          <Field label="Severity" value={<SeverityPill severity={incident.severity} />} />
          <Field label="Occurred" value={dateTime(incident.occurredAt)} />
          <Field label="Reported" value={dateTime(incident.reportedAt)} />
          <Field
            label="Affected clinician"
            value={shortId(incident.affectedClinicianMembershipId)}
            mono
          />
          <Field label="Reported by" value={shortId(incident.reportedByMembershipId)} mono />
          <Field
            label="Visit"
            value={incident.visitId ? shortId(incident.visitId) : "None"}
            mono={incident.visitId !== null}
          />
          <Field label="Submitted" value={dateTime(incident.submittedAt)} />
          <Field label="Reviewed" value={dateTime(incident.reviewedAt)} />
          <Field label="Closed" value={dateTime(incident.closedAt)} />
          <Field label="Row version" value={String(incident.version)} mono />
          <Field
            label="OSHA-reportable"
            value={
              incident.oshaReportable ? (
                <StatusPill
                  label={incident.oshaReportableSignedOffAt ? "Yes — signed" : "Yes — UNSIGNED"}
                  tone={incident.oshaReportableSignedOffAt ? "critical" : "error"}
                />
              ) : (
                "No"
              )
            }
          />
          <Field
            label="Signed off"
            value={
              incident.oshaReportableSignedOffAt
                ? `${dateTime(incident.oshaReportableSignedOffAt)} · ${shortId(incident.oshaReportableSignedOffByMembershipId)}`
                : "—"
            }
          />
          <Field
            label="Workers' comp"
            value={
              incident.workersCompClaimInitiated
                ? (incident.workersCompClaimReference ?? "Initiated")
                : "Not initiated"
            }
            mono={incident.workersCompClaimReference !== null}
          />
          <Field
            label="Linked SOS"
            value={
              incident.linkedSosAlertId ? (
                <Link to={`/safety/sos/${incident.linkedSosAlertId}`} style={linkStyle}>
                  {shortId(incident.linkedSosAlertId)}
                </Link>
              ) : (
                "None"
              )
            }
          />
        </SummaryGrid>
        {incident.locationDescription ? (
          <Field label="Where" value={incident.locationDescription} />
        ) : null}
        {incident.reopenReason ? (
          <Notice tone="warning">
            <strong>Reopened:</strong> {incident.reopenReason}
          </Notice>
        ) : null}
      </Card>

      <Card title="Narrative">
        <CipherText value={incident.narrative} available={incident.narrativeAvailable} />
      </Card>

      {incident.witnesses ? (
        <Card title="Witnesses">
          <p style={{ margin: 0, fontSize: "0.85rem", whiteSpace: "pre-wrap" }}>
            {incident.witnesses}
          </p>
        </Card>
      ) : null}

      <Card title="Action plan">
        <CipherText
          value={incident.actionPlan}
          available={incident.actionPlanAvailable}
          emptyLabel="No action plan — this incident has not been closed with one."
        />
      </Card>

      <Card title="Lifecycle ledger">
        {ledger.length === 0 ? (
          <span style={mutedStyle}>No transitions yet — this incident is still a draft.</span>
        ) : (
          <Timeline entries={ledger} />
        )}
      </Card>

      {/* ── ceremonies ─────────────────────────────────────────────────────────────────────────────── */}

      {ceremony === "edit" ? (
        <Modal
          title="Edit this draft"
          onClose={() => setCeremony("none")}
          footer={
            <button
              type="button"
              onClick={() => void submitEdit()}
              disabled={saving}
              style={saving ? disabledButtonStyle : primaryButtonStyle}
            >
              {saving ? "Saving…" : "Save draft"}
            </button>
          }
        >
          {!incident.narrativeAvailable ? (
            <Notice tone="warning" assertive>
              The stored narrative could not be decrypted for display, so the box below starts
              empty. Leaving it empty keeps what is already stored; typing into it REPLACES text you
              cannot see.
            </Notice>
          ) : null}
          <SelectField
            label="Category"
            value={category}
            options={INCIDENT_CATEGORIES.map((v) => ({
              value: v,
              label: incidentCategoryLabel(v),
            }))}
            onChange={setCategory}
          />
          <SelectField
            label="Severity"
            value={severity}
            options={INCIDENT_SEVERITIES.map((v) => ({ value: v, label: humanize(v) }))}
            onChange={setSeverity}
          />
          <TextField label="Where" value={locationDescription} onChange={setLocationDescription} />
          <TextAreaField
            label="What happened"
            value={narrative}
            onChange={setNarrative}
            rows={8}
            minChars={INCIDENT_NARRATIVE_MIN_CHARS}
            hint="Stored encrypted under the tenant key. Once submitted, this text is part of a record an insurer and a state agency may read."
          />
          <TextAreaField label="Witnesses" value={witnesses} onChange={setWitnesses} rows={3} />
          <CheckboxField
            label="A workers' compensation claim has been initiated"
            checked={wcInitiated}
            onChange={setWcInitiated}
          />
          {wcInitiated ? (
            <TextField label="Claim reference" value={wcReference} onChange={setWcReference} mono />
          ) : null}
          {modalError ? (
            <Notice tone="error" assertive>
              {modalError}
            </Notice>
          ) : null}
        </Modal>
      ) : null}

      {ceremony === "submit" ? (
        <Modal
          title="Submit this incident for review"
          onClose={() => setCeremony("none")}
          footer={
            <button
              type="button"
              onClick={() => void doSubmit()}
              disabled={saving}
              style={saving ? disabledButtonStyle : primaryButtonStyle}
            >
              {saving ? "Submitting…" : "Submit"}
            </button>
          }
        >
          <Notice tone="warning">
            Submitting ends the editable phase. From here the incident moves through the supervisor
            state machine, and the narrative becomes part of a record that survives your account.
          </Notice>
          <TextAreaField
            label="Anything to add before it goes?"
            value={finalNarrative}
            onChange={setFinalNarrative}
            rows={5}
            hint="Optional. Appended to the record; it does not replace what you already wrote."
          />
          <span style={mutedStyle}>
            This submission is filed as{" "}
            <strong>{incident.oshaReportable ? "OSHA-reportable" : "not OSHA-reportable"}</strong> —
            the flag this incident already carries. You cannot raise it here: D9 makes that a
            supervisor's step-up'd sign-off, precisely so a filing with a state agency is never made
            on the reporting clinician's own say-so.
          </span>
          {modalError ? (
            <Notice tone="error" assertive>
              {modalError}
            </Notice>
          ) : null}
        </Modal>
      ) : null}

      {ceremony === "transition" ? (
        <Modal
          title="Change this incident's state"
          onClose={() => setCeremony("none")}
          footer={
            <button
              type="button"
              onClick={() => void doTransition()}
              disabled={
                saving ||
                !meetsMinChars(reason, INCIDENT_TRANSITION_REASON_MIN_CHARS) ||
                (toState === "closed_with_action_plan" && actionPlan.trim().length === 0)
              }
              style={
                saving ||
                !meetsMinChars(reason, INCIDENT_TRANSITION_REASON_MIN_CHARS) ||
                (toState === "closed_with_action_plan" && actionPlan.trim().length === 0)
                  ? disabledButtonStyle
                  : primaryButtonStyle
              }
            >
              {saving ? "Recording…" : "Record transition"}
            </button>
          }
        >
          <SelectField
            label="Move to"
            value={toState}
            options={INCIDENT_TRANSITION_STATES.map((v) => ({ value: v, label: humanize(v) }))}
            onChange={setToState}
          />
          <span style={mutedStyle}>
            <code>draft</code> and <code>submitted</code> are absent from this list on purpose: each
            is reached by its own route, and a picker that offered <code>submitted</code> would let
            you un-submit — which is exactly the immutability point §2.2.3 puts there.
          </span>
          <TextAreaField
            label="Why"
            value={reason}
            onChange={setReason}
            rows={3}
            minChars={INCIDENT_TRANSITION_REASON_MIN_CHARS}
          />
          {toState === "closed_with_action_plan" ? (
            <TextAreaField
              label="Action plan"
              value={actionPlan}
              onChange={setActionPlan}
              rows={6}
              hint="Required for this closure — the database refuses the state without it. This is the difference between the two closures: one leaves the agency with something to do differently."
            />
          ) : null}
          {toState === "reopened" ? (
            <Notice tone="warning">
              Reopening is also the only way to undo an OSHA sign-off (§6), and undoing one needs a
              second sign-off afterwards.
            </Notice>
          ) : null}
          {modalError ? (
            <Notice tone="error" assertive>
              {modalError}
            </Notice>
          ) : null}
        </Modal>
      ) : null}

      {ceremony === "osha" ? (
        <Modal
          title="OSHA-equivalent sign-off"
          onClose={() => setCeremony("none")}
          footer={
            <button
              type="button"
              onClick={() => void doOsha()}
              disabled={
                saving ||
                !meetsMinChars(oshaReason, OSHA_REASON_MIN_CHARS) ||
                stateCode.trim().length !== 2 ||
                !Number.isFinite(Number(windowHours)) ||
                Number(windowHours) < 1
              }
              style={
                saving ||
                !meetsMinChars(oshaReason, OSHA_REASON_MIN_CHARS) ||
                stateCode.trim().length !== 2 ||
                !Number.isFinite(Number(windowHours)) ||
                Number(windowHours) < 1
                  ? disabledButtonStyle
                  : primaryButtonStyle
              }
            >
              {saving
                ? "Signing…"
                : oshaReportable
                  ? "Sign off as reportable"
                  : "Sign off as NOT reportable"}
            </button>
          }
        >
          <Notice tone="warning" assertive>
            This is a <strong>step-up</strong> act with your name on it, logged at warn severity.
            Signing an incident as reportable starts a filing clock with a state agency; signing it
            as not reportable is the decision a later review will ask you to justify. Undoing either
            needs a reopen and a second sign-off.
          </Notice>
          <CheckboxField
            label="This incident IS OSHA-equivalent reportable"
            checked={oshaReportable}
            onChange={setOshaReportable}
          />
          <TextField
            label="State"
            value={stateCode}
            onChange={setStateCode}
            placeholder="OR"
            hint="Two letters. Required and not derived: Oregon's rules are not California's, and M20 holds no state-OSHA rule table to guess from."
            mono
          />
          <TextField
            label="Reporting window (hours)"
            value={windowHours}
            onChange={setWindowHours}
            type="number"
            hint="The window that state's regulation gives you. Nobody defaults this — a defaulted number on a filing deadline is one nobody chose."
          />
          <TextAreaField
            label="Reason — cite the rule"
            value={oshaReason}
            onChange={setOshaReason}
            rows={4}
            minChars={OSHA_REASON_MIN_CHARS}
            hint="What a later review reads to understand why this injury was classified the way it was."
          />
          {isClosed ? (
            <Notice tone="error">
              This incident is closed, and the sign-off route refuses a closed row. Reopen it first
              (§6) — that reopen is itself a recorded act with a reason, which is how the trail
              stays honest.
            </Notice>
          ) : null}
          {modalError ? (
            <Notice tone="error" assertive>
              {modalError}
            </Notice>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
