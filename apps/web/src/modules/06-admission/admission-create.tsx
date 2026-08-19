import {
  Button,
  Card,
  FormSection,
  LeftNavRail,
  PageHeader,
  SelectField,
  StepperWorkflowLayout,
  StickyFooterActions,
  TextField,
  WorkflowStepper,
  t,
  useApiClient,
} from "@wardenx/ui";
import type { WorkflowStep } from "@wardenx/ui";
// Direct intake is a short, governed workflow. It keeps draft values in React state only: browser
// storage would be inappropriate for referral/admission data, and no durable draft endpoint exists.
import { useCallback, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
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
  const [params] = useSearchParams();
  const [step, setStep] = useState<StepId>("intake");
  const [patientId, setPatientId] = useState("");
  const [referralId, setReferralId] = useState(params.get("referralId") ?? "");
  const [intakeMethod, setIntakeMethod] = useState<IntakeMethod>("in_person");
  const [attendingPhysicianId, setAttendingPhysicianId] = useState("");
  const [hospiceMedicalDirectorId, setHospiceMedicalDirectorId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const intakeReady = patientId.trim().length > 0;
  const clinicalReady = hospiceMedicalDirectorId.trim().length > 0;
  const ready = intakeReady && clinicalReady;
  const currentIndex = STEP_IDS.indexOf(step);
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
        ...(referralId.trim() ? { referralId: referralId.trim() } : {}),
        intakeMethod,
        ...(attendingPhysicianId.trim()
          ? { attendingPhysicianId: attendingPhysicianId.trim() }
          : {}),
        hospiceMedicalDirectorId: hospiceMedicalDirectorId.trim(),
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
    attendingPhysicianId,
    client,
    hospiceMedicalDirectorId,
    intakeMethod,
    navigate,
    patientId,
    referralId,
  ]);

  function next(): void {
    if (step === "intake" && intakeReady) setStep("clinical");
    else if (step === "clinical" && clinicalReady) setStep("review");
  }
  function previous(): void {
    if (currentIndex > 0) setStep(STEP_IDS[currentIndex - 1] ?? "intake");
  }

  return (
    <StepperWorkflowLayout
      header={
        <PageHeader
          title="New admission"
          breadcrumb="Admissions · Direct intake"
          actions={
            <Link to="/admissions" style={backLinkStyle}>
              Back to census
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
      context={<AdmissionContext referralId={referralId} intakeMethod={intakeMethod} />}
      footer={
        <StickyFooterActions>
          {currentIndex > 0 ? (
            <Button tone="secondary" onClick={previous} disabled={saving}>
              Back
            </Button>
          ) : null}
          {step !== "review" ? (
            <Button
              onClick={next}
              disabled={saving || (step === "intake" ? !intakeReady : !clinicalReady)}
            >
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
        {step === "intake" ? (
          <FormSection
            title="Intake context"
            description="Identify the patient and how this intake arrived."
          >
            <div style={formGrid}>
              <TextField
                label="Patient ID"
                value={patientId}
                onChange={(event) => setPatientId(event.target.value)}
                error={patientId.trim() ? undefined : "Patient ID is required before continuing."}
                required
              />
              <TextField
                label="Referral ID"
                value={referralId}
                onChange={(event) => setReferralId(event.target.value)}
                hint="Optional for direct walk-in, phone or transfer intake."
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
        {step === "clinical" ? (
          <FormSection
            title="Clinical responsibility"
            description="Identify the clinicians accountable for the new admission."
          >
            <div style={formGrid}>
              <TextField
                label="Attending physician ID"
                value={attendingPhysicianId}
                onChange={(event) => setAttendingPhysicianId(event.target.value)}
                hint="Optional when an attending physician is not yet assigned."
              />
              <TextField
                label="Hospice medical director ID"
                value={hospiceMedicalDirectorId}
                onChange={(event) => setHospiceMedicalDirectorId(event.target.value)}
                error={
                  hospiceMedicalDirectorId.trim()
                    ? undefined
                    : "A hospice medical director is required."
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
              <ReviewRow label="Referral ID" value={referralId || "Not provided"} />
              <ReviewRow
                label="Intake method"
                value={INTAKE_METHODS.find((item) => item.value === intakeMethod)?.label ?? "—"}
              />
              <ReviewRow
                label="Attending physician"
                value={attendingPhysicianId || "Not assigned"}
              />
              <ReviewRow label="Medical director" value={hospiceMedicalDirectorId} />
            </dl>
            {error ? (
              <p role="alert" style={{ color: t.error, margin: `${t.space5} 0 0` }}>
                {error}
              </p>
            ) : null}
          </FormSection>
        ) : null}
      </div>
    </StepperWorkflowLayout>
  );
}

function AdmissionContext({
  referralId,
  intakeMethod,
}: { referralId: string; intakeMethod: IntakeMethod }): JSX.Element {
  return (
    <aside
      className="wx-stepper-context"
      style={{ width: "18rem", flexShrink: 0, padding: `0 ${t.space5} ${t.space5} 0` }}
    >
      <Card>
        <h2 style={{ margin: 0, fontSize: "1rem" }}>Intake context</h2>
        <p style={{ margin: 0, color: t.onSurfaceVariant, fontSize: "0.85rem" }}>
          Direct intake is for walk-in, phone or transfer-in patients. A triaged referral creates
          its own admission.
        </p>
        <ContextRow label="Referral" value={referralId || "No referral linked"} />
        <ContextRow
          label="Method"
          value={INTAKE_METHODS.find((item) => item.value === intakeMethod)?.label ?? "—"}
        />
      </Card>
      <Card style={{ marginTop: t.space4 }}>
        <h2 style={{ margin: 0, fontSize: "1rem" }}>Draft handling</h2>
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
const backLinkStyle = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: "2.5rem",
  padding: "0.5rem 1rem",
  borderRadius: "9999px",
  background: t.surfaceContainer,
  color: t.onSurface,
  fontSize: "0.8125rem",
  fontWeight: 650,
  textDecoration: "none",
} as const;
