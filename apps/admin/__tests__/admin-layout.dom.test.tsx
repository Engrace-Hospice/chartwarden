import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
// The console frame's keyboard behaviour below 768px: the off-canvas nav takes focus when it opens, Escape closes it and
// returns focus to the toggle; the actor menu is a plain disclosure that Escape also closes.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminNavSection } from "../src/shell/admin-nav";
import { AdminLayout } from "../src/shell/layout";
import { ActorSessionProvider, type Session } from "../src/shell/session";

const SESSION: Session = {
  userId: "ops-user",
  displayName: "Otto OrgAdmin",
  organizationId: "11111111-1111-4111-8111-111111111111",
  roles: ["platform_ops"],
  permissions: [],
};

const SECTIONS: AdminNavSection[] = [
  { label: null, entries: [{ key: "overview", label: "Overview", to: "/", icon: "home" }] },
  {
    label: "Tenants",
    entries: [{ key: "saas.tenants", label: "Tenants", to: "/tenants", icon: "building" }],
  },
];

function Frame(): JSX.Element {
  return (
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost" })}>
      <ActorSessionProvider initial={SESSION}>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route element={<AdminLayout sections={SECTIONS} />}>
              <Route path="/" element={<div>home</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ActorSessionProvider>
    </ApiClientProvider>
  );
}

afterEach(() => cleanup());

describe("AdminLayout keyboard behaviour", () => {
  it("the nav toggle controls the sidebar, focuses it on open, and Escape closes it back to the toggle", async () => {
    render(<Frame />);
    const toggle = screen.getByRole("button", { name: "Open navigation" });
    const sidebar = document.getElementById("wx-admin-sidebar") as HTMLElement;
    expect(toggle.getAttribute("aria-controls")).toBe("wx-admin-sidebar");
    expect(sidebar.className).not.toContain("wx-nav-open");

    toggle.focus();
    fireEvent.click(toggle);
    expect(sidebar.className).toContain("wx-nav-open");
    await waitFor(() => expect(sidebar.contains(document.activeElement)).toBe(true));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(sidebar.className).not.toContain("wx-nav-open");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open navigation" }));
  });

  it("the actor menu is a disclosure, not an ARIA menu, and Escape closes it back to its trigger", () => {
    render(<Frame />);
    const trigger = screen.getByRole("button", { name: /Otto OrgAdmin/ });
    expect(trigger.getAttribute("aria-haspopup")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
