import type { ScreenRegistryModule } from "@chartwarden/types";
// @vitest-environment jsdom
// #592 F-025: nav hiding alone let a typed URL open a create form the actor cannot submit. The shell wraps every
// chromed screen in a permission guard; this proves the wrapper is wired onto the routes (the pure predicate is
// unit-tested in actor-session.test.ts and would stay green if the wrapper were removed).
import { createApiClient } from "@chartwarden/ui";
import { render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./app";
import { createScreenRegistry } from "./screen-registry";
import { systemScreens } from "./system-pages";

const GATED_KEY = "gated.create";

const gatedScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 2,
  slug: "gated-stand-in",
  screens: [
    {
      id: "test.gated-form",
      path: "/gated/new",
      title: "Gated form",
      requiredPermission: GATED_KEY,
      screen: () => <h1>Gated form body</h1>,
    },
    {
      id: "test.gated-detail",
      path: "/gated/:id",
      title: "Gated detail",
      requiredPermission: GATED_KEY,
      screen: () => <h1>Gated detail body</h1>,
    },
  ],
};

const stub = async (): Promise<Response> =>
  new Response(JSON.stringify({ error: { code: "STUB", message: "x" } }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });

afterEach(() => vi.unstubAllGlobals());

function renderAt(path: string, permissions: string[]) {
  vi.stubGlobal("fetch", vi.fn(stub));
  const registry = createScreenRegistry();
  registry.register(systemScreens);
  registry.register(gatedScreens);
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
        roles: ["external_auditor"],
        isAdmin: false,
        permissions,
      }}
    />,
  );
}

describe("chromed route permission guard (F-025)", () => {
  it("shows the denied state, not the form, for a typed URL the actor lacks the permission for", async () => {
    renderAt("/gated/new", []);
    expect(await screen.findByText("You do not have access")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Gated form body" })).toBeNull();
  });

  it("renders the screen when the actor holds the permission", async () => {
    renderAt("/gated/new", [GATED_KEY]);
    expect(await screen.findByRole("heading", { name: "Gated form body" })).toBeTruthy();
    expect(screen.queryByText("You do not have access")).toBeNull();
  });

  it("gives the denied state a heading and neutral copy", async () => {
    renderAt("/gated/new", []);
    expect(await screen.findByRole("heading", { name: "Gated form" })).toBeTruthy();
    expect(screen.getByText(/permission to view this page/i)).toBeTruthy();
  });

  it("leaves param-path screens to the server: a nav-only key must not hard-block a linked page", async () => {
    renderAt("/gated/abc", []);
    expect(await screen.findByRole("heading", { name: "Gated detail body" })).toBeTruthy();
    expect(screen.queryByText("You do not have access")).toBeNull();
  });
});
