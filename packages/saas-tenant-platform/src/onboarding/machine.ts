// @wardenx/saas-tenant-platform · onboarding — the §2.3 onboarding ROOT machine (M34, D3). Pure, IO-free.
//
// The §2.3 onboarding workflow as a STRICTLY OBSERVABLE state machine: it does NOT mutate `onboarding_task`
// rows — it consumes the current per-tenant task statuses + a {@link OnboardingContext} and EMITS the events
// the persistence layer (the onboarding-advance worker) consumes to drive the rows. That separation lets the
// machine be unit-tested with no DB and lets the DB stay the source of truth other modules observe (§2.3).
//
// XState v5 ── ARCHITECTURE-OVER-SPEC NOTE. Spec §2.3 names this an "XState v5 machine". XState is NOT a
// repo dependency, and the locked M34 manifest gives `packages/saas-tenant-platform` a single dependency
// edge (`@wardenx/db`); pulling in `xstate` would add an npm edge AND diverge from the established
// repo convention (the M8/M11/M12 lifecycle machines — packages/orders, packages/dosespot — are all pure
// hand-rolled transition functions, NOT XState). Per the repo authority rule (architecture wins over
// module spec) this ships the SAME shape XState v5 expresses — a declarative {@link OnboardingMachineConfig}
// (states + per-state transitions + the uniform `in_progress → blocked → in_progress → [*]` / `→ skipped`
// sub-state pattern) plus a pure interpreter ({@link advanceOnboarding}) that emits, never mutates — without
// the import. See the TODO at the foot of this file for the integrator if a true XActor is required later.
//
// The machine's STATE FLOOR is data-driven (D3): the steps come from the `onboarding_task_template` catalog
// (the worker passes them in, in `canonical_order`), and each step's precondition is the seed's
// `precondition_dsl` (evaluated by ./precondition-dsl). Adding a step is a SEED change, not a code change.
import type { OnboardingTaskStatus } from "../seams/tenant-onboarding-provider";
import type { OnboardingContext } from "./context";
import { evaluatePrecondition } from "./precondition-dsl";
import { ONBOARDING_DONE, canonicalStepIndex } from "./steps";

// The persisted sub-state of a step is the `onboarding_task_status` pgEnum (§3.3) — re-used from the
// TenantOnboardingProvider seam (`pending | in_progress | done | skipped | blocked`) so the machine and
// the seam share ONE status union. The machine reads these as observed sub-state and EMITS to move them.
export type { OnboardingTaskStatus };

/** The observed state of one step the machine reasons over: its template key, its precondition DSL (from
 *  the seed; `null` ⇒ no precondition), whether the seed marks it canonical, its persisted status, the
 *  due instant (for the overdue emit), and the instant it entered `blocked` (for the blocked-age emit). */
export interface OnboardingStepState {
  readonly templateKey: string;
  readonly preconditionDsl: string | null;
  readonly isCanonical: boolean;
  readonly status: OnboardingTaskStatus;
  readonly dueAt: Date | null;
  readonly blockedSince: Date | null;
}

// ── the events the machine EMITS for the persistence layer to consume (§2.3 "strictly observable") ───

/** The §2.3 / §4.9 outbox event family the persistence layer fires from an emitted machine event. The
 *  machine names the wire event; the worker publishes it (no `@wardenx/types` edge from this pure file).
 *  These map 1:1 onto the authoritative `m34.tenant.onboarding_*` catalog in
 *  apps/backend/src/modules/34-saas-tenant-platform/events-by-m34.ts. */
export type OnboardingOutboxEvent =
  | "m34.tenant.onboarding_step_blocked"
  | "m34.tenant.onboarding_overdue"
  | "m34.tenant.onboarding_completed";

/**
 * One event the machine emits (§2.3). The worker consumes these to (a) transition `onboarding_task` rows
 * and (b) publish the §4.9 outbox events / route the §4.8 M36 alerts. The machine returns them as DATA —
 * it performs no IO — so it is fully unit-testable (the M11 effects-as-data precedent).
 */
export type OnboardingEmit =
  /** A step's precondition now holds and the step was `pending`/`blocked` → advance it to `done` (the
   *  step-advanced transition; the worker stamps `completed_at` + publishes `m34.tenant.onboarding_*`). */
  | {
      readonly kind: "step_completed";
      readonly templateKey: string;
      readonly fromStatus: OnboardingTaskStatus;
    }
  /** A step's precondition does NOT hold and the step is being attempted (was `pending`/`in_progress`) →
   *  block it (the worker writes `status='blocked'` + `blocker_reason` and emits the blocked outbox/alert). */
  | {
      readonly kind: "step_blocked";
      readonly templateKey: string;
      readonly fromStatus: OnboardingTaskStatus;
      readonly blockerReason: string;
      readonly outbox: "m34.tenant.onboarding_step_blocked";
    }
  /** A `blocked` step's precondition now holds → unblock it back to `in_progress` (the seed's
   *  `blocked → in_progress` recovery edge), then the same advance attempt completes it. */
  | {
      readonly kind: "step_unblocked";
      readonly templateKey: string;
    }
  /** A non-completed step is past `due_at` → emit the overdue signal (the worker publishes the overdue
   *  outbox/alert; this does NOT change the step status, only raises the alert — §4.8). */
  | {
      readonly kind: "step_overdue";
      readonly templateKey: string;
      readonly dueAt: Date;
      readonly hoursOverdue: number;
      readonly outbox: "m34.tenant.onboarding_overdue";
    }
  /** Every CANONICAL step is `done`/`skipped` → the onboarding flow is complete; the worker drives the
   *  `onboarding → active` lifecycle transition (which itself re-checks BAA, §2.4.12) and publishes
   *  `m34.tenant.onboarding_completed`. The `[*]` terminal of the §2.3 mermaid. */
  | {
      readonly kind: "onboarding_completed";
      readonly outbox: "m34.tenant.onboarding_completed";
      readonly canonicalCompleted: number;
      readonly canonicalSkipped: number;
    };

/** The full pure result of one advance attempt: the observed current step (the first non-terminal step),
 *  the next step after this advance settles (or {@link ONBOARDING_DONE}), and the ordered emit list the
 *  worker consumes. No IO — the M11 effects-as-data shape. */
export interface OnboardingAdvanceResult {
  readonly currentStep: string;
  readonly nextStep: string;
  readonly emits: readonly OnboardingEmit[];
}

// ── the declarative machine config (the shape XState v5 `setup({}).createMachine({})` would express) ─

/** A per-state transition descriptor — `target` plus the `whenPreconditionHolds` guard the interpreter
 *  resolves via the precondition DSL. The XState analogue of `on: { ADVANCE: { target, guard } }`. */
export interface OnboardingStateTransition {
  readonly target: string;
  /** The precondition-DSL expression (from the seed) that guards the advance to `target`, or `null`. */
  readonly whenPreconditionHolds: string | null;
}

/** One state in the onboarding machine — a canonical/non-canonical step with its uniform sub-state set
 *  (`pending`, `in_progress`, `blocked`, `done`, `skipped`) and the single forward transition to the next
 *  step. Built from the seed templates by {@link buildOnboardingMachineConfig}. */
export interface OnboardingStateNode {
  readonly key: string;
  readonly isCanonical: boolean;
  readonly preconditionDsl: string | null;
  readonly onAdvance: OnboardingStateTransition;
}

/** The declarative onboarding machine config (the data XState v5 would consume). Ordered by the seed
 *  `canonical_order`; the last node targets {@link ONBOARDING_DONE}. */
export interface OnboardingMachineConfig {
  readonly id: "m34.onboarding";
  readonly initial: string;
  readonly nodes: readonly OnboardingStateNode[];
}

/**
 * Build the declarative §2.3 machine config from the seed templates (in `canonical_order`). The worker
 * loads `onboarding_task_template` rows (data-driven floor, D3) and passes their `{key, preconditionDsl,
 * isCanonical, canonicalOrder}` here; this assembles the linear state graph (each step → the next, the
 * last → `__done__`). Adding a step is therefore a SEED change observed here, never a code change.
 */
export function buildOnboardingMachineConfig(
  templates: ReadonlyArray<{
    readonly key: string;
    readonly preconditionDsl: string | null;
    readonly isCanonical: boolean;
    readonly canonicalOrder: number;
  }>,
): OnboardingMachineConfig {
  if (templates.length === 0) {
    throw new Error("onboarding machine requires at least one template (the seed floor is empty)");
  }
  const ordered = [...templates].sort((a, b) => a.canonicalOrder - b.canonicalOrder);
  const nodes: OnboardingStateNode[] = ordered.map((t, i) => {
    const next = ordered[i + 1];
    return {
      key: t.key,
      isCanonical: t.isCanonical,
      preconditionDsl: t.preconditionDsl,
      onAdvance: {
        target: next ? next.key : ONBOARDING_DONE,
        whenPreconditionHolds: t.preconditionDsl,
      },
    };
  });
  return {
    id: "m34.onboarding",
    initial: (ordered[0] as { key: string }).key,
    nodes,
  };
}

// ── the pure interpreter: observe step statuses + context → EMIT (never mutate) ─────────────────────

/** A standard blocker message for a step whose precondition did not hold (the worker writes it to
 *  `onboarding_task.blocker_reason`, §2.4.15 — `blocked` requires a non-null reason). */
function blockerReasonFor(templateKey: string, preconditionDsl: string | null): string {
  return preconditionDsl == null
    ? `step '${templateKey}' is blocked pending platform-ops action`
    : `precondition not yet satisfied for '${templateKey}': ${preconditionDsl}`;
}

const MS_PER_HOUR = 3_600_000;

/**
 * The pure §2.3 onboarding interpreter (the XState `transition`/`getNextSnapshot` analogue). Given the
 * machine config, the per-tenant step states (the observed `onboarding_task` rows), the populated
 * {@link OnboardingContext}, and the evaluation instant `now`, it walks the steps in order and EMITS the
 * events the worker consumes:
 *   • a non-completed step whose precondition holds → `step_completed` (preceded by `step_unblocked` if it
 *     was `blocked`) — the seed's `in_progress/blocked → [*]` edge;
 *   • a non-completed step whose precondition does NOT hold → `step_blocked` (+ the blocked outbox) — the
 *     `in_progress → blocked` edge — and the walk STOPS (later steps can't advance past a blocker);
 *   • any non-completed step past `due_at` → `step_overdue` (+ the overdue outbox, alert-only);
 *   • when every CANONICAL step is `done`/`skipped` → `onboarding_completed` (the `[*]` terminal).
 * It performs NO IO and mutates nothing — the worker turns the emits into row writes + outbox/alerts.
 */
export function advanceOnboarding(
  config: OnboardingMachineConfig,
  steps: readonly OnboardingStepState[],
  ctx: OnboardingContext,
  now: Date,
): OnboardingAdvanceResult {
  const byKey = new Map(steps.map((s) => [s.templateKey, s]));
  const emits: OnboardingEmit[] = [];

  // Overdue is alert-only and independent of the advance walk: any non-terminal step past due raises it.
  for (const node of config.nodes) {
    const step = byKey.get(node.key);
    if (step === undefined) continue;
    const terminal = step.status === "done" || step.status === "skipped";
    if (!terminal && step.dueAt !== null && step.dueAt.getTime() < now.getTime()) {
      emits.push({
        kind: "step_overdue",
        templateKey: node.key,
        dueAt: step.dueAt,
        hoursOverdue: (now.getTime() - step.dueAt.getTime()) / MS_PER_HOUR,
        outbox: "m34.tenant.onboarding_overdue",
      });
    }
  }

  // The advance walk: find the first non-terminal step and try to settle it.
  let currentStep: string = ONBOARDING_DONE;
  let nextStep: string = ONBOARDING_DONE;
  for (const node of config.nodes) {
    const step = byKey.get(node.key);
    if (step === undefined) continue;
    if (step.status === "done" || step.status === "skipped") continue;

    currentStep = node.key;
    const holds = evaluatePrecondition(node.preconditionDsl, ctx);

    if (holds) {
      if (step.status === "blocked") {
        emits.push({ kind: "step_unblocked", templateKey: node.key });
      }
      emits.push({
        kind: "step_completed",
        templateKey: node.key,
        fromStatus: step.status,
      });
      nextStep = node.onAdvance.target;
      // This step settles; the next advance attempt (next worker pass) handles the following step.
    } else {
      if (step.status !== "blocked") {
        emits.push({
          kind: "step_blocked",
          templateKey: node.key,
          fromStatus: step.status,
          blockerReason: blockerReasonFor(node.key, node.preconditionDsl),
          outbox: "m34.tenant.onboarding_step_blocked",
        });
      }
      // Already-blocked-and-still-blocked emits nothing new (the §4.8 5d-age sweep is the worker's job).
      nextStep = node.key;
    }
    // Stop at the first non-terminal step — a blocker (or a just-settled step) gates the rest.
    break;
  }

  // Completion: every CANONICAL step done/skipped → the §2.3 `[*]` terminal. Computed AFTER any settle
  // emit above so a final-step completion in this same pass rolls straight into onboarding_completed.
  const settledThisPass = new Set(
    emits
      .filter((e) => e.kind === "step_completed")
      .map((e) => (e as { templateKey: string }).templateKey),
  );
  const canonicalSteps = steps.filter((s) => s.isCanonical);
  const isSettled = (s: OnboardingStepState) =>
    s.status === "done" || s.status === "skipped" || settledThisPass.has(s.templateKey);
  if (canonicalSteps.length > 0 && canonicalSteps.every(isSettled)) {
    emits.push({
      kind: "onboarding_completed",
      outbox: "m34.tenant.onboarding_completed",
      canonicalCompleted: canonicalSteps.filter((s) => s.status !== "skipped").length,
      canonicalSkipped: canonicalSteps.filter((s) => s.status === "skipped").length,
    });
    nextStep = ONBOARDING_DONE;
  }

  return { currentStep, nextStep, emits };
}

/** Order two step states by their canonical index (non-canonical steps sort after the canonical floor).
 *  Exposed so the worker can present steps in a stable order independent of the DB row order. */
export function compareStepOrder(a: OnboardingStepState, b: OnboardingStepState): number {
  const ai = canonicalStepIndex(a.templateKey);
  const bi = canonicalStepIndex(b.templateKey);
  const an = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
  const bn = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
  return an - bn;
}

// TODO(M34-integrator / XActor): if a stateful, persisted XState v5 actor is later required (e.g. to drive
// the apps/admin onboarding-funnel from a live `Actor` ref rather than re-deriving from the `onboarding_task`
// rows on each read), add `xstate@^5` to packages/saas-tenant-platform/package.json AND record the new npm
// edge in the M34 codePaths note — NOT a manifest `dependsOn` edge (xstate is an external lib, not a WardenX
// module). The {@link OnboardingMachineConfig} here is already shaped to feed `setup({}).createMachine({})`
// 1:1 (states = nodes, `on.ADVANCE` = `onAdvance`, guards = the precondition DSL), so the migration is a wrap,
// not a rewrite. Until then the pure interpreter above is the source of truth and stays DB-free.
