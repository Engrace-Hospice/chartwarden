// Audit F-035: the chart tab strip scrolls at laptop widths, so the current tab is scrolled into view
// and the strip no longer hides its scrollbar.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChartModuleRail } from "./chart-module-rail";

const client = createApiClient({
  baseUrl: "http://localhost",
  fetch: async () => new Response("{}", { status: 404 }),
});

afterEach(cleanup);

describe("ChartModuleRail overflow", () => {
  it("presents six primary groups and keeps legacy patient-detail deep links", () => {
    render(
      <ApiClientProvider client={client}>
        <ToastProvider>
          <MemoryRouter>
            <ChartModuleRail patientId="p1" current="addresses" />
          </MemoryRouter>
        </ToastProvider>
      </ApiClientProvider>,
    );

    const primary = screen.getByRole("navigation", { name: "Patient chart" });
    expect(
      within(primary)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Overview", "Patient details", "Clinical", "Documents", "Communication", "More"]);
    expect(
      within(primary).getByRole("link", { name: "Patient details" }).getAttribute("aria-current"),
    ).toBe("page");

    const secondary = screen.getByRole("navigation", { name: "Patient details sections" });
    expect(
      within(secondary)
        .getByRole("link", { name: "Demographics & identifiers" })
        .getAttribute("href"),
    ).toBe("/patients/p1?view=demographics");
    expect(within(secondary).getByRole("link", { name: "Addresses" }).getAttribute("href")).toBe(
      "/patients/p1?view=addresses",
    );
    expect(within(secondary).getByRole("link", { name: "Coverage" }).getAttribute("href")).toBe(
      "/patients/p1?view=coverage",
    );
    expect(within(secondary).getByRole("link", { name: "Care team" }).getAttribute("href")).toBe(
      "/patients/p1?view=care-team",
    );
  });

  it("maps clinical and administration deep links into contextual section navigation", () => {
    const { rerender } = render(
      <ApiClientProvider client={client}>
        <ToastProvider>
          <MemoryRouter>
            <ChartModuleRail patientId="p1" current="medications" />
          </MemoryRouter>
        </ToastProvider>
      </ApiClientProvider>,
    );

    const clinical = screen.getByRole("navigation", { name: "Clinical sections" });
    expect(within(clinical).getByRole("link", { name: "Medications" }).getAttribute("href")).toBe(
      "/patients/p1/medications",
    );
    expect(within(clinical).getByRole("link", { name: "Code status" }).getAttribute("href")).toBe(
      "/patients/p1?view=code-status",
    );

    rerender(
      <ApiClientProvider client={client}>
        <ToastProvider>
          <MemoryRouter>
            <ChartModuleRail patientId="p1" current="claims" />
          </MemoryRouter>
        </ToastProvider>
      </ApiClientProvider>,
    );

    const more = screen.getByRole("navigation", { name: "More sections" });
    expect(
      within(more).getByRole("link", { name: "Election & certification" }).getAttribute("href"),
    ).toBe("/patients/p1/election-certification");
    expect(within(more).getByRole("link", { name: "Privacy" }).getAttribute("href")).toBe(
      "/patients/p1?view=privacy",
    );
    expect(within(more).getByRole("link", { name: "Claims" }).getAttribute("href")).toBe(
      "/patients/p1/claims",
    );
  });

  it("scrolls the current tab into view and keeps the scrollbar visible", () => {
    const scrolled: (string | null)[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this.textContent);
    });
    try {
      const { container } = render(
        <ApiClientProvider client={client}>
          <ToastProvider>
            <MemoryRouter>
              <ChartModuleRail patientId="p1" current="claims" />
            </MemoryRouter>
          </ToastProvider>
        </ApiClientProvider>,
      );
      expect(scrolled).toEqual(["More", "Claims"]);
      expect(container.querySelector("nav")?.className).not.toContain("wx-no-scrollbar");
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});
