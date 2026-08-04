// apps/backend/src/modules/31-portal/telehealth/visit-lifecycle.ts — M31-T05 (§2.2.3, §7.2, §7.3, D8/D14).
//
// The telehealth visit/room lifecycle as a PURE state machine over `TelehealthLifecycleState` (§3.3). The
// happy path (§7.2: room_minted → *_joined → in_progress → ended_clean → reconciled) and the §7.3 negative
// path (a mid-call disconnect → ended_aborted) are the same append-forward graph; the route + webhook layers
// (M31-T06/T07) fold the live join/leave events onto a row through these helpers so an illegal transition
// (e.g. `reconciled` → `in_progress`, a replayed webhook racing the state) is refused rather than forced.
// No clock, no IO — facts in, next state out.
import type { TelehealthEndReason, TelehealthLifecycleState } from "@wardenx/types";
import { requireTelehealth } from "./errors";

/**
 * §2.2.3 / §7.2 / §7.3 — the legal forward transitions. Both join orders are allowed (patient-first waiting
 * room OR clinician-first). Either party can abort from any pre-`ended` state (drop / vendor outage). An ended
 * visit reconciles once M8 signs the encounter (§7.2 step 5 / §7.3 negative path documents attempted-not-done).
 */
export const TELEHEALTH_TRANSITIONS: Record<
  TelehealthLifecycleState,
  readonly TelehealthLifecycleState[]
> = {
  room_minted: ["patient_joined", "clinician_joined", "ended_aborted"],
  patient_joined: ["in_progress", "ended_aborted"],
  clinician_joined: ["in_progress", "ended_aborted"],
  in_progress: ["ended_clean", "ended_aborted"],
  ended_clean: ["reconciled"],
  ended_aborted: ["reconciled"],
  reconciled: [],
};

/** §7.2 / §7.3 — a visit has ended (clean or aborted) but may still reconcile; `reconciled` is terminal. */
export const TELEHEALTH_ENDED_STATES: ReadonlySet<TelehealthLifecycleState> = new Set([
  "ended_clean",
  "ended_aborted",
  "reconciled",
]);

/** True once the visit reached any ended state (§7.2 — M8 attaches the encounter on `visit_ended`). */
export function isTelehealthEnded(state: TelehealthLifecycleState): boolean {
  return TELEHEALTH_ENDED_STATES.has(state);
}

/** True only in the terminal `reconciled` state (the encounter is signed; nothing more happens, §7.2 step 5). */
export function isTelehealthTerminal(state: TelehealthLifecycleState): boolean {
  return state === "reconciled";
}

/** The visit is live — someone can join / the room can be recorded (§7.4 recording precondition). */
export function isTelehealthActive(state: TelehealthLifecycleState): boolean {
  return state === "patient_joined" || state === "clinician_joined" || state === "in_progress";
}

/** §2.2.3 / D8 — is `to` a legal next state from `from`? */
export function canTransitionTelehealth(
  from: TelehealthLifecycleState,
  to: TelehealthLifecycleState,
): boolean {
  return TELEHEALTH_TRANSITIONS[from].includes(to);
}

/** §2.2.3 / D8 — the throwing form the row-update path uses; `TELEHEALTH_INVALID_TRANSITION` (409) on refusal. */
export function assertTelehealthTransition(
  from: TelehealthLifecycleState,
  to: TelehealthLifecycleState,
): void {
  requireTelehealth(
    canTransitionTelehealth(from, to),
    "TELEHEALTH_INVALID_TRANSITION",
    `illegal telehealth lifecycle transition ${from} → ${to}`,
  );
}

/**
 * §7.2 steps 1–4 — fold a participant-join event onto the current state. room_minted advances to the joiner's
 * `*_joined`; the second (opposite) party's join promotes to `in_progress`; a re-join by an already-present
 * party is idempotent (returns the same state). Joining an already-ended visit is an illegal transition.
 */
export function foldParticipantJoin(
  current: TelehealthLifecycleState,
  who: "patient" | "clinician",
): TelehealthLifecycleState {
  requireTelehealth(
    !isTelehealthEnded(current),
    "TELEHEALTH_INVALID_TRANSITION",
    `cannot join a ${current} telehealth visit`,
  );
  if (current === "in_progress") return current; // both already present
  if (current === "room_minted") return who === "patient" ? "patient_joined" : "clinician_joined";
  // A single party is present: the opposite party's join makes it in_progress; a same-party re-join is a no-op.
  if (current === "patient_joined") return who === "clinician" ? "in_progress" : current;
  return who === "patient" ? "in_progress" : current; // current === "clinician_joined"
}

/**
 * §7.3 negative path — derive the `end_reason` for an aborted visit from which party dropped. `vendorOutage`
 * (D14 breaker-open) overrides the party attribution. A clean end is `clean`. PURE.
 */
export function deriveEndReason(input: {
  readonly clean: boolean;
  readonly patientPresentAtEnd: boolean;
  readonly clinicianPresentAtEnd: boolean;
  readonly vendorOutage?: boolean;
}): TelehealthEndReason {
  if (input.clean) return "clean";
  if (input.vendorOutage) return "vendor_outage";
  const patientDropped = !input.patientPresentAtEnd;
  const clinicianDropped = !input.clinicianPresentAtEnd;
  if (patientDropped && clinicianDropped) return "both_dropped";
  if (patientDropped) return "patient_dropped";
  if (clinicianDropped) return "clinician_dropped";
  return "other";
}

/** The end state for a given outcome — `ended_clean` for a normal `meeting-ended`, else `ended_aborted`. */
export function endStateFor(
  clean: boolean,
): Extract<TelehealthLifecycleState, "ended_clean" | "ended_aborted"> {
  return clean ? "ended_clean" : "ended_aborted";
}
