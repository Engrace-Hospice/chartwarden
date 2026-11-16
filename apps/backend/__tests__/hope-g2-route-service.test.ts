import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSeamsForTest } from "../src/bootstrap/index";
import { createDbHopeBackend } from "../src/modules/10-hope/hope-route-service-db";
import { MAX_RESULT_EVENTS_PER_SUBMISSION } from "../src/modules/10-hope/hope-submission-result";
import type { HopeWriteOutboxPort } from "../src/modules/10-hope/outbox-port";
import { SCRIPT_EXHAUSTED, scriptedDb } from "./_hope-g3-fake-db";

// Group g2, with the database scripted (no Postgres): (1) parallel assembles of one provider entity serialise on a bounded
// advisory key BEFORE any candidate is read, (2) mark-uploaded keeps the CMS retention anchor (`transmitted_at`) on the
// SERVER's clock whatever `submittedAt` the caller sends, (3) a report row's assessment id matches an item whatever its
// spelling, (4) the provider-entity filter of the dashboard and the submission list is applied by the database on the
// canonical id. The same races need a real Postgres to be proven end to end; the order and the predicates are asserted here.
const ORG = "11111111-1111-4111-8111-111111111111";
const MEMBERSHIP = "33333333-3333-4333-8333-333333333333";
const CANONICAL = "abcdef01-2345-4678-89ab-cdef01234567";
const SPELLED = CANONICAL.toUpperCase();
const SERVER_NOW = new Date("2026-06-10T12:00:00.000Z");

const outcome = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { code?: string; statusCode?: number; message?: string }) => e,
  );

let warn: MockInstance;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  __resetSeamsForTest();
});
const warned = (): string => warn.mock.calls.map((call) => String(call[0])).join("\n");

/** The scripted database, plus every value a statement `set` / `values` was given (the fake only records `where`). */
function backend(outcomes: Parameters<typeof scriptedDb>[0]) {
  const fake = scriptedDb(outcomes);
  const written: Record<string, unknown>[] = [];
  const tx = fake.tx as unknown as Record<string, (...a: unknown[]) => Record<string, unknown>>;
  for (const kind of ["update", "insert"] as const) {
    const real = tx[kind]?.bind(tx);
    if (!real) throw new Error(`the scripted transaction has no ${kind}`);
    tx[kind] = (...args: unknown[]) => {
      const link = real(...args);
      for (const method of ["set", "values"] as const) {
        const realMethod = (link[method] as (v: unknown) => unknown).bind(link);
        link[method] = (value: unknown) => {
          written.push(value as Record<string, unknown>);
          return realMethod(value);
        };
      }
      return link;
    };
  }
  const publish = vi.fn(async () => undefined);
  const outbox: HopeWriteOutboxPort = { publish };
  return { ...fake, written, publish, svc: createDbHopeBackend(fake.db, outbox, () => SERVER_NOW) };
}

describe("assembleSubmission — parallel assembles of one provider entity serialise before any candidate is read", () => {
  it("takes the advisory key on the canonical provider entity id as its FIRST statement, before the candidate read", async () => {
    // candidate read -> none, so the call ends at its 409 right after the first read
    const { svc, statements, indexOf } = backend([[]]);

    const failure = await outcome(svc.assembleSubmission(ORG, SPELLED));

    expect(failure).toMatchObject({ statusCode: 409 });
    const lock = indexOf("execute", "pg_advisory_xact_lock");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(indexOf("select"));
    const rendered = statements[lock]?.rendered;
    expect(rendered?.sql).toContain("::uuid)::text");
    // The id as Postgres writes it, not as the body spelled it: `assembleSubmission` canonicalises it before the lock (a
    // non-uuid is the 409 "nothing eligible" without a statement), and the key's own `::uuid` cast keeps it canonical.
    expect(rendered?.params).toEqual([`m10:assemble:${ORG}`, CANONICAL, ""]);
  });

  it("the candidate read behind the lock leaves out a record that already has a live item (the winner's), and an empty read is the 409 'nothing eligible', not a 500", async () => {
    // This pins the predicate a loser relies on, not a winner's commit (that needs a real Postgres: the live suite):
    // the SELECT after the lock carries the `not exists` live-item test, so what the winner packaged is not read again.
    const { svc, statements, indexOf } = backend([[]]);

    const failure = await outcome(svc.assembleSubmission(ORG, SPELLED));

    expect(failure).toMatchObject({ statusCode: 409 });
    expect(String(failure?.message)).toContain("No signed HOPE assessments are eligible");
    const select = indexOf("select");
    expect(select).toBeGreaterThan(indexOf("execute", "pg_advisory_xact_lock"));
    const where = statements[select]?.rendered?.sql;
    expect(where).toContain("not exists (select 1 from");
    expect(where).toContain('"hope_submission_item"."hope_assessment_id" = ');
  });

  it("a lock wait that times out answers the typed busy 409 and reads no candidate", async () => {
    const timeout = new Error("Failed query (secret bound value)", {
      cause: Object.assign(new Error("driver"), { code: "55P03" }),
    });
    const fake = scriptedDb([]);
    const realExecute = fake.tx.execute.bind(fake.tx);
    let executes = 0;
    (fake.tx as unknown as { execute: unknown }).execute = async (statement: unknown) => {
      executes += 1;
      // set_config x2, SET LOCAL lock_timeout, then the advisory lock
      if (executes === 4) throw timeout;
      return realExecute(statement as never);
    };
    const svc = createDbHopeBackend(fake.db, { publish: vi.fn() });

    const failure = await outcome(svc.assembleSubmission(ORG, SPELLED));

    expect(failure).toMatchObject({ code: "M10_RECORD_BUSY", statusCode: 409 });
    expect(fake.statements.filter((s) => s.kind === "select")).toHaveLength(0);
    expect(warned()).toContain(`advisory key m10:assemble:${ORG}`);
    expect(warned()).not.toContain("secret bound value");
  });
});

describe("markSubmissionUploaded — the retention anchor is the server's clock, never the caller's date", () => {
  const packaged = {
    id: CANONICAL,
    status: "packaged",
    providerEntityId: "pe-1",
    packageSha256: "a".repeat(64),
  };

  it.each([
    ["a back-dated instant", "2005-01-01T00:00:00Z"],
    ["a far-future instant", "2199-12-31T00:00:00Z"],
  ])(
    "%s lands in submitted_at only; transmitted_at is the server's now",
    async (_label, submittedAt) => {
      const { svc, written, publish } = backend([
        [packaged],
        [{ ...packaged, status: "submitted_pending_result" }],
      ]);

      await svc.markSubmissionUploaded(ORG, MEMBERSHIP, CANONICAL, { submittedAt });

      const update = written.find((w) => w.status === "submitted_pending_result");
      expect(update?.transmittedAt).toEqual(SERVER_NOW);
      expect(update?.submittedAt).toEqual(new Date(submittedAt));
      expect(publish).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          eventName: "m10.hope.submission_transmitted",
          payload: expect.objectContaining({
            transmittedAt: SERVER_NOW.toISOString(),
            submittedAt: new Date(submittedAt).toISOString(),
          }),
        }),
      );
    },
  );

  it("with no submittedAt both are the server's now", async () => {
    const { svc, written } = backend([
      [packaged],
      [{ ...packaged, status: "submitted_pending_result" }],
    ]);

    await svc.markSubmissionUploaded(ORG, MEMBERSHIP, CANONICAL, {});

    const update = written.find((w) => w.status === "submitted_pending_result");
    expect(update?.transmittedAt).toEqual(SERVER_NOW);
    expect(update?.submittedAt).toEqual(SERVER_NOW);
  });
});

describe("importSubmissionResult — a report row's assessment id matches its item in any spelling Postgres reads as a uuid", () => {
  const submission = {
    id: "55555555-5555-4555-8555-555555555555",
    status: "submitted_pending_result",
    providerEntityId: "pe-1",
    resultReportHash: null,
    acceptanceReport: {},
  };
  const item = {
    id: "66666666-6666-4666-8666-666666666666",
    hopeAssessmentId: CANONICAL,
    itemStatus: "pending",
    iqiesRecordId: null,
  };
  // lock select, "seen this report" select, item select; then the item UPDATE (a bulk statement, which the scripted
  // database records without consuming an outcome: the point the match is proven at), the result-event insert and the batch
  // UPDATE, where the script ends
  const script = [[submission], [], [item], []] as const;
  const itemUpdateOf = (statements: ReturnType<typeof scriptedDb>["statements"]) =>
    statements.find(
      (s) =>
        s.kind === "execute" && (s.rendered?.sql ?? "").includes('UPDATE "hope_submission_item"'),
    )?.rendered;

  it.each([
    ["upper case", SPELLED],
    ["braces", `{${CANONICAL}}`],
    ["blanks around it (a pasted CSV cell)", `  ${CANONICAL}  `],
    ["no hyphens", CANONICAL.replace(/-/g, "")],
  ])("%s still settles the item", async (_label, assessmentId) => {
    const { svc, statements } = backend([...script]);

    const failure = await outcome(
      svc.importSubmissionResult(ORG, MEMBERSHIP, submission.id, {
        results: [{ assessmentId, status: "accepted" }],
      }),
    );

    expect(failure?.code).not.toBe("M10_SUBMISSION_RESULT_NO_MATCH");
    expect(itemUpdateOf(statements)?.params).toEqual(
      expect.arrayContaining([item.id, "accepted", submission.id, ORG]),
    );
    expect(failure?.message).toBe(SCRIPT_EXHAUSTED); // it went on to the writes: the script ended it there
  });

  it.each([
    ["hex digits that are no uuid", "abc123"],
    ["a different uuid", "11111111-2222-4333-8444-555555555555"],
  ])("%s is no match (the 422), never a database cast error", async (_label, assessmentId) => {
    const { svc, statements } = backend([...script]);

    const failure = await outcome(
      svc.importSubmissionResult(ORG, MEMBERSHIP, submission.id, {
        results: [{ assessmentId, status: "accepted" }],
      }),
    );

    expect(failure).toMatchObject({ code: "M10_SUBMISSION_RESULT_NO_MATCH", statusCode: 422 });
    expect(itemUpdateOf(statements)).toBeUndefined();
  });

  it.each([
    ["a name", "Jane Q Public"],
    ["a word", "not-a-uuid"],
    ["only blanks", "   "],
  ])(
    "%s is no assessment id at all: a static 422 before any statement, never stored or echoed",
    async (_label, assessmentId) => {
      const { svc, statements } = backend([...script]);

      const failure = await outcome(
        svc.importSubmissionResult(ORG, MEMBERSHIP, submission.id, {
          results: [{ assessmentId, status: "accepted" }],
        }),
      );

      expect(failure).toMatchObject({ code: "VALIDATION_FAILED", statusCode: 422 });
      expect(JSON.stringify(failure)).not.toContain("Jane");
      expect(statements).toEqual([]);
    },
  );

  it("a trailing line break (a CRLF-split CSV) is a blank: it still settles the item, stored trimmed", async () => {
    const { svc, written } = backend([...script]);

    const failure = await outcome(
      svc.importSubmissionResult(ORG, MEMBERSHIP, submission.id, {
        results: [{ assessmentId: `${CANONICAL}\r`, status: "accepted" }],
      }),
    );

    expect(failure?.code).not.toBe("M10_SUBMISSION_RESULT_NO_MATCH");
    expect(failure?.code).not.toBe("VALIDATION_FAILED");
    const events = written.find((w) => Array.isArray(w)) as unknown as { rawResult: unknown }[];
    expect(events[0]?.rawResult).toEqual({ assessmentId: CANONICAL, status: "accepted" });
  });

  it("two rows of one assessment with blank codes both keep a NULL code and item code (a stored '' would be a unique key)", async () => {
    const { svc, written } = backend([...script]);

    await outcome(
      svc.importSubmissionResult(ORG, MEMBERSHIP, submission.id, {
        results: [
          { assessmentId: CANONICAL, status: "rejected", code: "", itemCode: "", message: "first" },
          {
            assessmentId: CANONICAL,
            status: "rejected",
            code: "",
            itemCode: "",
            message: "second",
          },
        ],
      }),
    );

    const events = written.find((w) => Array.isArray(w)) as unknown as Record<string, unknown>[];
    expect(events.map((e) => [e.cmsEditCode, e.itemCode, e.message])).toEqual([
      [null, null, "first"],
      [null, null, "second"],
    ]);
  });

  describe("a batch holds at most MAX_RESULT_EVENTS_PER_SUBMISSION recorded report rows", () => {
    const rows = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        assessmentId: CANONICAL,
        status: "rejected",
        code: `-${3000 + i}`,
        message: "bad",
      }));
    const withRecorded = (n: number) => [[submission], [], [item], [{ n }]];

    it("an import that would pass the cap is a static 409 under the batch lock, and nothing is written", async () => {
      const { svc, statements, written } = backend(
        withRecorded(MAX_RESULT_EVENTS_PER_SUBMISSION - 1),
      );

      const failure = await outcome(
        svc.importSubmissionResult(ORG, MEMBERSHIP, submission.id, { results: rows(2) }),
      );

      expect(failure).toMatchObject({ code: "CONFLICT", statusCode: 409 });
      expect(failure?.message).toContain(
        `${MAX_RESULT_EVENTS_PER_SUBMISSION - 1} recorded report rows`,
      );
      expect(failure?.message).not.toContain(CANONICAL);
      expect(written).toEqual([]);
      expect(itemUpdateOf(statements)).toBeUndefined();
      expect(statements.some((s) => s.kind === "insert" || s.kind === "update")).toBe(false);
      // the count is made after the batch row lock (the first select) and before any write
      const lock = statements.findIndex((s) => s.kind === "select");
      const count = statements.findIndex((s) => s.columns?.join() === "n");
      expect(statements[lock]?.rendered?.sql).toContain("hope_submission");
      expect(count).toBeGreaterThan(lock);
    });

    it("an import that lands exactly on the cap goes on to the writes (the script ends it there)", async () => {
      const { svc, written } = backend(withRecorded(MAX_RESULT_EVENTS_PER_SUBMISSION - 2));

      const failure = await outcome(
        svc.importSubmissionResult(ORG, MEMBERSHIP, submission.id, { results: rows(2) }),
      );

      expect(failure?.message).toBe(SCRIPT_EXHAUSTED);
      expect(written.some((w) => Array.isArray(w))).toBe(true);
    });

    it("the count is a COUNT over this batch and this tenant, not a read of the rows", async () => {
      const { svc, statements } = backend(withRecorded(0));

      await outcome(
        svc.importSubmissionResult(ORG, MEMBERSHIP, submission.id, { results: rows(1) }),
      );

      const counted = statements.find((s) => s.columns?.join() === "n");
      expect(counted?.kind).toBe("select");
      expect(counted?.rendered?.sql).toContain("hope_submission_result_event");
      expect(counted?.rendered?.params).toEqual(expect.arrayContaining([ORG, submission.id]));
    });
  });

  it("stores the REBUILT row, never the caller's object: a key the schema has not is refused, a value that is no string is refused", async () => {
    const unknownKey = backend([...script]);
    const notAString = backend([...script]);

    const a = await outcome(
      unknownKey.svc.importSubmissionResult(ORG, MEMBERSHIP, submission.id, {
        results: [{ assessmentId: CANONICAL, status: "accepted", extra: "x" }],
      }),
    );
    const b = await outcome(
      notAString.svc.importSubmissionResult(ORG, MEMBERSHIP, submission.id, {
        results: [{ assessmentId: CANONICAL, severity: 3 as never }],
      }),
    );

    expect(a).toMatchObject({ code: "VALIDATION_FAILED", statusCode: 422 });
    expect(b).toMatchObject({ code: "VALIDATION_FAILED", statusCode: 422 });
    expect(JSON.stringify([a, b])).not.toContain("extra");
    expect(unknownKey.statements).toEqual([]);
    expect(notAString.statements).toEqual([]);
  });
});

describe("the provider-entity filter is the database's, on the canonical id", () => {
  const filterOf = (statements: ReturnType<typeof scriptedDb>["statements"]) =>
    statements.filter((s) => s.kind === "select").map((s) => s.rendered);

  it("complianceDashboard narrows the schedules, the SFVs and the submissions of ONE provider entity, not only the submissions", async () => {
    const { svc, statements } = backend([[], [], []]);

    const view = await svc.complianceDashboard(ORG, SPELLED);

    expect(view.providerEntityId).toBe(CANONICAL); // echoed as Postgres writes it, like regenerateSchedules
    const wheres = filterOf(statements);
    expect(wheres).toHaveLength(3);
    for (const where of wheres) {
      expect(where?.sql).toContain('"provider_entity_id"');
      expect(where?.params).toEqual([CANONICAL]); // canonical text: any spelling reaches the same rows
    }
  });

  it("complianceDashboard with no provider entity reads the whole organisation (no predicate)", async () => {
    const { svc, statements } = backend([[], [], []]);

    await svc.complianceDashboard(ORG, undefined);

    expect(filterOf(statements)).toEqual([undefined, undefined, undefined]);
  });

  it("complianceDashboard with an id that is no uuid matches nothing and sends no cast to the database", async () => {
    const { svc, statements } = backend([[], [], []]);

    const view = await svc.complianceDashboard(ORG, "not-a-uuid");

    expect(view.hopeOnTimeCounts).toEqual({ onTime: 0, total: 0 });
    for (const where of filterOf(statements)) {
      expect(where?.sql).toContain("false");
      expect(where?.params).toEqual([]);
    }
  });

  it("listSubmissions applies the same canonical predicate in SQL", async () => {
    const { svc, statements } = backend([[]]);

    await svc.listSubmissions(ORG, `{${SPELLED}}`);

    const [where] = filterOf(statements);
    expect(where?.sql).toContain('"provider_entity_id"');
    // the tenant, then (inside the cap's subquery) the tenant again, the canonical entity id, the closed statuses and the cap
    expect(where?.params).toEqual([
      ORG,
      ORG,
      CANONICAL,
      "accepted",
      "accepted_with_warnings",
      "cancelled",
      500,
    ]);
  });
});
