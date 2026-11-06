// apps/backend/src/modules/34-saas-tenant-platform/onboarding/wizard-go-live.ts - the compliance officer and the two-party
// go-live: who may be the officer, the officer's attestation, the platform approval (which opens the organization) and the
// voiding of an attestation that no longer holds. Runs against ONE open store transaction the caller supplies.
import { ChartWardenError } from "@chartwarden/types";
import { normalizeOptionalNote, normalizeReason } from "./evidence";
import {
  assertAttesterStillValid,
  assertCanApprove,
  assertCanAttest,
  assertCanRevoke,
  assertGuardsPass,
  evaluateGoLiveGuards,
} from "./go-live";
import {
  COMPLIANCE_OFFICER_ROLE,
  GO_LIVE_TEMPLATE_KEY,
  type GoLiveAttestation,
  ONBOARDING_STATUS,
  type PlatformActor,
  type TenantActor,
  type TenantRef,
  type WizardMember,
} from "./model";
import {
  type Loaded,
  conflict,
  isPlatformStaffMember,
  load,
  platformStaffRefusal,
  refuse,
  view,
} from "./wizard-core";
import type { TaskPatch } from "./wizard-store";
import type { OnboardingWizardDeps } from "./wizard-types";
import type { WizardView } from "./wizard-view";

/** Recorded as the revoke reason of an attestation the officer reassignment superseded. */
export const OFFICER_CHANGED_REVOKE_REASON =
  "the compliance officer was reassigned, so the earlier officer's go-live attestation was voided";

/** The platform operator's reason for assigning an organisation's compliance officer. */
export const OFFICER_REASON_MAX = 500;

/**
 * The tenant states in which the compliance officer may be changed. An officer legitimately changes after go-live (staff
 * turnover), so `active` is allowed alongside `onboarding`; a suspended, closing or destroyed tenant is frozen. Migration
 * 1328's UPDATE policy enforces the same pair.
 */
const OFFICER_CHANGEABLE_STATUSES: readonly string[] = [ONBOARDING_STATUS, "active"];

/**
 * The only tenant state in which the platform route may BIND the role: the first designation, while the tenant is onboarding.
 * (`provisioning` would qualify by name, but an officer cannot be assigned before onboarding, so binding there would leave a
 * stray grant.) Once the tenant is live, the platform route needs the member to hold the role already.
 */
const OFFICER_ROLE_BINDABLE_STATUS = ONBOARDING_STATUS;

export function createGoLiveOperations(deps: OnboardingWizardDeps, now: () => Date) {
  const viewOf = (ctx: Loaded): Promise<WizardView> => view(ctx, now);

  /**
   * The member may be the officer only when they are the customer's own staff: not ChartWarden platform staff (audience-bound
   * in this tenant or a platform role holder at home) and not the platform operator making the assignment.
   */
  async function assertMayBeOfficer(
    ctx: Loaded,
    member: WizardMember,
    operator: PlatformActor | undefined,
  ): Promise<void> {
    if (
      (operator !== undefined && member.userId === operator.userId) ||
      (await isPlatformStaffMember(ctx.store, member))
    ) {
      throw platformStaffRefusal("be the compliance officer");
    }
  }

  /**
   * Platform route only: gives an active member the `compliance_officer` role when they lack it, while the tenant is
   * onboarding. Every other case returns false and leaves the decision to `assignOfficer` (which refuses a stranger, an
   * inactive member, a locked tenant, or a member without the role). The bind commits first, on its own transaction, so a
   * later failure leaves at most a grant to the member the operator chose, which the audit trail records.
   */
  async function ensureOfficerRole(
    ctx: Loaded,
    actor: PlatformActor,
    membershipId: string,
    reason: string,
  ): Promise<boolean> {
    if (!deps.bindComplianceOfficerRole || ctx.tenant.status !== OFFICER_ROLE_BINDABLE_STATUS) {
      return false;
    }
    const member = await ctx.store.loadMember(ctx.tenant.organizationId, membershipId);
    if (!member?.active) return false;
    // Before any grant: platform staff (or the operator themselves) never receive the role.
    await assertMayBeOfficer(ctx, member, actor);
    if (member.roleKeys.includes(COMPLIANCE_OFFICER_ROLE)) return false;
    await deps.bindComplianceOfficerRole({
      organizationId: ctx.tenant.organizationId,
      tenantAccountId: ctx.tenant.tenantAccountId,
      membershipId,
      operator: actor,
      reason,
    });
    return true;
  }

  /**
   * Sets the tenant's compliance officer. Returns the pending go-live attestation the change makes stale (an attestation is
   * the previous officer's statement), for the caller to revoke: a platform caller does it in this same transaction, a
   * tenant caller cannot (the tenant role may not write the table) and hands it to a platform transaction after commit.
   */
  async function assignOfficer(
    ctx: Loaded,
    membershipId: string,
    operator?: PlatformActor,
  ): Promise<{ complianceOfficerMembershipId: string; superseded: GoLiveAttestation | null }> {
    if (!OFFICER_CHANGEABLE_STATUSES.includes(ctx.tenant.status)) {
      throw refuse(
        "COMPLIANCE_OFFICER_LOCKED",
        "the compliance officer can only be changed while the tenant is onboarding or active",
        409,
      );
    }
    const member = await ctx.store.loadMember(ctx.tenant.organizationId, membershipId);
    if (!member?.active) {
      throw refuse(
        "COMPLIANCE_OFFICER_NOT_A_MEMBER",
        "the compliance officer must be an active member of this organization",
        422,
      );
    }
    await assertMayBeOfficer(ctx, member, operator);
    if (!member.roleKeys.includes(COMPLIANCE_OFFICER_ROLE)) {
      throw refuse(
        "COMPLIANCE_OFFICER_LACKS_ROLE",
        "the compliance officer must hold the compliance_officer role",
        422,
      );
    }
    const pending = (await ctx.store.listGoLive(ctx.tenant)).find((a) => a.status === "pending");
    await ctx.store.setComplianceOfficer(ctx.tenant.tenantAccountId, membershipId);
    return {
      complianceOfficerMembershipId: membershipId,
      superseded: pending && pending.attestedByMembershipId !== membershipId ? pending : null,
    };
  }

  // ── go-live ────────────────────────────────────────────────────────────────────────────────────────────────

  async function goLiveAttest(
    ctx: Loaded,
    actor: TenantActor,
    note: string | undefined,
  ): Promise<WizardView> {
    if (!actor.roles.includes("compliance_officer")) {
      throw refuse(
        "GO_LIVE_NOT_COMPLIANCE_OFFICER",
        "only the tenant's compliance officer may attest go-live readiness",
        403,
      );
    }
    if (await isPlatformStaffMember(ctx.store, { userId: actor.userId, roleKeys: actor.roles })) {
      throw platformStaffRefusal("attest go-live readiness");
    }
    const attestationNote = normalizeOptionalNote(note);
    const attestations = await ctx.store.listGoLive(ctx.tenant);
    assertCanAttest({
      tenantStatus: ctx.tenant.status,
      templates: ctx.templates,
      tasks: ctx.tasks,
      attestations,
      assignedOfficer: ctx.tenant.complianceOfficerMembershipId,
      actorMembershipId: actor.membershipId,
      now: now(),
    });
    const latestBaa = await ctx.store.latestBaa(ctx.tenant.tenantAccountId);
    assertGuardsPass(
      evaluateGoLiveGuards({ templates: ctx.templates, tasks: ctx.tasks, latestBaa, today: now() }),
      ctx.templates,
      ctx.tasks,
    );
    await ctx.store.insertGoLive({
      organizationId: ctx.tenant.organizationId,
      tenantAccountId: ctx.tenant.tenantAccountId,
      attestedByMembershipId: actor.membershipId,
      attestedByUserId: actor.userId,
      attestationNote,
    });
    const goLiveTask = ctx.tasks.find((t) => t.templateKey === GO_LIVE_TEMPLATE_KEY);
    const patch: TaskPatch = {
      status: "in_progress",
      startedAt: goLiveTask?.startedAt ?? now(),
      blockerReason: null,
    };
    const updated =
      goLiveTask && (goLiveTask.status === "pending" || goLiveTask.status === "blocked")
        ? await ctx.store.updateTask(goLiveTask.id, goLiveTask.status, patch)
        : goLiveTask;
    return viewOf({
      ...ctx,
      tasks: ctx.tasks.map((t) => (updated && t.id === updated.id ? updated : t)),
    });
  }

  async function goLiveApprove(
    ctx: Loaded,
    actor: PlatformActor,
    reasonInput: string,
  ): Promise<WizardView> {
    const reason = normalizeReason(reasonInput);
    const attestations = await ctx.store.listGoLive(ctx.tenant);
    const pending = assertCanApprove({
      tenantStatus: ctx.tenant.status,
      attestations,
      approver: { membershipId: actor.membershipId, userId: actor.userId },
      now: now(),
    });
    // The attestation is the officer's statement: it only counts while that officer is still active, still holds the
    // role and is still the assigned officer. Judged against the membership as it is at this instant.
    const attester = await ctx.store.loadMember(
      ctx.tenant.organizationId,
      pending.attestedByMembershipId,
    );
    assertAttesterStillValid({
      pending,
      attester,
      assignedOfficer: ctx.tenant.complianceOfficerMembershipId,
      attesterIsPlatformStaff: attester ? await isPlatformStaffMember(ctx.store, attester) : false,
    });
    const latestBaa = await ctx.store.latestBaa(ctx.tenant.tenantAccountId);
    const guards = evaluateGoLiveGuards({
      templates: ctx.templates,
      tasks: ctx.tasks,
      latestBaa,
      today: now(),
    });
    assertGuardsPass(guards, ctx.templates, ctx.tasks);

    const settled = await ctx.store.settleGoLive(ctx.tenant.organizationId, pending.id, {
      status: "approved",
      approvedByMembershipId: actor.membershipId,
      approvedByUserId: actor.userId,
      approvalReason: reason,
    });
    if (!settled)
      throw refuse("GO_LIVE_NOT_ATTESTED", "the go-live attestation is no longer pending", 409);
    const at = now();
    const goLiveTask = ctx.tasks.find((t) => t.templateKey === GO_LIVE_TEMPLATE_KEY);
    if (goLiveTask) {
      const done = await ctx.store.updateTask(goLiveTask.id, goLiveTask.status, {
        status: "done",
        startedAt: goLiveTask.startedAt ?? at,
        completedAt: at,
        blockerReason: null,
        evidenceNote: reason,
        evidenceRef: pending.id,
        attestedByMembershipId: actor.membershipId,
        attestedByActorKind: "platform_ops",
        attestedAt: at,
        completionEvidence: {
          ...(await ctx.store.getCompletionEvidence(goLiveTask.id)),
          goLive: {
            attestationId: pending.id,
            attestedByMembershipId: pending.attestedByMembershipId,
            attestedByUserId: pending.attestedByUserId,
            approvedByMembershipId: actor.membershipId,
            approvedByUserId: actor.userId,
          },
        },
      });
      if (!done) throw conflict();
    }
    await ctx.store.activate({
      tenant: ctx.tenant,
      actor,
      reason,
      tasksCompleted: guards.tasksCompleted,
      tasksSkipped: guards.tasksSkipped,
    });
    const fresh = await load(ctx.store, { organizationId: ctx.tenant.organizationId });
    return viewOf(fresh);
  }

  /** Revokes `pending` and puts an in-flight go-live step back to pending. The one place an attestation is voided. */
  async function revokePending(
    ctx: Loaded,
    pending: GoLiveAttestation,
    revokedByMembershipId: string,
    revokeReason: string,
  ): Promise<boolean> {
    const settled = await ctx.store.settleGoLive(ctx.tenant.organizationId, pending.id, {
      status: "revoked",
      revokedByMembershipId,
      revokeReason,
    });
    if (!settled) return false;
    const goLiveTask = ctx.tasks.find((t) => t.templateKey === GO_LIVE_TEMPLATE_KEY);
    if (goLiveTask?.status === "in_progress") {
      await ctx.store.updateTask(goLiveTask.id, "in_progress", {
        status: "pending",
        startedAt: null,
      });
    }
    return true;
  }

  async function goLiveRevoke(
    ctx: Loaded,
    actor: PlatformActor,
    reasonInput: string,
  ): Promise<WizardView> {
    const reason = normalizeReason(reasonInput);
    const pending = assertCanRevoke({
      tenantStatus: ctx.tenant.status,
      attestations: await ctx.store.listGoLive(ctx.tenant),
    });
    if (!(await revokePending(ctx, pending, actor.membershipId, reason))) {
      throw refuse("GO_LIVE_NOT_ATTESTED", "the go-live attestation is no longer pending", 409);
    }
    return viewOf(await load(ctx.store, { organizationId: ctx.tenant.organizationId }));
  }

  /**
   * A tenant session cannot write the attestation table, so voiding the attestation a reassignment superseded runs on a
   * platform transaction, attributed to the org_admin who reassigned. It is hygiene, not the guard: approval re-checks the
   * attester against the live officer, so a failed void is logged and never lets a stale attestation through.
   */
  async function voidSuperseded(
    tenant: TenantRef,
    superseded: GoLiveAttestation,
    actor: TenantActor,
  ): Promise<void> {
    try {
      await deps.runner.inPlatform(
        "system: void go-live attestation after compliance officer change",
        async (store) =>
          revokePending(
            await load(store, { organizationId: tenant.organizationId }),
            superseded,
            actor.membershipId,
            OFFICER_CHANGED_REVOKE_REASON,
          ),
        actor.userId,
      );
    } catch (error) {
      deps.warn?.("m34.onboarding wizard: voiding the superseded go-live attestation failed", {
        tenantAccountId: tenant.tenantAccountId,
        attestationId: superseded.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The approval has committed: the tenant is live. Now open its organization. A failure must not look like success (the
   * organization would stay on the onboarding allowlist), so it is a typed error that names the recovery; the tenant stays live
   * and the manual platform route (`POST /api/v1/platform/organizations/:id/status {event: activate}`) finishes the job.
   */
  async function activateOrganizationAfterApproval(
    approved: { organizationId: string; tenantAccountId: string },
    operator: PlatformActor,
    reason: string,
  ): Promise<void> {
    if (!deps.activateOrganization) return;
    try {
      await deps.activateOrganization({
        organizationId: approved.organizationId,
        operator,
        reason,
      });
    } catch (error) {
      deps.warn?.("m34.onboarding wizard: organization activation after go-live approval failed", {
        tenantAccountId: approved.tenantAccountId,
        organizationId: approved.organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw refuse(
        "ORGANIZATION_ACTIVATION_FAILED",
        `the tenant is live but its organization could not be activated; retry POST /api/v1/platform/organizations/${approved.organizationId}/status with {"event":"activate"}`,
        500,
      );
    }
  }

  return {
    ensureOfficerRole,
    assignOfficer,
    goLiveAttest,
    goLiveApprove,
    revokePending,
    goLiveRevoke,
    voidSuperseded,
    activateOrganizationAfterApproval,
  };
}
