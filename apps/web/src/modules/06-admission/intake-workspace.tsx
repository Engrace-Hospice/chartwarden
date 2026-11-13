import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  StickyFooterActions,
  type WorkflowStep,
  WorkflowStepper,
  t,
  useApiClient,
} from "@chartwarden/ui";
import type { CSSProperties, JSX } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { REFERRAL_TONE, stateLabel } from "./admission-status";
import { AdmissionsTabs } from "./admissions-chrome";
import { type IntakeStepId, deriveIntakeWorkspace } from "./intake-workspace-stage";
import { ReferralDetail } from "./referral-detail";
import { type ReferralView, getReferral } from "./referrals-api";

const STEP_DEFINITIONS: readonly {
  id: IntakeStepId;
  label: string;
  description: string;
}[] = [
  { id: "receive", label: "Receive referral", description: "Referral details and records" },
  { id: "verify", label: "Verify information", description: "Missing and source information" },
  { id: "match", label: "Match patient", description: "Confirm or create deliberately" },
  { id: "review", label: "Review requirements", description: "Clinical and coverage facts" },
  { id: "handoff", label: "Start admission", description: "Existing conversion transition" },
  {
    id: "requirements",
    label: "Admission readiness",
    description: "Election, certification, assessments and activation",
  },
];

export function IntakeWorkspace(): JSX.Element {
  const { id = "" } = useParams();
  const client = useApiClient();
  const navigate = useNavigate();
  const [referral, setReferral] = useState<ReferralView | null>(null);
  const [viewedStepId, setViewedStepId] = useState<IntakeStepId | null>(null);
  const [reviewingEarlierStep, setReviewingEarlierStep] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReferral(await getReferral(client, id));
    } catch (err) {
      setError(errorMessage(err, "The intake workspace could not be loaded."));
    } finally {
      setLoading(false);
    }
  }, [client, id]);

  useEffect(() => {
    setViewedStepId(null);
    setReviewingEarlierStep(false);
    void load();
  }, [load]);

  const presentation = referral ? deriveIntakeWorkspace(referral) : null;
  const displayedStepId = viewedStepId ?? presentation?.activeStepId ?? "receive";
  const steps = useMemo<readonly WorkflowStep[]>(() => {
    if (!presentation) return [];
    const activeIndex = stepIndex(presentation.activeStepId);
    return STEP_DEFINITIONS.map((step) => ({
      ...step,
      state:
        step.id === displayedStepId
          ? step.id === presentation.activeStepId && presentation.activeStepBlocked
            ? "blocked"
            : "in_progress"
          : stepIndex(step.id) < activeIndex
            ? "complete"
            : "not_started",
      disabled: stepIndex(step.id) > activeIndex,
    }));
  }, [displayedStepId, presentation]);

  if (loading) return <LoadingSpinner />;
  if (!referral || !presentation) {
    return (
      <div className="wx-list-state" role={error ? "alert" : undefined}>
        <EmptyState title="Intake unavailable" description={error ?? "Referral not found."} />
        {error ? (
          <Button tone="secondary" onClick={() => void load()}>
            Try again
          </Button>
        ) : null}
      </div>
    );
  }

  const owner = referral.assignedToUserId
    ? referral.assignedToDisplayName || "Staff member"
    : "Unassigned";
  const currentPresentation = presentation;
  const displayedCopy = stepCopy(displayedStepId, currentPresentation);
  const activeIndex = stepIndex(currentPresentation.activeStepId);
  const displayedIndex = stepIndex(displayedStepId);
  const isReviewingEarlierStep = reviewingEarlierStep && displayedIndex < activeIndex;

  function selectStep(stepId: string): void {
    const nextStepId = stepId as IntakeStepId;
    if (stepIndex(nextStepId) > activeIndex) return;
    setViewedStepId(nextStepId === currentPresentation.activeStepId ? null : nextStepId);
    setReviewingEarlierStep(stepIndex(nextStepId) < activeIndex);
    focusTask(nextStepId);
  }

  function focusTask(stepId: IntakeStepId): void {
    const target = document.getElementById(taskTargetId(stepId));
    if (typeof target?.scrollIntoView === "function") target.scrollIntoView({ block: "start" });
    target?.focus({ preventScroll: true });
  }

  function runPrimaryAction(): void {
    if (displayedStepId === "verify") {
      const save = document.querySelector<HTMLButtonElement>(
        '[data-intake-primary-action="save-info"]',
      );
      if (save && !save.disabled) {
        save.click();
        return;
      }
      focusTask("verify");
      return;
    }

    if (displayedStepId === "review" && currentPresentation.blockers.length > 0) {
      const save = document.querySelector<HTMLButtonElement>(
        '[data-intake-primary-action="save-info"]',
      );
      if (save && !save.disabled) {
        save.click();
        return;
      }
      focusTask("review");
      return;
    }

    if (isReviewingEarlierStep) {
      setViewedStepId(null);
      setReviewingEarlierStep(false);
      focusTask(currentPresentation.activeStepId);
      return;
    }

    if (currentPresentation.primaryAction.href.startsWith("/admissions/")) {
      navigate(currentPresentation.primaryAction.href);
      return;
    }

    const action = document.querySelector<HTMLButtonElement>(
      `[data-intake-primary-action="${primaryActionName(displayedStepId)}"]`,
    );
    if (action && !action.disabled) {
      action.click();
      return;
    }
    focusTask(displayedStepId);
  }

  function goBack(): void {
    const previous = STEP_DEFINITIONS[displayedIndex - 1];
    if (previous && stepIndex(previous.id) <= activeIndex) selectStep(previous.id);
  }

  function handleActionComplete(action: string): void {
    setViewedStepId(action === "review" ? "verify" : null);
    setReviewingEarlierStep(false);
  }

  return (
    <div className="wx-admissions" style={page}>
      <PageHeader
        title={referral.patientNameAtReceipt}
        actions={
          <div style={headerActions}>
            <StatusPill
              label={presentation.queueLabel}
              tone={REFERRAL_TONE[referral.status] ?? "neutral"}
            />
            {referral.priority === "urgent" ? <StatusPill label="Urgent" tone="error" /> : null}
          </div>
        }
      >
        <p style={meta}>
          {referral.externalReferralId ? `Referral ${referral.externalReferralId} · ` : ""}
          {owner} · Canonical status: {stateLabel(referral.status)}
        </p>
      </PageHeader>

      <AdmissionsTabs current="/referrals" />

      <div className="wx-intake-workspace" style={workspace}>
        <nav className="wx-intake-progress" aria-label="Intake progress" style={progress}>
          <WorkflowStepper
            steps={steps}
            activeId={displayedStepId}
            onSelect={selectStep}
            ariaLabel="Intake steps"
          />
        </nav>

        <div className="wx-intake-body" style={body}>
          <section
            className="wx-center-workspace"
            style={center}
            aria-label="Current intake task"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: this is the independently scrollable workspace; keyboard users must be able to focus and scroll it.
            tabIndex={0}
          >
            <section aria-labelledby="intake-stage-heading" style={stageIntro}>
              <p style={eyebrow}>Step {activeStepNumber(displayedStepId)} of 6</p>
              <h2 id="intake-stage-heading" style={title}>
                {displayedCopy.heading}
              </h2>
              <p style={guidance}>{displayedCopy.guidance}</p>
            </section>
            <ReferralDetail
              embedded
              activeStage={displayedStepId}
              onReferralLoaded={setReferral}
              onActionComplete={handleActionComplete}
            />
          </section>

          <aside
            className="wx-intake-context"
            aria-labelledby="needs-attention-heading"
            style={rail}
          >
            <section id="referral-readiness" style={panel} tabIndex={-1}>
              <p style={railEyebrow}>Referral readiness</p>
              <h2 id="needs-attention-heading" style={railTitle}>
                Needs attention
              </h2>
              {presentation.blockers.length > 0 ? (
                <ul style={blockerList}>
                  {presentation.blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              ) : (
                <p style={guidance}>No referral qualification blockers are currently reported.</p>
              )}
            </section>
          </aside>
        </div>
      </div>

      <StickyFooterActions>
        {displayedIndex > 0 ? (
          <Button tone="secondary" onClick={goBack}>
            Back
          </Button>
        ) : null}
        <Button tone="secondary" onClick={() => navigate(`/referrals/${referral.id}`)}>
          View full referral
        </Button>
        <Button tone="primary" onClick={runPrimaryAction}>
          {isReviewingEarlierStep && displayedStepId === "verify"
            ? `Save & return to ${STEP_DEFINITIONS[activeIndex]?.label ?? "current step"}`
            : isReviewingEarlierStep
              ? `Return to ${STEP_DEFINITIONS[activeIndex]?.label ?? "current step"}`
              : primaryLabel(displayedStepId, presentation)}
        </Button>
      </StickyFooterActions>
    </div>
  );
}

function taskTargetId(step: IntakeStepId): string {
  if (step === "receive") return "referral-overview";
  if (step === "verify") return "missing-information";
  if (step === "match") return "patient-resolution";
  if (step === "review") return "review-blockers";
  if (step === "requirements") return "start-admission";
  return "start-admission";
}

function activeStepNumber(step: IntakeStepId): number {
  return stepIndex(step) + 1;
}

function stepIndex(step: IntakeStepId): number {
  return STEP_DEFINITIONS.findIndex((definition) => definition.id === step);
}

function stepCopy(
  step: IntakeStepId,
  presentation: ReturnType<typeof deriveIntakeWorkspace>,
): { heading: string; guidance: string } {
  if (step === presentation.activeStepId) {
    return { heading: presentation.heading, guidance: presentation.guidance };
  }
  const copy: Record<IntakeStepId, { heading: string; guidance: string }> = {
    receive: {
      heading: "Review the received referral",
      guidance: "Review the referral summary, ownership, priority, and source details.",
    },
    verify: {
      heading: "Verify the referral information",
      guidance: "Check the received information and record anything that is still missing.",
    },
    match: {
      heading: "Resolve the patient identity",
      guidance: "Confirm an existing patient or deliberately create a new patient.",
    },
    review: {
      heading: "Review clinical and coverage requirements",
      guidance: "Confirm the clinical, coverage, and referral facts before qualification.",
    },
    handoff: {
      heading: "Start the admission",
      guidance: "Create the admission from this qualified referral.",
    },
    requirements: {
      heading: "Complete admission readiness",
      guidance: "Continue election, certification, assessment, and activation work.",
    },
  };
  return copy[step];
}

function primaryActionName(step: IntakeStepId): string {
  if (step === "receive") return "review";
  if (step === "verify") return "save-info";
  if (step === "review") return "qualify";
  if (step === "handoff") return "convert";
  return step;
}

function primaryLabel(
  step: IntakeStepId,
  presentation: ReturnType<typeof deriveIntakeWorkspace>,
): string {
  if (step === "receive") return "Start review & continue";
  if (step === "verify" && presentation.activeStepId === "match") {
    return "Save & continue to patient matching";
  }
  if (step === "review" && presentation.blockers.length > 0) {
    return "Save review information";
  }
  return presentation.primaryAction.label;
}

function errorMessage(err: unknown, fallback: string): string {
  const error = err as { error?: { message?: string }; message?: string };
  return error.error?.message ?? error.message ?? fallback;
}

const page: CSSProperties = { minHeight: "100%" };
const workspace: CSSProperties = { display: "flex", flexDirection: "column", minHeight: 0 };
const progress: CSSProperties = {
  padding: `${t.space4} ${t.space5}`,
  borderBottom: `1px solid ${t.outlineVariant}`,
  background: t.surfaceLowest,
};
const body: CSSProperties = { display: "flex", flex: 1, minHeight: 0, overflow: "hidden" };
const center: CSSProperties = { flex: 1, minWidth: 0, overflow: "auto", padding: t.space5 };
const rail: CSSProperties = {
  width: "20rem",
  flexShrink: 0,
  padding: t.space5,
  background: t.surfaceLow,
};
const panel: CSSProperties = {
  borderRadius: t.radiusLg,
  padding: t.space5,
  background: t.surfaceLowest,
  boxShadow: t.shadowSoft,
};
const stageIntro: CSSProperties = {
  maxWidth: "56rem",
  marginBottom: t.space4,
  padding: `${t.space2} 0`,
};
const headerActions: CSSProperties = { display: "flex", flexWrap: "wrap", gap: t.space2 };
const meta: CSSProperties = { margin: 0, color: t.onSurfaceVariant };
const eyebrow: CSSProperties = {
  margin: `0 0 ${t.space2}`,
  color: t.primary,
  fontSize: "0.75rem",
  fontWeight: 700,
};
const title: CSSProperties = { margin: 0, color: t.onSurface, fontSize: "1.5rem" };
const railTitle: CSSProperties = { margin: `0 0 ${t.space3}`, fontSize: "1rem" };
const railEyebrow: CSSProperties = {
  margin: `0 0 ${t.space1}`,
  color: t.onSurfaceVariant,
  fontSize: "0.75rem",
  fontWeight: 650,
};
const guidance: CSSProperties = { color: t.onSurfaceVariant, lineHeight: 1.5 };
const blockerList: CSSProperties = { margin: 0, paddingLeft: "1.25rem", lineHeight: 1.5 };
