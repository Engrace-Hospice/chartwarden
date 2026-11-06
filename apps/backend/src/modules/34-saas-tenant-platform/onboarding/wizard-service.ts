// apps/backend/src/modules/34-saas-tenant-platform/onboarding/wizard-service.ts - the onboarding wizard's operations.
//
// One implementation for both surfaces: the tenant's org_admin / compliance officer (inside the tenant's own org
// transaction) and the platform operator (inside an audited platform transaction). Every rule is enforced HERE,
// server-side, whatever the UI shows:
//   * strict sequence - a step can only be started, completed, attested or skipped when every earlier gating step is
//     done or skipped (sequence.ts); 409 ONBOARDING_STEP_OUT_OF_ORDER;
//   * owner - a tenant actor may only act on a step it owns (`either` = org_admin); a platform operator acts on any;
//   * attestation - a human settles an `attestation` / `either` step with required evidence (evidence.ts); the actor is a
//     human by the route's AI-actor block, and the evidence + who + when are stored on the task (the row audit records it);
//   * re-open - a settled step can be re-opened and edited. It does NOT reset later steps (they keep their state; the lock
//     re-applies to later steps not yet settled; activation re-checks everything). Refused while a go-live attestation is
//     pending, because it would silently invalidate what the officer attested;
//   * two-party go-live - the compliance officer attests, a platform operator approves (go-live.ts).
// After any change that can make an `auto`/`either` step's fact true, the wizard asks the advance sweep to run for that
// tenant (best effort, after commit) so the next step unlocks without waiting for the daily pass.
//
// This file is the factory: it opens the right transaction for each surface and delegates. A step's lifecycle is
// wizard-steps.ts, the officer and the go-live are wizard-go-live.ts, what they share is wizard-core.ts, the contract is
// wizard-types.ts (re-exported here, so importers keep one entry point).
import { normalizeReason } from "./evidence";
import {
  ONBOARDING_STATUS,
  type PlatformActor,
  type StepTask,
  type StepTemplate,
  type TenantActor,
  type TenantRef,
} from "./model";
import { normalizeOrgProfilePatch } from "./org-profile";
import { lockedByStep } from "./sequence";
import { type Loaded, actorMayActOnStep, load, loadTenant, view } from "./wizard-core";
import { requireOnboarding } from "./wizard-core";
import {
  OFFICER_CHANGED_REVOKE_REASON,
  OFFICER_REASON_MAX,
  createGoLiveOperations,
} from "./wizard-go-live";
import { createStepOperations } from "./wizard-steps";
import type {
  OnboardingWizard,
  OnboardingWizardDeps,
  ProfileInput,
  WizardViewWithProfile,
} from "./wizard-types";
import {
  type WizardStepView,
  type WizardView,
  redactStepForTenant,
  redactViewForTenant,
  toWizardStepView,
} from "./wizard-view";

export { actorMayActOnStep };
export type {
  AttestInput,
  ComplianceOfficerRoleBinder,
  OnboardingWizard,
  OnboardingWizardDeps,
  ProfileInput,
  WizardViewWithProfile,
} from "./wizard-types";

export function createOnboardingWizard(deps: OnboardingWizardDeps): OnboardingWizard {
  const now = deps.now ?? (() => new Date());
  const steps = createStepOperations(now);
  const goLive = createGoLiveOperations(deps, now);
  const { attest, skip, reopen, start, block } = steps;
  const {
    ensureOfficerRole,
    undoOfficerRoleBind,
    assignOfficer,
    goLiveAttest,
    goLiveApprove,
    goLiveRevoke,
    revokePending,
    voidSuperseded,
    activateOrganizationAfterApproval,
  } = goLive;

  const stepView = (ctx: Loaded, task: StepTask): WizardStepView => {
    const template = ctx.templates.find((t) => t.key === task.templateKey) as StepTemplate;
    return toWizardStepView(template, task, lockedByStep(ctx.templates, ctx.tasks, template.key));
  };

  async function settle(tenant: {
    tenantAccountId: string;
    organizationId: string;
  }): Promise<void> {
    if (!deps.advance) return;
    try {
      await deps.advance(tenant);
    } catch (error) {
      deps.warn?.("m34.onboarding wizard: advance after change failed", {
        tenantAccountId: tenant.tenantAccountId,
        err: error,
      });
    }
  }

  async function withProfile(ctx: Loaded): Promise<WizardViewWithProfile> {
    const [wizard, orgProfile] = await Promise.all([
      view(ctx, now),
      deps.orgProfile.read(ctx.tenant.organizationId),
    ]);
    return { ...wizard, orgProfile };
  }

  // ── surface adapters ───────────────────────────────────────────────────────────────────────────────────────

  /**
   * The wizard as the tenant may see it. A revocation stays attributed when its revoker is a member of the tenant's own
   * organisation (an org_admin who voided it by reassigning the officer); a platform operator's never does.
   */
  async function forTenant<V extends WizardView>(ctx: Loaded, wizardView: V): Promise<V> {
    const revoker = wizardView.goLive.attestation?.revokedByMembershipId ?? null;
    const revokedByTenantMember =
      revoker !== null && (await ctx.store.loadMember(ctx.tenant.organizationId, revoker)) !== null;
    return redactViewForTenant(wizardView, { revokedByTenantMember });
  }

  /** A platform transaction on one tenant. `actor` is the operator it acts for (every write is attributed to them). */
  const platform = <T>(
    reason: string,
    orgSlug: string,
    fn: (ctx: Loaded) => Promise<T>,
    actor?: PlatformActor,
  ): Promise<T> =>
    deps.runner.inPlatform(
      reason,
      async (store) => fn(await load(store, { orgSlug })),
      actor?.userId,
    );
  const tenantTx = <T>(
    actor: TenantActor,
    organizationId: string,
    fn: (ctx: Loaded) => Promise<T>,
  ): Promise<T> =>
    deps.runner.inTenant(actor, organizationId, async (store) =>
      fn(await load(store, { organizationId })),
    );

  /** Run a step change, then let the sweep settle anything it unlocked. */
  async function changed<T extends { tenant: TenantRef }>(result: T): Promise<T> {
    // Only an onboarding tenant has anything for the sweep to settle (an active one's leftovers would just raise alerts).
    if (result.tenant.status !== ONBOARDING_STATUS) return result;
    await settle({
      tenantAccountId: result.tenant.tenantAccountId,
      organizationId: result.tenant.organizationId,
    });
    return result;
  }
  const stepResult = async (ctx: Loaded, task: StepTask) => ({
    tenant: ctx.tenant,
    view: stepView({ ...ctx, tasks: ctx.tasks.map((t) => (t.id === task.id ? task : t)) }, task),
  });
  /** The same, for a tenant caller: a platform operator's attestation shows as the organisation, not the member. */
  const tenantStepResult = async (ctx: Loaded, task: StepTask) => {
    const result = await stepResult(ctx, task);
    return { ...result, view: redactStepForTenant(result.view) };
  };
  /**
   * The org-profile write, on the TENANT pool as the actor (an operator acts through the tenant's own RLS scope, as the
   * onboarding-data writes do), in ONE transaction: the shared onboarding lock, the status check under it, the write, and the
   * void of a pending go-live attestation the change makes stale. A check made before the transaction could be overtaken by
   * go-live approval (which takes the lock exclusive); this one cannot.
   */
  const profileResult = (
    organizationId: string,
    patch: ProfileInput,
    actor: { readonly userId: string; readonly membershipId: string },
  ) =>
    deps.runner.inTenant(
      { kind: "tenant", userId: actor.userId, membershipId: actor.membershipId, roles: [] },
      organizationId,
      async (store) => {
        await store.lockOnboardingShared(organizationId);
        requireOnboarding(await loadTenant(store, { organizationId }));
        const profile = await store.updateOrgProfile(
          organizationId,
          normalizeOrgProfilePatch(patch),
          actor.userId,
        );
        await store.voidPendingGoLiveForDataChange({
          organizationId,
          revokedByUserId: actor.userId,
          revokedByMembershipId: actor.membershipId,
        });
        return profile;
      },
    );

  return {
    getPlatform: (orgSlug) => platform("platform-ops tenant onboarding read", orgSlug, withProfile),
    attestPlatform: async (orgSlug, taskId, actor, input) =>
      (
        await changed(
          await platform(
            "platform-ops onboarding attest",
            orgSlug,
            async (ctx) => stepResult(ctx, await attest(ctx, actor, taskId, input)),
            actor,
          ),
        )
      ).view,
    skipPlatform: async (orgSlug, taskId, actor, rationale) =>
      (
        await changed(
          await platform(
            "platform-ops onboarding skip",
            orgSlug,
            async (ctx) => stepResult(ctx, await skip(ctx, actor, taskId, rationale)),
            actor,
          ),
        )
      ).view,
    reopenPlatform: async (orgSlug, taskId, actor, reason) =>
      (
        await changed(
          await platform(
            "platform-ops onboarding reopen",
            orgSlug,
            async (ctx) => stepResult(ctx, await reopen(ctx, actor, taskId, reason)),
            actor,
          ),
        )
      ).view,
    setOrgProfilePlatform: async (orgSlug, actor, patch) => {
      const tenant = await deps.runner.inPlatform(
        "platform-ops tenant org profile lookup",
        async (store) => loadTenant(store, { orgSlug }),
      );
      return profileResult(tenant.organizationId, patch, actor);
    },
    setComplianceOfficerPlatform: async (orgSlug, actor, membershipId, reasonInput) => {
      const reason = normalizeReason(reasonInput, { max: OFFICER_REASON_MAX });
      const out = await platform(
        "platform-ops compliance officer assignment",
        orgSlug,
        async (ctx) => {
          const previous = ctx.tenant.complianceOfficerMembershipId;
          const roleBound = await ensureOfficerRole(ctx, actor, membershipId, reason);
          try {
            const assigned = await assignOfficer(ctx, membershipId, actor);
            if (assigned.superseded) {
              await revokePending(ctx, assigned.superseded, actor, OFFICER_CHANGED_REVOKE_REASON);
            }
            // The row trigger names the operator (app.user_id) but cannot say why or who it replaced: one explicit entry.
            await ctx.store.recordPlatformAudit({
              eventType: "m34.onboarding.compliance_officer_assigned",
              tenantAccountId: ctx.tenant.tenantAccountId,
              organizationId: ctx.tenant.organizationId,
              operator: { userId: actor.userId, membershipId: actor.membershipId },
              reason,
              detail: {
                previousOfficerMembershipId: previous,
                newOfficerMembershipId: membershipId,
                roleBoundByOperator: roleBound ? "true" : "false",
              },
            });
            return {
              tenant: ctx.tenant,
              out: { complianceOfficerMembershipId: assigned.complianceOfficerMembershipId },
            };
          } catch (error) {
            // The bind committed on its own transaction; a later failure must not leave that grant behind.
            if (roleBound) await undoOfficerRoleBind(ctx, actor, membershipId, reason);
            throw error;
          }
        },
        actor,
      );
      return (await changed(out)).out;
    },
    approveGoLive: async (orgSlug, actor, reason) => {
      const approved = await platform(
        "platform-ops go-live approval",
        orgSlug,
        async (ctx) => ({
          organizationId: ctx.tenant.organizationId,
          tenantAccountId: ctx.tenant.tenantAccountId,
          wizard: await goLiveApprove(ctx, actor, reason),
        }),
        actor,
      );
      await activateOrganizationAfterApproval(approved, actor, reason.trim());
      return approved.wizard;
    },
    revokeGoLive: async (orgSlug, actor, reason) =>
      platform(
        "platform-ops go-live revoke",
        orgSlug,
        (ctx) => goLiveRevoke(ctx, actor, reason),
        actor,
      ),

    getTenant: (organizationId) =>
      deps.runner.inTenant(
        { kind: "tenant", membershipId: "", userId: "", roles: [] },
        organizationId,
        async (store) => {
          const ctx = await load(store, { organizationId });
          return forTenant(ctx, await withProfile(ctx));
        },
      ),
    startTask: async (actor, organizationId, taskId) =>
      (
        await changed(
          await tenantTx(actor, organizationId, async (ctx) =>
            tenantStepResult(ctx, await start(ctx, actor, taskId)),
          ),
        )
      ).view,
    blockTask: async (actor, organizationId, taskId, reason) =>
      (
        await tenantTx(actor, organizationId, async (ctx) =>
          tenantStepResult(ctx, await block(ctx, actor, taskId, reason)),
        )
      ).view,
    attestTask: async (actor, organizationId, taskId, input) =>
      (
        await changed(
          await tenantTx(actor, organizationId, async (ctx) =>
            tenantStepResult(ctx, await attest(ctx, actor, taskId, input)),
          ),
        )
      ).view,
    reopenTask: async (actor, organizationId, taskId, reason) =>
      (
        await changed(
          await tenantTx(actor, organizationId, async (ctx) =>
            tenantStepResult(ctx, await reopen(ctx, actor, taskId, reason)),
          ),
        )
      ).view,
    setOrgProfile: (actor, organizationId, patch) => profileResult(organizationId, patch, actor),
    setComplianceOfficer: async (actor, organizationId, membershipId) => {
      const done = await tenantTx(actor, organizationId, async (ctx) => ({
        tenant: ctx.tenant,
        assigned: await assignOfficer(ctx, membershipId),
      }));
      if (done.assigned.superseded)
        await voidSuperseded(done.tenant, done.assigned.superseded, actor);
      await changed(done);
      return { complianceOfficerMembershipId: done.assigned.complianceOfficerMembershipId };
    },
    attestGoLive: (actor, organizationId, note) =>
      tenantTx(actor, organizationId, async (ctx) =>
        forTenant(ctx, await goLiveAttest(ctx, actor, note)),
      ),
  };
}
