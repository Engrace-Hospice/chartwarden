// WP 3.10 - the medication-question pure rules: the body keeps the text verbatim, and routing never sends a question back
// to its asker or to someone ineligible.
import { RICH_BODY_LIMITS, sanitizeRichBody } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { buildMedicationQuestionBody, resolveMedicationQuestionAssignee } from "../src";

const MED = "11111111-1111-4111-8111-111111111111";
const CALLER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("buildMedicationQuestionBody", () => {
  it("carries the text byte for byte, even when it reads like an order", () => {
    const text = "increase morphine to 10 mg q2h";
    const body = buildMedicationQuestionBody(text, null);
    expect(body.doc.content).toEqual([{ type: "paragraph", content: [{ type: "text", text }] }]);
  });

  it("adds exactly one medication link node when a medication is given", () => {
    const body = buildMedicationQuestionBody("Is this dose right?", MED);
    const para = body.doc.content[0];
    expect(para?.type === "paragraph" && para.content).toEqual([
      { type: "text", text: "Is this dose right?" },
      { type: "clinicalLink", kind: "medication", entityId: MED },
    ]);
  });

  it("produces a body the shared sanitiser accepts unchanged", () => {
    const body = buildMedicationQuestionBody("Why is the patient on this?", MED);
    const result = sanitizeRichBody(body);
    expect(result.ok && result.value).toEqual(body);
  });

  it.each(["", "   ", "\n\t"])("rejects blank text %j", (text) => {
    expect(() => buildMedicationQuestionBody(text, null)).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });

  it("rejects text over the send cap and stays under the rich body budget", () => {
    expect(() => buildMedicationQuestionBody("a".repeat(8001), null)).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
    expect(8000).toBeLessThanOrEqual(RICH_BODY_LIMITS.maxTextChars);
    expect(() => buildMedicationQuestionBody("a".repeat(8000), MED)).not.toThrow();
  });
});

describe("resolveMedicationQuestionAssignee", () => {
  const base = {
    chosen: null,
    primaryRn: RN,
    careTeam: [RN, OTHER],
    callerId: CALLER,
    isEligible: async () => true,
  };

  it("routes to the primary RN when nobody was chosen", async () => {
    expect(await resolveMedicationQuestionAssignee(base)).toEqual({
      kind: "primary_rn",
      userId: RN,
    });
  });

  it("routes to the chosen colleague when on the care team and eligible", async () => {
    expect(await resolveMedicationQuestionAssignee({ ...base, chosen: OTHER })).toEqual({
      kind: "chosen",
      userId: OTHER,
    });
  });

  it("is invalid when the chosen user is the caller", async () => {
    expect(
      await resolveMedicationQuestionAssignee({ ...base, chosen: CALLER, careTeam: [CALLER] }),
    ).toEqual({ kind: "invalid" });
  });

  it("is invalid when the chosen user is off the care team", async () => {
    expect(
      await resolveMedicationQuestionAssignee({ ...base, chosen: OTHER, careTeam: [RN] }),
    ).toEqual({ kind: "invalid" });
  });

  it("is invalid when the chosen user is ineligible, and never falls back to the primary RN", async () => {
    const out = await resolveMedicationQuestionAssignee({
      ...base,
      chosen: OTHER,
      isEligible: async (u) => u !== OTHER,
    });
    expect(out).toEqual({ kind: "invalid" });
  });

  it("is unrouted when the caller is the primary RN", async () => {
    expect(await resolveMedicationQuestionAssignee({ ...base, primaryRn: CALLER })).toEqual({
      kind: "unrouted",
    });
  });

  it("is unrouted when the primary RN is ineligible or absent", async () => {
    expect(
      await resolveMedicationQuestionAssignee({ ...base, isEligible: async () => false }),
    ).toEqual({ kind: "unrouted" });
    expect(await resolveMedicationQuestionAssignee({ ...base, primaryRn: null })).toEqual({
      kind: "unrouted",
    });
  });
});
