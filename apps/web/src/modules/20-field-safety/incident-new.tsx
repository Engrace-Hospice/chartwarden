// apps/web/src/modules/20-field-safety — §5.1 "INCIDENT CREATION"
// (`/safety/incidents/new`, Track B / ADR-0030).
//
// Creates a draft. OSHA-reportable classification is deliberately absent; it is a supervisor step-up on
// the incident detail.
import {
  Button,
  GateStepper,
  PageHeader,
  Panel,
  StepperWorkflowLayout,
  StickyFooterActions,
  useApiClient,
} from "@chartwarden/ui";
import type { GateItem, GateStatus } from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { MembershipLookupField, PatientLookupField } from "../../shell/entity-lookups";
import {
  type SafetyIncidentCategory,
  type SafetyIncidentSeverity,
  createIncident,
  writeErrorMessage,
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
import { Field, Notice, SelectField, SummaryGrid, TextAreaField, TextField } from "./safety-ui";

const FORM_ID = "new-safety-incident-form";
const STEP_TITLES = ["Incident", "Details", "Context & Review"] as const;
// The heading id each step's SectionTitle renders (and its section is labelled by); a step change moves focus onto it.
const STEP_HEADING_IDS = ["incident-step-h", "details-step-h", "review-step-h"] as const;

function stepStatus(stepIndex: number, activeIndex: number): GateStatus {
  if (stepIndex < activeIndex) return "complete";
  if (stepIndex === activeIndex) return "in-progress";
  return "not-started";
}

export function IncidentNewScreen(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const linkedSosAlertId = params.get("sosAlertId") ?? "";

  const [step, setStep] = useState(0);
  const [affected, setAffected] = useState("");
  const [affectedName, setAffectedName] = useState("");
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
  const [incidentAttempted, setIncidentAttempted] = useState(false);
  const [detailsAttempted, setDetailsAttempted] = useState(false);
  const [optionalOpen, setOptionalOpen] = useState(linkedSosAlertId.trim().length > 0);

  const incidentComplete = affected.trim().length > 0 && occurredAt.trim().length > 0;
  const detailsComplete = meetsMinChars(narrative, INCIDENT_NARRATIVE_MIN_CHARS);
  const ready = incidentComplete && detailsComplete;
  const narrativeCount = narrative.trim().length;
  const hasOptionalContext =
    locationDescription.trim().length > 0 ||
    visitId.trim().length > 0 ||
    patientId.trim().length > 0 ||
    sosAlertId.trim().length > 0;

  const steps: GateItem[] = useMemo(
    () =>
      STEP_TITLES.map((title, i) => ({
        id: `incident-step-${i}`,
        label: `${i + 1}. ${title}`,
        status: stepStatus(i, step),
        detail:
          i === 0
            ? incidentComplete
              ? "Clinician and time set"
              : "Clinician and time required"
            : i === 1
              ? detailsComplete
                ? "Narrative complete"
                : `${Math.min(narrativeCount, INCIDENT_NARRATIVE_MIN_CHARS)} / ${INCIDENT_NARRATIVE_MIN_CHARS} minimum`
              : hasOptionalContext
                ? "Optional context included"
                : "Review and create draft",
      })),
    [detailsComplete, hasOptionalContext, incidentComplete, narrativeCount, step],
  );

  const submit = useCallback(async () => {
    if (!ready) {
      setIncidentAttempted(true);
      setDetailsAttempted(true);
      setStep(incidentComplete ? 1 : 0);
      return;
    }
    setSaving(true);
    setError(null);
    // The client REJECTS on a network failure; `null` is that, and `saving` is reset either way.
    const res = await createIncident(client, {
      affectedClinicianMembershipId: affected.trim(),
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
    }).catch(() => null);
    setSaving(false);
    if (!res || res.error || !res.incident) {
      setError(writeErrorMessage(res, "The incident was not created. Nothing has been recorded."));
      return;
    }
    navigate(`/safety/incidents/${res.incident.id}`);
  }, [
    affected,
    category,
    client,
    incidentComplete,
    locationDescription,
    narrative,
    navigate,
    occurredAt,
    patientId,
    ready,
    severity,
    sosAlertId,
    visitId,
    wcInitiated,
    wcReference,
    witnesses,
  ]);

  // Changing step replaces the focused Continue/Back button (distinct keys in the footer, and Back is absent on
  // step 0). Focus would fall to <body> and the new step go unannounced: land on its heading instead.
  const previousStep = useRef(step);
  useEffect(() => {
    if (previousStep.current === step) return;
    previousStep.current = step;
    const active = document.activeElement;
    const headingId = STEP_HEADING_IDS[step];
    if (headingId && (!active || active === document.body))
      document.getElementById(headingId)?.focus();
  }, [step]);

  const continueFromIncident = (): void => {
    setIncidentAttempted(true);
    if (incidentComplete) setStep(1);
  };

  const continueFromDetails = (): void => {
    setDetailsAttempted(true);
    if (detailsComplete) setStep(2);
  };

  return (
    <StepperWorkflowLayout
      header={
        <PageHeader
          title="Report a Safety Incident"
          actions={
            <Link to="/safety/incidents" style={linkButtonStyle}>
              Back to ledger
            </Link>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Create an encrypted incident report for supervisor review.
          </div>
        </PageHeader>
      }
      steps={
        <GateStepper
          items={steps}
          ariaLabel="Safety incident report steps"
          surfaceBlockersFirst={false}
        />
      }
      footer={
        <StickyFooterActions>
          {step > 0 ? (
            <Button
              type="button"
              tone="secondary"
              disabled={saving}
              onClick={() => setStep((s) => s - 1)}
            >
              Back
            </Button>
          ) : (
            <Link to="/safety/incidents" style={linkButtonStyle}>
              Discard
            </Link>
          )}
          {/* Distinct keys: one reused <button> flips to type="submit" before a real click's default
              action runs, so "Continue" on the details step created the draft without the review step. */}
          {step === 0 ? (
            <Button
              key="continue-incident"
              type="button"
              tone="primary"
              disabled={saving}
              onClick={continueFromIncident}
            >
              Continue
            </Button>
          ) : step === 1 ? (
            <Button
              key="continue-details"
              type="button"
              tone="primary"
              disabled={saving}
              onClick={continueFromDetails}
            >
              Continue
            </Button>
          ) : (
            <Button
              key="create-draft"
              type="submit"
              form={FORM_ID}
              tone="primary"
              disabled={saving || !ready}
            >
              {saving ? "Creating..." : "Create draft"}
            </Button>
          )}
        </StickyFooterActions>
      }
    >
      <form
        id={FORM_ID}
        style={formWrapStyle}
        onSubmit={(event) => {
          event.preventDefault();
          if (!saving) void submit();
        }}
      >
        {linkedSosAlertId ? (
          <Notice tone="info" live>
            Opened from SOS <strong>{linkedSosAlertId}</strong>. The linked alert is included in
            optional context.
          </Notice>
        ) : null}
        {error ? (
          <Notice tone="error" assertive>
            {error}
          </Notice>
        ) : null}

        {step === 0 ? (
          <IncidentStep
            affected={affected}
            setAffected={(id, name) => {
              setAffected(id);
              setAffectedName(name);
            }}
            occurredAt={occurredAt}
            setOccurredAt={setOccurredAt}
            category={category}
            setCategory={setCategory}
            severity={severity}
            setSeverity={setSeverity}
            showErrors={incidentAttempted}
          />
        ) : null}

        {step === 1 ? (
          <DetailsStep
            narrative={narrative}
            setNarrative={setNarrative}
            witnesses={witnesses}
            setWitnesses={setWitnesses}
            showErrors={detailsAttempted}
          />
        ) : null}

        {step === 2 ? (
          <ReviewStep
            affected={affected}
            affectedName={affectedName}
            occurredAt={occurredAt}
            category={category}
            severity={severity}
            narrativeComplete={detailsComplete}
            locationDescription={locationDescription}
            setLocationDescription={setLocationDescription}
            visitId={visitId}
            setVisitId={setVisitId}
            patientId={patientId}
            setPatientId={setPatientId}
            sosAlertId={sosAlertId}
            setSosAlertId={setSosAlertId}
            optionalOpen={optionalOpen}
            setOptionalOpen={setOptionalOpen}
            hasOptionalContext={hasOptionalContext}
            wcInitiated={wcInitiated}
            setWcInitiated={setWcInitiated}
            wcReference={wcReference}
            setWcReference={setWcReference}
            ready={ready}
          />
        ) : null}
      </form>
    </StepperWorkflowLayout>
  );
}

function IncidentStep({
  affected,
  setAffected,
  occurredAt,
  setOccurredAt,
  category,
  setCategory,
  severity,
  setSeverity,
  showErrors,
}: {
  affected: string;
  setAffected: (id: string, name: string) => void;
  occurredAt: string;
  setOccurredAt: (value: string) => void;
  category: string;
  setCategory: (value: string) => void;
  severity: string;
  setSeverity: (value: string) => void;
  showErrors: boolean;
}): JSX.Element {
  return (
    <section style={sectionStyle} aria-labelledby={STEP_HEADING_IDS[0]}>
      <SectionTitle id={STEP_HEADING_IDS[0]} title="Who was affected and when?" />
      <div style={stackStyle}>
        <MembershipLookupField
          label="Affected clinician"
          value={affected}
          onChange={(id, option) => setAffected(id, option?.searchLabel ?? "")}
          required
          error={
            showErrors && affected.trim().length === 0 ? "Affected clinician is required." : null
          }
        />
        <div style={gridStyle}>
          <TextField
            label="Occurred at"
            value={occurredAt}
            onChange={setOccurredAt}
            type="datetime-local"
            required
            error={
              showErrors && occurredAt.trim().length === 0
                ? "Incident date/time is required."
                : null
            }
          />
          <SelectField
            label="Category"
            value={category}
            onChange={setCategory}
            options={INCIDENT_CATEGORIES.map((value) => ({
              value,
              label: incidentCategoryLabel(value),
            }))}
          />
          <SelectField
            label="Severity"
            value={severity}
            onChange={setSeverity}
            options={INCIDENT_SEVERITIES.map((value) => ({ value, label: humanize(value) }))}
          />
        </div>
      </div>
    </section>
  );
}

function DetailsStep({
  narrative,
  setNarrative,
  witnesses,
  setWitnesses,
  showErrors,
}: {
  narrative: string;
  setNarrative: (value: string) => void;
  witnesses: string;
  setWitnesses: (value: string) => void;
  showErrors: boolean;
}): JSX.Element {
  const complete = meetsMinChars(narrative, INCIDENT_NARRATIVE_MIN_CHARS);
  return (
    <section style={sectionStyle} aria-labelledby={STEP_HEADING_IDS[1]}>
      <SectionTitle id={STEP_HEADING_IDS[1]} title="What happened?" />
      <TextAreaField
        label="Describe what happened"
        value={narrative}
        onChange={setNarrative}
        required
        rows={5}
        error={showErrors && !complete ? "The narrative must be at least 200 characters." : null}
        hint={
          <span style={counterRowStyle}>
            <span className={complete ? "wx-text-success" : undefined}>
              {characterCounter(narrative, INCIDENT_NARRATIVE_MIN_CHARS)}
            </span>
            <span>Stored encrypted under your agency key.</span>
          </span>
        }
      />
      <TextAreaField
        label="Witnesses"
        value={witnesses}
        onChange={setWitnesses}
        rows={3}
        placeholder="Names, roles, or none known."
      />
    </section>
  );
}

function ReviewStep({
  affected,
  affectedName,
  occurredAt,
  category,
  severity,
  narrativeComplete,
  locationDescription,
  setLocationDescription,
  visitId,
  setVisitId,
  patientId,
  setPatientId,
  sosAlertId,
  setSosAlertId,
  optionalOpen,
  setOptionalOpen,
  hasOptionalContext,
  wcInitiated,
  setWcInitiated,
  wcReference,
  setWcReference,
  ready,
}: {
  affected: string;
  affectedName: string;
  occurredAt: string;
  category: string;
  severity: string;
  narrativeComplete: boolean;
  locationDescription: string;
  setLocationDescription: (value: string) => void;
  visitId: string;
  setVisitId: (value: string) => void;
  patientId: string;
  setPatientId: (value: string) => void;
  sosAlertId: string;
  setSosAlertId: (value: string) => void;
  optionalOpen: boolean;
  setOptionalOpen: (value: boolean) => void;
  hasOptionalContext: boolean;
  wcInitiated: boolean;
  setWcInitiated: (value: boolean) => void;
  wcReference: string;
  setWcReference: (value: string) => void;
  ready: boolean;
}): JSX.Element {
  return (
    <section style={sectionStyle} aria-labelledby={STEP_HEADING_IDS[2]}>
      <SectionTitle id={STEP_HEADING_IDS[2]} title="Context & Review" />
      <Panel stack headingLevel={3} title="Incident summary">
        <SummaryGrid>
          <Field label="Affected clinician" value={affectedName || affected.trim() || "Missing"} />
          <Field
            label="Occurred at"
            value={occurredAt.trim() ? localDateTimeLabel(occurredAt) : "Missing"}
          />
          <Field label="Category" value={incidentCategoryLabel(category)} />
          <Field label="Severity" value={humanize(severity)} />
          <Field label="Narrative" value={narrativeComplete ? "Completed" : "Missing"} />
        </SummaryGrid>
        {!ready ? <p className="wx-text-error">Required information is still missing.</p> : null}
        <p className="wx-text-muted">
          This creates a draft only. OSHA reportability is reviewed later on the incident detail
          page.
        </p>
      </Panel>

      <section style={collapsibleStyle}>
        <button
          type="button"
          style={collapsibleButtonStyle}
          aria-expanded={optionalOpen}
          onClick={() => setOptionalOpen(!optionalOpen)}
        >
          <span>{optionalOpen ? "Hide optional context" : "Add optional context"}</span>
          {hasOptionalContext ? <span style={contextSignalStyle}>Contains data</span> : null}
        </button>
        {optionalOpen ? (
          <div style={gridStyle}>
            <TextField
              label="Location"
              value={locationDescription}
              onChange={setLocationDescription}
              placeholder="Front porch, second landing, driveway..."
              hint="Plain words are enough; do not enter coordinates here."
            />
            <TextField label="Visit" value={visitId} onChange={setVisitId} mono />
            <PatientLookupField
              label="Patient"
              value={patientId}
              onChange={(id) => setPatientId(id)}
            />
            <TextField label="Linked SOS alert" value={sosAlertId} onChange={setSosAlertId} mono />
          </div>
        ) : null}
      </section>

      <Panel stack headingLevel={3} title="Workers' compensation">
        <label style={checkStyle}>
          <input
            type="checkbox"
            checked={wcInitiated}
            onChange={(event) => setWcInitiated(event.target.checked)}
          />
          <span>A workers' compensation claim has already been initiated</span>
        </label>
        {wcInitiated ? (
          <TextField
            label="Claim reference"
            value={wcReference}
            onChange={setWcReference}
            mono
            hint="Reference from the claim system, insurer, or internal workflow."
          />
        ) : null}
      </Panel>
    </section>
  );
}

function SectionTitle({ id, title }: { id: string; title: string }): JSX.Element {
  return (
    <div style={toolbarTitleStyle}>
      <span style={toolbarEyebrowStyle}>Step</span>
      <h2 id={id} tabIndex={-1} style={sectionTitleStyle}>
        {title}
      </h2>
    </div>
  );
}

function characterCounter(value: string, min: number): string {
  const count = value.trim().length;
  return count >= min ? `${count} characters` : `${count} / ${min} minimum`;
}

function localDateTimeLabel(value: string): string {
  return value.replace("T", " ");
}

const linkButtonStyle: CSSProperties = {
  minHeight: "2.5rem",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0 1rem",
  borderRadius: "9999px",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.8125rem",
  fontWeight: 650,
  textDecoration: "none",
};
const formWrapStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  maxWidth: "54rem",
  width: "100%",
};
const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
};
const stackStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.9rem",
};
const toolbarTitleStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.125rem",
  color: "var(--color-on-surface)",
  fontSize: "0.875rem",
};
const toolbarEyebrowStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};
const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "1.15rem",
  fontWeight: 650,
  color: "var(--color-on-surface)",
};
const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(13rem, 1fr))",
  gap: "0.75rem",
};
const counterRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.5rem",
};
const collapsibleStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.85rem",
};
const collapsibleButtonStyle: CSSProperties = {
  minHeight: "2.75rem",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  padding: "0.65rem 0.9rem",
  border: "none",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
  fontWeight: 650,
  cursor: "pointer",
};
const contextSignalStyle: CSSProperties = {
  color: "var(--color-success)",
  fontSize: "0.75rem",
  fontWeight: 650,
};
const checkStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.5rem",
  minHeight: "2.5rem",
  color: "var(--color-on-surface)",
  fontSize: "0.875rem",
};
