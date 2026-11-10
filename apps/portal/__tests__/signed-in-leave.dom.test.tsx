// "Back to sign in" signs out and navigates inside the SPA (no page reload), so the API client's held Idempotency-Keys must be dropped
// there: the next person to sign in on this page must not inherit them.
import { createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortalApp } from "../src/app";

afterEach(() => vi.unstubAllGlobals());

describe("the portal's Back to sign in", () => {
  it("drops the held Idempotency-Keys, even before the sign-out call is answered", async () => {
    // Never settles: proves the keys were dropped BEFORE the sign-out was awaited.
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => undefined)));
    const keys: (string | null)[] = [];
    const client = createApiClient({
      baseUrl: "http://localhost",
      fetch: async (request) => {
        if (new URL(request.url).pathname.endsWith("/sign-in/accounts")) {
          throw new TypeError("Failed to fetch"); // the portal cannot open: it offers Back to sign in
        }
        keys.push(request.headers.get("Idempotency-Key"));
        if (keys.length === 1) throw new TypeError("Failed to fetch"); // the first write's reply is lost
        return new Response("{}", { status: 200 });
      },
    });
    const write = () =>
      client.POST("/api/v1/x" as never, { body: { a: 1 } } as never).catch(() => undefined);
    await write();
    window.history.pushState({}, "", "/portal/signed-in");
    render(<PortalApp client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Back to sign in" }));
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    await write(); // the next person on this page

    expect(keys[1]).not.toBe(keys[0]);
  });
});
