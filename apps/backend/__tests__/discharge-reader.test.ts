// apps/backend/__tests__/discharge-reader.test.ts — the M6 DischargeReader Drizzle impl (M30 HCI
// indicators 3/4's early/late live-discharge counts). A fake scoped db drives the reader's
// `select().from().innerJoin().where()` chain and the test asserts the day-since-admission
// classification — the actual point of this reader, not just that it queried the right tables.
import type { DbClient } from "@wardenx/db";
import { describe, expect, it } from "vitest";
import { createDischargeReader } from "../src/modules/06-admission/index";

interface FakeRow {
  dischargeType: string;
  effectiveAt: string; // date column → string
  admissionAt: Date | null;
}

function makeFakeDb(rows: FakeRow[]): DbClient {
  const tx = {
    async execute() {
      return undefined;
    },
    select() {
      return {
        from() {
          return {
            innerJoin() {
              return { where: () => Promise.resolve(rows) };
            },
          };
        },
      };
    },
  };
  const db = {
    async transaction<R>(fn: (t: typeof tx) => Promise<R>): Promise<R> {
      return fn(tx);
    },
  };
  return db as unknown as DbClient;
}

const period = { from: "2026-01-01T00:00:00.000Z", to: "2026-04-01T00:00:00.000Z" };

describe("DischargeReader (M30 HCI indicators 3/4)", () => {
  it("counts every discharge (live + death) in totalDischarges but only classifies LIVE ones", async () => {
    const db = makeFakeDb([
      { dischargeType: "death", effectiveAt: "2026-02-01", admissionAt: new Date("2026-01-25T00:00:00.000Z") },
      { dischargeType: "transfer", effectiveAt: "2026-02-01", admissionAt: new Date("2026-01-30T00:00:00.000Z") },
    ]);
    const out = await createDischargeReader(db).liveDischargeTimingCounts("org-1", period);
    // death discharge (day 7) is NOT classified early/late even though it'd otherwise qualify — it's a
    // death, not a live discharge, so it stays out of both live-discharge numerators.
    expect(out.totalDischarges).toBe(2);
    expect(out.earlyLiveDischarges).toBe(1); // the transfer, at day 2
    expect(out.lateLiveDischarges).toBe(0);
  });

  it("classifies a live discharge on day 7 as early, and day 6 also early (on-or-before)", async () => {
    const db = makeFakeDb([
      {
        dischargeType: "revocation",
        effectiveAt: "2026-01-08", // day 7 since 2026-01-01
        admissionAt: new Date("2026-01-01T09:00:00.000Z"),
      },
    ]);
    const out = await createDischargeReader(db).liveDischargeTimingCounts("org-1", period);
    expect(out.earlyLiveDischarges).toBe(1);
    expect(out.lateLiveDischarges).toBe(0);
  });

  it("classifies a live discharge on day 180 as late, day 179 as neither early nor late", async () => {
    const db = makeFakeDb([
      {
        dischargeType: "no_longer_terminal",
        effectiveAt: "2026-06-30", // day 180 since 2026-01-01
        admissionAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        dischargeType: "no_longer_terminal",
        effectiveAt: "2026-06-29", // day 179 — the mid-band, neither early nor late
        admissionAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);
    const out = await createDischargeReader(db).liveDischargeTimingCounts("org-1", period);
    expect(out.totalDischarges).toBe(2);
    expect(out.lateLiveDischarges).toBe(1);
    expect(out.earlyLiveDischarges).toBe(0);
  });

  it("counts a discharge with no recorded admission timestamp in the denominator but classifies neither", async () => {
    const db = makeFakeDb([
      { dischargeType: "for_cause", effectiveAt: "2026-02-01", admissionAt: null },
    ]);
    const out = await createDischargeReader(db).liveDischargeTimingCounts("org-1", period);
    expect(out.totalDischarges).toBe(1);
    expect(out.earlyLiveDischarges).toBe(0);
    expect(out.lateLiveDischarges).toBe(0);
  });

  it("returns all zeros for a period with no discharges", async () => {
    const db = makeFakeDb([]);
    const out = await createDischargeReader(db).liveDischargeTimingCounts("org-1", period);
    expect(out).toEqual({ totalDischarges: 0, earlyLiveDischarges: 0, lateLiveDischarges: 0 });
  });
});
