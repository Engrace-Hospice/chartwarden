// apps/web/src/modules/20-field-safety — §5.1 "INCIDENT CREATION"
// (`/safety/incidents/new`, Track B / ADR-0030).
//
// Creates a draft. OSHA-reportable classification is deliberately absent; it is a supervisor step-up on
// the incident detail.
import {
  Button,
  GateStepper,
  PageHeader,
  StepperWorkflowLayout,
  StickyFooterActions,
  useApiClient,
} from "@chartwarden/ui";
import type { GateItem, GateStatus } from "@chartwarden/ui";
import { useCallback, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { MembershipLookupField, PatientLookupField } from "../../shell/entity-lookups";
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
import { Notice } from "./safety-ui";

const FORM_ID = "new-safety-incident-form";
const STEP_TITLES = ["Incident", "Details", "Context & Review"] as const;

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
    });
    setSaving(false);
    if (res.error || !res.incident) {
      setError(errorMessage(res.error, "The incident was not created. Nothing has been recorded."));
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
          {step === 0 ? (
            <Button type="button" tone="primary" disabled={saving} onClick={continueFromIncident}>
              Continue
            </Button>
          ) : step === 1 ? (
            <Button type="button" tone="primary" disabled={saving} onClick={continueFromDetails}>
              Continue
            </Button>
          ) : (
            <Button type="submit" form={FORM_ID} tone="primary" disabled={saving || !ready}>
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
    <section style={sectionStyle} aria-labelledby="incident-step-h">
      <SectionTitle id="incident-step-h" title="Who was affected and when?" />
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
          <TextInput
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
          <SelectInput
            label="Category"
            value={category}
            onChange={setCategory}
            options={INCIDENT_CATEGORIES.map((value) => ({
              value,
              label: incidentCategoryLabel(value),
            }))}
          />
          <SelectInput
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
    <section style={sectionStyle} aria-labelledby="details-step-h">
      <SectionTitle id="details-step-h" title="What happened?" />
      <TextAreaInput
        label="Describe what happened"
        value={narrative}
        onChange={setNarrative}
        required
        minRows={5}
        error={showErrors && !complete ? "The narrative must be at least 200 characters." : null}
        footer={
          <div style={counterRowStyle}>
            <span style={complete ? successTextStyle : helpTextStyle}>
              {characterCounter(narrative, INCIDENT_NARRATIVE_MIN_CHARS)}
            </span>
            <span style={helpTextStyle}>Stored encrypted under your agency key.</span>
          </div>
        }
      />
      <TextAreaInput
        label="Witnesses"
        value={witnesses}
        onChange={setWitnesses}
        minRows={3}
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
    <section style={sectionStyle} aria-labelledby="review-step-h">
      <SectionTitle id="review-step-h" title="Context & Review" />
      <div style={summaryPanelStyle}>
        <h3 style={panelTitleStyle}>Incident summary</h3>
        <div style={summaryGridStyle}>
          <ReviewField
            label="Affected clinician"
            value={affectedName || affected.trim() || "Missing"}
          />
          <ReviewField
            label="Occurred at"
            value={occurredAt.trim() ? localDateTimeLabel(occurredAt) : "Missing"}
          />
          <ReviewField label="Category" value={incidentCategoryLabel(category)} />
          <ReviewField label="Severity" value={humanize(severity)} />
          <ReviewField label="Narrative" value={narrativeComplete ? "Completed" : "Missing"} />
        </div>
        {!ready ? <p style={warningTextStyle}>Required information is still missing.</p> : null}
        <p style={helpTextStyle}>
          This creates a draft only. OSHA reportability is reviewed later on the incident detail
          page.
        </p>
      </div>

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
            <TextInput
              label="Location"
              value={locationDescription}
              onChange={setLocationDescription}
              placeholder="Front porch, second landing, driveway..."
              hint="Plain words are enough; do not enter coordinates here."
            />
            <TextInput label="Visit" value={visitId} onChange={setVisitId} mono />
            <PatientLookupField
              label="Patient"
              value={patientId}
              onChange={(id) => setPatientId(id)}
            />
            <TextInput label="Linked SOS alert" value={sosAlertId} onChange={setSosAlertId} mono />
          </div>
        ) : null}
      </section>

      <section style={summaryPanelStyle} aria-label="Workers' compensation">
        <h3 style={panelTitleStyle}>Workers' compensation</h3>
        <label style={checkStyle}>
          <input
            type="checkbox"
            checked={wcInitiated}
            onChange={(event) => setWcInitiated(event.target.checked)}
          />
          <span>A workers' compensation claim has already been initiated</span>
        </label>
        {wcInitiated ? (
          <TextInput
            label="Claim reference"
            value={wcReference}
            onChange={setWcReference}
            mono
            hint="Reference from the claim system, insurer, or internal workflow."
          />
        ) : null}
      </section>
    </section>
  );
}

function SectionTitle({ id, title }: { id: string; title: string }): JSX.Element {
  return (
    <div style={toolbarTitleStyle}>
      <span style={toolbarEyebrowStyle}>Step</span>
      <h2 id={id} style={sectionTitleStyle}>
        {title}
      </h2>
    </div>
  );
}

function ReviewField({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <div style={reviewFieldStyle}>
      <span style={labelStyle}>{label}</span>
      <span style={mono ? monoValueStyle : reviewValueStyle}>{value}</span>
    </div>
  );
}

function TextInput({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  mono,
  required,
  hint,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "datetime-local";
  placeholder?: string;
  mono?: boolean;
  required?: boolean;
  hint?: string;
  error?: string | null;
}): JSX.Element {
  return (
    <label style={fieldStyle}>
      <span style={labelRowStyle}>
        <span style={labelStyle}>
          {label}
          {required ? " *" : ""}
        </span>
      </span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        required={required}
        aria-invalid={error ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
        style={mono ? { ...inputStyle, fontFamily: "var(--font-mono)" } : inputStyle}
      />
      {error ? (
        <span style={warningTextStyle}>{error}</span>
      ) : hint ? (
        <span style={helpTextStyle}>{hint}</span>
      ) : null}
    </label>
  );
}

function TextAreaInput({
  label,
  value,
  onChange,
  placeholder,
  required,
  minRows,
  error,
  footer,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  minRows: number;
  error?: string | null;
  footer?: JSX.Element;
}): JSX.Element {
  return (
    <label style={fieldStyle}>
      <span style={labelStyle}>
        {label}
        {required ? " *" : ""}
      </span>
      <textarea
        value={value}
        rows={minRows}
        onChange={(event) => onChange(event.target.value)}
        style={textareaStyle}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        required={required}
        placeholder={placeholder}
      />
      {error ? <span style={warningTextStyle}>{error}</span> : null}
      {footer}
    </label>
  );
}

function SelectInput({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <label style={fieldStyle}>
      <span style={labelStyle}>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} style={inputStyle}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
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
const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.3rem",
};
const labelStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
  fontWeight: 650,
};
const labelRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.5rem",
};
const inputStyle: CSSProperties = {
  minHeight: "2.5rem",
  padding: "0.45rem 0.6rem",
  border: "none",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface)",
  fontSize: "0.875rem",
};
const textareaStyle: CSSProperties = {
  width: "100%",
  minHeight: "7rem",
  maxHeight: "16rem",
  padding: "0.55rem 0.65rem",
  border: "none",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface)",
  fontFamily: "inherit",
  fontSize: "0.875rem",
  resize: "vertical",
};
const helpTextStyle: CSSProperties = {
  margin: 0,
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8rem",
  lineHeight: 1.45,
};
const warningTextStyle: CSSProperties = {
  ...helpTextStyle,
  color: "var(--color-error)",
};
const successTextStyle: CSSProperties = {
  ...helpTextStyle,
  color: "var(--color-success)",
};
const counterRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.5rem",
};
const summaryPanelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  padding: "1rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-lowest)",
  boxShadow: "var(--shadow-soft)",
};
const panelTitleStyle: CSSProperties = {
  margin: 0,
  color: "var(--color-on-surface)",
  fontSize: "0.95rem",
  fontWeight: 650,
};
const summaryGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))",
  gap: "0.85rem 1rem",
};
const reviewFieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.2rem",
};
const reviewValueStyle: CSSProperties = {
  color: "var(--color-on-surface)",
  fontSize: "0.875rem",
};
const monoValueStyle: CSSProperties = {
  ...reviewValueStyle,
  fontFamily: "var(--font-mono)",
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
