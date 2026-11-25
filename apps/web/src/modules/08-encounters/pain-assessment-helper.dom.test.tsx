// @vitest-environment jsdom
// The pain assessment helper and the plan-of-care prompt, as the clinician meets them under "Symptom impact — pain limiting function".
// Assertions are on what is on screen and on what is selected; the rules and thresholds have their own unit tests in @chartwarden/types.
// Synthetic values only.
import {
  PAIN_ASSESSMENT_CODES as C,
  PAIN_PRN_REASSESS_HINT,
  painPlanReviewReasons,
} from "@chartwarden/types";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { DraftEntry, MenuEntry, TemplateSection } from "./encounters-api";
import { PainAssessmentHelper, showsPainHelper } from "./pain-assessment-helper";
import { PlanReviewPrompt } from "./plan-review-prompt";

const score = (label: string) => ({ kind: "integer", min: 0, max: 10, label });
const choice = (options: string[], label: string) => ({ kind: "choice", options, label });

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

const MENU: readonly MenuEntry[] = [
  entry("nv.sym.pain_uncontrolled", ["pain_score"], { pain_score: score("Pain score (0–10)") }),
  entry(C.location, ["pain_location"]),
  entry(C.character, ["pain_character"]),
  entry(C.duration, ["pain_duration"]),
  entry(C.frequency, ["pain_frequency"]),
  entry(C.worsenedBy, ["pain_worsened_by"]),
  entry(C.relievedBy, ["pain_relieved_by"]),
  entry(C.prnRelief, ["pain_prn_relief"], {
    pain_prn_relief: choice(
      ["complete relief", "partial relief", "no relief", "no dose taken"],
      "Response to the last as-needed dose",
    ),
  }),
  entry(C.sideEffects, ["pain_side_effects"]),
  entry(C.bowelRegimen, ["bowel_regimen"]),
  entry(C.oralBarrier, ["oral_barrier"]),
  entry(C.nonverbal, ["nonverbal_cues"]),
  entry(C.observationScale, ["observation_tool", "observation_score"], {
    observation_tool: choice(["PAINAD", "FLACC"], "Observation scale"),
    observation_score: score("Observation scale score (0–10)"),
  }),
  entry(C.goal, ["pain_goal"], { pain_goal: score("Acceptable pain level (0–10)") }),
  entry(C.lastScore, ["pain_last_score"], {
    pain_last_score: score("Pain score at the last visit (0–10)"),
  }),
  entry(C.change, ["pain_change"], {
    pain_change: choice(
      ["improved", "unchanged", "worsened", "new pain"],
      "Change since the last visit",
    ),
  }),
  entry(C.planDecision, ["pain_plan_decision"], {
    pain_plan_decision: choice(
      [
        "no change to the current plan of care",
        "physician notified",
        "IDG plan-of-care review requested",
        "physician notified and IDG plan-of-care review requested",
      ],
      "Plan of care decision",
    ),
  }),
];

const LIMITING = (painScore = "6"): DraftEntry => ({
  code: "nv.sym.pain_uncontrolled",
  params: { pain_score: painScore },
});

/** The composer's own toggle and slot handlers, reduced to what the helper depends on. */
function Harness({
  initial = [LIMITING()],
  disabled = false,
  onOpenPlan = () => undefined,
  onChange,
}: {
  initial?: DraftEntry[];
  disabled?: boolean;
  onOpenPlan?: () => void;
  onChange?: (entries: readonly DraftEntry[]) => void;
}) {
  const [selected, setSelected] = useState<DraftEntry[]>(initial);
  const update = (next: DraftEntry[]) => {
    setSelected(next);
    onChange?.(next);
  };
  return (
    <PainAssessmentHelper
      menu={MENU}
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

describe("PainAssessmentHelper", () => {
  it("names the seven characteristics and counts what the pain statement already documents", () => {
    render(<Harness />);
    expect(screen.getByText(/2 of 7 characteristics documented/)).toBeTruthy();
    const chips = screen.getByRole("list", {
      name: "Characteristics of a comprehensive pain assessment",
    });
    expect(within(chips).getAllByRole("listitem")).toHaveLength(7);
    expect(within(chips).getByText("Severity: documented")).toBeTruthy();
    expect(
      within(chips).getByText("Effect on function or quality of life: documented"),
    ).toBeTruthy();
    for (const missing of [
      "Location",
      "Character",
      "Duration",
      "Frequency",
      "What relieves or worsens it",
    ]) {
      expect(within(chips).getByText(missing)).toBeTruthy();
    }
  });

  it("gives the chip list an explicit list role, which Safari and VoiceOver otherwise drop from an unstyled list", () => {
    render(<Harness />);
    const chips = screen.getByRole("list", {
      name: "Characteristics of a comprehensive pain assessment",
    });
    expect(chips).toHaveAttribute("role", "list");
  });

  describe("what a screen reader reads with each control", () => {
    it("reads the as-needed reassess hint with its choice, and a number's bounds with its hint", () => {
      render(<Harness />);
      expect(
        screen.getByLabelText("Response to the last as-needed dose"),
      ).toHaveAccessibleDescription(PAIN_PRN_REASSESS_HINT);
      expect(
        screen.getByLabelText("The patient's own acceptable pain level"),
      ).toHaveAccessibleDescription(
        "0–10 The level at which the patient is comfortable enough to do what matters to them.",
      );
      expect(screen.getByLabelText("Location")).toHaveAccessibleDescription(
        "Where it is, and where it spreads.",
      );
    });

    it("reads why a row is locked with every control in it, and with none of the other rows", () => {
      render(
        <PainAssessmentHelper
          menu={MENU}
          selected={[LIMITING()]}
          disabled={false}
          recordedElsewhere={(code) =>
            ([C.location, C.prnRelief, C.goal] as readonly string[]).includes(code)
              ? ({ heading: "Baseline Symptoms" } as TemplateSection)
              : undefined
          }
          onToggle={() => undefined}
          onSlot={() => undefined}
          onOpenPlan={() => undefined}
        />,
      );
      const lock = "Already recorded in Baseline Symptoms";
      expect(screen.getByLabelText("Location")).toHaveAccessibleDescription(
        `Where it is, and where it spreads. ${lock}`,
      );
      expect(
        screen.getByLabelText("Response to the last as-needed dose"),
      ).toHaveAccessibleDescription(`${PAIN_PRN_REASSESS_HINT} ${lock}`);
      expect(
        screen.getByLabelText("The patient's own acceptable pain level"),
      ).toHaveAccessibleDescription(
        `0–10 The level at which the patient is comfortable enough to do what matters to them. ${lock}`,
      );
      expect(screen.getByLabelText("Character")).not.toHaveAccessibleDescription(
        /Already recorded/,
      );
      expect(screen.getAllByText(lock)).toHaveLength(3);
    });

    it("gives the lock note of each locked row its own id", () => {
      render(
        <PainAssessmentHelper
          menu={MENU}
          selected={[LIMITING()]}
          disabled={false}
          recordedElsewhere={(code) =>
            ([C.location, C.character] as readonly string[]).includes(code)
              ? ({ heading: "Baseline Symptoms" } as TemplateSection)
              : undefined
          }
          onToggle={() => undefined}
          onSlot={() => undefined}
          onOpenPlan={() => undefined}
        />,
      );
      const ids = screen
        .getAllByText("Already recorded in Baseline Symptoms")
        .map((note) => note.getAttribute("id"));
      expect(ids.every((id) => id !== null && id !== "")).toBe(true);
      expect(new Set(ids).size).toBe(2);
    });
  });

  describe("what the count and the prompt read", () => {
    const LOCATION_ELSEWHERE: DraftEntry = { code: C.location, params: { pain_location: "hip" } };
    const GOAL_ELSEWHERE: DraftEntry = { code: C.goal, params: { pain_goal: "3" } };
    const renderWith = (allSelected?: readonly DraftEntry[]) =>
      render(
        <PainAssessmentHelper
          menu={MENU}
          selected={[LIMITING("6")]}
          allSelected={allSelected}
          disabled={false}
          recordedElsewhere={() => undefined}
          onToggle={() => undefined}
          onSlot={() => undefined}
          onOpenPlan={() => undefined}
        />,
      );

    it("counts a characteristic recorded in another section, as the Plan section's card does", () => {
      renderWith([LIMITING("6"), LOCATION_ELSEWHERE]);
      expect(screen.getByText(/3 of 7 characteristics documented/)).toBeTruthy();
      expect(
        within(
          screen.getByRole("list", { name: "Characteristics of a comprehensive pain assessment" }),
        ).getByText("Location: documented"),
      ).toBeTruthy();
    });

    it("raises the plan-of-care reasons from a goal recorded in another section", () => {
      renderWith([LIMITING("6"), GOAL_ELSEWHERE]);
      const prompt = screen.getByRole("region", { name: "Consider a plan-of-care review" });
      expect(
        within(prompt).getByText(/above the patient's own acceptable level of 3/),
      ).toBeTruthy();
    });

    it("reads only its own section when it is given nothing wider", () => {
      renderWith();
      expect(screen.getByText(/2 of 7 characteristics documented/)).toBeTruthy();
      const prompt = screen.getByRole("region", { name: "Consider a plan-of-care review" });
      expect(within(prompt).queryByText(/above the patient's own acceptable level/)).toBeNull();
    });
  });

  it("records a characteristic as the clinician types it and takes it back when it is cleared", async () => {
    const user = userEvent.setup();
    const seen: (readonly DraftEntry[])[] = [];
    render(<Harness onChange={(entries) => seen.push(entries)} />);

    await user.type(screen.getByLabelText("Location"), "right hip");
    expect(screen.getByText(/3 of 7 characteristics documented/)).toBeTruthy();
    expect(seen.at(-1)).toContainEqual({
      code: C.location,
      params: { pain_location: "right hip" },
    });

    await user.clear(screen.getByLabelText("Location"));
    expect(screen.getByText(/2 of 7 characteristics documented/)).toBeTruthy();
    expect(seen.at(-1)?.some((e) => e.code === C.location)).toBe(false);
  });

  it("counts 'what relieves or worsens it' once and says when the CMS admission benchmark of 5 is reached", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByText(/At a routine visit this is a guide, not a requirement/)).toBeTruthy();

    await user.type(screen.getByLabelText("Location"), "lower back");
    await user.type(screen.getByLabelText("Character"), "aching");
    await user.type(screen.getByLabelText("What makes it worse"), "turning");
    await user.type(screen.getByLabelText("What relieves it"), "a warm pack");
    expect(screen.getByText(/5 of 7 characteristics documented/)).toBeTruthy();
    expect(screen.getByText(/reaches the CMS quality measure's 5 of 7/)).toBeTruthy();
  });

  it("takes a chosen response to medication and an observation scale with its score", async () => {
    const user = userEvent.setup();
    const seen: (readonly DraftEntry[])[] = [];
    render(<Harness onChange={(entries) => seen.push(entries)} />);

    await user.selectOptions(
      screen.getByLabelText("Response to the last as-needed dose"),
      "no relief",
    );
    expect(seen.at(-1)).toContainEqual({
      code: C.prnRelief,
      params: { pain_prn_relief: "no relief" },
    });

    await user.selectOptions(screen.getByLabelText("Observation scale"), "PAINAD");
    await user.type(screen.getByLabelText(/Observation scale score/), "5");
    expect(seen.at(-1)).toContainEqual({
      code: C.observationScale,
      params: { observation_tool: "PAINAD", observation_score: "5" },
    });
  });

  it("keeps a two-field statement while either field still holds a value", async () => {
    const user = userEvent.setup();
    const seen: (readonly DraftEntry[])[] = [];
    render(<Harness onChange={(entries) => seen.push(entries)} />);
    await user.selectOptions(screen.getByLabelText("Observation scale"), "FLACC");
    await user.type(screen.getByLabelText(/Observation scale score/), "3");
    await user.clear(screen.getByLabelText(/Observation scale score/));
    expect(seen.at(-1)?.some((e) => e.code === C.observationScale)).toBe(true);
    await user.selectOptions(screen.getByLabelText("Observation scale"), "");
    expect(seen.at(-1)?.some((e) => e.code === C.observationScale)).toBe(false);
  });

  it("says so while a statement of two fields is only half filled", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByText(/Fill in every field here/)).toBeNull();
    await user.selectOptions(screen.getByLabelText("Observation scale"), "PAINAD");
    expect(screen.getByText(/Fill in every field here/)).toBeTruthy();
    await user.type(screen.getByLabelText(/Observation scale score/), "4");
    expect(screen.queryByText(/Fill in every field here/)).toBeNull();
  });

  it("gives two prompts on one page their own heading ids", () => {
    const reasons = painPlanReviewReasons([LIMITING()]);
    render(
      <>
        <PlanReviewPrompt reasons={reasons} />
        <PlanReviewPrompt reasons={reasons} />
      </>,
    );
    const regions = screen.getAllByRole("region", { name: "Consider a plan-of-care review" });
    const ids = regions.map((r) => r.getAttribute("aria-labelledby"));
    expect(new Set(ids).size).toBe(2);
  });

  it("locks every field when the note cannot take a write", () => {
    render(<Harness disabled />);
    expect((screen.getByLabelText("Location") as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByLabelText("Change since the last visit") as HTMLSelectElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Go to Plan of care" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("lists only the statements the section's menu offers", () => {
    render(
      <PainAssessmentHelper
        menu={MENU.filter((e) => e.code !== C.goal && e.code !== C.planDecision)}
        selected={[LIMITING()]}
        disabled={false}
        recordedElsewhere={() => undefined}
        onToggle={() => undefined}
        onSlot={() => undefined}
        onOpenPlan={() => undefined}
      />,
    );
    expect(screen.queryByLabelText("The patient's own acceptable pain level")).toBeNull();
    expect(screen.queryByLabelText("Your decision about the plan of care")).toBeNull();
    expect(screen.getByLabelText("Location")).toBeTruthy();
  });

  describe("the plan-of-care prompt", () => {
    it("is there as soon as pain limiting function is picked, and says it is advisory", () => {
      render(<Harness />);
      const prompt = screen.getByRole("region", { name: "Consider a plan-of-care review" });
      expect(within(prompt).getByText(/Pain is limiting function/)).toBeTruthy();
      expect(within(prompt).getByText(/This is a prompt, not a rule/)).toBeTruthy();
      expect(within(prompt).getByText("Clinical guideline")).toBeTruthy();
    });

    it("adds the reasons as the clinician records them, each labelled with its kind", async () => {
      const user = userEvent.setup();
      render(<Harness initial={[LIMITING("8")]} />);
      const prompt = screen.getByRole("region", { name: "Consider a plan-of-care review" });
      expect(within(prompt).getByText(/severe range on the CMS HOPE scale/)).toBeTruthy();
      expect(within(prompt).getByText("CMS guidance")).toBeTruthy();

      await user.type(screen.getByLabelText("The patient's own acceptable pain level"), "3");
      expect(
        within(prompt).getByText(/above the patient's own acceptable level of 3/),
      ).toBeTruthy();
      expect(within(prompt).getByText("Common practice")).toBeTruthy();

      await user.type(screen.getByLabelText("Pain score at the last visit"), "5");
      expect(within(prompt).getByText(/rose 3 points since the last visit/)).toBeTruthy();
      expect(within(prompt).getByText("Research benchmark")).toBeTruthy();

      await user.selectOptions(screen.getByLabelText("Change since the last visit"), "new pain");
      expect(within(prompt).getByText(/new since the last visit/)).toBeTruthy();
      expect(within(prompt).getByText("CMS rule")).toBeTruthy();
    });

    it("names no relief and an oral barrier, and then also points at the level of care", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      const prompt = screen.getByRole("region", { name: "Consider a plan-of-care review" });
      expect(within(prompt).queryByText(/continuous home care/)).toBeNull();

      await user.selectOptions(
        screen.getByLabelText("Response to the last as-needed dose"),
        "no relief",
      );
      await user.type(
        screen.getByLabelText("Cannot take oral pain medicine: why"),
        "cannot swallow",
      );
      expect(within(prompt).getByText(/The last as-needed dose gave no relief/)).toBeTruthy();
      expect(within(prompt).getByText(/cannot take oral pain medicine/)).toBeTruthy();
      expect(within(prompt).getByText(/continuous home care for a brief crisis/)).toBeTruthy();
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

    it("records the clinician's decision as a choice", async () => {
      const user = userEvent.setup();
      const seen: (readonly DraftEntry[])[] = [];
      render(<Harness onChange={(entries) => seen.push(entries)} />);
      await user.selectOptions(
        screen.getByLabelText("Your decision about the plan of care"),
        "physician notified",
      );
      expect(seen.at(-1)).toContainEqual({
        code: C.planDecision,
        params: { pain_plan_decision: "physician notified" },
      });
    });
  });
});

describe("PlanReviewPrompt on its own (the Plan section)", () => {
  it("renders nothing when there is no reason", () => {
    const { container } = render(<PlanReviewPrompt reasons={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("offers no button where the clinician is already in the Plan of care step", () => {
    const reasons = painPlanReviewReasons([LIMITING()]);
    render(<PlanReviewPrompt reasons={reasons} />);
    expect(screen.queryByRole("button", { name: "Go to Plan of care" })).toBeNull();
  });

  it("lists the sources, the 15-day cadence and the HOPE follow-up behind a disclosure", () => {
    render(<PlanReviewPrompt reasons={painPlanReviewReasons([LIMITING()])} />);
    expect(screen.getByText("Where these prompts come from")).toBeTruthy();
    expect(screen.getByText(/at least every 15 calendar days/)).toBeTruthy();
    expect(screen.getByText(/within 2 calendar days/)).toBeTruthy();
  });
});

describe("showsPainHelper", () => {
  it("shows once a pain statement or a helper statement is picked, and only where the section offers the pain statement", () => {
    expect(showsPainHelper(MENU, [])).toBe(false);
    expect(showsPainHelper(MENU, [LIMITING()])).toBe(true);
    expect(showsPainHelper(MENU, [{ code: "nv.sym.pain_controlled", params: {} }])).toBe(true);
    expect(showsPainHelper(MENU, [{ code: C.location, params: { pain_location: "hip" } }])).toBe(
      true,
    );
    expect(showsPainHelper(MENU.slice(1), [LIMITING()])).toBe(false);
  });
});
