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

function clientWith(
  tenant: "tenant" | "suspended" | "none" | "throws",
  memberships = [MEMBERSHIP],
) {
  const post = vi.fn(async () => ({ data: undefined, error: undefined }));
  const client = {
    GET: vi.fn(async (path: string) => {
      if (path === "/api/v1/public/tenant") {
        if (tenant === "throws") throw new Error("network");
        if (tenant === "suspended") return { data: { status: "suspended" } };
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
  });

  it("falls back to the picker when the automatic binding request is rejected", async () => {
    const { client, post } = clientWith("tenant");
    post.mockRejectedValueOnce(new Error("network"));
    withClient(client, <OrganizationSelect />);
    const pick = await screen.findByRole("button", { name: /Cedar Ridge Hospice/ });
    expect(post).toHaveBeenCalledTimes(1);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    fireEvent.click(pick); // the person can retry with a click
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("explains a wrong-organization refusal, names the host's organization and offers sign-out and retry", async () => {
    const { client, post } = clientWith("tenant");
    post.mockResolvedValueOnce({
      data: undefined,
      error: { error: { code: "TENANT_HOST_MISMATCH" } },
    } as never);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    withClient(client, <OrganizationSelect />);
    expect(await screen.findByText(/belongs to Cedar Ridge Hospice/)).toBeTruthy();
    // True for a non-member and for a member of another organization alike: it must not claim the account is no member at all.
    expect(screen.queryByText(/not a member/)).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
    expect(assign).not.toHaveBeenCalledWith("/");
  });

  it("Try again re-runs the load in place instead of reloading the page (a reload ended on /expired)", async () => {
    const { client, post } = clientWith("tenant");
    post.mockResolvedValueOnce({
      data: undefined,
      error: { error: { code: "TENANT_HOST_MISMATCH" } },
    } as never);
    const assign = vi.fn();
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign, reload });
    withClient(client, <OrganizationSelect />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    expect(post).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
  });

  it("shows an error with actions when the load itself throws", async () => {
    const { client } = clientWith("tenant");
    (client.GET as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    withClient(client, <OrganizationSelect />);
    expect(await screen.findByText(/Something went wrong/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("does not auto-bind on a tenant host that is not active (suspended), and asks the tenant lookup in parallel", async () => {
    const { client, post } = clientWith("suspended");
    withClient(client, <OrganizationSelect />);
    expect(await screen.findByRole("button", { name: /Cedar Ridge Hospice/ })).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    const calls = (client.GET as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls.indexOf("/api/v1/public/tenant")).toBeGreaterThan(
      calls.indexOf("/api/v1/auth/credential-status"),
    );
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
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: "nurse@example.org" } });
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

  it("announces the confirmation as a status region and moves focus to its heading", async () => {
    const { client } = clientWith("none");
    await submit(client);
    const heading = await screen.findByRole("heading", { name: "Check your email" });
    expect(heading.closest("[role=status]")).toBeTruthy();
    expect(document.activeElement).toBe(heading);
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
    ["app.chartwarden.com", "chartwarden.com", true],
    ["APP.chartwarden.com.", "Chartwarden.com", true],
    ["app.chartwarden.localhost", "chartwarden.localhost", true],
    ["app.chartwarden.com", undefined, false], // no base domain configured: a single-host deployment at app.<domain>
    ["app.chartwarden.com", "", false],
    ["app.demo.example.org", "chartwarden.com", false],
    ["acme.chartwarden.com", "chartwarden.com", false],
    ["myapp.chartwarden.com", "chartwarden.com", false],
    ["x.app.chartwarden.com", "chartwarden.com", false],
    ["chartwarden.com", "chartwarden.com", false],
  ])("%s with base %s -> %s", (host, base, expected) => {
    expect(isAppLandingHost(host, base)).toBe(expected);
  });
});
