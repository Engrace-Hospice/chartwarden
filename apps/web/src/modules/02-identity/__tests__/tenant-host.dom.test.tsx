import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// @vitest-environment jsdom
// ADR-0049 Phase 4 web: tenant sign-in copy, the skipped organization picker, and the app.<base> landing.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../auth-client", () => ({
  authClient: { signIn: {}, signOut: vi.fn(), getSession: vi.fn() },
}));

import { AppLanding } from "../app-landing";
import { OrganizationSelect } from "../organization-select";
import { SignIn } from "../sign-in";
import { isAppLandingHost } from "../tenant-info";

const MEMBERSHIP = {
  membershipId: "m-1",
  organizationId: "o-1",
  organizationName: "Cedar Ridge Hospice",
  status: "active",
  isAdmin: false,
  defaultLocationIds: [],
};

function clientWith(tenant: "tenant" | "none" | "throws", memberships = [MEMBERSHIP]) {
  const post = vi.fn(async () => ({ data: undefined, error: undefined }));
  const client = {
    GET: vi.fn(async (path: string) => {
      if (path === "/api/v1/public/tenant") {
        if (tenant === "throws") throw new Error("network");
        return tenant === "tenant"
          ? { data: { status: "active", displayName: "Cedar Ridge Hospice" } }
          : { data: undefined, error: { error: { code: "TENANT_HOST_UNKNOWN" } } };
      }
      if (path.endsWith("/credential-status")) return { data: { passwordChangeRequired: false } };
      return { data: { memberships } };
    }),
    POST: post,
  } as unknown as ApiClient;
  return { client, post };
}

const withClient = (client: ApiClient, ui: React.ReactNode) =>
  render(
    <ApiClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </ApiClientProvider>,
  );

afterEach(() => vi.restoreAllMocks());

describe("SignIn on a tenant host", () => {
  it("shows the organization's name", async () => {
    withClient(clientWith("tenant").client, <SignIn />);
    expect(await screen.findByText("Sign in to Cedar Ridge Hospice")).toBeTruthy();
  });

  it.each(["none", "throws"] as const)(
    "keeps the generic copy and the form when the lookup is %s",
    async (mode) => {
      const { client } = clientWith(mode);
      withClient(client, <SignIn />);
      await waitFor(() => expect(client.GET).toHaveBeenCalledWith("/api/v1/public/tenant"));
      expect(screen.getByText("Welcome back. Sign in to continue.")).toBeTruthy();
      expect(screen.getByLabelText("Password")).toBeTruthy();
    },
  );
});

describe("OrganizationSelect on a tenant host", () => {
  it("binds the single matching organization without a click", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const { client, post } = clientWith("tenant");
    withClient(client, <OrganizationSelect />);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/auth/select-organization", {
        body: { organizationId: "o-1" },
      }),
    );
    expect(screen.queryByRole("button", { name: /Cedar Ridge/ })).toBeNull();
    vi.unstubAllGlobals();
  });

  it("keeps the picker on the demo host", async () => {
    const { client, post } = clientWith("none");
    withClient(client, <OrganizationSelect />);
    expect(await screen.findByRole("button", { name: /Cedar Ridge Hospice/ })).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps the picker on a tenant host when there is more than one membership", async () => {
    const other = {
      ...MEMBERSHIP,
      membershipId: "m-2",
      organizationId: "o-2",
      organizationName: "Other",
    };
    const { client, post } = clientWith("tenant", [MEMBERSHIP, other]);
    withClient(client, <OrganizationSelect />);
    expect(await screen.findByRole("button", { name: /Other/ })).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });
});

describe("AppLanding", () => {
  const CONFIRMATION = /If that address belongs to an organization, we.ve emailed sign-in links/;
  const submit = async (client: ApiClient) => {
    withClient(client, <AppLanding />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "nurse@example.org" } });
    fireEvent.click(screen.getByRole("button", { name: /Email me/ }));
  };

  it("posts the email and shows the neutral confirmation", async () => {
    const { client, post } = clientWith("none");
    await submit(client);
    expect(await screen.findByText(CONFIRMATION)).toBeTruthy();
    expect(post).toHaveBeenCalledWith("/api/v1/public/find-my-organization", {
      body: { email: "nurse@example.org" },
    });
  });

  it.each(["rejected", "error"])(
    "shows the same confirmation when the request %s",
    async (mode) => {
      const { client, post } = clientWith("none");
      post.mockImplementation(async () => {
        if (mode === "rejected") throw new Error("network");
        return { data: undefined, error: { error: { code: "RATE_LIMITED" } } } as never;
      });
      await submit(client);
      expect(await screen.findByText(CONFIRMATION)).toBeTruthy();
    },
  );
});

describe("isAppLandingHost", () => {
  it.each([
    ["app.chartwarden.com", true],
    ["APP.chartwarden.com.", true],
    ["app.chartwarden.localhost", true],
    ["app.localhost", false],
    ["app", false],
    ["acme.chartwarden.com", false],
    ["myapp.chartwarden.com", false],
    ["chartwarden.com", false],
  ])("%s -> %s", (host, expected) => {
    expect(isAppLandingHost(host)).toBe(expected);
  });
});
