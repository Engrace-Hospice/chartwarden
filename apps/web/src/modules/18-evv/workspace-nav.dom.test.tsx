import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { EvvWorkspaceNav } from "./workspace-nav";

function renderNav(path: string, permissions: string[]): ReturnType<typeof render> {
  return render(
    <SessionProvider
      session={{
        userId: "user-1",
        organizationId: "org-1",
        roles: [],
        permissions,
      }}
    >
      <MemoryRouter initialEntries={[path]}>
        <EvvWorkspaceNav />
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("EvvWorkspaceNav", () => {
  it("does not add an empty navigation landmark without an EVV permission", () => {
    renderNav("/evv/events", []);

    expect(screen.queryByRole("navigation", { name: "EVV operations" })).not.toBeInTheDocument();
  });

  it("shows only EVV tasks the current session can open", () => {
    renderNav("/evv/missing-resolutions?status=open", ["evv.missing_resolution.read", "evv.read"]);

    expect(screen.getByRole("navigation", { name: "EVV operations" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Needs attention" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Events" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Submissions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Policies" })).not.toBeInTheDocument();
  });

  it("keeps event detail inside the Events section", () => {
    renderNav("/evv/events/event-1", ["evv.read", "evv.aggregator.read"]);

    expect(screen.getByRole("link", { name: "Events" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Submissions" })).not.toHaveAttribute("aria-current");
  });

  it("separates operational work from policy and device administration", () => {
    renderNav("/evv/geofence-policy", [
      "evv.read_metrics",
      "evv.aggregator.read",
      "evv.policy.read",
      "evv.device.read",
    ]);

    expect(screen.getByRole("link", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Submissions" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Policies" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Devices" })).toBeInTheDocument();
  });
});
