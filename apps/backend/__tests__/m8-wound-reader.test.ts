// WF09 — M8's read of the wounds recorded on a visit goes through M9's `WoundProvider` seam and states only what the visit recorded.
import { afterEach, describe, expect, it } from "vitest";
import { NotImplementedError, __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import { woundProviderDenyStub } from "../src/bootstrap/seams/providers";
import { noWoundReader, seamWoundReader } from "../src/modules/08-encounters/wound-reader";

const args = { organizationId: "org-1", encounterId: "enc-1", patientId: "pat-1" };

const view = {
  observationId: "obs-1",
  woundId: "wound-1",
  observedAt: "2026-11-18T14:00:00.000Z",
  site: "sacrum",
  etiology: "pressure_injury",
  stage: "stage_2",
  lengthCm: 2.5,
  widthCm: 1.5,
  depthCm: null,
  undermining: null,
  woundBed: ["granulation"],
  exudateAmount: "scant",
  exudateType: "serous",
  odor: "none",
  periwound: ["intact"],
  painScore: 2,
  dressing: "foam",
  dressingChanged: true,
  infectionSigns: false,
  trend: "improving",
} as const;

afterEach(() => __resetSeamsForTest());

describe("seamWoundReader", () => {
  it("FAILS CLOSED when M9 is not wired: an unregistered seam is an error, never 'no wounds'", async () => {
    __resetSeamsForTest();
    await expect(seamWoundReader.woundsForEncounter(args)).rejects.toThrow(
      /requested before registration/,
    );
  });

  it("FAILS CLOSED on the Phase-0 deny stub: a boot that never wired M9 cannot finalize a note without its wounds", async () => {
    registerSeam("WoundProvider", woundProviderDenyStub);
    await expect(seamWoundReader.woundsForEncounter(args)).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });

  it("a composition with no M9 states no wounds only by passing noWoundReader by name", async () => {
    __resetSeamsForTest();
    await expect(noWoundReader.woundsForEncounter(args)).resolves.toEqual([]);
  });

  it("hands the seam the encounter and its patient, and returns each observation without its ids", async () => {
    const calls: unknown[][] = [];
    registerSeam("WoundProvider", {
      async listObservationsForEncounter(...a) {
        calls.push(a);
        return [view];
      },
    });
    const wounds = await seamWoundReader.woundsForEncounter(args);
    expect(calls).toEqual([["org-1", "enc-1", { userId: "" }, { patientId: "pat-1" }]]);
    expect(wounds).toHaveLength(1);
    expect(wounds[0]).toMatchObject({
      site: "sacrum",
      etiology: "pressure_injury",
      stage: "stage_2",
    });
    expect(Object.keys(wounds[0] ?? {})).not.toEqual(
      expect.arrayContaining(["observationId", "woundId", "observedAt"]),
    );
  });

  it("lets any other failure through, so a note is never finalized without the wounds recorded", async () => {
    registerSeam("WoundProvider", {
      async listObservationsForEncounter() {
        throw new Error("database unavailable");
      },
    });
    await expect(seamWoundReader.woundsForEncounter(args)).rejects.toThrow("database unavailable");
  });
});
