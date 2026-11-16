import { publishOutboxEvent } from "@chartwarden/shared";
import { describe, expect, it } from "vitest";
import { buildBootOutboxCatalog } from "../src/bootstrap/outbox-persister";
import { M10_OUTBOX_EVENTS } from "../src/modules/10-hope/events-by-m10";
import { settledBatchEvent } from "../src/modules/10-hope/hope-submission-result";
import { assertResultRowsAreClean } from "../src/modules/10-hope/routes/hope-reference-screen";
import {
  HOPE_RESULT_CODE_PATTERN,
  HOPE_RESULT_TOKEN_MAX_LENGTH,
} from "../src/modules/10-hope/routes/hope-typebox";

// `m10.hope.submission_rejected` carries the CMS edit code and item code of the rejected rows as `findings[].ruleId`. The tokens
// are operator-typed, so the question is whether a VALID token (one the route accepts) can break the real catalog validation, which
// would turn a recorded result into a 500 after the report was already stored. The catalog schema asks only for a non-empty
// string; this runs the widest valid token through the real catalog-validating dispatcher, the one the production publisher uses.
const ORG = "11111111-1111-4111-8111-111111111111";
const SUBMISSION = "66666666-6666-4666-8666-666666666666";
const CATALOG = buildBootOutboxCatalog([M10_OUTBOX_EVENTS]);

/** 64 characters that use every character class the code pattern allows: letters, digits, `. _ : # -`, a leading `-`. */
const WIDEST_CODE = `-${"aZ09._:#-".repeat(8)}`.slice(0, HOPE_RESULT_TOKEN_MAX_LENGTH);

async function publish(payload: unknown): Promise<unknown> {
  let persisted: unknown;
  await publishOutboxEvent(
    {
      eventName: "m10.hope.submission_rejected",
      payload,
      organizationId: ORG,
      aggregateKind: "hope_submission",
      aggregateId: SUBMISSION,
      callerModule: "m10",
      occurredAt: new Date(),
    },
    async (record) => {
      persisted = record.payload;
    },
    CATALOG,
  );
  return persisted;
}

describe("the widest valid CMS code in a submission_rejected finding", () => {
  it("is a valid token by the route's pattern and the service's check", () => {
    expect(WIDEST_CODE).toHaveLength(HOPE_RESULT_TOKEN_MAX_LENGTH);
    expect(new RegExp(HOPE_RESULT_CODE_PATTERN).test(WIDEST_CODE)).toBe(true);
    expect(() =>
      assertResultRowsAreClean([{ status: "rejected", code: WIDEST_CODE, itemCode: WIDEST_CODE }]),
    ).not.toThrow();
  });

  it("passes the real catalog validation as an edit code and as an item code, and is stored as typed", async () => {
    for (const token of [{ code: WIDEST_CODE }, { itemCode: WIDEST_CODE }]) {
      const { eventName, payload } = settledBatchEvent(
        SUBMISSION,
        "pe-1",
        { acceptedCount: 0, rejectedCount: 2 },
        [
          { assessmentId: "a", status: "rejected", ...token },
          { assessmentId: "b", status: "rejected", ...token },
        ],
      );

      const persisted = await publish(payload);

      expect(eventName).toBe("m10.hope.submission_rejected");
      expect(persisted).toMatchObject({ findings: [{ ruleId: WIDEST_CODE, count: 2 }] });
    }
  });

  it("the catalog constrains ruleId to a non-empty string only (no pattern, no length): nothing a valid token can violate", () => {
    const entry = CATALOG.get("m10.hope.submission_rejected");
    const finding = (
      entry?.payloadSchema as unknown as {
        properties: { findings: { items: { properties: { ruleId: Record<string, unknown> } } } };
      }
    ).properties.findings.items.properties.ruleId;

    expect(finding).toMatchObject({ type: "string", minLength: 1 });
    expect(finding).not.toHaveProperty("pattern");
    expect(finding).not.toHaveProperty("maxLength");
  });

  it("a row with no code or item code reports under cms.rejected, which the catalog also accepts", async () => {
    const { payload } = settledBatchEvent(
      SUBMISSION,
      "pe-1",
      { acceptedCount: 0, rejectedCount: 1 },
      [{ assessmentId: "a", status: "rejected" }],
    );

    expect(await publish(payload)).toMatchObject({ findings: [{ ruleId: "cms.rejected" }] });
  });
});
