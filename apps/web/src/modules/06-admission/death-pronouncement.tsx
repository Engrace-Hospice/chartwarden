import { EmptyState, Glyph, InlineAlert, LoadingSpinner, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/06-admission — Death & Pronouncement (WARDENX_UI_DEATH_PRONOUNCEMENT, M6 §4.2.7
// route 39 with `reason: "death"`). One write: POST /api/v1/admissions/:id/discharge. The server derives
// the `discharge.death` permission from the reason, demands step-up, enforces R-DC-01 (an identified
// certifier), the place of death (claim patient status 40/41/42) and the narrative minimum, moves the
// admission to `bereavement`, and emits `m6.discharge.death` (M5 deceased status, M16 bereavement, M23
// final claim + NOTR, M30 mortality review). The screen states that cascade as what runs; it never shows
// live downstream status it cannot read. Steps the spec lists without a backing route (family
// notification, body release) are not drawn as fillable steps. Drawn in the same workspace frame as the
// discharge workflow (end-of-episode-ui.tsx).
import { type JSX, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { MdmEntityLookupField } from "../../shell/entity-lookups";
import { fmtDate } from "../../shell/patient-context";
import { DISCHARGEABLE_STATES, stateLabel } from "./admission-status";
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
  bodyText,
  dateOnly,
  endOfEpisodeMessage,
  errorCodeOf,
  errorFieldOf,
  linearSteps,
  localToday,
  useEpisodeAdmission,
} from "./end-of-episode-ui";
import { authFailureRedirect } from "./write-workflow";

const TITLE = "Death & Pronouncement";
const STEPS = ["Record death", "Review & sign", "Post-death cascade"] as const;
const MIN_NARRATIVE = 10;

/** Where the patient died — the final claim's patient status 40 (home) / 41 (facility) / 42 (unknown). */
export const PLACES_OF_DEATH = [
  { value: "home", label: "Home" },
  { value: "facility", label: "Facility (hospital, nursing home, inpatient unit)" },
  { value: "unknown", label: "Unknown" },
] as const;
export type PlaceOfDeath = (typeof PLACES_OF_DEATH)[number]["value"];

const DEATH_MESSAGES: Record<string, string> = {
  DEATH_CERTIFIER_INVALID: "Select the physician who pronounced or certified the death.",
  DISCHARGE_NARRATIVE_TOO_SHORT: `The pronouncement note must be at least ${MIN_NARRATIVE} characters.`,
  DISCHARGE_BEFORE_ADMISSION: "The date of death cannot be before the admission date.",
  PLACE_OF_DEATH_REQUIRED: "Choose where the patient died.",
};

export const DEATH_CASCADE: readonly WhatHappensItem[] = [
  { icon: "bed", text: "The admission moves to Bereavement (not Discharged)." },
  { icon: "user", text: "The patient is marked deceased with the date of death." },
  { icon: "heart", text: "The 13-month bereavement program opens unless the family opted out." },
  {
    icon: "receipt",
    text: "Billing limits the final claim to the date of death and drafts the NOTR; the place of death sets its patient status.",
  },
  { icon: "clipboard-check", text: "A mortality quality-review draft is created." },
];

export interface DeathDraft {
  deathDate: string;
  placeOfDeath: PlaceOfDeath | "";
  certifierId: string;
  certifierLabel: string;
  narrative: string;
}

type FieldErrors = Partial<
  Record<"deathDate" | "placeOfDeath" | "certifierId" | "narrative", string>
>;

export function validateDeath(d: DeathDraft, admissionDate: string, today: string): FieldErrors {
  const e: FieldErrors = {};
  if (!d.deathDate) e.deathDate = "Enter the date of death.";
  else if (d.deathDate > today) e.deathDate = "The date of death cannot be in the future.";
  else if (admissionDate && d.deathDate < admissionDate)
    e.deathDate = "The date of death cannot be before the admission date.";
  if (!d.placeOfDeath) e.placeOfDeath = DEATH_MESSAGES.PLACE_OF_DEATH_REQUIRED;
  if (!d.certifierId) e.certifierId = "Select the pronouncing physician.";
  if (d.narrative.trim().length < MIN_NARRATIVE)
    e.narrative = `Enter at least ${MIN_NARRATIVE} characters.`;
  return e;
}

/** A server rejection that names one field sends the clinician back to the form, on that field. */
function fieldErrorFor(code: string | undefined, field: string | undefined): FieldErrors | null {
  if (code === "DEATH_CERTIFIER_INVALID" || field === "deathCertifierId")
    return { certifierId: DEATH_MESSAGES.DEATH_CERTIFIER_INVALID };
  if (code === "PLACE_OF_DEATH_REQUIRED" || field === "placeOfDeath")
    return { placeOfDeath: DEATH_MESSAGES.PLACE_OF_DEATH_REQUIRED };
  if (code === "DISCHARGE_NARRATIVE_TOO_SHORT" || field === "narrative")
    return { narrative: DEATH_MESSAGES.DISCHARGE_NARRATIVE_TOO_SHORT };
  if (code === "DISCHARGE_BEFORE_ADMISSION" || field === "dischargeDate")
    return { deathDate: DEATH_MESSAGES.DISCHARGE_BEFORE_ADMISSION };
  return null;
}

const placeLabel = (v: PlaceOfDeath | ""): string =>
  PLACES_OF_DEATH.find((p) => p.value === v)?.label ?? "—";

export function DeathPronouncement(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const client = useApiClient();
  const navigate = useNavigate();
  const admission = useEpisodeAdmission(id);
  const today = localToday();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<DeathDraft>({
    deathDate: today,
    placeOfDeath: "",
    certifierId: "",
    certifierLabel: "",
    narrative: "",
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (admission === null) return <LoadingSpinner />;
  if (admission === "error")
    return (
      <EmptyState
        title="Unavailable"
        description="This admission was not found or is not visible to you."
      />
    );

  const admissionDate = dateOnly(admission.admissionAt);
  const dischargeable = DISCHARGEABLE_STATES.has(admission.state);
  const backTo = `/admissions/${admission.id}`;
  const patch = (p: Partial<DeathDraft>) => setDraft((d) => ({ ...d, ...p }));

  const toReview = () => {
    const e = validateDeath(draft, admissionDate, today);
    setErrors(e);
    if (Object.keys(e).length === 0) setStep(1);
  };

  const submit = async () => {
    setBusy(true);
    setSubmitError(null);
    try {
      const { error, response } = await client.POST("/api/v1/admissions/{id}/discharge", {
        params: { path: { id: admission.id } },
        body: {
          reason: "death",
          dischargeDate: draft.deathDate,
          narrative: draft.narrative.trim(),
          deathCertifierId: draft.certifierId,
          placeOfDeath: draft.placeOfDeath as PlaceOfDeath,
        },
      });
      if (error) {
        const code = errorCodeOf(error);
        const redirect = authFailureRedirect(response?.status, code, window.location.pathname);
        if (redirect) {
          navigate(redirect);
          return;
        }
        const fieldErrors = fieldErrorFor(code, errorFieldOf(error));
        if (fieldErrors) {
          setErrors(fieldErrors);
          setStep(0);
        }
        setSubmitError(
          endOfEpisodeMessage(
            response?.status,
            code,
            DEATH_MESSAGES,
            "The death could not be recorded. Try again.",
          ),
        );
        return;
      }
      setStep(2);
    } catch {
      setSubmitError("The death could not be recorded. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const rail = (
    <>
      <AdmissionPanel admission={admission} />
      <WhatHappensPanel title="When the death is recorded">
        <WhatHappensList items={DEATH_CASCADE} compact />
      </WhatHappensPanel>
    </>
  );

  return (
    <EpisodeWorkspace patientId={admission.patientId} backTo={backTo} rail={rail}>
      <div className="wx-hope-workspace">
        <StepNav
          label="Death workflow steps"
          heading="Death"
          steps={linearSteps(STEPS, step)}
          activeId={String(step)}
        />
        <main className="wx-hope-main">
          <WorkflowHead
            title={TITLE}
            stepLine={`Step ${Math.min(step + 1, STEPS.length)} of ${STEPS.length} · ${STEPS[step]}`}
          />

          {!dischargeable && step < 2 ? (
            <InlineAlert tone="info">
              This admission is {stateLabel(admission.state).toLowerCase()}. A death can only be
              recorded on an active or on-hold admission.
            </InlineAlert>
          ) : null}

          {step === 0 ? (
            <RecordDeathStep
              draft={draft}
              errors={errors}
              disabled={!dischargeable}
              admissionDate={admissionDate}
              today={today}
              patch={patch}
            />
          ) : null}

          {step === 1 ? (
            <Section
              icon="file-check"
              title="Review and sign"
              description="Signing records the death and cannot be undone from this screen. You may be asked to confirm your identity."
            >
              <div style={{ display: "grid", gap: "0.875rem" }}>
                <ReviewList
                  rows={[
                    { term: "Date of death", value: fmtDate(draft.deathDate) },
                    { term: "Place of death", value: placeLabel(draft.placeOfDeath) },
                    {
                      term: "Pronouncing physician",
                      value: draft.certifierLabel || "Selected",
                    },
                    { term: "Discharge reason", value: "Death" },
                    { term: "Pronouncement note", value: draft.narrative.trim(), multiline: true },
                  ]}
                />
                {submitError ? <InlineAlert tone="error">{submitError}</InlineAlert> : null}
              </div>
            </Section>
          ) : null}

          {step === 2 ? (
            <Section icon="check-circle" title="Death recorded">
              <div style={{ display: "grid", gap: "0.875rem" }}>
                <InlineAlert tone="success">
                  The death on {fmtDate(draft.deathDate)} was recorded. The admission is now in
                  bereavement.
                </InlineAlert>
                <p style={bodyText}>
                  The post-death cascade listed on the right runs on the server.
                </p>
              </div>
            </Section>
          ) : null}

          {step === 0 && submitError ? <InlineAlert tone="error">{submitError}</InlineAlert> : null}

          <WorkflowFooter note="Death">
            {step === 0 ? (
              <>
                <Link to={backTo} className="wx-btn-secondary">
                  Cancel
                </Link>
                <button
                  type="button"
                  className="wx-btn-primary"
                  onClick={toReview}
                  disabled={!dischargeable}
                >
                  Review <Glyph name="arrow-right" size={16} />
                </button>
              </>
            ) : null}
            {step === 1 ? (
              <>
                <button
                  type="button"
                  className="wx-btn-secondary"
                  onClick={() => setStep(0)}
                  disabled={busy}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="wx-btn-primary"
                  onClick={() => void submit()}
                  disabled={busy}
                >
                  {busy ? "Recording…" : "Sign and record death"}
                </button>
              </>
            ) : null}
            {step === 2 ? (
              <>
                {admission.patientId ? (
                  <Link to={`/patients/${admission.patientId}`} className="wx-btn-secondary">
                    Open patient chart
                  </Link>
                ) : null}
                <Link to={backTo} className="wx-btn-primary">
                  Open admission
                </Link>
              </>
            ) : null}
          </WorkflowFooter>
        </main>
      </div>
    </EpisodeWorkspace>
  );
}

function RecordDeathStep({
  draft,
  errors,
  disabled,
  admissionDate,
  today,
  patch,
}: {
  draft: DeathDraft;
  errors: FieldErrors;
  disabled: boolean;
  admissionDate: string;
  today: string;
  patch: (p: Partial<DeathDraft>) => void;
}): JSX.Element {
  return (
    <>
      <Section
        icon="clock"
        title="Time and place of death"
        description="The calendar date the patient died — the final claim covers through this date."
      >
        <div className="wx-field-grid">
          <Field id="death-date" label="Date of death" required error={errors.deathDate}>
            <input
              id="death-date"
              type="date"
              value={draft.deathDate}
              max={today}
              min={admissionDate || undefined}
              aria-invalid={errors.deathDate ? true : undefined}
              onChange={(e) => patch({ deathDate: e.target.value })}
              disabled={disabled}
            />
          </Field>
          <Field
            id="death-place"
            label="Place of death"
            required
            hint="Sets the death patient status on the final claim (40 home / 41 facility / 42 unknown)."
            error={errors.placeOfDeath}
          >
            <select
              id="death-place"
              value={draft.placeOfDeath}
              aria-invalid={errors.placeOfDeath ? true : undefined}
              onChange={(e) => patch({ placeOfDeath: e.target.value as PlaceOfDeath | "" })}
              disabled={disabled}
            >
              <option value="">Choose…</option>
              {PLACES_OF_DEATH.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
          <LockedField
            id="death-admitted"
            label="Admission date"
            value={admissionDate ? fmtDate(admissionDate) : "Not recorded"}
            source="From the admission record"
          />
          <LockedField
            id="death-reason"
            label="Discharge reason"
            value="Death"
            source="Set by this workflow"
          />
        </div>
      </Section>

      <Section
        icon="stethoscope"
        title="Pronouncement"
        description="The physician who pronounced or certified the death (R-DC-01)."
      >
        <div className="wx-field-grid">
          <div className="wx-field-grid-full">
            <MdmEntityLookupField
              kind="physician"
              label="Pronouncing physician"
              value={draft.certifierId}
              valueLabel={draft.certifierLabel || undefined}
              onChange={(value, option) =>
                patch({
                  certifierId: value,
                  certifierLabel: !option
                    ? ""
                    : typeof option.label === "string"
                      ? option.label
                      : option.searchLabel,
                })
              }
              required
              disabled={disabled}
              error={errors.certifierId}
              hint="Searches the physician directory."
            />
          </div>
          <Field
            id="death-narrative"
            label="Pronouncement note"
            required
            full
            hint={`At least ${MIN_NARRATIVE} characters. Who was present, how death was confirmed, who was notified.`}
            error={errors.narrative}
          >
            <textarea
              id="death-narrative"
              rows={5}
              value={draft.narrative}
              maxLength={4000}
              aria-invalid={errors.narrative ? true : undefined}
              onChange={(e) => patch({ narrative: e.target.value })}
              disabled={disabled}
            />
          </Field>
        </div>
      </Section>
    </>
  );
}
