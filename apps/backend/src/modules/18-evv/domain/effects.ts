// apps/backend/src/modules/18-evv/domain/effects.ts — M18-T03 (§2.4, §2.5).
//
// The M6/M17 §2.4 pattern: every recording carries an explicit, in-transaction side-effect list (audit +
// outbox + the `evv_geofence_evaluation` snapshot insert + the append-only supersede + the missing-resolution
// open marker), and the COMMIT binds the `evv_event` row, the evaluation row, the audit row and the outbox
// row atomically — the "DB updated but the event never went out" failure mode is eliminated structurally
// (M1 §25.5/§25.6). This pure recorder returns side effects DECLARATIVELY as data; the service layer
// (M18-T06/T07) executes them inside one transaction. Keeping them as data makes the recorder deterministic
// and unit-testable with no DB. `outbox` events are restricted to the §4.10 `m18.evv.*` catalog (the
// dispatcher + `events-by-m18.ts` registration land in M18-T07).
import type {
  EvvAlertPayload,
  EvvMissingResolutionKind,
  EvvMissingResolutionStatus,
  M18EventName,
} from "@wardenx/types";
import type { GeofenceEvaluation } from "./geofence";

/** The §4.9 typed-alert discriminator the `alert` effect names (the payload is assembled in M18-T07). */
export type EvvAlertKind = EvvAlertPayload["kind"];

/**
 * One in-transaction (or, for alerts, fire-and-forget) side effect a recording declares (§2.4). The service
 * layer is the only place these run; the recorder never touches IO.
 */
export type EvvSideEffect =
  /** Write the M4 write-audit row for the event (always present per §2.5). */
  | { readonly kind: "audit" }
  /** Publish an `m18.evv.*` outbox event in the same tx (§4.10 catalog). */
  | { readonly kind: "outbox"; readonly event: M18EventName }
  /** Dispatch a typed M36 alert (fire-and-forget, §4.9 — never rolls back the recording). */
  | { readonly kind: "alert"; readonly alert: EvvAlertKind }
  /** Insert the §2.2.6 informational geofence-evaluation snapshot for this event. */
  | { readonly kind: "insert_geofence_evaluation"; readonly evaluation: GeofenceEvaluation }
  /** §7.7 correction-of-record — set `superseded_at`/`superseded_by_event_id` on the original event row
   * (append-only; the original is never deleted). The new event id is minted by the service. */
  | { readonly kind: "supersede_event"; readonly originalEventId: string }
  /** §2.4 — open an `evv_missing_resolution` row in `open` status with the given kind. The D6 resolution
   * MACHINE (open → closed_*) lands in M18-T04; the recorder only declares the open marker. */
  | { readonly kind: "open_missing_resolution"; readonly resolutionKind: EvvMissingResolutionKind }
  /** §2.4 check-out — auto-close any `open` `missing_checkout` resolution for this visit via
   * `closed_system_checkout_received` (system-driven; no human attestation). Drives the D6 machine in T04. */
  | {
      readonly kind: "close_missing_resolution_system";
      readonly resolutionKind: EvvMissingResolutionKind;
    }
  /** §2.2.4 D6 (T04) — move an `evv_missing_resolution` row to a terminal `closed_*` status (with the
   * optimistic `version` bump, §2.5). The machine emits exactly one of these per close. */
  | { readonly kind: "set_resolution_status"; readonly status: EvvMissingResolutionStatus }
  /** §2.2.4 / §2.3 (T04) — stamp `resolved_by_membership_id` + `resolved_at` on a HUMAN close (clinician
   * self-attest, supervisor override, documented-at-encounter). System closes do not emit this. */
  | { readonly kind: "stamp_resolver" }
  /** §2.4 — persist a denylisted free-text reason on the event / resolution row (§3.6 scrub records `<changed>`). */
  | { readonly kind: "capture_reason"; readonly field: EvvReasonField; readonly value: string };

/** The free-text reason columns a recording / resolution may capture (each denylisted from audit per §3.6). */
export type EvvReasonField = "geofence_breach_reason" | "correction_reason" | "resolution_reason";

/** Collect the outbox event names a side-effect list declares, order-preserving (test/assembly helper). */
export function outboxEvents(effects: readonly EvvSideEffect[]): M18EventName[] {
  return effects
    .filter((e): e is Extract<EvvSideEffect, { kind: "outbox" }> => e.kind === "outbox")
    .map((e) => e.event);
}
