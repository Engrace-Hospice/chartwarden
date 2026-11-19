// @vitest-environment jsdom
// The visit-note draft switch as the shell sees it (ADR-0114 VN-D17): registered under the permission key the server enforces, so a typed
// URL for an actor without `encounter.draft_policy_admin` shows the denied state rather than the screen, and the nav offers it only to
// a holder.
import { createApiClient } from "@chartwarden/ui";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canSeeScreen } from "../../../shell/actor-session";
import { AppShell } from "../../../shell/app";
import { createScreenRegistry } from "../../../shell/screen-registry";
import { systemScreens } from "../../../shell/system-pages";
import { encounterScreens } from "../screens";

const stub = async (): Promise<Response> =>
  new Response(JSON.stringify({ error: { code: "STUB", message: "x" } }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });

afterEach(() => vi.unstubAllGlobals());

const PATH = "/admin/draft-policy";
const KEY = "encounter.draft_policy_admin";

function renderAt(permissions: string[]): void {
  vi.stubGlobal("fetch", vi.fn(stub));
  const registry = createScreenRegistry();
  registry.register(systemScreens);
  registry.register(encounterScreens);
  window.history.pushState({}, "", PATH);
  render(
    <AppShell
      registry={registry}
      client={createApiClient({ baseUrl: "http://localhost", fetch: stub })}
      session={{
        userId: "u",
        organizationId: "o",
        membershipId: "m",
        displayName: "N",
        organizationName: "Org",
        roles: ["director_of_nursing"],
        isAdmin: false,
        permissions,
      }}
    />,
  );
}

const screenEntry = encounterScreens.screens.find((s) => s.id === "encounter.draft-policy");

describe("visit-note draft screen registration", () => {
  it("is registered under the key the server enforces, in the Admin group", () => {
    expect(screenEntry).toMatchObject({
      path: PATH,
      navGroup: "Admin",
      requiredPermission: KEY,
    });
  });

  it("is visible only to a holder of the permission", () => {
    const session = (permissions: string[]) => ({
      userId: "u",
      organizationId: "o",
      membershipId: "m",
      roles: [],
      isAdmin: false,
      permissions,
    });
    expect(canSeeScreen(screenEntry ?? {}, session([KEY]))).toBe(true);
    expect(canSeeScreen(screenEntry ?? {}, session(["encounter.author"]))).toBe(false);
  });
});

describe("visit-note draft route permission gate", () => {
  it("shows the denied state without the permission", async () => {
    renderAt(["encounter.author"]);
    expect(await screen.findByText("You do not have access")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Visit-note draft" })).toBeNull();
  });

  it("renders the screen for a holder of the permission", async () => {
    renderAt([KEY]);
    expect(await screen.findByRole("heading", { name: "Visit-note draft" })).toBeTruthy();
    expect(screen.queryByText("You do not have access")).toBeNull();
  });
});
