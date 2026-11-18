// M8's billable-encounter range read (M23 claim assembly's input) carries what SIA and the visit lines need:
// how each visit was delivered, whether the clinician confirmed it, and the DOCUMENTED minutes unrounded.
import { describe, expect, it, vi } from "vitest";
import { billableEncountersInRangeForOrg } from "../src/modules/08-encounters/seams/drizzle-store";

const ORG = "11111111-1111-4111-8111-111111111111";
const PE = "22222222-2222-4222-8222-222222222222";
const PATIENT = "33333333-3333-4333-8333-333333333333";

/** A fake DbClient: the tenant transaction's select chain resolves to `rows` at `.where(...)`. */
function fakeDb(rows: unknown[]) {
  const chain = { from: () => chain, where: () => Promise.resolve(rows) };
  const tx = { execute: vi.fn(async () => {}), select: () => chain };
  return { transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)) } as never;
}

const BASE = {
  patientId: PATIENT,
  encounterType: "routine_visit",
  discipline: "rn",
  status: "signed",
  lateEntryTier: "normal",
  significantLateOverrideBy: null,
  administrativeOverrideBy: null,
  serviceDate: "2026-05-05",
  startedAt: null,
  endedAt: null,
  visitModality: null,
  visitModalityConfirmedAt: null,
};

const at = (hhmmss: string): Date => new Date(`2026-05-05T${hhmmss}.000Z`);

async function read(rows: Array<Record<string, unknown>>) {
  const out = await billableEncountersInRangeForOrg(
    fakeDb(rows.map((r, i) => ({ encounterId: `enc-${i}`, ...BASE, ...r }))),
    ORG,
    PE,
    PATIENT,
    { from: "2026-05-01", to: "2026-05-31" },
  );
  return out;
}

describe("billableEncountersInRangeForOrg: delivery facts", () => {
  it("returns visitModality and a confirmed flag derived from the confirmation instant", async () => {
    const [confirmed, seeded, unknown] = await read([
      { visitModality: "in_person", visitModalityConfirmedAt: at("15:00:00") },
      { visitModality: "in_person", visitModalityConfirmedAt: null },
      { visitModality: null, visitModalityConfirmedAt: null },
    ]);
    expect(confirmed).toMatchObject({ visitModality: "in_person", visitModalityConfirmed: true });
    expect(seeded).toMatchObject({ visitModality: "in_person", visitModalityConfirmed: false });
    expect(unknown).toMatchObject({ visitModality: null, visitModalityConfirmed: false });
  });

  it("keeps documented minutes FRACTIONAL: a 52.5 minute visit is 52.5, not 53 or 52", async () => {
    const [row] = await read([{ startedAt: at("14:00:00"), endedAt: at("14:52:30") }]);
    expect(row?.durationMinutes).toBe(52.5);
  });

  it("keeps a sub-minute remainder too (7 min 29 s is not rounded to 7)", async () => {
    const [row] = await read([{ startedAt: at("14:00:00"), endedAt: at("14:07:29") }]);
    expect(row?.durationMinutes).toBeCloseTo(7 + 29 / 60, 10);
  });

  it("is null (unresolved, never zero) for a missing, empty or inverted bracket", async () => {
    const rows = await read([
      { startedAt: at("14:00:00"), endedAt: null },
      { startedAt: null, endedAt: at("14:30:00") },
      { startedAt: at("14:00:00"), endedAt: at("14:00:00") },
      { startedAt: at("14:30:00"), endedAt: at("14:00:00") },
    ]);
    expect(rows.map((r) => r.durationMinutes)).toEqual([null, null, null, null]);
  });

  it("still reports the billability verdict and visit facts alongside", async () => {
    const [row] = await read([{ discipline: "lpn", status: "cosign_pending" }]);
    expect(row).toMatchObject({
      billable: false,
      reason: "awaiting_cosignature",
      discipline: "lpn",
      encounterType: "routine_visit",
      serviceDate: "2026-05-05",
    });
  });
});
