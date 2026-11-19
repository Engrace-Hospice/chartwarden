// @vitest-environment jsdom
// The two note-closure screens as the shell sees them (ADR-0113): registered under the permission keys the server enforces, so a typed
// URL for an actor without the key shows the denied state rather than the screen, and My Drafts is relabelled My Notes without moving.
import { createApiClient } from "@chartwarden/ui";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function renderAt(path: string, permissions: string[]): void {
  vi.stubGlobal("fetch", vi.fn(stub));
  const registry = createScreenRegistry();
  registry.register(systemScreens);
  registry.register(encounterScreens);
  window.history.pushState({}, "", path);
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

const screenById = (id: string) => encounterScreens.screens.find((s) => s.id === id);

describe("note-closure screen registration", () => {
  it("registers the overdue board and the policy under the keys the server enforces", () => {
    expect(screenById("encounter.overdue-notes")).toMatchObject({
      path: "/work/overdue-notes",
      navGroup: "Clinical",
      requiredPermission: "encounter.closure_override",
    });
    expect(screenById("encounter.closure-policy")).toMatchObject({
      path: "/admin/closure-policy",
      requiredPermission: "encounter.closure_policy_admin",
    });
  });

  it("relabels My Drafts as My Notes without changing its id or path", () => {
    expect(screenById("encounter.my-drafts")).toMatchObject({
      path: "/work/drafts",
      title: "My Notes",
      requiredPermission: "encounter.author",
    });
  });
});

describe("note-closure route permission gate", () => {
  it.each([
    ["/work/overdue-notes", "encounter.closure_override", "Overdue notes"],
    ["/admin/closure-policy", "encounter.closure_policy_admin", "Note closure policy"],
  ])("shows the denied state at %s without %s", async (path, _key, heading) => {
    renderAt(path, ["encounter.author"]);
    expect(await screen.findByText("You do not have access")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: heading })).toBeNull();
  });

  it.each([
    ["/work/overdue-notes", "encounter.closure_override", "Overdue notes"],
    ["/admin/closure-policy", "encounter.closure_policy_admin", "Note closure policy"],
  ])("renders the screen at %s for an actor holding %s", async (path, key, heading) => {
    renderAt(path, [key]);
    expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
    expect(screen.queryByText("You do not have access")).toBeNull();
  });
});
