// The words and rules of amending a signed note through an addendum (ADR-0114 VN-D30): what each refusal says and what to do next, which
// drafted sections hold the Sign button back, and what each named section will do when the addendum signs.
import { NOTE_CLOSURE_SUPERVISOR_ROLE_KEYS } from "@chartwarden/auth";
import { describe, expect, it } from "vitest";
import {
  MAX_AMENDED_SECTIONS,
  SUPERVISOR_ROLE_KEYS,
  addendumContentHint,
  addendumRefusalMessage,
  amendCreateRefusal,
  amendedSectionNote,
  amendedSectionOutcome,
  isSectionRefusal,
  mayNameSections,
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

  it("says the viewer cannot choose sections on this note, with the next step", () => {
    const text = amendCreateRefusal(422, "AMENDMENT_PART2_NOT_ENTITLED");
    expect(text).toMatch(/cannot choose sections to amend on this note/);
    expect(text).toMatch(/without choosing sections/);
    expect(text).toMatch(/ask the note's author/);
  });

  it("says only the note's author or a supervisor can choose sections for a 403 FORBIDDEN, changing nothing, with the next step", () => {
    const text = amendCreateRefusal(403, "FORBIDDEN");
    expect(text).toMatch(/only the author of this note or a supervisor/i);
    expect(text).toMatch(/Nothing was changed/);
    expect(text).toMatch(/without choosing sections/);
  });

  it("leaves a 403 that is not that rule (step-up, a note-closure block) to the server's own words", () => {
    expect(amendCreateRefusal(403, "STEP_UP_REQUIRED")).toBeNull();
    expect(amendCreateRefusal(403, "NOTE_CLOSURE_REQUIRED")).toBeNull();
    expect(amendCreateRefusal(403, null)).toBeNull();
  });

  it("leaves any other refusal to the server's own words", () => {
    expect(amendCreateRefusal(500, "INTERNAL")).toBeNull();
    expect(amendCreateRefusal(422, "VALIDATION_ERROR")).toBeNull();
  });
});

describe("mayNameSections", () => {
  const author = "mem-author";
  it("is true for the note's author and for a supervisor", () => {
    expect(mayNameSections({ membershipId: author, roles: ["rn"] }, author)).toBe(true);
    expect(
      mayNameSections({ membershipId: "mem-2", roles: ["rn", "director_of_nursing"] }, author),
    ).toBe(true);
  });

  it("is false only when the session shows the viewer is neither", () => {
    expect(mayNameSections({ membershipId: "mem-2", roles: ["rn"] }, author)).toBe(false);
    expect(mayNameSections({ membershipId: "mem-2", roles: [] }, author)).toBe(false);
  });

  it("is true when the session cannot say who the viewer is: the server decides, and a refusal is worded", () => {
    expect(mayNameSections(null, author)).toBe(true);
    expect(mayNameSections({}, author)).toBe(true);
    expect(mayNameSections({ membershipId: "mem-2" }, author)).toBe(true);
    expect(mayNameSections({ roles: ["rn"] }, author)).toBe(true);
    expect(mayNameSections({ membershipId: "mem-2", roles: ["rn"] }, undefined)).toBe(true);
  });

  it("uses the supervisor role keys the platform grants by (one set, copied because the web may not import the backend's)", () => {
    expect([...SUPERVISOR_ROLE_KEYS].sort()).toEqual([...NOTE_CLOSURE_SUPERVISOR_ROLE_KEYS].sort());
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

  describe("a refused compliance gate (COMPLIANCE_GATE_FAILED)", () => {
    const GENERIC = "the Layer-3 compliance gate did not pass; the encounter stays in draft";
    const gate = (details?: unknown, step?: "finalize" | "sign", amends = false) => ({
      status: 422,
      code: "COMPLIANCE_GATE_FAILED",
      message: GENERIC,
      details,
      amends,
      ...(step ? { step } : {}),
    });
    const EMPTY = [{ code: "ADDENDUM_EMPTY", message: "an addendum must carry something" }];

    it("words an empty FREE addendum at finalize: only a finding or a note, which is all a free addendum can hold", () => {
      const text = addendumRefusalMessage(gate(EMPTY, "finalize", false));
      expect(text).toBe(
        "This addendum has nothing in it yet. Add a finding or a note, then finalize it.",
      );
      expect(text).not.toMatch(/section|confirm/i);
    });

    it("words an empty AMENDING addendum at finalize: a finding or a note, or a redrafted section if one is offered", () => {
      expect(addendumRefusalMessage(gate(EMPTY, "finalize", true))).toBe(
        "This addendum has nothing in it yet. Add a finding or a note, or confirm a redrafted section if one is offered, then finalize it.",
      );
    });

    it("words an empty amending addendum at sign without claiming anything was deselected, and with a way on", () => {
      const text = addendumRefusalMessage(gate(EMPTY, "sign", true));
      expect(text).toMatch(/nothing in it now/);
      expect(text).toMatch(/no section is left to amend/);
      expect(text).toMatch(/confirm a redrafted section if one is offered/i);
      expect(text).toMatch(/open a new addendum with a finding or a note\.$/);
      expect(text).not.toMatch(/deselect/i);
    });

    it("words an empty free addendum at sign without any word about sections", () => {
      const text = addendumRefusalMessage(gate(EMPTY, "sign", false));
      expect(text).toMatch(/cannot be signed/);
      expect(text).not.toMatch(/section|deselect|confirm/i);
    });

    it("treats a refusal that does not say whether the addendum amends as a free one", () => {
      expect(
        addendumRefusalMessage({
          status: 422,
          code: "COMPLIANCE_GATE_FAILED",
          message: GENERIC,
          details: EMPTY,
        }),
      ).toMatch(/Add a finding or a note, then finalize it\.$/);
    });

    it("never shows the top-level sentence, which names the encounter, nor the server's text for a code it words itself", () => {
      for (const step of ["finalize", "sign"] as const) {
        for (const amends of [false, true]) {
          const text = addendumRefusalMessage(gate(EMPTY, step, amends));
          expect(text).not.toMatch(/encounter/i);
          expect(text).not.toContain("Layer-3");
          expect(text).not.toContain("an addendum must carry something");
        }
      }
    });

    it("falls back to the server's detail message for a remediation code it has no words for, not the top-level one", () => {
      const text = addendumRefusalMessage(
        gate([
          { code: "SOMETHING_NEW", message: "the first detail" },
          { field: "pain", code: "ANOTHER_NEW", message: "the second detail" },
        ]),
      );
      expect(text).toBe("the first detail the second detail");
    });

    it("still says what happened, changing nothing, when the refusal lists no remediation", () => {
      for (const details of [undefined, [], "nonsense", [{ code: 3 }]]) {
        const text = addendumRefusalMessage(gate(details));
        expect(text).toMatch(/Nothing was changed/);
        expect(text).not.toMatch(/encounter/i);
      }
    });

    it("leaves a 422 with another code to the default (the server's own message)", () => {
      expect(
        addendumRefusalMessage({
          status: 422,
          code: "GATE_FAILED",
          message: "required Pain is empty",
        }),
      ).toBe("required Pain is empty");
    });
  });

  it("says a source could not be read and to try again, changing nothing", () => {
    expect(
      addendumRefusalMessage({ ...refusal("COMPLIANCE_GATE_UNAVAILABLE"), status: 503 }),
    ).toMatch(/Try again in a moment/);
  });

  it("says no cosigner is available, that the case manager cannot cosign what they wrote (the note or the amendment), and what to ask for", () => {
    const text = addendumRefusalMessage({ ...refusal("NO_ELIGIBLE_COSIGNER"), status: 422 });
    expect(text).toMatch(/cosign/i);
    expect(text).toMatch(/a note or an amendment they wrote themselves/);
    expect(text).toMatch(/Nothing was changed/);
    expect(text).toMatch(/wrote neither the note nor this amendment/);
  });

  // The server's message for this code is generic and names no section: the sentence is keyed on the CODE, whatever the message says.
  it.each([
    "a named section cannot be amended by this signer",
    "",
    "something else a later server might say",
  ])(
    "explains an amendment of text the signer's access does not include, whatever the server's message (%j)",
    (message) => {
      const text = addendumRefusalMessage({
        ...refusal("AMENDMENT_PART2_NOT_ENTITLED", undefined, message),
        status: 422,
      });
      expect(text).toMatch(/cannot choose sections to amend on this note/);
      expect(text).toMatch(/Nothing was changed/);
      if (message !== "") expect(text).not.toContain(message);
    },
  );

  // The server answers this code for ANY named section whenever the note holds Part 2 text the signer cannot be told of, so the sentence
  // may not say that a section holds Part 2, nor name the section: a viewer without disclosure learns nothing from the refusal.
  it("implies nothing about Part 2 content or about which section was named, at opening or at signing", () => {
    const sentences = [
      amendCreateRefusal(422, "AMENDMENT_PART2_NOT_ENTITLED"),
      addendumRefusalMessage({
        ...refusal(
          "AMENDMENT_PART2_NOT_ENTITLED",
          { sectionId: "sud_history" },
          "sud_history holds Part 2 text",
        ),
        status: 422,
      }),
    ];
    for (const text of sentences) {
      expect(text).not.toMatch(/part\s*2|cfr|protected|withheld|holds|information/i);
      expect(text).not.toMatch(/sud|history|pain|plan|assessment/i);
    }
    expect(sentences[0]).toBe(sentences[1]);
  });

  it("words the machine's stale step-up (412) in the app's own sentence, with the next step", () => {
    const text = addendumRefusalMessage({ ...refusal("STEP_UP_AUTH_REQUIRED"), status: 412 });
    expect(text).not.toBe("server said so");
    expect(text).toMatch(/re-authenticat/i);
    expect(text).toMatch(/Nothing was changed/);
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

  it("waits, saying only the author can review and sign, when the draft is the author's alone", () => {
    expect(signBlockReason({ status: "notAuthor" })).toMatch(/only the author of this addendum/i);
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

describe("addendumContentHint (the addendum's one rule: it needs content, not the note's required sections)", () => {
  const EMPTY = {};
  const WRITTEN = { pain: { entries: [{ code: "pain.controlled", params: {} }], freeText: "" } };
  const NOTE_ONLY = { pain: { entries: [], freeText: "  Family reports relief.  " } };
  const BLANK = { pain: { entries: [], freeText: "   " } };

  it("says a free addendum with nothing in it needs a finding or a note", () => {
    expect(addendumContentHint(EMPTY, null)).toBe(
      "Nothing here yet. Before finalizing, add a finding or a note.",
    );
    expect(addendumContentHint(BLANK, null)).toMatch(/^Nothing here yet/);
  });

  it("also offers a confirmed redrafted section to an amending addendum", () => {
    expect(addendumContentHint(EMPTY, { confirmed: 0 })).toBe(
      "Nothing here yet. Before finalizing, add a finding or a note, or confirm a redrafted section if one is offered.",
    );
  });

  it("is silent once a finding or a note is in, whatever else is empty", () => {
    expect(addendumContentHint(WRITTEN, null)).toBeNull();
    expect(addendumContentHint(NOTE_ONLY, null)).toBeNull();
    expect(addendumContentHint(WRITTEN, { confirmed: 0 })).toBeNull();
  });

  it("is silent once an amended section is confirmed, with no finding or note at all", () => {
    expect(addendumContentHint(EMPTY, { confirmed: 1 })).toBeNull();
  });

  it("says nothing while an amending addendum's own draft has not been read: an unknown count is not an empty one", () => {
    expect(addendumContentHint(EMPTY, { confirmed: null })).toBeNull();
  });

  it("never lists the note's required sections", () => {
    for (const amendment of [null, { confirmed: 0 }]) {
      expect(addendumContentHint(EMPTY, amendment)).not.toMatch(/required|Assessment|Plan/i);
    }
  });
});
