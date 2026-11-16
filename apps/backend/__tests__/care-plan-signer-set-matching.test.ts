// apps/backend/__tests__/care-plan-signer-set-matching.test.ts — M7 Required Signer Set quorum matching
// (11b) and tightened-set satisfiability (11a). Pure: no DB. A signature fills at most one slot and the
// quorum is met iff SOME assignment of signatures to slots exists (bipartite matching), never a greedy
// first-fit that depends on signing order.
import { REQUIRED_SIGNER_SET_INITIAL, type RequiredSignerSet } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  decideRecordSignature,
  isQuorumMet,
  resolveTightenedSignerSet,
} from "../src/modules/07-care-plan/lifecycle/required-signer-set";

// The overlapping set from the finding: the union slot and the explicit NP slot compete for the NP.
const OVERLAP: RequiredSignerSet = [
  { role: "hospice_physician|nurse_practitioner", count: 1 },
  { role: "rn_case_manager", count: 1 },
  { role: "nurse_practitioner", count: 1 },
];

describe("quorum matching over overlapping union slots (11b)", () => {
  it("accepts the NP after the physician even though the union slot could also take the NP", () => {
    // Greedy consumed the NP into the union slot (the physician was already there), left the explicit
    // NP slot unmet and threw DUPLICATE_SIGNER_ROLE although physician→union, NP→NP is valid.
    const decision = decideRecordSignature(OVERLAP, ["hospice_physician"], "nurse_practitioner");
    expect(decision.quorumMet).toBe(false);
    expect(
      decideRecordSignature(OVERLAP, ["hospice_physician", "nurse_practitioner"], "rn_case_manager")
        .quorumMet,
    ).toBe(true);
  });

  it("is signing-order independent: every permutation of the three seats meets the quorum", () => {
    const orders: ReadonlyArray<
      ReadonlyArray<"hospice_physician" | "nurse_practitioner" | "rn_case_manager">
    > = [
      ["hospice_physician", "nurse_practitioner", "rn_case_manager"],
      ["hospice_physician", "rn_case_manager", "nurse_practitioner"],
      ["nurse_practitioner", "hospice_physician", "rn_case_manager"],
      ["nurse_practitioner", "rn_case_manager", "hospice_physician"],
      ["rn_case_manager", "hospice_physician", "nurse_practitioner"],
      ["rn_case_manager", "nurse_practitioner", "hospice_physician"],
    ];
    for (const order of orders) {
      const signed: Array<(typeof order)[number]> = [];
      let met = false;
      for (const role of order) {
        met = decideRecordSignature(OVERLAP, signed, role).quorumMet;
        signed.push(role);
      }
      expect(met, order.join(">")).toBe(true);
    }
  });

  it("isQuorumMet needs the NP to fill the explicit slot: physician + RN alone is not a quorum", () => {
    expect(isQuorumMet(OVERLAP, ["hospice_physician", "rn_case_manager"])).toBe(false);
    expect(isQuorumMet(OVERLAP, ["nurse_practitioner", "rn_case_manager"])).toBe(false);
    expect(
      isQuorumMet(OVERLAP, ["hospice_physician", "nurse_practitioner", "rn_case_manager"]),
    ).toBe(true);
  });

  it("still rejects a true duplicate and a role outside the set", () => {
    expect(() =>
      decideRecordSignature(
        REQUIRED_SIGNER_SET_INITIAL,
        ["hospice_physician"],
        "nurse_practitioner",
      ),
    ).toThrow(expect.objectContaining({ code: "DUPLICATE_SIGNER_ROLE" }));
    expect(() => decideRecordSignature(REQUIRED_SIGNER_SET_INITIAL, [], "chaplain")).toThrow(
      expect.objectContaining({ code: "SIGNER_ROLE_MISMATCH" }),
    );
  });

  it("the floor INITIAL set still completes with physician + RN in either order", () => {
    expect(
      isQuorumMet(REQUIRED_SIGNER_SET_INITIAL, ["rn_case_manager", "nurse_practitioner"]),
    ).toBe(true);
    expect(isQuorumMet(REQUIRED_SIGNER_SET_INITIAL, ["nurse_practitioner"])).toBe(false);
  });
});

describe("tightened set must be satisfiable with one signature per role (11a)", () => {
  it("rejects a slot with count > 1 — one live signature per (version, signer_role) can never meet it", () => {
    expect(() =>
      resolveTightenedSignerSet(REQUIRED_SIGNER_SET_INITIAL, [
        { role: "hospice_physician|nurse_practitioner", count: 1 },
        { role: "rn_case_manager", count: 1 },
        { role: "msw", count: 2 },
      ]),
    ).toThrow(expect.objectContaining({ code: "REQUIRED_SIGNER_SET_UNMET" }));
  });

  it("rejects a floor slot widened to count 2 (floor check alone allowed count >= floor)", () => {
    expect(() =>
      resolveTightenedSignerSet(REQUIRED_SIGNER_SET_INITIAL, [
        { role: "hospice_physician|nurse_practitioner", count: 1 },
        { role: "rn_case_manager", count: 2 },
      ]),
    ).toThrow(expect.objectContaining({ code: "REQUIRED_SIGNER_SET_UNMET" }));
  });

  it("rejects a non-integer count", () => {
    expect(() =>
      resolveTightenedSignerSet(REQUIRED_SIGNER_SET_INITIAL, [
        ...REQUIRED_SIGNER_SET_INITIAL,
        { role: "msw", count: 1.5 },
      ]),
    ).toThrow(expect.objectContaining({ code: "REQUIRED_SIGNER_SET_UNMET" }));
  });

  it("rejects two slots that can only be filled by the same single role", () => {
    // Floor-covering, every count 1, yet two seats both need an rn_case_manager: never satisfiable.
    expect(() =>
      resolveTightenedSignerSet(REQUIRED_SIGNER_SET_INITIAL, [
        ...REQUIRED_SIGNER_SET_INITIAL,
        { role: "rn_case_manager", count: 1 },
      ]),
    ).toThrow(expect.objectContaining({ code: "REQUIRED_SIGNER_SET_UNMET" }));
  });

  it("accepts the overlapping union + explicit NP set (physician and NP are distinct roles)", () => {
    expect(resolveTightenedSignerSet(REQUIRED_SIGNER_SET_INITIAL, OVERLAP)).toEqual(OVERLAP);
  });

  it("accepts plain tightening with distinct extra roles", () => {
    const tightened = [...REQUIRED_SIGNER_SET_INITIAL, { role: "msw", count: 1 }];
    expect(resolveTightenedSignerSet(REQUIRED_SIGNER_SET_INITIAL, tightened)).toEqual(tightened);
  });
});
