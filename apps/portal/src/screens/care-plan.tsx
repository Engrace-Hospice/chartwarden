import { Button, Glyph, useApiClient } from "@wardenx/ui";
// M31 portal care-plan summary: M7 owns the care plan and the backend exposes only a
// patient-authorized, PHI-minimised projection. This screen never infers goal completion,
// care status or the contents of server-redacted details.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { usePortalPatient } from "../patient-context";
import { readError } from "./portal-format";
import { PortalPage } from "./portal-page";

interface CareProblem {
  problemId: string;
  label: string;
  goals: string[];
  focus: string[];
}

interface CareSummary {
  problems: CareProblem[];
  redacted: boolean;
}

type CareResource =
  | { status: "loading"; summary: null; error: null }
  | { status: "ready"; summary: CareSummary; error: null }
  | { status: "error"; summary: null; error: string };

const loading = (): CareResource => ({
  status: "loading",
  summary: null,
  error: null,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accept only the existing lay-summary DTO; a malformed response must not masquerade as an empty plan. */
function parseCareSummary(value: unknown): CareSummary | null {
  if (!isRecord(value) || !Array.isArray(value.problems)) return null;
  const problems: CareProblem[] = [];
  for (const raw of value.problems) {
    if (
      !isRecord(raw) ||
      typeof raw.problemId !== "string" ||
      typeof raw.label !== "string" ||
      !Array.isArray(raw.goals) ||
      !Array.isArray(raw.focus) ||
      !raw.goals.every((item: unknown) => typeof item === "string") ||
      !raw.focus.every((item: unknown) => typeof item === "string")
    )
      return null;
    problems.push({
      problemId: raw.problemId,
      label: raw.label.trim() || "Care area",
      goals: raw.goals.map((item: string) => item.trim()).filter(Boolean),
      focus: raw.focus.map((item: string) => item.trim()).filter(Boolean),
    });
  }
  return { problems, redacted: value.redacted === true };
}

function PlanSkeleton(): JSX.Element {
  return (
    <div
      className="wx-care-plan-skeleton"
      role="status"
      aria-label="Loading your care plan"
    >
      <span className="wx-care-plan-skeleton__intro" />
      <span className="wx-care-plan-skeleton__card" />
      <span className="wx-care-plan-skeleton__card" />
      <span className="wx-care-plan-skeleton__side" />
    </div>
  );
}

function PlanError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div className="wx-care-plan-error" role="alert">
      <span className="wx-care-plan-state-icon" aria-hidden="true">
        <Glyph name="alert-circle" size={24} />
      </span>
      <div>
        <h2>Care plan unavailable</h2>
        <p>{message}</p>
        <Button tone="secondary" onClick={onRetry}>
          <Glyph name="rotate-ccw" size={16} aria-hidden="true" /> Try again
        </Button>
      </div>
    </div>
  );
}

function PlanEmpty({ restricted }: { restricted: boolean }): JSX.Element {
  return (
    <div className="wx-care-plan-empty">
      <span className="wx-care-plan-state-icon" aria-hidden="true">
        <Glyph name="clipboard-list" size={26} />
      </span>
      <h2>
        {restricted
          ? "No care-plan details available to show"
          : "No care-plan items shared yet"}
      </h2>
      <p>
        {restricted
          ? "There are no care-plan details available to display in this portal view. Your care team can answer questions about your care."
          : "When your team shares care goals and focus areas, they will appear here."}
      </p>
    </div>
  );
}

function RestrictedContentNotice(): JSX.Element {
  return (
    <aside
      className="wx-care-plan-restricted"
      role="note"
      aria-label="Care plan privacy notice"
    >
      <span className="wx-care-plan-restricted__icon" aria-hidden="true">
        <Glyph name="shield-check" size={21} />
      </span>
      <div>
        <strong>Some details are not shown here</strong>
        <p>
          This portal shows only the care-plan information available to your
          account. Your care team can help explain what can be shared.
        </p>
      </div>
    </aside>
  );
}

function CareAreaCard({
  problem,
  index,
}: {
  problem: CareProblem;
  index: number;
}): JSX.Element {
  const hasDetails = problem.goals.length > 0 || problem.focus.length > 0;
  return (
    <li className="wx-care-plan-area">
      <div className="wx-care-plan-area__heading">
        <span className="wx-care-plan-area__number" aria-hidden="true">
          {String(index + 1).padStart(2, "0")}
        </span>
        <div>
          <span className="wx-care-plan-eyebrow">Care area</span>
          <h3>{problem.label}</h3>
        </div>
      </div>
      {hasDetails ? (
        <div className="wx-care-plan-area__content">
          {problem.goals.length > 0 ? (
            <section
              className="wx-care-plan-area__goals"
              aria-label={`Goals for ${problem.label}`}
            >
              <h4>
                <Glyph name="target" size={17} aria-hidden="true" /> Care goals
              </h4>
              <ul>
                {problem.goals.map((goal, goalIndex) => (
                  // No individual goal IDs in the read-only lay-summary response.
                  <li key={`${goalIndex}-${goal}`}>
                    <span
                      className="wx-care-plan-goal-mark"
                      aria-hidden="true"
                    />
                    <span>{goal}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {problem.focus.length > 0 ? (
            <section
              className="wx-care-plan-area__focus"
              aria-label={`Focus areas for ${problem.label}`}
            >
              <h4>
                <Glyph name="heart" size={17} aria-hidden="true" />{" "}
                Areas of focus
              </h4>
              <ul>
                {problem.focus.map((item, focusIndex) => (
                  <li key={`${focusIndex}-${item}`}>{item}</li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : (
        <p className="wx-care-plan-area__no-details">
          No additional details have been shared for this care area.
        </p>
      )}
    </li>
  );
}

function CarePlanContent({ summary }: { summary: CareSummary }): JSX.Element {
  return (
    <div className="wx-care-plan-page">
      <div className="wx-care-plan-intro">
        <span className="wx-care-plan-intro__icon" aria-hidden="true">
          <Glyph name="clipboard-check" size={24} />
        </span>
        <div>
          <span className="wx-care-plan-eyebrow">Your care overview</span>
          <p>
            See the goals and care priorities your hospice team has shared with
            you.
          </p>
        </div>
      </div>
      {summary.redacted ? <RestrictedContentNotice /> : null}
      {summary.problems.length > 0 ? (
        <div className="wx-care-plan-layout">
          <section
            className="wx-care-plan-main"
            aria-labelledby="wx-care-plan-areas-title"
          >
            <div className="wx-care-plan-section-head">
              <div>
                <span className="wx-care-plan-eyebrow">Shared care plan</span>
                <h2 id="wx-care-plan-areas-title">Your care areas</h2>
                <p>Goals and areas of focus provided by your care team.</p>
              </div>
              <span className="wx-care-plan-count">
                {summary.problems.length}{" "}
                {summary.problems.length === 1 ? "area" : "areas"} shared
              </span>
            </div>
            <ol className="wx-care-plan-area-list" aria-label="Care areas">
              {summary.problems.map((problem, index) => (
                <CareAreaCard
                  key={`${problem.problemId}-${index}`}
                  problem={problem}
                  index={index}
                />
              ))}
            </ol>
          </section>
          <aside
            className="wx-care-plan-guide"
            aria-labelledby="wx-care-plan-guide-title"
          >
            <span className="wx-care-plan-guide__icon" aria-hidden="true">
              <Glyph name="info" size={20} />
            </span>
            <h2 id="wx-care-plan-guide-title">Understanding your care plan</h2>
            <p>
              Care goals describe what your team is working toward. Focus areas
              describe what they are paying attention to.
            </p>
            <div className="wx-care-plan-guide__footnote">
              This is a read-only summary. For questions or changes to your care
              plan, speak with your hospice care team.
            </div>
          </aside>
        </div>
      ) : (
        <PlanEmpty restricted={summary.redacted} />
      )}
    </div>
  );
}

/** Remount by patient key so no previous patient's plan can appear under a new patient context. */
export function PortalCarePlanView(): JSX.Element {
  const { patientId } = usePortalPatient();
  return (
    <CarePlanForPatient key={patientId ?? "no-patient"} patientId={patientId} />
  );
}

function CarePlanForPatient({
  patientId,
}: {
  patientId: string | null;
}): JSX.Element {
  const client = useApiClient();
  const [resource, setResource] = useState<CareResource>(loading);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    void attempt;
    let active = true;
    setResource(loading());
    if (!patientId)
      return () => {
        active = false;
      };
    void (async () => {
      try {
        const response = await client.GET(
          "/api/v1/portal/care-plan/summary",
          {},
        );
        if (!active) return;
        if ("error" in response) {
          setResource({
            status: "error",
            summary: null,
            error: readError(response.response?.status),
          });
          return;
        }
        const summary = parseCareSummary(response.data);
        if (!summary) {
          setResource({
            status: "error",
            summary: null,
            error: readError(undefined),
          });
          return;
        }
        setResource({ status: "ready", summary, error: null });
      } catch {
        if (active)
          setResource({
            status: "error",
            summary: null,
            error: readError(undefined),
          });
      }
    })();
    return () => {
      active = false;
    };
  }, [client, patientId, attempt]);

  return (
    <PortalPage
      title="Care plan"
      subtitle="Your care goals and priorities, explained in everyday language."
      width="workspace"
    >
      {!patientId ? (
        <div className="wx-care-plan-empty">
          <h2>Choose a patient to view their care plan</h2>
          <p>Select an authorized patient from the portal to continue.</p>
        </div>
      ) : resource.status === "loading" ? (
        <PlanSkeleton />
      ) : resource.status === "error" ? (
        <PlanError
          message={resource.error}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      ) : (
        <CarePlanContent summary={resource.summary} />
      )}
    </PortalPage>
  );
}
