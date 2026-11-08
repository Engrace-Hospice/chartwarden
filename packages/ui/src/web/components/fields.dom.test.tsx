// @vitest-environment jsdom
// The kit's fields (TextField, SelectField, TextAreaField): the control's accessible name is its label alone. The hint and
// the error are tied to the control with aria-describedby, so they must not also sit inside the <label> (where they would be
// read as part of the name AND again as the description).
import { cleanup, render, screen } from "@testing-library/react";
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

  it("an error replaces the hint, in the description as on screen", () => {
    render(<TextAreaField label="Notes" hint="Plain text" error="Too long" />);
    const control = screen.getByRole("textbox", { name: "Notes" });
    expect(describedBy(control).map((el) => el.textContent)).toEqual(["Too long"]);
    expect(screen.queryByText("Plain text")).toBeNull();
  });

  it("keeps the label bound to the control: clicking it focuses the control, and the required asterisk is not in the name", () => {
    render(<SelectField label="Kind" required options={[{ value: "a", label: "A" }]} />);
    const control = screen.getByRole("combobox", { name: "Kind" });
    const label = document.querySelector("label") as HTMLLabelElement;
    expect(label.htmlFor).toBe(control.id);
    expect(label.textContent).toContain("*");
  });

  it("lays the label, control, hint and error out as one column under a .wx-field root", () => {
    render(<TextField label="Email" hint="We never share it" />);
    const root = document.querySelector(".wx-field") as HTMLElement;
    expect(root.style.flexDirection).toBe("column");
    expect(Array.from(root.children).map((el) => el.tagName)).toEqual(["LABEL", "INPUT", "SPAN"]);
  });
});
