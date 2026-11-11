// apps/backend/src/modules/34-saas-tenant-platform/onboarding/wizard-steps.ts - a step's lifecycle: attest, skip, re-open,
// start and block. One implementation for both surfaces; every rule (sequence, owner, evidence, pending go-live) is enforced
// here, server-side. Each operation runs against ONE open store transaction the caller supplies.
import {
  SKIP_RATIONALE_MAX,
  normalizeBlockerReason,
  normalizeEvidence,
  normalizeReason,
} from "./evidence";
import { GO_LIVE_TEMPLATE_KEY, type PlatformActor, type StepTask, type WizardActor } from "./model";
import { assertStepActionable, isSettled } from "./sequence";
import {
  type Loaded,
  actorKindOf,
  conflict,
  refuse,
  requireOnboarding,
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

  return { attest, skip, reopen, start, block };
}
