import type { DbClient } from "@chartwarden/db";
import {
  type AdmissionStatusReader,
  type AdmissionSummary,
  DegradedError,
} from "@chartwarden/types";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import {
  type SfvRegulatoryItem,
  invalidSfvRegulatoryItemCodes,
  requireValidSfvCompletionContent,
  sfvCompletionInvalidMessage,
} from "../src/modules/10-hope/hope-sfv-completion-content";
import {
  requireSfvBoundToAdmission,
  resolveSfvAdmissionPatient,
} from "../src/modules/10-hope/hope-sfv-completion-guards";
import { buildCompletedSfvRegulatoryAnswerPlan } from "../src/modules/10-hope/hope-sfv-completion-plan";

const ORG = "11111111-1111-4111-8111-111111111111";
const ORG_OTHER = "22222222-2222-4222-8222-222222222222";
const ADMISSION = "33333333-3333-4333-8333-333333333333";
const PATIENT = "44444444-4444-4444-8444-444444444444";
const TRIGGER = "55555555-5555-4555-8555-555555555555";

function registerReader(getAdmissionSummary: AdmissionStatusReader["getAdmissionSummary"]): void {
  registerSeam("AdmissionStatusReader", { getAdmissionSummary } as AdmissionStatusReader);
}

const summaryOf = (over: Partial<AdmissionSummary>): AdmissionSummary =>
  ({ organizationId: ORG, patientId: PATIENT, ...over }) as AdmissionSummary;

describe("resolveSfvAdmissionPatient", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    __resetSeamsForTest();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("returns the admission's patient when the seam resolves it in the caller's organization", async () => {
    registerReader(async () => summaryOf({}));

    await expect(resolveSfvAdmissionPatient(ORG, ADMISSION)).resolves.toBe(PATIENT);
    expect(warn).not.toHaveBeenCalled();
  });

  it("answers a thrown seam read with a retryable 503 (DegradedError), never the 409 'no SFV obligation'", async () => {
    registerReader(async () => {
      throw new Error("connection reset while reading Jane Doe's admission");
    });

    const refusal = await resolveSfvAdmissionPatient(ORG, ADMISSION).catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(DegradedError);
    expect(refusal).toMatchObject({ code: "DEGRADED", statusCode: 503 });
    expect((refusal as Error).message).not.toContain("Jane Doe");
    // A generic label: the 503 body does not name the internal component that failed.
    expect((refusal as Error).message).not.toMatch(/M6|seam|admission/i);
  });

  it("logs the outage with the ids and the error class only, never the error's message", async () => {
    registerReader(async () => {
      throw new Error("connection reset while reading Jane Doe's admission");
    });

    await resolveSfvAdmissionPatient(ORG, ADMISSION).catch(() => undefined);

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain(ADMISSION);
    expect(line).toContain(ORG);
    expect(line).not.toContain("Jane Doe");
  });

  it.each([
    ["another organization's admission", summaryOf({ organizationId: ORG_OTHER })],
    ["an admission with no patient", summaryOf({ patientId: undefined })],
    ["no summary at all", undefined],
  ])("treats %s as the projection gap and logs it", async (_label, summary) => {
    registerReader(async () => summary as AdmissionSummary);

    await expect(resolveSfvAdmissionPatient(ORG, ADMISSION)).rejects.toMatchObject({
      code: "M10_ADMISSION_PROJECTION_GAP",
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("is keyed on the URL admission alone, so no body field can change which refusal a caller sees", async () => {
    const seen: string[] = [];
    registerReader(async (_org, admissionId) => {
      seen.push(admissionId);
      return summaryOf({});
    });

    await resolveSfvAdmissionPatient(ORG, ADMISSION);

    expect(seen).toEqual([ADMISSION]);
  });
});

describe("requireSfvBoundToAdmission", () => {
  const sfv = { id: "sfv-1", patientId: PATIENT } as Parameters<
    typeof requireSfvBoundToAdmission
  >[0];
  const MEMBERSHIP = "66666666-6666-4666-8666-666666666666";
  const caller = {
    organizationId: ORG,
    membershipId: MEMBERSHIP,
    admissionId: ADMISSION,
    triggeringAssessmentId: TRIGGER,
  };
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("accepts an SFV whose patient is the admission's, logging nothing", () => {
    expect(() => requireSfvBoundToAdmission(sfv, PATIENT, caller)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses a missing SFV and a mispaired one with the identical 409 NO_TRIGGER (message included)", () => {
    const refusalOf = (row: typeof sfv, patient: string): unknown => {
      try {
        requireSfvBoundToAdmission(row, patient, caller);
      } catch (error) {
        return error;
      }
      return undefined;
    };

    const missing = refusalOf(undefined, PATIENT);
    const mispaired = refusalOf(sfv, "99999999-9999-4999-8999-999999999999");

    expect(missing).toMatchObject({ code: "M10_SFV_NO_TRIGGER", statusCode: 409 });
    expect(mispaired).toMatchObject({ code: "M10_SFV_NO_TRIGGER", statusCode: 409 });
    expect((mispaired as Error).message).toBe((missing as Error).message);
  });

  it("leaves a server-side warn naming the org, membership, admission and triggering ids, and nothing else", () => {
    const mispaired = "99999999-9999-4999-8999-999999999999";

    expect(() => requireSfvBoundToAdmission(sfv, mispaired, caller)).toThrow();

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    for (const id of [ORG, MEMBERSHIP, ADMISSION, TRIGGER]) expect(line).toContain(id);
    expect(line).not.toContain(PATIENT);
  });

  it("masks an id that is not a uuid, so a direct service call cannot forge a log line", () => {
    expect(() =>
      requireSfvBoundToAdmission(undefined, PATIENT, {
        ...caller,
        triggeringAssessmentId: "x\nm10: forged line",
      }),
    ).toThrow();

    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).not.toContain("forged");
    expect(line).toContain("[not-a-uuid]");
  });
});

/** Just enough of the J2052/J2053 spec rows: coded items with the CMS option set, J2052B as a date. */
function specItems(): ReadonlyMap<string, SfvRegulatoryItem> {
  const coded = (itemCode: string, codes: readonly string[]): [string, SfvRegulatoryItem] => [
    itemCode,
    {
      item: { id: itemCode, itemCode, cmsItemTypeCode: "Code", fixedRecordLength: 1 },
      options: codes.map((valueCode) => ({
        specItemId: itemCode,
        valueCode,
        label: valueCode === "^" ? "Blank (skip pattern)" : `option ${valueCode}`,
      })),
    } as unknown as SfvRegulatoryItem,
  ];
  const impact = ["0", "1", "2", "3", "9", "^"];
  return new Map<string, SfvRegulatoryItem>([
    coded("J2052A", ["0", "1", "^"]),
    [
      "J2052B",
      {
        item: { id: "J2052B", itemCode: "J2052B", cmsItemTypeCode: "Date", fixedRecordLength: 8 },
        options: [{ specItemId: "J2052B", valueCode: "YYYYMMDD", label: "Date of in-person SFV" }],
      } as unknown as SfvRegulatoryItem,
    ],
    ...["A", "B", "C", "D", "E", "F", "G", "H"].map((l) => coded(`J2053${l}`, impact)),
  ]);
}

const planWith = (over: Record<string, unknown>, completedDate = "2026-09-09") => {
  const j2053 = {
    ...Object.fromEntries(["A", "B", "C", "D", "E", "F", "G", "H"].map((l) => [`J2053${l}`, "1"])),
    ...over,
  };
  const plan = buildCompletedSfvRegulatoryAnswerPlan(completedDate, { J: { J2053: j2053 } });
  if (!plan) throw new Error("fixture plan must be complete");
  return plan;
};

describe("invalidSfvRegulatoryItemCodes", () => {
  it("accepts every CMS option for the follow-up items, including N/A (9) and a numeric 3", () => {
    const plan = planWith({ J2053A: "0", J2053B: 3, J2053C: "2", J2053D: "9" });

    expect(invalidSfvRegulatoryItemCodes(plan, specItems())).toEqual([]);
  });

  it.each([
    ["an arbitrary string", "x"],
    ["an out-of-range number", 99999],
    ["the skip-pattern caret", "^"],
    ["a value with surrounding space", " 1"],
  ])("flags %s as not allowed", (_label, value) => {
    const plan = planWith({ J2053A: value });

    expect(invalidSfvRegulatoryItemCodes(plan, specItems())).toEqual(["J2053A"]);
  });

  it("names every offending follow-up item, in item order", () => {
    const plan = planWith({ J2053C: "nope", J2053H: "7" });

    expect(invalidSfvRegulatoryItemCodes(plan, specItems())).toEqual(["J2053C", "J2053H"]);
  });

  it.each([
    ["a Feb 30", "2026-02-30"],
    ["month 13", "2026-13-01"],
    ["a non-leap Feb 29", "2026-02-29"],
  ])("flags the server-written J2052B date when it is %s", (_label, completedDate) => {
    const plan = planWith({}, completedDate);

    expect(invalidSfvRegulatoryItemCodes(plan, specItems())).toEqual(["J2052B"]);
  });

  it("accepts a real leap day as the J2052B date", () => {
    expect(invalidSfvRegulatoryItemCodes(planWith({}, "2028-02-29"), specItems())).toEqual([]);
  });

  it("does not judge an item the spec does not carry active for the ISC (it is never written)", () => {
    const withoutB = new Map(specItems());
    withoutB.delete("J2053B");

    expect(invalidSfvRegulatoryItemCodes(planWith({ J2053B: "x" }), withoutB)).toEqual([]);
  });
});

describe("sfvCompletionInvalidMessage", () => {
  it("lists item codes and never a submitted value", () => {
    const message = sfvCompletionInvalidMessage(["J2053A", "J2053C"]);

    expect(message).toContain("J2053A, J2053C");
    expect(message).toContain("nothing was written");
  });
});

/**
 * A tx whose k-th `select()` resolves to the k-th scripted result, whatever the chain (`from`, `innerJoin`, `where`,
 * `orderBy`, `limit`). Enough to drive the guard's three reads: the triggering assessment, the newest HA spec, the items.
 */
function scriptedTx(results: readonly unknown[][]): { tx: DbClient; selects: () => number } {
  let call = 0;
  const chain = (rows: unknown[]): unknown => {
    const link: Record<string, unknown> = {
      // biome-ignore lint/suspicious/noThenProperty: a Drizzle query chain is awaited at a different link per query
      then: (resolve: (value: unknown[]) => unknown) => resolve(rows),
    };
    for (const name of ["from", "innerJoin", "where", "orderBy", "limit"]) link[name] = () => link;
    return link;
  };
  const tx = { select: () => chain(results[call++] ?? []) } as unknown as DbClient;
  return { tx, selects: () => call };
}

describe("requireValidSfvCompletionContent for a triggering assessment with no frozen spec", () => {
  const sfv = { id: "sfv-1", triggeringAssessmentId: TRIGGER } as Parameters<
    typeof requireValidSfvCompletionContent
  >[2];
  const completion = (over: Record<string, unknown>) => ({
    completedDate: "2026-09-09",
    data: {
      J: {
        J2053: {
          ...Object.fromEntries(
            ["A", "B", "C", "D", "E", "F", "G", "H"].map((l) => [`J2053${l}`, "1"]),
          ),
          ...over,
        },
      },
    },
  });
  // The triggering assessment's OWN target date picks the spec an unfrozen one is judged against (the date
  // `ensureDraftSpecInitialized` later freezes it by), never the server's clock.
  const unfrozen = [
    { specVersionId: null, isc: null, targetDate: new Date("2026-09-09T12:00:00.000Z") },
  ];
  const newestHa = [{ specVersionId: "spec-newest" }];
  const items = [...specItems().values()].map(({ item }) => ({ item }));
  const options = [...specItems().values()].flatMap(({ options: rows }) => rows);

  it("judges the values against the newest HA spec's options and refuses an invalid one", async () => {
    const { tx } = scriptedTx([unfrozen, newestHa, items, options]);

    await expect(
      requireValidSfvCompletionContent(tx, ORG, sfv, completion({ J2053A: "x" })),
    ).rejects.toMatchObject({ code: "M10_SFV_COMPLETION_INCOMPLETE" });
  });

  it("accepts valid options against that spec", async () => {
    const { tx } = scriptedTx([unfrozen, newestHa, items, options]);

    await expect(
      requireValidSfvCompletionContent(tx, ORG, sfv, completion({ J2053A: "3" })),
    ).resolves.toMatchObject({ answered: expect.any(Map) });
  });

  it("refuses, rather than silently skipping the CMS-value check, when no HA spec is in force on that date", async () => {
    const { tx, selects } = scriptedTx([unfrozen, []]);

    // A typed 422 (a data fault the clinician sees and an administrator fixes), never an unmapped error answered as a 500.
    const failure = await requireValidSfvCompletionContent(
      tx,
      ORG,
      sfv,
      completion({ J2053A: "x" }),
    ).catch((e: unknown) => e);

    expect(failure).toMatchObject({ code: "M10_SPEC_NOT_IN_FORCE", statusCode: 422 });
    // PHI-free: the refusal text names no date (the target date of a patient's record) and no value.
    expect((failure as Error).message).not.toContain("2026-09-09");
    expect((failure as Error).message).not.toContain('"x"');
    expect(selects()).toBe(2); // the triggering row, then the (empty) spec lookup
  });

  it("still refuses missing J2053 content without reading anything", async () => {
    const { tx, selects } = scriptedTx([]);

    await expect(
      requireValidSfvCompletionContent(tx, ORG, sfv, {
        completedDate: "2026-09-09",
        data: {},
      }),
    ).rejects.toMatchObject({ code: "M10_SFV_COMPLETION_INCOMPLETE" });
    expect(selects()).toBe(0);
  });
});

describe("the spec an unfrozen triggering assessment is judged against is one in force on ITS OWN target date", () => {
  const sfv = { id: "sfv-1", triggeringAssessmentId: TRIGGER } as Parameters<
    typeof requireValidSfvCompletionContent
  >[2];
  const data = {
    J: {
      J2053: Object.fromEntries(
        ["A", "B", "C", "D", "E", "F", "G", "H"].map((l) => [`J2053${l}`, "1"]),
      ),
    },
  };

  const unfrozenAt = (day: string) => ({
    specVersionId: null,
    isc: null,
    targetDate: new Date(`${day}T12:00:00.000Z`),
  });
  const newestHa = [{ specVersionId: "spec-newest" }];

  /** Records, per `select()`, the SQL and params of its `where` and the SQL of its `orderBy`, and answers the scripted rows. */
  function capturingTx(results: readonly unknown[][]) {
    const dialect = new PgDialect();
    const captured: { where: string; params: unknown[]; orderBy: string }[] = [];
    let call = 0;
    const tx = {
      select: () => {
        const entry = { where: "", params: [] as unknown[], orderBy: "" };
        captured.push(entry);
        const rows = results[call++] ?? [];
        const link: Record<string, unknown> = {
          // biome-ignore lint/suspicious/noThenProperty: a Drizzle query chain is awaited at a different link per query
          then: (resolve: (value: unknown[]) => unknown) => resolve(rows),
        };
        for (const name of ["from", "innerJoin", "limit"]) link[name] = () => link;
        link.where = (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
          const query = dialect.sqlToQuery(condition);
          entry.where = query.sql;
          entry.params = query.params;
          return link;
        };
        link.orderBy = (...order: Parameters<PgDialect["sqlToQuery"]>[0][]) => {
          entry.orderBy = order.map((o) => dialect.sqlToQuery(o).sql).join(", ");
          return link;
        };
        return link;
      },
    } as unknown as DbClient;
    return { tx, captured };
  }

  it("bounds the lookup by effective_from and effective_to, so a future-dated or retired version is never chosen", async () => {
    const { tx, captured } = capturingTx([[unfrozenAt("2026-09-09")], newestHa]);

    await requireValidSfvCompletionContent(tx, ORG, sfv, {
      completedDate: "2026-09-09",
      data,
    });

    const lookup = captured[1];
    expect(lookup?.where).toMatch(/"effective_from" <= \$\d+/);
    expect(lookup?.where).toMatch(/"effective_to" is null or .*"effective_to" >= \$\d+/);
  });

  it("orders versions that started the same day deterministically: newest start, then creation time, then id", async () => {
    const { tx, captured } = capturingTx([[unfrozenAt("2026-09-09")], newestHa]);

    await requireValidSfvCompletionContent(tx, ORG, sfv, {
      completedDate: "2026-09-09",
      data,
    });

    expect(captured[1]?.orderBy).toMatch(/"effective_from" desc, .*"created_at" desc, .*"id" desc/);
  });

  it("picks the spec by the triggering assessment's target date, never by the server's date", async () => {
    const { tx, captured } = capturingTx([[unfrozenAt("2026-03-01")], newestHa]);

    await requireValidSfvCompletionContent(tx, ORG, sfv, {
      completedDate: "2026-09-09",
      data,
    });

    expect(captured[1]?.params).toContain("2026-03-01");
    expect(captured[1]?.params).not.toContain(new Date().toISOString().slice(0, 10));
  });
});
