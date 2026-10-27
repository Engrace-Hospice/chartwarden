import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// @vitest-environment jsdom
// GAP-009 — the accept page when the visitor is already signed in. The server binds the one-time token to
// the invited address (403 INVITATION_EMAIL_MISMATCH, token NOT burned), so the page must say "wrong
// account" up front — not "invalid or expired", and not claim the INVITED address is the current account.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
const signOut = vi.fn(async () => ({ error: null }));
vi.mock("../auth-client", () => ({
  authClient: {
    getSession: () => getSession(),
    signOut: () => signOut(),
    signUp: { email: vi.fn() },
  },
}));

import { AcceptInvitation } from "../accept-invitation";

const INVITED = "Invitee@Example.test";

function clientFor(accept: { error?: unknown } = {}): ApiClient {
  return {
    GET: vi.fn(async () => ({
      data: { email: INVITED, organizationName: "Demo Hospice" },
      error: undefined,
    })),
    POST: vi.fn(async () => ({ data: accept.error ? undefined : { status: "active" }, ...accept })),
  } as unknown as ApiClient;
}

function renderPage(client: ApiClient): void {
  render(
    <MemoryRouter initialEntries={["/invite/tok-1"]}>
      <ApiClientProvider client={client}>
        <Routes>
          <Route path="/invite/:token" element={<AcceptInvitation />} />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

const signedInAs = (email: string | null) =>
  getSession.mockResolvedValue({ data: email ? { user: { id: "u1", email } } : null, error: null });

describe("AcceptInvitation — signed-in visitors", () => {
  beforeEach(() => {
    getSession.mockReset();
    signOut.mockClear();
  });

  it("signed out → the create-account form for the invited address", async () => {
    signedInAs(null);
    renderPage(clientFor());
    expect(await screen.findByText("Create your account")).toBeTruthy();
  });

  it("signed in as the invited address (any letter case) → accept button naming the SESSION account", async () => {
    signedInAs("invitee@example.test");
    renderPage(clientFor());
    expect(await screen.findByRole("button", { name: "Accept invitation" })).toBeTruthy();
    expect(screen.getByText(/with your current account \(invitee@example\.test\)/)).toBeTruthy();
  });

  it("signed in as someone else → says so up front, names both addresses, offers sign-out, no accept button", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    signedInAs("someone.else@example.test");
    renderPage(clientFor());
    expect(await screen.findByText(/was sent to/)).toBeTruthy();
    expect(screen.getByText(INVITED)).toBeTruthy();
    expect(screen.getByText("someone.else@example.test")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept invitation" })).toBeNull();
    expect(screen.queryByText(/invalid or has expired/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1)); // back to the link, signed out
    vi.unstubAllGlobals();
  });

  it("a server 403 INVITATION_EMAIL_MISMATCH on accept shows the wrong-account screen, not 'expired'", async () => {
    signedInAs("invitee@example.test"); // the page's own check passes; the server still refuses
    renderPage(clientFor({ error: { error: { code: "INVITATION_EMAIL_MISMATCH" } } }));
    fireEvent.click(await screen.findByRole("button", { name: "Accept invitation" }));
    expect(await screen.findByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.queryByText(/invalid or has expired/)).toBeNull();
  });

  it("any other accept failure still reads 'invalid or has expired'", async () => {
    signedInAs("invitee@example.test");
    renderPage(clientFor({ error: { error: { code: "LINK_EXPIRED" } } }));
    fireEvent.click(await screen.findByRole("button", { name: "Accept invitation" }));
    expect(await screen.findByText(/invalid or has expired/)).toBeTruthy();
  });
});
