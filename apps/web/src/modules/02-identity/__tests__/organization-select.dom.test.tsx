import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// @vitest-environment jsdom
// A freshly invited org_admin has no passkey, and the server refuses `select-organization` (403
// MFA_ENROLMENT_REQUIRED) until one is registered. The screen used to answer "Contact your administrator" and the
// only passkey screen sat behind the pre-org guard, so the admin could neither bind an org nor register a passkey.
// The refusal now says what is required and links to a pre-org passkey registration page.
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberPendingNotificationLink } from "../../../shell/pending-deep-link";
import { OrganizationSelect } from "../organization-select";

const MEMBERSHIP = {
  membershipId: "m-1",
  organizationId: "o-1",
  organizationName: "Cedar Ridge Hospice",
  status: "active",
  isAdmin: true,
  defaultLocationIds: [],
};

function renderWithSelectError(error: unknown): void {
  const client = {
    GET: vi.fn(async (path: string) =>
      path.endsWith("/credential-status")
        ? { data: { passwordChangeRequired: false } }
        : { data: { memberships: [MEMBERSHIP] } },
    ),
    POST: vi.fn(async () => ({ data: undefined, error })),
  } as unknown as ApiClient;
  render(
    <ApiClientProvider client={client}>
      <OrganizationSelect />
    </ApiClientProvider>,
  );
}

const refusal = (message: string) => ({
  error: { code: "MFA_ENROLMENT_REQUIRED", message, correlationId: "c" },
});

describe("OrganizationSelect MFA refusal", () => {
  it("tells an org_admin with no passkey to register one, and links to the pre-org page", async () => {
    renderWithSelectError(refusal("register a passkey before continuing (required for your role)"));

    fireEvent.click(await screen.findByRole("button", { name: /Cedar Ridge Hospice/ }));

    expect(await screen.findByText(/register a passkey before continuing/i)).toBeTruthy();
    const link = screen.getByRole("link", { name: /register a passkey/i });
    expect(link.getAttribute("href")).toBe(
      `/login/passkey?returnTo=${encodeURIComponent("/login/organization")}`,
    );
  });

  it("sends a user who has a passkey but did not prove it this session back to sign in", async () => {
    renderWithSelectError(
      refusal("sign in again with your passkey before continuing (required for your role)"),
    );

    fireEvent.click(await screen.findByRole("button", { name: /Cedar Ridge Hospice/ }));

    const link = await screen.findByRole("link", { name: /sign in again/i });
    expect(link.getAttribute("href")).toBe("/login");
  });

  it("keeps the generic message and offers no enrolment link for any other refusal", async () => {
    renderWithSelectError({ error: { code: "FORBIDDEN", message: "no", correlationId: "c" } });

    fireEvent.click(await screen.findByRole("button", { name: /Cedar Ridge Hospice/ }));

    expect(await screen.findByText(/contact your administrator/i)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("OrganizationSelect finishing a notification link", () => {
  const assign = vi.fn();
  beforeEach(() => {
    window.sessionStorage.clear();
    assign.mockClear();
    vi.stubGlobal("location", { ...window.location, assign });
  });
  afterEach(() => vi.unstubAllGlobals());

  function renderSelectSucceeding(): void {
    const client = {
      GET: vi.fn(async (path: string) =>
        path.endsWith("/credential-status")
          ? { data: { passwordChangeRequired: false } }
          : { data: { memberships: [MEMBERSHIP] } },
      ),
      POST: vi.fn(async () => ({ data: {}, error: undefined })),
    } as unknown as ApiClient;
    render(
      <ApiClientProvider client={client}>
        <OrganizationSelect />
      </ApiClientProvider>,
    );
  }

  it("loads the rebuilt /n/<id> when a link was stashed before sign-in", async () => {
    rememberPendingNotificationLink("/n/abc-123");
    renderSelectSucceeding();

    fireEvent.click(await screen.findByRole("button", { name: /Cedar Ridge Hospice/ }));

    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith("/n/abc-123"));
  });

  it("loads the home page when nothing was stashed", async () => {
    renderSelectSucceeding();

    fireEvent.click(await screen.findByRole("button", { name: /Cedar Ridge Hospice/ }));

    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
  });
});
