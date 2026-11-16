import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetSeamsForTest } from "../src/bootstrap/index";
import { createDbHopeBackend } from "../src/modules/10-hope/hope-route-service-db";
import { CLOSED_BATCH_STATUSES, newestFirst } from "../src/modules/10-hope/hope-submission-result";
import { renderSql, scriptedDb } from "./_hope-g3-fake-db";

// GET /hope/submissions is capped (500). The cap must not hide a batch that still needs an operator behind 500 newer, finished
// ones (code review 1, database L2): the read orders the unfinished batches first, applies the cap, and the answer is put back
// newest first. The statement's order is asserted here (scripted database); that an old `exported` batch survives 501 newer
// accepted ones is proven against a real Postgres (m10-hope-submission-result.live.test.ts).
const ORG = "11111111-1111-4111-8111-111111111111";
const at = (day: number): Date => new Date(Date.UTC(2026, 5, day));
const batch = (id: string, status: string, createdAt: Date) => ({
  id,
  organizationId: ORG,
  providerEntityId: "44444444-4444-4444-8444-444444444444",
  submissionPeriod: "2026-06",
  status,
  itemCount: 1,
  acceptedCount: 0,
  rejectedCount: 0,
  createdAt,
});

afterEach(() => __resetSeamsForTest());

describe("CLOSED_BATCH_STATUSES — what the submission list may drop first", () => {
  it("is exactly the answered-clean and the cancelled statuses: every other status can still need an operator", () => {
    expect([...CLOSED_BATCH_STATUSES].sort()).toEqual(
      ["accepted", "accepted_with_warnings", "cancelled"].sort(),
    );
    for (const status of [
      "packaged",
      "exported",
      "in_flight",
      "submitted_pending_result",
      "rejected",
      "partially_accepted",
    ]) {
      expect(CLOSED_BATCH_STATUSES as readonly string[], status).not.toContain(status);
    }
  });
});

describe("newestFirst", () => {
  it("sorts by created_at descending, then id descending, and does not touch its input", () => {
    const rows = [
      { id: "a", createdAt: at(1) },
      { id: "c", createdAt: at(3) },
      { id: "b", createdAt: at(3) },
      { id: "d", createdAt: at(2) },
    ];
    const before = [...rows];

    expect(newestFirst(rows).map((r) => r.id)).toEqual(["c", "b", "d", "a"]);
    expect(rows).toEqual(before);
  });
});

describe("listSubmissions — unfinished batches first under the cap, newest first in the answer", () => {
  function backend(outcomes: Parameters<typeof scriptedDb>[0]) {
    const fake = scriptedDb(outcomes);
    const tx = fake.tx as unknown as Record<string, (...a: unknown[]) => Record<string, unknown>>;
    const ordered: { sql: string; params: readonly unknown[] }[] = [];
    let limit: unknown;
    const realSelect = tx.select?.bind(tx);
    if (!realSelect) throw new Error("the scripted transaction has no select");
    let first = true;
    tx.select = (...args: unknown[]) => {
      const link = realSelect(...args);
      if (!first) return link;
      first = false;
      for (const method of ["orderBy", "limit"] as const) {
        const real = (link[method] as (...a: unknown[]) => unknown).bind(link);
        link[method] = (...given: unknown[]) => {
          if (method === "limit") limit = given[0];
          else for (const part of given) ordered.push(renderSql(part));
          return real(...given);
        };
      }
      return link;
    };
    return {
      ...fake,
      ordered,
      limitGiven: () => limit,
      svc: createDbHopeBackend(fake.db, { publish: vi.fn(async () => undefined) }),
    };
  }

  it("orders by 'not closed' first, then newest, then id, and caps after that order", async () => {
    const { svc, ordered, limitGiven } = backend([[]]);

    await svc.listSubmissions(ORG);

    expect(ordered).toHaveLength(3);
    expect(ordered[0]?.sql).toMatch(/"hope_submission"\."status" not in \(\$1, \$2, \$3\) desc/);
    expect(ordered[0]?.params).toEqual([...CLOSED_BATCH_STATUSES]);
    expect(ordered[1]?.sql).toContain('"created_at" desc');
    expect(ordered[2]?.sql).toContain('"id" desc');
    expect(limitGiven()).toBe(500);
  });

  it("answers newest first whatever order the database kept them in (the unfinished old batch is read first, listed last)", async () => {
    const oldExported = batch("a0000000-0000-4000-8000-000000000001", "exported", at(1));
    const newer = batch("a0000000-0000-4000-8000-000000000002", "accepted", at(5));
    const newest = batch("a0000000-0000-4000-8000-000000000003", "accepted", at(9));
    const { svc } = backend([[oldExported, newest, newer]]);

    const { submissions } = await svc.listSubmissions(ORG);

    expect(submissions.map((s) => s.id)).toEqual([newest.id, newer.id, oldExported.id]);
  });
});
