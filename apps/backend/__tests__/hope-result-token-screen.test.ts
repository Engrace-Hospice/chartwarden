import { looksLikeMbi } from "@chartwarden/shared";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { loadSubmissionFindings } from "../src/modules/10-hope/hope-submission-reads-db";
import { createDbHopeBackend, createInMemoryHopeBackend } from "../src/modules/10-hope/index";
import {
  RESULT_ROW_TOKENS,
  assertResultRowsAreClean,
  assertSubmissionReferenceIsClean,
  cleanResultRows,
} from "../src/modules/10-hope/routes/hope-reference-screen";
import {
  HOPE_RESULT_CODE_PATTERN,
  HOPE_RESULT_SEVERITIES,
  HOPE_RESULT_SEVERITY_PATTERN,
  HOPE_RESULT_TOKEN_MAX_LENGTH,
  ImportSubmissionResultSchema,
} from "../src/modules/10-hope/routes/hope-typebox";
import { scriptedDb } from "./_hope-g3-fake-db";

// The operator-typed references and the fields of every CMS result row are checked by the route AND by the service: the FORMAT
// (the schema's patterns, and what the database cannot store) and the CONTENT (the patient-identifier screen, plus a date shape
// and a phone shape for the code-like tokens). Synthetic identifiers only (area 900 SSN; the listed synthetic MBI).
const ORG = "11111111-1111-4111-8111-111111111111";
const MEMBERSHIP = "22222222-2222-4222-8222-222222222222";
const SUB = "66666666-6666-4666-8666-666666666666";
const ASSESSMENT = "77777777-7777-4777-8777-777777777777";
const SSN = "900-12-3456";
const MBI = "1EG4TE5MK73";
/** A uuid whose hex digits spell an MBI window ("1ac1ac1aa11"): the MBI screen alone would refuse it. */
const MBI_SHAPED_UUID = "1ac1ac1a-a110-4000-8000-000000000000";

const failureOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error as {
      code: string;
      statusCode: number;
      details: { field: string }[];
      message: string;
    };
  }
  return undefined;
};
const refusal = async (run: () => Promise<unknown>) => run().catch((e: unknown) => e);
const row = (token: Record<string, unknown>) => ({ assessmentId: ASSESSMENT, ...token });

describe("the exact patterns and the severity set", () => {
  it("the severity pattern is the closed list, any case, or empty, and nothing else", () => {
    const pattern = new RegExp(HOPE_RESULT_SEVERITY_PATTERN);
    for (const word of HOPE_RESULT_SEVERITIES) {
      for (const spelled of [word, word.toUpperCase(), word[0]?.toUpperCase() + word.slice(1)])
        expect(pattern.test(spelled), spelled).toBe(true);
    }
    expect(pattern.test("")).toBe(true);
    for (const other of ["info", "warn", "moderate", "errors", " error", "error ", "fatal error"])
      expect(pattern.test(other), other).toBe(false);
  });

  it("the code pattern is one word: no space, no slash, at most 64 characters, empty allowed", () => {
    const pattern = new RegExp(HOPE_RESULT_CODE_PATTERN);
    for (const ok of ["", "-3015", "A0050", "J2051", "ERR-0012", "REC-2026.06:a#3", "a".repeat(64)])
      expect(pattern.test(ok), ok).toBe(true);
    for (const bad of [
      "E 1",
      " E1",
      "E1 ",
      "03/12/1950",
      "a/b",
      "a".repeat(65),
      "<b>",
      'E"1',
      "E\n1",
    ])
      expect(pattern.test(bad), bad).toBe(false);
  });
});

describe("assertResultRowsAreClean: identifiers", () => {
  it("names the row and the token, never the value", () => {
    const failure = failureOf(() =>
      assertResultRowsAreClean([{ assessmentId: ASSESSMENT, status: "accepted" }, { code: SSN }]),
    );

    expect(failure).toMatchObject({ code: "EVIDENCE_LOOKS_LIKE_PHI", statusCode: 422 });
    expect(failure?.details).toEqual([expect.objectContaining({ field: "results.1.code" })]);
    expect(JSON.stringify({ message: failure?.message, details: failure?.details })).not.toContain(
      SSN,
    );
  });

  it.each([
    ["an SSN in a code", { code: SSN }],
    ["an MBI in an item code", { itemCode: MBI }],
    ["an SSN in a record id", { iqiesRecordId: SSN }],
    ["an MBI in a status phrase", { status: `Rejected ${MBI}` }],
    ["a year-first date in a code", { code: "1950-03-12" }],
    ["a year-first dotted date in an item code", { itemCode: "1950.03.12" }],
    ["a day-first dotted date in a record id", { iqiesRecordId: "12.03.1950" }],
    ["a month-first dashed date in a code", { code: "03-12-1950" }],
    ["a US phone number in a code", { code: "555-867-5309" }],
    ["a US phone number with a leading 1 in a record id", { iqiesRecordId: "1.555.867.5309" }],
  ])("refuses %s as a patient identifier (422, nothing echoed)", (_label, token) => {
    const failure = failureOf(() => assertResultRowsAreClean([row(token)]));

    expect(failure).toMatchObject({ code: "EVIDENCE_LOOKS_LIKE_PHI", statusCode: 422 });
    const value = String(Object.values(token)[0]);
    expect(JSON.stringify({ message: failure?.message, details: failure?.details })).not.toContain(
      value,
    );
  });

  it("a date or a phone number is refused only in a code-like token, not in a status phrase", () => {
    expect(() =>
      assertResultRowsAreClean([row({ status: "received 2026-06-01, pending review" })]),
    ).not.toThrow();
  });

  it("an assessmentId that is no uuid is screened; a uuid is not (an MBI-shaped uuid passes)", () => {
    expect(looksLikeMbi(MBI_SHAPED_UUID)).toBe(true); // not vacuous: the screen alone would refuse it
    expect(failureOf(() => assertResultRowsAreClean([{ assessmentId: SSN }]))).toMatchObject({
      code: "EVIDENCE_LOOKS_LIKE_PHI",
    });
    expect(failureOf(() => assertResultRowsAreClean([{ assessmentId: SSN }]))?.details).toEqual([
      expect.objectContaining({ field: "results.0.assessmentId" }),
    ]);
    expect(() => assertResultRowsAreClean([{ assessmentId: MBI_SHAPED_UUID }])).not.toThrow();
    expect(() => assertResultRowsAreClean([{ assessmentId: ` ${ASSESSMENT} ` }])).not.toThrow();
  });

  it("an iqiesRecordId that is a uuid is exempt from the identifier screen, a code is not", () => {
    expect(() => assertResultRowsAreClean([row({ iqiesRecordId: MBI_SHAPED_UUID })])).not.toThrow();
    expect(() => assertResultRowsAreClean([row({ code: MBI_SHAPED_UUID })])).toThrow();
  });

  it("a message is screened too", () => {
    const failure = failureOf(() =>
      assertResultRowsAreClean([row({ message: `Edit failed for beneficiary ${SSN}` })]),
    );

    expect(failure).toMatchObject({ code: "EVIDENCE_LOOKS_LIKE_PHI", statusCode: 422 });
    expect(failure?.details).toEqual([expect.objectContaining({ field: "results.0.message" })]);
    expect(JSON.stringify(failure)).not.toContain(SSN);
  });

  it("passes the codes and prose CMS sends", () => {
    expect(() =>
      assertResultRowsAreClean([
        {
          assessmentId: ASSESSMENT,
          status: "Accepted with warnings",
          severity: "WARNING",
          code: "-3015",
          itemCode: "J2051A",
          iqiesRecordId: "ERR-0012",
          message:
            "Item A0050 (Enter Type of Record) must be 1, 2 or 3.\n\tCheck the admission date entered for this record.",
        },
        { status: "", code: undefined, severity: "", message: "" },
      ]),
    ).not.toThrow();
  });

  it("every screened token key is listed with its pattern", () => {
    expect(RESULT_ROW_TOKENS.map((t) => t.key)).toEqual([
      "status",
      "result",
      "outcome",
      "severity",
      "code",
      "itemCode",
      "iqiesRecordId",
    ]);
  });
});

describe("assertResultRowsAreClean: what the database cannot store, and the patterns", () => {
  const invalid = (rows: Record<string, unknown>[]) =>
    failureOf(() => assertResultRowsAreClean(rows));

  it.each([
    ["a NUL in a message", { message: "edit\u0000failed" }, "results.0.message"],
    ["an escape character in a message", { message: "edit\u001bfailed" }, "results.0.message"],
    ["a lone high surrogate in a message", { message: "edit \uD83D failed" }, "results.0.message"],
    ["a lone low surrogate in a message", { message: "edit \uDE00 failed" }, "results.0.message"],
    ["a NUL in an assessmentId", { assessmentId: "abc\u0000def" }, "results.0.assessmentId"],
    ["a line feed in an assessmentId", { assessmentId: "abc\ndef" }, "results.0.assessmentId"],
    [
      "a lone surrogate in an assessmentId",
      { assessmentId: "abc\uD83D" },
      "results.0.assessmentId",
    ],
  ])("%s is a static 422 (not a database error)", (_label, fields, field) => {
    const failure = invalid([fields]);

    expect(failure).toMatchObject({ statusCode: 422 });
    expect(failure?.details).toEqual([
      expect.objectContaining({ field, code: "INVALID_CHARACTERS" }),
    ]);
    expect(JSON.stringify(failure)).not.toContain("failed");
  });

  it("a message may hold tabs, line feeds and carriage returns, and a well-formed surrogate pair", () => {
    expect(() =>
      assertResultRowsAreClean([row({ message: "line one\r\n\tline two \u{1F6D1} end" })]),
    ).not.toThrow();
  });

  it.each([
    ["a code with a space", { code: "E 1" }, "results.0.code"],
    ["a code with a slash", { code: "E/1" }, "results.0.code"],
    ["a record id of only spaces", { iqiesRecordId: "   " }, "results.0.iqiesRecordId"],
    ["a severity outside the closed set", { severity: "info" }, "results.0.severity"],
    ["a status with markup", { status: "<b>ok</b>" }, "results.0.status"],
    [
      "a token over 64 characters",
      { code: "a".repeat(HOPE_RESULT_TOKEN_MAX_LENGTH + 1) },
      "results.0.code",
    ],
  ])("%s is refused by the SERVICE's own pattern check", (_label, token, field) => {
    const failure = invalid([row(token)]);

    expect(failure).toMatchObject({ statusCode: 422, code: "VALIDATION_FAILED" });
    expect(failure?.details).toEqual([expect.objectContaining({ field })]);
  });

  it("the schema and the service agree: whatever the schema accepts, the service accepts", () => {
    const rows = [
      row({ status: "received, pending review (2 notes)", severity: "Fatal", code: "-3015" }),
      row({ itemCode: "A0050", iqiesRecordId: "ERR-0012", message: "ok" }),
    ];

    expect(Value.Check(ImportSubmissionResultSchema, { results: rows })).toBe(true);
    expect(() => assertResultRowsAreClean(rows)).not.toThrow();
  });
});

describe("assertSubmissionReferenceIsClean", () => {
  it.each([
    ["only spaces", "      "],
    ["a leading space", " UP-1"],
    ["empty", ""],
    ["markup", "<b>ref</b>"],
    ["129 characters", "a".repeat(129)],
  ])("refuses a reference that is %s (422 VALIDATION_FAILED)", (_label, value) => {
    expect(
      failureOf(() => assertSubmissionReferenceIsClean("reportReference", value)),
    ).toMatchObject({ statusCode: 422, code: "VALIDATION_FAILED" });
  });

  it("refuses an identifier-shaped reference without echoing it, and passes an ordinary one or none", () => {
    const failure = failureOf(() => assertSubmissionReferenceIsClean("reportReference", SSN));

    expect(failure).toMatchObject({ code: "EVIDENCE_LOOKS_LIKE_PHI" });
    expect(JSON.stringify(failure)).not.toContain(SSN);
    expect(() =>
      assertSubmissionReferenceIsClean("iqiesSubmissionReference", "UP-2026/06 #12"),
    ).not.toThrow();
    expect(() => assertSubmissionReferenceIsClean("reportReference", null)).not.toThrow();
    expect(() => assertSubmissionReferenceIsClean("reportReference", undefined)).not.toThrow();
  });
});

describe("the service re-applies all of it before any statement", () => {
  const backend = () => {
    const fake = scriptedDb([]);
    return { ...fake, svc: createDbHopeBackend(fake.db, { publish: async () => undefined }) };
  };

  it.each([
    ["an SSN reportReference", { reportReference: SSN, results: [row({ status: "accepted" })] }],
    ["a reportReference with a leading space", { reportReference: " FVR", results: [row({})] }],
    ["a code with a space", { results: [row({ code: "E 1" })] }],
    ["a date-shaped code", { results: [row({ code: "1950-03-12" })] }],
    ["a phone-shaped record id", { results: [row({ iqiesRecordId: "555-867-5309" })] }],
    ["a record id of only spaces", { results: [row({ iqiesRecordId: "   " })] }],
    ["a severity outside the closed set", { results: [row({ severity: "info" })] }],
    ["a NUL in a message", { results: [row({ message: "a\u0000b" })] }],
    ["an SSN in a message", { results: [row({ message: `for ${SSN}` })] }],
    ["an SSN assessmentId", { results: [{ assessmentId: SSN }] }],
  ])("importSubmissionResult refuses %s with a 422", async (_label, args) => {
    const { svc, statements } = backend();

    const failure = await refusal(() => svc.importSubmissionResult(ORG, MEMBERSHIP, SUB, args));

    expect(failure).toMatchObject({ statusCode: 422 });
    expect(statements).toEqual([]);
  });

  it.each([
    ["an SSN", SSN, "EVIDENCE_LOOKS_LIKE_PHI"],
    ["a leading space", " UP-1", "VALIDATION_FAILED"],
  ])(
    "markSubmissionUploaded refuses an iqiesSubmissionReference with %s",
    async (_l, ref, code) => {
      const { svc, statements } = backend();

      const failure = await refusal(() =>
        svc.markSubmissionUploaded(ORG, MEMBERSHIP, SUB, { iqiesSubmissionReference: ref }),
      );

      expect(failure).toMatchObject({ code, statusCode: 422 });
      expect(statements).toEqual([]);
    },
  );
});

describe("date and phone shapes with every separator a code may hold", () => {
  it.each([
    "1990_05_17",
    "1990:05:17",
    "1990#05#17",
    "05_17_1990",
    "05:17:1990",
    "05#17#1990",
    "1990-05_17",
    "555_867_5309",
    "555:867:5309",
    "555#867#5309",
    "1_555_867_5309",
  ])("refuses %s in a code (a date or a phone number)", (value) => {
    expect(failureOf(() => assertResultRowsAreClean([row({ code: value })]))).toMatchObject({
      code: "EVIDENCE_LOOKS_LIKE_PHI",
      statusCode: 422,
    });
  });

  it.each(["-3015", "A0050", "J2051", "ERR-0012", "REC-2026.06:a#3"])(
    "still accepts %s",
    (value) => {
      expect(() => assertResultRowsAreClean([row({ code: value })])).not.toThrow();
    },
  );

  it("compact digit runs and month-name dates stay a documented residual (they pass)", () => {
    for (const value of ["19900517", "5558675309", "05-17-90", "12-Mar-1945"])
      expect(() => assertResultRowsAreClean([row({ code: value })]), value).not.toThrow();
  });
});

describe("an assessmentId is spelt like an id, and is trimmed before it is read", () => {
  it("a trailing CR, LF or tab (a CRLF-split CSV) is a blank: it passes and is stored trimmed", () => {
    for (const blank of ["\r", "\n", "\t", " \r\n"]) {
      const [clean] = cleanResultRows([
        { assessmentId: `${ASSESSMENT}${blank}`, status: "accepted" },
      ]);
      expect(clean).toEqual({ assessmentId: ASSESSMENT, status: "accepted" });
    }
  });

  it("a control character INSIDE the id, a NUL and a lone surrogate are still refused", () => {
    for (const bad of [
      `${ASSESSMENT.slice(0, 8)}\u0000${ASSESSMENT.slice(8)}`,
      `${ASSESSMENT}\uD83D`,
      `abc\ndef`,
    ]) {
      expect(failureOf(() => assertResultRowsAreClean([{ assessmentId: bad }]))).toMatchObject({
        statusCode: 422,
      });
    }
  });

  it.each([
    ["a name", "Jane Q Public"],
    ["a word", "not-a-uuid"],
    ["only blanks", "   "],
    ["a slash", "a/b"],
  ])("%s is no assessment id (a static 422, never echoed)", (_label, assessmentId) => {
    const failure = failureOf(() => assertResultRowsAreClean([{ assessmentId }]));

    expect(failure).toMatchObject({ code: "VALIDATION_FAILED", statusCode: 422 });
    expect(JSON.stringify(failure)).not.toContain(assessmentId.trim() || "unreachable-marker");
  });

  it("any spelling Postgres reads as a uuid passes: upper case, braces, no hyphens, blanks around it", () => {
    for (const spelled of [
      ASSESSMENT.toUpperCase(),
      `{${ASSESSMENT}}`,
      ASSESSMENT.replace(/-/g, ""),
      `  ${ASSESSMENT}  `,
    ])
      expect(() => assertResultRowsAreClean([{ assessmentId: spelled }])).not.toThrow();
  });
});

describe("a non-uuid assessmentId is screened for a date or a phone number too", () => {
  it.each(["555-867-5309", "1-555-867-5309", "1990-05-17", "05-17-1990", "{1990-05-17}"])(
    "refuses %s (the id charset holds hex digits and hyphens: a date or a phone number fits it)",
    (assessmentId) => {
      const failure = failureOf(() => assertResultRowsAreClean([{ assessmentId }]));

      expect(failure).toMatchObject({ code: "EVIDENCE_LOOKS_LIKE_PHI", statusCode: 422 });
      expect(failure?.details).toEqual([
        expect.objectContaining({ field: "results.0.assessmentId" }),
      ]);
      expect(JSON.stringify(failure)).not.toContain("1990");
    },
  );

  it("compact digit forms and a uuid pass (a documented residual, and an id)", () => {
    for (const ok of ["5558675309", "19900517", ASSESSMENT])
      expect(() => assertResultRowsAreClean([{ assessmentId: ok }]), ok).not.toThrow();
  });
});

describe("the service stores only what it rebuilt", () => {
  it.each([
    ["null", [null]],
    ["a string", ["x"]],
    ["an array", [[]]],
    ["a number", [3]],
  ])("a row that is %s is a static 422, never a TypeError", (_label, rows) => {
    expect(failureOf(() => cleanResultRows(rows))).toMatchObject({ statusCode: 422 });
  });

  it("results that is no array is a static 422", () => {
    expect(failureOf(() => cleanResultRows({ length: 1 }))).toMatchObject({ statusCode: 422 });
    expect(failureOf(() => cleanResultRows(undefined))).toMatchObject({ statusCode: 422 });
  });

  it.each([
    ["a number", { severity: 3 }],
    ["a boolean", { status: true }],
    ["null", { code: null }],
    ["an object", { message: { a: 1 } }],
  ])("a value that is %s is refused (the schema's types)", (_label, fields) => {
    const failure = failureOf(() => cleanResultRows([row(fields)]));

    expect(failure).toMatchObject({ code: "VALIDATION_FAILED", statusCode: 422 });
    expect(failure?.details).toEqual([
      expect.objectContaining({ field: `results.0.${Object.keys(fields)[0]}` }),
    ]);
  });

  it("an unknown key is refused without naming it, and the rebuilt row holds the schema's keys only", () => {
    const failure = failureOf(() => cleanResultRows([row({ zzextra: "x" })]));

    expect(failure).toMatchObject({ code: "VALIDATION_FAILED", statusCode: 422 });
    expect(JSON.stringify(failure)).not.toContain("zzextra");
    const input = { assessmentId: ` ${ASSESSMENT} `, status: "accepted", code: "-3015" };
    const [clean] = cleanResultRows([input]);
    expect(clean).toEqual({ assessmentId: ASSESSMENT, status: "accepted", code: "-3015" });
    expect(clean).not.toBe(input);
    expect(input.assessmentId).toBe(` ${ASSESSMENT} `); // the caller's object is not touched
  });
});

describe("the in-memory twin refuses what the database backend refuses", () => {
  const twin = () =>
    createInMemoryHopeBackend({
      submissions: [
        {
          id: SUB,
          organizationId: ORG,
          providerEntityId: "pe-1",
          status: "packaged",
          items: [],
        },
      ],
    } as never);

  it("markSubmissionUploaded: an identifier-shaped or malformed reference is a 422, nothing changes", async () => {
    const svc = twin();

    for (const [ref, code] of [
      [SSN, "EVIDENCE_LOOKS_LIKE_PHI"],
      [" UP-1", "VALIDATION_FAILED"],
    ] as const)
      expect(
        await refusal(() =>
          svc.markSubmissionUploaded(ORG, MEMBERSHIP, SUB, { iqiesSubmissionReference: ref }),
        ),
      ).toMatchObject({ code, statusCode: 422 });
  });

  it("importSubmissionResult: a report reference, a non-string value and an unknown key are 422s", async () => {
    const svc = twin();

    for (const args of [
      { reportReference: SSN, results: [{ assessmentId: ASSESSMENT }] },
      { results: [{ assessmentId: ASSESSMENT, severity: 3 as never }] },
      { results: [{ assessmentId: ASSESSMENT, extra: "x" }] },
      { results: [{ assessmentId: ASSESSMENT, code: SSN }] },
    ])
      expect(
        await refusal(() => svc.importSubmissionResult(ORG, MEMBERSHIP, SUB, args)),
      ).toMatchObject({
        statusCode: 422,
      });
  });
});

describe("the read API returns an assessment id only when it is one", () => {
  const readWith = async (rawAssessmentId: unknown) => {
    const fake = scriptedDb([
      [
        {
          id: "r1",
          hopeSubmissionItemId: null,
          rawResult: { assessmentId: rawAssessmentId },
          cmsEditCode: "-3015",
          itemCode: null,
          message: "m",
          resultStatus: "rejected",
          cmsSeverity: null,
        },
      ],
      [],
    ]);
    return (await loadSubmissionFindings(fake.tx, ORG, SUB))[0]?.assessmentId;
  };

  it("an unmatched row's uuid is returned canonical; a name, a word or a non-string is not returned", async () => {
    expect(await readWith(` {${ASSESSMENT.toUpperCase()}} `)).toBe(ASSESSMENT);
    expect(await readWith("Jane Q Public")).toBeNull();
    expect(await readWith("abc123")).toBeNull();
    expect(await readWith(7)).toBeNull();
    expect(await readWith(undefined)).toBeNull();
  });
});
