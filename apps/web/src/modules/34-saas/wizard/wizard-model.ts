// apps/web/src/modules/34-saas/wizard — the tenant onboarding wizard's decisions as pure functions (which actions a step offers to whom,
// and what is said when none is). The server owns every rule (strict sequence, owner, evidence, step-up, the pending go-live
// attestation); this only decides what to OFFER, so the tenant is not handed a button the server is certain to refuse.
import {
  ORG_ADMIN_ROLE,
  STEPS_SETTLED_BY_PANEL,
  type TenantWizardStep,
  type TenantWizardView,
} from "./panel-props";

export type WizardView = TenantWizardView;
export type WizardStep = TenantWizardStep;
export type WizardOwner = WizardStep["owner"];

/** The keys the tenant routes require (routes/tenant/onboarding-tasks.ts, baa.ts, the M2 org-admin and M35 pricing routes). */
export const ONBOARDING_KEYS = {
  readOwn: "onboarding.read_own",
  /** Start, attest and re-open a step. */
  update: "onboarding.update",
  /** Org profile, compliance officer and the tenant skip. */
  manageOwn: "onboarding.manage_own",
  goLiveAttest: "go_live.attest",
  /** Provider entities and locations. */
  orgManage: "org.manage",
  baaRead: "platform_tenant_baa.read_own",
  baaAttest: "platform_tenant_baa.attest",
  pricingRead: "subscription.read",
} as const;

export const ROLE_COMPLIANCE_OFFICER = "compliance_officer";

/** The step the compliance officer settles through the go-live attestation: never attested, skipped or re-opened as an ordinary step. */
export const GO_LIVE_STEP_KEY = "go_live_checklist_complete";

/** Who owns a step, in the tenant's words. */
export const OWNER_LABEL: Record<WizardOwner, string> = {
  platform_ops: "ChartWarden",
  org_admin: "Your administrator",
  compliance_officer: "Your compliance officer",
  either: "Your administrator or ChartWarden",
};

const isSettled = (s: Pick<WizardStep, "status">): boolean =>
  s.status === "done" || s.status === "skipped";

function titleOf(view: WizardView, key: string): string {
  return view.steps.find((s) => s.key === key)?.title ?? key;
}

/** Why the step's state (not the person's role) closes it to work: setup still running, a live organization, a locked step. Null while open. */
export function closedReasonOf(step: WizardStep, view: WizardView): string | null {
  if (view.tenantStatus !== "onboarding") {
    if (view.tenantStatus === "provisioning") {
      return "ChartWarden is still setting up your organization. Steps open when that finishes.";
    }
    if (view.tenantStatus === "active") return "Your organization is live. Onboarding is complete.";
    return "Onboarding is closed for your organization.";
  }
  if (step.id === null) return "ChartWarden creates this step when setup finishes.";
  if (step.locked && !isSettled(step)) {
    return `Finish ${titleOf(view, step.lockedBy ?? "the earlier step")} first.`;
  }
  return null;
}

export interface StepActions {
  readonly canStart: boolean;
  readonly canAttest: boolean;
  /** Skip: only steps 8, 9 and 10, only for the organization's administrator, only where the server says the tenant may. */
  readonly canSkip: boolean;
  readonly canReopen: boolean;
  /** Why a re-open is not offered although the step is settled. */
  readonly reopenBlockedBy: "go_live_pending" | null;
  /** Why a panel's forms are closed (state, not role): setup running, organization live, locked step. Null while open. */
  readonly closedReason: string | null;
  /** Why the frame offers no action (the closed reason, else whose step it is), or null when it offers one or nothing needs saying. */
  readonly readOnlyReason: string | null;
}

const NONE = {
  canStart: false,
  canAttest: false,
  canSkip: false,
  canReopen: false,
  reopenBlockedBy: null,
} as const;

/** The server's owner rule: ChartWarden steps are never the tenant's; an `org_admin` or `either` step needs the org_admin role; a compliance-officer step that role. */
function ownerRefusal(owner: WizardOwner, roles: ReadonlySet<string>): string | null {
  if (owner === "platform_ops") return "ChartWarden completes this step. You can follow it here.";
  if (owner === "compliance_officer") {
    return roles.has(ROLE_COMPLIANCE_OFFICER)
      ? null
      : "Only your compliance officer can complete this step.";
  }
  return roles.has(ORG_ADMIN_ROLE)
    ? null
    : "Only your organization's administrator can complete this step.";
}

const NO_KEY = "You can read this step, but your role cannot change it.";

/** What the signed-in person may do on a step: the step's state, then the owner rule, then the keys `held` (the session's; fail closed). */
export function stepActionsOf(
  step: WizardStep,
  view: WizardView,
  held: ReadonlySet<string>,
  roles: Iterable<string>,
): StepActions {
  const closedReason = closedReasonOf(step, view);
  if (closedReason !== null) return { ...NONE, closedReason, readOnlyReason: closedReason };
  if (step.key === GO_LIVE_STEP_KEY) return { ...NONE, closedReason: null, readOnlyReason: null };

  const roleSet = new Set(roles);
  const refusal = ownerRefusal(step.owner, roleSet);
  if (refusal !== null) return { ...NONE, closedReason: null, readOnlyReason: refusal };
  const mayUpdate = held.has(ONBOARDING_KEYS.update);

  if (isSettled(step)) {
    const pending = view.goLive.state === "awaiting_approval";
    return {
      ...NONE,
      canReopen: mayUpdate && !pending,
      reopenBlockedBy: mayUpdate && pending ? "go_live_pending" : null,
      closedReason: null,
      readOnlyReason: mayUpdate ? null : NO_KEY,
    };
  }
  const canSkip =
    step.tenantSkippable &&
    !step.locked &&
    step.isCanonical &&
    step.owner === "either" &&
    roleSet.has(ORG_ADMIN_ROLE) &&
    held.has(ONBOARDING_KEYS.manageOwn);
  // A step whose own panel settles it (choosing a clearinghouse) is never marked done by hand: that would settle it without the choice.
  const canAttest =
    mayUpdate && step.completionMode !== "auto" && !STEPS_SETTLED_BY_PANEL.has(step.key);
  const canStart = mayUpdate && step.status === "pending";
  return {
    ...NONE,
    canStart,
    canAttest,
    canSkip,
    closedReason: null,
    readOnlyReason:
      canStart || canAttest || canSkip || step.completionMode === "auto" ? null : NO_KEY,
  };
}
