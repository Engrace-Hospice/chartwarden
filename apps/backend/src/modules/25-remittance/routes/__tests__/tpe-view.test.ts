// M25 milestone 5 — the TPE read model: an empty round carries no sample-size warning; a started sample outside
// 20 to 40 does.
import { describe, expect, it } from "vitest";
import { detailOfProgram } from "../tpe-view";

const program = {
  id: "p",
  providerEntityId: "pe",
  macName: "CGS",
  openedOn: "2026-01-01",
  state: "active",
  outcomeOn: null,
  reliefUntil: null,
  referralKinds: [],
  version: 1,
};
const round = {
  id: "r1",
  tpeProgramId: "p",
  roundNumber: 1,
  noticeOn: "2026-02-01",
  resultsOn: null,
  macErrorRatePct: null,
  macResult: null,
  thresholdPct: null,
  thresholdSource: null,
  thresholdVerified: false,
  educationOn: null,
  educationNote: null,
  version: 1,
};
const claim = (n: number) => ({
  id: `c${n}`,
  tpeRoundId: "r1",
  claimId: `claim${n}`,
  adrCaseId: null,
  result: "pending",
  version: 1,
});

describe("detailOfProgram sample-size warning", () => {
  it("has none while a round has no sampled claims", () => {
    const detail = detailOfProgram(program, [round], [], [], new Map());
    expect(detail.rounds[0]?.warnings).toEqual([]);
  });
  it("warns once a started sample is outside 20 to 40", () => {
    const detail = detailOfProgram(program, [round], [claim(1)], [], new Map());
    expect(detail.rounds[0]?.warnings.join(" ")).toMatch(/1 claims sampled/);
  });
  it("is quiet for a sample of 20", () => {
    const claims = Array.from({ length: 20 }, (_, i) => claim(i));
    expect(detailOfProgram(program, [round], claims, [], new Map()).rounds[0]?.warnings).toEqual(
      [],
    );
  });
});
