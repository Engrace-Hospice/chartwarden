import { InlineAlert, LoadingSpinner, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/06-admission — "Discharge details for billing": the guided screen that completes a death
// discharge or transfer-out recorded before WardenX captured the detail the final Medicare claim needs (place of
// death → patient status 40/41/42; receiving care setting → 50/51). Reached from the admission detail's alert and
// from a blocked claim's "Fix discharge details" action (`?claimId=` returns there).
//   GET  /api/v1/admissions/:id/discharge-details
//   POST /api/v1/discharges/:id/place-of-death           { placeOfDeath, ifVersion, correctionReason? }
//   POST /api/v1/transfers/:id/receiving-care-setting    { receivingCareSetting, ifVersion, correctionReason? }
// Steps: why it is needed → choose the value → confirm → recorded (with the way back to the claim). When nothing is
// missing the same screen corrects a recorded value, which needs a reason the server stores with the change. The
// server is the authority (discharge.death / transfer.out + admission scope); a 403 says which permission it took.
import { type JSX, useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  formatClaimDate,
  missingDetailExplanation,
  missingDetailNoun,
} from "../../shell/discharge-claim-codes";
import {
  CORRECTION_REASON_MIN,
  DETAIL_MESSAGES,
  type DetailErrors,
  type DetailTarget,
  type DischargeDetailsView,
  choicesFor,
  detailTarget,
  forbiddenMessage,
  validateDetail,
} from "./discharge-details-model";
import {
  AdmissionPanel,
  ChoiceRows,
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
  useEpisodeAdmission,
} from "./end-of-episode-ui";
import { authFailureRedirect } from "./write-workflow";

const STEPS = ["Why it's needed", "Choose", "Confirm", "Recorded"] as const;

const AFTER_SAVE: readonly WhatHappensItem[] = [
  {
    icon: "file-text",
    text: "The value is saved on the discharge record and kept in the audit trail.",
  },
  {
    icon: "receipt",
    text: "Billing re-validates this admission's open claims and sets the patient status.",
  },
  { icon: "check-circle", text: "A claim held only for this reason can then be submitted." },
];

type Load = DischargeDetailsView | null | "error";

export function DischargeDetails(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const [search] = useSearchParams();
  const claimId = search.get("claimId");
  const client = useApiClient();
  const navigate = useNavigate();
  const admission = useEpisodeAdmission(id);

  const [view, setView] = useState<Load>(null);
  const [step, setStep] = useState(0);
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<DetailErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [correctingRecorded, setCorrectingRecorded] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setView(null);
    try {
      const { data, error } = await client.GET("/api/v1/admissions/{id}/discharge-details", {
        params: { path: { id } },
      });
      setView(error || !data ? "error" : (data as DischargeDetailsView));
    } catch {
      setView("error");
    }
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!id) return <InlineAlert tone="error">No admission was specified.</InlineAlert>;
  if (view === null || admission === null) return <LoadingSpinner />;

  const backToAdmission = `/admissions/${id}`;
  const claimLink = claimId ? `/billing/claims/${encodeURIComponent(claimId)}` : null;
  const target = view === "error" ? null : detailTarget(view);

  const frame = (children: JSX.Element): JSX.Element =>
    admission === "error" || !admission.patientId ? (
      children
    ) : (
      <EpisodeWorkspace
        patientId={admission.patientId}
        backTo={backToAdmission}
        rail={
          <>
            <AdmissionPanel admission={admission} />
            <WhatHappensPanel title="When you save">
              <WhatHappensList items={AFTER_SAVE} compact />
            </WhatHappensPanel>
          </>
        }
      >
        {children}
      </EpisodeWorkspace>
    );

  if (view === "error" || !target) {
    return frame(
      <div className="wx-hope-workspace">
        <main className="wx-hope-main">
          <WorkflowHead title="Discharge details for billing" stepLine="Nothing to record" />
          <InlineAlert tone={view === "error" ? "error" : "info"}>
            {view === "error"
              ? "The discharge record could not be loaded. It may not exist or may not be visible to you."
              : "This admission has no completed death discharge or transfer-out, so there is no place of death or receiving care setting to record."}
          </InlineAlert>
          <WorkflowFooter note="Discharge details">
            <Link to={claimLink ?? backToAdmission} className="wx-btn-secondary">
              {claimLink ? "Back to claim" : "Back to admission"}
            </Link>
          </WorkflowFooter>
        </main>
      </div>,
    );
  }

  const noun = missingDetailNoun(target.detail);
  const choices = choicesFor(target.detail);
  const chosen = choices.find((c) => c.value === value);
  const nothingMissing = target.correcting && !correctingRecorded;
  const title =
    target.detail === "place_of_death"
      ? "Record the place of death"
      : "Record the receiving care setting";

  const toConfirm = () => {
    const e = validateDetail(target, value, reason);
    setErrors(e);
    if (Object.keys(e).length === 0) setStep(2);
  };

  const save = async (t: DetailTarget) => {
    setBusy(true);
    setSubmitError(null);
    const correction =
      t.correcting && reason.trim() ? { correctionReason: reason.trim() } : ({} as const);
    try {
      const { error, response } =
        t.detail === "place_of_death"
          ? await client.POST("/api/v1/discharges/{id}/place-of-death", {
              params: { path: { id: t.recordId } },
              body: {
                placeOfDeath: value as "home" | "facility" | "unknown",
                ifVersion: t.version,
                ...correction,
              },
            })
          : await client.POST("/api/v1/transfers/{id}/receiving-care-setting", {
              params: { path: { id: t.recordId } },
              body: {
                receivingCareSetting: value as "home" | "facility",
                ifVersion: t.version,
                ...correction,
              },
            });
      if (error) {
        const code = errorCodeOf(error);
        const redirect = authFailureRedirect(response?.status, code, window.location.pathname);
        if (redirect) {
          navigate(redirect);
          return;
        }
        setSubmitError(
          response?.status === 403
            ? forbiddenMessage(t.detail)
            : endOfEpisodeMessage(
                response?.status,
                code,
                DETAIL_MESSAGES,
                `The ${missingDetailNoun(t.detail)} could not be saved. Try again.`,
              ),
        );
        return;
      }
      setStep(3);
    } catch {
      setSubmitError("The value could not be saved. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const eventLine =
    target.detail === "place_of_death"
      ? `Death recorded ${formatClaimDate(target.effectiveDate)}`
      : `Transfer out effective ${formatClaimDate(target.effectiveDate)}${
          view.transferOut?.receivingHospiceName
            ? ` to ${view.transferOut.receivingHospiceName}`
            : ""
        }`;
  const currentLabel = choices.find((c) => c.value === target.current);

  return frame(
    <div className="wx-hope-workspace">
      <StepNav
        label="Discharge details progress"
        heading="Discharge details"
        steps={linearSteps(STEPS, step === 3 ? STEPS.length : step)}
        activeId={step === 3 ? null : String(step)}
      />
      <main className="wx-hope-main">
        <WorkflowHead
          title={title}
          stepLine={
            step === 3 ? "Recorded" : `Step ${step + 1} of ${STEPS.length} · ${STEPS[step]}`
          }
        />

        {step === 0 ? (
          <Section icon="info" title="Why this is needed" description={eventLine}>
            {nothingMissing ? (
              <div style={{ display: "grid", gap: "0.75rem" }}>
                <InlineAlert tone="success">
                  The {noun} is recorded as <strong>{currentLabel?.label ?? target.current}</strong>{" "}
                  (claim patient status {currentLabel?.status ?? "—"}). Nothing is missing.
                </InlineAlert>
                <p style={bodyText}>
                  If the recorded value is wrong you can correct it. The correction needs a reason,
                  which is kept with the change, and the admission's open claims are re-validated.
                </p>
              </div>
            ) : (
              <div style={{ display: "grid", gap: "0.75rem" }}>
                <InlineAlert tone="info">{missingDetailExplanation(target.detail)}</InlineAlert>
                <p style={bodyText}>
                  Record the {noun} once and billing re-validates the claim. The answer is used only
                  for the claim's patient status; the clinical record is unchanged otherwise.
                </p>
              </div>
            )}
          </Section>
        ) : null}

        {step === 1 ? (
          <Section
            icon="pencil"
            title={
              target.detail === "place_of_death"
                ? "Where did the patient die?"
                : "Where will the receiving hospice care for the patient?"
            }
            description={eventLine}
          >
            <div style={{ display: "grid", gap: "0.875rem" }}>
              <ChoiceRows
                name="discharge-detail"
                legend={
                  target.detail === "place_of_death" ? "Place of death" : "Receiving care setting"
                }
                options={choices.map((c) => ({ value: c.value, label: c.label, hint: c.hint }))}
                value={value}
                onChange={(v) => setValue(v)}
                error={errors.value}
                hint="Sets the patient status on the final Medicare claim."
              />
              {target.correcting ? (
                <Field
                  id="dd-reason"
                  label="Reason for the correction"
                  required
                  full
                  hint={`${reason.trim().length} / at least ${CORRECTION_REASON_MIN} characters. Kept with the change.`}
                  error={errors.reason}
                >
                  <textarea
                    id="dd-reason"
                    rows={3}
                    value={reason}
                    maxLength={2000}
                    aria-invalid={errors.reason ? true : undefined}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </Field>
              ) : null}
            </div>
          </Section>
        ) : null}

        {step === 2 && chosen ? (
          <Section icon="clipboard-check" title="Confirm" description={eventLine}>
            <div style={{ display: "grid", gap: "0.75rem" }}>
              <ReviewList
                rows={[
                  {
                    term:
                      target.detail === "place_of_death"
                        ? "Place of death"
                        : "Receiving care setting",
                    value: chosen.label,
                  },
                  {
                    term: "Claim patient status",
                    value: `${chosen.status} — ${chosen.hint.replace(/^Patient status \d+ — /, "")}`,
                  },
                  ...(target.correcting
                    ? [
                        { term: "Replaces", value: currentLabel?.label ?? String(target.current) },
                        { term: "Reason", value: reason.trim() },
                      ]
                    : []),
                ]}
              />
              {submitError ? <InlineAlert tone="error">{submitError}</InlineAlert> : null}
            </div>
          </Section>
        ) : null}

        {step === 3 && chosen ? (
          <Section icon="check-circle" title={`The ${noun} is recorded`}>
            <div style={{ display: "grid", gap: "0.75rem" }}>
              <InlineAlert tone="success">
                Saved as {chosen.label.toLowerCase()} (claim patient status {chosen.status}).
                Billing re-validates this admission's open claims automatically.
              </InlineAlert>
              {claimId ? (
                <p style={bodyText}>
                  Open the claim's validation worklist to re-run validation now, or go back to the
                  claim.
                </p>
              ) : null}
            </div>
          </Section>
        ) : null}

        <WorkflowFooter note="Discharge details">
          {step === 3 ? (
            <>
              {claimId ? (
                <Link
                  to={`/billing/claims/${encodeURIComponent(claimId)}/validation`}
                  className="wx-btn-secondary"
                >
                  Re-validate claim
                </Link>
              ) : null}
              <Link to={claimLink ?? backToAdmission} className="wx-btn-primary">
                {claimLink ? "Back to claim" : "Back to admission"}
              </Link>
            </>
          ) : (
            <>
              {step === 0 ? (
                <Link to={claimLink ?? backToAdmission} className="wx-btn-secondary">
                  {claimLink ? "Back to claim" : "Cancel"}
                </Link>
              ) : (
                <button
                  type="button"
                  className="wx-btn-secondary"
                  onClick={() => setStep(step - 1)}
                >
                  Back
                </button>
              )}
              {step === 0 ? (
                <button
                  type="button"
                  className="wx-btn-primary"
                  onClick={() => {
                    if (nothingMissing) setCorrectingRecorded(true);
                    setStep(1);
                  }}
                >
                  {nothingMissing ? "Correct the recorded value" : `Record the ${noun}`}
                </button>
              ) : null}
              {step === 1 ? (
                <button type="button" className="wx-btn-primary" onClick={toConfirm}>
                  Review
                </button>
              ) : null}
              {step === 2 ? (
                <button
                  type="button"
                  className="wx-btn-primary"
                  disabled={busy}
                  onClick={() => void save(target)}
                >
                  {busy ? "Saving…" : `Save ${noun}`}
                </button>
              ) : null}
            </>
          )}
        </WorkflowFooter>
      </main>
    </div>,
  );
}
