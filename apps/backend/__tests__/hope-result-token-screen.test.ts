import { describe, expect, it } from "vitest";
import { createDbHopeBackend } from "../src/modules/10-hope/index";
import {
  RESULT_ROW_TOKEN_KEYS,
  assertResultRowsHaveNoPatientIdentifier,
} from "../src/modules/10-hope/routes/hope-reference-screen";
import { scriptedDb } from "./_hope-g3-fake-db";

// The operator-typed references and the tokens of a CMS result row are screened for a patient identifier by the route AND by the
// service: a second caller of the service cannot store one. Synthetic identifiers only (area 900 SSN; the listed synthetic MBI).
const ORG = "11111111-1111-4111-8111-111111111111";
const MEMBERSHIP = "22222222-2222-4222-8222-222222222222";
const SUB = "66666666-6666-4666-8666-666666666666";
const ASSESSMENT = "77777777-7777-4777-8777-777777777777";
const SSN = "900-12-3456";
const MBI = "1EG4TE5MK73";

const backend = () => {
  const fake = scriptedDb([]);
  return { ...fake, svc: createDbHopeBackend(fake.db, { publish: async () => undefined }) };
};
const refusal = async (run: () => Promise<unknown>) => run().catch((e: unknown) => e);

describe("assertResultRowsHaveNoPatientIdentifier", () => {
  it("names the row and the token, never the value", () => {
    const rows = [{ assessmentId: ASSESSMENT, status: "accepted" }, { code: SSN }];

    const failure = (() => {
      try {
        assertResultRowsHaveNoPatientIdentifier(rows);
      } catch (error) {
        return error as { code: string; statusCode: number; details: unknown[]; message: string };
      }
      return undefined;
    })();

    expect(failure).toMatchObject({ code: "EVIDENCE_LOOKS_LIKE_PHI", statusCode: 422 });
    expect(failure?.details).toEqual([expect.objectContaining({ field: "results.1.code" })]);
    expect(JSON.stringify({ message: failure?.message, details: failure?.details })).not.toContain(
      SSN,
    );
  });

  it("looks at every token key, and leaves assessmentId and message alone", () => {
    for (const key of RESULT_ROW_TOKEN_KEYS) {
      expect(() => assertResultRowsHaveNoPatientIdentifier([{ [key]: MBI }])).toThrow();
    }
    expect(() =>
      assertResultRowsHaveNoPatientIdentifier([
        { assessmentId: SSN, message: `edit failed for ${SSN}` },
      ]),
    ).not.toThrow();
  });

  it("passes an empty, absent or non-string token and an ordinary report row", () => {
    expect(() =>
      assertResultRowsHaveNoPatientIdentifier([
        { status: "", code: undefined, severity: 3 },
        {
          status: "Accepted with warnings",
          severity: "ERROR",
          code: "-3010",
          iqiesRecordId: "R-1",
        },
      ]),
    ).not.toThrow();
  });
});

describe("the service screens what the route screened", () => {
  it("importSubmissionResult refuses an identifier-shaped reportReference before any statement", async () => {
    const { svc, statements } = backend();

    const failure = await refusal(() =>
      svc.importSubmissionResult(ORG, MEMBERSHIP, SUB, {
        reportReference: SSN,
        results: [{ assessmentId: ASSESSMENT, status: "accepted" }],
      }),
    );

    expect(failure).toMatchObject({ code: "EVIDENCE_LOOKS_LIKE_PHI", statusCode: 422 });
    expect(statements).toEqual([]);
  });

  it.each([
    ["code", { code: SSN }],
    ["iqiesRecordId", { iqiesRecordId: MBI }],
  ])(
    "importSubmissionResult refuses an identifier-shaped %s before any statement",
    async (_k, token) => {
      const { svc, statements } = backend();

      const failure = await refusal(() =>
        svc.importSubmissionResult(ORG, MEMBERSHIP, SUB, {
          results: [{ assessmentId: ASSESSMENT, status: "accepted", ...token }],
        }),
      );

      expect(failure).toMatchObject({ code: "EVIDENCE_LOOKS_LIKE_PHI", statusCode: 422 });
      expect(statements).toEqual([]);
    },
  );

  it("markSubmissionUploaded refuses an identifier-shaped iqiesSubmissionReference before any statement", async () => {
    const { svc, statements } = backend();

    const failure = await refusal(() =>
      svc.markSubmissionUploaded(ORG, MEMBERSHIP, SUB, { iqiesSubmissionReference: SSN }),
    );

    expect(failure).toMatchObject({ code: "EVIDENCE_LOOKS_LIKE_PHI", statusCode: 422 });
    expect(statements).toEqual([]);
  });
});
