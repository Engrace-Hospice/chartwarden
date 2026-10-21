import { EmptyState, Glyph, InlineAlert, LoadingSpinner, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/06-admission — Transfer-in (WARDENX_UI_DISCHARGE_REVOCATION_TRANSFER "Transfer-in
// (separate entry)"; M6 W-DC-03 / D9, POST /api/v1/admissions/:id/transfer-in). Records that this
// admission continues another hospice's benefit period: the carried sequence becomes the ACTIVE period
// (the sending hospice's certification covers it, 42 CFR 418.28) and the next period opens PENDING on
// our own CTI. The sequence counter never restarts and a prior signed election statement is not
// re-collected. The CTI physician must equal the admission's selected hospice physician
// (CTI_HOSPICE_PHYSICIAN_MISMATCH), so when the admission already names one the field is locked to it.
// Drawn in the same workspace frame as the discharge workflow (end-of-episode-ui.tsx).
import { type JSX, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { MdmEntityLookupField } from "../../shell/entity-lookups";
import { fmtDate } from "../../shell/patient-context";
import { stateLabel } from "./admission-status";
import {
  AdmissionPanel,
  EpisodeWorkspace,
  Field,
  LockedField,
  ReviewList,
  Section,
  StepNav,
  type WhatHappensItem,
  WhatHappensList,
  WhatHappensPanel,
  WorkflowFooter,
  WorkflowHead,
  endOfEpisodeMessage,
  errorCodeOf,
  errorFieldOf,
  linearSteps,
  localToday,
  useEpisodeAdmission,
} from "./end-of-episode-ui";
import { TransferNoticeStatus } from "./transfer-notice-status";
import { authFailureRedirect } from "./write-workflow";

const TITLE = "Transfer-in";
const STEPS = ["Sending hospice", "Benefit period", "Review & record"] as const;
const REVIEW_STEP = 2;
const MIN_NARRATIVE = 10;
const CCN = /^[0-9A-Z]{6}$/;
const NPI = /^[0-9]{10}$/;
/** Transfer-in is recorded during intake, before the admission is activated. */
const TRANSFERABLE = new Set(["pending", "notice_of_rights_acknowledged"]);

const TRANSFER_MESSAGES: Record<string, string> = {
  CTI_HOSPICE_PHYSICIAN_MISMATCH:
    "The certifying physician must be the admission's hospice physician.",
  TRANSFER_LIMIT_EXCEEDED:
    "This patient already changed hospices in this benefit period. Only one change is allowed per benefit period.",
  TRANSFER_IN_SOURCE_INVALID:
    "The sending hospice details were rejected. Check the name, CCN and NPI.",
  TRANSFER_SAME_PROVIDER:
    "That CCN is ours. A move between locations of the same hospice is not a transfer.",
  BENEFIT_PERIOD_SEQUENCE_GAP:
    "The prior benefit period number does not follow the patient's history.",
  ELECTION_PERIOD_OVERLAP: "The inherited period overlaps an existing benefit period.",
  TRANSFER_IN_PERIOD_CONFLICT:
    "This admission already has a benefit period at or after the carried one. Check the prior benefit period number.",
};

const TRANSFER_CASCADE: readonly WhatHappensItem[] = [
  {
    icon: "calendar-check",
    text: "The sending hospice's period becomes active here — no new certification for it.",
  },
  { icon: "calendar", text: "The next period opens pending, the day after; it needs our own CTI." },
  { icon: "file-check", text: "A prior signed election statement is not re-collected." },
  { icon: "shield", text: "One transfer per benefit period is enforced." },
  {
    icon: "file-check",
    text: "A Medicare transfer notice (TOB 81C) is drafted in Billing, held until the sending hospice finalizes its billing.",
  },
];

export interface TransferDraft {
  otherHospiceName: string;
  otherHospiceCcn: string;
  otherHospiceNpi: string;
  effectiveDate: string;
  priorBenefitPeriodSequence: string;
  priorElectionStartDate: string;
  hospiceMedicalDirectorId: string;
  hospiceMedicalDirectorLabel: string;
  attendingPhysicianId: string;
  attendingPhysicianLabel: string;
  narrative: string;
}

type DraftField =
  | "otherHospiceName"
  | "otherHospiceCcn"
  | "otherHospiceNpi"
  | "effectiveDate"
  | "priorBenefitPeriodSequence"
  | "priorElectionStartDate"
  | "hospiceMedicalDirectorId"
  | "narrative";
type FieldErrors = Partial<Record<DraftField, string>>;

const STEP_FIELDS: DraftField[][] = [
  ["otherHospiceName", "otherHospiceCcn", "otherHospiceNpi", "effectiveDate"],
  ["priorBenefitPeriodSequence", "priorElectionStartDate", "hospiceMedicalDirectorId", "narrative"],
];

export function validateTransfer(d: TransferDraft, today: string): FieldErrors {
  const e: FieldErrors = {};
  if (!d.otherHospiceName.trim()) e.otherHospiceName = "Enter the sending hospice's name.";
  // The Medicare transfer notice cannot be filed without it (a transfer from our own CCN is not allowed).
  if (!d.otherHospiceCcn) e.otherHospiceCcn = "Enter the sending hospice's CCN.";
  else if (!CCN.test(d.otherHospiceCcn))
    e.otherHospiceCcn = "A CCN is 6 characters: digits or capital letters.";
  if (d.otherHospiceNpi && !NPI.test(d.otherHospiceNpi)) e.otherHospiceNpi = "An NPI is 10 digits.";
  if (!d.effectiveDate) e.effectiveDate = "Enter the transfer date.";
  else if (d.effectiveDate > today) e.effectiveDate = "The transfer date cannot be in the future.";
  const seq = Number(d.priorBenefitPeriodSequence);
  if (!Number.isInteger(seq) || seq < 1)
    e.priorBenefitPeriodSequence = "Enter the benefit period number (1 or higher).";
  if (!d.priorElectionStartDate) e.priorElectionStartDate = "Enter the period's start date.";
  else if (d.effectiveDate && d.priorElectionStartDate > d.effectiveDate)
    e.priorElectionStartDate = "The period must start on or before the transfer date.";
  if (!d.hospiceMedicalDirectorId)
    e.hospiceMedicalDirectorId = "Select the certifying hospice physician.";
  if (d.narrative.trim().length < MIN_NARRATIVE)
    e.narrative = `Enter at least ${MIN_NARRATIVE} characters.`;
  return e;
}

const EMPTY_DRAFT = (today: string): TransferDraft => ({
  otherHospiceName: "",
  otherHospiceCcn: "",
  otherHospiceNpi: "",
  effectiveDate: today,
  priorBenefitPeriodSequence: "",
  priorElectionStartDate: "",
  hospiceMedicalDirectorId: "",
  hospiceMedicalDirectorLabel: "",
  attendingPhysicianId: "",
  attendingPhysicianLabel: "",
  narrative: "",
});

export function TransferIn(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const client = useApiClient();
  const navigate = useNavigate();
  const admission = useEpisodeAdmission(id);
  const today = localToday();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<TransferDraft>(() => EMPTY_DRAFT(today));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (admission === null) return <LoadingSpinner />;
  if (admission === "error")
    return (
      <EmptyState
        title="Unavailable"
        description="This admission was not found or is not visible to you."
      />
    );

  const transferable = TRANSFERABLE.has(admission.state);
  const backTo = `/admissions/${admission.id}`;
  const lockedPhysician = admission.hospicePhysicianId ?? null;
  const effective: TransferDraft = lockedPhysician
    ? {
        ...draft,
        hospiceMedicalDirectorId: lockedPhysician,
        hospiceMedicalDirectorLabel: admission.hospicePhysician?.displayName ?? "",
      }
    : draft;
  const patch = (p: Partial<TransferDraft>) => setDraft((d) => ({ ...d, ...p }));

  const next = () => {
    const all = validateTransfer(effective, today);
    const mine: FieldErrors = {};
    for (const f of STEP_FIELDS[step] ?? []) if (all[f]) mine[f] = all[f];
    setErrors(mine);
    if (Object.keys(mine).length === 0) setStep(step + 1);
  };

  const submit = async () => {
    const all = validateTransfer(effective, today);
    if (Object.keys(all).length > 0) {
      setErrors(all);
      setStep(STEP_FIELDS.findIndex((fs) => fs.some((f) => all[f])));
      return;
    }
    setBusy(true);
    setSubmitError(null);
    try {
      const { error, response } = await client.POST("/api/v1/admissions/{id}/transfer-in", {
        params: { path: { id: admission.id } },
        body: {
          direction: "in",
          effectiveDate: effective.effectiveDate,
          otherHospiceName: effective.otherHospiceName.trim(),
          ...(effective.otherHospiceCcn ? { otherHospiceCcn: effective.otherHospiceCcn } : {}),
          ...(effective.otherHospiceNpi ? { otherHospiceNpi: effective.otherHospiceNpi } : {}),
          priorBenefitPeriodSequence: Number(effective.priorBenefitPeriodSequence),
          priorElectionStartDate: effective.priorElectionStartDate,
          hospiceMedicalDirectorId: effective.hospiceMedicalDirectorId,
          ...(effective.attendingPhysicianId
            ? { attendingPhysicianId: effective.attendingPhysicianId }
            : {}),
          narrative: effective.narrative.trim(),
        },
      });
      if (error) {
        const code = errorCodeOf(error);
        const redirect = authFailureRedirect(response?.status, code, window.location.pathname);
        if (redirect) {
          navigate(redirect);
          return;
        }
        const field = errorFieldOf(error) as DraftField | undefined;
        if (field && STEP_FIELDS.some((fs) => fs.includes(field))) {
          setErrors({ [field]: "This value was rejected. Check it and try again." });
          setStep(STEP_FIELDS.findIndex((fs) => fs.includes(field)));
        }
        setSubmitError(
          endOfEpisodeMessage(
            response?.status,
            code,
            TRANSFER_MESSAGES,
            "The transfer could not be recorded. Try again.",
          ),
        );
        return;
      }
      setDone(true);
    } catch {
      setSubmitError("The transfer could not be recorded. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const current = done ? STEPS.length : step;
  const navSteps = linearSteps(STEPS, current).map((s, i) => ({ ...s, open: !done && i < step }));
  const rail = (
    <>
      <AdmissionPanel admission={admission} />
      <WhatHappensPanel title="When the transfer is recorded">
        <WhatHappensList items={TRANSFER_CASCADE} compact />
      </WhatHappensPanel>
    </>
  );

  return (
    <EpisodeWorkspace patientId={admission.patientId} backTo={backTo} rail={rail}>
      <div className="wx-hope-workspace">
        <StepNav
          label="Transfer-in progress"
          heading="Transfer-in"
          steps={navSteps}
          activeId={done ? null : String(step)}
          onSelect={(s) => setStep(Number(s))}
        />
        <main className="wx-hope-main">
          <WorkflowHead
            title={TITLE}
            stepLine={
              done ? "Recorded" : `Step ${step + 1} of ${STEPS.length} · ${STEPS[step] ?? ""}`
            }
            detail="Continue a benefit period started at another hospice"
          />

          {!transferable && !done ? (
            <InlineAlert tone="info">
              This admission is {stateLabel(admission.state).toLowerCase()}. A transfer-in is
              recorded during intake, before the admission is activated.
            </InlineAlert>
          ) : null}

          {done ? (
            <Section icon="check-circle" title="Transfer recorded">
              <InlineAlert tone="success">
                Benefit period {effective.priorBenefitPeriodSequence} from{" "}
                {effective.otherHospiceName.trim()} is now active on this admission.
              </InlineAlert>
              <TransferNoticeStatus admissionId={admission.id} />
            </Section>
          ) : null}

          {!done && step === 0 ? (
            <SendingHospiceStep
              draft={draft}
              errors={errors}
              disabled={!transferable}
              today={today}
              patch={patch}
            />
          ) : null}

          {!done && step === 1 ? (
            <BenefitPeriodStep
              draft={draft}
              errors={errors}
              today={today}
              lockedPhysicianLabel={
                lockedPhysician
                  ? (admission.hospicePhysician?.displayName ?? lockedPhysician)
                  : null
              }
              patch={patch}
            />
          ) : null}

          {!done && step === REVIEW_STEP ? (
            <Section icon="file-check" title="Review">
              <div style={{ display: "grid", gap: "0.875rem" }}>
                <ReviewList rows={reviewRows(effective)} />
                {submitError ? <InlineAlert tone="error">{submitError}</InlineAlert> : null}
              </div>
            </Section>
          ) : null}

          {!done && step < REVIEW_STEP && submitError ? (
            <InlineAlert tone="error">{submitError}</InlineAlert>
          ) : null}

          <WorkflowFooter note={`Admission state: ${stateLabel(admission.state)}`}>
            {done ? (
              <Link to={backTo} className="wx-btn-primary">
                Open admission
              </Link>
            ) : (
              <>
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
                  <button
                    type="button"
                    className="wx-btn-primary"
                    onClick={next}
                    disabled={!transferable}
                  >
                    Continue <Glyph name="arrow-right" size={16} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="wx-btn-primary"
                    onClick={() => void submit()}
                    disabled={busy || !transferable}
                  >
                    {busy ? "Recording…" : "Record transfer"}
                  </button>
                )}
              </>
            )}
          </WorkflowFooter>
        </main>
      </div>
    </EpisodeWorkspace>
  );
}

function reviewRows(d: TransferDraft): { term: string; value: string; multiline?: boolean }[] {
  return [
    { term: "Sending hospice", value: d.otherHospiceName.trim() },
    { term: "CCN", value: d.otherHospiceCcn || "—" },
    { term: "NPI", value: d.otherHospiceNpi || "—" },
    { term: "Transfer date", value: fmtDate(d.effectiveDate) },
    {
      term: "Inherited period",
      value: `Period ${d.priorBenefitPeriodSequence}, from ${fmtDate(d.priorElectionStartDate)}`,
    },
    { term: "Hospice physician", value: d.hospiceMedicalDirectorLabel || "Selected" },
    { term: "Attending physician", value: d.attendingPhysicianLabel || "—" },
    { term: "Transfer note", value: d.narrative.trim(), multiline: true },
  ];
}

function SendingHospiceStep({
  draft,
  errors,
  disabled,
  today,
  patch,
}: {
  draft: TransferDraft;
  errors: FieldErrors;
  disabled: boolean;
  today: string;
  patch: (p: Partial<TransferDraft>) => void;
}): JSX.Element {
  return (
    <Section
      icon="building"
      title="Sending hospice"
      description="The hospice the patient is transferring from."
    >
      <div className="wx-field-grid">
        <Field id="ti-name" label="Hospice name" required error={errors.otherHospiceName}>
          <input
            id="ti-name"
            type="text"
            maxLength={200}
            value={draft.otherHospiceName}
            aria-invalid={errors.otherHospiceName ? true : undefined}
            onChange={(e) => patch({ otherHospiceName: e.target.value })}
            disabled={disabled}
          />
        </Field>
        <Field
          id="ti-ccn"
          label="CMS Certification Number"
          required
          hint="Medicare CCN — 6 characters. It must differ from ours."
          error={errors.otherHospiceCcn}
        >
          <input
            id="ti-ccn"
            type="text"
            maxLength={6}
            value={draft.otherHospiceCcn}
            aria-invalid={errors.otherHospiceCcn ? true : undefined}
            onChange={(e) => patch({ otherHospiceCcn: e.target.value.toUpperCase() })}
            disabled={disabled}
          />
        </Field>
        <Field
          id="ti-npi"
          label="NPI"
          optional
          hint="The sending hospice's 10-digit NPI."
          error={errors.otherHospiceNpi}
        >
          <input
            id="ti-npi"
            type="text"
            inputMode="numeric"
            maxLength={10}
            value={draft.otherHospiceNpi}
            aria-invalid={errors.otherHospiceNpi ? true : undefined}
            onChange={(e) => patch({ otherHospiceNpi: e.target.value.trim() })}
            disabled={disabled}
          />
        </Field>
        <Field
          id="ti-date"
          label="Transfer date"
          required
          hint="They bill through this date and we bill from it — the same day, or Medicare rejects the transfer."
          error={errors.effectiveDate}
        >
          <input
            id="ti-date"
            type="date"
            max={today}
            value={draft.effectiveDate}
            aria-invalid={errors.effectiveDate ? true : undefined}
            onChange={(e) => patch({ effectiveDate: e.target.value })}
            disabled={disabled}
          />
        </Field>
      </div>
    </Section>
  );
}

function BenefitPeriodStep({
  draft,
  errors,
  today,
  lockedPhysicianLabel,
  patch,
}: {
  draft: TransferDraft;
  errors: FieldErrors;
  today: string;
  lockedPhysicianLabel: string | null;
  patch: (p: Partial<TransferDraft>) => void;
}): JSX.Element {
  return (
    <>
      <Section
        icon="calendar"
        title="Inherited benefit period"
        description="The period in progress at the sending hospice. It continues here without a new certification."
      >
        <div className="wx-field-grid">
          <Field
            id="ti-seq"
            label="Benefit period number"
            required
            hint="1 and 2 are 90-day periods; 3 and later are 60 days."
            error={errors.priorBenefitPeriodSequence}
          >
            <input
              id="ti-seq"
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={draft.priorBenefitPeriodSequence}
              aria-invalid={errors.priorBenefitPeriodSequence ? true : undefined}
              onChange={(e) => patch({ priorBenefitPeriodSequence: e.target.value })}
            />
          </Field>
          <Field
            id="ti-start"
            label="Period start date"
            required
            error={errors.priorElectionStartDate}
          >
            <input
              id="ti-start"
              type="date"
              max={draft.effectiveDate || today}
              value={draft.priorElectionStartDate}
              aria-invalid={errors.priorElectionStartDate ? true : undefined}
              onChange={(e) => patch({ priorElectionStartDate: e.target.value })}
            />
          </Field>
        </div>
      </Section>

      <Section
        icon="stethoscope"
        title="Physicians"
        description="Our certifying physician for the next benefit period."
      >
        <div className="wx-field-grid">
          {lockedPhysicianLabel !== null ? (
            <LockedField
              id="ti-hmd"
              label="Hospice physician (CTI)"
              value={lockedPhysicianLabel}
              source="From the admission's selected hospice physician"
            />
          ) : (
            <div>
              <MdmEntityLookupField
                kind="physician"
                label="Hospice physician (CTI)"
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
                hint="Also becomes the admission's hospice physician."
              />
            </div>
          )}
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
          <Field
            id="ti-narrative"
            label="Transfer note"
            required
            full
            hint={`At least ${MIN_NARRATIVE} characters. Why the patient is transferring and what records were received.`}
            error={errors.narrative}
          >
            <textarea
              id="ti-narrative"
              rows={4}
              maxLength={4000}
              value={draft.narrative}
              aria-invalid={errors.narrative ? true : undefined}
              onChange={(e) => patch({ narrative: e.target.value })}
            />
          </Field>
        </div>
      </Section>
    </>
  );
}
