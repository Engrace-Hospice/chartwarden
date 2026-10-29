import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { Breadcrumbs } from "./breadcrumbs";

function Location(): JSX.Element {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

describe("Breadcrumbs", () => {
  it("navigates to a parent and marks the current page", () => {
    render(
      <MemoryRouter initialEntries={["/admissions/new"]}>
        <Breadcrumbs
          items={[{ label: "Admissions", href: "/admissions" }, { label: "Direct intake" }]}
        />
        <Location />
      </MemoryRouter>,
    );
    expect(screen.getByText("Direct intake").getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByRole("link", { name: "Admissions" }));
    expect(screen.getByTestId("location").textContent).toBe("/admissions");
  });
});
