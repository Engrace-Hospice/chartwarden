import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetSeamsForTest } from "../src/bootstrap/index";
import { createDbHopeBackend } from "../src/modules/10-hope/hope-route-service-db";
import { CLOSED_BATCH_STATUSES } from "../src/modules/10-hope/hope-submission-result";
import { renderSql, scriptedDb } from "./_hope-g3-fake-db";

// GET /hope/submissions is capped (500). The cap must not hide a batch that still needs an operator behind 500 newer, finished
// ones (code review 1, database L2): a subquery orders the unfinished batches first and applies the cap, and the statement
// around it orders what survived newest first, in SQL (no second sort in JavaScript, whose Date has milliseconds where
// `created_at` has microseconds). The statement's shape is asserted here (scripted database); that an old `exported` batch
// survives 501 newer accepted ones is proven against a real Postgres (m10-hope-submission-result.live.test.ts).
const ORG = "11111111-1111-4111-8111-111111111111";
const PE = "abcdef01-2345-4678-89ab-cdef01234567";
const at = (day: number): Date => new Date(Date.UTC(2026, 5, day));
const batch = (id: string, status: string, createdAt: Date) => ({
  id,
  organizationId: ORG,
  providerEntityId: PE,
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

describe("listSubmissions — unfinished batches first under the cap, newest first in the answer, one statement", () => {
  function backend(outcomes: Parameters<typeof scriptedDb>[0]) {
    const fake = scriptedDb(outcomes);
    const tx = fake.tx as unknown as Record<string, (...a: unknown[]) => Record<string, unknown>>;
    const outerOrder: string[] = [];
    const realSelect = tx.select?.bind(tx);
    if (!realSelect) throw new Error("the scripted transaction has no select");
    let first = true;
    tx.select = (...args: unknown[]) => {
      const link = realSelect(...args);
      if (!first) return link;
      first = false;
      const real = (link.orderBy as (...a: unknown[]) => unknown).bind(link);
      link.orderBy = (...given: unknown[]) => {
        for (const part of given) outerOrder.push(renderSql(part).sql);
        return real(...given);
      };
      return link;
    };
    return {
      ...fake,
      outerOrder,
      svc: createDbHopeBackend(fake.db, { publish: vi.fn(async () => undefined) }),
    };
  }

  it("caps in a subquery ordered 'not closed' first, then newest, then id; the cap is the subquery's limit", async () => {
    const { svc, statements } = backend([[]]);

    await svc.listSubmissions(ORG, PE);

    const selects = statements.filter((s) => s.kind === "select");
    expect(selects).toHaveLength(1); // ONE statement, not a read plus a sort
    const where = selects[0]?.rendered;
    expect(where?.sql).toContain(
      '"hope_submission"."id" in (select "id" from "hope_submission" where ',
    );
    expect(where?.sql).toMatch(
      /order by "hope_submission"\."status" not in \(\$\d+, \$\d+, \$\d+\) desc, "hope_submission"\."created_at" desc, "hope_submission"\."id" desc limit \$\d+\)/,
    );
    expect(where?.params).toEqual(expect.arrayContaining([ORG, PE, ...CLOSED_BATCH_STATUSES, 500]));
  });

  it("names the tenant on the outer statement and on the subquery", async () => {
    const { svc, statements } = backend([[]]);

    await svc.listSubmissions(ORG);

    const where = statements.find((s) => s.kind === "select")?.rendered;
    expect(where?.sql.match(/"organization_id" = \$\d+/g)).toHaveLength(2);
    expect(where?.params.filter((p) => p === ORG)).toHaveLength(2);
  });

  it("orders the outer statement newest first by the database, and answers the rows in the order it returned them", async () => {
    const newest = batch("a0000000-0000-4000-8000-000000000003", "accepted", at(9));
    const newer = batch("a0000000-0000-4000-8000-000000000002", "accepted", at(5));
    const oldExported = batch("a0000000-0000-4000-8000-000000000001", "exported", at(1));
    const { svc, outerOrder } = backend([[newest, newer, oldExported]]);

    const { submissions } = await svc.listSubmissions(ORG);

    expect(outerOrder).toHaveLength(2);
    expect(outerOrder[0]).toContain('"created_at" desc');
    expect(outerOrder[1]).toContain('"id" desc');
    // no JavaScript re-sort: the answer is the database's order (the unfinished old batch is listed last here because it is oldest)
    expect(submissions.map((s) => s.id)).toEqual([newest.id, newer.id, oldExported.id]);
    const unsorted = backend([[oldExported, newest, newer]]);
    expect((await unsorted.svc.listSubmissions(ORG)).submissions.map((s) => s.id)).toEqual([
      oldExported.id,
      newest.id,
      newer.id,
    ]);
  });
});
