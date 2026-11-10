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
import userEvent from "@testing-library/user-event";
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

describe("EntityLookupField name and description", () => {
  const renderWithMessages = () => {
    const loadOptions = vi.fn(async () => ({ options: OPTIONS, nextCursor: null }));
    render(
      <EntityLookupField
        label="Patient"
        required
        value={OPTIONS[0]?.id as string}
        valueLabel="Whitfield, Eleanor"
        onChange={vi.fn()}
        loadOptions={loadOptions}
        hint="Search by name"
        error="Choose a patient"
      />,
    );
  };
  const describedText = (control: HTMLElement): string[] =>
    (control.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? "");

  it("is named by its label alone, not by the error, the hint, the Clear button or the option text", async () => {
    renderWithMessages();
    await act(async () => {
      fireEvent.focus(screen.getByRole("combobox"));
    });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    // `getByRole(name)` matches the computed accessible name exactly, so any leaked text would fail to find it.
    const input = screen.getByRole("combobox", { name: "Patient" });
    expect(input.closest("label")).toBeNull();
    expect(screen.getByText("Patient").closest("label")?.getAttribute("for")).toBe(input.id);
  });

  it("is described by the hint then the error, both outside the label", () => {
    renderWithMessages();
    const input = screen.getByRole("combobox", { name: "Patient" });
    expect(describedText(input)).toEqual(["Search by name", "Choose a patient"]);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    for (const id of (input.getAttribute("aria-describedby") ?? "").split(" ")) {
      expect(document.getElementById(id)?.closest("label")).toBeNull();
    }
  });

  it("clicking the label focuses the combobox", async () => {
    renderWithMessages();
    const user = userEvent.setup();
    await user.click(screen.getByText("Patient"));
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Patient" }));
  });

  it("keeps the combobox wiring while open: aria-controls names the listbox and activedescendant names the active option", async () => {
    renderWithMessages();
    const input = screen.getByRole("combobox", { name: "Patient" });
    fireEvent.focus(input);
    await screen.findAllByRole("option");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const listbox = screen.getByRole("listbox");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-controls")).toBe(listbox.id);
    expect(input.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[0]?.id);
    expect(listbox.getAttribute("aria-labelledby")).toBe(
      document.querySelector("label")?.getAttribute("id"),
    );
  });
});

describe("EntityLookupField paging by keyboard", () => {
  const THIRD = {
    id: "33333333-3333-3333-3333-333333333333",
    label: "Adeyemi, Ruth",
    searchLabel: "Adeyemi, Ruth",
  };
  const CLOSE_DELAY_MS = 120;

  function renderPaged() {
    const loadOptions = vi.fn(async ({ cursor }: { cursor: string | null }) =>
      cursor ? { options: [THIRD], nextCursor: null } : { options: OPTIONS, nextCursor: "page-2" },
    );
    render(
      <>
        <EntityLookupField label="Patient" value="" onChange={vi.fn()} loadOptions={loadOptions} />
        <button type="button">after</button>
      </>,
    );
    return { loadOptions };
  }
  const openPopup = async (user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> => {
    await user.click(screen.getByRole("combobox"));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    return screen.getByRole("button", { name: "Load more" });
  };
  const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it("Tab from the input reaches Load more and the popup stays open under the keyboard user", async () => {
    const user = userEvent.setup();
    renderPaged();
    const more = await openPopup(user);
    await user.tab();
    expect(document.activeElement).toBe(more);
    // Longer than the close delay that used to unmount the button from under the focus.
    await pause(CLOSE_DELAY_MS * 2);
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.getByRole("combobox").getAttribute("aria-expanded")).toBe("true");
  });

  it("activating Load more from the keyboard appends the page and returns focus to the input once the button is gone", async () => {
    const user = userEvent.setup();
    const { loadOptions } = renderPaged();
    await openPopup(user);
    await user.tab();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
    expect(loadOptions).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "page-2" }));
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox")));
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("Escape on Load more closes the popup and puts focus back in the input", async () => {
    const user = userEvent.setup();
    renderPaged();
    await openPopup(user);
    await user.tab();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("combobox"));
  });

  it("still closes when focus moves on past the popup", async () => {
    const user = userEvent.setup();
    renderPaged();
    await openPopup(user);
    await user.tab(); // Load more
    await user.tab(); // the control after the field
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "after" }));
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });

  it("keeps the arrow-key combobox semantics: ArrowDown still moves through the options", async () => {
    const user = userEvent.setup();
    renderPaged();
    await openPopup(user);
    await user.keyboard("{ArrowDown}");
    const input = screen.getByRole("combobox");
    expect(input.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[0]?.id);
  });

  it("keeps the list open and on page 1+2 while a slow page loads: Load more keeps focus (aria-disabled, never disabled) and is not re-pressable", async () => {
    // Only the timers are faked (user-event and Testing Library wait on real ones): focus is moved with focus(), activation with a click.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const SLOW_PAGE_MS = 600;
      const advance = (ms: number): Promise<void> =>
        act(async () => {
          await vi.advanceTimersByTimeAsync(ms);
        });
      const loadOptions = vi.fn(
        ({ cursor }: { cursor: string | null }) =>
          new Promise<{ options: typeof OPTIONS; nextCursor: string | null }>((resolve) => {
            setTimeout(
              () =>
                resolve(
                  cursor
                    ? { options: [THIRD], nextCursor: "page-3" }
                    : { options: OPTIONS, nextCursor: "page-2" },
                ),
              cursor ? SLOW_PAGE_MS : 0,
            );
          }),
      );
      render(
        <EntityLookupField label="Patient" value="" onChange={vi.fn()} loadOptions={loadOptions} />,
      );
      await act(async () => {
        screen.getByRole("combobox").focus();
      });
      await advance(200); // the 180ms debounce, then page 1
      expect(screen.getAllByRole("option")).toHaveLength(2);
      const more = screen.getByRole("button", { name: "Load more" });
      await act(async () => {
        more.focus(); // Tab from the input
      });
      expect(document.activeElement).toBe(more);

      fireEvent.click(more);
      // In flight. A browser drops focus from a button that is `disabled`; this one must not be, so focus stays and nothing
      // reports focus leaving (which would arm the popup's close timer).
      expect(more.getAttribute("aria-disabled")).toBe("true");
      expect((more as HTMLButtonElement).disabled).toBe(false);
      expect(document.activeElement).toBe(more);
      // Pressed again while busy: ignored, no second request.
      fireEvent.click(more);
      expect(loadOptions).toHaveBeenCalledTimes(2);

      // Longer than the 120ms close delay, still loading: the list is open and page 1 is untouched.
      await advance(300);
      expect(screen.getByRole("listbox")).toBeTruthy();
      expect(screen.getAllByRole("option")).toHaveLength(2);

      await advance(SLOW_PAGE_MS);
      // The appended page, not a restart at page 1; the button is back to normal and still has focus.
      expect(screen.getAllByRole("option")).toHaveLength(3);
      expect(loadOptions.mock.calls.map(([input]) => input.cursor)).toEqual([null, "page-2"]);
      const again = screen.getByRole("button", { name: "Load more" });
      expect(again.hasAttribute("aria-disabled")).toBe(false);
      expect(document.activeElement).toBe(again);
    } finally {
      vi.useRealTimers();
    }
  });
});
