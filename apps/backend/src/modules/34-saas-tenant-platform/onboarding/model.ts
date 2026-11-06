// apps/backend/src/modules/34-saas-tenant-platform/onboarding/model.ts — the onboarding wizard's vocabulary.
//
// Pure types + constants shared by the sequence rule, the read model, the go-live state machine and the
// store/service pair. Nothing here touches IO. The wizard order lives in `onboarding_task_template`
// (`canonical_order` is the step's `sequence`, `required_role` its `owner`); migration 1327 seeds the ops
// wizard order and this file only NAMES the fields the data carries.

/** The one step the platform settles through the two-party go-live (never by attestation, skip or the sweep). */
export const GO_LIVE_TEMPLATE_KEY = "go_live_checklist_complete";

/** Who may settle a step. `either` = the tenant's org_admin or platform ops. */
export const STEP_OWNERS = ["platform_ops", "org_admin", "compliance_officer", "either"] as const;
export type StepOwner = (typeof STEP_OWNERS)[number];

/**
 * How a step settles.
 *   auto        - the advance sweep settles it from a fact (its precondition DSL); a human cannot.
 *   attestation - a human settles it with evidence; the sweep never does.
 *   either      - the sweep settles it when its fact holds, otherwise a human may attest.
 */
export const COMPLETION_MODES = ["auto", "attestation", "either"] as const;
export type CompletionMode = (typeof COMPLETION_MODES)[number];

export type TaskStatus = "pending" | "in_progress" | "done" | "skipped" | "blocked";

/** One `onboarding_task_template` row, in the wizard's own words. Retired templates are never loaded. */
export interface StepTemplate {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  /** `canonical_order`: the position in the wizard. */
  readonly sequence: number;
  readonly owner: StepOwner;
  readonly completionMode: CompletionMode;
  readonly optional: boolean;
  readonly canonical: boolean;
}

/** One `onboarding_task` row for a tenant. */
export interface StepTask {
  readonly id: string;
  readonly templateKey: string;
  readonly status: TaskStatus;
  readonly assignedToMembershipId: string | null;
  readonly createdAt: Date;
  readonly dueAt: Date | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly blockerReason: string | null;
  readonly evidenceNote: string | null;
  readonly evidenceRef: string | null;
  readonly attestedByMembershipId: string | null;
  readonly attestedByActorKind: "platform_ops" | "tenant" | null;
  readonly attestedAt: Date | null;
  /** The platform-ops skip rationale, when the step was skipped. */
  readonly skipRationale: string | null;
  /** The skip was made by the SYSTEM (a tenant that bills outside ChartWarden), not typed by a person. Absent = false. */
  readonly skippedBySystem?: boolean;
}

/** The membership id the system acts under (the clearinghouse sync's skip and reopen); a person's membership is never this. */
export const SYSTEM_MEMBERSHIP_ID = "system";

/** The two kinds of caller the wizard serves. */
export interface PlatformActor {
  readonly kind: "platform";
  readonly membershipId: string;
  readonly userId: string;
}
export interface TenantActor {
  readonly kind: "tenant";
  readonly membershipId: string;
  readonly userId: string;
  readonly roles: readonly string[];
}
export type WizardActor = PlatformActor | TenantActor;

/** The tenant a wizard call addresses. */
export interface TenantRef {
  readonly tenantAccountId: string;
  readonly organizationId: string;
  readonly orgSlug: string;
  readonly status: string;
  readonly legalBusinessName: string;
  readonly complianceOfficerMembershipId: string | null;
}

export type GoLiveStatus = "pending" | "approved" | "revoked";

/**
 * One `tenant_go_live_attestation` row. Both parties are recorded as a membership AND as the user behind it: a person has
 * a different membership in every organisation (a platform operator can also be invited into the tenant), so the
 * two-person rule compares USERS; the membership ids stay as the audit trail of which hat each one wore.
 */
export interface GoLiveAttestation {
  readonly id: string;
  readonly tenantAccountId: string;
  readonly status: GoLiveStatus;
  readonly attestedByMembershipId: string;
  readonly attestedByUserId: string;
  readonly attestedAt: Date;
  readonly attestationNote: string | null;
  readonly approvedByMembershipId: string | null;
  readonly approvedByUserId: string | null;
  readonly approvedAt: Date | null;
  readonly approvalReason: string | null;
  readonly revokedByMembershipId: string | null;
  /** Always present on a revoked attestation; the membership is only recorded where the revoker had one. */
  readonly revokedByUserId: string | null;
  readonly revokedAt: Date | null;
  readonly revokeReason: string | null;
}

/** The tenant's governing BAA as go-live judges it: its state, its executed document, and who wrote it (NULL = before the columns). */
export interface GoverningBaa {
  readonly baaStatus: string;
  readonly expiresOn: string | null;
  readonly documentId: string | null;
  readonly recordedByUserId: string | null;
  readonly updatedByUserId: string | null;
}

/** A membership of the tenant's organisation as the wizard judges it: who it is, whether it is live, what it may do. */
export interface WizardMember {
  readonly membershipId: string;
  readonly userId: string;
  readonly active: boolean;
  /** Keys of the enabled, unexpired roles the membership holds in the organisation. */
  readonly roleKeys: readonly string[];
}

/** The revoke reason an automatic void records when onboarding data changed after the attestation (8 to 1000 characters, by the table's CHECK). */
export const GO_LIVE_DATA_CHANGED_REVOKE_REASON = "onboarding data changed after attestation";

/** The role that attests go-live readiness, and the only role an assigned compliance officer may be missing none of. */
export const COMPLIANCE_OFFICER_ROLE = "compliance_officer";

/** A tenant status is `onboarding` while the wizard is open. */
export const ONBOARDING_STATUS = "onboarding";
