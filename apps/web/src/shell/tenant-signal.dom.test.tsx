// @vitest-environment jsdom
// ADR-0049 end to end through the real API client: a 410 TENANT_CLOSED body on an /api/ call reaches the global signal
// via `handleObservedResponse` and the shell navigates to /tenant-unavailable; once there, a further signal is a no-op.
import { createApiClient } from "@chartwarden/ui";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./app";
import { getGlobalResponseSignal, handleObservedResponse, setGlobalResponseSignal } from "./global-response-signal";
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

function mount(fetch: () => Promise<Response>, at: string) {
  const registry = createScreenRegistry();
  registry.register(systemScreens);
  window.history.pushState({}, "", at);
  const client = createApiClient({ baseUrl: "http://localhost", fetch, onResponseStatus: handleObservedResponse });
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
    const client = mount(refusal("TENANT_HOST_UNKNOWN", 404), "/tenant-unavailable?reason=suspended");
    expect(await screen.findByRole("heading", { name: /suspended/i })).toBeTruthy();
    await client.GET("/api/v1/patients" as never, {} as never);
    await waitFor(() => expect(getGlobalResponseSignal()).toBeNull());
    expect(window.location.search).toBe("?reason=suspended");
    expect(screen.getByRole("heading", { name: /suspended/i })).toBeTruthy();
  });
});
