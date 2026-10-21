// apps/backend/src/modules/15-discipline-care-plans/lifecycle/effects.ts — M15-T03 (§2.4 side-effects).
//
// The same §2.4 discipline M6/M7 fixed: every transition carries an explicit, in-transaction side-effect
// list (audit + outbox + snapshot/timestamp ops), and the COMMIT binds the domain row, the audit row and
// the outbox row atomically — "DB updated but the event never went out" is eliminated structurally. This
// pure engine returns side effects DECLARATIVELY as data; the M15 service layer (M15-T06 routes / the
// M15-T04 workers) executes them inside the aggregate's optimistic-locked (§2.5 `If-Match`) transaction.
// Keeping them as data makes the machines deterministic and unit-testable with no DB.
import type { DisciplineRequiredSignerSet, IsoInstant, M15EventName } from "@chartwarden/types";

/**
 * One in-transaction side effect a transition declares (§2.4). The service layer is the only place these
 * run; the machine never touches IO. `outbox` events are restricted to the §2.4 `m15.*` catalog, so a
 * typo cannot invent an event name the dispatcher (and `arch:gaps`) would not recognise.
 */
export type DisciplinePlanSideEffect =
  /** Write the M4 write-audit row for the aggregate (always present). */
  | { readonly kind: "audit" }
  /** Publish an `m15.*` outbox event in the same tx (§2.4 catalog). */
  | { readonly kind: "outbox"; readonly event: M15EventName }
  /** Seal `state_snapshot` + `required_signer_set` at the `draft → in_review` transition (§2.2.2). */
  | { readonly kind: "snapshot"; readonly requiredSignerSet: DisciplineRequiredSignerSet }
  /** Set a timestamp column on the aggregate (e.g. `signed_at`, `discharged_at`). */
  | { readonly kind: "set_timestamp"; readonly field: string; readonly at: IsoInstant }
  /** Clear all collected signatures (§2.2.2 — edit-after-first-signature returns the version to draft). */
  | { readonly kind: "clear_signatures" }
  /** Recompute `discipline_care_plan.next_supervisory_due_at` (§2.2.4; `aide_poc` only). */
  | { readonly kind: "recompute_supervisory_due"; readonly nextDueAt: IsoInstant }
  /**
   * Write the §8.1 `m15.gate.override.invoked` audit event at `warn` severity and bump the
   * `chartwarden_m15_gate_override_counter` metric (§8.2). Declared by the §8.6 STRIDE path where a
   * coordinator books a volunteer past an unmet 418.78 gate with a documented reason — the override is
   * legal, but it is never silent.
   */
  | {
      readonly kind: "gate_override";
      readonly gateKinds: ReadonlyArray<string>;
      readonly reason: string;
    }
  /** Stamp `volunteer_hour_ledger.total_volunteer_hour_minutes` + `as_of_at` (§2.2.7 aggregator). */
  | {
      readonly kind: "set_ledger_total";
      readonly totalVolunteerHourMinutes: number;
      readonly asOfAt: IsoInstant;
    }
  /** Point the plan at its newly-signed current version (`discipline_care_plan_version.sequence`). */
  | { readonly kind: "flip_current_version" };

/** A transition's full result — the new state + its ordered side-effect list. */
export interface TransitionResult<S extends string, E extends string> {
  readonly from: S;
  readonly event: E;
  readonly to: S;
  readonly effects: ReadonlyArray<DisciplinePlanSideEffect>;
}

/** Build a {@link TransitionResult} (keeps the machines terse and uniform). */
export function result<S extends string, E extends string>(
  from: S,
  event: E,
  to: S,
  effects: ReadonlyArray<DisciplinePlanSideEffect>,
): TransitionResult<S, E> {
  return { from, event, to, effects };
}
