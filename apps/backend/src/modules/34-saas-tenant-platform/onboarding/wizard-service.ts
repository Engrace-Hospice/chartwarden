// apps/backend/src/modules/34-saas-tenant-platform/onboarding/wizard-service.ts — the onboarding wizard's operations.
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
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import {
  SKIP_RATIONALE_MAX,
  normalizeBlockerReason,
  normalizeEvidence,
  normalizeOptionalNote,
  normalizeReason,
} from "./evidence";
import {
  assertCanApprove,
  assertCanAttest,
  assertCanRevoke,
  assertGuardsPass,
  evaluateGoLiveGuards,
} from "./go-live";
import {
  GO_LIVE_TEMPLATE_KEY,
  ONBOARDING_STATUS,
  type PlatformActor,
  type StepOwner,
  type StepTask,
  type StepTemplate,
  type TenantActor,
  type TenantRef,
  type WizardActor,
} from "./model";
import { type OrgProfile, type OrgProfilePort, normalizeOrgProfilePatch } from "./org-profile";
import { assertStepActionable, isSettled } from "./sequence";
import { lockedByStep } from "./sequence";
import type { TaskPatch, WizardRunner, WizardStore } from "./wizard-store";
import {
  type WizardStepView,
  type WizardView,
  buildWizardView,
  toWizardStepView,
} from "./wizard-view";

export interface OnboardingWizardDeps {
  readonly runner: WizardRunner;
  readonly orgProfile: OrgProfilePort;
  /** Runs the advance sweep for one tenant after a change (best effort; a failure never fails the change). */
  readonly advance?: (tenant: { tenantAccountId: string; organizationId: string }) => Promise<void>;
  readonly warn?: (message: string, context: Record<string, string>) => void;
  readonly now?: () => Date;
}

export interface WizardViewWithProfile extends WizardView {
  readonly orgProfile: OrgProfile | null;
}

export interface OnboardingWizard {
  // ── platform surface (addressed by org slug; the actor is a platform operator) ─────────────────────────────
  getPlatform(orgSlug: string): Promise<WizardViewWithProfile>;
  attestPlatform(
    orgSlug: string,
    taskId: string,
    actor: PlatformActor,
    input: AttestInput,
  ): Promise<WizardStepView>;
  skipPlatform(
    orgSlug: string,
    taskId: string,
    actor: PlatformActor,
    rationale: string,
  ): Promise<WizardStepView>;
  reopenPlatform(
    orgSlug: string,
    taskId: string,
    actor: PlatformActor,
    reason: string,
  ): Promise<WizardStepView>;
  setOrgProfilePlatform(
    orgSlug: string,
    actor: PlatformActor,
    patch: ProfileInput,
  ): Promise<OrgProfile>;
  setComplianceOfficerPlatform(
    orgSlug: string,
    actor: PlatformActor,
    membershipId: string,
  ): Promise<{ complianceOfficerMembershipId: string }>;
  approveGoLive(orgSlug: string, actor: PlatformActor, reason: string): Promise<WizardView>;
  revokeGoLive(orgSlug: string, actor: PlatformActor, reason: string): Promise<WizardView>;
  // ── tenant surface (the actor's own org) ───────────────────────────────────────────────────────────────────
  getTenant(organizationId: string): Promise<WizardViewWithProfile>;
  startTask(actor: TenantActor, organizationId: string, taskId: string): Promise<WizardStepView>;
  blockTask(
    actor: TenantActor,
    organizationId: string,
    taskId: string,
    blockerReason: string,
  ): Promise<WizardStepView>;
  attestTask(
    actor: TenantActor,
    organizationId: string,
    taskId: string,
    input: AttestInput,
  ): Promise<WizardStepView>;
  reopenTask(
    actor: TenantActor,
    organizationId: string,
    taskId: string,
    reason: string | undefined,
  ): Promise<WizardStepView>;
  setOrgProfile(
    actor: TenantActor,
    organizationId: string,
    patch: ProfileInput,
  ): Promise<OrgProfile>;
  setComplianceOfficer(
    actor: TenantActor,
    organizationId: string,
    membershipId: string,
  ): Promise<{ complianceOfficerMembershipId: string }>;
  attestGoLive(
    actor: TenantActor,
    organizationId: string,
    note: string | undefined,
  ): Promise<WizardView>;
}

export interface AttestInput {
  readonly evidenceNote?: unknown;
  readonly evidenceRef?: unknown;
  /** Why a platform operator is settling the step on the tenant's behalf (required for platform actors). */
  readonly reason?: unknown;
}
export interface ProfileInput {
  readonly displayName?: unknown;
  readonly orgTimezone?: unknown;
}

const refuse = (code: string, message: string, status: number): ChartWardenError =>
  new ChartWardenError(code, message, status);

/** Who may act on a step. Platform operators act on any step; `either` is the tenant org_admin or platform ops. */
export function actorMayActOnStep(actor: WizardActor, owner: StepOwner): boolean {
  if (actor.kind === "platform") return true;
  if (owner === "platform_ops") return false;
  if (owner === "compliance_officer") return actor.roles.includes("compliance_officer");
  return actor.roles.includes("org_admin");
}

const actorKindOf = (actor: WizardActor): "platform_ops" | "tenant" =>
  actor.kind === "platform" ? "platform_ops" : "tenant";

const requireOnboarding = (tenant: TenantRef): void => {
  if (tenant.status !== ONBOARDING_STATUS) {
    throw refuse("TENANT_NOT_ONBOARDING", "the tenant is not in onboarding", 409);
  }
};

interface Loaded {
  readonly store: WizardStore;
  readonly tenant: TenantRef;
  readonly templates: StepTemplate[];
  readonly tasks: StepTask[];
}

async function loadTenant(
  store: WizardStore,
  by: { orgSlug: string } | { organizationId: string },
): Promise<TenantRef> {
  const tenant = await store.loadTenant(by);
  if (!tenant) throw new NotFoundError("tenant");
  return tenant;
}

async function load(
  store: WizardStore,
  by: { orgSlug: string } | { organizationId: string },
): Promise<Loaded> {
  const tenant = await loadTenant(store, by);
  const [templates, tasks] = await Promise.all([
    store.listTemplates(),
    store.listTasks(tenant.tenantAccountId),
  ]);
  return { store, tenant, templates, tasks };
}

/** The task and its template, for a step action by `actor` (owner check included). */
function targetOf(
  ctx: Loaded,
  taskId: string,
  actor: WizardActor,
): { task: StepTask; template: StepTemplate } {
  const task = ctx.tasks.find((t) => t.id === taskId);
  const template = task && ctx.templates.find((t) => t.key === task.templateKey);
  if (!task || !template) throw new NotFoundError("onboarding_task", taskId);
  if (!actorMayActOnStep(actor, template.owner)) {
    throw refuse(
      "ONBOARDING_STEP_OWNER_MISMATCH",
      `this step belongs to ${template.owner === "either" ? "the organization administrator" : template.owner}; you cannot act on it`,
      403,
    );
  }
  return { task, template };
}

const conflict = (): ChartWardenError =>
  refuse(
    "ONBOARDING_TASK_CHANGED",
    "the onboarding step changed concurrently; reload and retry",
    409,
  );

export function createOnboardingWizard(deps: OnboardingWizardDeps): OnboardingWizard {
  const now = deps.now ?? (() => new Date());

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
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function view(ctx: Loaded): Promise<WizardView> {
    const [attestations, latestBaa] = await Promise.all([
      ctx.store.listGoLive(ctx.tenant.tenantAccountId),
      ctx.store.latestBaa(ctx.tenant.tenantAccountId),
    ]);
    return buildWizardView({
      tenant: ctx.tenant,
      templates: ctx.templates,
      tasks: ctx.tasks,
      attestations,
      latestBaa,
      today: now(),
    });
  }

  async function withProfile(ctx: Loaded): Promise<WizardViewWithProfile> {
    const [wizard, orgProfile] = await Promise.all([
      view(ctx),
      deps.orgProfile.read(ctx.tenant.organizationId),
    ]);
    return { ...wizard, orgProfile };
  }

  // ── the shared step operations ─────────────────────────────────────────────────────────────────────────────

  async function attest(
    ctx: Loaded,
    actor: WizardActor,
    taskId: string,
    input: AttestInput,
  ): Promise<StepTask> {
    requireOnboarding(ctx.tenant);
    const { task, template } = targetOf(ctx, taskId, actor);
    if (template.key === GO_LIVE_TEMPLATE_KEY) {
      throw refuse(
        "ONBOARDING_STEP_NOT_ATTESTABLE",
        "go-live is settled by the two-party approval, not by attestation",
        422,
      );
    }
    if (template.completionMode === "auto") {
      throw refuse(
        "ONBOARDING_STEP_NOT_ATTESTABLE",
        "this step is verified by the platform from its own data and cannot be attested",
        422,
      );
    }
    const evidence = normalizeEvidence(input);
    const reason = actor.kind === "platform" ? normalizeReason(input.reason) : null;
    if (isSettled(task.status)) {
      throw refuse(
        "ONBOARDING_STEP_ALREADY_SETTLED",
        "this step is already done; re-open it to change it",
        409,
      );
    }
    assertStepActionable(ctx.templates, ctx.tasks, template.key);
    const at = now();
    const updated = await ctx.store.updateTask(task.id, task.status, {
      status: "done",
      startedAt: task.startedAt ?? at,
      completedAt: at,
      blockerReason: null,
      evidenceNote: evidence.note,
      evidenceRef: evidence.ref,
      attestedByMembershipId: actor.membershipId,
      attestedByActorKind: actorKindOf(actor),
      attestedAt: at,
      completionEvidence: {
        ...(await ctx.store.getCompletionEvidence(task.id)),
        attestation: {
          actorKind: actorKindOf(actor),
          userId: actor.userId,
          ...(reason ? { reason } : {}),
        },
      },
    });
    if (!updated) throw conflict();
    return updated;
  }

  async function skip(
    ctx: Loaded,
    actor: PlatformActor,
    taskId: string,
    rationale: string,
  ): Promise<StepTask> {
    requireOnboarding(ctx.tenant);
    const { task, template } = targetOf(ctx, taskId, actor);
    if (template.key === GO_LIVE_TEMPLATE_KEY) {
      throw refuse(
        "ONBOARDING_STEP_NOT_SKIPPABLE",
        "go-live cannot be skipped: it is the two-party approval",
        409,
      );
    }
    const why = normalizeReason(rationale, { max: SKIP_RATIONALE_MAX, field: "skipRationale" });
    if (isSettled(task.status))
      throw refuse(
        "ONBOARDING_STEP_ALREADY_SETTLED",
        `a ${task.status} task cannot be skipped`,
        409,
      );
    assertStepActionable(ctx.templates, ctx.tasks, template.key);
    const at = now();
    const updated = await ctx.store.updateTask(task.id, task.status, {
      status: "skipped",
      blockerReason: null,
      completionEvidence: {
        ...(await ctx.store.getCompletionEvidence(task.id)),
        skip: {
          rationale: why,
          skippedByMembershipId: actor.membershipId,
          skippedByUserId: actor.userId,
          skippedAt: at.toISOString(),
        },
      },
    });
    if (!updated) throw conflict();
    return updated;
  }

  async function reopen(
    ctx: Loaded,
    actor: WizardActor,
    taskId: string,
    reason: unknown,
  ): Promise<StepTask> {
    requireOnboarding(ctx.tenant);
    const { task } = targetOf(ctx, taskId, actor);
    // A re-open discards an attestation the audit trail relied on, so every actor, tenant included, says why.
    const why = normalizeReason(reason);
    if (!isSettled(task.status))
      throw refuse(
        "ONBOARDING_STEP_NOT_SETTLED",
        "only a done or skipped step can be re-opened",
        409,
      );
    if (
      (await ctx.store.listGoLive(ctx.tenant.tenantAccountId)).some((a) => a.status === "pending")
    ) {
      throw refuse(
        "GO_LIVE_PENDING",
        "a go-live attestation is pending: revoke it before re-opening a step",
        409,
      );
    }
    const at = now();
    const bag = await ctx.store.getCompletionEvidence(task.id);
    const { attestation: _a, skip: _s, ...rest } = bag as Record<string, unknown>;
    const history = Array.isArray(rest.reopened) ? (rest.reopened as unknown[]) : [];
    const updated = await ctx.store.updateTask(task.id, task.status, {
      status: "in_progress",
      completedAt: null,
      blockerReason: null,
      evidenceNote: null,
      evidenceRef: null,
      attestedByMembershipId: null,
      attestedByActorKind: null,
      attestedAt: null,
      completionEvidence: {
        ...rest,
        reopened: [
          ...history,
          {
            reopenedAt: at.toISOString(),
            reopenedBy: { actorKind: actorKindOf(actor), membershipId: actor.membershipId },
            reason: why,
            previous: {
              status: task.status,
              completedAt: task.completedAt?.toISOString() ?? null,
              evidenceNote: task.evidenceNote,
              evidenceRef: task.evidenceRef,
              attestedByMembershipId: task.attestedByMembershipId,
              attestedAt: task.attestedAt?.toISOString() ?? null,
              ...(task.skipRationale ? { skipRationale: task.skipRationale } : {}),
            },
          },
        ],
      },
    });
    if (!updated) throw conflict();
    return updated;
  }

  async function start(ctx: Loaded, actor: WizardActor, taskId: string): Promise<StepTask> {
    requireOnboarding(ctx.tenant);
    const { task, template } = targetOf(ctx, taskId, actor);
    if (isSettled(task.status))
      throw refuse(
        "ONBOARDING_STEP_ALREADY_SETTLED",
        "this step is already done; re-open it to change it",
        409,
      );
    assertStepActionable(ctx.templates, ctx.tasks, template.key);
    if (task.status === "in_progress") return task;
    const updated = await ctx.store.updateTask(task.id, task.status, {
      status: "in_progress",
      startedAt: task.startedAt ?? now(),
      blockerReason: null,
    });
    if (!updated) throw conflict();
    return updated;
  }

  async function block(
    ctx: Loaded,
    actor: WizardActor,
    taskId: string,
    blockerReason: string,
  ): Promise<StepTask> {
    requireOnboarding(ctx.tenant);
    const { task } = targetOf(ctx, taskId, actor);
    const why = normalizeBlockerReason(blockerReason);
    if (task.status !== "pending" && task.status !== "in_progress") {
      throw refuse("ONBOARDING_STEP_NOT_BLOCKABLE", `a ${task.status} step cannot be blocked`, 409);
    }
    const updated = await ctx.store.updateTask(task.id, task.status, {
      status: "blocked",
      blockerReason: why,
    });
    if (!updated) throw conflict();
    return updated;
  }

  async function assignOfficer(
    ctx: Loaded,
    membershipId: string,
  ): Promise<{ complianceOfficerMembershipId: string }> {
    requireOnboarding(ctx.tenant);
    if (!(await ctx.store.isActiveMember(ctx.tenant.organizationId, membershipId))) {
      throw refuse(
        "COMPLIANCE_OFFICER_NOT_A_MEMBER",
        "the compliance officer must be an active member of this organization",
        422,
      );
    }
    await ctx.store.setComplianceOfficer(ctx.tenant.tenantAccountId, membershipId);
    return { complianceOfficerMembershipId: membershipId };
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
    const attestationNote = normalizeOptionalNote(note);
    const attestations = await ctx.store.listGoLive(ctx.tenant.tenantAccountId);
    assertCanAttest({
      tenantStatus: ctx.tenant.status,
      templates: ctx.templates,
      tasks: ctx.tasks,
      attestations,
      assignedOfficer: ctx.tenant.complianceOfficerMembershipId,
      actorMembershipId: actor.membershipId,
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
    return view({
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
    const attestations = await ctx.store.listGoLive(ctx.tenant.tenantAccountId);
    const pending = assertCanApprove({
      tenantStatus: ctx.tenant.status,
      attestations,
      approverMembershipId: actor.membershipId,
    });
    const latestBaa = await ctx.store.latestBaa(ctx.tenant.tenantAccountId);
    const guards = evaluateGoLiveGuards({
      templates: ctx.templates,
      tasks: ctx.tasks,
      latestBaa,
      today: now(),
    });
    assertGuardsPass(guards, ctx.templates, ctx.tasks);

    const settled = await ctx.store.settleGoLive(pending.id, {
      status: "approved",
      approvedByMembershipId: actor.membershipId,
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
            approvedByMembershipId: actor.membershipId,
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
    return view(fresh);
  }

  async function goLiveRevoke(
    ctx: Loaded,
    actor: PlatformActor,
    reasonInput: string,
  ): Promise<WizardView> {
    const reason = normalizeReason(reasonInput);
    const pending = assertCanRevoke({
      tenantStatus: ctx.tenant.status,
      attestations: await ctx.store.listGoLive(ctx.tenant.tenantAccountId),
    });
    const settled = await ctx.store.settleGoLive(pending.id, {
      status: "revoked",
      revokedByMembershipId: actor.membershipId,
      revokeReason: reason,
    });
    if (!settled)
      throw refuse("GO_LIVE_NOT_ATTESTED", "the go-live attestation is no longer pending", 409);
    const goLiveTask = ctx.tasks.find((t) => t.templateKey === GO_LIVE_TEMPLATE_KEY);
    if (goLiveTask?.status === "in_progress") {
      await ctx.store.updateTask(goLiveTask.id, "in_progress", {
        status: "pending",
        startedAt: null,
      });
    }
    return view(await load(ctx.store, { organizationId: ctx.tenant.organizationId }));
  }

  // ── surface adapters ───────────────────────────────────────────────────────────────────────────────────────

  const platform = <T>(
    reason: string,
    orgSlug: string,
    fn: (ctx: Loaded) => Promise<T>,
  ): Promise<T> =>
    deps.runner.inPlatform(reason, async (store) => fn(await load(store, { orgSlug })));
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
  const profileResult = async (
    organizationId: string,
    patch: ProfileInput,
    actorUserId: string,
    tenant: TenantRef,
  ) => {
    requireOnboarding(tenant);
    return deps.orgProfile.update(organizationId, normalizeOrgProfilePatch(patch), actorUserId);
  };

  return {
    getPlatform: (orgSlug) => platform("platform-ops tenant onboarding read", orgSlug, withProfile),
    attestPlatform: async (orgSlug, taskId, actor, input) =>
      (
        await changed(
          await platform("platform-ops onboarding attest", orgSlug, async (ctx) =>
            stepResult(ctx, await attest(ctx, actor, taskId, input)),
          ),
        )
      ).view,
    skipPlatform: async (orgSlug, taskId, actor, rationale) =>
      (
        await changed(
          await platform("platform-ops onboarding skip", orgSlug, async (ctx) =>
            stepResult(ctx, await skip(ctx, actor, taskId, rationale)),
          ),
        )
      ).view,
    reopenPlatform: async (orgSlug, taskId, actor, reason) =>
      (
        await changed(
          await platform("platform-ops onboarding reopen", orgSlug, async (ctx) =>
            stepResult(ctx, await reopen(ctx, actor, taskId, reason)),
          ),
        )
      ).view,
    setOrgProfilePlatform: async (orgSlug, actor, patch) => {
      const tenant = await deps.runner.inPlatform(
        "platform-ops tenant org profile lookup",
        async (store) => loadTenant(store, { orgSlug }),
      );
      return profileResult(tenant.organizationId, patch, actor.userId, tenant);
    },
    setComplianceOfficerPlatform: async (orgSlug, _actor, membershipId) => {
      const out = await platform(
        "platform-ops compliance officer assignment",
        orgSlug,
        async (ctx) => ({ tenant: ctx.tenant, out: await assignOfficer(ctx, membershipId) }),
      );
      return (await changed(out)).out;
    },
    approveGoLive: (orgSlug, actor, reason) =>
      platform("platform-ops go-live approval", orgSlug, (ctx) =>
        goLiveApprove(ctx, actor, reason),
      ),
    revokeGoLive: async (orgSlug, actor, reason) =>
      platform("platform-ops go-live revoke", orgSlug, (ctx) => goLiveRevoke(ctx, actor, reason)),

    getTenant: (organizationId) =>
      deps.runner.inTenant(
        { kind: "tenant", membershipId: "", userId: "", roles: [] },
        organizationId,
        async (store) => withProfile(await load(store, { organizationId })),
      ),
    startTask: async (actor, organizationId, taskId) =>
      (
        await changed(
          await tenantTx(actor, organizationId, async (ctx) =>
            stepResult(ctx, await start(ctx, actor, taskId)),
          ),
        )
      ).view,
    blockTask: async (actor, organizationId, taskId, reason) =>
      (
        await tenantTx(actor, organizationId, async (ctx) =>
          stepResult(ctx, await block(ctx, actor, taskId, reason)),
        )
      ).view,
    attestTask: async (actor, organizationId, taskId, input) =>
      (
        await changed(
          await tenantTx(actor, organizationId, async (ctx) =>
            stepResult(ctx, await attest(ctx, actor, taskId, input)),
          ),
        )
      ).view,
    reopenTask: async (actor, organizationId, taskId, reason) =>
      (
        await changed(
          await tenantTx(actor, organizationId, async (ctx) =>
            stepResult(ctx, await reopen(ctx, actor, taskId, reason)),
          ),
        )
      ).view,
    setOrgProfile: async (actor, organizationId, patch) => {
      const tenant = await deps.runner.inTenant(actor, organizationId, async (store) =>
        loadTenant(store, { organizationId }),
      );
      return profileResult(organizationId, patch, actor.userId, tenant);
    },
    setComplianceOfficer: async (actor, organizationId, membershipId) =>
      (
        await changed(
          await tenantTx(actor, organizationId, async (ctx) => ({
            tenant: ctx.tenant,
            out: await assignOfficer(ctx, membershipId),
          })),
        )
      ).out,
    attestGoLive: (actor, organizationId, note) =>
      tenantTx(actor, organizationId, (ctx) => goLiveAttest(ctx, actor, note)),
  };
}
