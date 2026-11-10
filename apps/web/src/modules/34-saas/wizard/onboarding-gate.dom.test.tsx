// @vitest-environment jsdom
// The shell's onboarding gate, mounted the way main.tsx mounts it: while the organization is onboarding the landing page goes to the
// wizard and screens outside onboarding say "Available after go-live"; a live or unknown stage leaves the shell as it was.
import type { ScreenRegistryModule } from "@chartwarden/types";
import { createApiClient } from "@chartwarden/ui";
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../../../shell/app";
import { createScreenRegistry } from "../../../shell/screen-registry";
import type { Session } from "../../../shell/session";
import { systemScreens } from "../../../shell/system-pages";
import { OnboardingScreenGate } from "./onboarding-gate";

const standIn = (id: string, path: string, text: string) => ({
  id,
  path,
  title: text,
  navGroup: "Admin",
  screen: () => <h1>{text}</h1>,
});
const screens: ScreenRegistryModule<ComponentType> = {
  moduleId: 34,
  slug: "gate-stand-ins",
  screens: [
    standIn("t.wizard", "/admin/onboarding", "Wizard"),
    standIn("t.wizard-step", "/admin/onboarding/:stepKey", "Wizard step"),
    standIn("t.account", "/admin/account", "Account page"),
    standIn("t.setup", "/admin/setup", "Agency setup page"),
    standIn("t.grants", "/admin/support-grants", "Support grants page"),
  ],
};

const stub = async (): Promise<Response> =>
  new Response(JSON.stringify({ error: { code: "STUB", message: "x" } }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });

afterEach(() => vi.unstubAllGlobals());

function mountAt(path: string, organizationStage: Session["organizationStage"]) {
  vi.stubGlobal("fetch", vi.fn(stub));
  const registry = createScreenRegistry();
  registry.register(systemScreens);
  registry.register(screens);
  window.history.pushState({}, "", path);
  render(
    <AppShell
      registry={registry}
      client={createApiClient({ baseUrl: "http://localhost", fetch: stub })}
      screenGuard={OnboardingScreenGate}
      session={{
        userId: "u",
        organizationId: "o",
        membershipId: "m",
        displayName: "N",
        organizationName: "Org",
        roles: ["org_admin"],
        isAdmin: true,
        permissions: [],
        ...(organizationStage ? { organizationStage } : {}),
      }}
    />,
  );
}

describe("OnboardingScreenGate", () => {
  it("sends the landing page to the wizard while the organization is onboarding", async () => {
    mountAt("/", "onboarding");
    expect(await screen.findByRole("heading", { name: "Wizard" })).toBeTruthy();
    expect(window.location.pathname).toBe("/admin/onboarding");
  });

  it("says Available after go-live on a screen outside onboarding, with a way back", async () => {
    mountAt("/admin/support-grants", "onboarding");
    expect(await screen.findByText("Available after go-live")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Support grants page" })).toBeNull();
    expect(screen.getByRole("link", { name: "Back to onboarding" }).getAttribute("href")).toBe(
      "/admin/onboarding",
    );
  });

  it.each([
    ["/admin/onboarding", "Wizard"],
    ["/admin/onboarding/plan_contract", "Wizard step"],
    ["/admin/account", "Account page"],
    ["/admin/setup", "Agency setup page"],
  ])("lets %s through while onboarding", async (path, heading) => {
    mountAt(path, "onboarding");
    expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
    expect(screen.queryByText("Available after go-live")).toBeNull();
  });

  it("leaves every screen alone once the organization is live", async () => {
    mountAt("/admin/support-grants", "live");
    expect(await screen.findByRole("heading", { name: "Support grants page" })).toBeTruthy();
  });

  it("leaves the shell normal when the stage is unknown (the server stays the authority)", async () => {
    mountAt("/admin/support-grants", undefined);
    expect(await screen.findByRole("heading", { name: "Support grants page" })).toBeTruthy();
    expect(screen.queryByText("Available after go-live")).toBeNull();
  });

  it("keeps the landing page where it is when the organization is live or the stage is unknown", async () => {
    for (const stage of ["live", undefined] as const) {
      mountAt("/", stage);
      expect(await screen.findByRole("main")).toBeTruthy();
      expect(window.location.pathname).toBe("/");
      cleanup();
    }
  });
});
