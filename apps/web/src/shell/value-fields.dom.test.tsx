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

// The server refuses a narrative shorter than its floor, counted on TRIMMED text (a CHECK on length(btrim(...))). The
// counter tells the clinician before the round trip, never instead of it, so it must count what the database counts.
describe("TextAreaField minChars counter", () => {
  const counter = () => document.querySelector("output") as HTMLOutputElement | null;

  it("shows no counter when no minimum is given", () => {
    render(<TextAreaField label="Narrative" value="abc" onChange={() => {}} />);
    expect(counter()).toBeNull();
  });

  it("says how many characters are still owed, in the singular and the plural", () => {
    const { rerender } = render(
      <TextAreaField label="Narrative" value="abc" onChange={() => {}} minChars={10} />,
    );
    expect(counter()?.textContent).toBe(
      "7 more characters required — the server asks for at least 10.",
    );
    rerender(
      <TextAreaField label="Narrative" value="abcdefghi" onChange={() => {}} minChars={10} />,
    );
    expect(counter()?.textContent).toBe(
      "1 more character required — the server asks for at least 10.",
    );
  });

  it("counts trimmed characters, as the database does", () => {
    render(
      <TextAreaField label="Narrative" value="      ab      " onChange={() => {}} minChars={5} />,
    );
    expect(counter()?.textContent).toBe(
      "3 more characters required — the server asks for at least 5.",
    );
  });

  it("confirms once the minimum is met", () => {
    render(<TextAreaField label="Narrative" value="abcde" onChange={() => {}} minChars={5} />);
    expect(counter()?.textContent).toBe("Minimum of 5 characters met.");
  });

  it("announces politely and describes the textarea, after its hint", () => {
    render(
      <TextAreaField label="Narrative" value="" onChange={() => {}} minChars={5} hint="Be brief" />,
    );
    const out = counter() as HTMLOutputElement;
    expect(out.getAttribute("aria-live")).toBe("polite");
    const described = (
      screen.getByLabelText("Narrative").getAttribute("aria-describedby") ?? ""
    ).split(" ");
    expect(described).toHaveLength(2);
    expect(document.getElementById(described[0] as string)?.textContent).toBe("Be brief");
    expect(described[1]).toBe(out.id);
  });
});
