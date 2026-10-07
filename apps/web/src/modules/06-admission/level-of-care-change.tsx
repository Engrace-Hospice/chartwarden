import { Button, EmptyState, InlineAlert, LoadingSpinner, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/06-admission — Level-of-care change (M6 spec screen 13, D12).
// POST /api/v1/admissions/:id/level-of-care. Selecting GIP expands the documentation panel with the three D12
// attestations; the form stays unsubmittable until all are checked and the reason meets R-LCP-01. The server
// enforces the same rules (412 GIP_DOCUMENTATION_INCOMPLETE / 422 GIP_DOCUMENTATION_INSUFFICIENT) and a refusal
// is rendered here, in place. IRC/GIP land `assigning` until M37 confirms a bed — the confirmation says so.
import { type JSX, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { MdmEntityLookupField } from "../../shell/entity-lookups";
import { stateLabel } from "./admission-status";
import {
  AdmissionPanel,
  EpisodeWorkspace,
  Section,
  WorkflowHead,
  endOfEpisodeMessage,
  errorCodeOf,
  localToday,
  useEpisodeAdmission,
} from "./end-of-episode-ui";
import {
  GIP_ATTESTATIONS,
  LEVELS,
  LOC_CHANGEABLE_STATES,
  type LevelValue,
  type LocDraft,
  type LocErrors,
  emptyDraft,
  locRequestBody,
  needsFacility,
  validateLocDraft,
} from "./level-of-care-model";
import { authFailureRedirect } from "./write-workflow";

const LOC_MESSAGES: Record<string, string> = {
  GIP_DOCUMENTATION_INCOMPLETE:
    "General inpatient care needs all three attestations confirmed before it can be requested.",
  GIP_DOCUMENTATION_INSUFFICIENT:
    "Describe the uncontrolled symptoms or end-of-life status in at least 30 characters.",
  IPU_FACILITY_REQUIRED: "Inpatient care needs an inpatient facility.",
  LEVEL_OF_CARE_OVERLAP: "This change overlaps an existing level-of-care period.",
};

export function LevelOfCareChange(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const client = useApiClient();
  const navigate = useNavigate();
  const admission = useEpisodeAdmission(id);
  const today = localToday();
  const [draft, setDraft] = useState<LocDraft>(() => emptyDraft(today));
  const [errors, setErrors] = useState<LocErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ state: string } | null>(null);

  if (admission === null) return <LoadingSpinner />;
  if (admission === "error")
    return (
      <EmptyState
        title="Unavailable"
        description="This admission was not found or is not visible to you."
      />
    );

  const backTo = `/admissions/${admission.id}`;
  const changeable = LOC_CHANGEABLE_STATES.has(admission.state);
  const isGip = draft.newLevel === "general_inpatient_care";
  const patch = (p: Partial<LocDraft>) => setDraft((d) => ({ ...d, ...p }));
  const allErrors = validateLocDraft(draft);
  const canSubmit = changeable && Object.keys(allErrors).length === 0 && !busy;

  async function submit(): Promise<void> {
    const found = validateLocDraft(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const { data, error, response } = await client.POST("/api/v1/admissions/{id}/level-of-care", {
        params: { path: { id: admission === null || admission === "error" ? "" : admission.id } },
        body: locRequestBody(draft),
      } as never);
      if (error) {
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
            LOC_MESSAGES,
            "The level of care could not be changed. Try again.",
          ),
        );
        return;
      }
      setResult({ state: (data as { state?: string } | undefined)?.state ?? "active" });
    } catch {
      setSubmitError(
        "The level of care could not be changed. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  const rail = <AdmissionPanel admission={admission} />;

  return (
    <EpisodeWorkspace patientId={admission.patientId} backTo={backTo} rail={rail}>
      <div className="wx-hope-workspace">
        <main className="wx-hope-main">
          <WorkflowHead
            title="Change level of care"
            detail="Step up or down between home care and inpatient levels"
          />

          {!changeable && !result ? (
            <InlineAlert tone="info">
              This admission is {stateLabel(admission.state).toLowerCase()}. The level of care can
              only change while it is active or on hold.
            </InlineAlert>
          ) : null}

          {result ? (
            <Section icon="check-circle" title="Level of care requested">
              <InlineAlert tone="success">
                {result.state === "assigning"
                  ? "Recorded. The inpatient bed is being assigned; the level of care takes effect once the bed is confirmed."
                  : "The new level of care is in effect."}
              </InlineAlert>
              <Link to={backTo} className="wx-btn-primary">
                Open admission
              </Link>
            </Section>
          ) : (
            <Section icon="bed" title="New level of care">
              <div style={{ display: "grid", gap: "0.875rem", maxWidth: "40rem" }}>
                <fieldset style={{ border: "none", margin: 0, padding: 0 }}>
                  <legend>Level</legend>
                  {LEVELS.map((level) => (
                    <label key={level.value} style={{ display: "block", padding: "0.25rem 0" }}>
                      <input
                        type="radio"
                        name="newLevel"
                        value={level.value}
                        checked={draft.newLevel === level.value}
                        disabled={!changeable}
                        onChange={() => patch({ newLevel: level.value as LevelValue })}
                      />{" "}
                      {level.label}
                    </label>
                  ))}
                </fieldset>

                <label style={{ display: "grid", gap: "0.25rem" }}>
                  <span>Effective date</span>
                  <input
                    type="date"
                    value={draft.effectiveStart}
                    disabled={!changeable}
                    onChange={(e) => patch({ effectiveStart: e.target.value })}
                  />
                  {errors.effectiveStart ? <span role="alert">{errors.effectiveStart}</span> : null}
                </label>

                {needsFacility(draft.newLevel) ? (
                  <MdmEntityLookupField
                    kind="facility"
                    label="Inpatient facility"
                    value={draft.facilityId}
                    valueLabel={draft.facilityLabel || undefined}
                    onChange={(value, option) =>
                      patch({ facilityId: value, facilityLabel: option?.searchLabel ?? "" })
                    }
                    required
                    error={errors.facilityId}
                  />
                ) : null}

                <label style={{ display: "grid", gap: "0.25rem" }}>
                  <span>
                    Reason {isGip ? "(uncontrolled symptoms / end-of-life, min 30 characters)" : ""}
                  </span>
                  <textarea
                    rows={4}
                    value={draft.reason}
                    disabled={!changeable}
                    onChange={(e) => patch({ reason: e.target.value })}
                  />
                  {errors.reason ? <span role="alert">{errors.reason}</span> : null}
                </label>

                {isGip ? (
                  <fieldset
                    aria-label="GIP documentation"
                    style={{ border: "1px solid var(--color-outline-variant)", padding: "0.75rem" }}
                  >
                    <legend>GIP documentation (required)</legend>
                    {GIP_ATTESTATIONS.map((a) => (
                      <label key={a.key} style={{ display: "block", padding: "0.25rem 0" }}>
                        <input
                          type="checkbox"
                          checked={draft.attestations[a.key]}
                          disabled={!changeable}
                          onChange={(e) =>
                            patch({
                              attestations: { ...draft.attestations, [a.key]: e.target.checked },
                            })
                          }
                        />{" "}
                        {a.label}
                      </label>
                    ))}
                    {errors.attestations ? <span role="alert">{errors.attestations}</span> : null}
                  </fieldset>
                ) : null}

                {submitError ? <InlineAlert tone="error">{submitError}</InlineAlert> : null}

                <div>
                  <Button onClick={() => void submit()} disabled={!canSubmit}>
                    {busy ? "Submitting..." : "Request level of care change"}
                  </Button>
                </div>
              </div>
            </Section>
          )}
        </main>
      </div>
    </EpisodeWorkspace>
  );
}
