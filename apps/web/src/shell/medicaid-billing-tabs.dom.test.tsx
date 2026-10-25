// MedicaidBillingTabs: five areas (Overview · Work Queue · Claims · Compliance · Tools) with the views of the current
// area on a second row. Every Medicaid billing screen must be reachable from the bar, and the area is read from the URL.
// Gate facts: new test file, nothing imports it; it exercises MedicaidBillingTabs only; no API or data schema.
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { MedicaidBillingTabs } from "./medicaid-billing-tabs";

afterEach(cleanup);

function renderAt(path: string): HTMLElement {
  render(
    <MemoryRouter initialEntries={[path]}>
      <MedicaidBillingTabs />
    </MemoryRouter>,
  );
  return screen.getByRole("navigation", { name: "Medicaid billing areas" });
}
const currentArea = (nav: HTMLElement) => nav.querySelector("[aria-current]")?.textContent ?? null;
const currentView = () =>
  screen.queryByRole("navigation", { name: /views$/ })?.querySelector('[aria-current="page"]')
    ?.textContent ?? null;

describe("MedicaidBillingTabs", () => {
  it("offers the five areas, each linking to its first screen", () => {
    const nav = renderAt("/medicaid/billing/ar-dashboard");
    const hrefs = Object.fromEntries(
      within(nav)
        .getAllByRole("link")
        .map((a) => [a.textContent, a.getAttribute("href")]),
    );
    expect(hrefs).toEqual({
      Overview: "/medicaid/billing/ar-dashboard",
      "Work Queue": "/medicaid/billing/queue",
      Claims: "/medicaid/billing/claims",
      Compliance: "/medicaid/billing/rule-config",
      Tools: "/medicaid/billing/eligibility",
    });
  });

  it.each([
    ["/medicaid/billing/ar-dashboard", "Overview"],
    ["/medicaid/billing/queue", "Work Queue"],
    ["/medicaid/billing/validation-worklist", "Work Queue"],
    ["/medicaid/billing/claims", "Claims"],
    ["/medicaid/billing/claims/new", "Claims"],
    ["/medicaid/billing/claims/c1", "Claims"],
    ["/medicaid/billing/claims/c1/validation", "Claims"],
    ["/medicaid/billing/claims/c1/submissions", "Claims"],
    ["/medicaid/billing/claims/c1/acknowledgments", "Claims"],
    ["/medicaid/billing/rule-config", "Compliance"],
    ["/medicaid/billing/override-audit", "Compliance"],
    ["/medicaid/billing/eligibility", "Tools"],
    ["/medicaid/billing/trading-partner-credentials", "Tools"],
    ["/medicaid/billing/rb-arrangements", "Tools"],
    ["/medicaid/billing/rb-arrangements/a1", "Tools"],
    ["/medicaid/billing/metrics", "Tools"],
  ])("%s highlights %s", (path, area) => {
    expect(currentArea(renderAt(path))).toBe(area);
  });

  it("shows the views of the current area and marks exactly one page", () => {
    renderAt("/medicaid/billing/override-audit");
    expect(currentView()).toBe("Override audit");
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it("has no second row on Claims", () => {
    renderAt("/medicaid/billing/claims/c1");
    expect(screen.queryByRole("navigation", { name: /views$/ })).toBeNull();
  });

  it("falls back to Overview for other Medicaid billing screens, and to nothing outside", () => {
    expect(currentArea(renderAt("/medicaid/billing/something-new"))).toBe("Overview");
    cleanup();
    expect(currentArea(renderAt("/billing"))).toBeNull();
  });
});
