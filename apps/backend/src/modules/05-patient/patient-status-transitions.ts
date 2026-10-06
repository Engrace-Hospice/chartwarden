// apps/backend/src/modules/05-patient/patient-status-transitions.ts — the two M6-driven edges of the
// §2.4.1 `patient.status` lifecycle, as pure decisions the outbox consumers apply.
//
//   prospective --> active : admission approved (M6)
//   discharged  --> active : re-admission (new election period; M6)
//   active      --> deceased, on_hold --> deceased : death recorded
//
// Nothing applied the first two edges until now, so every patient admitted through the app stayed
// `prospective` for its whole stay and the death cascade (which only knew the `→ deceased` edges)
// dead-lettered on the first death recorded for one of them.

/** Statuses an `m6.admission.activated` promotes to `active` (§2.4.1: admission approved / re-admission).
 *  `active`/`on_hold` are already under care, `deceased`/`merged` are terminal for this chart. */
const PROMOTED_ON_ACTIVATION: ReadonlySet<string> = new Set(["prospective", "discharged"]);

export function activationPromotesToActive(status: string): boolean {
  return PROMOTED_ON_ACTIVATION.has(status);
}

/**
 * How an M6 death discharge applies to the patient row.
 *
 * `active`/`on_hold` are the §2.4.1 `→ deceased` edges. `prospective`/`discharged` are accepted too: M6
 * records a death discharge only against an admission that is under care (§6 ADMISSION graph), so the
 * M6 fact itself proves the patient was admitted — a `prospective`/`discharged` patient row is M5 lagging
 * behind an activation it never applied (or applied late), not a contradiction. Dead-lettering there
 * would strand the bereavement/final-claim cascade on a bookkeeping lag. A `merged` chart is a genuine
 * conflict (the death belongs on the surviving chart) and still dead-letters for a human.
 */
export type DeathTransition = "record" | "already_deceased" | "reject";

const DEATH_RECORDABLE_FROM: ReadonlySet<string> = new Set([
  "active",
  "on_hold",
  "prospective",
  "discharged",
]);

export function deathTransitionFrom(status: string): DeathTransition {
  if (status === "deceased") return "already_deceased";
  return DEATH_RECORDABLE_FROM.has(status) ? "record" : "reject";
}
