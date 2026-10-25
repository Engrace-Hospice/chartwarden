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
  "ADR requests": "/remittance/adrs",
  Audits: "/remittance/audits",
  Appeals: "/remittance/appeals",
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
  return nav.querySelector("[aria-current]")?.textContent ?? null;
}

function currentView(): string | null {
  const views = screen.queryByRole("navigation", { name: /views$/ });
  return views?.querySelector('[aria-current="page"]')?.textContent ?? null;
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
    ["/billing/queue", "Work Queue"],
    ["/billing/noe", "Work Queue"],
    ["/billing/noe/n1", "Work Queue"],
    ["/billing/notr/n1", "Work Queue"],
    ["/billing/transfer-notices", "Work Queue"],
    ["/billing/dde", "Work Queue"],
    ["/remittance", "Revenue Cycle"],
    ["/remittance/denials", "Revenue Cycle"],
    ["/remittance/adrs", "Revenue Cycle"],
    ["/remittance/audits", "Revenue Cycle"],
    ["/remittance/appeals", "Revenue Cycle"],
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

  it.each([
    ["/billing/queue", "All work"],
    ["/billing/claims", "Medicare"],
    ["/billing/claims/c1", "Medicare"],
    ["/commercial/billing/payers", "Commercial"],
    ["/commercial/billing/claims/c1", "Commercial"],
    ["/billing/noe/n1", "NOE / NOTR"],
    ["/billing/notr", "NOE / NOTR"],
    ["/billing/notr/n1", "NOE / NOTR"],
    ["/remittance", "Remittances"],
    ["/remittance/denials", "Denials"],
    ["/remittance/adrs", "ADR requests"],
    ["/remittance/audits", "Audits"],
    ["/remittance/appeals", "Appeals"],
    ["/billing/rate-tables", "Rates"],
  ])("%s highlights the %s view", (path, view) => {
    renderAt(path);
    expect(currentView()).toBe(view);
  });

  it("marks exactly one element aria-current=page, and the area as in-area on a view route", () => {
    const nav = renderAt("/remittance/denials");
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(nav.querySelector("[aria-current]")?.getAttribute("aria-current")).toBe("true");
    expect(screen.getAllByRole("navigation")).toHaveLength(2);
  });

  it("marks the Overview area itself as the page, with no second row", () => {
    const nav = renderAt("/billing");
    expect(nav.querySelector("[aria-current]")?.getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("navigation", { name: /views$/ })).toBeNull();
  });

  it.each(["/remittance/tpe", "/remittance/playbooks", "/remittance/report"])(
    "%s, a Revenue Cycle screen with no view of its own, falls under Remittances",
    (path) => {
      renderAt(path);
      expect(currentView()).toBe("Remittances");
    },
  );

  it("falls back to Overview for billing screens outside the views", () => {
    const nav = renderAt("/billing/rule-config");
    expect(currentArea(nav)).toBe("Overview");
    expect(screen.queryByRole("navigation", { name: /views$/ })).toBeNull();
  });

  it("highlights nothing outside billing", () => {
    const nav = renderAt("/patients/p1");
    expect(currentArea(nav)).toBeNull();
    expect(screen.queryByRole("navigation", { name: /views$/ })).toBeNull();
  });

  it("sends each area link to its first view, so every old view is reachable from any screen", () => {
    const nav = renderAt("/billing");
    const hrefs = Object.fromEntries(
      within(nav)
        .getAllByRole("link")
        .map((a) => [a.textContent, a.getAttribute("href")]),
    );
    expect(hrefs).toEqual({
      Overview: "/billing",
      "Work Queue": "/billing/queue",
      Claims: "/billing/claims",
      "Revenue Cycle": "/remittance",
      Tools: "/billing/eligibility",
    });
  });

  it.each(Object.entries(OLD_VIEWS))("keeps %s reachable at %s", (label, to) => {
    renderAt(to);
    const link = screen
      .getAllByRole("link", { name: label })
      .find((a) => a.getAttribute("href") === to);
    expect(link).toBeTruthy();
  });
});
