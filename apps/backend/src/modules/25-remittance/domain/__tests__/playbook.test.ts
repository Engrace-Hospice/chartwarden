// M25 milestone 9a-1 - the denial-reason playbook library. Pure: validation of a version, the review-before-publish rule
// and code-keyed resolution. Nothing here states a CMS/MAC rule; every text is organization-authored data.
import { describe, expect, it } from "vitest";
import type { DenialRouteInput } from "../denial-route";
import {
  PLAYBOOK_MAX_STEPS,
  type PlaybookResolveEntry,
  checkPublish,
  checkRetire,
  normalizePlaybookCode,
  resolvePlaybook,
  validatePlaybookVersion,
} from "../playbook";

const valid = {
  summary: "Pull the certification and the physician narrative before deciding the path.",
  sourceNote: "Written by the billing lead from the 2026 MAC webinar slides",
  steps: [
    { key: "pull-cert", text: "Pull the signed certification" },
    { key: "narrative", text: "Pull the physician narrative" },
  ],
};

describe("validatePlaybookVersion", () => {
  it("accepts a version with a source note, a summary and unique steps", () => {
    expect(validatePlaybookVersion(valid)).toEqual({ ok: true });
  });

  it("refuses a blank source note: guidance without a source is never saved", () => {
    const r = validatePlaybookVersion({ ...valid, sourceNote: "   " });
    expect(r).toEqual({ ok: false, reasons: ["SOURCE_NOTE_REQUIRED"] });
  });

  it("refuses a blank summary and an empty step list", () => {
    const r = validatePlaybookVersion({ ...valid, summary: " ", steps: [] });
    expect(r).toEqual({ ok: false, reasons: ["SUMMARY_REQUIRED", "STEPS_REQUIRED"] });
  });

  it("refuses more than the product step limit", () => {
    const steps = Array.from({ length: PLAYBOOK_MAX_STEPS + 1 }, (_, i) => ({
      key: `s${i}`,
      text: "x",
    }));
    expect(validatePlaybookVersion({ ...valid, steps })).toEqual({
      ok: false,
      reasons: ["TOO_MANY_STEPS"],
    });
  });

  it("refuses duplicate, malformed and blank steps", () => {
    const r = validatePlaybookVersion({
      ...valid,
      steps: [
        { key: "a", text: "one" },
        { key: "a", text: "two" },
        { key: "Bad Key", text: "three" },
        { key: "c", text: "  " },
      ],
    });
    expect(r).toEqual({
      ok: false,
      reasons: ["STEP_KEY_DUPLICATE", "STEP_KEY_INVALID", "STEP_TEXT_REQUIRED"],
    });
  });

  it("refuses over-long text", () => {
    const r = validatePlaybookVersion({
      summary: "s".repeat(1001),
      sourceNote: "n".repeat(501),
      steps: [{ key: "a", text: "t".repeat(501) }],
    });
    expect(r).toEqual({
      ok: false,
      reasons: ["SUMMARY_TOO_LONG", "SOURCE_NOTE_TOO_LONG", "STEP_TEXT_TOO_LONG"],
    });
  });
});

describe("checkPublish", () => {
  const people = {
    authorMembershipId: "m1",
    authorUserId: "u1",
    lastEditorMembershipId: "m1",
    lastEditorUserId: "u1",
    publisherMembershipId: "m2",
    publisherUserId: "u2",
  };
  it("refuses the author publishing their own draft", () => {
    expect(checkPublish({ ...people, status: "draft", publisherMembershipId: "m1" })).toBe(
      "REVIEWER_IS_AUTHOR",
    );
  });
  it("refuses the same human under a new membership id (revoke and re-invite)", () => {
    expect(
      checkPublish({
        ...people,
        status: "draft",
        publisherMembershipId: "m9",
        publisherUserId: "u1",
      }),
    ).toBe("REVIEWER_IS_AUTHOR");
  });
  it("refuses anything that is not a draft", () => {
    expect(checkPublish({ ...people, status: "published" })).toBe("NOT_A_DRAFT");
    expect(checkPublish({ ...people, status: "retired" })).toBe("NOT_A_DRAFT");
  });
  it("refuses the last editor too: a second person cannot rewrite a draft and then approve it", () => {
    const edited = {
      ...people,
      status: "draft",
      lastEditorMembershipId: "m2",
      lastEditorUserId: "u2",
    } as const;
    expect(checkPublish(edited)).toBe("REVIEWER_IS_AUTHOR");
    expect(
      checkPublish({ ...edited, publisherMembershipId: "m3", publisherUserId: "u3" }),
    ).toBeNull();
  });
  it("allows a different person to publish a draft", () => {
    expect(checkPublish({ ...people, status: "draft" })).toBeNull();
  });
});

describe("checkRetire", () => {
  it("only a published version can be retired", () => {
    expect(checkRetire("published")).toBeNull();
    expect(checkRetire("draft")).toBe("NOT_PUBLISHED");
    expect(checkRetire("retired")).toBe("NOT_PUBLISHED");
  });
});

describe("normalizePlaybookCode", () => {
  it("upper-cases and trims; rejects anything not 1-16 letters or digits", () => {
    expect(normalizePlaybookCode(" 5b ")).toBe("5B");
    expect(normalizePlaybookCode("")).toBeNull();
    expect(normalizePlaybookCode("a-b")).toBeNull();
    expect(normalizePlaybookCode("x".repeat(17))).toBeNull();
  });
});

const entry = (over: Partial<PlaybookResolveEntry>): PlaybookResolveEntry => ({
  id: "v1",
  macName: null,
  codeKind: "carc",
  code: "50",
  effectiveFrom: "2026-01-01",
  ...over,
});
const denial = (over: Partial<DenialRouteInput> = {}): DenialRouteInput => ({
  macName: "CGS",
  macReasonCode: null,
  carcCode: "50",
  rarcCode: null,
  asOf: "2026-06-01",
  ...over,
});

describe("resolvePlaybook", () => {
  it("returns null when the organization has written none: absence is never defaulted", () => {
    expect(resolvePlaybook(denial(), [])).toBeNull();
    expect(resolvePlaybook(denial({ macReasonCode: "56900" }), [entry({})])?.id).toBe("v1");
    expect(resolvePlaybook(denial({ carcCode: "99" }), [entry({})])).toBeNull();
  });

  it("uses the denial-route precedence: MAC reason code beats RARC beats CARC", () => {
    const winner = resolvePlaybook(denial({ macReasonCode: "56900", rarcCode: "N1" }), [
      entry({ id: "carc", codeKind: "carc", code: "50" }),
      entry({ id: "rarc", codeKind: "rarc", code: "N1" }),
      entry({ id: "mac", codeKind: "mac_reason", code: "56900" }),
    ]);
    expect(winner?.id).toBe("mac");
  });

  it("prefers a MAC-specific playbook over an any-MAC one, and ignores another MAC's", () => {
    const entries = [
      entry({ id: "any" }),
      entry({ id: "cgs", macName: "cgs" }),
      entry({ id: "other", macName: "Novitas" }),
    ];
    expect(resolvePlaybook(denial(), entries)?.id).toBe("cgs");
    expect(resolvePlaybook(denial({ macName: null }), entries)?.id).toBe("any");
  });

  it("does not match a version that is not yet in effect", () => {
    expect(resolvePlaybook(denial(), [entry({ effectiveFrom: "2026-07-01" })])).toBeNull();
  });
});
