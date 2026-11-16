import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSeamsForTest } from "../src/bootstrap/index";
import {
  ASSEMBLE_CANDIDATE_LIMIT,
  lockPackageableRecords,
  readAssembleCandidateIds,
  validateCandidates,
} from "../src/modules/10-hope/hope-assemble-candidates";
import { createDbHopeBackend } from "../src/modules/10-hope/hope-route-service-db";
import { HopeValidationFindingSitingError } from "../src/modules/10-hope/hope-validation-service";
import { SCRIPT_EXHAUSTED, renderSql, scriptedDb } from "./_hope-g3-fake-db";

// assembleSubmission (database review, pre-PR): (1) a record the validator cannot site (no location) is skipped, never a 409 for
// the whole entity; (2) a call looks at a bounded number of records, ids only, the known-refused ones last; (7) the records
// that passed are judged again, under the key, just before the package is written. The validator is stubbed (it needs the
// spec corpus); the database is scripted, so the statements and their order are asserted here and the behaviour against a real
// Postgres is the live suite's (m10-hope-submission-result.live.test.ts).
const validate = vi.hoisted(() => vi.fn());
vi.mock("../src/modules/10-hope/hope-validation-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/modules/10-hope/hope-validation-service")>();
  return { ...actual, createHopeValidationService: () => ({ validateAssessment: validate }) };
});

const ORG = "11111111-1111-4111-8111-111111111111";
const PE = "abcdef01-2345-4678-89ab-cdef01234567";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const clean = { findings: [] };

interface SelectCall {
  limit?: unknown;
  orderBy: string[];
  lock?: unknown;
}

/** The scripted database, plus what each `select` chain was given for `orderBy`, `limit` and the row lock (the fake records only `where`). */
function backend(outcomes: Parameters<typeof scriptedDb>[0]) {
  const fake = scriptedDb(outcomes);
  const tx = fake.tx as unknown as Record<string, (...a: unknown[]) => Record<string, unknown>>;
  const selects: SelectCall[] = [];
  const realSelect = tx.select?.bind(tx);
  if (!realSelect) throw new Error("the scripted transaction has no select");
  tx.select = (...args: unknown[]) => {
    const link = realSelect(...args);
    const call: SelectCall = { orderBy: [] };
    selects.push(call);
    for (const method of ["limit", "orderBy", "for"] as const) {
      const real = (link[method] as (...a: unknown[]) => unknown).bind(link);
      link[method] = (...given: unknown[]) => {
        if (method === "limit") call.limit = given[0];
        if (method === "for") call.lock = given[0];
        if (method === "orderBy") {
          call.orderBy = given.map((part) => {
            try {
              return renderSql(part).sql;
            } catch {
              return String((part as { name?: string }).name);
            }
          });
        }
        return real(...given);
      };
    }
    return link;
  };
  return {
    ...fake,
    selects,
    svc: createDbHopeBackend(fake.db, { publish: vi.fn(async () => undefined) }),
  };
}

let warn: MockInstance;
beforeEach(() => {
  validate.mockReset();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  __resetSeamsForTest();
});
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { code?: string; statusCode?: number; message?: string }) => e,
  );

describe("validateCandidates — one refused or unsited record never stops the others", () => {
  it("skips a record with no siting (reporting its id), keeps going, and returns the ones that passed in order", async () => {
    const unsited: string[] = [];
    const run = vi.fn(async (id: string) => {
      if (id === A) throw new HopeValidationFindingSitingError(A);
      return clean;
    });

    const passed = await validateCandidates([A, B, C], run, (id) => unsited.push(id));

    expect(passed).toEqual([B, C]);
    expect(unsited).toEqual([A]);
    expect(run.mock.calls.map(([id]) => id)).toEqual([A, B, C]);
  });

  it("drops a record whose final validation has an ERROR finding, and keeps one with only warnings", async () => {
    const run = async (id: string) => ({
      findings: id === A ? [{ severity: "error" }] : [{ severity: "warning" }],
    });

    expect(await validateCandidates([A, B], run, () => undefined)).toEqual([B]);
  });

  it("lets any other failure through: it is not a per-record refusal", async () => {
    const failure = new Error("pool is gone");
    const run = async () => {
      throw failure;
    };

    await expect(validateCandidates([A], run, () => undefined)).rejects.toBe(failure);
  });
});

describe("readAssembleCandidateIds — a bounded read of ids, known-refused records last", () => {
  it("selects ONLY the id, limited to ASSEMBLE_CANDIDATE_LIMIT, with the known-refused records after the rest and oldest signed first", async () => {
    const { tx, statements, selects } = backend([[{ id: A }, { id: B }]]);

    const ids = await readAssembleCandidateIds(tx, ORG, PE);

    expect(ids).toEqual([A, B]);
    expect(ASSEMBLE_CANDIDATE_LIMIT).toBe(200);
    expect(statements[0]?.columns).toEqual(["id"]);
    expect(selects[0]?.limit).toBe(200);
    const [refused, signedAt, id] = selects[0]?.orderBy ?? [];
    expect(refused).toContain('"location_id" is null');
    expect(refused).toContain('"hope_validation_finding"."resolved" = ');
    expect(refused).toContain("severity");
    expect(signedAt).toContain("signed_at");
    expect(id).toContain('"id"');
  });

  it("tests a missing iQIES record id with IS NULL only (a blank id is no longer a case: the partial index answers IS NULL)", async () => {
    const { tx, statements } = backend([[]]);

    await readAssembleCandidateIds(tx, ORG, PE);

    const where = statements[0]?.rendered?.sql ?? "";
    expect(where).toContain('"iqies_record_id" is null');
    expect(where).not.toMatch(/iqies_record_id" = /);
    expect(statements[0]?.rendered?.params).toEqual(expect.arrayContaining([ORG, PE, "signed"]));
  });
});

describe("assembleSubmission — a record without siting is skipped, not a 409 for every assemble of its entity", () => {
  it("validates the next candidate after one the validator cannot site, and packages from the ones that passed", async () => {
    validate.mockImplementation(async ({ assessmentId }: { assessmentId: string }) => {
      if (assessmentId === A) throw new HopeValidationFindingSitingError(A);
      return clean;
    });
    const rowB = { id: B, status: "signed", specVersionId: "s", isc: "HA", version: 1 };
    // the candidate read, then the re-assertion; the script ends at the first statement of the package build
    const { svc, statements, selects } = backend([[{ id: A }, { id: B }], [rowB]]);

    const failure = await outcome(svc.assembleSubmission(ORG, PE));

    expect(validate.mock.calls.map(([input]) => input.assessmentId)).toEqual([A, B]);
    expect(failure?.message).toBe(SCRIPT_EXHAUSTED); // it went on to build the package from B, not a 409 from A
    const relock = statements.filter((s) => s.kind === "select")[1];
    expect(relock?.rendered?.params).toContain(B);
    expect(relock?.rendered?.params).not.toContain(A);
    expect(selects[1]?.lock).toBe("share");
    // the skip leaves a line naming ids only, no record content
    const lines = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(lines).toContain(`assessment ${A}`);
    expect(lines).toContain(`org ${ORG}`);
    expect(lines).toContain("no provider entity / location siting");
  });

  it("answers the ordinary 409 when every candidate is unsited (nothing packageable), not the siting error", async () => {
    validate.mockRejectedValue(new HopeValidationFindingSitingError(A));
    const { svc } = backend([[{ id: A }]]);

    const failure = await outcome(svc.assembleSubmission(ORG, PE));

    expect(failure).toMatchObject({ statusCode: 409 });
    expect(failure?.message).toBe(
      "No signed HOPE assessments are eligible for iQIES package generation",
    );
  });
});

describe("assembleSubmission — the records are judged again under the key, just before the package is written", () => {
  it("a record superseded after it was read and validated (a correction signed meanwhile) is not packaged", async () => {
    validate.mockResolvedValue(clean);
    // the candidate read still sees A; the re-assertion no longer does (the supersede trigger flipped it)
    const { svc, statements, selects } = backend([[{ id: A }], []]);

    const failure = await outcome(svc.assembleSubmission(ORG, PE));

    expect(failure?.message).toBe(
      "No signed HOPE assessments are eligible for iQIES package generation",
    );
    const reads = statements.filter((s) => s.kind === "select");
    expect(reads).toHaveLength(2);
    const where = reads[1]?.rendered;
    expect(where?.sql).toContain('"status" = ');
    expect(where?.sql).toContain("not exists (select 1 from");
    expect(where?.sql).toContain('"id" in (');
    expect(where?.params).toEqual(expect.arrayContaining([ORG, PE, "signed", A]));
    expect(selects[1]?.lock).toBe("share");
    // nothing was written
    expect(statements.some((s) => s.kind === "insert" || s.kind === "update")).toBe(false);
  });

  it("reads no row lock when nothing passed validation (an empty id list is no statement)", async () => {
    const { tx, statements } = backend([]);

    expect(await lockPackageableRecords(tx, ORG, PE, [])).toEqual([]);
    expect(statements).toEqual([]);
  });
});
