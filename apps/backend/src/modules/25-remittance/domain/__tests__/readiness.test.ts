// M25 milestone 8a-1 - the advisory ADR documentation-readiness rules. Pure. The properties that matter: the AI
// can never make a gap look present, can never cite a document outside the packet, and never touches the checklist.
import { describe, expect, it } from "vitest";
import { ADR_CHECKLIST_KEYS } from "../adr-packet-rules";
import {
  MAX_READINESS_NOTE_LENGTH,
  acceptAiFindings,
  deterministicGaps,
  isReviewDisposed,
  normalizeReadinessNote,
} from "../readiness";

const DOC_A = "11111111-1111-4111-8111-111111111111";
const DOC_B = "22222222-2222-4222-8222-222222222222";
const PACKET = [DOC_A, DOC_B];

const finding = (over: Record<string, unknown>) => ({
  checklistKey: "physician_orders",
  status: "cannot_tell",
  citedDocumentIds: [] as string[],
  note: "n",
  ...over,
});

describe("deterministicGaps", () => {
  it("flags every key when nothing is attached", () => {
    const out = deterministicGaps({}, []);
    expect(out.keys.map((k) => k.checklistKey)).toEqual([...ADR_CHECKLIST_KEYS]);
    expect(out.keys.every((k) => k.isGap && k.status === "no_document_attached")).toBe(true);
  });

  it("maps attached documents to their key and leaves the rest as gaps", () => {
    const out = deterministicGaps({}, [
      { documentId: DOC_A, checklistKey: "plan_of_care" },
      { documentId: DOC_B, checklistKey: null },
    ]);
    const poc = out.keys.find((k) => k.checklistKey === "plan_of_care");
    expect(poc).toMatchObject({ status: "documents_attached", isGap: false, documentIds: [DOC_A] });
    expect(out.keys.filter((k) => k.isGap)).toHaveLength(ADR_CHECKLIST_KEYS.length - 1);
    expect(out.unmappedDocumentIds).toEqual([DOC_B]);
  });

  it("does not flag a key a person marked not applicable", () => {
    const out = deterministicGaps({ visit_notes: "not_applicable" }, []);
    expect(out.keys.find((k) => k.checklistKey === "visit_notes")).toMatchObject({
      status: "marked_not_applicable",
      isGap: false,
    });
  });

  it("still flags a key ticked 'ready' that has no document", () => {
    const out = deterministicGaps({ election_statement: "ready" }, []);
    expect(out.keys.find((k) => k.checklistKey === "election_statement")?.isGap).toBe(true);
  });
});

describe("acceptAiFindings", () => {
  const gaps = deterministicGaps({ visit_notes: "not_applicable" }, [
    { documentId: DOC_A, checklistKey: "plan_of_care" },
  ]);
  const accept = (c: unknown) => acceptAiFindings(c, gaps, PACKET);

  it("keeps a cited presence claim on a key that has a document", () => {
    const out = accept([
      finding({ checklistKey: "plan_of_care", status: "looks_present", citedDocumentIds: [DOC_A] }),
    ]);
    expect(out.accepted).toHaveLength(1);
    expect(out.dropped).toEqual([]);
  });

  it("never lets the AI turn a deterministic gap into 'present'", () => {
    const out = accept([
      finding({
        checklistKey: "election_statement",
        status: "looks_present",
        citedDocumentIds: [DOC_A],
      }),
    ]);
    expect(out.accepted).toEqual([]);
    expect(out.dropped[0]?.reason).toBe("PRESENCE_ON_GAP");
  });

  it("allows a 'possibly missing' or 'cannot tell' note on a gap, with no citation", () => {
    const out = accept([
      finding({ checklistKey: "election_statement", status: "possibly_missing" }),
      finding({ checklistKey: "physician_orders", status: "cannot_tell" }),
    ]);
    expect(out.accepted.map((f) => f.status)).toEqual(["possibly_missing", "cannot_tell"]);
  });

  it("drops a finding that cites a document outside the packet", () => {
    const out = accept([
      finding({
        checklistKey: "plan_of_care",
        status: "looks_present",
        citedDocumentIds: ["33333333-3333-4333-8333-333333333333"],
      }),
    ]);
    expect(out.accepted).toEqual([]);
    expect(out.dropped[0]?.reason).toBe("CITATION_NOT_IN_PACKET");
  });

  it("drops a presence claim whose citations are in the packet but not attached to that checklist item", () => {
    const out = accept([
      finding({ checklistKey: "plan_of_care", status: "looks_present", citedDocumentIds: [DOC_B] }),
    ]);
    expect(out.accepted).toEqual([]);
    expect(out.dropped[0]?.reason).toBe("CITATION_NOT_ON_KEY");
    const mixed = accept([
      finding({
        checklistKey: "plan_of_care",
        status: "looks_present",
        citedDocumentIds: [DOC_B, DOC_A],
      }),
    ]);
    expect(mixed.accepted).toHaveLength(1);
  });

  it("stores a normalized note: no control or bidi-override characters, trimmed", () => {
    const out = accept([finding({ note: "  a\u202Eb\nc\u0000d\u200Be  " })]);
    expect(out.accepted[0]?.note).toBe("a b c d e");
  });

  it("drops an uncited presence claim", () => {
    const out = accept([finding({ checklistKey: "plan_of_care", status: "looks_present" })]);
    expect(out.dropped[0]?.reason).toBe("UNCITED_PRESENCE");
  });

  it("drops unknown keys (the list is never extended), unknown statuses and a key marked not applicable", () => {
    const out = accept([
      finding({ checklistKey: "made_up_item" }),
      finding({ checklistKey: "plan_of_care", status: "compliant", citedDocumentIds: [DOC_A] }),
      finding({ checklistKey: "visit_notes" }),
    ]);
    expect(out.accepted).toEqual([]);
    expect(out.dropped.map((d) => d.reason)).toEqual([
      "UNKNOWN_KEY",
      "UNKNOWN_STATUS",
      "KEY_NOT_APPLICABLE",
    ]);
  });

  it("keeps only the first finding per key", () => {
    const out = accept([finding({}), finding({ status: "possibly_missing" })]);
    expect(out.accepted).toHaveLength(1);
    expect(out.dropped[0]?.reason).toBe("DUPLICATE_KEY");
  });

  it("treats malformed output as nothing accepted", () => {
    expect(accept("nope").accepted).toEqual([]);
    expect(accept(null).dropped[0]?.reason).toBe("MALFORMED");
    expect(accept([{ checklistKey: 4 }, 7, null]).accepted).toEqual([]);
  });

  it("bounds the note length", () => {
    const out = accept([finding({ note: "x".repeat(MAX_READINESS_NOTE_LENGTH + 1) })]);
    expect(out.dropped[0]?.reason).toBe("NOTE_TOO_LONG");
  });
});

describe("normalizeReadinessNote", () => {
  it("leaves plain text alone and counts the length after normalizing", () => {
    expect(normalizeReadinessNote("Appears on page 2.")).toBe("Appears on page 2.");
    expect(normalizeReadinessNote("\u202E\u202E  ")).toBe("");
  });
});

describe("isReviewDisposed", () => {
  it("is true only when every finding has a disposition (an empty review counts)", () => {
    expect(isReviewDisposed([])).toBe(true);
    expect(isReviewDisposed([{ disposition: "dismissed" }, { disposition: null }])).toBe(false);
    expect(isReviewDisposed([{ disposition: "dismissed" }, { disposition: "disputed" }])).toBe(
      true,
    );
  });
});
