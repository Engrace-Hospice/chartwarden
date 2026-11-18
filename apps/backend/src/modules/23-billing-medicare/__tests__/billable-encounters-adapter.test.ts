// The M23 boundary over M8's billable-encounter reader: what the SIA engine and the visit lines read about each visit. The
// delivery mode and who supplied the documented minutes cross here, and an absent value must read as UNKNOWN (never as an
// in-person, EVV-verified visit): a reader that predates visit delivery has to leave a visit uncounted, not counted.
import { describe, expect, it } from "vitest";
import {
  type M8BillableEncountersReader,
  buildM23BillableEncountersAdapter,
} from "../services/claim-assembly-seam-adapters";

const RANGE = { from: "2026-01-01", to: "2026-01-31" } as const;

type Rows = Awaited<ReturnType<M8BillableEncountersReader["inRange"]>>;

const row = (over: Record<string, unknown> = {}): Rows[number] =>
  ({
    encounterId: "11111111-1111-4111-8111-111111111111",
    billable: true,
    serviceDate: "2026-01-15",
    discipline: "rn",
    encounterType: "routine_visit",
    durationMinutes: 45,
    ...over,
  }) as Rows[number];

const read = async (rows: Rows) =>
  buildM23BillableEncountersAdapter({ inRange: async () => rows }).forRange(
    "org",
    "pe",
    "patient",
    RANGE,
  );

describe("buildM23BillableEncountersAdapter: delivery facts", () => {
  it("carries the confirmed delivery mode and who supplied the documented minutes", async () => {
    const [visit] = await read([
      row({ visitModality: "in_person", visitModalityConfirmed: true, timeSource: "clinician" }),
    ]);
    expect(visit).toMatchObject({
      modality: "in_person",
      modalityConfirmed: true,
      timeSource: "clinician",
      durationMinutes: 45,
    });
  });

  it("reads an absent delivery mode, confirmation or time source as unknown, never as in person or EVV", async () => {
    const [visit] = await read([row()]);
    expect(visit).toMatchObject({ modality: null, modalityConfirmed: false, timeSource: null });
  });

  it("does not read a seeded-but-unconfirmed mode as confirmed", async () => {
    const [visit] = await read([
      row({ visitModality: "in_person", visitModalityConfirmed: false }),
    ]);
    expect(visit).toMatchObject({ modality: "in_person", modalityConfirmed: false });
  });
});
