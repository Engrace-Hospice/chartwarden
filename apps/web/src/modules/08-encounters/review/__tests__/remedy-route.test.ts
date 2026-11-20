// WF09 WP3 review fixes — where a remedy leads outside the screen that shows it, and the `?focus=` the record hands the composer. The
// query value is user-controlled: it is read against a fixed list and the template's own section ids, and anything else is ignored.
import { describe, expect, it } from "vitest";
import type { NoteTarget } from "../note-target";
import { panelAttemptFor } from "../panel-attempt";
import { connectionLostAttempt } from "../refusal-model";
import {
  composeHrefFor,
  externalPathFor,
  focusParamFor,
  parseFocusParam,
  recordRemedyLabel,
} from "../remedy-route";

const SECTIONS: ReadonlySet<string> = new Set(["chief_concern", "assessment", "plan"]);
const COMPOSE = "/patients/p1/encounters/e1/compose";

describe("the focus a target asks of the composer", () => {
  it("names a section, the vitals, the plan of care and the note text, and nothing else", () => {
    expect(focusParamFor({ kind: "section", sectionId: "assessment" })).toBe("section:assessment");
    expect(focusParamFor({ kind: "draft_section", sectionId: "plan" })).toBe("section:plan");
    expect(focusParamFor({ kind: "vitals", vital: "bp" })).toBe("vitals");
    expect(focusParamFor({ kind: "plan_step" })).toBe("plan");
    expect(focusParamFor({ kind: "note_text" })).toBe("note");
    for (const target of [
      { kind: "save_selections" },
      { kind: "late_entry_reason" },
      { kind: "scales", scale: "pps" },
      { kind: "care_plan_review" },
      { kind: "my_notes" },
      { kind: "open_note" },
      { kind: "reauthenticate" },
      { kind: "none" },
    ] satisfies NoteTarget[]) {
      expect(focusParamFor(target), target.kind).toBeNull();
    }
  });

  it("adds the focus to the composer path, encoded, and leaves the path alone when there is none", () => {
    expect(composeHrefFor(COMPOSE, { kind: "section", sectionId: "assessment" })).toBe(
      `${COMPOSE}?focus=section%3Aassessment`,
    );
    expect(composeHrefFor(COMPOSE, { kind: "save_selections" })).toBe(COMPOSE);
  });
});

describe("reading ?focus= (input from the address bar)", () => {
  it("round-trips each target the record can send", () => {
    expect(parseFocusParam("section:assessment", SECTIONS)).toEqual({
      kind: "section",
      sectionId: "assessment",
    });
    expect(parseFocusParam("vitals", SECTIONS)).toEqual({ kind: "vitals" });
    expect(parseFocusParam("plan", SECTIONS)).toEqual({ kind: "plan_step" });
    expect(parseFocusParam("note", SECTIONS)).toEqual({ kind: "note_text" });
  });

  it("ignores anything it does not know", () => {
    for (const raw of [
      null,
      "",
      "evil",
      "section:",
      "section:nope",
      "section:assessment:extra",
      "section:../../etc",
      "SECTION:assessment",
      "vitals ",
      "javascript:alert(1)",
      "<script>",
    ]) {
      expect(parseFocusParam(raw, SECTIONS), String(raw)).toBeNull();
    }
  });

  it("opens no section when the template has none", () => {
    expect(parseFocusParam("section:assessment", new Set())).toBeNull();
  });
});

describe("the screens outside the note that fix a target", () => {
  it("names the assessments, the care plan and My Notes, and no other target", () => {
    expect(externalPathFor({ kind: "scales", scale: "pps" }, "p1")).toBe(
      "/patients/p1/assessments",
    );
    expect(externalPathFor({ kind: "care_plan_review" }, "p1")).toBe("/patients/p1/care-plan");
    expect(externalPathFor({ kind: "my_notes" }, "p1")).toBe("/work/drafts");
    expect(externalPathFor({ kind: "section", sectionId: "plan" }, "p1")).toBeNull();
    expect(externalPathFor({ kind: "none" }, "p1")).toBeNull();
  });
});

describe("what the record calls a remedy it cannot honour itself", () => {
  const blocker = (remedy: NoteTarget, remedyLabel: string | null) => ({
    code: "C",
    field: null,
    check: null,
    what: "w",
    why: "y",
    remedy,
    remedyLabel,
  });

  it("opens the composer instead of saving the selections, and keeps every other label", () => {
    expect(
      recordRemedyLabel(blocker({ kind: "save_selections" }, "Save the selections again")),
    ).toBe("Open the composer");
    expect(recordRemedyLabel(blocker({ kind: "vitals" }, "Open visit vitals"))).toBe(
      "Open visit vitals",
    );
    expect(recordRemedyLabel(blocker({ kind: "none" }, null))).toBeNull();
  });
});

describe("the attempt a panel shows for the note's status", () => {
  it("shows a finalized note as finalized, keeps a refused try, and returns one object for finalized", () => {
    const refused = connectionLostAttempt("sign");
    expect(panelAttemptFor("finalized", { state: "none" })).toEqual({ state: "finalized" });
    expect(panelAttemptFor("finalized", { state: "none" })).toBe(
      panelAttemptFor("finalized", { state: "running" }),
    );
    expect(panelAttemptFor("finalized", refused)).toBe(refused);
    const none = { state: "none" } as const;
    expect(panelAttemptFor("draft", none)).toBe(none);
  });
});
