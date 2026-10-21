// apps/backend/src/modules/08-encounters/authoring/f2f.ts — M8-T10 (§7.4, D1).
//
// The MD/NP Face-to-Face dual-write coordination. Per D1 (this module) / D2 (M6): a `face_to_face`
// encounter signs as ONE atomic unit that writes BOTH sides — M8's clinical note encounter and M6's
// `face_to_face_encounter` compliance-attestation row (status `attested`, back-referencing the M8
// encounter id). M8 does NOT own the 30-day window math, the period-N applicability rules, or the
// override path — all that is M6 (§7.4). M8 owns only: (a) the clinical encounter sign transition, and
// (b) producing the cross-module attestation WRITE REQUEST as a plain descriptor — never a direct import
// of M6's schema, so no `dependsOn` edge is created. The composition layer hands the descriptor to M6's
// writer; both commit or both abort. The abort is structural: `transitionEncounter` throws on a failed
// Layer-3 gate or stale step-up, so the plan (and therefore the M6 write) is never produced.
import type { EncounterDiscipline, FaceToFaceEncounterId, LocalDate } from "@chartwarden/types";
import {
  type EncounterState,
  type EncounterTransition,
  transitionEncounter,
} from "../lifecycle/encounter";

/**
 * The cross-module write M8 asks M6 to perform inside the same transaction (D1). A plain data
 * descriptor — M6's writer (or the composition root) executes it; M8 never touches M6's tables.
 */
export interface F2fAttestationWrite {
  readonly kind: "create_f2f_attestation";
  /** The M8 encounter the M6 row back-references via `face_to_face_encounter.encounter_id`. */
  readonly encounterId: string;
  /** The logical M6 `face_to_face_encounter` id carried on the encounter for the dual-write (D1). */
  readonly faceToFaceEncounterId: FaceToFaceEncounterId;
  /** The compliance row lands directly in `attested` — the MD/NP completed both panels (§7.4). */
  readonly status: "attested";
}

/** The facts the dual-write needs (resolved upstream; the F2F encounter is always MD/NP → no cosign). */
export interface F2fDualWriteFacts {
  readonly status: EncounterState;
  readonly encounterId: string;
  /** Populated in the same tx (§2.7 `F2F_DUAL_WRITE_REQUIRED` when absent). */
  readonly faceToFaceEncounterId: FaceToFaceEncounterId | null;
  readonly discipline: EncounterDiscipline;
  /** Layer-3 gate verdict — a failure aborts BOTH sides (no plan returned). */
  readonly gatePassed: boolean;
  /** D13 step-up freshness — a stale step-up aborts BOTH sides. */
  readonly stepUpFresh: boolean;
  readonly at: LocalDate;
}

/** The atomic F2F dual-write plan: the M8 sign transition + the M6 attestation write request. */
export interface F2fDualWritePlan {
  readonly encounter: EncounterTransition;
  readonly attestation: F2fAttestationWrite;
}

/**
 * Plan the F2F dual-write (§7.4, D1). Runs the M8 sign transition with `isF2f` set so the §2.7
 * `F2F_DUAL_WRITE_REQUIRED` guard fires when the M6 id is absent, then pairs it with the M6 attestation
 * write descriptor. Throws (via `transitionEncounter`) on a failed gate / stale step-up — the structural
 * abort that keeps the two sides consistent.
 */
export function planF2fDualWrite(facts: F2fDualWriteFacts): F2fDualWritePlan {
  const encounter = transitionEncounter(facts.status, {
    type: "sign",
    discipline: facts.discipline,
    gatePassed: facts.gatePassed,
    stepUpFresh: facts.stepUpFresh,
    isF2f: true,
    f2fDualWriteSatisfied: facts.faceToFaceEncounterId !== null,
    eligibleCosignerExists: true, // MD/NP never route to cosignature (§2.3)
    at: facts.at,
  });
  // The guard above guarantees a non-null id here; narrow for the descriptor.
  const faceToFaceEncounterId = facts.faceToFaceEncounterId as FaceToFaceEncounterId;
  return {
    encounter,
    attestation: {
      kind: "create_f2f_attestation",
      encounterId: facts.encounterId,
      faceToFaceEncounterId,
      status: "attested",
    },
  };
}
