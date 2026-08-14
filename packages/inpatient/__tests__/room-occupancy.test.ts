import type { PatientRoomingFacts } from "@wardenx/types";
// GAP-061 — the §2.2 shared-room occupancy gate (route-table row 170). The kernel that computes the
// `roomOccupancyAllowed` fact the admission machine has always accepted and nothing ever produced.
import { describe, expect, it } from "vitest";
import {
  MIXED_SEX_ROOMING_PERMIT_FLAGS,
  evaluateRoomOccupancy,
  isPrivateRoom,
  permitsMixedSexRooming,
  roomOccupancyDenyMessage,
} from "../src/domain/bed/room-occupancy";

const INCOMING = "11111111-1111-1111-1111-111111111111";
const OCCUPANT = "22222222-2222-2222-2222-222222222222";
const OCCUPANT_2 = "33333333-3333-3333-3333-333333333333";

const facts = (
  patientId: string,
  sexClass: PatientRoomingFacts["sexClass"],
  privacyFlags: string[] = [],
): PatientRoomingFacts => ({ patientId, sexClass, privacyFlags });

describe("evaluateRoomOccupancy — the allow paths", () => {
  it("allows a private room regardless of who is already in it", () => {
    const d = evaluateRoomOccupancy({
      roomKind: "private",
      incomingPatientId: INCOMING,
      occupantPatientIds: [OCCUPANT],
      facts: [],
    });
    expect(d.allowed).toBe(true);
    expect(d.denyReason).toBeNull();
  });

  it("allows an EMPTY shared room without needing any M5 fact", () => {
    const d = evaluateRoomOccupancy({
      roomKind: "semi_private",
      incomingPatientId: INCOMING,
      occupantPatientIds: [],
      facts: [],
    });
    expect(d.allowed).toBe(true);
    expect(d.occupantCount).toBe(0);
  });

  it("allows a same-sex shared room", () => {
    const d = evaluateRoomOccupancy({
      roomKind: "semi_private",
      incomingPatientId: INCOMING,
      occupantPatientIds: [OCCUPANT],
      facts: [facts(INCOMING, "female"), facts(OCCUPANT, "female")],
    });
    expect(d.allowed).toBe(true);
    expect(d.occupantCount).toBe(1);
  });

  it("ignores the incoming patient appearing in the occupant list (a re-assign within the room)", () => {
    const d = evaluateRoomOccupancy({
      roomKind: "shared_overflow",
      incomingPatientId: INCOMING,
      occupantPatientIds: [INCOMING],
      facts: [],
    });
    expect(d.allowed).toBe(true);
    expect(d.occupantCount).toBe(0);
  });
});

describe("evaluateRoomOccupancy — the refusals", () => {
  it("refuses an opposite-sex occupant in a semi-private room", () => {
    const d = evaluateRoomOccupancy({
      roomKind: "semi_private",
      incomingPatientId: INCOMING,
      occupantPatientIds: [OCCUPANT],
      facts: [facts(INCOMING, "male"), facts(OCCUPANT, "female")],
    });
    expect(d.allowed).toBe(false);
    expect(d.denyReason).toBe("opposite_sex_occupant");
  });

  it("refuses when ANY occupant of a multi-bed room is opposite-sex", () => {
    const d = evaluateRoomOccupancy({
      roomKind: "shared_overflow",
      incomingPatientId: INCOMING,
      occupantPatientIds: [OCCUPANT, OCCUPANT_2],
      facts: [facts(INCOMING, "male"), facts(OCCUPANT, "male"), facts(OCCUPANT_2, "female")],
    });
    expect(d.allowed).toBe(false);
    expect(d.denyReason).toBe("opposite_sex_occupant");
  });

  it("refuses an UNRECORDED sex rather than treating it as a match — on the incoming patient", () => {
    const d = evaluateRoomOccupancy({
      roomKind: "semi_private",
      incomingPatientId: INCOMING,
      occupantPatientIds: [OCCUPANT],
      facts: [facts(INCOMING, "unspecified"), facts(OCCUPANT, "male")],
    });
    expect(d.allowed).toBe(false);
    expect(d.denyReason).toBe("sex_not_recorded");
  });

  it("refuses TWO unspecified patients — `unspecified` is not a third sex that matches itself", () => {
    const d = evaluateRoomOccupancy({
      roomKind: "semi_private",
      incomingPatientId: INCOMING,
      occupantPatientIds: [OCCUPANT],
      facts: [facts(INCOMING, "unspecified"), facts(OCCUPANT, "unspecified")],
    });
    expect(d.allowed).toBe(false);
    expect(d.denyReason).toBe("sex_not_recorded");
  });

  it("refuses when M5 returned nothing for the incoming patient", () => {
    const d = evaluateRoomOccupancy({
      roomKind: "semi_private",
      incomingPatientId: INCOMING,
      occupantPatientIds: [OCCUPANT],
      facts: [facts(OCCUPANT, "male")],
    });
    expect(d.allowed).toBe(false);
    expect(d.denyReason).toBe("rooming_facts_unavailable");
  });

  it("refuses when M5 returned nothing for an OCCUPANT — a missing roommate is not an empty room", () => {
    const d = evaluateRoomOccupancy({
      roomKind: "semi_private",
      incomingPatientId: INCOMING,
      occupantPatientIds: [OCCUPANT],
      facts: [facts(INCOMING, "male")],
    });
    expect(d.allowed).toBe(false);
    expect(d.denyReason).toBe("rooming_facts_unavailable");
  });

  it("refuses on a wholly empty fact set (the unbound/unreadable-seam path)", () => {
    const d = evaluateRoomOccupancy({
      roomKind: "semi_private",
      incomingPatientId: INCOMING,
      occupantPatientIds: [OCCUPANT],
      facts: [],
    });
    expect(d.allowed).toBe(false);
    expect(d.denyReason).toBe("rooming_facts_unavailable");
  });
});

describe("the privacy-flag permit path", () => {
  it("carries NO permit flag today — every M5 v1 flag is restrictive", () => {
    expect(MIXED_SEX_ROOMING_PERMIT_FLAGS).toEqual([]);
    for (const flag of [
      "sud",
      "hiv",
      "mental_health",
      "genetic",
      "minor_restricted",
      "abuse_victim",
    ]) {
      expect(permitsMixedSexRooming(facts(INCOMING, "male", [flag]))).toBe(false);
    }
  });

  it("is WIRED, not decorative: a patient carrying a permit flag clears an opposite-sex room", () => {
    // Proves the branch is reachable the day M5 publishes a rooming-permit flag — the same code path,
    // driven through the `permitFlags` override rather than by mutating the module constant.
    const d = evaluateRoomOccupancy({
      roomKind: "semi_private",
      incomingPatientId: INCOMING,
      occupantPatientIds: [OCCUPANT],
      facts: [facts(INCOMING, "male", ["mixed_sex_rooming_permitted"]), facts(OCCUPANT, "female")],
      permitFlags: ["mixed_sex_rooming_permitted"],
    });
    expect(d.allowed).toBe(true);
  });

  it("does not let an OCCUPANT's permit flag clear the room — the permit is the incoming patient's", () => {
    const d = evaluateRoomOccupancy({
      roomKind: "semi_private",
      incomingPatientId: INCOMING,
      occupantPatientIds: [OCCUPANT],
      facts: [facts(INCOMING, "male"), facts(OCCUPANT, "female", ["mixed_sex_rooming_permitted"])],
      permitFlags: ["mixed_sex_rooming_permitted"],
    });
    expect(d.allowed).toBe(false);
    expect(d.denyReason).toBe("opposite_sex_occupant");
  });
});

describe("room-kind classification + deny messages", () => {
  it("treats only `private` as single-occupancy", () => {
    expect(isPrivateRoom("private")).toBe(true);
    expect(isPrivateRoom("semi_private")).toBe(false);
    expect(isPrivateRoom("family")).toBe(false);
    expect(isPrivateRoom("shared_overflow")).toBe(false);
  });

  it("gives every deny reason its own message (the coordinator's next action differs)", () => {
    const messages = (
      ["opposite_sex_occupant", "sex_not_recorded", "rooming_facts_unavailable"] as const
    ).map(roomOccupancyDenyMessage);
    expect(new Set(messages).size).toBe(3);
    for (const m of messages) expect(m.length).toBeGreaterThan(0);
  });
});
