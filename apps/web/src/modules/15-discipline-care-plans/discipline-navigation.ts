import type { StatusTone } from "@chartwarden/ui";
import type { PlanListItem } from "./discipline-api";
import { PLAN_STATUS_TONE, humanize, toneOf } from "./discipline-status";

const KIND_SEGMENT: Readonly<Record<string, string>> = {
  aide_poc: "aide-poc",
  msw_plan: "msw-plan",
  spiritual_plan: "spiritual-plan",
  volunteer_plan: "volunteer-plan",
};

const overviewPath = (patientId: string): string => `/patients/${patientId}/discipline-plans`;

export function disciplinePlanPath(patientId: string, kind: string): string {
  const segment = KIND_SEGMENT[kind];
  return segment ? `${overviewPath(patientId)}/${segment}` : overviewPath(patientId);
}

export function disciplineAssessmentPath(
  patientId: string,
  kind: string,
  planId: string,
  assessmentId: string,
): string {
  const planPath = disciplinePlanPath(patientId, kind);
  return planPath === overviewPath(patientId)
    ? planPath
    : `${planPath}/${planId}/assessments/${assessmentId}`;
}

export interface DisciplineOverviewPresentation {
  statusLabel: string;
  statusTone: StatusTone;
  nextAction: string;
  description?: string;
}

export function openVersionIntent(plan: PlanListItem): "initial" | "interim_revision" | null {
  if (plan.actionSummary.openVersion !== null) return null;
  if (plan.status === "draft" && plan.actionSummary.latestSignedVersion === null) return "initial";
  if (plan.status === "active") return "interim_revision";
  return null;
}

export function overviewPresentation(
  kind: string,
  plan: PlanListItem | undefined,
  now = Date.now(),
): DisciplineOverviewPresentation {
  if (!plan) {
    if (kind === "volunteer_plan") {
      return {
        statusLabel: "Not assigned",
        statusTone: "neutral",
        nextAction: "No action until a volunteer is assigned",
        description:
          "No volunteer plan yet. A plan is created after the first volunteer assignment.",
      };
    }
    return {
      statusLabel: "Unavailable",
      statusTone: "neutral",
      nextAction: "No plan is available",
      description: "This plan should be created when the admission is activated.",
    };
  }

  const aideSupervisionOverdue =
    kind === "aide_poc" &&
    plan.nextSupervisoryDueAt !== null &&
    Date.parse(plan.nextSupervisoryDueAt) < now;
  const nextAction = aideSupervisionOverdue
    ? "Aide supervision is overdue"
    : openVersionIntent(plan) === "initial"
      ? "Start initial plan"
      : openVersionIntent(plan) === "interim_revision"
        ? "Start next revision"
        : plan.status === "draft"
          ? "Review draft plan"
          : plan.status === "draft_revising"
            ? "Review draft revision"
            : plan.status === "active"
              ? "Review active plan"
              : plan.status === "discharged"
                ? "Review historical plan"
                : "Review plan status";

  return {
    statusLabel: humanize(plan.status),
    statusTone: toneOf(PLAN_STATUS_TONE, plan.status),
    nextAction,
  };
}
