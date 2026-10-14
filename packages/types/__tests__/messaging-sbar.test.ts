// M36 WP 3.3 - the closed `sbar` block node: structural sanitiser, projection, link walk, and the shared validator.
import { describe, expect, it } from "vitest";
import {
  canonicalRichBodyJson,
  parseStoredRichBody,
  richBodyClinicalLinks,
  richBodyMentions,
  richBodyToPlainText,
  sanitizeRichBody,
  storedBodyToPlainText,
} from "../src/messaging-rich-body";
import type { RichBody } from "../src/messaging-rich-body";
import {
  type EffectiveSbarPolicy,
  SBAR_MAX_SECTION_CHARS,
  SBAR_PLATFORM_FLOOR,
  SBAR_SECTION_KEYS,
  SBAR_SECTION_LABELS,
  SBAR_URGENCY_HINTS,
  richBodySbar,
  validateSbar,
} from "../src/messaging-sbar";

const ID = "11111111-1111-4111-8111-111111111111";
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (value: string) => ({ type: "text", text: value });
const section = (value: string) => [para(text(value))];
const sbar = (overrides: Record<string, unknown> = {}) => ({
  type: "sbar",
  urgencyHint: "routine",
  situation: section("Pain uncontrolled"),
  background: section("Day 3 of morphine"),
  assessment: section("Likely breakthrough"),
  recommendation: section("Increase PRN dose"),
  ...overrides,
});
const doc = (...content: unknown[]) => ({ schemaVersion: 1, doc: { type: "doc", content } });

function ok(input: unknown): RichBody {
  const result = sanitizeRichBody(input);
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
  return result.value;
}
const rejected = (input: unknown): string => {
  const result = sanitizeRichBody(input);
  if (result.ok) throw new Error("expected a rejection");
  return result.reason;
};

describe("platform constants", () => {
  it("are closed, labelled and floored at one character", () => {
    expect(SBAR_SECTION_KEYS).toEqual(["situation", "background", "assessment", "recommendation"]);
    expect(SBAR_SECTION_LABELS).toEqual({
      situation: "Situation",
      background: "Background",
      assessment: "Assessment",
      recommendation: "Recommendation",
    });
    expect(SBAR_URGENCY_HINTS).toEqual(["routine", "important", "urgent"]);
    expect(SBAR_MAX_SECTION_CHARS).toBe(2000);
    for (const key of SBAR_SECTION_KEYS) expect(SBAR_PLATFORM_FLOOR.minChars[key]).toBe(1);
    expect(SBAR_PLATFORM_FLOOR.requirePatientChannel).toBe(false);
  });
});

describe("sanitizeRichBody: sbar node", () => {
  it("accepts a complete sbar block as the only block and rebuilds it", () => {
    const body = ok(doc(sbar({ urgencyHint: "urgent" })));
    expect(body.doc.content).toHaveLength(1);
    expect(body.doc.content[0]?.type).toBe("sbar");
  });

  it("is idempotent", () => {
    const once = ok(doc(sbar()));
    expect(ok(JSON.parse(canonicalRichBodyJson(once)))).toEqual(once);
  });

  it("rejects a missing section", () => {
    const { recommendation: _drop, ...rest } = sbar();
    expect(rejected(doc(rest))).toMatch(/recommendation/);
  });

  it.each(SBAR_SECTION_KEYS)("rejects an empty or invisible %s section", (key) => {
    expect(rejected(doc(sbar({ [key]: [] })))).toMatch(new RegExp(key));
    expect(rejected(doc(sbar({ [key]: section("  　") })))).toMatch(new RegExp(key));
  });

  it("rejects extra keys, a bad urgency hint and a missing urgency hint", () => {
    expect(rejected(doc(sbar({ extra: 1 })))).toMatch(/unknown field/);
    expect(rejected(doc(sbar({ urgencyHint: "critical" })))).toMatch(/urgencyHint/);
    const { urgencyHint: _drop, ...rest } = sbar();
    expect(rejected(doc(rest))).toMatch(/urgencyHint/);
  });

  it("rejects an sbar block beside another block, and two sbar blocks", () => {
    expect(rejected(doc(sbar(), para(text("more"))))).toMatch(/only/);
    expect(rejected(doc(para(text("first")), sbar()))).toMatch(/only/);
    expect(rejected(doc(sbar(), sbar()))).toMatch(/only/);
  });

  it("rejects a nested sbar and non-paragraph/list section children", () => {
    expect(rejected(doc(sbar({ situation: [sbar()] })))).toMatch(/only paragraph or list/);
    expect(rejected(doc(sbar({ situation: [{ type: "codeBlock", text: "x" }] })))).toMatch(
      /only paragraph or list/,
    );
    expect(
      rejected(
        doc({
          type: "bulletList",
          content: [{ type: "listItem", content: [sbar()] }],
        }),
      ),
    ).toBeTruthy();
  });

  it("allows lists, mentions and clinical links inside sections", () => {
    const list = {
      type: "bulletList",
      content: [{ type: "listItem", content: [para(text("item"))] }],
    };
    const body = ok(
      doc(
        sbar({
          situation: [list],
          background: [
            para(text("see "), { type: "clinicalLink", kind: "visit", entityId: ID.toUpperCase() }),
          ],
        }),
      ),
    );
    expect(richBodyClinicalLinks(body)).toEqual([{ kind: "visit", entityId: ID }]);
  });

  it("does not apply any length rule (old bodies must stay readable)", () => {
    expect(ok(doc(sbar({ situation: section("x") }))).doc.content).toHaveLength(1);
  });
});

describe("sbar projection", () => {
  it("projects fixed labels and never the urgency hint", () => {
    const body = ok(doc(sbar({ urgencyHint: "urgent" })));
    expect(richBodyToPlainText(body)).toBe(
      "SBAR\nSituation: Pain uncontrolled\nBackground: Day 3 of morphine\nAssessment: Likely breakthrough\nRecommendation: Increase PRN dose",
    );
    expect(richBodyToPlainText(body)).not.toMatch(/urgent/i);
  });

  it("stored projection matches and mention offsets point into it", () => {
    const body = ok(
      doc(
        sbar({
          background: [
            para(text("ask "), { type: "mention", kind: "staff", entityId: ID, label: "Ann" }),
          ],
        }),
      ),
    );
    const projected = richBodyToPlainText(body);
    const [mention] = richBodyMentions(body);
    expect(mention).toBeDefined();
    expect(projected.slice(mention?.start, mention?.end)).toBe("@Ann");
    expect(storedBodyToPlainText("rich", canonicalRichBodyJson(body))).toBe(projected);
    expect(parseStoredRichBody(canonicalRichBodyJson(body)).ok).toBe(true);
  });

  it("projects list sections on their own lines", () => {
    const list = {
      type: "orderedList",
      content: [
        { type: "listItem", content: [para(text("a"))] },
        { type: "listItem", content: [para(text("b"))] },
      ],
    };
    expect(richBodyToPlainText(ok(doc(sbar({ situation: [list] }))))).toContain(
      "Situation: \n1. a\n2. b\nBackground:",
    );
  });
});

describe("richBodySbar", () => {
  it("returns null for a non-sbar body", () => {
    expect(richBodySbar(ok(doc(para(text("hi")))))).toBeNull();
  });

  it("returns the urgency hint and per-section text", () => {
    const result = richBodySbar(ok(doc(sbar({ urgencyHint: "important" }))));
    expect(result).toEqual({
      urgencyHint: "important",
      sections: {
        situation: "Pain uncontrolled",
        background: "Day 3 of morphine",
        assessment: "Likely breakthrough",
        recommendation: "Increase PRN dose",
      },
    });
  });
});

describe("validateSbar", () => {
  const policy = (
    minChars: Partial<EffectiveSbarPolicy["minChars"]> = {},
  ): EffectiveSbarPolicy => ({
    minChars: { ...SBAR_PLATFORM_FLOOR.minChars, ...minChars },
    requirePatientChannel: false,
    hints: {},
  });
  const bodyWith = (situation: string) => ok(doc(sbar({ situation: section(situation) })));

  it("returns no issues for a body that is not SBAR", () => {
    expect(validateSbar(ok(doc(para(text("hi")))), policy())).toEqual([]);
  });

  it("passes at exactly the minimum and the maximum", () => {
    expect(validateSbar(bodyWith("x".repeat(40)), policy({ situation: 40 }))).toEqual([]);
    expect(validateSbar(bodyWith("x".repeat(SBAR_MAX_SECTION_CHARS)), policy())).toEqual([]);
  });

  it("reports TOO_SHORT one under the minimum, naming the field", () => {
    const issues = validateSbar(bodyWith("x".repeat(39)), policy({ situation: 40 }));
    expect(issues).toEqual([
      {
        field: "sbar.situation",
        code: "TOO_SHORT",
        message: "must be at least 40 characters",
      },
    ]);
  });

  it("reports TOO_LONG one over the maximum", () => {
    const issues = validateSbar(bodyWith("x".repeat(SBAR_MAX_SECTION_CHARS + 1)), policy());
    expect(issues).toEqual([
      {
        field: "sbar.situation",
        code: "TOO_LONG",
        message: `must be at most ${SBAR_MAX_SECTION_CHARS} characters`,
      },
    ]);
  });

  it("measures trimmed text and never echoes it", () => {
    const issues = validateSbar(bodyWith("  ab  "), policy({ situation: 3 }));
    expect(issues).toHaveLength(1);
    expect(JSON.stringify(issues)).not.toContain("ab");
  });

  it("reports REQUIRED when a section projects to nothing", () => {
    const fake = {
      schemaVersion: 1,
      doc: { type: "doc", content: [sbar({ situation: [para()] })] },
    } as unknown as RichBody;
    expect(validateSbar(fake, policy()).map((i) => [i.field, i.code])).toEqual([
      ["sbar.situation", "REQUIRED"],
    ]);
  });

  it("reports every failing section in key order", () => {
    const issues = validateSbar(ok(doc(sbar())), policy({ background: 100, recommendation: 100 }));
    expect(issues.map((i) => i.field)).toEqual(["sbar.background", "sbar.recommendation"]);
  });
});
