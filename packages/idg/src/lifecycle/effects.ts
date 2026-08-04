// @wardenx/idg — IDG-lifecycle side-effect descriptors (§2.7 / §2.8, M14-T03).
//
// The M8/M11/M13 §2.8 pattern: every transition carries an explicit, in-transaction side-effect list
// (audit + outbox + cross-row ops), and the COMMIT binds the aggregate row, the audit row, the child
// rows, and the outbox row atomically — the "DB updated but the event never went out" failure mode is
// eliminated structurally (M1 §25.5/§25.6). This pure engine returns side effects DECLARATIVELY as data;
// the M14-T05/T06 service + decision-emitter + consumers execute them inside the optimistic-locked
// transaction. Keeping them as data makes the machines deterministic and unit-testable with no DB.
//
// `fire-and-forget` distinction (§7.10): `alert` / `notify_compliance` are M36 dispatches the service
// runs OUTSIDE the rollback boundary — M36 unavailability must NOT block a clinician from adjourning a
// meeting. `outbox` events are the durable cross-module contract and run INSIDE the transaction.
import type { M14AlertPayload, M14EventName } from "@wardenx/types";

/** The §4.10 typed-alert discriminator the `alert` effect names (the payload is assembled in M14-T06). */
export type M14AlertKind = M14AlertPayload["kind"];

/**
 * One in-transaction (or, for alerts, fire-and-forget) side effect a transition declares (§2.7 / §2.8).
 * The service layer is the only place these run; the machines never touch IO. `outbox` events are
 * restricted to the §4.4 `m14.*` / `idg.decision_recorded` catalog.
 */
export type IdgSideEffect =
  /** Write the M4 write-audit row for the aggregate (always present per §2.8). */
  | { readonly kind: "audit" }
  /** Publish an `m14.*` / `idg.decision_recorded` outbox event in the same tx (§4.4 catalog). */
  | { readonly kind: "outbox"; readonly event: M14EventName }
  /** Dispatch a typed M36 alert (fire-and-forget, §7.10 — never rolls back the transition). */
  | { readonly kind: "alert"; readonly alert: M14AlertKind }
  /** Set a timestamp/marker column on the aggregate (e.g. `adjourned_at`, `emitted_at`, `closed_at`). */
  | { readonly kind: "set_timestamp"; readonly field: string }
  /** `BUILD_PACKETS` — enqueue one per-patient packet build job per the §2.3 D9 included set. */
  | { readonly kind: "enqueue_packet_builds" }
  /** `ADJOURN` — set `frozen_at = now()` on every included `idg_patient_packet` (§2.7). */
  | { readonly kind: "freeze_packets" }
  /** `ADJOURN` — stamp `last_idg_reviewed_at = adjourned_at` per included patient (M14-F01 / ADR-0018 D2). */
  | { readonly kind: "stamp_review_floor" }
  /** `ADJOURN` — burst `idg.decision_recorded` for every `status='open'` actionable decision (§2.7). */
  | { readonly kind: "emit_open_decisions" }
  /** `ADJOURN` — lock every action item's final assignee + due date (§2.7). */
  | { readonly kind: "assign_action_items" }
  /** `ADJOURN` — flip the minutes `in_progress → final` (D10). */
  | { readonly kind: "finalize_minutes" }
  /** `RESCHEDULE` — spawn a new `idg_meeting` with `rescheduled_from_meeting_id` set (§2.2). */
  | { readonly kind: "spawn_rescheduled_meeting" }
  /** D8 auto-close — confirm the `linked_artifact_id` that absorbed the action item. */
  | { readonly kind: "confirm_linked_artifact" }
  /** D10 — surface a minutes-amendment request to the Compliance inbox via M36 (fire-and-forget). */
  | { readonly kind: "notify_compliance" };

/** A transition's full result — the new state + its ordered side-effect list. */
export interface IdgTransitionResult<S extends string, E extends string> {
  readonly from: S;
  readonly event: E;
  readonly to: S;
  readonly effects: ReadonlyArray<IdgSideEffect>;
}

/** Build an {@link IdgTransitionResult} (keeps the machines terse and uniform). */
export function result<S extends string, E extends string>(
  from: S,
  event: E,
  to: S,
  effects: ReadonlyArray<IdgSideEffect>,
): IdgTransitionResult<S, E> {
  return { from, event, to, effects };
}

/** Collect the outbox event names a side-effect list declares, order-preserving (test/assembly helper). */
export function outboxEvents(effects: ReadonlyArray<IdgSideEffect>): M14EventName[] {
  return effects
    .filter((e): e is Extract<IdgSideEffect, { kind: "outbox" }> => e.kind === "outbox")
    .map((e) => e.event);
}
