// apps/backend/src/modules/34-saas-tenant-platform/onboarding/wizard-view.ts — the wizard read model (pure).
//
// One ordered list of steps for both surfaces (platform GET /tenants/:orgSlug/onboarding and tenant GET
// /tenant/onboarding): key, title, owner, sequence, optional, status, `locked` (an earlier gating step is unsettled),
// completion mode, evidence, who/when - plus the overall `currentStepKey` and the go-live state. A step whose tenant has
// no task row yet is shown pending with a null id (it still gates; nothing can act on it until provisioning writes it).
import type { ActivationGuardInput } from "../routes/platform/activation-guards";
import {
  type GoLiveState,
  attestationExpiresAt,
  evaluateGoLiveGuards,
  goLiveStateOf,
  latestAttestation,
} from "./go-live";
import {
  type CompletionMode,
  type GoLiveAttestation,
  type SkipActorKind,
  type StepOwner,
  type StepTask,
  type StepTemplate,
  type TaskStatus,
  type TenantRef,
  isSkippableStep,
  isTenantSkippableStep,
} from "./model";
import { currentStepKey, isSettled, lockedByStep, orderedTemplates } from "./sequence";

export interface WizardStepView {
  /** The task id; null when the tenant has no task row for this template yet. */
  readonly id: string | null;
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly owner: StepOwner;
  readonly sequence: number;
  readonly optional: boolean;
  readonly status: TaskStatus;
  /** An earlier gating step is not done or skipped, so this one cannot be started, completed or attested yet. */
  readonly locked: boolean;
  readonly lockedBy: string | null;
  readonly completionMode: CompletionMode;
  readonly evidence: { readonly note: string; readonly ref: string | null } | null;
  readonly attestedBy: {
    /** Null on the tenant surface when the attester is a ChartWarden operator (see `label`). */
    readonly membershipId: string | null;
    readonly actorKind: "platform_ops" | "tenant";
    /** The organisation to show instead of a person's id; only the tenant surface sets it, for a platform operator. */
    readonly label: string | null;
    readonly at: string;
  } | null;
  readonly assignedToMembershipId: string | null;
  readonly dueAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly blockerReason: string | null;
  readonly skipRationale: string | null;
  /** A skip may settle this step (`isSkippableStep`: a non-canonical catalog step added by platform ops, or on `SKIPPABLE_STEP_KEYS`); the server refuses a skip on any other with ONBOARDING_STEP_NOT_SKIPPABLE. */
  readonly skippable: boolean;
  /** The skip was made by the system (the tenant bills outside ChartWarden), not typed by a person: read this, never the rationale text. */
  readonly systemSkipped: boolean;
  /**
   * Who settled the step by skipping it, as the skip recorded it: the `system` (billing outside ChartWarden), the `tenant`'s own org_admin
   * or a `platform_ops` operator; null when the step is not skipped. Read this, never the rationale text. (`systemSkipped` stays for older clients.)
   */
  readonly skippedBy: SkipActorKind | null;
  /**
   * What the tenant surface shows in place of who skipped: the organization's own for its skip, "ChartWarden operations" for an
   * operator's, never a person or a membership. Null on the platform surface and for a system skip.
   */
  readonly skippedByLabel: string | null;
  /**
   * The tenant's own org_admin may skip this step now: it is one of the three (MAC credentials, payer enrollment, DoseSpot kickoff), it
   * is not settled yet, no earlier gating step still locks it (`locked` is false) and the viewer is an org_admin (the platform surface,
   * which has no tenant viewer, reports the step alone); else the skip is refused (409 ONBOARDING_STEP_NOT_TENANT_SKIPPABLE for another
   * step, 409 ONBOARDING_STEP_OUT_OF_ORDER for a locked one).
   */
  readonly tenantSkippable: boolean;
  readonly createdAt: string | null;
  // The names the first onboarding screens already read (kept so they do not break).
  readonly templateKey: string;
  readonly isCanonical: boolean;
  readonly canonicalOrder: number;
}

export interface GoLiveAttestationView {
  readonly id: string;
  readonly status: GoLiveAttestation["status"];
  readonly attestedByMembershipId: string;
  readonly attestedAt: string;
  /** A pending attestation can be approved until this instant; null once it is approved or revoked. */
  readonly expiresAt: string | null;
  readonly attestationNote: string | null;
  readonly approvedByMembershipId: string | null;
  /** Set instead of the membership on the tenant surface (the approver is always a ChartWarden operator). */
  readonly approvedByLabel: string | null;
  readonly approvedAt: string | null;
  readonly approvalReason: string | null;
  readonly revokedByMembershipId: string | null;
  /** Set instead of the membership on the tenant surface when an operator revoked it. */
  readonly revokedByLabel: string | null;
  readonly revokedAt: string | null;
  readonly revokeReason: string | null;
}

export interface GoLiveView {
  readonly state: GoLiveState;
  /** The most recent attestation of any status. */
  readonly attestation: GoLiveAttestationView | null;
  /** The activation guards that would fail if approval ran now (only meaningful once every earlier step is settled). */
  readonly failedGuards: readonly string[];
  readonly complianceOfficerMembershipId: string | null;
}

export interface WizardView {
  readonly tenantAccountId: string;
  readonly orgSlug: string;
  readonly tenantStatus: string;
  readonly currentStepKey: string | null;
  readonly steps: readonly WizardStepView[];
  readonly goLive: GoLiveView;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toWizardStepView(
  template: StepTemplate,
  task: StepTask | undefined,
  lockedBy: string | null,
): WizardStepView {
  const status = task?.status ?? "pending";
  // A skipped task whose store did not say who skipped it predates the actor kind: an operator's (a tenant could not skip yet).
  const skippedBy = status === "skipped" ? (task?.skippedByActorKind ?? "platform_ops") : null;
  return {
    id: task?.id ?? null,
    key: template.key,
    title: template.title,
    description: template.description,
    owner: template.owner,
    sequence: template.sequence,
    optional: template.optional,
    status,
    locked: lockedBy !== null,
    lockedBy,
    completionMode: template.completionMode,
    evidence: task?.evidenceNote ? { note: task.evidenceNote, ref: task.evidenceRef } : null,
    attestedBy:
      task?.attestedByMembershipId && task.attestedByActorKind && task.attestedAt
        ? {
            membershipId: task.attestedByMembershipId,
            actorKind: task.attestedByActorKind,
            label: null,
            at: task.attestedAt.toISOString(),
          }
        : null,
    assignedToMembershipId: task?.assignedToMembershipId ?? null,
    dueAt: iso(task?.dueAt ?? null),
    startedAt: iso(task?.startedAt ?? null),
    completedAt: iso(task?.completedAt ?? null),
    blockerReason: task?.blockerReason ?? null,
    skipRationale: task?.status === "skipped" ? (task.skipRationale ?? null) : null,
    systemSkipped: skippedBy === "system",
    skippedBy,
    skippedByLabel: null,
    skippable: isSkippableStep(template),
    tenantSkippable: isTenantSkippableStep(template) && !isSettled(status) && lockedBy === null,
    createdAt: iso(task?.createdAt ?? null),
    templateKey: template.key,
    isCanonical: template.canonical,
    canonicalOrder: template.sequence,
  };
}

function toAttestationView(a: GoLiveAttestation): GoLiveAttestationView {
  return {
    id: a.id,
    status: a.status,
    attestedByMembershipId: a.attestedByMembershipId,
    attestedAt: a.attestedAt.toISOString(),
    expiresAt: a.status === "pending" ? attestationExpiresAt(a).toISOString() : null,
    attestationNote: a.attestationNote,
    approvedByMembershipId: a.approvedByMembershipId,
    approvedByLabel: null,
    approvedAt: iso(a.approvedAt),
    approvalReason: a.approvalReason,
    revokedByMembershipId: a.revokedByMembershipId,
    revokedByLabel: null,
    revokedAt: iso(a.revokedAt),
    revokeReason: a.revokeReason,
  };
}

const FAILED_GUARD_NAMES = [
  "canonicalTasksComplete",
  "baaExecuted",
  "baaExpiryClearsNinetyDays",
] as const;

export function buildWizardView(input: {
  readonly tenant: TenantRef;
  readonly templates: readonly StepTemplate[];
  readonly tasks: readonly StepTask[];
  readonly attestations: readonly GoLiveAttestation[];
  readonly latestBaa: ActivationGuardInput["latestBaa"];
  readonly today: Date;
}): WizardView {
  const { tenant, templates, tasks, attestations } = input;
  const taskByKey = new Map(tasks.map((t) => [t.templateKey, t]));
  const steps = orderedTemplates(templates).map((template) =>
    toWizardStepView(
      template,
      taskByKey.get(template.key),
      lockedByStep(templates, tasks, template.key),
    ),
  );
  const state = goLiveStateOf({ tenantStatus: tenant.status, templates, tasks, attestations });
  const guards = evaluateGoLiveGuards({
    templates,
    tasks,
    latestBaa: input.latestBaa,
    today: input.today,
  });
  const reviewable = state === "awaiting_attestation" || state === "awaiting_approval";
  const latest = latestAttestation(attestations);
  return {
    tenantAccountId: tenant.tenantAccountId,
    orgSlug: tenant.orgSlug,
    tenantStatus: tenant.status,
    currentStepKey: currentStepKey(templates, tasks),
    steps,
    goLive: {
      state,
      attestation: latest ? toAttestationView(latest) : null,
      failedGuards: reviewable ? FAILED_GUARD_NAMES.filter((name) => !guards[name]) : [],
      complianceOfficerMembershipId: tenant.complianceOfficerMembershipId,
    },
  };
}

/** What a tenant is shown in place of a ChartWarden operator: the organisation, never a person or a membership. */
export const PLATFORM_OPERATOR_LABEL = "ChartWarden operations";

/** What a tenant is shown for a skip of its own. */
export const TENANT_OWN_LABEL = "Your organization";

/** The tenant surface's own judgement of who the viewer is: the roles the session holds in the organization. */
export interface TenantViewer {
  readonly roles: readonly string[];
}

/**
 * A step as the tenant sees it: a platform operator's attestation or skip names the organisation and the time, never the member, and
 * the tenant's own skip is the organization's. `tenantSkippable` is the step's own flag narrowed to what THIS viewer may do (the
 * org_admin, by the same rule `actorMayActOnStep` applies); a viewer the caller does not name may do nothing.
 */
export function redactStepForTenant(step: WizardStepView, viewer: TenantViewer): WizardStepView {
  const skippedByLabel =
    step.skippedBy === "platform_ops"
      ? PLATFORM_OPERATOR_LABEL
      : step.skippedBy === "tenant"
        ? TENANT_OWN_LABEL
        : null;
  const redacted: WizardStepView = {
    ...step,
    skippedByLabel,
    tenantSkippable: step.tenantSkippable && viewer.roles.includes("org_admin"),
  };
  if (!step.attestedBy || step.attestedBy.actorKind !== "platform_ops") return redacted;
  return {
    ...redacted,
    attestedBy: { ...step.attestedBy, membershipId: null, label: PLATFORM_OPERATOR_LABEL },
  };
}

/**
 * The wizard as the tenant sees it. The approver of a go-live is always a platform operator, so it is always redacted; a
 * revocation is redacted unless the revoker is a member of the tenant's own organisation (an org_admin who voided an
 * attestation by reassigning the officer is the tenant's own person). Reasons and times are kept.
 */
export function redactViewForTenant<V extends WizardView>(
  view: V,
  opts: { readonly revokedByTenantMember: boolean; readonly viewer: TenantViewer },
): V {
  const attestation = view.goLive.attestation;
  return {
    ...view,
    steps: view.steps.map((step) => redactStepForTenant(step, opts.viewer)),
    goLive: {
      ...view.goLive,
      attestation: attestation && {
        ...attestation,
        approvedByMembershipId: null,
        approvedByLabel: attestation.approvedByMembershipId ? PLATFORM_OPERATOR_LABEL : null,
        revokedByMembershipId: opts.revokedByTenantMember
          ? attestation.revokedByMembershipId
          : null,
        revokedByLabel:
          attestation.revokedByMembershipId && !opts.revokedByTenantMember
            ? PLATFORM_OPERATOR_LABEL
            : null,
      },
    },
  };
}
