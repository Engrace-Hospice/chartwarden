// @vitest-environment jsdom
// StepRail: the wizard's ordered step list. It is navigation (select a step to read it), not a gate: a locked step is still
// selectable, because an operator reads ahead and the server is what refuses an out-of-order write.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StepRail, type StepRailItem } from "./step-rail";

const STEPS: StepRailItem[] = [
  { key: "org", label: "Organisation", state: "done" },
  { key: "plan", label: "Plan & contract", caption: "Platform operator", state: "current" },
  { key: "baa", label: "BAA", state: "todo" },
  { key: "locations", label: "Locations", state: "locked", lockedReason: "Finish BAA first" },
  { key: "mac", label: "MAC credentials", state: "skipped" },
  { key: "npi", label: "NPI", state: "blocked" },
];

function renderRail(activeKey: string | null = "plan") {
  const onSelect = vi.fn();
  render(
    <StepRail
      steps={STEPS}
      activeKey={activeKey}
      onSelect={onSelect}
      ariaLabel="Onboarding steps"
    />,
  );
  return { onSelect };
}

describe("StepRail", () => {
  it("is a named list of the steps, in order", () => {
    renderRail();
    const list = screen.getByRole("list", { name: "Onboarding steps" });
    const labels = within(list)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(labels).toHaveLength(6);
    expect(labels[0]).toContain("Organisation");
    expect(labels[1]).toContain("Plan & contract");
    expect(labels[1]).toContain("Platform operator");
  });

  it("marks only the active step as the current step", () => {
    renderRail("baa");
    const current = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-current") === "step");
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain("BAA");
  });

  it("says each state in words, so colour is never the only signal", () => {
    renderRail();
    expect(screen.getByRole("button", { name: /Organisation/ }).textContent).toMatch(/Done/);
    expect(screen.getByRole("button", { name: /MAC credentials/ }).textContent).toMatch(/Skipped/);
    expect(screen.getByRole("button", { name: /NPI/ }).textContent).toMatch(/Needs attention/);
  });

  it("names why a locked step is locked", () => {
    renderRail();
    const locked = screen.getByRole("button", { name: /Locations/ });
    expect(locked.textContent).toMatch(/Locked/);
    expect(locked.textContent).toMatch(/Finish BAA first/);
  });

  it("selects a step on click, a locked one included", () => {
    const { onSelect } = renderRail();
    fireEvent.click(screen.getByRole("button", { name: /Locations/ }));
    expect(onSelect).toHaveBeenCalledWith("locations");
    fireEvent.click(screen.getByRole("button", { name: /Organisation/ }));
    expect(onSelect).toHaveBeenLastCalledWith("org");
  });

  it("marks no step current when nothing is active", () => {
    renderRail(null);
    expect(
      screen.getAllByRole("button").some((b) => b.getAttribute("aria-current") === "step"),
    ).toBe(false);
  });
});
