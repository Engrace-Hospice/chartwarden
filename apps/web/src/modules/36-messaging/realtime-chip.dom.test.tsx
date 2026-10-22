import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RealtimeChip } from "./realtime-banner";

describe("RealtimeChip", () => {
  it("renders nothing while realtime has never connected", () => {
    const { container } = render(
      <RealtimeChip connected={false} degraded={false} catchingUp={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("says Live when connected and not catching up", () => {
    render(<RealtimeChip connected degraded={false} catchingUp={false} />);
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("says Catching up… from the reconnect until the refresh resolves", () => {
    const { rerender } = render(<RealtimeChip connected degraded={false} catchingUp />);
    expect(screen.getByText("Catching up…")).toBeTruthy();
    rerender(<RealtimeChip connected degraded={false} catchingUp={false} />);
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("says Paused in the degraded state, even if a catch-up flag is stale", () => {
    render(<RealtimeChip connected={false} degraded catchingUp />);
    expect(screen.getByText("Paused")).toBeTruthy();
  });

  it("is not a live region and carries no clinical wording", () => {
    render(<RealtimeChip connected degraded={false} catchingUp={false} />);
    const chip = screen.getByText("Live");
    expect(chip.closest("[aria-live], output, [role=status]")).toBeNull();
    expect(chip.getAttribute("aria-label")).toBeNull();
  });
});
