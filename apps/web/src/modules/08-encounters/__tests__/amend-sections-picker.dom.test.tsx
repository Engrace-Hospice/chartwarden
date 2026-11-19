// @vitest-environment jsdom
// Choosing the sections of a signed note an addendum amends (ADR-0114 VN-D30): at most twelve, and
// leaving them all unchosen is the free addendum. Synthetic data only.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AmendSectionsPicker } from "../amend-sections-picker";
import type { AmendableSection } from "../signed-note-model";

afterEach(cleanup);

const sections = (n: number): AmendableSection[] =>
  Array.from({ length: n }, (_, i) => ({ sectionId: `section_${i + 1}` }));

function Harness({
  all,
  initial = [],
  onChange = () => {},
}: {
  all: readonly AmendableSection[];
  initial?: readonly string[];
  onChange?: (ids: readonly string[]) => void;
}) {
  const [chosen, setChosen] = useState<readonly string[]>(initial);
  return (
    <AmendSectionsPicker
      sections={all}
      chosen={chosen}
      onChange={(ids) => {
        setChosen(ids);
        onChange(ids);
      }}
    />
  );
}

describe("AmendSectionsPicker", () => {
  it("offers each sealed section, none chosen, and says leaving them is a free addendum", () => {
    render(<Harness all={sections(3)} />);
    const group = screen.getByRole("group", { name: "Amend sections of this note (optional)" });
    expect(group).toHaveAccessibleDescription(/free addendum/);
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    expect(screen.getByRole("checkbox", { name: "Section 2" })).not.toBeChecked();
    expect(screen.getByText("0 of 12 chosen")).toBeInTheDocument();
  });

  it("reports the chosen sections in the order they were chosen, and unchooses", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness all={sections(3)} onChange={onChange} />);
    await user.click(screen.getByRole("checkbox", { name: "Section 3" }));
    await user.click(screen.getByRole("checkbox", { name: "Section 1" }));
    expect(onChange).toHaveBeenLastCalledWith(["section_3", "section_1"]);
    expect(screen.getByText("2 of 12 chosen")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Section 3" }));
    expect(onChange).toHaveBeenLastCalledWith(["section_1"]);
  });

  it("stops at twelve: the rest wait, with the reason, and a chosen one can still be unchosen", async () => {
    const user = userEvent.setup();
    render(<Harness all={sections(14)} />);
    for (let i = 1; i <= 12; i += 1) {
      await user.click(screen.getByRole("checkbox", { name: `Section ${i}` }));
    }
    const thirteenth = screen.getByRole("checkbox", { name: "Section 13" });
    // Not `disabled`: a disabled box cannot be focused, so its reason would never be read. It says why, and does nothing.
    expect(thirteenth).toHaveAttribute("aria-disabled", "true");
    expect(thirteenth).not.toBeDisabled();
    expect(thirteenth).toHaveAccessibleDescription(/at most 12 sections/i);
    expect(screen.getByText("12 of 12 chosen")).toBeInTheDocument();
    await user.click(thirteenth);
    expect(thirteenth).not.toBeChecked();
    expect(screen.getByText("12 of 12 chosen")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Section 1" })).not.toHaveAttribute(
      "aria-disabled",
    );
    await user.click(screen.getByRole("checkbox", { name: "Section 1" }));
    expect(thirteenth).not.toHaveAttribute("aria-disabled");
  });

  it("has no axe violations", async () => {
    const { container } = render(<Harness all={sections(3)} initial={["section_1"]} />);
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
