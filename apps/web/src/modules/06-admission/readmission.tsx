import { EmptyState, Glyph, InlineAlert, LoadingSpinner, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/06-admission — Readmit patient (`/admissions/:id/readmit`). A patient discharged ALIVE comes
// back: the readmission repeats the whole admission (new election statement, certification, NOE, assessments, HOPE
// Admission) in the NEXT available benefit period — a live discharge or revocation ended the last one, a transfer kept
// it (42 CFR 418.21 / 418.24). Guided steps: the previous episode → the benefit period (our history's suggestion,
// confirmed against HETS / ELGA / ELGH; a warning, never a block, when it is not) → the requirements of that period
// → the intake fields → review. Submit creates the admission (POST /api/v1/admissions with
// `readmittedFromAdmissionId` + `benefitPeriod`) and lands on it. Drawn in the end-of-episode workspace frame.
import { type JSX, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { MdmEntityLookupField } from "../../shell/entity-lookups";
import { fmtDate } from "../../shell/patient-context";
import { RhcCarryOverSummary } from "../../shell/rhc-carry-over";
import {
  BenefitPeriodField,
  type HetsHandle,
  WarningNote,
  useBenefitPeriodPlan,
  useHetsHospicePeriods,
} from "./benefit-period-field";
import { endLabel } from "./discharges-hub-model";
import {
  AdmissionPanel,
  EpisodeWorkspace,
  Field,
  ReviewList,
  Section,
  StepNav,
  type WhatHappensItem,
  WhatHappensList,
  WhatHappensPanel,
  WorkflowFooter,
  WorkflowHead,
  bodyText,
  endOfEpisodeMessage,
  errorCodeOf,
  linearSteps,
  localToday,
  useEpisodeAdmission,
} from "./end-of-episode-ui";
import { canRunHetsCheck } from "./hets-model";
import {
  type BenefitPeriodDraft,
  type BenefitPeriodPlan,
  MIN_F2F_EXCEPTION_REASON,
  benefitPeriodBody,
  blockerLabel,
  closureLabel,
  emptyBenefitPeriodDraft,
  endKindLabel,
  periodLengthLabel,
  requirementChecklist,
  validateBenefitPeriod,
} from "./readmission-model";
import { authFailureRedirect } from "./write-workflow";

/** The merged RHC carry-over from the HETS read (null until loaded, or when HETS is unavailable). */
function rhcCarryOverOf(hets: HetsHandle) {
  return hets.load.kind === "loaded" ? (hets.load.view.rhcCarryOver ?? null) : null;
}

const STEPS = ["Previous episode", "Benefit period", "Requirements", "Intake", "Review"] as const;
const REVIEW_STEP = STEPS.length - 1;

const READMIT_MESSAGES: Record<string, string> = {
  PATIENT_ALREADY_ELECTED: "The patient already has an open admission.",
  READMISSION_SOURCE_INVALID:
    "This stay cannot be readmitted from. Start from the patient's latest discharge.",
  BENEFIT_PERIOD_INVALID: "The benefit period number was rejected.",
  BENEFIT_PERIOD_CONFIRMATION_DATE_REQUIRED: "Enter the date the period was checked in HETS.",
  BENEFIT_PERIOD_CONFIRMATION_DATE_INVALID: "The confirmation date was rejected.",
  F2F_EXCEPTION_INVALID: "The face-to-face exception needs period 3 or later and a reason.",
  PATIENT_NOT_FOUND: "The patient could not be found.",
};

const CASCADE: readonly WhatHappensItem[] = [
  { icon: "user-plus", text: "A new admission opens in intake, linked to this stay." },
  { icon: "calendar", text: "Its first benefit period is the number you confirm here." },
  { icon: "file-check", text: "A new election statement, NOR and certification are collected." },
  {
    icon: "send",
    text: "The NOE is drafted at activation; filing waits for the prior NOTR / final claim.",
  },
];

interface IntakeDraft {
  admissionDate: string;
  intakeMethod: "in_person" | "phone";
  hospiceMedicalDirectorId: string;
  hospiceMedicalDirectorLabel: string;
  attendingPhysicianId: string;
  attendingPhysicianLabel: string;
  f2fException: boolean;
  f2fExceptionReason: string;
}

type IntakeField = "admissionDate" | "hospiceMedicalDirectorId" | "f2fExceptionReason";

export function validateIntake(
  d: IntakeDraft,
  sequence: number,
  today: string,
): Partial<Record<IntakeField, string>> {
  const e: Partial<Record<IntakeField, string>> = {};
  if (!d.admissionDate) e.admissionDate = "Enter the admission date.";
  else if (d.admissionDate > today) e.admissionDate = "The admission date cannot be in the future.";
  if (!d.hospiceMedicalDirectorId)
    e.hospiceMedicalDirectorId = "Select the hospice medical director.";
  if (
    sequence >= 3 &&
    d.f2fException &&
    d.f2fExceptionReason.trim().length < MIN_F2F_EXCEPTION_REASON
  )
    e.f2fExceptionReason = `Describe the circumstance in at least ${MIN_F2F_EXCEPTION_REASON} characters.`;
  return e;
}

export function Readmission(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const client = useApiClient();
  const navigate = useNavigate();
  const today = localToday();
  const previousAdmission = useEpisodeAdmission(id);
  const [step, setStep] = useState(0);
  const [period, setPeriod] = useState<BenefitPeriodDraft>(() => emptyBenefitPeriodDraft(null));
  const [intake, setIntake] = useState<IntakeDraft>({
    admissionDate: today,
    intakeMethod: "in_person",
    hospiceMedicalDirectorId: "",
    hospiceMedicalDirectorLabel: "",
    attendingPhysicianId: "",
    attendingPhysicianLabel: "",
    f2fException: false,
    f2fExceptionReason: "",
  });
  const [periodErrors, setPeriodErrors] = useState<ReturnType<typeof validateBenefitPeriod>>({});
  const [intakeErrors, setIntakeErrors] = useState<ReturnType<typeof validateIntake>>({});
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const sequence = Number(period.sequence);
  const plan = useBenefitPeriodPlan(id ? { admissionId: id } : null, {
    ...(Number.isInteger(sequence) && sequence >= 1 ? { sequence } : {}),
    startDate: intake.admissionDate || today,
  });
  const loadedPlan = plan && plan !== "error" ? plan : null;
  const suggested = loadedPlan?.suggestion.suggestedSequence ?? null;
  const hets = useHetsHospicePeriods(loadedPlan?.patientId, {
    electionDate: intake.admissionDate || today,
  });

  // Prefill the suggestion once, when the plan first arrives.
  useEffect(() => {
    if (suggested !== null) setPeriod((p) => (p.sequence ? p : emptyBenefitPeriodDraft(suggested)));
  }, [suggested]);

  const carry = rhcCarryOverOf(hets);
  const checklist = useMemo(
    () =>
      loadedPlan ? requirementChecklist(loadedPlan, (d) => (d ? fmtDate(d) : "—"), carry) : [],
    [loadedPlan, carry],
  );

  if (previousAdmission === null || plan === null) return <LoadingSpinner />;
  if (previousAdmission === "error" || plan === "error" || !loadedPlan)
    return (
      <EmptyState
        title="Unavailable"
        description="This admission was not found or is not visible to you."
      />
    );

  const backTo = `/admissions/${previousAdmission.id}`;
  const eligible = loadedPlan.readmission.eligible;
  const f2fRequired = loadedPlan.requirements.faceToFace.required;

  const next = () => {
    if (step === 1) {
      const errs = validateBenefitPeriod(period, today);
      setPeriodErrors(errs);
      if (Object.keys(errs).length > 0) return;
    }
    if (step === 3) {
      const errs = validateIntake(intake, sequence, today);
      setIntakeErrors(errs);
      if (Object.keys(errs).length > 0) return;
    }
    setStep(step + 1);
  };

  const submit = async () => {
    const bp = benefitPeriodBody(period, suggested, today);
    const intakeErrs = validateIntake(intake, sequence, today);
    if (!bp) {
      setPeriodErrors(validateBenefitPeriod(period, today));
      setStep(1);
      return;
    }
    if (Object.keys(intakeErrs).length > 0) {
      setIntakeErrors(intakeErrs);
      setStep(3);
      return;
    }
    setBusy(true);
    setSubmitError(null);
    try {
      const { data, error, response } = await client.POST("/api/v1/admissions", {
        body: {
          patientId: loadedPlan.patientId,
          intakeMethod: intake.intakeMethod,
          hospiceMedicalDirectorId: intake.hospiceMedicalDirectorId,
          ...(intake.attendingPhysicianId
            ? { attendingPhysicianId: intake.attendingPhysicianId }
            : {}),
          readmittedFromAdmissionId: previousAdmission.id,
          benefitPeriod: bp,
          admissionDate: intake.admissionDate,
          ...(f2fRequired && intake.f2fException
            ? { f2fException: { reason: intake.f2fExceptionReason.trim() } }
            : {}),
        },
      });
      if (error || !data) {
        const code = errorCodeOf(error);
        const redirect = authFailureRedirect(response?.status, code, window.location.pathname);
        if (redirect) {
          navigate(redirect);
          return;
        }
        setSubmitError(
          endOfEpisodeMessage(
            response?.status,
            code,
            READMIT_MESSAGES,
            "The readmission could not be created. Try again.",
          ),
        );
        return;
      }
      navigate(`/admissions/${data.id}`);
    } catch {
      setSubmitError("The readmission could not be created. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const navSteps = linearSteps(STEPS, step).map((s, i) => ({ ...s, open: i < step }));
  const rail = (
    <>
      <AdmissionPanel
        admission={previousAdmission}
        extra={[
          {
            label: "Ended",
            value: loadedPlan.previous
              ? `${endKindLabel(loadedPlan.previous.endKind)} · ${fmtDate(loadedPlan.previous.endedOn)}`
              : "—",
          },
        ]}
      />
      <WhatHappensPanel title="When the readmission is created">
        <WhatHappensList items={CASCADE} compact />
      </WhatHappensPanel>
    </>
  );

  return (
    <EpisodeWorkspace patientId={previousAdmission.patientId} backTo={backTo} rail={rail}>
      <div className="wx-hope-workspace">
        <StepNav
          label="Readmission progress"
          heading="Readmit patient"
          steps={navSteps}
          activeId={String(step)}
          onSelect={(s) => setStep(Number(s))}
        />
        <main className="wx-hope-main">
          <WorkflowHead
            title="Readmit patient"
            stepLine={`Step ${step + 1} of ${STEPS.length} · ${STEPS[step] ?? ""}`}
            detail="A new admission in the next available benefit period"
          />

          {!eligible ? (
            <InlineAlert tone="error">
              {loadedPlan.readmission.blockers.map(blockerLabel).join(" ") ||
                "This stay cannot be readmitted from."}
            </InlineAlert>
          ) : null}

          {step === 0 ? <PreviousEpisodeStep plan={loadedPlan} hets={hets} /> : null}

          {step === 1 ? (
            <Section
              icon="calendar"
              title="Benefit period"
              description="The period this admission elects into. Medicare counts periods for the patient across every hospice."
            >
              <BenefitPeriodField
                idPrefix="rd"
                draft={period}
                onChange={(p) => setPeriod((d) => ({ ...d, ...p }))}
                suggested={suggested}
                basis={loadedPlan.suggestion.basis}
                today={today}
                errors={periodErrors}
                hets={hets}
                serviceDate={intake.admissionDate || today}
              />
            </Section>
          ) : null}

          {step === 2 ? (
            <Section
              icon="clipboard-list"
              title={`Requirements for period ${loadedPlan.requirements.sequence}`}
              description={`${periodLengthLabel(loadedPlan.requirements.sequence)}: ${fmtDate(
                loadedPlan.requirements.startDate,
              )} – ${fmtDate(loadedPlan.requirements.endDate)}.`}
            >
              <ul className="wx-readmit-checklist" style={checklistStyle}>
                {checklist.map((c) => (
                  <li key={c.key} style={checklistItemStyle}>
                    <span
                      aria-hidden
                      style={{
                        color:
                          c.tone === "warning" ? "var(--color-warning)" : "var(--color-primary)",
                      }}
                    >
                      <Glyph name={c.tone === "warning" ? "alert" : "check-circle"} size={18} />
                    </span>
                    <span>
                      <strong style={{ display: "block", fontSize: "0.875rem" }}>{c.title}</strong>
                      <span style={bodyText}>{c.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {step === 3 ? (
            <IntakeStep
              draft={intake}
              errors={intakeErrors}
              today={today}
              f2fRequired={f2fRequired}
              exceptionWindowEnd={loadedPlan.requirements.faceToFace.exceptionWindowEnd}
              patch={(p) => setIntake((d) => ({ ...d, ...p }))}
            />
          ) : null}

          {step === REVIEW_STEP ? (
            <Section icon="file-check" title="Review">
              <div style={{ display: "grid", gap: "0.875rem" }}>
                <ReviewList
                  rows={[
                    {
                      term: "Readmitted from",
                      value: loadedPlan.previous
                        ? `${endKindLabel(loadedPlan.previous.endKind)} on ${fmtDate(loadedPlan.previous.endedOn)}`
                        : "—",
                    },
                    {
                      term: "Benefit period",
                      value: `Period ${period.sequence} (${periodLengthLabel(sequence)}) — ${
                        period.hetsConfirmed
                          ? `confirmed in HETS on ${fmtDate(period.confirmedOn)}`
                          : "not confirmed in HETS"
                      }`,
                    },
                    { term: "Admission date", value: fmtDate(intake.admissionDate) },
                    {
                      term: "Hospice medical director",
                      value: intake.hospiceMedicalDirectorLabel || "Selected",
                    },
                    { term: "Attending physician", value: intake.attendingPhysicianLabel || "—" },
                    ...(f2fRequired
                      ? [
                          {
                            term: "Face-to-face",
                            value: intake.f2fException
                              ? `Exceptional circumstances: ${intake.f2fExceptionReason.trim()}`
                              : "Before activation",
                            multiline: true,
                          },
                        ]
                      : []),
                    {
                      term: "NOE",
                      value: loadedPlan.noeBlocked
                        ? "Held until the prior NOTR / final claim is filed"
                        : `Due by ${fmtDate(loadedPlan.requirements.noeDueBy)}`,
                    },
                  ]}
                />
                {!period.hetsConfirmed ? (
                  <WarningNote>
                    The benefit period is not confirmed against HETS / ELGA / ELGH. You can still
                    create the admission; confirm it before the NOE is filed.
                  </WarningNote>
                ) : null}
                {submitError ? <InlineAlert tone="error">{submitError}</InlineAlert> : null}
              </div>
            </Section>
          ) : null}

          <WorkflowFooter note={`Previous stay: ${previousEndLabel(loadedPlan.previous)}`}>
            {step === 0 ? (
              <Link to={backTo} className="wx-btn-secondary">
                Cancel
              </Link>
            ) : (
              <button
                type="button"
                className="wx-btn-secondary"
                onClick={() => setStep(step - 1)}
                disabled={busy}
              >
                Back
              </button>
            )}
            {step < REVIEW_STEP ? (
              <button type="button" className="wx-btn-primary" onClick={next} disabled={!eligible}>
                Continue <Glyph name="arrow-right" size={16} />
              </button>
            ) : (
              <button
                type="button"
                className="wx-btn-primary"
                onClick={() => void submit()}
                disabled={busy || !eligible}
              >
                {busy ? "Creating…" : "Create readmission"}
              </button>
            )}
          </WorkflowFooter>
        </main>
      </div>
    </EpisodeWorkspace>
  );
}

/** How the previous stay ended; a transfer with no discharge type on file reads as a transfer out. */
function previousEndLabel(prev: BenefitPeriodPlan["previous"]): string {
  if (!prev) return endLabel(null);
  return endLabel(prev.dischargeType ?? (prev.transfer ? "transfer_out" : null));
}

function PreviousEpisodeStep({
  plan,
  hets,
}: {
  plan: BenefitPeriodPlan;
  hets: HetsHandle;
}): JSX.Element {
  const prev = plan.previous;
  const carry = rhcCarryOverOf(hets);
  return (
    <Section
      icon="clipboard-check"
      title="Previous episode"
      description="The stay this readmission follows."
    >
      {prev ? (
        <div style={{ display: "grid", gap: "0.875rem" }}>
          <ReviewList
            rows={[
              { term: "Admitted", value: fmtDate(prev.startedOn) },
              { term: "Ended", value: `${endKindLabel(prev.endKind)} on ${fmtDate(prev.endedOn)}` },
              {
                term: "Reason",
                value: previousEndLabel(prev),
              },
              {
                term: "Days since discharge",
                value: prev.daysSinceDischarge === null ? "—" : String(prev.daysSinceDischarge),
              },
              {
                term: "Last benefit period",
                value: prev.lastSequence === null ? "—" : `Period ${prev.lastSequence}`,
              },
              { term: "Prior election close-out", value: closureLabel(plan.priorElectionClosure) },
              {
                term: "Prior hospice days (RHC)",
                value: carry
                  ? `${carry.priorDays} carry over (our stays${carry.basis === "internal_only" ? "" : " + other hospices via HETS"})`
                  : plan.rhc.applies
                    ? `${plan.rhc.priorHospiceDays} carry over (readmitted within 60 days)`
                    : "Day count starts again (more than 60 days since discharge)",
              },
            ]}
          />
          {carry ? <RhcCarryOverSummary carry={carry} fmt={fmtDate} /> : null}
          {plan.rhc.applies && (!carry || carry.basis !== "hets_merged") ? (
            <WarningNote>
              Readmitted within 60 days of a discharge, but no recent HETS check is on file: days
              the patient spent at another hospice are not counted, so the RHC high/low rate split
              may be wrong.{" "}
              {canRunHetsCheck(hets.load, hets.canCheck)
                ? "Run a HETS check on the Benefit period step."
                : "Look the patient up in HETS / ELGA / ELGH before confirming the benefit period."}
            </WarningNote>
          ) : null}
          {prev.transfer ? (
            <InlineAlert tone="info">
              This stay ended in a transfer: the period kept running at the other hospice. If the
              patient is coming back on transfer from that hospice, record a transfer-in on a new
              admission instead.
            </InlineAlert>
          ) : null}
          {plan.noeBlocked ? (
            <WarningNote>
              The previous election has no NOTR (8xB) or final claim on file. You can admit the
              patient, but Medicare rejects the new NOE until one is filed.
            </WarningNote>
          ) : null}
        </div>
      ) : (
        <p style={bodyText}>No earlier stay is on file.</p>
      )}
    </Section>
  );
}

function IntakeStep({
  draft,
  errors,
  today,
  f2fRequired,
  exceptionWindowEnd,
  patch,
}: {
  draft: IntakeDraft;
  errors: ReturnType<typeof validateIntake>;
  today: string;
  f2fRequired: boolean;
  exceptionWindowEnd: string | null;
  patch: (p: Partial<IntakeDraft>) => void;
}): JSX.Element {
  return (
    <>
      <Section icon="user-plus" title="Intake" description="The new admission's details.">
        <div className="wx-field-grid">
          <Field id="rd-date" label="Admission date" required error={errors.admissionDate}>
            <input
              id="rd-date"
              type="date"
              max={today}
              value={draft.admissionDate}
              aria-invalid={errors.admissionDate ? true : undefined}
              onChange={(e) => patch({ admissionDate: e.target.value })}
            />
          </Field>
          <Field id="rd-method" label="Intake method" required>
            <select
              id="rd-method"
              value={draft.intakeMethod}
              onChange={(e) =>
                patch({ intakeMethod: e.target.value as IntakeDraft["intakeMethod"] })
              }
            >
              <option value="in_person">In person</option>
              <option value="phone">Phone</option>
            </select>
          </Field>
          <div>
            <MdmEntityLookupField
              kind="physician"
              label="Hospice medical director"
              value={draft.hospiceMedicalDirectorId}
              valueLabel={draft.hospiceMedicalDirectorLabel || undefined}
              onChange={(value, option) =>
                patch({
                  hospiceMedicalDirectorId: value,
                  hospiceMedicalDirectorLabel: option?.searchLabel ?? "",
                })
              }
              required
              error={errors.hospiceMedicalDirectorId}
            />
          </div>
          <div>
            <MdmEntityLookupField
              kind="physician"
              label="Attending physician"
              value={draft.attendingPhysicianId}
              valueLabel={draft.attendingPhysicianLabel || undefined}
              onChange={(value, option) =>
                patch({
                  attendingPhysicianId: value,
                  attendingPhysicianLabel: option?.searchLabel ?? "",
                })
              }
              clearable
              hint="Optional"
            />
          </div>
        </div>
      </Section>
      {f2fRequired ? (
        <Section
          icon="stethoscope"
          title="Face-to-face encounter"
          description="Required from benefit period 3. Normally completed before the admission date."
        >
          <div style={{ display: "grid", gap: "0.75rem" }}>
            <label className={draft.f2fException ? "wx-tile checked" : "wx-tile"}>
              <input
                type="checkbox"
                checked={draft.f2fException}
                onChange={(e) => patch({ f2fException: e.currentTarget.checked })}
              />
              <span className="wx-tile-text">
                <span>Exceptional circumstances</span>
                <small>
                  A weekend emergency admission, or CMS systems down so the period was unknown: the
                  encounter may then happen by{" "}
                  {exceptionWindowEnd ? fmtDate(exceptionWindowEnd) : "2 days after admission"}.
                </small>
              </span>
            </label>
            {draft.f2fException ? (
              <Field
                id="rd-f2f-reason"
                label="Describe the circumstance"
                required
                full
                hint={`At least ${MIN_F2F_EXCEPTION_REASON} characters. Kept on the benefit period for audit.`}
                error={errors.f2fExceptionReason}
              >
                <textarea
                  id="rd-f2f-reason"
                  rows={3}
                  maxLength={2000}
                  value={draft.f2fExceptionReason}
                  aria-invalid={errors.f2fExceptionReason ? true : undefined}
                  onChange={(e) => patch({ f2fExceptionReason: e.target.value })}
                />
              </Field>
            ) : null}
          </div>
        </Section>
      ) : null}
    </>
  );
}

const checklistStyle = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: "0.75rem",
} as const;

const checklistItemStyle = {
  display: "flex",
  gap: "0.625rem",
  alignItems: "flex-start",
} as const;
