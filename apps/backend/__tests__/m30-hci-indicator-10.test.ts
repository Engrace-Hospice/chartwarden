// apps/backend/__tests__/m30-hci-indicator-10.test.ts — HCI indicator 10 (visits near death).
//
// The first HCI indicator to resolve from live seams. It reuses the SAME two the HVLDL path uses (M6's
// death-discharge census, M8's signed-encounter digests) but deliberately NOT the same predicate: HVLDL
// additionally requires an EVV-verified visit from a qualifying discipline and counts visits per decedent
// against a minimum. HCI-10 asks the looser CMS question — was this decedent visited at all in the window.
//
// Sharing HVLDL's filters would silently make HCI-10 stricter than CMS defines and depress the score, so
// the difference is pinned here rather than left to a reader of the two resolvers.
import { describe, expect, it } from "vitest";
import { computeHciIndicator10 } from "@wardenx/quality";
import { resolveHciIndicator10Input } from "../src/modules/30-quality/jobs/m30-jobs";

const REQUEST = {
  registration: { code: "hci_indicator_10" } as never,
  organizationId: "org-1",
  providerEntityId: "pe-1",
  periodStart: "2026-01-01T00:00:00.000Z",
  periodEnd: "2026-04-01T00:00:00.000Z",
};

type Death = { patientId: string; deathAt: string; source: string; cosignStatus: string };

function seams(deaths: Death[], digestsByPatient: Record<string, { serviceDate: string; discipline?: string; evvBracketState?: string }[]>) {
  return {
    deathDischargeReader: { async listDeathDischargesInPeriod() { return deaths; } },
    encounters: {
      async signedEncountersForPatientSince(_org: string, patientId: string) {
        return digestsByPatient[patientId] ?? [];
      },
      async renderPayloadFor() { throw new Error("unused"); },
      async lateEntryCountsForOrg() { throw new Error("unused"); },
    },
  } as never;
}

const death = (patientId: string, deathAt: string): Death => ({
  patientId,
  deathAt,
  source: "pronouncement",
  cosignStatus: "not_required",
});

describe("HCI indicator 10 — visits near death", () => {
  it("counts a decedent visited inside the window, and keeps unvisited decedents in the denominator", async () => {
    const input = await resolveHciIndicator10Input(
      REQUEST,
      seams(
        [death("p1", "2026-02-10T12:00:00.000Z"), death("p2", "2026-02-20T12:00:00.000Z")],
        { p1: [{ serviceDate: "2026-02-09" }] }, // p2 has no visits at all
      ),
    );
    expect(input).toMatchObject({ totalDecedents: 2, decedentsWithNearDeathVisits: 1 });

    const result = computeHciIndicator10(input as never);
    expect(result.denominator).toBe(2);
    expect(result.rate).toBeCloseTo(0.5);
  });

  it("does NOT apply HVLDL's EVV / qualifying-discipline filters (HCI-10 is the looser question)", async () => {
    const input = await resolveHciIndicator10Input(
      REQUEST,
      seams([death("p1", "2026-02-10T12:00:00.000Z")], {
        // A visit HVLDL would REJECT: no EVV bracket, and a discipline outside its qualifying set.
        p1: [{ serviceDate: "2026-02-09", discipline: "chaplain", evvBracketState: "evv_absent" }],
      }),
    );
    expect(input).toMatchObject({ totalDecedents: 1, decedentsWithNearDeathVisits: 1 });
  });

  it("excludes a visit dated AFTER the death date", async () => {
    const input = await resolveHciIndicator10Input(
      REQUEST,
      seams([death("p1", "2026-02-10T12:00:00.000Z")], {
        p1: [{ serviceDate: "2026-02-11" }], // charted after death — not a near-death visit
      }),
    );
    expect(input).toMatchObject({ totalDecedents: 1, decedentsWithNearDeathVisits: 0 });
  });

  it("a period with no deaths SUPPRESSES rather than scoring 0% or 100%", async () => {
    const input = await resolveHciIndicator10Input(REQUEST, seams([], {}));
    const result = computeHciIndicator10(input as never);
    expect(result.denominator).toBe(0);
    expect(result.rate).toBeNull();
    expect(result.bandColor).toBe("insufficient_n");
  });
});
