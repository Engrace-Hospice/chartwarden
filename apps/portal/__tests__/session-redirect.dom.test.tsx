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

  it("shows a calm notice on the sign-in screen only when the redirect carries reason=expired", async () => {
    window.history.pushState({}, "", `/portal/p/${PID}/care-plan`);
    const view = render(app(unauthorized));
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/portal\/?$/));
    expect(new URLSearchParams(window.location.search).get("reason")).toBe("expired");
    expect(await screen.findByText("Your session ended. Please sign in again.")).toBeTruthy();
    expect(screen.queryByText(/UNAUTHENTICATED/)).toBeNull();
    view.unmount();

    window.history.pushState({}, "", "/portal/");
    render(app(unauthorized));
    await screen.findByLabelText(/email/i);
    expect(screen.queryByText("Your session ended. Please sign in again.")).toBeNull();
  });

  const OTHER = "22222222-2222-4222-8222-222222222222";
  const OTHER2 = "33333333-3333-4333-8333-333333333333";
  const target = `/p/${PID}/care-plan`;

  /** Drives the password form to completion; `granted` is what /sessions/patients answers. */
  async function passwordSignIn(
    granted: string[],
    twoFactor = false,
    holdAtSignedIn = false,
    opts: { selectStatus?: number; patientsStatus?: number; accounts?: number } = {},
  ) {
    window.history.pushState({}, "", `/portal/?next=${encodeURIComponent(target)}`);
    const posts: string[] = [];
    const handler = (url: string): Response => {
      if (url.includes("/api/auth/sign-in/email"))
        return Response.json(twoFactor ? { twoFactorRedirect: true } : {});
      if (url.includes("/two-factor/verify-totp")) return Response.json({});
      if (url.includes("/portal/sign-in/accounts") && holdAtSignedIn)
        return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
      if (url.includes("/portal/sign-in/accounts"))
        return Response.json({
          items: Array.from({ length: opts.accounts ?? 1 }, (_, i) => ({
            portalAccountId: `a${i + 1}`,
            organizationName: `Org ${i + 1}`,
            relationship: "x",
            blockedReason: null,
          })),
        });
      if (url.includes("/portal/sign-in/establish")) return Response.json({});
      if (url.includes("/portal/sessions/patients") && opts.patientsStatus)
        return new Response("{}", {
          status: opts.patientsStatus,
          headers: { "content-type": "application/json" },
        });
      if (url.includes("/portal/sessions/patients"))
        return Response.json({
          items: granted.map((patientId) => ({
            patientId,
            grantId: `g-${patientId}`,
            grantKind: "family",
            layPatientLabel: "Someone",
          })),
        });
      if (url.includes("/portal/sessions/select-patient")) {
        posts.push(url);
        if (opts.selectStatus)
          return new Response("{}", {
            status: opts.selectStatus,
            headers: { "content-type": "application/json" },
          });
        return Response.json({});
      }
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => handler(String(input)));
    render(app(handler));
    const email = await screen.findByLabelText(/email/i);
    const passwordToggle = screen.queryByRole("button", { name: /password/i });
    if (passwordToggle) fireEvent.click(passwordToggle);
    fireEvent.change(email, { target: { value: "a@b.co" } });
    const pw = await screen.findByLabelText(/^password/i);
    fireEvent.change(pw, { target: { value: "pw-pw-pw-pw" } });
    fireEvent.submit(pw.closest("form") as HTMLFormElement);
    return { posts, fetchSpy };
  }

  it("sign-in honours next after password sign-in when the patient is granted, binding the session", async () => {
    const { posts, fetchSpy } = await passwordSignIn([PID]);
    try {
      await waitFor(() => expect(window.location.pathname).toBe(`/portal${target}`));
      expect(posts).toHaveLength(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("falls back to the picker when next names a patient the account is not granted", async () => {
    // Two other patients: a lone granted patient would auto-open from the picker.
    const { posts, fetchSpy } = await passwordSignIn([OTHER, OTHER2]);
    try {
      await waitFor(() => expect(window.location.pathname).toBe("/portal/patient-picker"));
      expect(posts).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("falls back to the picker, never the patient route, when select-patient fails for a granted patient", async () => {
    const landed: string[] = [];
    const { posts, fetchSpy } = await passwordSignIn([PID, OTHER], false, false, {
      selectStatus: 403,
    });
    const track = setInterval(() => landed.push(window.location.pathname), 5);
    try {
      await waitFor(() => expect(window.location.pathname).toBe("/portal/patient-picker"));
      expect(posts).toHaveLength(1);
      expect(landed.some((p) => p.includes("/p/"))).toBe(false);
    } finally {
      clearInterval(track);
      fetchSpy.mockRestore();
    }
  });

  it("falls back to the picker when the patient list fails", async () => {
    const { posts, fetchSpy } = await passwordSignIn([PID], false, false, { patientsStatus: 500 });
    try {
      await waitFor(() => expect(window.location.pathname).toBe("/portal/patient-picker"));
      expect(posts).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("honours next after choosing among several accounts, binding the session", async () => {
    const { posts, fetchSpy } = await passwordSignIn([PID], false, false, { accounts: 2 });
    try {
      fireEvent.click(await screen.findByRole("button", { name: /Org 2/ }));
      await waitFor(() => expect(window.location.pathname).toBe(`/portal${target}`));
      expect(posts).toHaveLength(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("carries next through the authenticator-code step to /signed-in", async () => {
    const { fetchSpy } = await passwordSignIn([PID], true, true);
    try {
      const code = await screen.findByRole("textbox", { name: /authenticator code/i });
      fireEvent.change(code, { target: { value: "123456" } });
      fireEvent.submit(code.closest("form") as HTMLFormElement);
      await waitFor(() => expect(window.location.pathname).toBe("/portal/signed-in"));
      expect(new URLSearchParams(window.location.search).get("next")).toBe(target);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
