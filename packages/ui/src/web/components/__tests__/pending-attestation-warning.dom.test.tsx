// @vitest-environment jsdom
// Said BEFORE anything is saved: a change voids a go-live attestation that is waiting for approval. Either lane's view fits, in the lane's wording.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PendingAttestationWarning } from "../pending-attestation-warning";

describe("PendingAttestationWarning", () => {
  it("speaks to an operator by default and to the tenant when asked", () => {
    const view = { goLive: { state: "awaiting_approval" } };
    const { rerender } = render(<PendingAttestationWarning view={view} />);
    expect(screen.getByText(/The compliance officer has attested go-live readiness/)).toBeTruthy();
    rerender(<PendingAttestationWarning view={view} audience="tenant" />);
    expect(
      screen.getByText(/Your compliance officer has attested that you are ready/),
    ).toBeTruthy();
  });

  it.each(["not_ready", "awaiting_attestation", "live", "closed"])(
    "says nothing while go-live is %s",
    (state) => {
      const { container } = render(<PendingAttestationWarning view={{ goLive: { state } }} />);
      expect(container.innerHTML).toBe("");
    },
  );
});
