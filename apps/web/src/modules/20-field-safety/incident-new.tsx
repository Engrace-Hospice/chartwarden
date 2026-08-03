// apps/web/src/modules/20-field-safety — §5.1 "INCIDENT CREATION"
// (`/safety/incidents/new`, Track B / ADR-0030).
//
// The form a clinician fills in after a dog bite, a threat, or a car hitting her on the way out. §5.1 says
// it is "pre-populated when launched from an SOS detail page", which is what the `?sosAlertId=` query
// parameter does — the SOS detail screen's own CTA passes it, and the field is shown filled and editable
// rather than hidden, so the link between the two records is a thing the reporter can see and correct.
//
// ── `oshaReportable` IS NOT ON THIS FORM AND MUST NEVER BE ───────────────────────────────────────────
//
// §4.2's `CreateIncidentBody` omits it deliberately (D9): the classification is a supervisor's separate,
// step-up'd act. A checkbox here would let a clinician file with a state agency on her own say-so, or —
// worse — let a supervisor filing on her behalf pre-answer the question the sign-off exists to ask. The
// form says where the decision happens instead of pretending it is not made.
//
// ── THE AFFECTED CLINICIAN IS AN ID, AND THAT IS A REAL LIMIT ───────────────────────────────────────
//
// §2.2.3 lets a supervisor open an incident naming somebody else, so the field must exist. M20 publishes
// no membership directory (M2/M40 own that and M20 holds no reader for either), so it is a typed id with
// its consequence spelled out beside it: naming a membership other than your own makes this a
// filed-on-behalf incident, and §6 then requires HER acknowledgment before it can close.
import { PageHeader, t, useApiClient } from "@wardenx/ui";
import { useCallback, useState } from "react";
import type { JSX } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  type SafetyIncidentCategory,
  type SafetyIncidentSeverity,
  createIncident,
  errorMessage,
} from "./safety-api";
import {
  DEFAULT_INCIDENT_CATEGORY,
  DEFAULT_INCIDENT_SEVERITY,
  INCIDENT_CATEGORIES,
  INCIDENT_NARRATIVE_MIN_CHARS,
  INCIDENT_SEVERITIES,
  humanize,
  incidentCategoryLabel,
  meetsMinChars,
  nowLocalInput,
  toInstant,
} from "./safety-status";
import {
  Card,
  CheckboxField,
  Notice,
  SelectField,
  TextAreaField,
  TextField,
  columnStyle,
  disabledButtonStyle,
  ghostButtonStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
} from "./safety-ui";

export function IncidentNewScreen(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const linkedSosAlertId = params.get("sosAlertId") ?? "";

  const [affected, setAffected] = useState("");
  const [category, setCategory] = useState(DEFAULT_INCIDENT_CATEGORY);
  const [severity, setSeverity] = useState(DEFAULT_INCIDENT_SEVERITY);
  const [occurredAt, setOccurredAt] = useState(nowLocalInput());
  const [visitId, setVisitId] = useState("");
  const [patientId, setPatientId] = useState("");
  const [locationDescription, setLocationDescription] = useState("");
  const [narrative, setNarrative] = useState("");
  const [witnesses, setWitnesses] = useState("");
  const [sosAlertId, setSosAlertId] = useState(linkedSosAlertId);
  const [wcInitiated, setWcInitiated] = useState(false);
  const [wcReference, setWcReference] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready =
    affected.trim().length > 0 && meetsMinChars(narrative, INCIDENT_NARRATIVE_MIN_CHARS);

  const submit = useCallback(async () => {
    setSaving(true);
    setError(null);
    const res = await createIncident(client, {
      affectedClinicianMembershipId: affected.trim(),
      // `category`/`severity` are always one of the closed vocabularies the SelectFields below offer.
      category: category as SafetyIncidentCategory,
      severity: severity as SafetyIncidentSeverity,
      occurredAt: toInstant(occurredAt),
      ...(visitId.trim() ? { visitId: visitId.trim() } : {}),
      ...(patientId.trim() ? { patientId: patientId.trim() } : {}),
      ...(locationDescription.trim() ? { locationDescription: locationDescription.trim() } : {}),
      narrative,
      ...(witnesses.trim() ? { witnesses } : {}),
      ...(sosAlertId.trim() ? { linkedSosAlertId: sosAlertId.trim() } : {}),
      workersCompClaimInitiated: wcInitiated,
      ...(wcReference.trim() ? { workersCompClaimReference: wcReference.trim() } : {}),
    });
    setSaving(false);
    if (res.error || !res.incident) {
      setError(errorMessage(res.error, "The incident was not created. Nothing has been recorded."));
      return;
    }
    // Straight to the draft, not back to the ledger: the next act is almost always to re-read what you
    // wrote and submit it, and a redirect to a list makes the reporter hunt for her own row.
    navigate(`/safety/incidents/${res.incident.id}`);
  }, [
    affected,
    category,
    client,
    locationDescription,
    narrative,
    navigate,
    occurredAt,
    patientId,
    severity,
    sosAlertId,
    visitId,
    wcInitiated,
    wcReference,
    witnesses,
  ]);

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Report a safety incident</span>}
        breadcrumb="Field safety · Incidents"
        actions={
          <Link to="/safety/incidents" style={ghostButtonStyle}>
            Back to ledger
          </Link>
        }
      />

      {linkedSosAlertId ? (
        <Notice tone="info" live>
          This form was opened from SOS <strong>{linkedSosAlertId}</strong> and the link is filled in
          below. Clear it if this incident is about something else — the two records are joined by that
          field and by nothing implicit.
        </Notice>
      ) : null}

      <Card title="Who and when">
        <TextField
          label="Affected clinician (membership id)"
          value={affected}
          onChange={setAffected}
          mono
          hint="Your own membership for your own incident. Naming somebody else files it on her behalf — §6 then requires HER acknowledgment before it can close, and that acknowledgment cannot be recorded for her."
        />
        <TextField
          label="When did it happen?"
          value={occurredAt}
          onChange={setOccurredAt}
          type="datetime-local"
          hint="Must not be after the moment you file — the database enforces that, so a mistyped year is refused rather than stored."
        />
        <span style={mutedStyle}>
          Membership, visit and patient are typed ids because M20 publishes no directory for any of the
          three. M2, M17 and M5 own them and M20 holds no reader; a picker here would be a second,
          drifting copy of somebody else's record.
        </span>
      </Card>

      <Card title="What happened">
        <SelectField
          label="Category"
          value={category}
          options={INCIDENT_CATEGORIES.map((v) => ({ value: v, label: incidentCategoryLabel(v) }))}
          onChange={setCategory}
        />
        <SelectField
          label="Severity — as you judge it"
          value={severity}
          options={INCIDENT_SEVERITIES.map((v) => ({ value: v, label: humanize(v) }))}
          onChange={setSeverity}
        />
        <TextAreaField
          label="Tell it in your own words"
          value={narrative}
          onChange={setNarrative}
          rows={10}
          minChars={INCIDENT_NARRATIVE_MIN_CHARS}
          hint="Stored encrypted under your agency's key. This is the account an insurer, a supervisor and possibly a state agency will read — write it while you remember it."
        />
        <TextField
          label="Where (a description, not an address)"
          value={locationDescription}
          onChange={setLocationDescription}
          placeholder="Front porch, second landing, driveway…"
        />
        <TextAreaField
          label="Witnesses"
          value={witnesses}
          onChange={setWitnesses}
          rows={3}
          hint="Names and how to reach them. Also stored encrypted."
        />
      </Card>

      <Card title="Links and claims">
        <TextField label="Visit id" value={visitId} onChange={setVisitId} mono />
        <TextField label="Patient id" value={patientId} onChange={setPatientId} mono />
        <TextField label="Linked SOS alert id" value={sosAlertId} onChange={setSosAlertId} mono />
        <CheckboxField
          label="A workers' compensation claim has already been initiated"
          checked={wcInitiated}
          onChange={setWcInitiated}
        />
        {wcInitiated ? (
          <TextField label="Claim reference" value={wcReference} onChange={setWcReference} mono />
        ) : null}
      </Card>

      <Card title="What this form does not ask">
        <span style={mutedStyle}>
          <strong>Whether this is OSHA-reportable.</strong> That is a supervisor's separate, step-up'd
          sign-off (D9) made on the incident's own page, and it is deliberately not a box on this form: a
          filing with a state agency should never rest on the reporting clinician's own classification,
          and a supervisor filing on her behalf should not be able to pre-answer it either. File the facts;
          the classification is somebody else's named act.
        </span>
      </Card>

      {error ? (
        <Notice tone="error" assertive>
          {error}
        </Notice>
      ) : null}

      <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={saving || !ready}
          style={saving || !ready ? disabledButtonStyle : primaryButtonStyle}
        >
          {saving ? "Creating…" : "Create draft"}
        </button>
        <Link to="/safety/incidents" style={ghostButtonStyle}>
          Discard
        </Link>
      </div>
      <span style={mutedStyle}>
        This creates a <strong>draft</strong>. Nothing is submitted, nobody is notified, and you can edit
        every field until you submit it yourself.
      </span>
    </div>
  );
}
