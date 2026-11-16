// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { type JSX, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AmendmentDialog, type AmendmentKind } from "../hope-amendment-dialog";
import type { SfvAuthorDiscipline } from "../hope-api";

// Amending a signed record (a correction draft, or a CMS inactivation draft) needs a reason and the discipline the
// clinician records it as, and is not something to do by accident.

const RN: readonly SfvAuthorDiscipline[] = ["RN"];
const RN_NP: readonly SfvAuthorDiscipline[] = ["RN", "NP"];

function renderAmendment(
  options: {
    kind?: AmendmentKind;
    busy?: boolean;
    error?: string | null;
    disciplines?: readonly SfvAuthorDiscipline[];
  } = {},
) {
  const onCancel = vi.fn();
  const onSubmit = vi.fn();
  const view = render(
    <AmendmentDialog
      kind={options.kind ?? "inactivation"}
      busy={options.busy ?? false}
      error={options.error ?? null}
      recordLabel="Admission"
      disciplines={options.disciplines ?? RN}
      onCancel={onCancel}
      onSubmit={onSubmit}
    />,
  );
  const name = options.kind === "correction" ? "Correct Admission" : "Inactivate Admission";
  return { ...view, onCancel, onSubmit, dialog: screen.getByRole("dialog", { name }) };
}

const submitButton = (dialog: HTMLElement, name = "Create inactivation") =>
  within(dialog).getByRole("button", { name }) as HTMLButtonElement;
const typeReason = (dialog: HTMLElement, value: string) =>
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason" }), { target: { value } });

describe("AmendmentDialog", () => {
  it("puts focus on the reason when it opens", () => {
    const { dialog } = renderAmendment();
    expect(document.activeElement).toBe(within(dialog).getByRole("textbox", { name: "Reason" }));
  });

  it("cannot create an inactivation without a reason, and sends the trimmed reason with the discipline", () => {
    const { dialog, onSubmit } = renderAmendment();
    expect(submitButton(dialog).disabled).toBe(true);
    typeReason(dialog, "   ");
    expect(submitButton(dialog).disabled).toBe(true);
    typeReason(dialog, "  Entered on the wrong patient  ");
    fireEvent.click(submitButton(dialog));
    expect(onSubmit).toHaveBeenCalledWith("Entered on the wrong patient", "RN");
  });

  it("is the same ceremony for a correction, under its own words", () => {
    const { dialog, onSubmit } = renderAmendment({ kind: "correction" });
    typeReason(dialog, "The date was wrong");
    fireEvent.click(submitButton(dialog, "Create correction draft"));
    expect(onSubmit).toHaveBeenCalledWith("The date was wrong", "RN");
  });

  it("makes a caller with two disciplines choose one before it can submit", () => {
    const { dialog, onSubmit } = renderAmendment({ disciplines: RN_NP });
    typeReason(dialog, "Wrong patient");
    expect(submitButton(dialog).disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Author discipline" }), {
      target: { value: "NP" },
    });
    expect(submitButton(dialog).disabled).toBe(false);
    fireEvent.click(submitButton(dialog));
    expect(onSubmit).toHaveBeenCalledWith("Wrong patient", "NP");
  });

  it("blocks the write, and says why, when none of the caller's roles may author it", () => {
    const { dialog, onSubmit } = renderAmendment({ disciplines: [] });
    typeReason(dialog, "Wrong patient");
    expect(within(dialog).queryByRole("combobox")).toBeNull();
    expect(dialog.textContent).toContain("Your role cannot author an inactivation");
    expect(submitButton(dialog).disabled).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("is cancelled by Cancel and by Escape, but not by the backdrop (a typed reason is not lost to a stray click)", () => {
    const { dialog, onCancel } = renderAmendment();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
    for (const scrim of screen.getAllByRole("button", { name: "Close" })) fireEvent.click(scrim);
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("shows why the last attempt failed in an alert inside the dialog, and Cancel and Escape still work", () => {
    const { dialog, onCancel } = renderAmendment({
      error: "An inactivation is already in progress.",
    });
    expect(within(dialog).getByRole("alert").textContent).toBe(
      "An inactivation is already in progress.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("ignores Escape while the request is out", () => {
    const { dialog, onCancel } = renderAmendment({ busy: true });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    expect(
      (within(dialog).getByRole("button", { name: "Creating..." }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("AmendmentDialog focus after a failure", () => {
  /** The screen's part: busy while the request is out, then the refusal arrives. */
  function Attempt(props: { failure: string }): JSX.Element {
    const [state, setState] = useState<{ busy: boolean; error: string | null }>({
      busy: false,
      error: null,
    });
    return (
      <AmendmentDialog
        kind="inactivation"
        busy={state.busy}
        error={state.error}
        recordLabel="Admission"
        disciplines={RN}
        onCancel={() => undefined}
        onSubmit={() => {
          setState({ busy: true, error: null });
          setTimeout(() => setState({ busy: false, error: props.failure }), 0);
        }}
      />
    );
  }

  it("moves focus to the refusal, so Escape and Tab keep working inside the dialog, each time it fails", async () => {
    render(<Attempt failure="The server refused the request." />);
    const dialog = screen.getByRole("dialog", { name: "Inactivate Admission" });
    typeReason(dialog, "Wrong patient");
    for (const attempt of [1, 2]) {
      const button = submitButton(dialog);
      button.focus();
      fireEvent.click(button);
      const alert = await within(dialog).findByRole("alert");
      expect(document.activeElement, `attempt ${attempt}`).toBe(alert);
    }
  });

  it("does not take focus from the reason for an error that was already there when it opened", () => {
    const { dialog } = renderAmendment({ error: "An inactivation is already in progress." });
    expect(document.activeElement).toBe(within(dialog).getByRole("textbox", { name: "Reason" }));
  });
});
