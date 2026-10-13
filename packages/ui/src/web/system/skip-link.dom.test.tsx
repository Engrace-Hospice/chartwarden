// WCAG 2.4.1 (bypass blocks): a "Skip to main content" link that is the first Tab stop and moves focus to <main>.
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SkipLink } from "./skip-link";

function Shell() {
  return (
    <div>
      <SkipLink targetId="wx-main" />
      <nav>
        <a href="/one">One</a>
      </nav>
      <main id="wx-main" tabIndex={-1}>
        content
      </main>
    </div>
  );
}

describe("SkipLink", () => {
  it("is the first focusable element", async () => {
    render(<Shell />);
    await userEvent.setup().tab();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Skip to main content" }));
  });

  it("moves focus to the target without changing the URL hash", () => {
    render(<Shell />);
    const link = screen.getByRole("link", { name: "Skip to main content" });
    expect(fireEvent.click(link)).toBe(false); // default prevented: no #hash history entry
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("does nothing (and does not throw) when the target is missing", () => {
    render(<SkipLink targetId="absent" />);
    expect(() =>
      fireEvent.click(screen.getByRole("link", { name: "Skip to main content" })),
    ).not.toThrow();
  });
});
