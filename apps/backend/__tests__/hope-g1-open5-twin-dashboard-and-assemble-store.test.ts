import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDbHopeBackend } from "../src/modules/10-hope/hope-route-service-db";
import {
  ACCEPTED_BATCH_STATUSES,
  ANSWERED_BATCH_STATUSES,
} from "../src/modules/10-hope/hope-submission-result";
import {
  ASSEMBLE_BLOCKING_ITEM_STATUSES,
  assemblableAssessmentsForOrg,
} from "../src/modules/10-hope/jobs/assemble-store";
import { createInMemoryHopeBackend } from "../src/modules/10-hope/routes/service";
import { scriptedDb } from "./_hope-g3-fake-db";

// Group g1, open pass 5 (no Postgres).
//  - the in-memory twin's compliance dashboard counts the same batch statuses as the DB backend (it kept its own list and
//    left a batch iQIES accepted with warnings out of both halves of the ratio);
//  - the cron assemble scan treats the same item statuses as blocking as the manual package route.
const ORG = "11111111-1111-4111-8111-111111111111";
const PE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const ALL_BATCH_STATUSES = [
  "ready",
  "queued",
  "packaged",
  "exported",
  "in_flight",
  "submitted_pending_result",
  "accepted",
  "rejected",
  "partially_accepted",
  "accepted_with_warnings",
  "file_error",
  "cancelled",
] as const;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("twin complianceDashboard counts the batch statuses the DB backend counts", () => {
  it.each(ALL_BATCH_STATUSES)(
    "one %s batch reads the same acceptance counts on the twin and on the DB backend",
    async (status) => {
      const twin = createInMemoryHopeBackend({
        submissions: [{ id: "s-1", organizationId: ORG, providerEntityId: PE, status }],
      });
      const database = createDbHopeBackend(scriptedDb([[], [], [{ status, n: 1 }]]).db, {
        publish: async () => undefined,
      });

      const fromTwin = await twin.complianceDashboard(ORG, undefined);
      const fromDatabase = await database.complianceDashboard(ORG, undefined);

      expect(fromTwin.submissionAcceptanceCounts).toEqual(fromDatabase.submissionAcceptanceCounts);
      expect(fromTwin.submissionAcceptanceRate).toEqual(fromDatabase.submissionAcceptanceRate);
    },
  );

  it("a batch accepted with warnings is accepted and answered (1 of 1), not 0 of 0", async () => {
    const twin = createInMemoryHopeBackend({
      submissions: [
        {
          id: "s-1",
          organizationId: ORG,
          providerEntityId: PE,
          status: "accepted_with_warnings",
        },
      ],
    });

    const view = await twin.complianceDashboard(ORG, undefined);

    expect(view.submissionAcceptanceCounts).toEqual({ accepted: 1, total: 1 });
    expect(view.submissionAcceptanceRate).toBe(1);
  });

  it("the twin counts exactly the shared lists over a mix of every status", async () => {
    const twin = createInMemoryHopeBackend({
      submissions: ALL_BATCH_STATUSES.map((status, i) => ({
        id: `s-${i}`,
        organizationId: ORG,
        providerEntityId: PE,
        status,
      })),
    });

    const view = await twin.complianceDashboard(ORG, undefined);

    expect(view.submissionAcceptanceCounts).toEqual({
      accepted: ACCEPTED_BATCH_STATUSES.length,
      total: ANSWERED_BATCH_STATUSES.length,
    });
  });
});

describe("the cron assemble scan blocks on the item statuses the manual package route blocks on", () => {
  const dialect = new PgDialect();

  /** A tx that records the field map and the WHERE of the one candidate SELECT, and answers no rows. */
  function captureScan() {
    const captured: { fields?: Record<string, unknown>; where?: unknown } = {};
    const tx = {
      select: (fields: Record<string, unknown>) => {
        captured.fields = fields;
        return {
          from: () => ({
            where: (where: unknown) => {
              captured.where = where;
              return { orderBy: async () => [] };
            },
          }),
        };
      },
    };
    return { captured, tx: tx as never };
  }
  const render = (query: unknown) =>
    dialect.sqlToQuery(query as Parameters<PgDialect["sqlToQuery"]>[0]);

  it("names pending, accepted, accepted_with_warnings and rejected, and nothing else", () => {
    expect([...ASSEMBLE_BLOCKING_ITEM_STATUSES].sort()).toEqual([
      "accepted",
      "accepted_with_warnings",
      "pending",
      "rejected",
    ]);
  });

  it("projects an item in any of those statuses as an active item (a rejected original is not re-batched unchanged)", async () => {
    const { captured, tx } = captureScan();

    await assemblableAssessmentsForOrg(tx, ORG);

    const { sql, params } = render(captured.fields?.hasActiveItem);
    expect(sql).toMatch(/item_status in \(/);
    for (const status of ASSEMBLE_BLOCKING_ITEM_STATUSES) expect(params).toContain(status);
    expect(params).not.toContain("cancelled");
    expect(params).not.toContain("blocked");
    expect(params).not.toContain("unmatched");
  });

  it("still reads only signed, unsuperseded records with no iQIES record id", async () => {
    const { captured, tx } = captureScan();

    await assemblableAssessmentsForOrg(tx, ORG);

    const { sql, params } = render(captured.where);
    expect(sql).toContain('"superseded_by_id" is null');
    expect(sql).toContain('"iqies_record_id" is null');
    expect(params).toContain("signed");
    expect(params).toContain(ORG);
  });

  it("an item status the planner would re-batch on is gone: an accepted record with no report record id is still blocked by its item", async () => {
    // the scan answers one row whose item is accepted: hasActiveItem true -> skipped by the planner, not re-queued
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: async () => [
              {
                id: "a-1",
                providerEntityId: PE,
                rfaKind: "01_admission",
                targetDate: new Date("2026-06-01T00:00:00.000Z"),
                signedAt: new Date("2026-06-02T00:00:00.000Z"),
                iqiesRecordId: null,
                correctsIqiesRecordId: null,
                hasActiveItem: true,
              },
            ],
          }),
        }),
      }),
    };

    const scan = await assemblableAssessmentsForOrg(tx as never, ORG);

    expect(scan.eligible.map((e) => [e.assessmentId, e.hasActiveSubmissionItem])).toEqual([
      ["a-1", true],
    ]);
  });
});

describe("source comments that described a design that is not built", () => {
  // a comment wraps across lines: join them (dropping the `//` / ` *` markers) so a phrase is found wherever it wraps
  const prose = (relative: string) =>
    readFileSync(resolve(__dirname, "../src/modules/10-hope", relative), "utf8")
      .replace(/\s*\n\s*(\/\/|\*)?\s*/g, " ")
      .replace(/\s+/g, " ");

  it("the eraser does not say an M4 envelope-purge worker purges envelope content (spec 8.4: M10 purges none, no purge job exists)", () => {
    expect(prose("erasers/hope-eraser.ts")).not.toMatch(/purged by M4/i);
    expect(prose("erasers/hope-eraser.ts")).not.toMatch(
      /M4'?s? envelope-purge worker\)? ?(,|\.)? ?not here/i,
    );
  });

  it("the eraser does not claim a partition-granularity drop (the row path is the only one built)", () => {
    expect(prose("erasers/hope-eraser.ts")).not.toMatch(/PARTITION granularity/);
    expect(prose("erasers/hope-eraser.ts")).not.toMatch(
      /partition DETACH\+DROP where a partition is wholly erasable/,
    );
  });

  it("the twin's patientOfAdmission comment does not say the DB recordTimepoint falls back to the admission id", () => {
    expect(prose("routes/service.ts")).not.toMatch(/else the admission id itself/);
    expect(prose("routes/service.ts")).not.toMatch(/has NO such refusal/);
  });
});
