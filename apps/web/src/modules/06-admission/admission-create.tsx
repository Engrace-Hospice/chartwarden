import {
  Button,
  Card,
  FormSection,
  Glyph,
  LeftNavRail,
  PageHeader,
  SelectField,
  StepperWorkflowLayout,
  StickyFooterActions,
  WorkflowStepper,
  t,
  useApiClient,
} from "@wardenx/ui";
import type { WorkflowStep } from "@wardenx/ui";
// Direct intake is a short, governed workflow. It keeps draft values in React state only: browser
// storage would be inappropriate for referral/admission data, and no durable draft endpoint exists.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { MdmEntityLookupField, PatientLookupField } from "../../shell/entity-lookups";
import { fmtDate } from "../../shell/patient-context";
import {
  BenefitPeriodField,
  useBenefitPeriodPlan,
  useHetsHospicePeriods,
} from "./benefit-period-field";
import { localToday } from "./end-of-episode-ui";
import {
  type BenefitPeriodDraft,
  benefitPeriodBody,
  emptyBenefitPeriodDraft,
  endKindLabel,
  validateBenefitPeriod,
} from "./readmission-model";
import { authFailureRedirect } from "./write-workflow";

const INTAKE_METHODS = [
  { value: "in_person", label: "In person" },
  { value: "phone", label: "Phone" },
  { value: "transfer_in", label: "Transfer in" },
] as const;
type IntakeMethod = (typeof INTAKE_METHODS)[number]["value"];
type StepId = "intake" | "clinical" | "review";
const STEP_IDS: readonly StepId[] = ["intake", "clinical", "review"];

export function AdmissionCreate(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [step, setStep] = useState<StepId>("intake");
  // Field errors show only once the user has tried to leave a step with it incomplete.
  const [attempted, setAttempted] = useState<ReadonlySet<StepId>>(new Set());
  const showErrors = attempted.has(step);
  const [patientId, setPatientId] = useState(searchParams.get("patientId") ?? "");
  const [intakeMethod, setIntakeMethod] = useState<IntakeMethod>("in_person");
  const [attendingPhysicianId, setAttendingPhysicianId] = useState("");
  const [hospiceMedicalDirectorId, setHospiceMedicalDirectorId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The first benefit period: our history's suggestion (1 for a patient never served), confirmed against HETS.
  // A transfer-in inherits its period through the transfer-in workflow instead.
  const today = localToday();
  const askPeriod = intakeMethod !== "transfer_in" && patientId.trim().length > 0;
  const plan = useBenefitPeriodPlan(askPeriod ? { patientId: patientId.trim() } : null);
  const loadedPlan = plan && plan !== "error" ? plan : null;
  const suggested = loadedPlan?.suggestion.suggestedSequence ?? null;
  const hets = useHetsHospicePeriods(askPeriod ? patientId.trim() : null);
  const [period, setPeriod] = useState<BenefitPeriodDraft>(() => emptyBenefitPeriodDraft(null));
  const [prefilledFor, setPrefilledFor] = useState<string | null>(null);
  useEffect(() => {
    // Re-prefill when the selected patient changes (a different history).
    if (loadedPlan && prefilledFor !== loadedPlan.patientId) {
      setPeriod(emptyBenefitPeriodDraft(loadedPlan.suggestion.suggestedSequence));
      setPrefilledFor(loadedPlan.patientId);
    }
  }, [loadedPlan, prefilledFor]);
  const periodErrors = askPeriod ? validateBenefitPeriod(period, today) : {};
  const periodReady = !askPeriod || Object.keys(periodErrors).length === 0;

  const intakeReady = patientId.trim().length > 0 && periodReady;
  const clinicalReady = hospiceMedicalDirectorId.trim().length > 0;
  const ready = intakeReady && clinicalReady;
  const currentIndex = STEP_IDS.indexOf(step);
  const completedCount = Number(intakeReady) + Number(clinicalReady);
  const steps = useMemo<readonly WorkflowStep[]>(
    () => [
      {
        id: "intake",
        label: "Intake context",
        description: "Patient, referral and source",
        state: intakeReady ? (step === "intake" ? "in_progress" : "complete") : "in_progress",
      },
      {
        id: "clinical",
        label: "Clinical responsibility",
        description: "Responsible physicians",
        state: clinicalReady ? (step === "clinical" ? "in_progress" : "complete") : "not_started",
        disabled: !intakeReady,
      },
      {
        id: "review",
        label: "Review & create",
        description: "Validate before admission",
        state: ready ? "in_progress" : "blocked",
        disabled: !ready,
      },
    ],
    [clinicalReady, intakeReady, ready, step],
  );

  const submit = useCallback(async () => {
    setSaving(true);
    setError(null);
    const {
      data,
      error: requestError,
      response,
    } = await client.POST("/api/v1/admissions", {
      body: {
        patientId: patientId.trim(),
        intakeMethod,
        ...(attendingPhysicianId.trim()
          ? { attendingPhysicianId: attendingPhysicianId.trim() }
          : {}),
        hospiceMedicalDirectorId: hospiceMedicalDirectorId.trim(),
        ...(askPeriod && benefitPeriodBody(period, suggested, today)
          ? { benefitPeriod: benefitPeriodBody(period, suggested, today) ?? undefined }
          : {}),
      },
    });
    if (requestError || !data) {
      const redirect = authFailureRedirect(
        response?.status,
        requestError?.error?.code,
        window.location.pathname,
      );
      if (redirect) {
        navigate(redirect);
        return;
      }
      setSaving(false);
      if (response?.status === 422)
        setError("Validation failed — check the entered identifiers and try again.");
      else if (response?.status === 403)
        setError("You do not have permission to create an admission.");
      else setError("The admission was not created.");
      return;
    }
    navigate(`/admissions/${data.id}`);
  }, [
    askPeriod,
    attendingPhysicianId,
    client,
    hospiceMedicalDirectorId,
    intakeMethod,
    navigate,
    patientId,
    period,
    suggested,
    today,
  ]);

  function next(): void {
    if (step === "intake" && intakeReady) setStep("clinical");
    else if (step === "clinical" && clinicalReady) setStep("review");
    else setAttempted((prev) => new Set(prev).add(step));
  }
  function previous(): void {
    if (currentIndex > 0) setStep(STEP_IDS[currentIndex - 1] ?? "intake");
  }

  return (
    <StepperWorkflowLayout
      header={
        <PageHeader
          title="New admission"
          breadcrumb="Admissions / Direct intake"
          actions={
            <Link to="/admissions" style={backLinkStyle}>
              <Glyph name="arrow-right" size={14} style={{ transform: "rotate(180deg)" }} />
              <span>Back to census</span>
            </Link>
          }
        >
          <p style={{ margin: 0, color: t.onSurfaceVariant, fontSize: "0.85rem" }}>
            Complete the required intake checks before creating an admission.
          </p>
        </PageHeader>
      }
      steps={
        <LeftNavRail ariaLabel="Admission steps">
          <WorkflowStepper steps={steps} activeId={step} onSelect={(id) => setStep(id as StepId)} />
        </LeftNavRail>
      }
      context={<AdmissionContext intakeMethod={intakeMethod} />}
      footer={
        <StickyFooterActions>
          {currentIndex > 0 ? (
            <Button tone="secondary" onClick={previous} disabled={saving}>
              Back
            </Button>
          ) : null}
          {step !== "review" ? (
            <Button onClick={next} disabled={saving}>
              Continue
            </Button>
          ) : (
            <Button onClick={() => void submit()} loading={saving} disabled={!ready}>
              Create admission
            </Button>
          )}
        </StickyFooterActions>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: t.space5, maxWidth: "48rem" }}>
        <Card as="div" padding={t.space4} style={summaryCardStyle}>
          <div style={summaryIconStyle}>
            <Glyph name={ready ? "check-circle" : "clipboard-check"} size={18} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: "0.875rem", fontWeight: 650, color: t.onSurface }}>
              {completedCount} of 2 required sections complete
            </div>
            <div style={{ color: t.onSurfaceVariant, fontSize: "0.8125rem" }}>
              {ready
                ? "Ready to create the admission."
                : "Patient ID and medical director ID are required before submission."}
            </div>
          </div>
        </Card>
        {error ? (
          <div role="alert" style={alertStyle}>
            <Glyph name="alert" size={16} />
            <span>{error}</span>
          </div>
        ) : null}
        {step === "intake" ? (
          <FormSection
            title="Intake context"
            description="Identify the patient and how this intake arrived."
          >
            <div style={formGrid}>
              <PatientLookupField
                label="Patient"
                value={patientId}
                onChange={setPatientId}
                error={
                  showErrors && !patientId.trim()
                    ? "Select a patient before continuing."
                    : undefined
                }
                required
              />
              <SelectField
                label="Intake method"
                value={intakeMethod}
                onChange={(event) => setIntakeMethod(event.target.value as IntakeMethod)}
                options={INTAKE_METHODS}
              />
            </div>
          </FormSection>
        ) : null}
        {step === "intake" && askPeriod ? (
          <FormSection
            title="Benefit period"
            description="The Medicare benefit period this admission elects into. Medicare counts periods across every hospice."
          >
            {loadedPlan?.previous && loadedPlan.previous.endKind !== "death" ? (
              <p
                style={{
                  margin: `0 0 ${t.space3}`,
                  fontSize: "0.85rem",
                  color: t.onSurfaceVariant,
                }}
              >
                Earlier stay: {endKindLabel(loadedPlan.previous.endKind).toLowerCase()} on{" "}
                {fmtDate(loadedPlan.previous.endedOn)}.{" "}
                {loadedPlan.readmission.eligible ? (
                  <Link to={`/admissions/${loadedPlan.previous.admissionId}/readmit`}>
                    Use the readmission workflow
                  </Link>
                ) : null}
              </p>
            ) : null}
            <BenefitPeriodField
              idPrefix="ac"
              draft={period}
              onChange={(p) => setPeriod((d) => ({ ...d, ...p }))}
              suggested={suggested}
              basis={loadedPlan?.suggestion.basis}
              today={today}
              errors={period.sequence ? periodErrors : {}}
              hets={hets}
            />
          </FormSection>
        ) : null}
        {step === "clinical" ? (
          <FormSection
            title="Clinical responsibility"
            description="Identify the clinicians accountable for the new admission."
          >
            <div style={formGrid}>
              <MdmEntityLookupField
                kind="physician"
                label="Attending physician"
                value={attendingPhysicianId}
                onChange={setAttendingPhysicianId}
                hint="Optional when an attending physician is not yet assigned."
              />
              <MdmEntityLookupField
                kind="physician"
                label="Hospice medical director"
                value={hospiceMedicalDirectorId}
                onChange={setHospiceMedicalDirectorId}
                error={
                  showErrors && !hospiceMedicalDirectorId.trim()
                    ? "Select a hospice medical director."
                    : undefined
                }
                required
              />
            </div>
          </FormSection>
        ) : null}
        {step === "review" ? (
          <FormSection
            title="Review admission"
            description="Confirm the identifiers before creating the admission."
          >
            <dl
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(9rem, auto) 1fr",
                gap: t.space3,
                margin: 0,
              }}
            >
              <ReviewRow label="Patient ID" value={patientId} />
              <ReviewRow
                label="Intake method"
                value={INTAKE_METHODS.find((item) => item.value === intakeMethod)?.label ?? "—"}
              />
              <ReviewRow
                label="Attending physician"
                value={attendingPhysicianId || "Not assigned"}
              />
              <ReviewRow label="Medical director" value={hospiceMedicalDirectorId} />
              {askPeriod ? (
                <ReviewRow
                  label="Benefit period"
                  value={`${period.sequence}${period.hetsConfirmed ? " (HETS-confirmed)" : " (not confirmed in HETS)"}`}
                />
              ) : null}
            </dl>
          </FormSection>
        ) : null}
      </div>
    </StepperWorkflowLayout>
  );
}

function AdmissionContext({ intakeMethod }: { intakeMethod: IntakeMethod }): JSX.Element {
  return (
    <aside
      className="wx-stepper-context"
      style={{ width: "18rem", flexShrink: 0, padding: `0 ${t.space5} ${t.space5} 0` }}
    >
      <Card style={contextCardStyle("var(--color-primary)")}>
        <div style={contextHeadingStyle}>
          <Glyph name="file-text" size={16} />
          <h2 style={{ margin: 0, fontSize: "1rem" }}>Intake context</h2>
        </div>
        <p style={{ margin: 0, color: t.onSurfaceVariant, fontSize: "0.85rem" }}>
          Direct intake is for walk-in, phone or transfer-in patients. Referrals start from the
          Referral Inbox and create admissions through the referral conversion command.
        </p>
        <Link to="/referrals" style={backLinkStyle}>
          <Glyph name="arrow-right" size={14} />
          <span>Start from referral</span>
        </Link>
        <ContextRow
          label="Method"
          value={INTAKE_METHODS.find((item) => item.value === intakeMethod)?.label ?? "—"}
        />
      </Card>
      <Card style={{ ...contextCardStyle("var(--color-outline-variant)"), marginTop: t.space4 }}>
        <div style={contextHeadingStyle}>
          <Glyph name="lock" size={16} />
          <h2 style={{ margin: 0, fontSize: "1rem" }}>Draft handling</h2>
        </div>
        <p style={{ margin: 0, color: t.onSurfaceVariant, fontSize: "0.85rem" }}>
          This screen does not persist a browser draft. Leave it only after submitting or recording
          the intake in an authorized referral workflow.
        </p>
      </Card>
    </aside>
  );
}

function ContextRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
      <span style={{ color: t.onSurfaceVariant, fontSize: "0.75rem" }}>{label}</span>
      <span style={{ color: t.onSurface }}>{value}</span>
    </div>
  );
}
function ReviewRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <>
      <dt style={{ color: t.onSurfaceVariant }}>{label}</dt>
      <dd style={{ margin: 0, fontFamily: t.fontMono }}>{value}</dd>
    </>
  );
}

const formGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(15rem, 1fr))",
  gap: t.space4,
};

const summaryCardStyle = {
  display: "flex",
  alignItems: "center",
  gap: t.space3,
  borderLeft: "4px solid var(--color-primary)",
} as const;

const summaryIconStyle = {
  width: "2.25rem",
  height: "2.25rem",
  borderRadius: t.radiusLg,
  background: t.primaryTint,
  color: t.primary,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
} as const;

const alertStyle = {
  padding: "0.625rem 1rem",
  borderRadius: t.radiusMd,
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  color: t.error,
  fontSize: "0.85rem",
  display: "flex",
  alignItems: "center",
  gap: t.space2,
} as const;

const contextHeadingStyle = {
  display: "flex",
  alignItems: "center",
  gap: t.space2,
  color: t.onSurface,
} as const;

function contextCardStyle(accentColor: string) {
  return {
    // The redesign drops the side rail; the accent colours the card's hairline edge instead.
    border: `1px solid color-mix(in srgb, ${accentColor} 35%, ${t.cardBorder})`,
    display: "flex",
    flexDirection: "column" as const,
    gap: t.space3,
  };
}

const backLinkStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.4rem",
  minHeight: "2.5rem",
  padding: "0.5rem 1rem",
  borderRadius: "9999px",
  background: t.surfaceContainer,
  color: t.onSurface,
  fontSize: "0.8125rem",
  fontWeight: 650,
  textDecoration: "none",
} as const;
