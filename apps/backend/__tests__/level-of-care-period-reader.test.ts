// apps/backend/__tests__/level-of-care-period-reader.test.ts — the M6 LevelOfCarePeriodReader Drizzle
// impl (M30 HCI indicator 1's CHC/GIP coverage counts). A fake scoped db drives TWO sequential
// `select().from().where()` reads (election periods, then LOC rows for those admissions) and the test
// asserts the reader's own interval-overlap classification — the actual point of this reader, not just
// that it queried the right tables.
import type { DbClient } from "@wardenx/db";
import { describe, expect, it } from "vitest";
import { createLevelOfCarePeriodReader } from "../src/modules/06-admission/index";

interface PeriodRow {
  admissionId: string;
  effectiveAt: string; // date column → string
  actualEndAt: string | null;
  scheduledEndAt: string | null;
}
interface LocRow {
  admissionId: string;
  effectiveAt: Date;
  endedAt: Date | null;
}

/** A fake `DbClient` whose `transaction(fn)` runs two sequential `select()` reads off a queue of
 *  pre-seeded result arrays (periods first, then LOC rows), mirroring the reader's real call order. */
function makeFakeDb(periods: PeriodRow[], locRows: LocRow[]): DbClient {
  const results = [periods, locRows];
  const tx = {
    async execute() {
      return undefined;
    },
    select() {
      return {
        from() {
          return {
            where: () => Promise.resolve(results.shift() ?? []),
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

describe("LevelOfCarePeriodReader (M30 HCI indicator 1)", () => {
  it("counts an election period whose window overlaps a CHC/GIP LOC day", async () => {
    const db = makeFakeDb(
      [
        {
          admissionId: "adm-1",
          effectiveAt: "2026-01-05",
          actualEndAt: "2026-02-05",
          scheduledEndAt: null,
        },
      ],
      [
        {
          admissionId: "adm-1",
          effectiveAt: new Date("2026-01-10T00:00:00.000Z"),
          endedAt: new Date("2026-01-12T00:00:00.000Z"),
        },
      ],
    );
    const out = await createLevelOfCarePeriodReader(db).chcOrGipCoverageCounts("org-1", period);
    expect(out).toEqual({ numerator: 1, denominator: 1 });
  });

  it("does NOT count a LOC day that ended before the election period even started", async () => {
    const db = makeFakeDb(
      [{ admissionId: "adm-1", effectiveAt: "2026-01-05", actualEndAt: null, scheduledEndAt: null }],
      [
        {
          admissionId: "adm-1",
          effectiveAt: new Date("2025-12-01T00:00:00.000Z"),
          endedAt: new Date("2025-12-15T00:00:00.000Z"),
        },
      ],
    );
    const out = await createLevelOfCarePeriodReader(db).chcOrGipCoverageCounts("org-1", period);
    expect(out).toEqual({ numerator: 0, denominator: 1 });
  });

  it("counts a STILL-OPEN LOC period (no endedAt) against a STILL-OPEN election period (no end dates)", async () => {
    const db = makeFakeDb(
      [{ admissionId: "adm-1", effectiveAt: "2026-01-05", actualEndAt: null, scheduledEndAt: null }],
      [{ admissionId: "adm-1", effectiveAt: new Date("2026-03-01T00:00:00.000Z"), endedAt: null }],
    );
    const out = await createLevelOfCarePeriodReader(db).chcOrGipCoverageCounts("org-1", period);
    expect(out).toEqual({ numerator: 1, denominator: 1 });
  });

  it("a LOC row on a DIFFERENT admission never counts toward this election period", async () => {
    const db = makeFakeDb(
      [{ admissionId: "adm-1", effectiveAt: "2026-01-05", actualEndAt: null, scheduledEndAt: null }],
      [
        {
          admissionId: "adm-OTHER",
          effectiveAt: new Date("2026-01-10T00:00:00.000Z"),
          endedAt: null,
        },
      ],
    );
    const out = await createLevelOfCarePeriodReader(db).chcOrGipCoverageCounts("org-1", period);
    expect(out).toEqual({ numerator: 0, denominator: 1 });
  });

  it("returns {0,0} without a second query when there are no election periods in the window", async () => {
    const db = makeFakeDb([], []);
    const out = await createLevelOfCarePeriodReader(db).chcOrGipCoverageCounts("org-1", period);
    expect(out).toEqual({ numerator: 0, denominator: 0 });
  });
});
