// apps/backend/src/modules/08-encounters/evv-at-sign.ts — GAP-070: the ONE rule for an encounter's EVV bracket
// state at sign time. `encounter.evv_bracket_state` was documented as "populated at finalize" but nothing
// wrote it except the EVV-missing documentation route, so a visit with real M18 check-in/out stayed NULL:
// the sign event reported `evv_present` (NULL coalesced up) while the SignedEncountersReader reported
// `evv_missing_documented` (NULL coalesced down), and M30's HVLDL numerator — which counts only
// `evv_present` — was always 0.
//
// The rule: a stored state wins; otherwise a complete M18 bracket (resolved through the EvvBracketResolver
// seam by the encounter's visit) reifies `evv_present` and is PERSISTED with its authoritative event ids and
// instants (D9: clinician-entered times never override EVV); anything else is `evv_missing_documented`.
// Never `evv_present` without a bracket — EVV-verified is a claim only M18's events can back.
import type { EvvBracketResolution, EvvBracketState } from "@wardenx/types";

/** The column values to write onto the encounter when sign resolved a bracket the row did not yet carry. */
export interface EvvBracketPersistence {
  readonly evvBracketState: "evv_present";
  readonly evvCheckInEventId: string | null;
  readonly evvCheckOutEventId: string | null;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
}

export interface EvvAtSign {
  /** The state the signed event reports AND every reader must agree on. */
  readonly state: EvvBracketState;
  /** Non-null only when sign newly resolved an `evv_present` bracket to persist. */
  readonly persist: EvvBracketPersistence | null;
}

/** NULL on the row means "never resolved", which is NOT evidence of EVV: it reads as missing. */
export function evvStateOrMissing(stored: string | null | undefined): EvvBracketState {
  return stored === "evv_present" ? "evv_present" : "evv_missing_documented";
}

export function deriveEvvAtSign(
  stored: string | null,
  resolution: EvvBracketResolution | null,
): EvvAtSign {
  if (stored !== null) return { state: evvStateOrMissing(stored), persist: null };
  if (resolution?.bracketState !== "evv_present") {
    return { state: "evv_missing_documented", persist: null };
  }
  return {
    state: "evv_present",
    persist: {
      evvBracketState: "evv_present",
      evvCheckInEventId: resolution.checkInEventId,
      evvCheckOutEventId: resolution.checkOutEventId,
      startedAt: resolution.startedAt ? new Date(resolution.startedAt) : null,
      endedAt: resolution.endedAt ? new Date(resolution.endedAt) : null,
    },
  };
}
