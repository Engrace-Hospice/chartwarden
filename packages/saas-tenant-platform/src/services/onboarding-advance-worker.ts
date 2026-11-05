// @chartwarden/saas-tenant-platform · services — the `tenant.onboarding_advance` worker (M34 §2.3 / §4.8).
//
// The IO-bearing companion of the strictly-observable §2.3 onboarding machine (../onboarding/machine.ts).
// The machine EMITS (never mutates); this worker CONSUMES the emits and effects them: it (a) drives the
// `onboarding_task` rows through the OnboardingRepository, and (b) fires the `m34.tenant.onboarding_*`
// outbox events + M36 alerts (§4.8 `tenant.onboarding_step_blocked` / `_overdue`). It NEVER activates a tenant:
// going live is the two-party approval (the compliance officer attests, a platform operator approves).
//
// PURE-OVER-PORTS (the packages/mdm/src/jobs/processors.ts precedent): the worker takes an injected
// {@link OnboardingAdvancePorts} bag — the onboarding repo (M34-owned, allowed), a clock, the
// context-gathering reads (M2 org/provider-entity/location/membership, M27 external feed, M40 BAA — all
// reached cross-module THROUGH SEAMS / outbox by the adapter that binds these ports at boot, NOT imported
// here), the outbox publisher and the M36 alert router. No clock/RNG/DB
// import in this file, so a run's emitted effects are deterministic and assertable with in-memory ports.
//
// withOrgContext / withPlatformContext (M1 @chartwarden/tenancy) RLS-scoping is the ADAPTER's job: the boot
// adapter wraps each port's DB touch in the tenant org's context (onboarding_task is org-scoped, §3.10);
// the template catalog is platform-shared read-only (§3.12) so its read needs no org scope. This pure
// orchestrator names WHAT to read/write; the adapter owns the RLS envelope.
import type { OnboardingContext } from "../onboarding/context";
import {
  type OnboardingCompletionMode,
  type OnboardingEmit,
  type OnboardingStepState,
  type OnboardingTaskStatus,
  advanceOnboarding,
  buildOnboardingMachineConfig,
} from "../onboarding/machine";
import type { OnboardingRepository } from "../repositories/onboarding";

/** The blocked-age threshold (§4.8 `tenant.onboarding_step_blocked_5d`): a step blocked longer than this
 *  re-fires the blocked outbox/alert so a stuck onboarding is re-surfaced. Five days, in milliseconds. */
const BLOCKED_AGE_REFIRE_MS = 5 * 24 * 60 * 60 * 1000;

/** The §4.9 outbox payloads this worker publishes. Pinned structurally (no `@chartwarden/types` edge from the
 *  pure package) to the apps/backend events-by-m34.ts schemas — the adapter passes them to the dispatcher
 *  verbatim. `tenantAccountId` keys every payload; ISO instants are pre-formatted by the worker. */
export type OnboardingOutboxPayload =
  | {
      readonly event: "m34.tenant.onboarding_step_blocked";
      readonly tenantAccountId: string;
      readonly taskId: string;
      readonly templateKey: string;
      readonly blockerReason: string;
      readonly blockedSinceIso: string;
    }
  | {
      readonly event: "m34.tenant.onboarding_overdue";
      readonly tenantAccountId: string;
      readonly taskId: string;
      readonly templateKey: string;
      readonly dueAt: string;
      readonly hoursOverdue: number;
    };

/** The ports the advance worker binds (the boot adapter resolves each over the M34 repo + seams/outbox). */
export interface OnboardingAdvancePorts {
  /** The M34-owned onboarding data port (templates catalog + per-tenant task rows). */
  readonly repo: OnboardingRepository;
  /** Injected clock — decides overdue + blocked-age, and stamps `completed_at`. */
  now(): Date;
  /**
   * Gather the structured {@link OnboardingContext} for the tenant org (§2.3). The adapter performs the
   * cross-module reads HERE — M2 provider-entity/location/membership counts + CCN/primary-location facts,
   * M27 external-feed (Xero/Gusto/MAC) flags, M12 DoseSpot-kickoff flag, M40 BAA-executed flag — each
   * through a seam or outbox-observed projection, NOT a direct module import. Returns the fact bag the
   * precondition DSL reads. (See the TODOs below for the seams an integrator must wire.)
   */
  gatherContext(input: { tenantAccountId: string; orgId: string }): Promise<OnboardingContext>;
  /** Publish an `m34.tenant.onboarding_*` outbox event in the advance transaction (§2.6 atomic-with-write). */
  publishOutbox(payload: OnboardingOutboxPayload): Promise<void>;
  /** Route an M36 alert (§4.8). Audience + PHI-sanitization are the adapter's job; the worker names the key. */
  routeAlert(input: {
    alertKey: "tenant.onboarding_step_blocked" | "tenant.onboarding_overdue";
    tenantAccountId: string;
    templateKey?: string;
  }): Promise<void>;
}

/** What one advance pass did (for the worker's caller / the §2.3 funnel telemetry). */
export interface OnboardingAdvanceReport {
  readonly tenantAccountId: string;
  readonly currentStep: string;
  readonly nextStep: string;
  readonly completed: readonly string[];
  readonly blocked: readonly string[];
  readonly overdue: readonly string[];
}

/** Map a live `onboarding_task` row (+ its template) into the machine's observed {@link OnboardingStepState}. */
function toStepState(
  task: {
    templateKey: string;
    status: OnboardingTaskStatus;
    dueAt: Date | null;
    blockerReason: string | null;
  },
  template: {
    preconditionDsl: string | null;
    isCanonical: boolean;
    completionMode: string;
    isOptional: boolean;
  },
  blockedSince: Date | null,
): OnboardingStepState {
  return {
    templateKey: task.templateKey,
    preconditionDsl: template.preconditionDsl,
    isCanonical: template.isCanonical,
    completionMode: template.completionMode as OnboardingCompletionMode,
    isOptional: template.isOptional,
    status: task.status,
    dueAt: task.dueAt,
    blockedSince,
  };
}

/**
 * Run one `tenant.onboarding_advance` pass for a tenant (§2.3 / §4.8). Loads the data-driven step floor
 * (`onboarding_task_template`, D3) + the tenant's `onboarding_task` rows, builds the machine config, gathers
 * the {@link OnboardingContext} (cross-module reads through the injected ports), runs the PURE
 * {@link advanceOnboarding} interpreter, then EFFECTS its emits: transition the task rows via the repo,
 * publish the `m34.tenant.onboarding_*` outbox events and route the §4.8 M36 alerts. Idempotent: re-running with no
 * new facts produces no new row writes (a `step_completed` only writes a row not already `done`).
 *
 * The worker is the live consumer of the strictly-observable machine; the DB stays the source of truth
 * other modules observe (§2.3). It is invoked (a) on demand when a tenant supplies a missing fact, and
 * (b) by the daily onboarding sweep (the §4.8 overdue + 5d-blocked-age scans) the app scheduler registers.
 */
export async function runOnboardingAdvance(
  input: { tenantAccountId: string; orgId: string },
  ports: OnboardingAdvancePorts,
): Promise<OnboardingAdvanceReport> {
  const { tenantAccountId, orgId } = input;
  const now = ports.now();

  const templates = await ports.repo.listTemplates();
  const tasks = await ports.repo.listTasksByTenant(tenantAccountId);
  const templateByKey = new Map(templates.map((t) => [t.key, t]));
  const taskByKey = new Map(tasks.map((t) => [t.templateKey, t]));

  const config = buildOnboardingMachineConfig(
    templates.map((t) => ({
      key: t.key,
      preconditionDsl: t.preconditionDsl,
      isCanonical: t.isCanonical,
      canonicalOrder: t.canonicalOrder,
      completionMode: t.completionMode as OnboardingCompletionMode,
      isOptional: t.isOptional,
    })),
  );

  const steps: OnboardingStepState[] = [];
  for (const task of tasks) {
    const template = templateByKey.get(task.templateKey);
    if (template === undefined) continue; // a tenant-additions task whose template was retired; skip.
    // `blocked_since` is not its own column; when blocked we treat `createdAt` floor — the adapter may
    // refine via the status-event ledger. For the 5d-age re-fire we use the current blocker presence.
    const blockedSince = task.status === "blocked" ? task.createdAt : null;
    steps.push(toStepState(task, template, blockedSince));
  }

  const ctx: OnboardingContext = await ports.gatherContext({ tenantAccountId, orgId });
  const result = advanceOnboarding(config, steps, ctx, now);

  const completed: string[] = [];
  const blocked: string[] = [];
  const overdue: string[] = [];

  // Every write is compare-and-set on the status the sweep believes the row holds (read once, then advanced as its own
  // writes land). A write that matches no row means a human changed the step since the read (a re-open, an attestation):
  // the pass stops there, because later emits assume the earlier step settled, and the next pass re-reads.
  const currentStatus = new Map<string, OnboardingTaskStatus>(
    tasks.map((t) => [t.templateKey, t.status as OnboardingTaskStatus]),
  );
  for (const emit of result.emits) {
    const landed = await applyEmit(emit, {
      tenantAccountId,
      orgId,
      now,
      taskByKey,
      currentStatus,
      ports,
      sink: { completed, blocked, overdue },
    });
    if (!landed) break;
  }

  return {
    tenantAccountId,
    currentStep: result.currentStep,
    nextStep: result.nextStep,
    completed,
    blocked,
    overdue,
  };
}

/** Effect a single machine emit (the §2.3 observe→persist handshake). Split out so each emit kind reads
 *  as one clause and the worker body stays a flat loop. Resolves `false` when a guarded write matched no row (the step
 *  changed under the sweep): nothing was effected for that emit and the caller stops the pass. */
async function applyEmit(
  emit: OnboardingEmit,
  cx: {
    tenantAccountId: string;
    orgId: string;
    now: Date;
    taskByKey: Map<string, { id: string; templateKey: string; status: OnboardingTaskStatus }>;
    /** The status each step holds as far as this pass knows: what the sweep read, advanced by its own writes. */
    currentStatus: Map<string, OnboardingTaskStatus>;
    ports: OnboardingAdvancePorts;
    sink: { completed: string[]; blocked: string[]; overdue: string[] };
  },
): Promise<boolean> {
  const { ports, taskByKey, now, currentStatus } = cx;
  /** One compare-and-set write; records the new status only when it landed. */
  const write = async (
    task: { id: string; templateKey: string },
    next: OnboardingTaskStatus,
    patch: Parameters<OnboardingRepository["updateTaskStatus"]>[2],
  ): Promise<boolean> => {
    const expected = currentStatus.get(task.templateKey) ?? "pending";
    const row = await ports.repo.updateTaskStatus(task.id, expected, patch);
    if (!row) return false;
    currentStatus.set(task.templateKey, next);
    return true;
  };
  switch (emit.kind) {
    case "step_unblocked": {
      const task = taskByKey.get(emit.templateKey);
      if (task === undefined) return true;
      // Seed's `blocked → in_progress` recovery edge: clear the blocker before the completing write.
      return write(task, "in_progress", { status: "in_progress", blockerReason: null });
    }
    case "step_completed": {
      const task = taskByKey.get(emit.templateKey);
      if (task === undefined) return true;
      if (currentStatus.get(emit.templateKey) === "done") return true; // idempotent: nothing to do.
      const landed = await write(task, "done", {
        status: "done",
        completedAt: now,
        blockerReason: null,
      });
      if (landed) cx.sink.completed.push(emit.templateKey);
      return landed;
    }
    case "step_blocked": {
      const task = taskByKey.get(emit.templateKey);
      if (task === undefined) return true;
      // §2.4.15 — `blocked` requires a non-null blocker_reason.
      if (
        currentStatus.get(emit.templateKey) !== "blocked" &&
        !(await write(task, "blocked", { status: "blocked", blockerReason: emit.blockerReason }))
      ) {
        return false; // the step changed under the sweep: it is not blocked, so there is nothing to announce
      }
      await ports.publishOutbox({
        event: "m34.tenant.onboarding_step_blocked",
        tenantAccountId: cx.tenantAccountId,
        taskId: task.id,
        templateKey: emit.templateKey,
        blockerReason: emit.blockerReason,
        blockedSinceIso: now.toISOString(),
      });
      await ports.routeAlert({
        alertKey: "tenant.onboarding_step_blocked",
        tenantAccountId: cx.tenantAccountId,
        templateKey: emit.templateKey,
      });
      cx.sink.blocked.push(emit.templateKey);
      return true;
    }
    case "step_overdue": {
      const task = taskByKey.get(emit.templateKey);
      if (task === undefined) return true;
      await ports.publishOutbox({
        event: "m34.tenant.onboarding_overdue",
        tenantAccountId: cx.tenantAccountId,
        taskId: task.id,
        templateKey: emit.templateKey,
        dueAt: emit.dueAt.toISOString(),
        hoursOverdue: emit.hoursOverdue,
      });
      await ports.routeAlert({
        alertKey: "tenant.onboarding_overdue",
        tenantAccountId: cx.tenantAccountId,
        templateKey: emit.templateKey,
      });
      cx.sink.overdue.push(emit.templateKey);
      return true;
    }
  }
}

// Silence "unused import" if the constant is referenced only in docs: the 5d-age re-fire threshold is a
// policy the boot adapter applies when deciding whether to re-publish a still-blocked step's alert. The
// pure worker re-publishes only newly-blocked steps; the daily sweep adapter compares blockedSince to
// BLOCKED_AGE_REFIRE_MS to re-fire aged blockers (§4.8 `tenant.onboarding_step_blocked_5d`).
export { BLOCKED_AGE_REFIRE_MS };
