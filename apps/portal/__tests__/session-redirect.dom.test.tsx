// #593 — a protected portal page with no session lands on the sign-in with a return path, never the shell.
import { createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PortalApp } from "../src/app";
import { createSessionGuard } from "../src/session-guard";

const PID = "11111111-1111-4111-8111-111111111111";

function app(handler: (url: string) => Response) {
  const guard = createSessionGuard();
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (request) => {
      const url = request instanceof Request ? request.url : String(request);
      // A synthesized Response has no url; a browser fetch always does, and the guard reads it.
      return Object.defineProperty(handler(url), "url", { value: url });
    },
    onResponseStatus: guard.onResponseStatus,
  });
  return <PortalApp client={client} sessionGuard={guard} />;
}
const unauthorized = () =>
  new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "no" } }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

describe("expired portal session", () => {
  it.each([`/portal/p/${PID}/care-plan`, "/portal/account", `/portal/p/${PID}`])(
    "redirects %s to sign-in with next and never shows the shell",
    async (path) => {
      window.history.pushState({}, "", path);
      render(app(unauthorized));
      await waitFor(() => expect(window.location.pathname).toMatch(/^\/portal\/?$/));
      const next = new URLSearchParams(window.location.search).get("next");
      expect(next).toBe(path.replace("/portal", ""));
      expect(screen.queryByRole("navigation", { name: "Portal navigation" })).toBeNull();
      expect(screen.queryByText(/Viewing care for/)).toBeNull();
      expect(screen.queryByText(/Your session has ended/)).toBeNull();
    },
  );

  it("does not redirect the chromeless funeral case page", async () => {
    window.history.pushState({}, "", "/portal/funeral/case");
    render(app(unauthorized));
    await new Promise((r) => setTimeout(r, 50));
    expect(window.location.pathname).toBe("/portal/funeral/case");
  });

  it("sign-in honours next after password sign-in", async () => {
    const target = `/p/${PID}/care-plan`;
    window.history.pushState({}, "", `/portal/?next=${encodeURIComponent(target)}`);
    const handler = (url: string): Response => {
      if (url.includes("/api/auth/sign-in/email")) return Response.json({});
      if (url.includes("/portal/sign-in/accounts"))
        return Response.json({
          items: [
            {
              portalAccountId: "a1",
              organizationName: "O",
              relationship: "x",
              blockedReason: null,
            },
          ],
        });
      if (url.includes("/portal/sign-in/establish")) return Response.json({});
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => handler(String(input)));
    try {
      render(app(handler));
      const email = await screen.findByLabelText(/email/i);
      const passwordToggle = screen.queryByRole("button", { name: /password/i });
      if (passwordToggle) fireEvent.click(passwordToggle);
      fireEvent.change(email, { target: { value: "a@b.co" } });
      const pw = await screen.findByLabelText(/^password/i);
      fireEvent.change(pw, { target: { value: "pw-pw-pw-pw" } });
      fireEvent.submit(pw.closest("form") as HTMLFormElement);
      await waitFor(() => expect(window.location.pathname).toBe(`/portal${target}`));
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
