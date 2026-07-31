// apps/web/src/modules/19-oncall — S19.1 INBOUND CALL INTAKE (`/triage/intake`, §5.1, Track B /
// ADR-0030). Spec: docs/design/screens/clinical/WARDENX_UI_ON_CALL_TRIAGE.md — the "Create call" action.
//
// THE FORM IS DELIBERATELY SHORT, because §4.2 makes almost everything about a triage call server-derived:
//   • `source` is pinned to `manual` (`OpenableSource`) — a caller who could name `no_show` could mint a
//     row that LOOKS like M17 detected a missed visit, and one who could name `paper_origin` would bypass
//     `triage.paper_reentry` and its step-up entirely (§8.3.2's back-dating threat).
//   • `onCallShiftId` is resolved by the server even though the column is NOT NULL: letting a caller name
//     the shift lets them attribute their call to somebody else's coverage window, and that window IS the
//     CoP 418.100(c)(2) record.
//   • `sourceOutboxEventId` is not offered at all — it is the §2.6 redelivery key the D10 consumers set.
// So the three inbound-channel values and the `system_inbound` caller kind that only a machine writes are
// absent from these pickers (`HUMAN_INBOUND_CHANNELS` / `HUMAN_CALLER_KINDS`), and the screen says why.
//
// PATIENT IDENTIFICATION IS NOT REQUIRED TO OPEN. §3.3 leaves `patient_id` and `admission_id` nullable
// until route 4 resolves the caller to a served person, and that is the clinically correct order: the
// clock starts when the phone rings, not when the chart is found. §5.1's "patient-search (M5 reader)" is
// therefore an id field here rather than an autocomplete — M19 publishes no patient search, and M5's own
// search is another module's screen with another module's permission; putting a second copy of it inside
// a triage screen would be a second, unaudited PHI read path. Identification can also be done later, from
// the panel, which is where §7.1 actually needs it.
//
// THE AI SUGGESTION IS NOT SHOWN HERE. D12's suggestion arrives on the OPEN RESPONSE, after the row
// exists — there is nothing to suggest against until a chief complaint has been recorded. This screen
// hands the response straight to the panel, which is where the suggestion is displayed and where the
// explicit clinician click that applies it lives.
import { EmptyState, PageHeader, t, useApiClient } from "@wardenx/ui";
import { useState } from "react";
import type { JSX } from "react";
import { Link, useNavigate } from "react-router-dom";
import { errorMessage, openTriageCall } from "./oncall-api";
import {
  DEFAULT_CALLER_KIND,
  DEFAULT_INBOUND_CHANNEL,
  HUMAN_CALLER_KINDS,
  HUMAN_INBOUND_CHANNELS,
  humanize,
} from "./oncall-status";
import {
  Card,
  Notice,
  SelectField,
  TextAreaField,
  TextField,
  alertStyle,
  columnStyle,
  disabledButtonStyle,
  enumOptions,
  ghostButtonStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
} from "./oncall-ui";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** §4.2's `callerPhoneE164` pattern, mirrored so the clinician learns before the round trip. The SERVER
 *  remains the validator; this only saves a wasted 422 at 2 a.m. */
const E164_RE = /^\+[1-9]\d{1,14}$/;

export function TriageIntakeScreen(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();

  const [providerEntityId, setProviderEntityId] = useState("");
  const [inboundChannel, setInboundChannel] = useState(DEFAULT_INBOUND_CHANNEL);
  const [callerKind, setCallerKind] = useState(DEFAULT_CALLER_KIND);
  const [callerDisplayName, setCallerDisplayName] = useState("");
  const [callerPhone, setCallerPhone] = useState("");
  const [callerRelationship, setCallerRelationship] = useState("");
  const [patientId, setPatientId] = useState("");
  const [admissionId, setAdmissionId] = useState("");
  const [chiefComplaint, setChiefComplaint] = useState("");
  const [callerQuote, setCallerQuote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const peValid = UUID_RE.test(providerEntityId);
  const phoneValid = callerPhone === "" || E164_RE.test(callerPhone);
  // Patient and admission travel TOGETHER or not at all: `identifyPatient` requires both, and a call opened
  // with a patient but no admission cannot reach M8's `EncounterCreator`, which needs both NOT NULL.
  const anchorValid =
    (patientId === "" && admissionId === "") ||
    (UUID_RE.test(patientId) && UUID_RE.test(admissionId));
  const canOpen = peValid && phoneValid && anchorValid && !busy;

  async function open(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await openTriageCall(client, {
      providerEntityId,
      inboundChannel,
      callerKind,
      ...(callerDisplayName ? { callerDisplayName } : {}),
      ...(callerPhone ? { callerPhoneE164: callerPhone } : {}),
      ...(callerRelationship ? { callerRelationshipLabel: callerRelationship } : {}),
      ...(patientId ? { patientId, admissionId } : {}),
      ...(chiefComplaint ? { chiefComplaintText: chiefComplaint } : {}),
      ...(callerQuote ? { callerQuote } : {}),
    });
    setBusy(false);
    if (res.error || !res.result) {
      setError(errorMessage(res.error, "The call could not be opened."));
      return;
    }
    // Straight into the panel: the D11/D12 advisories on the open response are displayed THERE, and the
    // clock the §4.8 SLA detector is already watching started the moment this row was written.
    navigate(`/triage/calls/${res.result.triageCallId}`);
  }

  if (!client) return <EmptyState title="Unavailable" description="No API client is configured." />;

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Take a call</span>}
        breadcrumb="On-call triage · intake"
        actions={
          <Link to="/triage" style={ghostButtonStyle}>
            Back to the queue
          </Link>
        }
      />

      <Notice tone="info">
        Opening the call starts the record. The covering shift, the call source and the red-flag evaluation
        are all the server's — none of them is a field on this form, because each is a fact about coverage
        or clinical judgement that a caller must not be able to assert about themselves.
      </Notice>

      <Card title="Where the call landed">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(14rem, 1fr))",
            gap: t.space3,
          }}
        >
          <TextField
            label="Provider entity id"
            value={providerEntityId}
            onChange={setProviderEntityId}
            mono
            hint="Which CCN this call belongs to. Coverage is proved per ProviderEntity, never across."
          />
          <SelectField
            label="Inbound channel"
            value={inboundChannel}
            options={enumOptions(HUMAN_INBOUND_CHANNELS)}
            onChange={setInboundChannel}
          />
          <SelectField
            label="Caller kind"
            value={callerKind}
            options={enumOptions(HUMAN_CALLER_KINDS)}
            onChange={setCallerKind}
          />
        </div>
        {!peValid && providerEntityId !== "" ? (
          <p style={alertStyle}>That is not a well-formed provider-entity id.</p>
        ) : null}
        <span style={mutedStyle}>
          The three machine-only channels ({humanize("inbound_visit_failure")},{" "}
          {humanize("inbound_evv_anomaly")}, {humanize("inbound_alert_failure")}) and the{" "}
          {humanize("system_inbound")} caller kind are not offered: those rows are written by the D10
          consumers when M17 detects a no-show, M18 detects a late check-out or an M36 delivery fails.
          Selecting one here would record a machine detection that never happened.
        </span>
      </Card>

      <Card title="Who is on the line">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(14rem, 1fr))",
            gap: t.space3,
          }}
        >
          <TextField label="Caller name" value={callerDisplayName} onChange={setCallerDisplayName} />
          <TextField
            label="Callback number (E.164)"
            value={callerPhone}
            onChange={setCallerPhone}
            type="tel"
            placeholder="+15125550123"
            mono
            hint="The number the callback-SLA detector will chase. Stored, audit-denylisted, never logged."
          />
          <TextField
            label="Relationship to patient"
            value={callerRelationship}
            onChange={setCallerRelationship}
            placeholder="daughter, facility nurse, …"
          />
        </div>
        {!phoneValid ? (
          <p style={alertStyle}>
            A callback number must be E.164 (a leading + and 2–15 digits). An unreachable number on a
            record whose whole purpose is reachability is worse than none.
          </p>
        ) : null}
      </Card>

      <Card title="Which patient (optional now, required before an encounter)">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(14rem, 1fr))",
            gap: t.space3,
          }}
        >
          <TextField label="Patient id" value={patientId} onChange={setPatientId} mono />
          <TextField label="Admission id" value={admissionId} onChange={setAdmissionId} mono />
        </div>
        {!anchorValid ? (
          <p style={alertStyle}>
            Patient and admission travel together or not at all — M8's encounter creator requires both, so
            a call carrying one of the two can never be documented.
          </p>
        ) : null}
        <span style={mutedStyle}>
          Leave both blank if you have not found the chart yet. The clock starts when the phone rings, and
          §3.3 leaves both columns nullable until the caller is resolved to a served person. You can
          identify the patient from the call panel at any point before documenting.
        </span>
      </Card>

      <Card title="Why they rang">
        <TextAreaField
          label="Chief complaint"
          value={chiefComplaint}
          onChange={setChiefComplaint}
          rows={3}
          hint="Free text, audit-denylisted. This is what the D12 protocol suggestion is computed from — the suggestion arrives with the open response and is shown on the panel."
        />
        <TextAreaField
          label="Caller's own words (optional)"
          value={callerQuote}
          onChange={setCallerQuote}
          rows={3}
          hint="Encrypted at rest under the tenant DEK (D14). Reading it back later needs a separate permission, an M2 step-up and leaves an audit row that names you."
        />
      </Card>

      {error ? <p style={alertStyle}>{error}</p> : null}

      <div style={{ display: "flex", gap: t.space2 }}>
        <button
          type="button"
          onClick={() => void open()}
          disabled={!canOpen}
          style={canOpen ? primaryButtonStyle : disabledButtonStyle}
          title={
            canOpen
              ? undefined
              : "A well-formed provider-entity id is required; a callback number must be E.164; patient and admission travel together."
          }
        >
          {busy ? "Opening…" : "Open the call"}
        </button>
      </div>
    </div>
  );
}
