// apps/backend/src/modules/08-encounters/lifecycle/effects.ts — M8-T04 (§2.8).
//
// §2.8 fixes the pattern: every state transition carries an explicit, in-transaction side-effect list
// (audit + outbox + child-row ops), and the COMMIT binds the domain row, the audit row and the outbox
// row atomically — the "DB updated but the event never went out" failure mode is eliminated
// structurally. This pure engine (M8-T04) returns side effects DECLARATIVELY as data; the service layer
// (M8-T09+) executes them inside the aggregate's optimistic-locked transaction (the §2.8 BEGIN..COMMIT
// envelope: load FOR UPDATE on version → run guards/gate → update row → write child rows → audit() →
// outbox.publish()). Keeping them as data makes the machines deterministic and unit-testable with no DB.
import type { LocalDate, M8EventName, SignatureKind } from "@wardenx/types";

/**
 * One in-transaction side effect a transition declares (§2.8). The service layer is the only place
 * these run; the machine never touches IO. `outbox` events are restricted to the §4.4 `m8.*` catalog.
 */
export type EncounterSideEffect =
  /** Write the M4 write-audit row for the aggregate (always present per §2.8). */
  | { readonly kind: "audit" }
  /** Publish an `m8.*` outbox event in the same tx (§4.4 catalog). */
  | { readonly kind: "outbox"; readonly event: M8EventName }
  /** Persist the Layer-1 (and any accepted Layer-2) assembled-output row at finalize (§2.6). */
  | { readonly kind: "persist_assembled_output" }
  /** Freeze the selection set + assembled output — no further edits except via addendum (§2.3). */
  | { readonly kind: "freeze_selections" }
  /** Reify the computed late-entry tier on the encounter row at finalize (§2.5). */
  | { readonly kind: "set_late_entry_tier" }
  /** Write the `encounter_signature` row for the given slot (primary / cosignature / addendum). */
  | { readonly kind: "write_signature"; readonly signature: SignatureKind }
  /** Open the §2.4 D3 cosignature_request (LPN/CHHA primary sign routes to an RN case manager). */
  | { readonly kind: "open_cosignature_request" }
  /** Set a timestamp/marker column on the aggregate (e.g. `finalized_at`, `signed_at`, `voided_at`). */
  | { readonly kind: "set_timestamp"; readonly field: string; readonly at: LocalDate }
  /** Set a free-text/marker column on the aggregate (e.g. the void reason). */
  | { readonly kind: "set_field"; readonly field: string };

/** Convenience: a transition's full result — the new state + its ordered side-effect list. */
export interface TransitionResult<S extends string, E extends string> {
  readonly from: S;
  readonly event: E;
  readonly to: S;
  readonly effects: ReadonlyArray<EncounterSideEffect>;
}

/** Build a {@link TransitionResult} (keeps the machines terse and uniform). */
export function result<S extends string, E extends string>(
  from: S,
  event: E,
  to: S,
  effects: ReadonlyArray<EncounterSideEffect>,
): TransitionResult<S, E> {
  return { from, event, to, effects };
}
