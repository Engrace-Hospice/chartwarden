// A claim reference on a denial / ADR / appeal panel is a link to the claim page, never the raw id as text.
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { ClaimLink } from "./claim-link";

afterEach(cleanup);

describe("ClaimLink", () => {
  it("links to the claim page without printing the id", () => {
    render(
      <MemoryRouter>
        <ClaimLink claimId="0b8c1f6e-0000-4000-8000-000000000001" />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: "Open claim" });
    expect(link.getAttribute("href")).toBe("/billing/claims/0b8c1f6e-0000-4000-8000-000000000001");
    expect(screen.queryByText(/0b8c1f6e/)).toBeNull();
  });

  it("keeps 'None linked' for a record with no claim", () => {
    const { container } = render(<span>{ClaimLink({ claimId: null })}</span>);
    expect(container.textContent).toBe("None linked");
  });
});
