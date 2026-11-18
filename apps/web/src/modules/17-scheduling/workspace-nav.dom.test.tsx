import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { SchedulingWorkspaceNav } from "./workspace-nav";

function renderNav(
  path: string,
  permissions: string[],
  patientId?: string,
): ReturnType<typeof render> {
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
        <SchedulingWorkspaceNav patientId={patientId} />
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("SchedulingWorkspaceNav", () => {
  it("shows only primary tasks the current session can open", () => {
    renderNav("/calendar", ["visit.read", "visit.proposal.read"]);

    expect(screen.getByRole("link", { name: "Calendar" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Needs scheduling" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "My visits" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Staff & availability" })).not.toBeInTheDocument();
  });

  it("preserves patient context only on patient-relevant workspace links", () => {
    renderNav(
      "/scheduling/proposals?patient=patient-1",
      ["visit.read", "visit.proposal.read"],
      "patient-1",
    );

    expect(screen.getByRole("link", { name: "Calendar" })).toHaveAttribute(
      "href",
      "/calendar?patient=patient-1",
    );
    expect(screen.getByRole("link", { name: "Needs scheduling" })).toHaveAttribute(
      "href",
      "/scheduling/proposals?patient=patient-1",
    );
    expect(screen.getByRole("link", { name: "My visits" })).toHaveAttribute("href", "/me/visits");
  });

  it("offers the staff panel only when the session can also open the calendar", () => {
    const { unmount } = renderNav("/calendar", ["availability.read"]);
    expect(screen.queryByRole("link", { name: "Staff & availability" })).not.toBeInTheDocument();
    unmount();

    renderNav("/calendar", ["visit.read", "availability.read"]);
    expect(screen.getByRole("link", { name: "Staff & availability" })).toBeInTheDocument();
  });
});
