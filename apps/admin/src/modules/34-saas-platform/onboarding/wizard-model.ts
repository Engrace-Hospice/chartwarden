// apps/admin/src/modules/34-saas-platform/onboarding — the tenant onboarding wizard's decisions as pure functions (what the rail
// shows, which actions a step offers, where "resume" lands). The server owns every rule (strict sequence, owner, evidence, the pending
// go-live attestation); this only decides what to OFFER, so an operator is not handed a button the server is certain to refuse.
import {
  OUTSIDE_SKIP_RATIONALE,
  type StepRailItem,
  defaultStepKey,
  gatingProgress,
  isSettledStep,
  isSystemSkip,
  type operations,
  railItemsOf as railItemsOfForOwners,
} from "@chartwarden/ui";

// The lane-neutral helpers live in @chartwarden/ui (the tenant wizard shares them); re-exported so admin imports keep their path.
export { OUTSIDE_SKIP_RATIONALE, defaultStepKey, gatingProgress, isSystemSkip };

type WizardResponse =
  operations["getApiV1PlatformTenantsByOrgSlugOnboarding"]["responses"][200]["content"]["application/json"];
export type WizardView = WizardResponse;
export type WizardStep = WizardResponse["steps"][number];
export type WizardOwner = WizardStep["owner"];

/** The keys the platform onboarding routes require (onboarding-data-routes.ts, onboarding-wizard-routes.ts). */
export const ONBOARDING_KEYS = {
  manageSteps: "onboarding.manage_platform",
  skipStep: "onboarding.skip",
  onboardingData: "tenant_onboarding_data.write_platform",
  clearinghouseWrite: "tenant_clearinghouse.write_platform",
  clearinghouseVerifyBaa: "tenant_clearinghouse.verify_baa_platform",
  clearinghouseRelease: "tenant_clearinghouse.release_credential_platform",
  noticeWithdraw: "tenant_notice_filing.withdraw_platform",
  baaDocumentUpload: "tenant_baa_document.upload_platform",
  baaRegisterWrite: "platform_tenant_baa.write_platform",
  pricingRead: "subscription.pricing_read_platform",
  pricingWrite: "subscription.onboard_platform",
  goLiveApprove: "go_live.approve_platform",
} as const;

/** The step the platform settles through the two-party approval: never attested, skipped or re-opened by hand. */
export const GO_LIVE_STEP_KEY = "go_live_checklist_complete";

export const OWNER_LABEL: Record<WizardOwner, string> = {
  platform_ops: "Platform operator",
  org_admin: "Tenant admin",
  compliance_officer: "Compliance officer",
  either: "Tenant admin or operator",
};

/** Who skipped a step, in words: the server's `skippedBy` (what the skip recorded), never the rationale's wording. */
export const SKIPPED_BY_LABEL: Record<NonNullable<WizardStep["skippedBy"]>, string> = {
  tenant: "Skipped by the organization",
  platform_ops: "Skipped by ChartWarden operations",
  system: "Skipped by the system",
};

const isSettled = isSettledStep;
const isGating = (s: WizardStep): boolean => s.isCanonical && !s.optional;

function titleOf(view: WizardView, key: string): string {
  return view.steps.find((s) => s.key === key)?.title ?? key;
}

export const railItemsOf = (view: WizardView): StepRailItem[] =>
  railItemsOfForOwners(view, OWNER_LABEL);

export interface StepActions {
  readonly canAttest: boolean;
  readonly canSkip: boolean;
  readonly canReopen: boolean;
  /** Why a re-open is not offered although the step is settled. */
  readonly reopenBlockedBy: "go_live_pending" | null;
  /** Why nothing can be done on this step right now (shown in place of the actions), or null. */
  readonly readOnlyReason: string | null;
}

const NONE: Omit<StepActions, "readOnlyReason" | "reopenBlockedBy"> = {
  canAttest: false,
  canSkip: false,
  canReopen: false,
};

/** True while the wizard's steps can be worked: only an onboarding tenant (provisioning has not opened them, a live tenant closed them). */
export const isOnboardingOpen = (tenantStatus: string): boolean => tenantStatus === "onboarding";

/** Why the step's state (not the operator's role) closes it to work: provisioning, a live tenant, a locked step. Null while it is open. */
export function readOnlyReasonOf(step: WizardStep, view: WizardView): string | null {
  if (!isOnboardingOpen(view.tenantStatus)) {
    if (view.tenantStatus === "provisioning")
      return "This tenant is still provisioning. Steps open when provisioning finishes.";
    if (view.tenantStatus === "active") return "This tenant is live. Onboarding is complete.";
    return `Onboarding is closed for this tenant (${view.tenantStatus}).`;
  }
  if (step.id === null) return "This step is created when provisioning finishes.";
  if (step.locked && !isSettled(step)) {
    return `Finish ${titleOf(view, step.lockedBy ?? "the earlier step")} first.`;
  }
  return null;
}

/**
 * The key a step's own data writes need (its panel's save), where the step has a panel that writes. Without it the step's data is
 * read-only for the operator; the frame's own actions need only their own keys (attest / re-open `onboarding.manage_platform`, skip
 * `onboarding.skip`), as on the server. The go-live step is not here: its panel gates approve / revoke itself and says so.
 */
const STEP_WRITE_KEY: Readonly<Record<string, string>> = {
  account_created: ONBOARDING_KEYS.manageSteps,
  compliance_officer_assigned: ONBOARDING_KEYS.manageSteps,
  plan_contract: ONBOARDING_KEYS.pricingWrite,
  clearinghouse_selected: ONBOARDING_KEYS.clearinghouseWrite,
  // The BAA panel's save is the register write; the agreement upload inside it has its own key (gated on the field).
  baa_executed: ONBOARDING_KEYS.baaRegisterWrite,
  ccn_registered: ONBOARDING_KEYS.onboardingData,
  locations_seeded: ONBOARDING_KEYS.onboardingData,
  mac_configured: ONBOARDING_KEYS.onboardingData,
};
const noRole = (key: string): string =>
  `You can view this step, but your role cannot edit its details (that needs the ${key} permission).`;

/** What the operator may do on a step: the step's state, then the keys `held` (the session's; fail closed when it has none). */
export function stepActionsOf(
  step: WizardStep,
  view: WizardView,
  held: ReadonlySet<string>,
): StepActions {
  const stateReason = readOnlyReasonOf(step, view);
  if (stateReason !== null) return { ...NONE, reopenBlockedBy: null, readOnlyReason: stateReason };
  const dataKey = STEP_WRITE_KEY[step.key];
  const readOnlyReason = dataKey !== undefined && !held.has(dataKey) ? noRole(dataKey) : null;
  if (step.key === GO_LIVE_STEP_KEY) return { ...NONE, reopenBlockedBy: null, readOnlyReason };
  const manage = held.has(ONBOARDING_KEYS.manageSteps);
  if (isSettled(step)) {
    const pending = view.goLive.state === "awaiting_approval";
    return {
      ...NONE,
      canReopen: manage && !pending,
      reopenBlockedBy: pending ? "go_live_pending" : null,
      readOnlyReason,
    };
  }
  return {
    canAttest: manage && step.completionMode !== "auto",
    // The server owns the skippable list and refuses any other skip; the view carries it per step.
    canSkip: step.skippable && held.has(ONBOARDING_KEYS.skipStep),
    canReopen: false,
    reopenBlockedBy: null,
    readOnlyReason,
  };
}
