// The denial-taxonomy lookup takes its CARC from the shared code picker. A CARC catalog that has not been
// loaded (CARC/RARC are admin uploads) must not block the lookup: the code is kept as entered and the
// taxonomy route (its own floor) remains the authority.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { TaxonomyOverlay } from "./taxonomy-overlay";

function mount(carcResults: Array<{ code: string; display: string }>) {
  const GET = vi.fn(async (path: string) => {
    if (path === "/api/v1/terminology/{system}/search") return { data: { results: carcResults } };
    if (path === "/api/v1/terminology/{system}/validate") return { data: { valid: false } };
    if (path === "/api/v1/taxonomy/carc/{code}")
      return {
        data: {
          carcCode: "197",
          rarcCode: null,
          category: "authorization",
          plainLanguage: "Precertification absent",
          suggestedAction: null,
          ownerRole: null,
          severity: "warn",
          hasOverlay: false,
          overlayVersion: null,
        },
      };
    return { data: {} };
  });
  render(
    <ApiClientProvider client={{ GET } as unknown as ApiClient}>
      <MemoryRouter>
        <TaxonomyOverlay />
      </MemoryRouter>
    </ApiClientProvider>,
  );
  return GET;
}

describe("TaxonomyOverlay CARC picker", () => {
  it("looks up the CARC chosen from the catalog", async () => {
    const GET = mount([{ code: "197", display: "Precertification/authorization absent" }]);
    const input = screen.getByRole("combobox", { name: /CARC code/ });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "auth" } });
    fireEvent.click(await screen.findByRole("option", { name: /197/ }));
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));
    await waitFor(() =>
      expect(GET).toHaveBeenCalledWith(
        "/api/v1/taxonomy/carc/{code}",
        expect.objectContaining({ params: { path: { code: "197" } } }),
      ),
    );
  });

  it("still looks up a CARC the catalog does not know", async () => {
    const GET = mount([]);
    const input = screen.getByRole("combobox", { name: /CARC code/ });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "197" } });
    fireEvent.click(await screen.findByRole("option", { name: /as entered/ }));
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));
    await waitFor(() =>
      expect(GET).toHaveBeenCalledWith(
        "/api/v1/taxonomy/carc/{code}",
        expect.objectContaining({ params: { path: { code: "197" } } }),
      ),
    );
  });
});
