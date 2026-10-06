import { Button, InlineAlert, t, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/06-admission — Death & Pronouncement (WARDENX_UI_DEATH_PRONOUNCEMENT, M6 §4.2.7
// route 39 with `reason: "death"`). One write: POST /api/v1/admissions/:id/discharge. The server derives
// the `discharge.death` permission from the reason, demands step-up, enforces R-DC-01 (an identified
// certifier) and the narrative minimum, moves the admission to `bereavement`, and emits
// `m6.discharge.death` (M5 deceased status, M16 bereavement, M23 final claim + NOTR, M30 mortality
// review). The screen states that cascade as what runs; it never shows live downstream status it
// cannot read. Steps the spec lists without a backing route (family notification, body release) are
// not drawn as fillable steps.
import { type JSX, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { MdmEntityLookupField } from "../../shell/entity-lookups";
import { stateLabel } from "./admission-status";
import {
  CascadePanel,
  EpisodeActions,
  EpisodeField,
  EpisodePage,
  EpisodeSection,
  LockedField,
  WorkflowSteps,
  dateOnly,
  endOfEpisodeMessage,
  errorCodeOf,
  errorFieldOf,
  longDate,
  todayLocal,
  useEpisodeAdmission,
} from "./end-of-episode-ui";
import { authFailureRedirect } from "./write-workflow";

const STEPS = ["Record death", "Review & sign", "Post-death cascade"] as const;
const MIN_NARRATIVE = 10;
/** §2.3.1 — only an active or on-hold admission accepts `executeDischarge`. */
const DISCHARGEABLE = new Set(["active", "on_hold"]);

const DEATH_MESSAGES: Record<string, string> = {
  DEATH_CERTIFIER_INVALID: "Select the physician who pronounced or certified the death.",
  DISCHARGE_NARRATIVE_TOO_SHORT: `The pronouncement note must be at least ${MIN_NARRATIVE} characters.`,
  DISCHARGE_BEFORE_ADMISSION: "The date of death cannot be before the admission date.",
};

export const DEATH_CASCADE = [
  { label: "Admission → Bereavement", detail: "The episode ends in bereavement, not discharged." },
  { label: "Patient marked deceased", detail: "The chart records the date of death." },
  {
    label: "Bereavement program",
    detail: "13-month family follow-up opens unless the family opted out.",
  },
  {
    label: "Final claim and NOTR",
    detail: "Billing is limited to the date of death; recertification claims are blocked.",
  },
  { label: "Mortality review", detail: "A quality review draft is created." },
];

interface Draft {
  deathDate: string;
  certifierId: string;
  certifierLabel: string;
  narrative: string;
}

type FieldErrors = Partial<Record<"deathDate" | "certifierId" | "narrative", string>>;

export function validateDeath(d: Draft, admissionDate: string, today: string): FieldErrors {
  const e: FieldErrors = {};
  if (!d.deathDate) e.deathDate = "Enter the date of death.";
  else if (d.deathDate > today) e.deathDate = "The date of death cannot be in the future.";
  else if (admissionDate && d.deathDate < admissionDate)
    e.deathDate = "The date of death cannot be before the admission date.";
  if (!d.certifierId) e.certifierId = "Select the pronouncing physician.";
  if (d.narrative.trim().length < MIN_NARRATIVE)
    e.narrative = `Enter at least ${MIN_NARRATIVE} characters.`;
  return e;
}

export function DeathPronouncement(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const client = useApiClient();
  const navigate = useNavigate();
  const admission = useEpisodeAdmission(id);
  const today = todayLocal();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>({
    deathDate: today,
    certifierId: "",
    certifierLabel: "",
    narrative: "",
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (admission === null) return <output>Loading admission…</output>;
  if (admission === "error")
    return (
      <InlineAlert tone="error">This admission was not found or is not visible to you.</InlineAlert>
    );

  const admissionDate = dateOnly(admission.admissionAt);
  const dischargeable = DISCHARGEABLE.has(admission.state);
  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

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
        },
      });
      if (error) {
        const code = errorCodeOf(error);
        const redirect = authFailureRedirect(response?.status, code, window.location.pathname);
        if (redirect) {
          navigate(redirect);
          return;
        }
        // A field-level rejection sends the clinician back to the form, on the field.
        const field = errorFieldOf(error);
        if (code === "DEATH_CERTIFIER_INVALID" || field === "deathCertifierId") {
          setErrors({ certifierId: DEATH_MESSAGES.DEATH_CERTIFIER_INVALID });
          setStep(0);
        } else if (code === "DISCHARGE_NARRATIVE_TOO_SHORT" || field === "narrative") {
          setErrors({ narrative: DEATH_MESSAGES.DISCHARGE_NARRATIVE_TOO_SHORT });
          setStep(0);
        } else if (code === "DISCHARGE_BEFORE_ADMISSION" || field === "dischargeDate") {
          setErrors({ deathDate: DEATH_MESSAGES.DISCHARGE_BEFORE_ADMISSION });
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

  const breadcrumb = (
    <>
      <Link to="/admissions">Admissions</Link> /{" "}
      <Link to={`/admissions/${admission.id}`}>Admission</Link> / Death &amp; Pronouncement
    </>
  );

  return (
    <EpisodePage
      title="Death & Pronouncement"
      subtitle="Record the death and pronouncing physician. This ends the hospice episode."
      breadcrumb={breadcrumb}
      railLabel="What happens next"
      rail={
        <CascadePanel
          title="When the death is recorded"
          items={DEATH_CASCADE}
          footnote="These run automatically on the server after you sign. They are not shown as live status here."
        />
      }
    >
      <WorkflowSteps steps={STEPS} current={step} label="Death workflow progress" />

      {!dischargeable && step < 2 ? (
        <InlineAlert tone="info">
          This admission is {stateLabel(admission.state).toLowerCase()}. A death can only be
          recorded on an active or on-hold admission.
        </InlineAlert>
      ) : null}

      {step === 0 ? (
        <>
          <EpisodeSection
            icon="clock"
            title="Time of death"
            description="The calendar date the patient died. The final claim covers through this date."
          >
            <div className="wx-field-grid">
              <EpisodeField
                htmlFor="death-date"
                label="Date of death"
                code="dischargeDate"
                required
                error={errors.deathDate}
              >
                <input
                  id="death-date"
                  type="date"
                  value={draft.deathDate}
                  max={today}
                  min={admissionDate || undefined}
                  aria-invalid={errors.deathDate ? true : undefined}
                  onChange={(e) => patch({ deathDate: e.target.value })}
                  disabled={!dischargeable}
                />
              </EpisodeField>
              <LockedField
                id="death-admitted"
                label="Admitted"
                value={longDate(admission.admissionAt)}
                source="From the admission record"
              />
              <LockedField
                id="death-reason"
                label="Discharge reason"
                code="reason"
                value="Death"
                source="Set by this workflow"
              />
            </div>
          </EpisodeSection>

          <EpisodeSection
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
                  disabled={!dischargeable}
                  error={errors.certifierId}
                  hint="Searches the physician directory."
                />
              </div>
              <EpisodeField
                htmlFor="death-narrative"
                label="Pronouncement note"
                code="narrative"
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
                  disabled={!dischargeable}
                />
              </EpisodeField>
            </div>
          </EpisodeSection>

          <EpisodeActions error={submitError}>
            <Button tone="secondary" onClick={() => navigate(`/admissions/${admission.id}`)}>
              Cancel
            </Button>
            <Button onClick={toReview} disabled={!dischargeable}>
              Review
            </Button>
          </EpisodeActions>
        </>
      ) : null}

      {step === 1 ? (
        <>
          <EpisodeSection
            icon="file-check"
            title="Review and sign"
            description="Signing records the death and cannot be undone from this screen. You may be asked to confirm your identity."
          >
            <dl className="wx-field-grid" style={{ margin: 0 }}>
              <ReviewItem term="Date of death" value={longDate(draft.deathDate)} />
              <ReviewItem term="Pronouncing physician" value={draft.certifierLabel || "Selected"} />
              <ReviewItem term="Discharge reason" value="Death" />
              <div className="wx-field-grid-full">
                <ReviewItem term="Pronouncement note" value={draft.narrative.trim()} />
              </div>
            </dl>
          </EpisodeSection>
          <EpisodeActions error={submitError}>
            <Button tone="secondary" onClick={() => setStep(0)} disabled={busy}>
              Back
            </Button>
            <Button tone="danger" onClick={() => void submit()} loading={busy} disabled={busy}>
              Sign and record death
            </Button>
          </EpisodeActions>
        </>
      ) : null}

      {step === 2 ? (
        <EpisodeSection icon="check-circle" title="Death recorded">
          <InlineAlert tone="success">
            The death on {longDate(draft.deathDate)} was recorded. The admission is now in
            bereavement.
          </InlineAlert>
          <p style={{ margin: "0.75rem 0", fontSize: "0.875rem", color: t.onSurfaceVariant }}>
            The post-death cascade listed on the right runs on the server.
          </p>
          <div style={{ display: "flex", gap: "0.625rem", flexWrap: "wrap" }}>
            <Button onClick={() => navigate(`/admissions/${admission.id}`)}>Open admission</Button>
            {admission.patientId ? (
              <Button tone="secondary" onClick={() => navigate(`/patients/${admission.patientId}`)}>
                Open patient chart
              </Button>
            ) : null}
          </div>
        </EpisodeSection>
      ) : null}
    </EpisodePage>
  );
}

export function ReviewItem({ term, value }: { term: string; value: string }): JSX.Element {
  return (
    <div>
      <dt style={{ fontSize: "0.75rem", color: t.onSurfaceVariant }}>{term}</dt>
      <dd style={{ margin: "0.2rem 0 0", whiteSpace: "pre-wrap" }}>{value}</dd>
    </div>
  );
}
