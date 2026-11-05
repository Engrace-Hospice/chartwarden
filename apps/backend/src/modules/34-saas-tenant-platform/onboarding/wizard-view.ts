// apps/backend/src/modules/34-saas-tenant-platform/onboarding/wizard-view.ts — the wizard read model (pure).
//
// One ordered list of steps for both surfaces (platform GET /tenants/:orgSlug/onboarding and tenant GET
// /tenant/onboarding): key, title, owner, sequence, optional, status, `locked` (an earlier gating step is unsettled),
// completion mode, evidence, who/when - plus the overall `currentStepKey` and the go-live state. A step whose tenant has
// no task row yet is shown pending with a null id (it still gates; nothing can act on it until provisioning writes it).
import {
  type GoLiveState,
  attestationExpiresAt,
  evaluateGoLiveGuards,
  goLiveStateOf,
  latestAttestation,
} from "./go-live";
import type {
  CompletionMode,
  GoLiveAttestation,
  StepOwner,
  StepTask,
  StepTemplate,
  TaskStatus,
  TenantRef,
} from "./model";
import { currentStepKey, lockedByStep, orderedTemplates } from "./sequence";

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
    readonly membershipId: string;
    readonly actorKind: "platform_ops" | "tenant";
    readonly at: string;
  } | null;
  readonly assignedToMembershipId: string | null;
  readonly dueAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly blockerReason: string | null;
  readonly skipRationale: string | null;
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
  readonly approvedAt: string | null;
  readonly approvalReason: string | null;
  readonly revokedByMembershipId: string | null;
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
  return {
    id: task?.id ?? null,
    key: template.key,
    title: template.title,
    description: template.description,
    owner: template.owner,
    sequence: template.sequence,
    optional: template.optional,
    status: task?.status ?? "pending",
    locked: lockedBy !== null,
    lockedBy,
    completionMode: template.completionMode,
    evidence: task?.evidenceNote ? { note: task.evidenceNote, ref: task.evidenceRef } : null,
    attestedBy:
      task?.attestedByMembershipId && task.attestedByActorKind && task.attestedAt
        ? {
            membershipId: task.attestedByMembershipId,
            actorKind: task.attestedByActorKind,
            at: task.attestedAt.toISOString(),
          }
        : null,
    assignedToMembershipId: task?.assignedToMembershipId ?? null,
    dueAt: iso(task?.dueAt ?? null),
    startedAt: iso(task?.startedAt ?? null),
    completedAt: iso(task?.completedAt ?? null),
    blockerReason: task?.blockerReason ?? null,
    skipRationale: task?.status === "skipped" ? (task.skipRationale ?? null) : null,
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
    approvedAt: iso(a.approvedAt),
    approvalReason: a.approvalReason,
    revokedByMembershipId: a.revokedByMembershipId,
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
  readonly latestBaa: { readonly baaStatus: string; readonly expiresOn: string | null } | undefined;
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
