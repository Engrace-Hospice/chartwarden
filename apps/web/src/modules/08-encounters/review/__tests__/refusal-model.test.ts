// WF09 WP3 — how a refused finalize or sign becomes a list of blockers. The server's answer is the only verdict: the gate's `check` id is
// stripped from the wire (gate.ts assertGatePassed), so the blockers key off `code` and `field`, and anything the model cannot read still
// renders as a generic blocker rather than vanishing. Synthetic data only.
import { describe, expect, it } from "vitest";
import { GATE_REGISTER } from "../gate-register";
import {
  type Blocker,
  CHECK_BY_CODE,
  asksForLateEntryReason,
  connectionLostAttempt,
  panelWordsRefusal,
  parseRefusal,
  refusalMovedStatus,
  refusedAttempt,
  remedyFor,
  responseRefusal,
} from "../refusal-model";

const headingOf = (sectionId: string): string =>
  ({ assessment: "Assessment", vitals_review: "Vital Signs Review", plan: "Plan" })[sectionId] ??
  sectionId;

const gateFailed = (details: unknown, status: number | null = 422) => ({
  status,
  code: "COMPLIANCE_GATE_FAILED",
  message: "the Layer-3 compliance gate did not pass; the encounter stays in draft",
  details,
});

function blockedOf(input: unknown, moment: "finalize" | "sign" = "finalize"): readonly Blocker[] {
  const refusal = parseRefusal(input, moment, headingOf);
  if (refusal.outcome !== "blocked")
    throw new Error(`expected a blocked refusal, got ${refusal.outcome}`);
  return refusal.blockers;
}

describe("remedyFor: where each refusal is fixed", () => {
  it("sends a template section to that section", () => {
    expect(remedyFor("MISSING_SECTION", "assessment")).toEqual({
      kind: "section",
      sectionId: "assessment",
    });
  });

  it("sends each vital key to the vitals panel", () => {
    for (const vital of ["bp", "heartRate", "respiratoryRate", "temperature", "spo2", "pain"]) {
      expect(remedyFor("MISSING_VITAL", vital)).toEqual({ kind: "vitals", vital });
    }
  });

  it("sends a vital the model does not know to the vitals panel without naming one", () => {
    expect(remedyFor("MISSING_VITAL", "weight")).toEqual({ kind: "vitals" });
  });

  it("sends the two required scales to where assessments are recorded", () => {
    expect(remedyFor("MISSING_SCALE", "pps")).toEqual({ kind: "scales", scale: "pps" });
    expect(remedyFor("MISSING_SCALE", "esas_r")).toEqual({ kind: "scales", scale: "esas_r" });
  });

  it("sends the care-plan review to the care plan", () => {
    expect(remedyFor("CARE_PLAN_REVIEW_OVERDUE", "carePlan")).toEqual({ kind: "care_plan_review" });
  });

  it("sends a drafted section to its draft card", () => {
    expect(remedyFor("DRAFT_SECTION_UNRESOLVED", "plan")).toEqual({
      kind: "draft_section",
      sectionId: "plan",
    });
    expect(remedyFor("DRAFT_SECTION_STALE", "plan")).toEqual({
      kind: "draft_section",
      sectionId: "plan",
    });
  });

  it("sends an invalid selection to the section field", () => {
    expect(remedyFor("INVALID_SELECTION", "assessment")).toEqual({
      kind: "section",
      sectionId: "assessment",
    });
  });

  it("sends a late-entry reason to the reason input", () => {
    expect(remedyFor("LATE_ENTRY_REASON_REQUIRED", undefined)).toEqual({
      kind: "late_entry_reason",
    });
  });

  it("has no place to enter a late-entry reason at sign: the sign request can carry one, but no screen sends it", () => {
    expect(remedyFor("LATE_ENTRY_REASON_REQUIRED", undefined, "sign")).toEqual({ kind: "none" });
    expect(remedyFor("LATE_ENTRY_REASON_REQUIRED", undefined, "finalize")).toEqual({
      kind: "late_entry_reason",
    });
  });

  it("tells the author to save the selections again after a vocabulary change", () => {
    expect(remedyFor("VOCAB_VERSION_MISMATCH", undefined)).toEqual({ kind: "save_selections" });
  });

  it("sends the closure gate to My Notes", () => {
    expect(remedyFor("NOTE_CLOSURE_REQUIRED", undefined)).toEqual({ kind: "my_notes" });
  });

  it("offers no in-app action for an override only another person can record", () => {
    expect(remedyFor("SIGNIFICANT_LATE_ENTRY_OVERRIDE_REQUIRED", undefined)).toEqual({
      kind: "none",
    });
    expect(remedyFor("NO_ELIGIBLE_COSIGNER", undefined)).toEqual({ kind: "none" });
  });

  it("falls back to opening the note for a code it does not know, and for a section code with no section", () => {
    expect(remedyFor("SOMETHING_NEW", "x")).toEqual({ kind: "open_note" });
    expect(remedyFor("MISSING_SECTION", undefined)).toEqual({ kind: "open_note" });
  });
});

describe("parseRefusal: a failed gate lists one blocker per failure", () => {
  it("words a missing required section with its heading and a remedy that targets it", () => {
    const [blocker] = blockedOf(
      gateFailed([{ field: "assessment", code: "MISSING_SECTION", message: "server words" }]),
    );
    expect(blocker).toMatchObject({
      code: "MISSING_SECTION",
      field: "assessment",
      check: "required_sections",
      what: "Assessment has no entry",
      remedy: { kind: "section", sectionId: "assessment" },
      remedyLabel: "Go to Assessment",
    });
  });

  it("says recorded vitals do not fill the vitals review section", () => {
    const [blocker] = blockedOf(
      gateFailed([{ field: "vitals_review", code: "MISSING_SECTION", message: "m" }]),
    );
    expect(blocker?.why).toMatch(/recorded vitals do not fill it/i);
  });

  it("keeps every failure, in the server's order, when the gate names several", () => {
    const blockers = blockedOf(
      gateFailed([
        { field: "plan", code: "MISSING_SECTION", message: "m" },
        { field: "bp", code: "MISSING_VITAL", message: "m" },
        { field: "pps", code: "MISSING_SCALE", message: "m" },
        { field: "carePlan", code: "CARE_PLAN_REVIEW_OVERDUE", message: "m" },
        { field: "plan", code: "DRAFT_SECTION_UNRESOLVED", message: "m" },
      ]),
    );
    expect(blockers.map((b) => b.check)).toEqual([
      "required_sections",
      "required_vitals",
      "required_scales",
      "care_plan_review",
      "draft_sections_resolved",
    ]);
    expect(blockers.map((b) => b.remedy.kind)).toEqual([
      "section",
      "vitals",
      "scales",
      "care_plan_review",
      "draft_section",
    ]);
  });

  it("renders a code it does not know instead of dropping it, with the open-the-note remedy", () => {
    const [blocker] = blockedOf(
      gateFailed([{ field: "x", code: "A_FUTURE_CHECK", message: "Something the server says." }]),
    );
    expect(blocker).toMatchObject({
      code: "A_FUTURE_CHECK",
      check: null,
      why: "Something the server says.",
      remedy: { kind: "open_note" },
    });
  });

  it("caps the server text it passes through for an unknown code", () => {
    const [blocker] = blockedOf(
      gateFailed([{ code: "A_FUTURE_CHECK", message: "x".repeat(2000) }]),
    );
    expect(blocker?.why.length).toBeLessThanOrEqual(241);
  });

  it("keeps a generic blocker when the gate named nothing readable", () => {
    for (const details of [undefined, null, [], "text", 7, {}, [null, 3, "x"]]) {
      const blockers = blockedOf(gateFailed(details));
      expect(blockers).toHaveLength(1);
      expect(blockers[0]).toMatchObject({
        code: "COMPLIANCE_GATE_FAILED",
        remedy: { kind: "open_note" },
      });
    }
  });

  it("reads a detail without a code as an unknown blocker rather than dropping it", () => {
    const blockers = blockedOf(gateFailed([{ message: "No code here." }]));
    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.code).toBe("UNKNOWN");
  });

  it("records that the gate ran in full only for a gate failure", () => {
    const failed = parseRefusal(
      gateFailed([{ field: "plan", code: "MISSING_SECTION", message: "m" }]),
      "finalize",
      headingOf,
    );
    const stale = parseRefusal(
      { status: 409, code: "VOCAB_VERSION_MISMATCH", message: "m", details: undefined },
      "finalize",
      headingOf,
    );
    expect(failed).toMatchObject({ outcome: "blocked", gateRanInFull: true });
    expect(stale).toMatchObject({ outcome: "blocked", gateRanInFull: false });
  });

  it("records a refusal as decided before any write only for a code this model knows the server raises before it writes", () => {
    const decided = (code: string): unknown =>
      (
        parseRefusal(
          { status: 409, code, message: "m", details: undefined },
          "finalize",
          headingOf,
        ) as {
          decidedBeforeWrite: boolean;
        }
      ).decidedBeforeWrite;
    for (const code of [
      "COMPLIANCE_GATE_FAILED",
      "LATE_ENTRY_REASON_REQUIRED",
      "VOCAB_VERSION_MISMATCH",
      "INVALID_SELECTION",
      "NOTE_CLOSURE_REQUIRED",
      "DRAFT_SECTION_STALE",
    ]) {
      expect(decided(code), code).toBe(true);
    }
    for (const code of ["ILLEGAL_TRANSITION", "IMMUTABLE_AFTER_SIGN", "SOMETHING_NEW", "UNKNOWN"]) {
      expect(decided(code), code).toBe(false);
    }
  });
});

describe("the words of a refusal that is not on a screen's own", () => {
  const signRefusal = (code: string): Blocker => {
    const [blocker] = blockedOf({ status: 422, code, message: "m", details: undefined }, "sign");
    if (!blocker) throw new Error("no blocker");
    return blocker;
  };

  it("says at sign that the late-entry reason is required and cannot be entered on this screen yet, with no button", () => {
    const blocker = signRefusal("LATE_ENTRY_REASON_REQUIRED");
    expect(blocker.what).toBe("A late-entry reason is required");
    expect(blocker.why).toContain(
      "The reason is required, and it cannot be entered on this screen yet.",
    );
    expect(blocker).toMatchObject({ remedy: { kind: "none" }, remedyLabel: null });
  });

  it("says at finalize that the reason is required once the note is more than 1 calendar day after the visit date, with the field as the remedy", () => {
    const [blocker] = blockedOf(
      { status: 422, code: "LATE_ENTRY_REASON_REQUIRED", message: "m", details: undefined },
      "finalize",
    );
    expect(blocker?.why).toBe(
      "This note is being documented more than 1 calendar day after the visit date.",
    );
    expect(blocker?.why).not.toMatch(/24 hours/);
    expect(blocker?.remedy).toEqual({ kind: "late_entry_reason" });
  });

  it("says a face-to-face encounter must already be linked to its record, and that signing does not write it", () => {
    const blocker = signRefusal("F2F_DUAL_WRITE_REQUIRED");
    expect(blocker.what).toBe("The face-to-face record is not linked to this encounter");
    expect(blocker.why).toBe(
      "A face-to-face encounter must already be linked to its face-to-face record before it can be signed. Link the record, then sign again.",
    );
    expect(blocker.why).not.toMatch(/written/);
    expect(blocker.remedyLabel).toBeNull();
  });
});

describe("every code this model words belongs to a check the register lists", () => {
  it("maps each code to a register check id that exists, or to none", () => {
    const ids = new Set(GATE_REGISTER.map((check) => check.id));
    expect(CHECK_BY_CODE.size).toBeGreaterThan(20);
    for (const [code, check] of CHECK_BY_CODE) {
      expect(check === null || ids.has(check), `${code} -> ${check}`).toBe(true);
    }
  });

  it("covers every code the gate raises (the mirror test pins the checks themselves against the server)", () => {
    for (const code of [
      "MISSING_SECTION",
      "NO_TEMPLATE_FOR_PAIR",
      "MISSING_VITAL",
      "MISSING_SCALE",
      "CARE_PLAN_REVIEW_OVERDUE",
      "DRAFT_SECTION_UNRESOLVED",
      "DRAFT_SECTION_STALE",
    ]) {
      expect(CHECK_BY_CODE.get(code), code).toBeTruthy();
    }
  });
});

describe("parseRefusal: other refusals", () => {
  it("lists drafted sections refused at sign (409) one by one", () => {
    const blockers = blockedOf(
      {
        status: 409,
        code: "DRAFT_SECTION_STALE",
        message: "m",
        details: [
          { field: "plan", code: "DRAFT_SECTION_UNRESOLVED", message: "m" },
          { field: "assessment", code: "DRAFT_SECTION_STALE", message: "m" },
        ],
      },
      "sign",
    );
    expect(blockers.map((b) => b.field)).toEqual(["plan", "assessment"]);
    expect(blockers.every((b) => b.remedy.kind === "draft_section")).toBe(true);
  });

  it("says each invalid selection with the server's own sentence and points at the section", () => {
    const [blocker] = blockedOf({
      status: 422,
      code: "INVALID_SELECTION",
      message: "m",
      details: [
        { field: "assessment", code: "SLOT_EMPTY", message: "Dependent edema needs a site." },
      ],
    });
    expect(blocker).toMatchObject({
      field: "assessment",
      why: "Dependent edema needs a site.",
      remedy: { kind: "section", sectionId: "assessment" },
    });
  });

  it("asks for the selections to be saved again on a vocabulary mismatch", () => {
    const [blocker] = blockedOf({
      status: 409,
      code: "VOCAB_VERSION_MISMATCH",
      message: "m",
      details: undefined,
    });
    expect(blocker).toMatchObject({
      check: "vocab_version_pin",
      remedyLabel: "Save the selections again",
    });
  });

  it("asks for a fresh sign-in on either step-up refusal", () => {
    for (const [status, code] of [
      [403, "STEP_UP_REQUIRED"],
      [412, "STEP_UP_AUTH_REQUIRED"],
    ] as const) {
      const [blocker] = blockedOf({ status, code, message: "m", details: undefined }, "sign");
      expect(blocker).toMatchObject({ check: "step_up_fresh", remedy: { kind: "reauthenticate" } });
    }
  });

  it("names the overdue-note count from the closure gate's details and points at My Notes", () => {
    const [blocker] = blockedOf({
      status: 403,
      code: "NOTE_CLOSURE_REQUIRED",
      message: "m",
      details: [
        { field: "encounterId", code: "OLDEST_OPEN_NOTE", message: "uuid" },
        { field: "overdueCount", code: "OVERDUE_COUNT", message: "3" },
      ],
    });
    expect(blocker?.why).toMatch(/3 overdue notes/);
    expect(blocker?.remedy).toEqual({ kind: "my_notes" });
  });

  it("reads the NO_ELIGIBLE_COSIGNER refusal as advice with no button", () => {
    const [blocker] = blockedOf(
      { status: 422, code: "NO_ELIGIBLE_COSIGNER", message: "m", details: undefined },
      "sign",
    );
    expect(blocker).toMatchObject({
      check: "eligible_cosigner",
      remedy: { kind: "none" },
      remedyLabel: null,
    });
  });

  it("falls back to one generic blocker for a refusal code it does not know", () => {
    const [blocker] = blockedOf({
      status: 422,
      code: "BRAND_NEW",
      message: "Say this.",
      details: undefined,
    });
    expect(blocker).toMatchObject({
      code: "BRAND_NEW",
      why: "Say this.",
      remedy: { kind: "open_note" },
    });
  });
});

describe("parseRefusal: when the server could not decide", () => {
  it("reads a 503 as unavailable and never carries the server's message", () => {
    const refusal = parseRefusal(
      {
        status: 503,
        code: "COMPLIANCE_GATE_UNAVAILABLE",
        message: "care plan reader failed: ECONNREFUSED 10.0.0.5:5432",
        details: undefined,
      },
      "finalize",
      headingOf,
    );
    expect(refusal).toEqual({ outcome: "unavailable", moment: "finalize", reason: "service" });
    expect(JSON.stringify(refusal)).not.toContain("ECONNREFUSED");
  });

  it("reads a rate limit as unavailable for the service: nothing was written", () => {
    const refusal = parseRefusal(
      { status: 429, code: "X", message: "m", details: undefined },
      "sign",
      headingOf,
    );
    expect(refusal).toEqual({ outcome: "unavailable", moment: "sign", reason: "service" });
  });

  it("reads any other server error as unconfirmed: it does not say whether the note changed", () => {
    for (const status of [500, 502, 503, 504]) {
      const refusal = parseRefusal(
        { status, code: "X", message: "m", details: undefined },
        "sign",
        headingOf,
      );
      expect(refusal, String(status)).toEqual({
        outcome: "unavailable",
        moment: "sign",
        reason: "unconfirmed",
      });
    }
  });

  it("reads a dropped connection as unavailable, for the connection", () => {
    const refusal = parseRefusal(
      { status: null, code: null, message: "m", details: undefined },
      "finalize",
      headingOf,
    );
    expect(refusal).toEqual({ outcome: "unavailable", moment: "finalize", reason: "connection" });
  });
});

describe("parseRefusal: garbage in", () => {
  it("never throws and always yields something to render", () => {
    const garbage: unknown[] = [
      null,
      undefined,
      42,
      "boom",
      [],
      {},
      { status: "422", code: 7, message: {}, details: 1 },
      { error: null },
      { error: { code: "COMPLIANCE_GATE_FAILED", details: [{ field: 4, code: 5, message: 6 }] } },
    ];
    for (const input of garbage) {
      const refusal = parseRefusal(input, "finalize", headingOf);
      // None of these is a server error, so each is a blocked refusal with something to render, never "unavailable".
      expect(refusal.outcome, JSON.stringify(input)).toBe("blocked");
      if (refusal.outcome === "blocked") expect(refusal.blockers.length).toBeGreaterThan(0);
    }
  });

  it("reads a raw error envelope the same as a write result", () => {
    const blockers = blockedOf({
      error: {
        code: "COMPLIANCE_GATE_FAILED",
        message: "m",
        details: [{ field: "plan", code: "MISSING_SECTION", message: "m" }],
      },
    });
    expect(blockers[0]).toMatchObject({ code: "MISSING_SECTION", field: "plan" });
  });

  it("uses the id as the heading when the template does not know the section", () => {
    const [blocker] = blockedOf(
      gateFailed([{ field: "mystery_section", code: "MISSING_SECTION", message: "m" }]),
    );
    expect(blocker?.what).toBe("mystery_section has no entry");
  });
});

describe("attempts for the panel", () => {
  it("wraps a refusal as a refused attempt, a new object for every answer", () => {
    const input = {
      status: 503,
      code: "COMPLIANCE_GATE_UNAVAILABLE",
      message: "m",
      details: undefined,
    };
    const first = refusedAttempt(input, "finalize", headingOf);
    expect(first).toEqual({
      state: "refused",
      refusal: { outcome: "unavailable", moment: "finalize", reason: "service" },
    });
    expect(refusedAttempt(input, "finalize", headingOf)).not.toBe(first);
  });

  it("says a finalize that got no answer is unknown, claiming nothing about the note", () => {
    expect(connectionLostAttempt("finalize")).toEqual({
      state: "refused",
      refusal: { outcome: "unavailable", moment: "finalize", reason: "connection" },
    });
  });
});

describe("what the screens ask of an attempt", () => {
  it("reads a gate failure, a code it knows, a note that moved on and 'could not decide' as the panel's alone to say, and a code it does not know as the screen's banner too", () => {
    const attempt = (status: number, code: string, details: unknown = undefined) =>
      refusedAttempt({ status, code, message: "m", details }, "finalize", headingOf);
    expect(
      panelWordsRefusal(
        refusedAttempt(
          gateFailed([{ field: "plan", code: "MISSING_SECTION", message: "m" }]),
          "finalize",
          headingOf,
        ),
      ),
    ).toBe(true);
    for (const [status, code] of [
      [503, "COMPLIANCE_GATE_UNAVAILABLE"],
      [409, "VOCAB_VERSION_MISMATCH"],
      [422, "LATE_ENTRY_REASON_REQUIRED"],
      [422, "INVALID_SELECTION"],
      [403, "NOTE_CLOSURE_REQUIRED"],
      [409, "ILLEGAL_TRANSITION"],
    ] as const) {
      expect(panelWordsRefusal(attempt(status, code, [])), code).toBe(true);
    }
    expect(panelWordsRefusal(connectionLostAttempt("finalize"))).toBe(true);
    expect(panelWordsRefusal(attempt(422, "VALIDATION_FAILED", []))).toBe(false);
    expect(panelWordsRefusal({ state: "none" })).toBe(false);
    expect(panelWordsRefusal({ state: "finalized" })).toBe(false);
  });

  it("reads a refusal that says the note moved on (finalized or signed in another tab) as one to read the note again for", () => {
    const moved = refusedAttempt(
      { status: 409, code: "ILLEGAL_TRANSITION", message: "m", details: undefined },
      "finalize",
      headingOf,
    );
    const signedElsewhere = refusedAttempt(
      { status: 409, code: "IMMUTABLE_AFTER_SIGN", message: "m", details: undefined },
      "sign",
      headingOf,
    );
    const vocab = refusedAttempt(
      { status: 409, code: "VOCAB_VERSION_MISMATCH", message: "m", details: undefined },
      "finalize",
      headingOf,
    );
    expect(refusalMovedStatus(moved)).toBe(true);
    expect(refusalMovedStatus(signedElsewhere)).toBe(true);
    expect(refusalMovedStatus(vocab)).toBe(false);
    expect(refusalMovedStatus(connectionLostAttempt("finalize"))).toBe(false);
    expect(refusalMovedStatus({ state: "none" })).toBe(false);
  });

  it("asks for the late-entry field only after the server asked for a reason", () => {
    const late = refusedAttempt(
      { status: 422, code: "LATE_ENTRY_REASON_REQUIRED", message: "m", details: undefined },
      "finalize",
      headingOf,
    );
    const other = refusedAttempt(
      gateFailed([{ field: "plan", code: "MISSING_SECTION", message: "m" }]),
      "finalize",
      headingOf,
    );
    const lateAtSign = refusedAttempt(
      { status: 422, code: "LATE_ENTRY_REASON_REQUIRED", message: "m", details: undefined },
      "sign",
      headingOf,
    );
    expect(asksForLateEntryReason(late)).toBe(true);
    // The field collects a reason for a finalize; a refused sign cannot take one, so it does not ask for the field.
    expect(asksForLateEntryReason(lateAtSign)).toBe(false);
    expect(asksForLateEntryReason(other)).toBe(false);
    expect(asksForLateEntryReason({ state: "none" })).toBe(false);
  });

  it("reads a raw API answer: the HTTP status with the envelope the body carries", () => {
    const input = responseRefusal(422, {
      error: {
        code: "COMPLIANCE_GATE_FAILED",
        message: "m",
        details: [{ field: "plan", code: "MISSING_SECTION", message: "m" }],
      },
    });
    const refusal = parseRefusal(input, "finalize", headingOf);
    expect(refusal).toMatchObject({ outcome: "blocked", gateRanInFull: true });
    expect(parseRefusal(responseRefusal(503, null), "sign", headingOf)).toMatchObject({
      outcome: "unavailable",
      reason: "unconfirmed",
    });
  });

  it("says the sign dialog's own refusals in words, with no button, since the dialog is where they are fixed", () => {
    for (const code of [
      "MODALITY_CONFIRMATION_REQUIRED",
      "MODALITY_CONFLICTS_WITH_VISIT_TYPE",
      "VISIT_TIME_OVERLAP",
    ]) {
      const [blocker] = blockedOf({ status: 422, code, message: "m", details: undefined }, "sign");
      expect(blocker).toMatchObject({ code, remedy: { kind: "none" }, remedyLabel: null });
      expect(blocker?.what).not.toBe("The server reported a problem");
    }
  });
});
