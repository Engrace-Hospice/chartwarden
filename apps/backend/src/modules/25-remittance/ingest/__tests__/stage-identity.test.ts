// A stage row's ISA06/ISA08/GS06 vs the sealed transaction set it was staged from. A NULL column (a stage staged before
// migration 1508 added them) is unrecorded, not different; a recorded value that disagrees is a real mismatch.
import { describe, expect, it } from "vitest";
import { stageIdentityDiffersFromSealedSet } from "../advice-envelope-identity";

const sealed = {
  interchangeSenderCode: "SYNTHSENDER",
  interchangeReceiverCode: "SYNTHRECEIVER",
  functionalGroupControlNumber: "941",
};
const recorded = {
  interchangeSenderCode: "SYNTHSENDER",
  interchangeReceiverCode: "SYNTHRECEIVER",
  functionalGroupControlNumber: "941",
};

describe("stageIdentityDiffersFromSealedSet", () => {
  it("agrees when every recorded column matches the sealed set", () => {
    expect(stageIdentityDiffersFromSealedSet(recorded, sealed)).toBe(false);
  });

  it("treats NULL columns (a stage staged before migration 1508) as unrecorded, not as a mismatch", () => {
    const preMigration = {
      interchangeSenderCode: null,
      interchangeReceiverCode: null,
      functionalGroupControlNumber: null,
    };
    expect(stageIdentityDiffersFromSealedSet(preMigration, sealed)).toBe(false);
  });

  it.each([
    ["ISA06", { ...recorded, interchangeSenderCode: "OTHERSENDER" }],
    ["ISA08", { ...recorded, interchangeReceiverCode: "OTHERRECEIVER" }],
    ["GS06", { ...recorded, functionalGroupControlNumber: "942" }],
  ])("still refuses a recorded %s that disagrees with the sealed set", (_name, stage) => {
    expect(stageIdentityDiffersFromSealedSet(stage, sealed)).toBe(true);
  });

  it("refuses a recorded value the sealed set does not carry at all", () => {
    expect(
      stageIdentityDiffersFromSealedSet(recorded, {
        interchangeSenderCode: undefined,
        interchangeReceiverCode: "SYNTHRECEIVER",
        functionalGroupControlNumber: "941",
      }),
    ).toBe(true);
  });
});
