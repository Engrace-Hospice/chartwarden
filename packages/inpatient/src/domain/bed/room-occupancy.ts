// @chartwarden/inpatient — M37 §2.2, route-table row 170. The shared-room occupancy gate: may this patient
// be placed in this bed, given who is already in the room? GAP-061.
//
// The admission machine has always accepted a `roomOccupancyAllowed` fact on its `assignBed` event and
// refused the transition when it is false (`IPU_ROOM_OCCUPANCY_CONFLICT` — the spec's route schema names
// this failure `BED_GENDER_MISMATCH`). Nothing ever computed the fact: the route hard-coded `true`, so
// every assignment passed. This kernel computes it. Pure & IO-free — the route resolves the room, the
// current occupants and their M5 rooming facts, and hands them in.
import type { PatientRoomingFacts, PatientSexClass } from "@chartwarden/types";

/** The `ipu_room.kind` values (§3.3 / the `ipu_room_kind` enum), mirrored leaf-side. */
export type IpuRoomKindValue = "private" | "semi_private" | "family" | "shared_overflow";

/**
 * Which room kinds hold ONE patient at a time. Only `private` does — the §2.1 privacy classification.
 * `family` is non-bed-bearing visitor space and `shared_overflow` is surge capacity; if either ever
 * carries a bed, it is shared space and the gate applies.
 */
export function isPrivateRoom(kind: IpuRoomKindValue): boolean {
  return kind === "private";
}

/** Why a shared-room placement was refused (recorded on the refusal; no PHI — no ids, no names). */
export type RoomOccupancyDenyReason =
  /** A current occupant's sex class differs from the incoming patient's. */
  | "opposite_sex_occupant"
  /** The incoming patient's or an occupant's sex is not recorded as male or female, so same-sex
   *  occupancy cannot be PROVEN. Refused rather than assumed. */
  | "sex_not_recorded"
  /** M5 returned no rooming facts for someone in the decision (incoming patient or an occupant). */
  | "rooming_facts_unavailable";

export interface RoomOccupancyDecision {
  readonly allowed: boolean;
  readonly denyReason: RoomOccupancyDenyReason | null;
  /** How many other patients the room already holds (0 → the gate is vacuously satisfied). */
  readonly occupantCount: number;
}

/**
 * The privacy flags that PERMIT mixed-sex shared occupancy — the spec's "unless … the patient privacy
 * flag permits" escape hatch.
 *
 * EMPTY, and that is a statement about the data, not a placeholder. Every flag in M5's v1 vocabulary
 * (`sud`, `hiv`, `mental_health`, `genetic`, `minor_restricted`, `abuse_victim` — §3.5) is RESTRICTIVE:
 * each one records a category whose disclosure is limited. None of them grants a rooming permission,
 * and inventing a mapping from, say, `abuse_victim` to "may share a room with the opposite sex" would
 * inverse the flag's meaning. The permit path is wired and tested against this list, so the day M5 adds
 * a genuine rooming-permit flag it becomes real by adding the name here.
 */
export const MIXED_SEX_ROOMING_PERMIT_FLAGS: readonly string[] = [];

/** Does this patient carry a flag that permits mixed-sex shared occupancy? `permitFlags` is a parameter
 *  so the branch is drivable without mutating the module constant (and so a tenant overlay could one day
 *  supply its own list); it defaults to {@link MIXED_SEX_ROOMING_PERMIT_FLAGS}. */
export function permitsMixedSexRooming(
  facts: PatientRoomingFacts,
  permitFlags: readonly string[] = MIXED_SEX_ROOMING_PERMIT_FLAGS,
): boolean {
  return facts.privacyFlags.some((f) => permitFlags.includes(f));
}

export interface RoomOccupancyInput {
  /** The kind of the room the target bed sits in. */
  readonly roomKind: IpuRoomKindValue;
  /** The patient being assigned. */
  readonly incomingPatientId: string;
  /** The patients currently holding a bed in the SAME room (excluding the incoming patient). */
  readonly occupantPatientIds: readonly string[];
  /** M5's rooming facts, for the incoming patient and every occupant. Absent entries fail closed. */
  readonly facts: readonly PatientRoomingFacts[];
  /** Overrides {@link MIXED_SEX_ROOMING_PERMIT_FLAGS} (see {@link permitsMixedSexRooming}). */
  readonly permitFlags?: readonly string[];
}

/**
 * §2.2 — decide whether `assignBed` may place the incoming patient in this room.
 *
 * A private room, or a shared room with no other occupant, is allowed without consulting anyone. For a
 * shared room that already holds someone: every occupant must be the same recorded sex class as the
 * incoming patient, unless the incoming patient carries a permit flag.
 *
 * FAIL-CLOSED on three unknowns — a missing M5 answer, an unrecorded sex on the incoming patient, and
 * an unrecorded sex on an occupant. `unspecified` is not a third sex that matches other `unspecified`
 * patients: it means the record cannot prove same-sex occupancy, and a charge nurse who needs the
 * placement anyway has the private-room path and the recorded-sex correction path. Silently pairing two
 * `UNK` patients would let the default value of a required column decide who shares a room.
 */
export function evaluateRoomOccupancy(input: RoomOccupancyInput): RoomOccupancyDecision {
  const occupants = input.occupantPatientIds.filter((id) => id !== input.incomingPatientId);
  const occupantCount = occupants.length;
  if (isPrivateRoom(input.roomKind) || occupantCount === 0) {
    return { allowed: true, denyReason: null, occupantCount };
  }

  const byId = new Map(input.facts.map((f) => [f.patientId, f]));
  const incoming = byId.get(input.incomingPatientId);
  if (!incoming) {
    return { allowed: false, denyReason: "rooming_facts_unavailable", occupantCount };
  }
  if (permitsMixedSexRooming(incoming, input.permitFlags)) {
    return { allowed: true, denyReason: null, occupantCount };
  }
  if (incoming.sexClass === "unspecified") {
    return { allowed: false, denyReason: "sex_not_recorded", occupantCount };
  }

  const incomingSex: PatientSexClass = incoming.sexClass;
  for (const occupantId of occupants) {
    const occupant = byId.get(occupantId);
    if (!occupant) {
      return { allowed: false, denyReason: "rooming_facts_unavailable", occupantCount };
    }
    if (occupant.sexClass === "unspecified") {
      return { allowed: false, denyReason: "sex_not_recorded", occupantCount };
    }
    if (occupant.sexClass !== incomingSex) {
      return { allowed: false, denyReason: "opposite_sex_occupant", occupantCount };
    }
  }
  return { allowed: true, denyReason: null, occupantCount };
}

/** The human-readable half of the refusal (the machine's error message; structural, no PHI). */
export function roomOccupancyDenyMessage(reason: RoomOccupancyDenyReason): string {
  switch (reason) {
    case "opposite_sex_occupant":
      return "The room already holds a patient of a different recorded sex, and this is not a private room.";
    case "sex_not_recorded":
      return "A shared room needs a recorded sex for the incoming patient and every current occupant; at least one is unrecorded.";
    case "rooming_facts_unavailable":
      return "The patient rooming facts (M5) could not be read, so shared-room occupancy cannot be cleared.";
  }
}
