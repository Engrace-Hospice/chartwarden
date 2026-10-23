// Audit F-035: the chart tab strip scrolls at laptop widths, so the current tab is scrolled into view
// and the strip no longer hides its scrollbar.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChartModuleRail } from "./chart-module-rail";

const client = createApiClient({
  baseUrl: "http://localhost",
  fetch: async () => new Response("{}", { status: 404 }),
});

afterEach(cleanup);

describe("ChartModuleRail overflow", () => {
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
      expect(scrolled).toEqual(["Claims"]);
      expect(container.querySelector("nav")?.className).not.toContain("wx-no-scrollbar");
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});
