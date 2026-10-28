import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// @vitest-environment jsdom
// M34 first-admin invitation (`tenant_invitation`) — the page the provisioning email links to. It is NOT the M2
// org-invitation page: that one peeks `organization_invitation`, so a tenant token reads "invalid or expired" there.
// This page redeems the token at POST /api/v1/public/tenant-invitations/:token/accept (which creates the user +
// first org_admin membership) and then sends the standard password-reset email so the admin can set a password.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requestPasswordReset = vi.fn();
vi.mock("../auth-client", () => ({
  authClient: { requestPasswordReset: (input: unknown) => requestPasswordReset(input) },
}));

import { AcceptTenantInvitation } from "../accept-tenant-invitation";

const ADMIN_EMAIL = "admin@sunrise.test";

function clientFor(result: { data?: unknown; error?: unknown }): {
  client: ApiClient;
  post: ReturnType<typeof vi.fn>;
} {
  const post = vi.fn(async () => result);
  return { client: { POST: post } as unknown as ApiClient, post };
}

function renderPage(client: ApiClient): void {
  render(
    <MemoryRouter initialEntries={["/tenant-invite/tok-1"]}>
      <ApiClientProvider client={client}>
        <Routes>
          <Route path="/tenant-invite/:token" element={<AcceptTenantInvitation />} />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("AcceptTenantInvitation", () => {
  beforeEach(() => {
    requestPasswordReset.mockReset();
    requestPasswordReset.mockResolvedValue({ error: null });
  });

  it("redeems the token from the URL, then emails a password-reset link to the invited address", async () => {
    const { client, post } = clientFor({ data: { accepted: true, email: ADMIN_EMAIL } });
    renderPage(client);

    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Sunrise Admin" } });
    fireEvent.click(screen.getByRole("button", { name: "Accept invitation" }));

    expect(await screen.findByText("Check your email")).toBeTruthy();
    expect(post).toHaveBeenCalledWith("/api/v1/public/tenant-invitations/{tokenHash}/accept", {
      params: { path: { tokenHash: "tok-1" } },
      body: { displayName: "Sunrise Admin" },
    });
    expect(requestPasswordReset).toHaveBeenCalledWith({
      email: ADMIN_EMAIL,
      redirectTo: `${window.location.origin}/reset-password`,
    });
    expect(screen.getByText(ADMIN_EMAIL)).toBeTruthy();
  });

  it("omits displayName when the name field is left blank", async () => {
    const { client, post } = clientFor({ data: { accepted: true, email: ADMIN_EMAIL } });
    renderPage(client);

    fireEvent.click(screen.getByRole("button", { name: "Accept invitation" }));

    await screen.findByText("Check your email");
    expect(post).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: {} }));
  });

  it("a refused token reads invalid or expired and sends no reset email", async () => {
    const { client } = clientFor({ error: { error: { code: "INVITATION_INVALID" } } });
    renderPage(client);

    fireEvent.click(screen.getByRole("button", { name: "Accept invitation" }));

    expect(await screen.findByText(/invalid or has expired/i)).toBeTruthy();
    expect(requestPasswordReset).not.toHaveBeenCalled();
  });

  it("a reset request that throws (network drop) after acceptance does not leave the page stuck on Accepting", async () => {
    requestPasswordReset.mockRejectedValue(new Error("network down"));
    const { client } = clientFor({ data: { accepted: true, email: ADMIN_EMAIL } });
    renderPage(client);

    fireEvent.click(screen.getByRole("button", { name: "Accept invitation" }));

    expect(await screen.findByRole("link", { name: /forgot password/i })).toBeTruthy();
    expect(screen.getByText(/invitation is accepted/i)).toBeTruthy();
  });

  it("a network failure on the accept call shows a retryable error instead of sticking on Accepting", async () => {
    const post = vi.fn().mockRejectedValueOnce(new Error("offline"));
    renderPage({ POST: post } as unknown as ApiClient);

    fireEvent.click(screen.getByRole("button", { name: "Accept invitation" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/try again/i);
    expect(screen.queryByText(/invalid or has expired/i)).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Accept invitation" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("a server error (5xx) is retryable, not reported as an invalid invitation", async () => {
    const post = vi.fn(async () => ({ error: { error: {} }, response: { status: 503 } }));
    renderPage({ POST: post } as unknown as ApiClient);

    fireEvent.click(screen.getByRole("button", { name: "Accept invitation" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/try again/i);
    expect(screen.queryByText(/invalid or has expired/i)).toBeNull();
  });

  it("two rapid submits send a single accept request", async () => {
    const { client, post } = clientFor({ data: { accepted: true, email: ADMIN_EMAIL } });
    renderPage(client);
    const form = screen
      .getByRole("button", { name: "Accept invitation" })
      .closest("form") as HTMLFormElement;

    fireEvent.submit(form);
    fireEvent.submit(form);

    await screen.findByText("Check your email");
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("an accepted invitation whose reset email fails still points the admin at /forgot-password", async () => {
    requestPasswordReset.mockResolvedValue({ error: { message: "mail down" } });
    const { client } = clientFor({ data: { accepted: true, email: ADMIN_EMAIL } });
    renderPage(client);

    fireEvent.click(screen.getByRole("button", { name: "Accept invitation" }));

    await waitFor(() =>
      expect(screen.getByRole("link", { name: /forgot password/i })).toBeTruthy(),
    );
    expect(screen.getByText(/invitation is accepted/i)).toBeTruthy();
  });
});
