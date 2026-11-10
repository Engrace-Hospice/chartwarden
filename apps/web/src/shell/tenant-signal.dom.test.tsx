// @vitest-environment jsdom
// ADR-0049 end to end through the real API client: a 410 TENANT_CLOSED body on an /api/ call reaches the global signal
// via `handleObservedResponse` and the shell navigates to /tenant-unavailable; once there, a further signal is a no-op.
import { createApiClient } from "@chartwarden/ui";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./app";
import {
  getGlobalResponseSignal,
  handleObservedResponse,
  setGlobalResponseSignal,
  subscribeGlobalResponseSignal,
} from "./global-response-signal";
import { createScreenRegistry } from "./screen-registry";
import { systemScreens } from "./system-pages";

const refusal = (code: string, status: number) => async (): Promise<Response> => {
  const res = new Response(JSON.stringify({ error: { code, message: "x" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
  Object.defineProperty(res, "url", { value: "http://localhost/api/v1/patients" }); // a constructed Response has none
  return res;
};

afterEach(() => {
  setGlobalResponseSignal(null);
  vi.unstubAllGlobals();
});

function mount(
  fetch: () => Promise<Response>,
  at: string,
  sessionOver: { organizationStage?: "onboarding" | "live" } = {},
) {
  const registry = createScreenRegistry();
  registry.register(systemScreens);
  window.history.pushState({}, "", at);
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch,
    onResponseStatus: handleObservedResponse,
  });
  render(
    <AppShell
      registry={registry}
      client={client}
      session={{
        userId: "u",
        organizationId: "o",
        membershipId: "m",
        displayName: "N",
        organizationName: "Org",
        roles: ["administrator"],
        isAdmin: true,
        permissions: [],
        ...sessionOver,
      }}
    />,
  );
  return client;
}

describe("tenant refusal end to end", () => {
  it("routes a 410 TENANT_CLOSED response body to /tenant-unavailable?reason=closed", async () => {
    const client = mount(refusal("TENANT_CLOSED", 410), "/");
    await client.GET("/api/v1/patients" as never, {} as never);
    expect(await screen.findByRole("heading", { name: /no longer on ChartWarden/i })).toBeTruthy();
    expect(window.location.pathname).toBe("/tenant-unavailable");
    expect(window.location.search).toBe("?reason=closed");
    expect(getGlobalResponseSignal()).toBeNull(); // consumed
  });

  it("does not navigate again when already on /tenant-unavailable (the page keeps its reason)", async () => {
    const client = mount(
      refusal("TENANT_HOST_UNKNOWN", 404),
      "/tenant-unavailable?reason=suspended",
    );
    expect(await screen.findByRole("heading", { name: /suspended/i })).toBeTruthy();
    await client.GET("/api/v1/patients" as never, {} as never);
    await waitFor(() => expect(getGlobalResponseSignal()).toBeNull());
    expect(window.location.search).toBe("?reason=suspended");
    expect(screen.getByRole("heading", { name: /suspended/i })).toBeTruthy();
  });
});

// #589 phase 2 - the shell sends a signed-in-but-org-less 401 to the org picker rather than /expired.
describe("org-less 401 end to end", () => {
  it("routes a 401 ORGANIZATION_NOT_SELECTED body to /login/organization, not /expired", async () => {
    const client = mount(refusal("ORGANIZATION_NOT_SELECTED", 401), "/");
    await client.GET("/api/v1/patients" as never, {} as never);
    await waitFor(() => expect(window.location.pathname).toBe("/login/organization"));
    expect(getGlobalResponseSignal()).toBeNull(); // consumed
  });

  it("does not pull the user off /expired when a late org-less 401 follows a genuine one", async () => {
    let code = "UNAUTHORIZED";
    const client = mount(async () => refusal(code, 401)(), "/");
    await client.GET("/api/v1/patients" as never, {} as never);
    await waitFor(() => expect(window.location.pathname).toBe("/expired"));

    code = "ORGANIZATION_NOT_SELECTED";
    await client.GET("/api/v1/patients" as never, {} as never);
    await waitFor(() => expect(getGlobalResponseSignal()).toBeNull());
    expect(window.location.pathname).toBe("/expired");
  });
});

// A generous wait: the first test mounts the whole shell and the suite runs beside many others.
const SETTLE = { timeout: 5000 };

/**
 * Starts listening for a signal of `kind` and returns a function that resolves once one has been raised AND consumed by the shell.
 * "The signal is null" alone would pass whether the signal never fired or was consumed; this proves it fired.
 */
function expectSignalHandled(kind: string): () => Promise<void> {
  let raised = false;
  const stop = subscribeGlobalResponseSignal(() => {
    if (getGlobalResponseSignal()?.kind === kind) raised = true;
  });
  return async () => {
    await waitFor(() => expect(raised).toBe(true), SETTLE);
    await waitFor(() => expect(getGlobalResponseSignal()).toBeNull(), SETTLE);
    stop();
  };
}

describe("organization onboarding refusal end to end", () => {
  it("routes a 403 ORGANIZATION_ONBOARDING (stage unknown) to /admin/onboarding, and not again once there", async () => {
    const client = mount(refusal("ORGANIZATION_ONBOARDING", 403), "/");
    const first = expectSignalHandled("organization-onboarding");
    await client.GET("/api/v1/patients" as never, {} as never);
    await first();
    await waitFor(() => expect(window.location.pathname).toBe("/admin/onboarding"), SETTLE);
    // The wizard's own refused call must not bounce it: there is nowhere further to go.
    const second = expectSignalHandled("organization-onboarding");
    await client.GET("/api/v1/patients" as never, {} as never);
    await second();
    expect(window.location.pathname).toBe("/admin/onboarding");
  });

  it("leaves the person where they are when the session already says onboarding (the screen guard routes; a refused background call is noise)", async () => {
    const client = mount(refusal("ORGANIZATION_ONBOARDING", 403), "/admin/setup", {
      organizationStage: "onboarding",
    });
    const handled = expectSignalHandled("organization-onboarding");
    await client.GET("/api/v1/alerts/inbox" as never, {} as never);
    await handled();
    expect(window.location.pathname).toBe("/admin/setup");
  });

  it("leaves a screen that works while onboarding alone, even when the stage is unknown", async () => {
    const client = mount(refusal("ORGANIZATION_ONBOARDING", 403), "/admin/account");
    const handled = expectSignalHandled("organization-onboarding");
    await client.GET("/api/v1/alerts/inbox" as never, {} as never);
    await handled();
    expect(window.location.pathname).toBe("/admin/account");
  });
});
