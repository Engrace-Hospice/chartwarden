// F-023 (#56) — the ARIA contract of the shared entity lookup.
//
// This component built a combobox out of the right ATTRIBUTES and none of the ROLES: an
// `<input aria-expanded aria-controls>` with no `role="combobox"` (which axe reports as
// `aria-allowed-attr`, critical — and which a screen reader hears as an ordinary text box claiming
// to control an element that announces as nothing), a popup `<span>` with no `role="listbox"`, and
// options that were `<button aria-selected>` with no `role="option"` — an attribute that is not
// valid on a button at all.
//
// It is worth pinning at the component level rather than only through the one E2E page that
// happened to catch it: `apps/web/src/shared/entity-lookups.tsx` wraps this for patients, provider
// entities, admissions and the M40 directory, and roughly fourteen screens across M6, M15, M23 and
// M24 render one. A single page's a11y scan is not the coverage this deserves.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EntityLookupField } from "../entity-lookup-field";

const OPTIONS = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    label: "Whitfield, Eleanor",
    searchLabel: "Whitfield, Eleanor",
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    label: "Okonkwo, Samuel",
    searchLabel: "Okonkwo, Samuel",
  },
];

function renderField(value = "") {
  const onChange = vi.fn();
  const loadOptions = vi.fn(async () => ({ options: OPTIONS, nextCursor: null }));
  render(
    <EntityLookupField
      label="Patient"
      value={value}
      onChange={onChange}
      loadOptions={loadOptions}
    />,
  );
  return { onChange, loadOptions };
}

describe("EntityLookupField ARIA", () => {
  it("declares the combobox role its aria-expanded/aria-controls require", () => {
    renderField();
    const input = screen.getByRole("combobox", { name: /Patient/ });
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
  });

  it("does not point aria-controls at an element that is not rendered", () => {
    renderField();
    // Closed: the popup does not exist, so a dangling reference would be its own defect.
    expect(screen.getByRole("combobox").hasAttribute("aria-controls")).toBe(false);
  });

  it("exposes the popup as a listbox of options, named by the field label", async () => {
    renderField();
    const input = screen.getByRole("combobox", { name: /Patient/ });
    await act(async () => {
      fireEvent.focus(input);
    });

    // The listbox opens with a spinner and fills in when the load resolves — wait for the options,
    // not merely for the popup.
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    const listbox = screen.getByRole("listbox");
    // Named by the field's own label element, so the popup is not an anonymous list.
    const labelId = listbox.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId as string)?.textContent).toContain("Patient");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-controls")).toBe(listbox.id);

    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Whitfield, Eleanor", "Okonkwo, Samuel"]);
    // `aria-selected` is only meaningful — and only legal — because these are options now.
    for (const option of options) expect(option.getAttribute("aria-selected")).toBe("false");
  });

  it("marks the selected option, so the current choice is exposed and not just painted", async () => {
    renderField((OPTIONS[1] as (typeof OPTIONS)[number]).id);
    await act(async () => {
      fireEvent.focus(screen.getByRole("combobox"));
    });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    const [first, second] = screen.getAllByRole("option");
    expect(first?.getAttribute("aria-selected")).toBe("false");
    expect(second?.getAttribute("aria-selected")).toBe("true");
  });

  it("still reports the chosen id to its caller (the roles changed, the behaviour did not)", async () => {
    const { onChange } = renderField();
    await act(async () => {
      fireEvent.focus(screen.getByRole("combobox"));
    });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    await act(async () => {
      fireEvent.click(screen.getAllByRole("option")[0] as HTMLElement);
    });
    const chosen = OPTIONS[0] as (typeof OPTIONS)[number];
    expect(onChange).toHaveBeenCalledWith(chosen.id, expect.objectContaining({ id: chosen.id }));
  });
});

describe("EntityLookupField keyboard (default appearance)", () => {
  it("chooses an option with ArrowDown and Enter, announcing it through aria-activedescendant", async () => {
    const { onChange } = renderField();
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    await screen.findAllByRole("option");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const first = screen.getAllByRole("option")[0];
    expect(input.getAttribute("aria-activedescendant")).toBe(first?.id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(
      OPTIONS[0]?.id,
      expect.objectContaining({ id: OPTIONS[0]?.id }),
    );
  });
});
