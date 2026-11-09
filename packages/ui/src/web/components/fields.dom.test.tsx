// @vitest-environment jsdom
// The kit's fields (TextField, SelectField, TextAreaField): the control's accessible name is its label alone. The hint and
// the error are tied to the control with aria-describedby, so they must not also sit inside the <label> (where they would be
// read as part of the name AND again as the description).
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { SelectField, TextAreaField, TextField } from "./fields";

afterEach(cleanup);

const describedBy = (control: HTMLElement): HTMLElement[] =>
  (control.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id) as HTMLElement);

describe("field label, hint and error", () => {
  it("names a control by its label alone when a hint is shown, and describes it by the hint", () => {
    render(<TextField label="Email" required hint="We never share it" />);
    const control = screen.getByRole("textbox", { name: "Email" });
    const [hint] = describedBy(control);
    expect(hint?.textContent).toBe("We never share it");
    expect(hint?.closest("label")).toBeNull();
    expect(control.closest("label")).toBeNull();
  });

  it("names a control by its label alone when an error is shown, and describes it by the error", () => {
    render(<TextField label="Email" error="Enter an email" />);
    const control = screen.getByRole("textbox", { name: "Email" });
    expect(control.getAttribute("aria-invalid")).toBe("true");
    const [error] = describedBy(control);
    expect(error?.textContent).toBe("Enter an email");
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.closest("label")).toBeNull();
  });

  it("an error shows alongside the hint: both are on screen and in the description, hint first", () => {
    render(
      <TextAreaField label="Notes" hint="Do not include patient information." error="Too long" />,
    );
    const control = screen.getByRole("textbox", { name: "Notes" });
    expect(describedBy(control).map((el) => el.textContent)).toEqual([
      "Do not include patient information.",
      "Too long",
    ]);
    expect(screen.getByText("Do not include patient information.")).toBeTruthy();
  });

  it("keeps a caller-supplied aria-describedby after the kit's own ids instead of overwriting it", () => {
    render(
      <>
        <p id="extra-note">Extra note</p>
        <TextField label="Email" hint="Hint" error="Error" aria-describedby="extra-note" />
        <SelectField
          label="Kind"
          aria-describedby="extra-note"
          options={[{ value: "a", label: "A" }]}
        />
      </>,
    );
    const email = screen.getByRole("textbox", { name: "Email" });
    expect(describedBy(email).map((el) => el.textContent)).toEqual(["Hint", "Error", "Extra note"]);
    const kind = screen.getByRole("combobox", { name: "Kind" });
    expect(describedBy(kind).map((el) => el.textContent)).toEqual(["Extra note"]);
  });

  it("keeps the label bound to the control: clicking it focuses the control, and the required asterisk is not in the name", async () => {
    render(<SelectField label="Kind" required options={[{ value: "a", label: "A" }]} />);
    const control = screen.getByRole("combobox", { name: "Kind" });
    const label = document.querySelector("label") as HTMLLabelElement;
    expect(label.htmlFor).toBe(control.id);
    expect(label.textContent).toContain("*");
    expect(document.activeElement).not.toBe(control);
    await userEvent.setup().click(label);
    expect(document.activeElement).toBe(control);
  });

  it("lays the label, control, hint and error out as one column under a .wx-field root", () => {
    render(<TextField label="Email" hint="We never share it" />);
    const root = document.querySelector(".wx-field") as HTMLElement;
    expect(root.style.flexDirection).toBe("column");
    expect(Array.from(root.children).map((el) => el.tagName)).toEqual(["LABEL", "INPUT", "SPAN"]);
  });
});
