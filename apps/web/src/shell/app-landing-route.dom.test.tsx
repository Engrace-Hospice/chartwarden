import type { ScreenRegistryModule } from "@chartwarden/types";
// @vitest-environment jsdom
// ADR-0049: a chromeless screen registered at `/` (the app.<base> landing, registered by main.tsx on that host only)
// claims `/` ahead of the chromed Role Home; without it `/` is untouched. The shell never imports a feature module,
// so the landing is stood in for by a local chromeless screen.
import { createApiClient } from "@chartwarden/ui";
import { render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./app";
import { createScreenRegistry } from "./screen-registry";
import { systemScreens } from "./system-pages";

const appLandingScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 2,
  slug: "landing-stand-in",
  screens: [
    {
      id: "test.landing",
      path: "/",
      title: "Find your organization",
      chrome: false,
      screen: () => <h1>Find your organization</h1>,
    },
  ],
};

const stub = async (): Promise<Response> =>
  new Response(JSON.stringify({ error: { code: "STUB", message: "x" } }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });

afterEach(() => vi.unstubAllGlobals());

function renderAtRoot(withLanding: boolean) {
  vi.stubGlobal("fetch", vi.fn(stub));
  const registry = createScreenRegistry();
  registry.register(systemScreens);
  if (withLanding) registry.register(appLandingScreens);
  window.history.pushState({}, "", "/");
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
        roles: ["administrator"],
        isAdmin: true,
        permissions: [],
      }}
    />,
  );
}

describe("app.<base> landing route", () => {
  it("renders the landing at / when registered", async () => {
    renderAtRoot(true);
    expect(await screen.findByRole("heading", { name: "Find your organization" })).toBeTruthy();
  });

  it("is absent when not registered: the chromed Role Home owns / instead", async () => {
    renderAtRoot(false);
    // Wait on something that proves the shell finished routing (the chromed layout's main landmark), then assert absence.
    expect(await screen.findByRole("main")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Find your organization" })).toBeNull();
  });
});
