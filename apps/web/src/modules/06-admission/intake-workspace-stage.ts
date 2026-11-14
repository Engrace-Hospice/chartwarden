import type {
  PatientResolutionStatus,
  QualificationBlocker,
  ReferralStatus,
} from "./referrals-api";

export type IntakeStepId = "receive" | "verify" | "match" | "review" | "requirements" | "handoff";

export interface IntakeWorkspaceReferral {
  readonly id: string;
  readonly status: ReferralStatus;
  readonly patientResolutionStatus: PatientResolutionStatus;
  readonly convertedAdmissionId: string | null;
  readonly qualificationBlockers: readonly QualificationBlocker[];
}

export interface IntakeWorkspacePresentation {
  readonly activeStepId: IntakeStepId;
  readonly completedStepIds: readonly IntakeStepId[];
  readonly activeStepBlocked: boolean;
  readonly queueLabel: string;
  readonly heading: string;
  readonly guidance: string;
  readonly primaryAction: { readonly label: string; readonly href: string };
  readonly blockers: readonly string[];
}

/** Action-oriented labels derived from, but never persisted over, M6's canonical states. */
export const INTAKE_WORKLIST_LABEL: Record<ReferralStatus, string> = {
  received: "Needs review",
  under_review: "In progress",
  pending_information: "Waiting on information",
  qualified: "Ready to start admission",
  declined: "Completed / closed",
  duplicate: "Completed / closed",
  withdrawn: "Completed / closed",
  converted: "Completed / closed",
};

const detailHref = (id: string, hash = ""): string => `/referrals/${id}${hash}`;

/**
 * Pure presentation mapping. It chooses orientation and links only; M6 remains the sole owner of
 * referral transitions, patient resolution, qualification, conversion, and admission readiness.
 */
export function deriveIntakeWorkspace(
  referral: IntakeWorkspaceReferral,
): IntakeWorkspacePresentation {
  const queueLabel = INTAKE_WORKLIST_LABEL[referral.status];
  const blockers = referral.qualificationBlockers.map((blocker) => blocker.message);

  if (referral.status === "received") {
    return {
      activeStepId: "receive",
      completedStepIds: [],
      // Qualification blockers describe later work; they do not prevent staff from opening review.
      activeStepBlocked: false,
      queueLabel,
      heading: "Review the received referral",
      guidance: "Confirm the referral details and begin the existing review workflow.",
      primaryAction: { label: "Review referral", href: detailHref(referral.id) },
      blockers,
    };
  }

  if (referral.status === "pending_information") {
    return {
      activeStepId: "verify",
      completedStepIds: ["receive"],
      activeStepBlocked: true,
      queueLabel,
      heading: "Waiting for requested information",
      guidance: "Review what is missing, then return the referral to review when it arrives.",
      primaryAction: { label: "Return to referral review", href: detailHref(referral.id) },
      blockers,
    };
  }

  if (referral.status === "under_review") {
    if (
      referral.patientResolutionStatus === "unresolved" ||
      referral.patientResolutionStatus === "possible_match"
    ) {
      return {
        activeStepId: "match",
        completedStepIds: ["receive", "verify"],
        activeStepBlocked: true,
        queueLabel,
        heading: "Resolve the patient identity",
        guidance: "Confirm an existing patient or deliberately create a new patient.",
        primaryAction: {
          label: "Resolve patient match",
          href: detailHref(referral.id, "#patient-resolution"),
        },
        blockers,
      };
    }

    return {
      activeStepId: "review",
      completedStepIds: ["receive", "verify", "match"],
      activeStepBlocked: blockers.length > 0,
      queueLabel,
      heading: blockers.length > 0 ? "Address referral blockers" : "Complete referral review",
      guidance:
        blockers.length > 0
          ? "Use the server-reported reasons below to complete the referral."
          : "The patient is resolved. Review the referral before marking it ready for admission.",
      primaryAction: {
        label: blockers.length > 0 ? "Address review blockers" : "Complete referral review",
        href: detailHref(referral.id, "#referral-readiness"),
      },
      blockers,
    };
  }

  if (referral.status === "qualified") {
    return {
      activeStepId: "handoff",
      completedStepIds: ["receive", "verify", "match", "review"],
      activeStepBlocked: false,
      queueLabel,
      heading: "Review and start the admission",
      guidance:
        "This referral is qualified to start an admission. Admission activation requirements are checked later by the server.",
      primaryAction: {
        label: "Start admission",
        href: detailHref(referral.id, "#start-admission"),
      },
      blockers,
    };
  }

  if (referral.status === "converted" && referral.convertedAdmissionId) {
    return {
      activeStepId: "requirements",
      completedStepIds: ["receive", "verify", "match", "review", "handoff"],
      activeStepBlocked: false,
      queueLabel,
      heading: "Admission started",
      guidance: "Continue in the admission workspace for readiness and activation requirements.",
      primaryAction: {
        label: "View admission",
        href: `/admissions/${referral.convertedAdmissionId}`,
      },
      blockers,
    };
  }

  return {
    activeStepId: "handoff",
    completedStepIds: ["receive"],
    activeStepBlocked: true,
    queueLabel,
    heading: referral.status === "converted" ? "Admission link unavailable" : "Referral closed",
    guidance:
      referral.status === "converted"
        ? "Review referral history while the admission link is unavailable."
        : "This referral cannot advance. Its disposition and activity remain available for review.",
    primaryAction: {
      label: "View referral history",
      href: detailHref(referral.id, "#activity"),
    },
    blockers,
  };
}
