// BillingTabs: four areas (Overview · Work Queue · Claims · Revenue Cycle) plus Tools, with the views inside the
// current area on a second row. Every view the old nine-tab bar reached must still be one click away, and the
// area is read from the URL (longest matching prefix) so a deep link highlights the right place.
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { BillingTabs } from "./billing-tabs";

afterEach(cleanup);

const OLD_VIEWS: Record<string, string> = {
  Medicare: "/billing/claims",
  Commercial: "/commercial/billing/claims",
  Remittances: "/remittance",
  Denials: "/remittance/denials",
  "NOE / NOTR": "/billing/noe",
  Transfers: "/billing/transfer-notices",
  "DDE queue": "/billing/dde",
  Eligibility: "/billing/eligibility",
  Rates: "/billing/rate-tables",
  "Wage index": "/billing/wage-indexes",
};

function renderAt(path: string): HTMLElement {
  render(
    <MemoryRouter initialEntries={[path]}>
      <BillingTabs />
    </MemoryRouter>,
  );
  return screen.getByRole("navigation", { name: "Billing areas" });
}

function currentArea(nav: HTMLElement): string | null {
  return nav.querySelector('[aria-current="page"]')?.textContent ?? null;
}

describe("BillingTabs areas", () => {
  it("offers the five areas", () => {
    const nav = renderAt("/billing");
    for (const label of ["Overview", "Work Queue", "Claims", "Revenue Cycle", "Tools"])
      expect(within(nav).getByRole("link", { name: label })).toBeTruthy();
  });

  it.each([
    ["/billing", "Overview"],
    ["/billing/claims", "Claims"],
    ["/billing/claims/c1", "Claims"],
    ["/billing/claims/new", "Claims"],
    ["/commercial/billing/claims", "Claims"],
    ["/billing/noe", "Work Queue"],
    ["/billing/noe/n1", "Work Queue"],
    ["/billing/notr/n1", "Work Queue"],
    ["/billing/transfer-notices", "Work Queue"],
    ["/billing/dde", "Work Queue"],
    ["/remittance", "Revenue Cycle"],
    ["/remittance/denials", "Revenue Cycle"],
    ["/billing/eligibility", "Tools"],
    ["/billing/rate-tables", "Tools"],
    ["/billing/wage-indexes", "Tools"],
  ])("%s highlights %s", (path, area) => {
    expect(currentArea(renderAt(path))).toBe(area);
  });

  it("shows the second row only for the current area", () => {
    renderAt("/billing/dde");
    const views = screen.getByRole("navigation", { name: "Work Queue views" });
    expect(
      within(views).getByRole("link", { name: "DDE queue" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(within(views).getByRole("link", { name: "NOE / NOTR" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Tools views" })).toBeNull();
  });

  it.each(Object.entries(OLD_VIEWS))("keeps %s reachable at %s", (label, to) => {
    renderAt(to);
    const link = screen
      .getAllByRole("link", { name: label })
      .find((a) => a.getAttribute("href") === to);
    expect(link).toBeTruthy();
  });
});
