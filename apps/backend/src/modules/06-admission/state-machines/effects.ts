// apps/backend/src/modules/06-admission/state-machines/effects.ts — M6-T04 (§2.5).
//
// §2.5 fixes the pattern: every state transition carries an explicit, in-transaction side-effect list
// (audit + outbox + child-row ops), and the COMMIT binds the domain row, the audit row and the outbox
// row atomically — the "DB updated but the event never went out" failure mode is eliminated
// structurally. This pure engine (M6-T04) returns side effects DECLARATIVELY as data; the service
// layer (M6-T06+) executes them inside the aggregate's optimistic-locked transaction. Keeping them as
// data makes the machines deterministic and unit-testable with no DB.
import type { ComplianceWindowKind, LevelOfCare, LocalDate, M6EventName } from "@wardenx/types";

/** Why an election period closed (§2.3.2 `complete(cause)`). */
export type ElectionEndCause = "next_period" | "revocation" | "transfer" | "discharge";

/**
 * One in-transaction side effect a transition declares (§2.5). The service layer is the only place
 * these run; the machine never touches IO. `outbox` events are restricted to the §4.4 `m6.*` catalog.
 */
export type SideEffect =
  /** Write the M4 write-audit row for the aggregate (always present per §2.5). */
  | { readonly kind: "audit" }
  /** Publish an `m6.*` outbox event in the same tx (§4.4 catalog). */
  | { readonly kind: "outbox"; readonly event: M6EventName }
  /** Open a compliance window child row (§2.3.1 createAdmission cascade). */
  | { readonly kind: "open_window"; readonly window: ComplianceWindowKind }
  /** Close (satisfy) a compliance window child row. */
  | { readonly kind: "close_window"; readonly window: ComplianceWindowKind }
  /** End the admission's current election period with the given cause (§2.3.2/§2.3.6). */
  | { readonly kind: "end_election_period"; readonly cause: ElectionEndCause }
  /** End the admission's current level-of-care period (§2.3.5/§2.3.6). */
  | { readonly kind: "end_level_of_care" }
  /** Start a new level-of-care period at the given level (transfer-in / discharge cascades). */
  | { readonly kind: "start_level_of_care"; readonly level: LevelOfCare }
  /** Set a timestamp/marker column on the aggregate (e.g. `activated_at`, `effective_at`). */
  | { readonly kind: "set_timestamp"; readonly field: string; readonly at: LocalDate }
  /** Flag the aggregate (e.g. CTI `signed_late=true`, F2F `window_override=true`). */
  | { readonly kind: "set_flag"; readonly field: string };

/** Convenience: a transition's full result — the new state + its ordered side-effect list. */
export interface TransitionResult<S extends string, E extends string> {
  readonly from: S;
  readonly event: E;
  readonly to: S;
  readonly effects: ReadonlyArray<SideEffect>;
}

/** Build a {@link TransitionResult} (keeps the machines terse and uniform). */
export function result<S extends string, E extends string>(
  from: S,
  event: E,
  to: S,
  effects: ReadonlyArray<SideEffect>,
): TransitionResult<S, E> {
  return { from, event, to, effects };
}
