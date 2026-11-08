// The organization picker: a signed-in platform-ops user chooses the org that binds the session. It lists only ACTIVE
// memberships (one `wx-drawer-card` row each, named by its Select button) and says so when there is none.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { OrganizationSelect } from "./organization-select";

const membership = (id: string, organizationName: string, status: string, isAdmin = false) => ({
  membershipId: `membership-${id}`,
  organizationId: `org-${id}`,
  organizationName,
  status,
  isAdmin,
  defaultLocationIds: [],
});

function mount(memberships: unknown[]): void {
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: async () =>
      new Response(JSON.stringify({ memberships }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  render(
    <ApiClientProvider client={client}>
      <MemoryRouter>
        <OrganizationSelect />
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

afterEach(() => cleanup());

describe("OrganizationSelect", () => {
  it("lists each active organization as a row with a Select button, hiding inactive memberships", async () => {
    mount([
      membership("1", "Cedar Ridge Hospice", "active", true),
      membership("2", "Maple Hollow Hospice", "active"),
      membership("3", "Old Org", "suspended"),
    ]);

    const list = await screen.findByRole("list", { name: "Your organizations" });
    const rows = within(list).getAllByRole("listitem");

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.classList.contains("wx-drawer-card"))).toBe(true);
    expect(within(rows[0] as HTMLElement).getByText("Cedar Ridge Hospice")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("Admin")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).queryByText("Admin")).toBeNull();
    expect(screen.getByRole("button", { name: "Select Cedar Ridge Hospice" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Select Maple Hollow Hospice" })).toBeTruthy();
    expect(screen.queryByText("Old Org")).toBeNull();
  });

  it("says there are no active organizations when every membership is inactive", async () => {
    mount([membership("3", "Old Org", "suspended")]);

    expect(await screen.findByText("No active organizations")).toBeTruthy();
    expect(
      screen.getByText("Your account has no active membership. Contact your administrator."),
    ).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Your organizations" })).toBeNull();
  });
});
