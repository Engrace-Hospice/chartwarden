// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SfvAnswersSection, choicesFor } from "../hope-sfv-answers";
import { useStubbedLocalStorage } from "./workspace-test-kit";

// The J2053 questions of the SFV completion dialog. Guided mode shows one question at a time and moves on a moment
// after an answer; that move must not strand keyboard or screen-reader users.

const QUESTIONS = [
  { itemCode: "J2053A", label: "Impact of pain" },
  { itemCode: "J2053B", label: "Impact of shortness of breath" },
  { itemCode: "J2053C", label: "Impact of anxiety" },
] as const;

/** The section with real answer state, as the dialog holds it. */
function Harness(): JSX.Element {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return (
    <SfvAnswersSection
      questions={QUESTIONS}
      answers={answers}
      answeredCount={Object.keys(answers).length}
      onAnswer={(code, value) => setAnswers((previous) => ({ ...previous, [code]: value }))}
      disabled={false}
    />
  );
}

const questionGroup = (code: string) => screen.getByRole("group", { name: new RegExp(code) });
const stepStatus = () => screen.getByRole("status");

describe("SfvAnswersSection", () => {
  useStubbedLocalStorage();
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("guided mode moves on after an answer", () => {
    it("puts focus on the new question (its fieldset, named by the question), which it just replaced the focused one with", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      await user.click(within(questionGroup("J2053A")).getByRole("radio", { name: "Slight" }));
      expect(document.activeElement).toBe(
        within(questionGroup("J2053A")).getByRole("radio", { name: "Slight" }),
      );

      await waitFor(() => expect(screen.getByText("Impact of shortness of breath")).toBeTruthy());
      const next = questionGroup("J2053B");
      await waitFor(() => expect(next.contains(document.activeElement)).toBe(true));
      // Not on its first radio: an Enter pressed from there would choose the first answer for a question nobody has read.
      expect(document.activeElement).toBe(next);
    });

    const focusRadio = (code: string, name: string) => {
      const radio = within(questionGroup(code)).getByRole("radio", { name });
      act(() => radio.focus());
      return radio;
    };

    it("keeps keyboard flow sane: confirm with Space, land in the next question, Tab enters its choices and then leaves the radio group forwards", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      focusRadio("J2053A", "Not at all");
      await user.keyboard(" ");
      await waitFor(() =>
        expect(questionGroup("J2053B").contains(document.activeElement)).toBe(true),
      );

      await user.tab();
      expect(document.activeElement).toBe(
        within(questionGroup("J2053B")).getByRole("radio", { name: "Not at all" }),
      );
      await user.tab();
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: /Previous question/ }),
      );
    });

    it("does not let Enter, pressed to get through the form, choose an answer for a question nobody has answered", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      focusRadio("J2053A", "Slight");
      await user.keyboard("{Enter}");
      await waitFor(() => expect(screen.getByText("Question 2 of 3")).toBeTruthy());
      await waitFor(() =>
        expect(questionGroup("J2053B").contains(document.activeElement)).toBe(true),
      );

      await user.keyboard("{Enter}{Enter}{Enter}");
      await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
      expect(screen.getByText("Question 2 of 3")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "J2053B — answered" })).toBeNull();
      expect(screen.queryByRole("button", { name: "J2053C — answered" })).toBeNull();
      for (const radio of within(questionGroup("J2053B")).getAllByRole("radio"))
        expect((radio as HTMLInputElement).checked).toBe(false);
    });

    it("also moves on when the answer is confirmed with Enter", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      focusRadio("J2053A", "Slight");
      await user.keyboard("{Enter}");
      await waitFor(() =>
        expect(questionGroup("J2053B").contains(document.activeElement)).toBe(true),
      );
      // Enter chose it, not just moved on: the step bar shows the first question answered.
      expect(screen.getByRole("button", { name: "J2053A — answered" })).toBeTruthy();
    });

    it("does not move on from an arrow key: moving through the choices is not choosing one", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      focusRadio("J2053A", "Not at all");
      await user.keyboard("{ArrowDown}");
      const mild = within(questionGroup("J2053A")).getByRole("radio", {
        name: "Slight",
      }) as HTMLInputElement;
      expect(mild.checked).toBe(true);
      await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
      expect(screen.getByText("Question 1 of 3")).toBeTruthy();
      expect(document.activeElement).toBe(mild);

      await user.keyboard("{ArrowDown}{ArrowDown}");
      await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
      expect(screen.getByText("Question 1 of 3")).toBeTruthy();
      // Next stays available for the clinician who has settled on an answer.
      await user.click(screen.getByRole("button", { name: /Next question/ }));
      expect(screen.getByText("Question 2 of 3")).toBeTruthy();
    });

    it("still moves on after a pointer click following arrow keys (the arrow does not stick)", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      focusRadio("J2053A", "Not at all");
      await user.keyboard("{ArrowDown}");
      await user.click(within(questionGroup("J2053A")).getByRole("radio", { name: "Moderate" }));
      await waitFor(() => expect(screen.getByText("Question 2 of 3")).toBeTruthy());
    });

    it("lands on the answer already chosen, not the first choice, when the question was answered before", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      await user.click(screen.getByRole("button", { name: "J2053B" }));
      await user.click(within(questionGroup("J2053B")).getByRole("radio", { name: "Moderate" }));
      await user.click(screen.getByRole("button", { name: "J2053A" }));
      await user.click(within(questionGroup("J2053A")).getByRole("radio", { name: "Slight" }));

      await waitFor(() => expect(screen.getByText("Question 2 of 3")).toBeTruthy());
      await waitFor(() =>
        expect(document.activeElement).toBe(
          within(questionGroup("J2053B")).getByRole("radio", { name: "Moderate" }),
        ),
      );
    });

    it("announces a step taken with a button through one status region that stays mounted", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      const region = stepStatus();
      expect(region.textContent).toContain("Question 1 of 3");
      await user.click(screen.getByRole("button", { name: /Next question/ }));
      expect(region.textContent).toContain("Question 2 of 3: Impact of shortness of breath");
      expect(stepStatus()).toBe(region);
    });

    it("announces a question again when a button takes the clinician back to one focus once moved to (Previous, then Next)", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      const region = stepStatus();
      await user.click(within(questionGroup("J2053A")).getByRole("radio", { name: "Slight" }));
      await waitFor(() =>
        expect(questionGroup("J2053B").contains(document.activeElement)).toBe(true),
      );
      expect(region.textContent).toBe("");

      await user.click(screen.getByRole("button", { name: /Previous question/ }));
      await user.click(screen.getByRole("button", { name: /Next question/ }));
      // Back on question 2 by a button: focus is on that button, so the region has to say what the question is.
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /Next question/ }));
      expect(region.textContent).toBe("Question 2 of 3: Impact of shortness of breath");
    });

    it("does not announce a move that moved focus to the new question too: focus says it, the region stays quiet", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      const region = stepStatus();
      await user.click(within(questionGroup("J2053A")).getByRole("radio", { name: "Slight" }));
      await waitFor(() =>
        expect(questionGroup("J2053B").contains(document.activeElement)).toBe(true),
      );
      expect(region.textContent).toBe("");
      // The visible counter still reads the step.
      expect(screen.getByText("Question 2 of 3")).toBeTruthy();
    });
  });

  describe("the pause before moving on", () => {
    it("is not overridden by a later answer-timer when the clinician steps with Next", () => {
      vi.useFakeTimers();
      render(<Harness />);
      fireEvent.click(within(questionGroup("J2053A")).getByRole("radio", { name: "Slight" }));
      fireEvent.click(screen.getByRole("button", { name: /Next question/ }));
      fireEvent.click(screen.getByRole("button", { name: /Next question/ }));
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.getByText("Question 3 of 3")).toBeTruthy();
    });

    it("is not overridden by a later answer-timer when the clinician picks a step directly", () => {
      vi.useFakeTimers();
      render(<Harness />);
      fireEvent.click(within(questionGroup("J2053A")).getByRole("radio", { name: "Slight" }));
      fireEvent.click(screen.getByRole("button", { name: "J2053C" }));
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.getByText("Question 3 of 3")).toBeTruthy();
    });

    it("is dropped when the section goes away, so nothing fires afterwards", () => {
      vi.useFakeTimers();
      const { unmount } = render(<Harness />);
      fireEvent.click(within(questionGroup("J2053A")).getByRole("radio", { name: "Slight" }));
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("the Show all switch", () => {
    it("is local to the dialog: it never rewrites the workspace's navigation preference", () => {
      render(<Harness />);
      fireEvent.click(screen.getByRole("checkbox", { name: /Show all/ }));
      expect(screen.getByText("Impact of anxiety")).toBeTruthy();
      expect(localStorage.getItem("wx.hope.navMode")).toBeNull();
    });

    it("is a native checkbox that reports its state once, without a second ARIA state", () => {
      render(<Harness />);
      const toggle = screen.getByRole("checkbox", { name: /Show all/ }) as HTMLInputElement;
      expect(toggle.hasAttribute("aria-checked")).toBe(false);
      fireEvent.click(toggle);
      expect(toggle.checked).toBe(true);
    });
  });
});

describe("the choices a J2053 question offers", () => {
  useStubbedLocalStorage();

  it("offers CMS's 'Not applicable' (9) beside the four impact levels, and records it as 9", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(
      <SfvAnswersSection
        questions={QUESTIONS}
        answers={{}}
        answeredCount={0}
        onAnswer={onAnswer}
        disabled={false}
      />,
    );
    const group = questionGroup("J2053A");
    expect(
      within(group)
        .getAllByRole("radio")
        .map((r) => (r as HTMLInputElement).value),
    ).toEqual(["0", "1", "2", "3", "9"]);
    await user.click(within(group).getByRole("radio", { name: "Not applicable" }));
    expect(onAnswer).toHaveBeenCalledWith("J2053A", "9");
  });

  it("builds them from the item's own CMS options, in their order, never offering the skip-pattern blank", () => {
    const choices = choicesFor({
      itemCode: "J2053A",
      label: "Impact of pain",
      options: [
        { valueCode: "^", label: "Blank (skip pattern)", sortOrder: 6 },
        {
          valueCode: "9",
          label: "Not applicable (the patient is not experiencing the symptom)",
          sortOrder: 5,
        },
        { valueCode: "1", label: "Slight", sortOrder: 2 },
        { valueCode: "0", label: "Not at all - symptom does not affect the patient", sortOrder: 1 },
      ],
    });
    expect(choices.map((c) => c.value)).toEqual(["0", "1", "9"]);
    expect(choices[0]?.label).toBe("Not at all - symptom does not affect the patient");
  });

  it.each([
    ["no options", undefined],
    ["only the skip-pattern blank", [{ valueCode: "^", label: "Blank (skip pattern)" }]],
  ])("falls back to the J2053 set for an item with %s", (_name, options) => {
    const choices = choicesFor({ itemCode: "J2053A", label: "Impact of pain", options });
    expect(choices.map((c) => c.value)).toEqual(["0", "1", "2", "3", "9"]);
  });
});
