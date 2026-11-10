// apps/backend/src/modules/34-saas-tenant-platform/onboarding/wizard-steps.ts - a step's lifecycle: attest, skip, re-open,
// start and block. One implementation for both surfaces; every rule (sequence, owner, evidence, pending go-live) is enforced
// here, server-side. Each operation runs against ONE open store transaction the caller supplies.
import {
  SKIP_RATIONALE_MAX,
  normalizeBlockerReason,
  normalizeEvidence,
  normalizeReason,
} from "./evidence";
import {
  GO_LIVE_TEMPLATE_KEY,
  SYSTEM_MEMBERSHIP_ID,
  type SkipActorKind,
  type StepTask,
  type WizardActor,
  isSkippableStep,
  isTenantSkippableStep,
} from "./model";
import { assertStepActionable, isSettled } from "./sequence";
import {
  type Loaded,
  actorKindOf,
  conflict,
  refuse,
  requireOnboarding,
  stepOf,
  targetOf,
} from "./wizard-core";
import type { AttestInput } from "./wizard-types";

export function createStepOperations(now: () => Date) {
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

  /** Who is skipping: the tenant's org_admin, a platform operator, or the system (the clearinghouse sync acts under the system membership). */
  const skipKindOf = (actor: WizardActor): SkipActorKind => {
    if (actor.kind === "tenant") return "tenant";
    return actor.membershipId === SYSTEM_MEMBERSHIP_ID ? "system" : "platform_ops";
  };

  /**
   * Settles a step that does not apply, with a recorded rationale and the kind of actor who said so. A platform operator may skip any
   * step `isSkippableStep` names; the tenant's own org_admin only those `isTenantSkippableStep` names (409
   * ONBOARDING_STEP_NOT_TENANT_SKIPPABLE otherwise, before the owner rule and the sequence: that answer is final whatever is open).
   * A TENANT's skip is onboarding data the officer's attestation did not see, so it voids a pending go-live attestation in the same
   * transaction (the three steps it may skip are gating, so an open one already rules a pending attestation out and the void is a
   * guarantee, not a path a normal wizard walks). An operator's skip does not void, as an operator's attestation of the same step does
   * not (the officer attests with an optional step such as sample data still open, and an operator settling it must not undo that);
   * the system's clearinghouse skip never does either.
   */
  async function skip(
    ctx: Loaded,
    actor: WizardActor,
    taskId: string,
    rationale: string,
  ): Promise<StepTask> {
    requireOnboarding(ctx.tenant);
    if (actor.kind === "tenant" && !isTenantSkippableStep(stepOf(ctx, taskId).template)) {
      throw refuse(
        "ONBOARDING_STEP_NOT_TENANT_SKIPPABLE",
        "the organization may skip only MAC credentials, payer enrollment and DoseSpot kickoff; ask ChartWarden about any other step",
        409,
      );
    }
    const { task, template } = targetOf(ctx, taskId, actor);
    if (template.key === GO_LIVE_TEMPLATE_KEY) {
      throw refuse(
        "ONBOARDING_STEP_NOT_SKIPPABLE",
        "go-live cannot be skipped: it is the two-party approval",
        409,
      );
    }
    const why = normalizeReason(rationale, { max: SKIP_RATIONALE_MAX, field: "skipRationale" });
    // The allowlist, before the sequence: a canonical step outside it is never skippable, so that answer is final whatever is still open.
    if (!isSkippableStep(template)) {
      throw refuse(
        "ONBOARDING_STEP_NOT_SKIPPABLE",
        "this step cannot be skipped: attest it or enter its data",
        409,
      );
    }
    if (isSettled(task.status))
      throw refuse(
        "ONBOARDING_STEP_ALREADY_SETTLED",
        `a ${task.status} task cannot be skipped`,
        409,
      );
    assertStepActionable(ctx.templates, ctx.tasks, template.key);
    const at = now();
    const kind = skipKindOf(actor);
    const updated = await ctx.store.updateTask(task.id, task.status, {
      status: "skipped",
      blockerReason: null,
      completionEvidence: {
        ...(await ctx.store.getCompletionEvidence(task.id)),
        skip: {
          rationale: why,
          skippedByMembershipId: actor.membershipId,
          skippedByUserId: actor.userId,
          skippedByActorKind: kind,
          skippedAt: at.toISOString(),
        },
      },
    });
    if (!updated) throw conflict();
    if (kind === "tenant") {
      await ctx.store.voidPendingGoLiveForDataChange({
        organizationId: ctx.tenant.organizationId,
        revokedByUserId: actor.userId,
        revokedByMembershipId: actor.membershipId,
      });
    }
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
    if ((await ctx.store.listGoLive(ctx.tenant)).some((a) => a.status === "pending")) {
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
              ...(task.skipRationale
                ? { skipRationale: task.skipRationale, skippedByActorKind: task.skippedByActorKind }
                : {}),
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

  return { attest, skip, reopen, start, block };
}
