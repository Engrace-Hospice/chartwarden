// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StaleNotice } from "../stale-notice";

describe("StaleNotice", () => {
  it("says nothing while the page is fresh", () => {
    const { container } = render(<StaleNotice stale={false} onReload={() => undefined} />);
    expect(container.innerHTML).toBe("");
  });

  it("says the page may be out of date and offers Reload", () => {
    const onReload = vi.fn();
    render(<StaleNotice stale onReload={onReload} />);
    expect(screen.getByText(/may be out of date/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
