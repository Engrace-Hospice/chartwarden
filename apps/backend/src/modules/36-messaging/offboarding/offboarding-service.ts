// M36 WP 5.9 (ADR-0084) - workforce offboarding as ONE idempotent, resumable, audited operation.
//
//  * No run table: the state is derived. Every step recounts what is still there, so a re-run after a partial failure finishes the remainder,
//    a re-run after success changes nothing (`acted` is 0 everywhere) and the preview is the same counting without the acting.
//  * Order is access first (sessions, then memberships), then owned work, then personal leftovers. A step that throws is `failed`; the others
//    still run; the response never carries the error text.
//  * Nothing is silently dropped: whatever a reassign could not move is `needs_person` with its count. Kept items (what the person sent) and
//    the on-call roster (M19's) never block completion.
//  * An unknown or foreign user is the same NotFoundError; a user who has not left is a 409 (this is not a way to look at active staff).
import {
  ChartWardenError,
  NotFoundError,
  type OffboardingDto,
  type OffboardingItemDto,
} from "@chartwarden/types";
import type {
  Inspection,
  OffboardingActor,
  OffboardingAuditEntry,
  OffboardingDeps,
  OffboardingStep,
  StepContext,
} from "./offboarding-types";

export interface OffboardingService {
  /** Dry run: counts only, nothing changes. */
  preview(actor: OffboardingActor, userId: string): Promise<OffboardingDto>;
  /** Do everything M36 can do, then report per item. Safe to repeat. */
  execute(actor: OffboardingActor, userId: string): Promise<OffboardingDto>;
}

const userActive = (): ChartWardenError =>
  new ChartWardenError(
    "OFFBOARDING_USER_ACTIVE",
    "This person has not left. Offboarding applies to a deactivated or removed user.",
    409,
  );

const total = (i: Inspection): number => i.auto + i.human;

function toItem(
  step: OffboardingStep,
  after: Inspection,
  acted: number,
  mode: "preview" | "execute",
  failed: boolean,
): OffboardingItemDto {
  const base = { key: step.key, acted, count: total(after), needs_person: after.human };
  if (failed) return { ...base, state: "failed" };
  if (step.kind === "kept") return { ...base, state: "kept", needs_person: 0 };
  if (step.kind === "advisory") return { ...base, state: "advisory", count: 0, needs_person: 0 };
  if (total(after) === 0) return { ...base, state: "done" };
  if (step.kind === "sweep") return { ...base, state: mode === "preview" ? "pending" : "failed" };
  // reassign: before the run only the automatable part is pending; after it, everything left is a person's.
  if (mode === "preview" && after.auto > 0) return { ...base, state: "pending" };
  return { ...base, state: "needs_person", needs_person: total(after) };
}

const BLOCKING = new Set<OffboardingItemDto["state"]>(["pending", "needs_person", "failed"]);

function summarise(userId: string, items: readonly OffboardingItemDto[]): OffboardingDto {
  const blocked = items.filter((i) => BLOCKING.has(i.state)).map((i) => i.key);
  return {
    user_id: userId,
    items,
    done: items.filter((i) => i.state === "done" || i.state === "kept").length,
    total: items.length,
    complete: blocked.length === 0,
    blocked_by: blocked,
  };
}

function auditEntry(
  action: OffboardingAuditEntry["action"],
  actor: OffboardingActor,
  userId: string,
  dto: OffboardingDto,
): OffboardingAuditEntry {
  const items: Record<
    string,
    { state: OffboardingItemDto["state"]; count: number; acted: number }
  > = {};
  for (const i of dto.items) items[i.key] = { state: i.state, count: i.count, acted: i.acted };
  return {
    action,
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    targetUserId: userId,
    complete: dto.complete,
    items: items as OffboardingAuditEntry["items"],
  };
}

export function createOffboardingService(deps: OffboardingDeps): OffboardingService {
  async function requireOffboarded(actor: OffboardingActor, userId: string): Promise<void> {
    const standing = await deps.standing(actor.organizationId, userId);
    if (standing === "unknown") throw new NotFoundError("user", userId);
    if (standing === "active") throw userActive();
  }

  const contextOf = (actor: OffboardingActor, userId: string): StepContext => ({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorSessionId: actor.sessionId,
    leaverUserId: userId,
  });

  async function runStep(step: OffboardingStep, ctx: StepContext): Promise<OffboardingItemDto> {
    const before = await step.inspect(ctx);
    if (!step.run || before.auto === 0) return toItem(step, before, 0, "execute", false);
    try {
      const acted = await step.run(ctx);
      return toItem(step, await step.inspect(ctx), acted, "execute", false);
    } catch (err) {
      deps.warn?.("offboarding step failed", {
        organization_id: ctx.organizationId,
        user_id: ctx.leaverUserId,
        item: step.key,
        error_name: err instanceof Error ? err.name : "NonError",
      });
      return toItem(step, before, 0, "execute", true);
    }
  }

  return {
    async preview(actor, userId) {
      await requireOffboarded(actor, userId);
      const ctx = contextOf(actor, userId);
      const items: OffboardingItemDto[] = [];
      for (const step of deps.steps) {
        items.push(toItem(step, await step.inspect(ctx), 0, "preview", false));
      }
      const dto = summarise(userId, items);
      await deps.audit(auditEntry("m36.offboarding.viewed", actor, userId, dto));
      return dto;
    },

    async execute(actor, userId) {
      await requireOffboarded(actor, userId);
      const ctx = contextOf(actor, userId);
      const items: OffboardingItemDto[] = [];
      for (const step of deps.steps) items.push(await runStep(step, ctx));
      const dto = summarise(userId, items);
      await deps.audit(auditEntry("m36.offboarding.executed", actor, userId, dto));
      return dto;
    },
  };
}
