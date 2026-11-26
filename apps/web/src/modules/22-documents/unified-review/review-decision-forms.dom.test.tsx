import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Candidate } from "../doclens-api";
import { DecisionForms, NO_VALUE_NOTE } from "./review-decision-forms";
import { CANDIDATE_ID, candidateFixture, savedDecision } from "./review-panel-test-kit";

const ACCEPT_REASON = "Reason for accepting despite the page reading";

function forms(
  candidate: Candidate = candidateFixture(CANDIDATE_ID),
  props: { canSubmit?: boolean; busy?: boolean; locked?: boolean; hintId?: string } = {},
) {
  const onSave = vi.fn();
  const view = render(
    <DecisionForms
      candidate={candidate}
      canSubmit={props.canSubmit ?? true}
      busy={props.busy ?? false}
      locked={props.locked ?? false}
      hintId={props.hintId}
      onSave={onSave}
    />,
  );
  return { onSave, ...view };
}

const accept = (): HTMLElement => screen.getByRole("button", { name: "Accept extracted value" });
const disagreed = candidateFixture(CANDIDATE_ID, {
  vision: { status: "disagreed", observedValue: "Salem OR" },
});

describe("DecisionForms accept", () => {
  it("accepts the extracted value as it is", () => {
    const { onSave } = forms();

    fireEvent.click(accept());

    expect(onSave).toHaveBeenCalledWith("approve", {});
  });

  it("is locked when a decision cannot be submitted or one is pending", () => {
    const first = forms(candidateFixture(CANDIDATE_ID), { canSubmit: false });
    expect(accept()).toBeDisabled();
    first.unmount();

    forms(candidateFixture(CANDIDATE_ID), { busy: true });
    expect(accept()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit value" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject extracted value" })).toBeDisabled();
  });

  it("needs a reason of at least five characters to accept over a vision disagreement", () => {
    const { onSave } = forms(disagreed);
    expect(accept()).toBeDisabled();

    fireEvent.change(screen.getByLabelText(ACCEPT_REASON), { target: { value: "no" } });
    expect(accept()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(ACCEPT_REASON), { target: { value: "  smudge  " } });
    fireEvent.click(accept());

    expect(onSave).toHaveBeenCalledWith("approve", { reason: "smudge" });
  });

  it("offers no reason prompt for a disagreement that is already decided", () => {
    forms(disagreed, { locked: true });

    expect(screen.queryByLabelText(ACCEPT_REASON)).toBeNull();
  });

  it("names the field by its label and describes it with the vision reading", () => {
    forms(disagreed);

    const field = screen.getByLabelText(ACCEPT_REASON);

    expect(field).toHaveAccessibleName(ACCEPT_REASON);
    expect(field).toHaveAccessibleDescription(/The vision check read “Salem OR”/);
    expect(field.getAttribute("type")).toBe("text");
    expect(field.getAttribute("autocomplete")).toBe("off");
  });

  it("points the buttons at the hint that says what unlocks them", () => {
    forms(candidateFixture(CANDIDATE_ID), { hintId: "hint-1" });
    const hint = document.createElement("p");
    hint.id = "hint-1";
    hint.textContent = "Compare the source first.";
    document.body.append(hint);

    expect(accept()).toHaveAccessibleDescription("Compare the source first.");
    expect(screen.getByRole("button", { name: "Edit value" })).toHaveAccessibleDescription(
      "Compare the source first.",
    );
    hint.remove();
  });

  it("says what accepting a blank value does", () => {
    forms(candidateFixture(CANDIDATE_ID, { value: " " }));

    expect(screen.getByText(NO_VALUE_NOTE)).toBeTruthy();
    expect(accept()).toHaveAccessibleDescription(NO_VALUE_NOTE);
  });

  it("does not say it when there is a value", () => {
    forms();

    expect(screen.queryByText(NO_VALUE_NOTE)).toBeNull();
  });
});

describe("DecisionForms edit", () => {
  it("opens with the extracted value, trims what is saved, and takes focus", () => {
    const { onSave } = forms();

    fireEvent.click(screen.getByRole("button", { name: "Edit value" }));
    const field = screen.getByLabelText("Corrected value");
    expect(field).toHaveValue("Salem");
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "  Keizer  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save corrected value" }));

    expect(onSave).toHaveBeenCalledWith("approve_with_edit", { editedValue: "Keizer" });
  });

  it("opens with the saved correction when there is one, not a stale value", () => {
    forms(
      candidateFixture(CANDIDATE_ID, { decision: savedDecision("approve_with_edit", "Keizer") }),
      { locked: false },
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit value" }));

    expect(screen.getByLabelText("Corrected value")).toHaveValue("Keizer");
  });

  it("will not save a blank correction", () => {
    const { onSave } = forms();
    fireEvent.click(screen.getByRole("button", { name: "Edit value" }));

    fireEvent.change(screen.getByLabelText("Corrected value"), { target: { value: "   " } });

    expect(screen.getByRole("button", { name: "Save corrected value" })).toBeDisabled();
    fireEvent.submit(screen.getByLabelText("Corrected value").closest("form") as HTMLFormElement);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("is a plain, non-remembered text field", () => {
    forms();
    fireEvent.click(screen.getByRole("button", { name: "Edit value" }));

    const field = screen.getByLabelText("Corrected value");

    expect(field.getAttribute("type")).toBe("text");
    expect(field.getAttribute("autocomplete")).toBe("off");
  });

  it("says Saving while a save is pending", () => {
    const { rerender, onSave } = forms();
    fireEvent.click(screen.getByRole("button", { name: "Edit value" }));

    rerender(
      <DecisionForms
        candidate={candidateFixture(CANDIDATE_ID)}
        canSubmit
        busy
        locked={false}
        onSave={onSave}
      />,
    );

    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  });
});

describe("DecisionForms reject", () => {
  it("rejects without a reason", () => {
    const { onSave } = forms();
    fireEvent.click(screen.getByRole("button", { name: "Reject extracted value" }));

    fireEvent.click(screen.getByRole("button", { name: "Reject extracted value" }));

    expect(onSave).toHaveBeenCalledWith("reject", {});
  });

  it("holds a reason that is entered to at least five characters", () => {
    const { onSave } = forms();
    fireEvent.click(screen.getByRole("button", { name: "Reject extracted value" }));
    const field = screen.getByLabelText(/Rejection reason/);

    fireEvent.change(field, { target: { value: "bad" } });
    expect(screen.getByRole("button", { name: "Reject extracted value" })).toBeDisabled();
    fireEvent.change(field, { target: { value: " not this patient " } });
    fireEvent.click(screen.getByRole("button", { name: "Reject extracted value" }));

    expect(onSave).toHaveBeenCalledWith("reject", { reason: "not this patient" });
  });

  it("keeps the accept reason and the reject reason apart", () => {
    forms(disagreed);
    fireEvent.change(screen.getByLabelText(ACCEPT_REASON), { target: { value: "smudged page" } });

    fireEvent.click(screen.getByRole("button", { name: "Reject extracted value" }));
    expect(screen.getByLabelText(/Rejection reason/)).toHaveValue("");
    fireEvent.change(screen.getByLabelText(/Rejection reason/), {
      target: { value: "wrong page" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByLabelText(ACCEPT_REASON)).toHaveValue("smudged page");
  });

  it("is a plain, non-remembered text field", () => {
    forms();
    fireEvent.click(screen.getByRole("button", { name: "Reject extracted value" }));

    const field = screen.getByLabelText(/Rejection reason/);

    expect(field.getAttribute("type")).toBe("text");
    expect(field.getAttribute("autocomplete")).toBe("off");
  });
});
