// S1 — the draft's seam reads take turns (design §3.2 "Connections"). Each seam read (M7, M9, M12, M39) opens its own pooled transaction while
// the request already holds one (and, on a write, the encounter row lock), so reading four sources at once takes up to six of the pool's
// ten connections for one request. Taking turns caps that at the request's own plus one read. Fakes only: no database.
import { describe, expect, it } from "vitest";
import { createDraftService } from "../src/modules/08-encounters/drafting/draft-service";
import type { DraftSeamPorts } from "../src/modules/08-encounters/drafting/ports";
import { serialSeams } from "../src/modules/08-encounters/drafting/serial-seams";
import { carePlan, change, fakePorts, honestSeries } from "./_encounter-draft-fixtures";
import { memoryRunInOrg } from "./_encounter-draft-memory-store";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Seams that record how many of their reads are in flight at once, each taking `ms` to answer. */
function measured(ms: number) {
  let inFlight = 0;
  const stats = { peak: 0, order: [] as string[] };
  const read =
    <R>(name: string, answer: () => R) =>
    async (): Promise<Awaited<R>> => {
      inFlight += 1;
      stats.peak = Math.max(stats.peak, inFlight);
      stats.order.push(name);
      await pause(ms);
      inFlight -= 1;
      return (await answer()) as Awaited<R>;
    };
  const base = fakePorts({
    carePlanAsOf: read("carePlan", () => carePlan()),
    scaleSeries: async (patientId, scaleType, from, to) => {
      await read("scale", () => null)();
      return honestSeries({})(patientId, scaleType, from, to);
    },
    medicationChangesBetween: read("medications", () => [
      change("started", "2026-11-12T16:00:00.000Z", { id: "order-a" }),
    ]),
    part2DisclosureAllowed: read("part2", () => true),
    electionPeriods: read("periods", () => []),
    levelOfCareOn: read("levelOfCare", () => ({
      admissionId: "a" as never,
      range: { from: "2026-11-18" as never, to: "2026-11-18" as never },
      daysByLevel: {
        routine_home_care: 1,
        continuous_home_care: 0,
        inpatient_respite_care: 0,
        general_inpatient_care: 0,
      },
    })),
    attestedFaceToFace: read("faceToFace", () => null),
    activeCertification: read("certification", () => null),
  });
  return { stats, seams: base as unknown as DraftSeamPorts };
}

describe("serialSeams", () => {
  it("never has two reads in flight, answers each its own result and keeps the order the reads were made in", async () => {
    const { stats, seams } = measured(5);
    const serial = serialSeams(seams);

    const [plan, scaleA, scaleB, meds, part2] = await Promise.all([
      serial.carePlanAsOf(
        "p",
        "routine_visit",
        "rn",
        undefined,
        { actor: { roles: [], membershipId: null } },
        "2026-11-18T00:00:00.000Z",
      ),
      serial.scaleSeries("p", "pps", "1970-01-01T00:00:00.000Z", "2026-11-18T00:00:00.000Z"),
      serial.scaleSeries("p", "esas_r", "1970-01-01T00:00:00.000Z", "2026-11-18T00:00:00.000Z"),
      serial.medicationChangesBetween(
        "o",
        "p",
        "2026-11-01T00:00:00.000Z",
        "2026-11-18T00:00:00.000Z",
      ),
      serial.part2DisclosureAllowed({
        organizationId: "o",
        patientId: "p",
        viewer: { roles: [], membershipId: null },
      }),
    ]);

    expect(stats.peak).toBe(1);
    expect(stats.order).toEqual(["carePlan", "scale", "scale", "medications", "part2"]);
    expect(plan?.goals).toHaveLength(1);
    expect(scaleA.scaleType).toBe("pps");
    expect(scaleB.scaleType).toBe("esas_r");
    expect(meds).toHaveLength(1);
    expect(part2).toBe(true);
  });

  it("takes the four module-6 reads of a recertification draft in turn too (S2)", async () => {
    const { stats, seams } = measured(5);
    const serial = serialSeams(seams);

    await Promise.all([
      serial.electionPeriods("a"),
      serial.levelOfCareOn("a", "2026-11-18"),
      serial.attestedFaceToFace("e"),
      serial.activeCertification("e"),
      serial.part2DisclosureAllowed({
        organizationId: "o",
        patientId: "p",
        viewer: { roles: [], membershipId: null },
      }),
    ]);

    expect(stats.peak).toBe(1);
    expect(stats.order).toEqual(["periods", "levelOfCare", "faceToFace", "certification", "part2"]);
  });

  it("a read that fails fails only itself: the reads queued behind it still run", async () => {
    const seams = fakePorts({
      carePlanAsOf: async () => {
        throw new Error("the care plan is unreachable");
      },
      medicationChangesBetween: async () => [],
    }) as unknown as DraftSeamPorts;
    const serial = serialSeams(seams);

    const outcomes = await Promise.allSettled([
      serial.carePlanAsOf(
        "p",
        "routine_visit",
        "rn",
        undefined,
        { actor: { roles: [], membershipId: null } },
        "2026-11-18T00:00:00.000Z",
      ),
      serial.medicationChangesBetween(
        "o",
        "p",
        "2026-11-01T00:00:00.000Z",
        "2026-11-18T00:00:00.000Z",
      ),
    ]);

    expect(outcomes.map((o) => o.status)).toEqual(["rejected", "fulfilled"]);
  });
});

describe("the draft service reads its sources one at a time", () => {
  it("a draft read for an encounter with a care plan, two scales and medication changes never has two source reads in flight", async () => {
    const { stats, seams } = measured(3);
    const unit = memoryRunInOrg({ previous: new Date("2026-11-10T15:00:00.000Z") });
    const service = createDraftService({
      runInOrg: unit.runInOrg,
      seams: () => seams,
      now: () => new Date("2026-11-18T20:00:00.000Z"),
    });

    const draft = await service.getDraft(
      { organizationId: "o", userId: "u", roles: ["rn"], membershipId: "m" },
      "00000000-0000-4000-8000-000000000004",
    );

    expect(draft.sections.length).toBeGreaterThan(0);
    expect(stats.order.length).toBeGreaterThanOrEqual(4);
    expect(stats.peak).toBe(1);
  });
});
