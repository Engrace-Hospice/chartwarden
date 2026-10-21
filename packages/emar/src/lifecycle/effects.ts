// @chartwarden/emar — administration-lifecycle side-effect descriptors (§2.2 D6, M13-T03).
//
// The M11/M12 §2.8 pattern carried forward: every transition carries an explicit, in-transaction
// side-effect list (audit + outbox + child-row ops + the M36 typed alerts), and the COMMIT binds the
// `administration_record` row, the audit row, the child rows (witness / drawdown / scheduled-dose linkage)
// and the outbox row atomically — the "DB updated but the event never went out" failure mode is eliminated
// structurally (M1 §25.5/§25.6). This pure engine returns side effects DECLARATIVELY as data; the service
// layer (M13-T08) executes them inside the administration write transaction (M12 `getAdministrationContext`
// consult → five-rights → witness check → insert row → write child rows → decrement kit → audit() →
// outbox.publish()). Keeping them as data makes the machine deterministic and unit-testable with no DB.
import type { M13AlertPayload, M13EventName } from "@chartwarden/types";

/** §4.9 — the discriminating `alertKind` of a typed M36 alert M13 dispatches (no outbox wire name). */
export type M13AlertKind = M13AlertPayload["alertKind"];

/**
 * One in-transaction side effect an administration transition declares (§2.2 D6). The service layer is the
 * only place these run; the machine never touches IO. `outbox` events are restricted to the §4.4 `m13.*`
 * catalog. The `decrement_kit_drawdown` / `link_*` / `request_document` descriptors name the child-row ops
 * the service binds at run time.
 */
export type AdministrationSideEffect =
  /** Write the M4 write-audit row for the administration aggregate (always present per §2.2). */
  | { readonly kind: "audit" }
  /** Publish an `m13.*` outbox event in the same tx (§4.4 catalog). */
  | { readonly kind: "outbox"; readonly event: M13EventName }
  /** Dispatch a typed M36 alert that carries no outbox wire name (§4.9 — e.g. void, caregiver-pending). */
  | { readonly kind: "alert"; readonly alert: M13AlertKind }
  /** Set a timestamp/marker column on the aggregate (e.g. `recorded_at`, `voided_at`). */
  | { readonly kind: "set_timestamp"; readonly field: string }
  /** §2.9 D10 — set the `requires_rn_review` cosign-queue flag. */
  | { readonly kind: "set_requires_rn_review"; readonly value: boolean }
  /** §2.7 D5 — decrement the matching `comfort_kit_drawdown.remaining_quantity` (atomic with commit). */
  | { readonly kind: "decrement_kit_drawdown" }
  /** §2.3 — link the committed administration to its `scheduled_dose` row (flips it to `administered`). */
  | { readonly kind: "link_scheduled_dose" }
  /** §2.4 D3 — emit the PRN-effectiveness reassessment trigger (`m13.prn_administration_recorded`). */
  | { readonly kind: "emit_prn_reassessment_trigger" }
  /** §2.2 / D9 — auto-link an in-flight M8 encounter resolved at administration time. */
  | { readonly kind: "link_encounter" }
  /** §2.2 — request the per-administration eMAR PDF from M22 (tenant policy; default off, on for IPU). */
  | { readonly kind: "request_document" }
  /** §5.12 — flip the corrected original row to `superseded` (correction trigger, in the same tx). */
  | { readonly kind: "supersede_original" }
  /** §2.2 — write the void reason + actor on the hard-void path. */
  | { readonly kind: "write_void"; readonly reason: string };

/** A transition's full result — the new state + its ordered side-effect list. */
export interface AdministrationTransitionResult<S extends string, E extends string> {
  readonly from: S;
  readonly event: E;
  readonly to: S;
  readonly effects: ReadonlyArray<AdministrationSideEffect>;
}

/** Build an {@link AdministrationTransitionResult} (keeps the machine terse and uniform). */
export function result<S extends string, E extends string>(
  from: S,
  event: E,
  to: S,
  effects: ReadonlyArray<AdministrationSideEffect>,
): AdministrationTransitionResult<S, E> {
  return { from, event, to, effects };
}
