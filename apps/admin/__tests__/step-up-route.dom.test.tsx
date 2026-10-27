import { createApiClient } from "@chartwarden/ui";
// @chartwarden/admin — the console's /step-up page. Platform-ops writes answer 403 STEP_UP_REQUIRED on a stale session,
// and before this route existed the console had no way to re-verify, so those actions could never succeed. The net:
// a signed-in platform_ops actor reaches /step-up (chromeless — RequireChrome does not bounce it), sees the shared
// ceremony under the console's own brand, and a verified code returns to the action's page.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AdminApp } from "../src/app";
import { adminAuthScreens } from "../src/shell/auth-screens";
import { createAdminRegistry } from "../src/shell/registry";
import type { Session } from "../src/shell/session";

const SESSION: Session = {
  userId: "ops-user",
  organizationId: "11111111-1111-4111-8111-111111111111",
  roles: ["platform_ops"],
  permissions: [],
};

let paths: string[] = [];

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const path = new URL(req.url, "http://localhost").pathname;
  paths.push(path);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (path === "/api/v1/sessions/step-up/initiate")
    return json(200, { challengeId: "33333333-3333-4333-8333-333333333333", factor: "totp" });
  if (path === "/api/v1/sessions/step-up") return json(200, { ok: true });
  return json(404, { error: { code: "NOT_FOUND", message: "none", correlationId: "c" } });
}

function mountAt(url: string): void {
  window.history.pushState({}, "", url);
  const registry = createAdminRegistry();
  registry.register(adminAuthScreens);
  render(
    <AdminApp
      registry={registry}
      client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}
      session={SESSION}
    />,
  );
}

afterEach(() => {
  cleanup();
  paths = [];
});

describe("admin /step-up", () => {
  it("renders the shared ceremony under the console brand for a signed-in platform_ops actor", async () => {
    mountAt("/step-up?returnTo=%2Fadmin%2Frevenue");
    expect(await screen.findByRole("heading", { name: "Confirm it’s you" })).toBeTruthy();
    expect(screen.getByText("ChartWarden Platform Ops")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in as someone else" }).getAttribute("href")).toBe(
      "/login",
    );
    expect(window.location.pathname).toBe("/step-up");
  });

  it("returns to the same-origin returnTo after a verified code", async () => {
    mountAt("/step-up?returnTo=%2Fadmin%2Frevenue%3Fx%3D1");
    fireEvent.change(await screen.findByLabelText(/Authentication code/), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() =>
      expect(`${window.location.pathname}${window.location.search}`).toBe("/admin/revenue?x=1"),
    );
    expect(paths).toEqual(["/api/v1/sessions/step-up/initiate", "/api/v1/sessions/step-up"]);
  });
});
