// M36 WP 5.9 (ADR-0084) - the ports of the workforce-offboarding orchestration. A "step" is one kind of thing a departed person leaves behind in
// M36. The service owns the decisions (preview vs execute, what blocks completion, fail-closed); a step only counts and acts, through the
// EXISTING services (tasks, handoffs, supervisor reassign, session revoke), so no rule is duplicated here.
import type { OffboardingItemKey, OffboardingItemState } from "@wardenx/types";

/** `unknown` covers an absent and a foreign user alike (one 404); `active` is a person who has not left. */
export type Standing = "unknown" | "active" | "offboarded";

/** `auto`: M36 can finish it. `human`: M36 cannot (flagged, acknowledged, advisory counts); a person must decide. */
export interface Inspection {
  readonly auto: number;
  readonly human: number;
}

export interface StepContext {
  readonly organizationId: string;
  /** The officer who runs the offboarding (the actor of every reassign). */
  readonly actorUserId: string;
  /** The officer's own session, which the session revoke needs to mark "current". */
  readonly actorSessionId: string;
  /** The departed user. */
  readonly leaverUserId: string;
}

/**
 * reassign  moves owned work to a colleague; whatever is still there after the run needs a person.
 * sweep     removes personal leftovers; whatever is still there after the run is a failure to run again.
 * kept      attribution kept on purpose: counted, never changed.
 * advisory  M36 cannot see it; always surfaced, never blocking.
 */
export type StepKind = "reassign" | "sweep" | "kept" | "advisory";

export interface OffboardingStep {
  readonly key: OffboardingItemKey;
  readonly kind: StepKind;
  inspect(ctx: StepContext): Promise<Inspection>;
  /** Idempotent. Returns how many things this call changed. Absent for kept and advisory steps. */
  run?(ctx: StepContext): Promise<number>;
}

export interface OffboardingAuditEntry {
  readonly action: "m36.offboarding.viewed" | "m36.offboarding.executed";
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly targetUserId: string;
  readonly complete: boolean;
  /** Counts and states only, per item. */
  readonly items: Readonly<
    Partial<
      Record<
        OffboardingItemKey,
        { readonly state: OffboardingItemState; readonly count: number; readonly acted: number }
      >
    >
  >;
}

export interface OffboardingDeps {
  standing(organizationId: string, userId: string): Promise<Standing>;
  /** In execution order. */
  readonly steps: readonly OffboardingStep[];
  audit(entry: OffboardingAuditEntry): Promise<void>;
  /** Ids and the error class name only, never an error message. */
  warn?(event: string, context: Record<string, string>): void;
}

export interface OffboardingActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly sessionId: string;
}
