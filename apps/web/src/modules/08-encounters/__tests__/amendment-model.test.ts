// The words and rules of amending a signed note through an addendum (ADR-0114 VN-D30): what each refusal says and what to do next, which
// drafted sections hold the Sign button back, and what each named section will do when the addendum signs.
import { describe, expect, it } from "vitest";
import {
  MAX_AMENDED_SECTIONS,
  addendumRefusalMessage,
  amendCreateRefusal,
  amendedSectionNote,
  amendedSectionOutcome,
  isSectionRefusal,
  signBlockReason,
  signedAmendmentMessage,
} from "../amendment-model";
import type { DraftSectionView } from "../draft-api";
import type { DraftLoad } from "../use-note-draft";

const section = (sectionId: string, state: DraftSectionView["state"]): DraftSectionView => ({
  sectionId,
  state,
  text: state === "not_drafted" ? null : "Drafted.",
  contentHash: state === "not_drafted" ? null : "h",
  corpusVersion: state === "not_drafted" ? null : "v",
  part2Derived: state === "not_drafted" ? null : false,
  origins: state === "not_drafted" ? [] : ["vitals"],
});
const ready = (...sections: DraftSectionView[]): DraftLoad => ({
  status: "ready",
  draft: {
    addendumId: "add-1",
    encounterId: "enc-1",
    patientId: "p-1",
    templateKey: "k",
    asOf: "2026-10-01T00:00:00Z",
    sections,
  } as never,
});

describe("the limit", () => {
  it("is the API's twelve sections", () => {
    expect(MAX_AMENDED_SECTIONS).toBe(12);
  });
});

describe("amendCreateRefusal", () => {
  it("says amending is unavailable for a 404, and offers the free addendum", () => {
    const text = amendCreateRefusal(404, "NOT_FOUND");
    expect(text).toMatch(/switched off/);
    expect(text).toMatch(/free addendum/);
  });

  it("names the section problem for 422 UNKNOWN_TEMPLATE_SECTION and says what to do", () => {
    expect(amendCreateRefusal(422, "UNKNOWN_TEMPLATE_SECTION")).toMatch(
      /not part of the signed note.*Reload/,
    );
  });

  it("explains a refusal of a Part 2 section the viewer cannot read", () => {
    expect(amendCreateRefusal(422, "AMENDMENT_PART2_NOT_ENTITLED")).toMatch(/42 CFR Part 2/);
  });

  it("leaves any other refusal to the server's own words", () => {
    expect(amendCreateRefusal(500, "INTERNAL")).toBeNull();
    expect(amendCreateRefusal(422, "VALIDATION_ERROR")).toBeNull();
  });
});

describe("addendumRefusalMessage", () => {
  const refusal = (code: string | null, details?: unknown, message = "server said so") => ({
    status: 409,
    code,
    message,
    details,
  });

  it("names the sections a stale sign refusal lists, in words, and says where to resolve them", () => {
    const text = addendumRefusalMessage(
      refusal("DRAFT_SECTION_STALE", [
        { field: "pain", code: "DRAFT_SECTION_UNRESOLVED", message: "m" },
        { field: "vitals_review", code: "DRAFT_SECTION_STALE", message: "m" },
      ]),
    );
    expect(text).toContain("Pain (not confirmed or deselected yet)");
    expect(text).toContain("Vitals review (changed since you resolved it)");
    expect(text).toMatch(/amended sections/);
    expect(text).toMatch(/sign again/);
  });

  it("words DRAFT_SECTION_UNRESOLVED as a top-level code the same way", () => {
    const text = addendumRefusalMessage(
      refusal("DRAFT_SECTION_UNRESOLVED", [
        { field: "pain", code: "DRAFT_SECTION_UNRESOLVED", message: "m" },
      ]),
    );
    expect(text).toContain("Pain (not confirmed or deselected yet)");
    expect(isSectionRefusal("DRAFT_SECTION_UNRESOLVED")).toBe(true);
    expect(isSectionRefusal("DRAFT_SECTION_STALE")).toBe(true);
    expect(isSectionRefusal("NO_ELIGIBLE_COSIGNER")).toBe(false);
  });

  it("still gives a next step when the refusal names no section", () => {
    expect(addendumRefusalMessage(refusal("DRAFT_SECTION_STALE"))).toMatch(/sign again/);
  });

  it("says nothing changed and who can switch the draft back on when it was switched off", () => {
    const text = addendumRefusalMessage(refusal("DRAFT_OFF_AFTER_FINALIZE"));
    expect(text).toMatch(/Nothing was changed/);
    expect(text).toMatch(/Visit-note Draft/);
  });

  it("says a source could not be read and to try again, changing nothing", () => {
    expect(
      addendumRefusalMessage({ ...refusal("COMPLIANCE_GATE_UNAVAILABLE"), status: 503 }),
    ).toMatch(/Try again in a moment/);
  });

  it("says no cosigner is available, and what to ask for", () => {
    const text = addendumRefusalMessage({ ...refusal("NO_ELIGIBLE_COSIGNER"), status: 422 });
    expect(text).toMatch(/cosign/i);
    expect(text).toMatch(/Nothing was changed/);
  });

  it("explains an amendment of text the signer's access does not include", () => {
    expect(
      addendumRefusalMessage({ ...refusal("AMENDMENT_PART2_NOT_ENTITLED"), status: 422 }),
    ).toMatch(/42 CFR Part 2/);
  });

  it("shows any other refusal as the server worded it", () => {
    expect(addendumRefusalMessage(refusal("STEP_UP_REQUIRED"))).toBe("server said so");
  });
});

describe("signBlockReason", () => {
  it("waits while the amended sections are being read", () => {
    expect(signBlockReason({ status: "loading" })).toMatch(/Checking/);
  });

  it("waits, with a retry, when they could not be read", () => {
    expect(signBlockReason({ status: "unavailable" })).toMatch(/can be read/);
  });

  it("leaves the server to judge when the draft is off for this viewer", () => {
    expect(signBlockReason({ status: "off" })).toBeNull();
  });

  it("names every unresolved or changed section and why", () => {
    const reason = signBlockReason(
      ready(
        section("pain", "unresolved"),
        section("plan", "needs_reconfirmation"),
        section("x", "confirmed"),
      ),
    );
    expect(reason).toContain("Pain (not confirmed or deselected yet)");
    expect(reason).toContain("Plan (changed since you resolved it)");
    expect(reason).not.toContain("X (");
  });

  it("does not wait once every named section is confirmed, deselected or has nothing drafted", () => {
    expect(
      signBlockReason(
        ready(section("a", "confirmed"), section("b", "deselected"), section("c", "not_drafted")),
      ),
    ).toBeNull();
  });
});

describe("amendedSectionOutcome", () => {
  it("says what each state does when the addendum signs", () => {
    expect(amendedSectionOutcome("confirmed")).toMatch(/will be amended/);
    expect(amendedSectionOutcome("deselected")).toMatch(/amends nothing/);
    expect(amendedSectionOutcome("not_drafted")).toMatch(/amends nothing/);
    expect(amendedSectionOutcome("unresolved")).toBeNull();
    expect(amendedSectionOutcome("needs_reconfirmation")).toBeNull();
  });
});

describe("amendedSectionNote", () => {
  it("is the section's status line once it is resolved, in the tone of what it does", () => {
    expect(amendedSectionNote("confirmed")).toMatchObject({ tone: "success" });
    expect(amendedSectionNote("deselected")).toMatchObject({ tone: "info" });
  });

  it("is nothing while unresolved, or when nothing was drafted (the section says that itself)", () => {
    expect(amendedSectionNote("unresolved")).toBeNull();
    expect(amendedSectionNote("needs_reconfirmation")).toBeNull();
    expect(amendedSectionNote("not_drafted")).toBeNull();
  });
});

describe("signedAmendmentMessage", () => {
  it("counts the amended sections and says a cosignature was requested", () => {
    expect(signedAmendmentMessage({ amendedSectionIds: ["a"], cosignatureRequestId: "r" })).toBe(
      "Addendum signed. 1 section amended. A cosignature was requested for this amendment.",
    );
    expect(
      signedAmendmentMessage({ amendedSectionIds: ["a", "b"], cosignatureRequestId: null }),
    ).toBe("Addendum signed. 2 sections amended.");
  });

  it("says when every named section was left as signed", () => {
    expect(signedAmendmentMessage({ amendedSectionIds: [] })).toBe(
      "Addendum signed. No section was amended.",
    );
  });

  it("says nothing extra for a free addendum", () => {
    expect(signedAmendmentMessage({})).toBeNull();
  });
});
