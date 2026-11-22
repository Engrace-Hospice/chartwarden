// No store read of a draft outlives the draft (S5, found by the live suite). The draft's store reads run on the REQUEST's transaction, concurrently with
// the seam reads. When a seam read fails fast, `Promise.all` used to reject at once, the transaction rolled back and its connection went back to the
// pool, while a multi-step store read (`loadSelection`: the selection, the fall, the ADLs, the nutrition) was still issuing queries: they ran on a
// connection that already belonged to the next request, and one of them (an `encounter` select with no tenant GUC set) aborted that request's
// transaction (`25P02`, a 500 for an unrelated caller). So a draft computation settles EVERY read before it answers, failed or not.
// Fake ports and timers only; no database (the live suite of S5 proves it on Postgres).
import { describe, expect, it } from "vitest";
import { computeDraft, snapshotStorePorts } from "../src/modules/08-encounters/drafting/compute";
import { readDraftInputs } from "../src/modules/08-encounters/drafting/inputs";
import { settleAll } from "../src/modules/08-encounters/drafting/unavailable";
import {
  AS_OF,
  EMPTY_SELECTION,
  NOW,
  encounter,
  fakePorts,
  viewer,
} from "./_encounter-draft-fixtures";

const F2F = encounter({ encounterType: "face_to_face", discipline: "np" });
const RN_ROUTINE = encounter({ encounterType: "routine_visit", discipline: "rn" });
const SLOW_MS = 25;

/** A read that answers after `SLOW_MS` and records that it did: the proof it finished before the caller was told of a failure. */
function slow<T>(answer: T) {
  const state = { done: false };
  const read = async (): Promise<T> => {
    await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
    state.done = true;
    return answer;
  };
  return { state, read };
}
const outage = async (): Promise<never> => {
  throw new Error("synthetic upstream outage");
};

describe("a draft computation settles every read before it answers", () => {
  it("computeDraft: a seam read that fails at once does not leave the stored-selection read running", async () => {
    const selection = slow(EMPTY_SELECTION);
    const ports = fakePorts({
      activeMedicationsAsOf: outage,
      loadSelection: selection.read as never,
    });
    await expect(computeDraft(ports, F2F, viewer({ roles: ["np"] }), NOW)).rejects.toMatchObject({
      code: "DRAFT_UNAVAILABLE",
    });
    expect(selection.state.done).toBe(true);
  });

  it("readDraftInputs: a seam read that fails at once does not leave a store read running", async () => {
    const vitals = slow(null);
    const ports = fakePorts({
      activeMedicationsAsOf: outage,
      latestVitals: vitals.read as never,
    });
    await expect(
      readDraftInputs(ports, F2F, viewer({ roles: ["np"] }), AS_OF),
    ).rejects.toMatchObject({ code: "DRAFT_UNAVAILABLE" });
    expect(vitals.state.done).toBe(true);
  });

  it("snapshotStorePorts: a store read that fails at once does not leave the stored-selection read running", async () => {
    const selection = slow(EMPTY_SELECTION);
    const ports = fakePorts({
      latestVitals: outage,
      loadSelection: selection.read as never,
    });
    await expect(snapshotStorePorts(ports, F2F, NOW, true)).rejects.toMatchObject({
      code: "DRAFT_UNAVAILABLE",
    });
    expect(selection.state.done).toBe(true);
  });

  it("readDraftInputs: a scale series that fails at once does not leave the other series read running", async () => {
    const esas = slow({ points: [] });
    const ports = fakePorts({
      scaleSeries: (async (_patientId: string, scale: string) => {
        if (scale === "pps") throw new Error("synthetic upstream outage");
        return esas.read();
      }) as never,
    });
    await expect(
      readDraftInputs(ports, F2F, viewer({ roles: ["np"] }), AS_OF),
    ).rejects.toMatchObject({ code: "DRAFT_UNAVAILABLE" });
    expect(esas.state.done).toBe(true);
  });

  it("readDraftInputs: a care-plan seam that fails at once does not leave the removed-elements store read running", async () => {
    const removed = slow([] as readonly string[]);
    const ports = fakePorts({
      carePlanAsOf: outage,
      removedCarePlanElementIds: removed.read as never,
    });
    await expect(readDraftInputs(ports, RN_ROUTINE, viewer(), AS_OF)).rejects.toMatchObject({
      code: "DRAFT_UNAVAILABLE",
    });
    expect(removed.state.done).toBe(true);
  });

  it("readDraftInputs: a time-zone read that fails at once does not leave the previous-visit store read running", async () => {
    const previous = slow(null);
    const ports = fakePorts({
      organizationTimeZone: outage,
      previousSignedVisitAt: previous.read as never,
    });
    await expect(readDraftInputs(ports, RN_ROUTINE, viewer(), AS_OF)).rejects.toMatchObject({
      code: "DRAFT_UNAVAILABLE",
    });
    expect(previous.state.done).toBe(true);
  });

  it("still reports the FIRST failure in the order the reads are listed, not whichever failed last", async () => {
    const ports = fakePorts({
      latestVitals: async () => {
        throw new Error("the vitals read failed");
      },
      activeMedicationsAsOf: outage,
    });
    const error = await readDraftInputs(ports, F2F, viewer({ roles: ["np"] }), AS_OF).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: "DRAFT_UNAVAILABLE" });
    expect((error as Error).message).toContain("the vitals");
  });

  it("reports the earlier-listed read's failure even when it fails later in time than a later-listed one", async () => {
    const ports = fakePorts({
      latestVitals: async () => {
        await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
        throw new Error("the vitals read failed");
      },
      activeMedicationsAsOf: outage,
    });
    const error = await readDraftInputs(ports, F2F, viewer({ roles: ["np"] }), AS_OF).catch(
      (e: unknown) => e,
    );
    expect((error as Error).message).toContain("the vitals");
  });
});

describe("settleAll", () => {
  it("answers an empty list with an empty list", async () => {
    await expect(settleAll([])).resolves.toEqual([]);
  });

  it("keeps the order of the list, whatever the order the reads answer in, and takes plain values", async () => {
    const late = slow("late");
    await expect(settleAll([late.read(), "plain", Promise.resolve(3)] as const)).resolves.toEqual([
      "late",
      "plain",
      3,
    ]);
  });

  it("throws the first failure in the order given, after every read has settled", async () => {
    const late = slow("late");
    const failing = async (message: string): Promise<never> => {
      throw new Error(message);
    };
    await expect(
      settleAll([late.read(), failing("first listed"), failing("second listed")]),
    ).rejects.toThrow("first listed");
    expect(late.state.done).toBe(true);
  });
});
