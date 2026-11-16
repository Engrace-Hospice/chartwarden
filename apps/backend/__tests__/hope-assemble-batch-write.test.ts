import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSeamsForTest } from "../src/bootstrap/index";
import { createDbHopeBackend } from "../src/modules/10-hope/hope-route-service-db";
import { scriptedDb } from "./_hope-g3-fake-db";

// assembleSubmission's write half (database review L3, second pass): the items go in with ONE multi-row insert instead of a
// statement per item while the share locks and the advisory key are held, and the share lock is taken AFTER the package is
// serialised (just before the batch is written), so a correction's signature is not stalled for the length of the serialising.
// The validator, the serialiser and the header are stubbed (they need the spec corpus and the foundation seams); the database
// is scripted, so the statements and their order are asserted here. Against a real Postgres: m10-hope-write.live.test.ts.
const validate = vi.hoisted(() => vi.fn(async () => ({ findings: [] })));
const serialize = vi.hoisted(() => vi.fn());
/** Every ZIP built, with the statements the database had been given by then (the share lock is a statement). */
const zips = vi.hoisted(() => ({
  calls: [] as { entries: string[]; selectsSoFar: () => number }[],
}));
const selectCount = vi.hoisted(() => ({ n: 0 }));
vi.mock("../src/modules/10-hope/hope-zip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/10-hope/hope-zip")>();
  return {
    ...actual,
    buildDeterministicZip: (entries: readonly { filename: string }[]) => {
      const at = selectCount.n;
      zips.calls.push({ entries: entries.map((e) => e.filename), selectsSoFar: () => at });
      return actual.buildDeterministicZip(entries as never);
    },
  };
});
vi.mock("../src/modules/10-hope/hope-validation-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/modules/10-hope/hope-validation-service")>();
  return { ...actual, createHopeValidationService: () => ({ validateAssessment: validate }) };
});
vi.mock("../src/modules/10-hope/hope-cms-xml-serializer", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/modules/10-hope/hope-cms-xml-serializer")>();
  return { ...actual, serializeHopeAssessmentXml: serialize };
});
vi.mock("../src/modules/10-hope/hope-submission-header", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/modules/10-hope/hope-submission-header")>();
  return { ...actual, buildHopeSubmissionHeader: () => ({}), readHopeSoftwareVendor: () => ({}) };
});
vi.mock("../src/bootstrap/foundation-site-reader", () => ({
  buildFoundationSiteReader: () => ({ providerEntitySubmissionProfile: async () => ({}) }),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const PE = "abcdef01-2345-4678-89ab-cdef01234567";
const BATCH = "77777777-7777-4777-8777-777777777777";
const IDS = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
];
const row = (id: string) => ({
  id,
  status: "signed",
  specVersionId: "spec-1",
  isc: "HA",
  version: 1,
});

let warn: MockInstance;
beforeEach(() => {
  zips.calls.length = 0;
  selectCount.n = 0;
  validate.mockClear();
  serialize.mockReset();
  serialize.mockImplementation(async (_tx: unknown, assessment: { id: string }) => ({
    filename: `${assessment.id}.xml`,
    bytes: Buffer.from(`<xml id="${assessment.id}"/>`),
    sha256: "e".repeat(64),
    operation: "submit",
    validationProfile: "profile-1",
  }));
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  __resetSeamsForTest();
});

/** The scripted database, plus what each `insert(...).values(...)` and `update(...).set(...)` was given, in order. */
function backend(outcomes: Parameters<typeof scriptedDb>[0]) {
  const fake = scriptedDb(outcomes);
  const calls: { kind: "insert" | "update"; value: unknown }[] = [];
  const tx = fake.tx as unknown as Record<string, (...a: unknown[]) => Record<string, unknown>>;
  const realSelect = tx.select?.bind(tx);
  if (!realSelect) throw new Error("the scripted transaction has no select");
  tx.select = (...args: unknown[]) => {
    selectCount.n += 1;
    return realSelect(...args);
  };
  for (const [kind, method] of [
    ["insert", "values"],
    ["update", "set"],
  ] as const) {
    const real = tx[kind]?.bind(tx);
    if (!real) throw new Error(`the scripted transaction has no ${kind}`);
    tx[kind] = (...args: unknown[]) => {
      const link = real(...args);
      const realMethod = (link[method] as (v: unknown) => unknown).bind(link);
      link[method] = (value: unknown) => {
        calls.push({ kind, value });
        return realMethod(value);
      };
      return link;
    };
  }
  const publish = vi.fn(async () => undefined);
  return { ...fake, calls, publish, svc: createDbHopeBackend(fake.db, { publish }) };
}

const batchRow = {
  id: BATCH,
  organizationId: ORG,
  providerEntityId: PE,
  submissionPeriod: "2026-06",
  status: "packaged",
  itemCount: 0,
  acceptedCount: 0,
  rejectedCount: 0,
};

/**
 * candidate ids, the validated rows (unlocked), the share-lock read of ids, the batch insert, the (multi-row) item insert, the
 * package update. The advisory key is an `execute`: no outcome.
 */
const script = (locked: readonly string[]) => [
  IDS.map((id) => ({ id })),
  IDS.map(row),
  locked.map((id) => ({ id })),
  [batchRow],
  [],
  [batchRow],
];

describe("assembleSubmission — the items are ONE multi-row insert, the share lock comes after the serialising", () => {
  it("writes every item in a single INSERT (13 binds a row), not one statement per item", async () => {
    const { svc, calls, statements } = backend(script(IDS));

    await svc.assembleSubmission(ORG, PE);

    const inserts = calls.filter((c) => c.kind === "insert");
    expect(inserts).toHaveLength(2); // the batch row, then ALL the items
    const items = inserts[1]?.value as Record<string, unknown>[];
    expect(Array.isArray(items)).toBe(true);
    expect(items.map((item) => item.hopeAssessmentId)).toEqual(IDS);
    for (const item of items) {
      expect(item).toMatchObject({
        organizationId: ORG,
        hopeSubmissionId: BATCH,
        itemStatus: "pending",
        operation: "submit",
        validationProfile: "profile-1",
      });
      expect(item.xmlStorageUri).toBe(`db://hope_submission/${BATCH}/${item.xmlFilename}`);
    }
    expect(statements.filter((s) => s.kind === "insert")).toHaveLength(2);
  });

  it("reads the validated rows unlocked, serialises them, and only then share-locks them, before the first write", async () => {
    const { svc, statements } = backend(script(IDS));
    const order: string[] = [];
    serialize.mockImplementation(async (_tx: unknown, assessment: { id: string }) => {
      order.push(`serialize:${assessment.id.slice(0, 1)}`);
      return {
        filename: `${assessment.id}.xml`,
        bytes: Buffer.from("<xml/>"),
        sha256: "e".repeat(64),
        operation: "submit",
        validationProfile: "profile-1",
      };
    });

    await svc.assembleSubmission(ORG, PE);

    expect(order).toEqual(["serialize:a", "serialize:b", "serialize:c"]);
    const kinds = statements.filter((s) => s.kind !== "execute").map((s) => s.kind);
    // ids, rows (unlocked), lock ids, batch insert, items insert, package update
    expect(kinds).toEqual(["select", "select", "select", "insert", "insert", "update"]);
    const [, rowsRead, lockRead] = statements.filter((s) => s.kind === "select");
    expect(rowsRead?.columns).toBeUndefined(); // whole rows: the serialiser reads `data`
    expect(lockRead?.columns).toEqual(["id"]); // the lock read answers ids only
  });

  it("packages only the records the share-lock read still finds: one superseded while the package was serialised is dropped", async () => {
    const { svc, calls, publish } = backend(script([IDS[0] as string, IDS[2] as string]));

    const view = await svc.assembleSubmission(ORG, PE);

    expect(serialize).toHaveBeenCalledTimes(3); // all three were serialised before the lock could tell
    const inserts = calls.filter((c) => c.kind === "insert");
    expect(inserts[0]?.value).toMatchObject({ itemCount: 2 }); // the batch counts what is packaged, not what was serialised
    const items = inserts[1]?.value as Record<string, unknown>[];
    expect(items.map((item) => item.hopeAssessmentId)).toEqual([IDS[0], IDS[2]]);
    expect(publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventName: "m10.hope.submission_queued",
        payload: expect.objectContaining({ itemCount: 2 }),
      }),
    );
    expect(view.id).toBe(BATCH);
  });

  it("answers the ordinary 409 and writes nothing when every record was superseded by the time of the lock", async () => {
    const { svc, calls, statements } = backend(script([]));

    await expect(svc.assembleSubmission(ORG, PE)).rejects.toMatchObject({
      statusCode: 409,
      message: "No signed HOPE assessments are eligible for iQIES package generation",
    });

    expect(calls).toEqual([]);
    expect(statements.some((s) => s.kind === "insert" || s.kind === "update")).toBe(false);
  });

  it("builds the ZIP once, BEFORE the share-lock read, and reuses it when every record is still packageable", async () => {
    const { svc, calls } = backend(script(IDS));

    await svc.assembleSubmission(ORG, PE);

    expect(zips.calls).toHaveLength(1);
    // selects so far: candidate ids, validated rows, then the lock read is the third: the ZIP was built before it
    expect(zips.calls[0]?.selectsSoFar()).toBe(2);
    expect(zips.calls[0]?.entries).toEqual(IDS.map((id) => `${id}.xml`));
    // and it is the stored package
    const update = calls.find((c) => c.kind === "update")?.value as {
      acceptanceReport: { files: { filename: string }[]; packageContentBase64: string };
    };
    expect(update.acceptanceReport.files.map((f) => f.filename)).toEqual(
      IDS.map((id) => `${id}.xml`),
    );
    expect(update.acceptanceReport.packageContentBase64.length).toBeGreaterThan(0);
  });

  it("rebuilds it only when the re-judgement dropped a record, and then stores the package of the records that were packaged", async () => {
    const { svc, calls } = backend(script([IDS[0] as string, IDS[2] as string]));

    await svc.assembleSubmission(ORG, PE);

    expect(zips.calls).toHaveLength(2);
    expect(zips.calls[0]?.selectsSoFar()).toBe(2); // before the lock read
    expect(zips.calls[1]?.selectsSoFar()).toBe(3); // after it: only for the survivors
    expect(zips.calls[1]?.entries).toEqual([`${IDS[0]}.xml`, `${IDS[2]}.xml`]);
    const update = calls.find((c) => c.kind === "update")?.value as {
      acceptanceReport: { files: { filename: string }[] };
    };
    expect(update.acceptanceReport.files.map((f) => f.filename)).toEqual([
      `${IDS[0]}.xml`,
      `${IDS[2]}.xml`,
    ]);
  });

  it("builds no second ZIP, and writes nothing, when nothing is packageable at the lock", async () => {
    const { svc, calls } = backend(script([]));

    await expect(svc.assembleSubmission(ORG, PE)).rejects.toMatchObject({ statusCode: 409 });

    expect(zips.calls).toHaveLength(1);
    expect(calls).toEqual([]);
  });
});
