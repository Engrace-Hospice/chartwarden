// apps/backend/src/modules/07-care-plan/lifecycle/effects.ts — M7-T03 (§2.4 side-effects).
//
// Same §2.5-style discipline the M6 machines fixed: every transition carries an explicit,
// in-transaction side-effect list (audit + outbox + snapshot/flag ops), and the COMMIT binds the
// domain row, the audit row and the outbox row atomically — "DB updated but the event never went out"
// is eliminated structurally. This pure engine (M7-T03) returns side effects DECLARATIVELY as data; the
// M7 service layer (M7-T05+) executes them inside the version aggregate's optimistic-locked
// transaction. Keeping them as data makes the machines deterministic and unit-testable with no DB.
import type { IsoInstant, M7EventName, RequiredSignerSet } from "@wardenx/types";

/**
 * One in-transaction side effect a transition declares (§2.4). The service layer is the only place
 * these run; the machine never touches IO. `outbox` events are restricted to the §2.4 `m7.*` catalog.
 */
export type CarePlanSideEffect =
  /** Write the M4 write-audit row for the aggregate (always present). */
  | { readonly kind: "audit" }
  /** Publish an `m7.*` outbox event in the same tx (§2.4 catalog). */
  | { readonly kind: "outbox"; readonly event: M7EventName }
  /** Snapshot `state_snapshot` + `required_signer_set` at the `draft → in_review` transition (§2.2.2). */
  | { readonly kind: "snapshot"; readonly requiredSignerSet: RequiredSignerSet }
  /** Set a timestamp column on the aggregate (e.g. `signed_at`, `initial_signed_at`). */
  | { readonly kind: "set_timestamp"; readonly field: string; readonly at: IsoInstant }
  /** Flag the aggregate (e.g. care_plan `active_version_id` flip marker). */
  | { readonly kind: "set_flag"; readonly field: string }
  /** Clear all collected signatures (D8 — edit-after-first-signature / return-for-edits). */
  | { readonly kind: "clear_signatures" }
  /** Flip the care plan's `active_version_id` to the newly-signed version (§2.2.1 active ⇄ active). */
  | { readonly kind: "flip_active_version" };

/** A transition's full result — the new state + its ordered side-effect list. */
export interface TransitionResult<S extends string, E extends string> {
  readonly from: S;
  readonly event: E;
  readonly to: S;
  readonly effects: ReadonlyArray<CarePlanSideEffect>;
}

/** Build a {@link TransitionResult} (keeps the machines terse and uniform). */
export function result<S extends string, E extends string>(
  from: S,
  event: E,
  to: S,
  effects: ReadonlyArray<CarePlanSideEffect>,
): TransitionResult<S, E> {
  return { from, event, to, effects };
}
