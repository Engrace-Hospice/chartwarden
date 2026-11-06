// @vitest-environment jsdom
// FactList: "what settles this step", as facts that hold or do not yet.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FactList } from "./fact-list";

describe("FactList", () => {
  it("lists each fact with its state in words and its detail", () => {
    render(
      <FactList
        ariaLabel="What settles this step"
        facts={[
          { key: "a", label: "A primary location exists", state: "ok" },
          { key: "b", label: "NPI verified", state: "pending", detail: "Not verified yet" },
          { key: "c", label: "BAA executed", state: "blocked", detail: "Expired on 2026-01-01" },
          { key: "d", label: "Recorded by you", state: "info" },
        ]}
      />,
    );
    const items = within(screen.getByRole("list", { name: "What settles this step" })).getAllByRole(
      "listitem",
    );
    expect(items).toHaveLength(4);
    expect(items[0]?.textContent).toMatch(/Met/);
    expect(items[1]?.textContent).toMatch(/Not yet/);
    expect(items[1]?.textContent).toContain("Not verified yet");
    expect(items[2]?.textContent).toMatch(/Blocked/);
    expect(items[2]?.textContent).toContain("Expired on 2026-01-01");
    expect(items[3]?.textContent).not.toMatch(/Met|Not yet|Blocked/);
  });

  it("renders nothing for an empty list", () => {
    const { container } = render(<FactList facts={[]} />);
    expect(container.querySelector("ul")).toBeNull();
  });
});
