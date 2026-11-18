// @vitest-environment jsdom
// The module screens hold their form state as strings and pass `onChange(value)`; these adapters put the kit's
// accessible fields (label, hint, error wiring) behind that call shape so a screen does not unwrap events itself.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelectField, TextAreaField, TextField } from "./value-fields";

afterEach(cleanup);

describe("TextField", () => {
  it("is named by its label and reports the typed text as a string", () => {
    const onChange = vi.fn();
    render(<TextField label="Reason" value="" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "family request" } });
    expect(onChange).toHaveBeenCalledWith("family request");
  });

  it("passes type and placeholder to the input", () => {
    render(
      <TextField label="Starts" value="" onChange={() => {}} type="date" placeholder="pick" />,
    );
    const input = screen.getByLabelText("Starts");
    expect(input.getAttribute("type")).toBe("date");
    expect(input.getAttribute("placeholder")).toBe("pick");
  });

  it("describes the input with the hint and then the caller's own description", () => {
    render(
      <>
        <p id="outside">Shown to the signer</p>
        <TextField
          label="Note"
          value=""
          onChange={() => {}}
          hint="Be brief"
          describedBy="outside"
        />
      </>,
    );
    const input = screen.getByLabelText("Note");
    const described = (input.getAttribute("aria-describedby") ?? "").split(" ");
    expect(described).toHaveLength(2);
    expect(document.getElementById(described[0] as string)?.textContent).toBe("Be brief");
    expect(described[1]).toBe("outside");
  });

  it("sets identifiers in the mono face when mono is given, and not otherwise", () => {
    render(
      <>
        <TextField label="Call id" value="" onChange={() => {}} mono />
        <TextField label="Note" value="" onChange={() => {}} />
      </>,
    );
    expect(screen.getByLabelText("Call id").getAttribute("style")).toContain("font-mono");
    expect(screen.getByLabelText("Note").getAttribute("style") ?? "").not.toContain("font-mono");
  });

  it("limits the typed length when maxLength is given", () => {
    render(<TextField label="Code" value="" onChange={() => {}} maxLength={8} />);
    expect(screen.getByLabelText("Code").getAttribute("maxlength")).toBe("8");
  });
});

describe("SelectField", () => {
  const options = [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Bravo" },
  ];

  it("lists its options under the label and reports the chosen value", () => {
    const onChange = vi.fn();
    render(<SelectField label="Kind" value="a" options={options} onChange={onChange} />);
    const select = screen.getByLabelText("Kind") as HTMLSelectElement;
    expect(select.value).toBe("a");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Alpha", "Bravo"]);
    fireEvent.change(select, { target: { value: "b" } });
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("can be disabled while a write is in flight", () => {
    render(<SelectField label="Kind" value="a" options={options} onChange={() => {}} disabled />);
    expect((screen.getByLabelText("Kind") as HTMLSelectElement).disabled).toBe(true);
  });
});

describe("TextAreaField", () => {
  it("honours rows, shows its hint and reports the text as a string", () => {
    const onChange = vi.fn();
    render(
      <TextAreaField
        label="Narrative"
        value=""
        onChange={onChange}
        rows={6}
        hint="No PHI beyond the chart"
      />,
    );
    const area = screen.getByLabelText("Narrative");
    expect(area.getAttribute("rows")).toBe("6");
    expect(screen.getByText("No PHI beyond the chart")).toBeTruthy();
    fireEvent.change(area, { target: { value: "stable overnight" } });
    expect(onChange).toHaveBeenCalledWith("stable overnight");
  });

  it("defaults to four rows, as the modules' own fields did", () => {
    render(<TextAreaField label="Narrative" value="" onChange={() => {}} />);
    expect(screen.getByLabelText("Narrative").getAttribute("rows")).toBe("4");
  });
});
