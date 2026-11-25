// @vitest-environment jsdom
// The dyspnea assessment helper and the plan-of-care prompt, as the clinician meets them under "Symptom impact — dyspnea limiting
// function". Assertions are on what is on screen and on what is selected; the rules have their own unit tests in @chartwarden/types.
// The pain prompt is exercised here only to show it did not change. Synthetic values only.
import {
  DYSPNEA_ASSESSMENT_CODES as D,
  DYSPNEA_CHANGE_OPTIONS,
  DYSPNEA_PLAN_DECISIONS,
  DYSPNEA_RESPONSE_OPTIONS,
  DYSPNEA_SETTING_OPTIONS,
  DYSPNEA_STATEMENT_CODE,
  DYSPNEA_SLOTS as S,
  dyspneaPlanReviewReasons,
  painPlanReviewReasons,
} from "@chartwarden/types";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DyspneaAssessmentHelper, showsDyspneaHelper } from "./dyspnea-assessment-helper";
import type { DraftEntry, MenuEntry } from "./encounters-api";
import { PlanReviewPrompt, PlanReviewPrompts } from "./plan-review-prompt";

const PAIN_PROMPT_TITLE = "Consider a plan-of-care review";
const PROMPT_TITLE = "Consider a plan-of-care review (dyspnea)";
const PROMPT_BODY =
  "This is a prompt, not a rule. Consider asking the IDG to review the plan of care for dyspnea. Nothing changes unless you propose it in the Plan of care step.";
const FUNCTION_LIMIT_REASON =
  "Dyspnea is limiting function, so any comfort and function goal in the plan of care may not be met.";
const HOPE_REMINDER =
  "At a HOPE admission or update visit, a moderate or severe impact of shortness of breath calls for an in-person follow-up visit within 2 calendar days. That impact is how much the shortness of breath affects the patient (HOPE records not at all, slight, moderate or severe); it is not the 0 to 10 score, and no score converts to it.";
const score = (label: string) => ({ kind: "integer", min: 0, max: 10, label });
const choice = (options: readonly string[], label: string) => ({
  kind: "choice",
  options: [...options],
  label,
});

const entry = (code: string, slots: string[], slotSpecs: Record<string, unknown> = {}): MenuEntry =>
  ({
    code,
    label: code,
    category: "symptom_impact",
    bodySystem: null,
    slots,
    slotSpecs,
    exclusiveGroup: null,
  }) as unknown as MenuEntry;

/** The section's menu as the corpus serves it: the existing impact statement, then the helper's 15. */
const MENU: readonly MenuEntry[] = [
  entry(DYSPNEA_STATEMENT_CODE, ["ambulation_distance"]),
  entry(D.score, [S.score], { [S.score]: score("Dyspnea intensity (0–10)") }),
  entry(D.onset, [S.onset]),
  entry(D.setting, [S.setting], {
    [S.setting]: choice(DYSPNEA_SETTING_OPTIONS, "When dyspnea occurs"),
  }),
  entry(D.triggers, [S.triggers]),
  entry(D.relievedBy, [S.relievedBy]),
  entry(D.quality, [S.quality]),
  entry(D.distress, [S.distress]),
  entry(D.function, [S.function]),
  entry(D.nonDrug, [S.nonDrug]),
  entry(D.response, [S.response], {
    [S.response]: choice(DYSPNEA_RESPONSE_OPTIONS, "Response to the measures tried"),
  }),
  entry(D.goal, [S.goal], { [S.goal]: score("Acceptable dyspnea level (0–10)") }),
  entry(D.lastScore, [S.lastScore], {
    [S.lastScore]: score("Dyspnea score at the last visit (0–10)"),
  }),
  entry(D.change, [S.change], {
    [S.change]: choice(DYSPNEA_CHANGE_OPTIONS, "Change since the last visit"),
  }),
  entry(D.nonverbal, [S.nonverbal]),
  entry(D.planDecision, [S.planDecision], {
    [S.planDecision]: choice(DYSPNEA_PLAN_DECISIONS, "Plan of care decision"),
  }),
];

const IMPACT = (): DraftEntry => ({
  code: DYSPNEA_STATEMENT_CODE,
  params: { ambulation_distance: "20 feet" },
});

const PAIN_LIMITING = (): DraftEntry => ({
  code: "nv.sym.pain_uncontrolled",
  params: { pain_score: "6" },
});

/** The composer's own toggle and slot handlers, reduced to what the helper depends on. */
function Harness({
  menu = MENU,
  initial = [IMPACT()],
  disabled = false,
  onOpenPlan = () => undefined,
  onChange,
}: {
  menu?: readonly MenuEntry[];
  initial?: DraftEntry[];
  disabled?: boolean;
  onOpenPlan?: () => void;
  onChange?: (entries: readonly DraftEntry[]) => void;
}) {
  const [selected, setSelected] = useState<DraftEntry[]>(initial);
  return (
    <DyspneaAssessmentHelper
      menu={menu}
      selected={selected}
      disabled={disabled}
      recordedElsewhere={() => undefined}
      onToggle={(e) =>
        setSelected((prev) => {
          const next = prev.some((s) => s.code === e.code)
            ? prev.filter((s) => s.code !== e.code)
            : [...prev, { code: e.code, params: {} }];
          onChange?.(next);
          return next;
        })
      }
      onSlot={(code, slot, value) =>
        setSelected((prev) => {
          const next = prev.map((s) =>
            s.code === code ? { ...s, params: { ...s.params, [slot]: value } } : s,
          );
          onChange?.(next);
          return next;
        })
      }
      onOpenPlan={onOpenPlan}
    />
  );
}

const prompt = () => screen.getByRole("region", { name: PROMPT_TITLE });

interface FieldCase {
  readonly label: string;
  readonly code: string;
  readonly slot: string;
  readonly value: string;
  readonly isChoice?: true;
}

const FIELDS: readonly FieldCase[] = [
  { label: "Intensity (0 to 10)", code: D.score, slot: S.score, value: "6" },
  { label: "Onset", code: D.onset, slot: S.onset, value: "two days ago" },
  {
    label: "When it occurs",
    code: D.setting,
    slot: S.setting,
    value: "on exertion",
    isChoice: true,
  },
  {
    label: "What brings it on or worsens it",
    code: D.triggers,
    slot: S.triggers,
    value: "climbing the stairs",
  },
  { label: "What relieves it", code: D.relievedBy, slot: S.relievedBy, value: "sitting upright" },
  {
    label: "Quality (what it feels like)",
    code: D.quality,
    slot: S.quality,
    value: "tightness in the chest",
  },
  {
    label: "Distress or anxiety",
    code: D.distress,
    slot: S.distress,
    value: "frightened when it starts",
  },
  {
    label: "Effect on function",
    code: D.function,
    slot: S.function,
    value: "rests after ten steps",
  },
  {
    label: "Non-drug measures",
    code: D.nonDrug,
    slot: S.nonDrug,
    value: "a fan and sitting forward",
  },
  {
    label: "Response to the measures tried",
    code: D.response,
    slot: S.response,
    value: "partial relief",
    isChoice: true,
  },
  {
    label: "Signs observed",
    code: D.nonverbal,
    slot: S.nonverbal,
    value: "fast shallow breathing, grimacing",
  },
  {
    label: "The patient's own acceptable dyspnea level",
    code: D.goal,
    slot: S.goal,
    value: "3",
  },
  { label: "Dyspnea score at the last visit", code: D.lastScore, slot: S.lastScore, value: "4" },
  {
    label: "Change since the last visit",
    code: D.change,
    slot: S.change,
    value: "unchanged",
    isChoice: true,
  },
  {
    label: "Your decision about the plan of care",
    code: D.planDecision,
    slot: S.planDecision,
    value: "physician notified",
    isChoice: true,
  },
];

describe("DyspneaAssessmentHelper", () => {
  it("names the eight characteristics and counts what the dyspnea statement already documents", () => {
    render(<Harness />);
    expect(screen.getByText("Dyspnea assessment: 1 of 8 characteristics documented")).toBeTruthy();
    const chips = screen.getByRole("list", { name: "Characteristics of a dyspnea assessment" });
    expect(within(chips).getAllByRole("listitem")).toHaveLength(8);
    expect(within(chips).getByText("Effect on function: documented")).toBeTruthy();
    for (const missing of [
      "Intensity",
      "Onset",
      "When it occurs",
      "What brings it on or worsens it",
      "What relieves it",
      "Quality (what it feels like)",
      "Distress or anxiety",
    ]) {
      expect(within(chips).getByText(missing)).toBeTruthy();
    }
  });

  it("says what to record, claims no benchmark and gives the group titles and notes as written", () => {
    render(<Harness />);
    expect(
      screen.getByText(
        "Record what you assessed. Every field is optional; the note states only what you enter, in your own words. This helper lists eight characteristics; none of the sources reviewed sets how many are required.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/benchmark|CMS quality measure/i)).toBeNull();
    for (const title of [
      "Characteristics",
      "Measures tried",
      "If the patient cannot self-report",
      "Compared with before",
      "Plan of care",
    ]) {
      expect(screen.getByRole("group", { name: title })).toBeTruthy();
    }
    expect(
      screen.getByText(
        "Intensity is the 0 to 10 score the patient reports. No validated dyspnea cut-off was found, and the published ESAS values differ, so none is used here.",
      ),
    ).toBeTruthy();
    for (const hint of [
      "Ask the patient to rate shortness of breath now, 0 is none and 10 is worst.",
      "For example positioning, a fan, relaxation techniques.",
      "Ask the patient first, then the caregiver. An observation score is not a 0 to 10 dyspnea rating.",
      "The level at which the patient is comfortable enough, for the same situation (rest or activity) in which you rated the intensity above.",
    ]) {
      expect(screen.getByText(hint)).toBeTruthy();
    }
  });

  it("gives the chip list an explicit list role, which Safari and VoiceOver otherwise drop from an unstyled list", () => {
    render(<Harness />);
    expect(
      screen.getByRole("list", { name: "Characteristics of a dyspnea assessment" }),
    ).toHaveAttribute("role", "list");
  });

  it("ties the hint of a numbered field to its control, so a screen reader reads both", () => {
    render(<Harness />);
    expect(screen.getByLabelText("Intensity (0 to 10)")).toHaveAccessibleDescription(
      /^0–10 Ask the patient to rate shortness of breath now, 0 is none and 10 is worst\.$/,
    );
    expect(
      screen.getByLabelText("The patient's own acceptable dyspnea level"),
    ).toHaveAccessibleDescription(
      /^0–10 The level at which the patient is comfortable enough, for the same situation \(rest or activity\) in which you rated the intensity above\.$/,
    );
  });

  it("offers no observation scale and no oxygen, opioid or teaching field", () => {
    render(<Harness />);
    expect(screen.queryByText(/RDOS|PAINAD|FLACC/)).toBeNull();
    expect(screen.queryByLabelText(/scale|oxygen|opioid|teaching/i)).toBeNull();
  });

  it.each(FIELDS)("writes $label to its own statement and slot", async (field) => {
    const user = userEvent.setup();
    const seen: (readonly DraftEntry[])[] = [];
    render(<Harness onChange={(entries) => seen.push(entries)} />);

    const control = screen.getByLabelText(field.label);
    if (field.isChoice) await user.selectOptions(control, field.value);
    else await user.type(control, field.value);

    expect(seen.at(-1)).toEqual([
      IMPACT(),
      { code: field.code, params: { [field.slot]: field.value } },
    ]);
  });

  it("takes a characteristic back when it is cleared, and counts it while it is there", async () => {
    const user = userEvent.setup();
    const seen: (readonly DraftEntry[])[] = [];
    render(<Harness onChange={(entries) => seen.push(entries)} />);

    await user.type(screen.getByLabelText("Intensity (0 to 10)"), "6");
    await user.type(screen.getByLabelText("Onset"), "two days ago");
    expect(screen.getByText(/3 of 8 characteristics documented/)).toBeTruthy();
    expect(
      within(
        screen.getByRole("list", { name: "Characteristics of a dyspnea assessment" }),
      ).getByText("Intensity: documented"),
    ).toBeTruthy();

    await user.clear(screen.getByLabelText("Onset"));
    expect(screen.getByText(/2 of 8 characteristics documented/)).toBeTruthy();
    expect(seen.at(-1)).toEqual([IMPACT(), { code: D.score, params: { [S.score]: "6" } }]);
  });

  it("never fills the last visit's score in for the clinician", () => {
    render(<Harness initial={[IMPACT(), { code: D.score, params: { [S.score]: "7" } }]} />);
    expect(
      (screen.getByLabelText("Dyspnea score at the last visit") as HTMLInputElement).value,
    ).toBe("");
    expect(screen.getByText(/2 of 8 characteristics documented/)).toBeTruthy();
  });

  it("counts a characteristic recorded in another section, and names itself apart from the pain helper", () => {
    // Intensity is recorded in another section (where the one-place lock would send the clinician); here only the impact statement is picked.
    render(
      <DyspneaAssessmentHelper
        menu={MENU}
        selected={[IMPACT()]}
        allSelected={[IMPACT(), { code: D.score, params: { [S.score]: "6" } }]}
        disabled={false}
        recordedElsewhere={() => undefined}
        onToggle={() => undefined}
        onSlot={() => undefined}
        onOpenPlan={() => undefined}
      />,
    );
    expect(screen.getByText(/2 of 8 characteristics documented/)).toBeTruthy();
    expect(
      within(
        screen.getByRole("list", { name: "Characteristics of a dyspnea assessment" }),
      ).getByText("Intensity: documented"),
    ).toBeTruthy();
    expect(screen.getByRole("group", { name: "Dyspnea assessment" })).toBeTruthy();
  });

  it("locks every field when the note cannot take a write", () => {
    render(<Harness disabled />);
    expect((screen.getByLabelText("Onset") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Intensity (0 to 10)") as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByLabelText("Change since the last visit") as HTMLSelectElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Go to Plan of care" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("lists only the statements the section's menu offers, and still shows the prompt", () => {
    render(<Harness menu={MENU.filter((e) => e.code !== D.goal && e.code !== D.planDecision)} />);
    expect(screen.queryByLabelText("The patient's own acceptable dyspnea level")).toBeNull();
    expect(screen.queryByLabelText("Your decision about the plan of care")).toBeNull();
    expect(screen.getByLabelText("Onset")).toBeTruthy();
    expect(prompt()).toBeTruthy();
  });

  it("uses none of the words that would turn it into a trigger, an instruction or a call", async () => {
    const user = userEvent.setup();
    const banned = /\b(notify|severe|moderate|mild|urgent|critical|oxygen|opioid|titrate|must)\b/i;
    // No source ties dyspnea to telling or calling anyone, so the helper's own copy, the five reasons and the card's body say neither.
    const addressee = /\b(tell\w*|physician|call\w*)\b/i;
    const { container } = render(<Harness />);
    await user.type(screen.getByLabelText("Intensity (0 to 10)"), "7");
    await user.type(screen.getByLabelText("The patient's own acceptable dyspnea level"), "3");
    await user.selectOptions(screen.getByLabelText("Response to the measures tried"), "no relief");
    const reasons = new Set<string>();
    for (const change of ["worsened", "new dyspnea"]) {
      await user.selectOptions(screen.getByLabelText("Change since the last visit"), change);
      for (const item of within(prompt()).getAllByRole("listitem")) {
        reasons.add(item.textContent ?? "");
      }
    }
    expect(reasons.size).toBe(5);

    // The helper's own wording, then the card (the reasons and where they come from). The CMS HOPE reminder is the rules' text,
    // reported separately; the plan-decision choices are the clinician's own options, not the helper's wording.
    const planChoices = screen.getByLabelText("Your decision about the plan of care").textContent;
    const helperText = (container.textContent ?? "")
      .replace(prompt().textContent ?? "", "")
      .replace(planChoices ?? "", "");
    const promptText = (prompt().textContent ?? "").replace(HOPE_REMINDER, "");
    const body = within(prompt()).getByText(/^This is a prompt, not a rule/).textContent ?? "";
    expect(helperText).not.toMatch(banned);
    expect(promptText).not.toMatch(banned);
    for (const text of [helperText, body, ...reasons]) expect(text).not.toMatch(addressee);
  });

  describe("the plan-of-care prompt", () => {
    it("is there as soon as dyspnea limiting function is picked, names dyspnea and says it is advisory", () => {
      render(<Harness />);
      expect(within(prompt()).getByText(FUNCTION_LIMIT_REASON)).toBeTruthy();
      expect(within(prompt()).getByText(PROMPT_BODY)).toBeTruthy();
      expect(within(prompt()).queryByText(/telling the physician/)).toBeNull();
      expect(within(prompt()).getByText("Clinical guideline")).toBeTruthy();
      expect(screen.queryByRole("region", { name: PAIN_PROMPT_TITLE })).toBeNull();
    });

    it("lists its reasons as a list a screen reader announces as one", () => {
      render(<Harness />);
      const reasons = within(prompt()).getByRole("list");
      expect(reasons).toHaveAttribute("role", "list");
      expect(within(reasons).getAllByRole("listitem")).toHaveLength(1);
    });

    it("reminds of the IDG cadence and the HOPE follow-up, in the sources' own terms, and of no level of care", () => {
      render(<Harness />);
      expect(prompt().textContent).toContain("at least every 15 calendar days");
      expect(prompt().textContent).toContain(HOPE_REMINDER);
      expect(prompt().textContent).not.toMatch(/level of care|continuous home care|inpatient/i);
    });

    it("is not shown for a helper statement that is no reason, such as the onset", () => {
      render(<Harness initial={[{ code: D.onset, params: { [S.onset]: "today" } }]} />);
      expect(screen.queryByRole("region", { name: PROMPT_TITLE })).toBeNull();
    });

    it("is shown without the impact statement when the clinician records a reason, and then omits the impact reason", () => {
      render(<Harness initial={[{ code: D.response, params: { [S.response]: "no relief" } }]} />);
      expect(
        within(prompt()).getByText("The measures tried for dyspnea gave no relief."),
      ).toBeTruthy();
      expect(within(prompt()).queryByText(FUNCTION_LIMIT_REASON)).toBeNull();
      expect(within(prompt()).getAllByRole("listitem")).toHaveLength(1);
    });

    it("adds a reason for each thing the clinician records, each with its kind and its source", async () => {
      const user = userEvent.setup();
      render(<Harness />);

      await user.type(screen.getByLabelText("Intensity (0 to 10)"), "7");
      await user.type(screen.getByLabelText("The patient's own acceptable dyspnea level"), "3");
      expect(
        within(prompt()).getByText(
          "Dyspnea is 7 of 10, above the patient's own acceptable level of 3.",
        ),
      ).toBeTruthy();
      expect(within(prompt()).getByText("Common practice")).toBeTruthy();

      await user.selectOptions(screen.getByLabelText("Change since the last visit"), "worsened");
      expect(within(prompt()).getByText("Dyspnea is worse than at the last visit.")).toBeTruthy();
      expect(within(prompt()).getAllByText("CMS guidance").length).toBeGreaterThan(0);
      expect(within(prompt()).getAllByText(/418\.56\(c\)\(1\)/).length).toBeGreaterThan(0);

      await user.selectOptions(screen.getByLabelText("Change since the last visit"), "new dyspnea");
      expect(within(prompt()).getByText("This dyspnea is new since the last visit.")).toBeTruthy();
      expect(within(prompt()).queryByText(/worse than at the last visit/)).toBeNull();
    });

    it("names no relief, and adds no level-of-care note for it", async () => {
      const user = userEvent.setup();
      render(<Harness />);

      await user.selectOptions(
        screen.getByLabelText("Response to the measures tried"),
        "no relief",
      );
      expect(
        within(prompt()).getByText("The measures tried for dyspnea gave no relief."),
      ).toBeTruthy();
      expect(prompt().textContent).not.toMatch(/level of care|continuous home care|inpatient/i);
    });

    it("adds nothing for a high score on its own or for a score far above the last visit's", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      await user.type(screen.getByLabelText("Intensity (0 to 10)"), "10");
      await user.type(screen.getByLabelText("Dyspnea score at the last visit"), "2");
      expect(within(prompt()).getAllByRole("listitem")).toHaveLength(1);
    });

    it("takes the clinician to the Plan of care step with one click, and changes nothing itself", async () => {
      const user = userEvent.setup();
      const onOpenPlan = vi.fn();
      const seen: (readonly DraftEntry[])[] = [];
      render(<Harness onOpenPlan={onOpenPlan} onChange={(entries) => seen.push(entries)} />);
      await user.click(screen.getByRole("button", { name: "Go to Plan of care" }));
      expect(onOpenPlan).toHaveBeenCalledTimes(1);
      expect(seen).toHaveLength(0);
    });
  });
});

describe("PlanReviewPrompt for dyspnea", () => {
  it("renders the new-dyspnea reason with its basis badge, its source and the dyspnea reminders only", () => {
    const reasons = dyspneaPlanReviewReasons([
      IMPACT(),
      { code: D.change, params: { [S.change]: "new dyspnea" } },
    ]);
    render(<PlanReviewPrompt kind="dyspnea" reasons={reasons} />);
    expect(screen.getByText("This dyspnea is new since the last visit.")).toBeTruthy();
    expect(within(prompt()).getAllByText("CMS guidance").length).toBeGreaterThan(0);
    expect(within(prompt()).getAllByText(/Appendix M, 418\.56\(c\)\(1\)/).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText(/at least every 15 calendar days/)).toBeTruthy();
    expect(screen.getByText(/impact of shortness of breath/)).toBeTruthy();
    expect(screen.queryByText(/level of care/)).toBeNull();
  });

  it("renders nothing when there is no reason", () => {
    const { container } = render(<PlanReviewPrompt kind="dyspnea" reasons={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("PlanReviewPrompt for pain is unchanged", () => {
  it("keeps its title, its sentence, its reasons and its reminders when it is given only pain reasons", () => {
    render(<PlanReviewPrompt reasons={painPlanReviewReasons([PAIN_LIMITING()])} />);
    const region = screen.getByRole("region", { name: PAIN_PROMPT_TITLE });
    expect(
      within(region).getByText(
        "This is a prompt, not a rule. Consider telling the physician and asking the IDG to review the plan of care for pain. Nothing changes unless you propose it in the Plan of care step.",
      ),
    ).toBeTruthy();
    expect(within(region).getByText(/Pain is limiting function/)).toBeTruthy();
    expect(within(region).getByText(/at least every 15 calendar days/)).toBeTruthy();
    expect(within(region).getByText(/a moderate or severe symptom impact/)).toBeTruthy();
    expect(within(region).queryByText(/shortness of breath/)).toBeNull();
    expect(within(within(region).getByRole("list")).getAllByRole("listitem")).toHaveLength(1);
  });
});

describe("PlanReviewPrompts (the Plan section)", () => {
  it("shows no prompt when the note raises no reason", () => {
    render(<PlanReviewPrompts entries={[]} />);
    expect(screen.queryByRole("region", { name: PAIN_PROMPT_TITLE })).toBeNull();
    expect(screen.queryByRole("region", { name: PROMPT_TITLE })).toBeNull();
  });

  it("shows only the pain prompt for pain, and only the dyspnea prompt for dyspnea", () => {
    const pain = render(<PlanReviewPrompts entries={[PAIN_LIMITING()]} />);
    expect(screen.getAllByRole("region", { name: PAIN_PROMPT_TITLE })).toHaveLength(1);
    expect(screen.queryByRole("region", { name: PROMPT_TITLE })).toBeNull();
    expect(screen.getByText(/review the plan of care for pain\./)).toBeTruthy();
    pain.unmount();

    render(<PlanReviewPrompts entries={[IMPACT()]} />);
    expect(screen.getAllByRole("region", { name: PROMPT_TITLE })).toHaveLength(1);
    expect(screen.queryByRole("region", { name: PAIN_PROMPT_TITLE })).toBeNull();
    expect(screen.getByText(/review the plan of care for dyspnea\./)).toBeTruthy();
  });

  it("shows both, each under its own title and heading id, when the note records both", () => {
    render(<PlanReviewPrompts entries={[PAIN_LIMITING(), IMPACT()]} />);
    const painRegion = screen.getByRole("region", { name: PAIN_PROMPT_TITLE });
    const dyspneaRegion = screen.getByRole("region", { name: PROMPT_TITLE });
    expect(painRegion).not.toBe(dyspneaRegion);
    expect(painRegion.getAttribute("aria-labelledby")).not.toBe(
      dyspneaRegion.getAttribute("aria-labelledby"),
    );
    expect(within(painRegion).getByText(/review the plan of care for pain\./)).toBeTruthy();
    expect(within(dyspneaRegion).getByText(/review the plan of care for dyspnea\./)).toBeTruthy();
  });
});

describe("showsDyspneaHelper", () => {
  it("shows once the impact statement or a helper statement is picked, and only where the section offers the impact statement", () => {
    expect(showsDyspneaHelper(MENU, [])).toBe(false);
    expect(showsDyspneaHelper(MENU, [PAIN_LIMITING()])).toBe(false);
    expect(showsDyspneaHelper(MENU, [IMPACT()])).toBe(true);
    expect(showsDyspneaHelper(MENU, [{ code: D.onset, params: { [S.onset]: "today" } }])).toBe(
      true,
    );
    expect(showsDyspneaHelper(MENU.slice(1), [IMPACT()])).toBe(false);
  });
});
