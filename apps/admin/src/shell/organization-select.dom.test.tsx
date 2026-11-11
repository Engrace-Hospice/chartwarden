// The organization picker: a signed-in platform-ops user chooses the org that binds the session. It lists only ACTIVE
// memberships (one row each, named by its Select button) and says so when there is none; choosing one POSTs the selection
// (busy while it is in flight) and then reloads the app; a failed load or selection is one announced error.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationSelect } from "./organization-select";

const SELECT_PATH = "/api/v1/auth/select-organization";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const membership = (id: string, organizationName: string, status: string, isAdmin = false) => ({
  membershipId: `membership-${id}`,
  organizationId: `org-${id}`,
  organizationName,
  status,
  isAdmin,
  defaultLocationIds: [],
});

interface Selection {
  path: string;
  method: string;
  body: unknown;
}

/** Mounts the picker; `memberships` answers the list, `onSelect` the selection POST (default: accepted). */
function mount(
  memberships: unknown[],
  options: {
    listStatus?: number;
    onSelect?: () => Response | Promise<Response>;
  } = {},
): { selections: Selection[] } {
  const selections: Selection[] = [];
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      if (req.method === "GET")
        return options.listStatus && options.listStatus >= 400
          ? json(
              { error: { code: "INTERNAL", message: "boom", correlationId: "c" } },
              options.listStatus,
            )
          : json({ memberships });
      selections.push({
        path: new URL(req.url).pathname,
        method: req.method,
        body: await req.json(),
      });
      return options.onSelect ? options.onSelect() : json({});
    },
  });
  render(
    <ApiClientProvider client={client}>
      <MemoryRouter>
        <OrganizationSelect />
      </MemoryRouter>
    </ApiClientProvider>,
  );
  return { selections };
}

const assign = vi.fn();
beforeEach(() => {
  assign.mockClear();
  vi.stubGlobal("location", { ...window.location, assign });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OrganizationSelect list", () => {
  it("lists each active organization as a row with a Select button, hiding inactive memberships", async () => {
    mount([
      membership("1", "Cedar Ridge Hospice", "active", true),
      membership("2", "Maple Hollow Hospice", "active"),
      membership("3", "Old Org", "suspended"),
    ]);

    const list = await screen.findByRole("list", { name: "Your organizations" });
    const rows = within(list).getAllByRole("listitem");

    // Marker-less lists state their role: Safari/VoiceOver drops it from a bare <ul> with list-style: none.
    expect(list.getAttribute("role")).toBe("list");
    expect(rows).toHaveLength(2);
    within(rows[0] as HTMLElement).getByText("Cedar Ridge Hospice");
    within(rows[0] as HTMLElement).getByText("Admin");
    expect(within(rows[1] as HTMLElement).queryByText("Admin")).toBeNull();
    screen.getByRole("button", { name: "Select Cedar Ridge Hospice" });
    screen.getByRole("button", { name: "Select Maple Hollow Hospice" });
    expect(screen.queryByText("Old Org")).toBeNull();
  });

  it("says there are no active organizations when every membership is inactive", async () => {
    mount([membership("3", "Old Org", "suspended")]);

    await screen.findByText("No active organizations");
    screen.getByText("Your account has no active membership. Contact your administrator.");
    expect(screen.queryByRole("list", { name: "Your organizations" })).toBeNull();
  });
});

describe("OrganizationSelect choosing an organization", () => {
  it("posts the selection, shows it busy and locks the other rows, then reloads the app", async () => {
    let accept: (response: Response) => void = () => {};
    const { selections } = mount(
      [
        membership("1", "Cedar Ridge Hospice", "active"),
        membership("2", "Maple Hollow Hospice", "active"),
      ],
      {
        onSelect: () =>
          new Promise<Response>((resolve) => {
            accept = resolve;
          }),
      },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Select Cedar Ridge Hospice" }));

    await waitFor(() => expect(selections).toHaveLength(1));
    expect(selections[0]).toEqual({
      path: SELECT_PATH,
      method: "POST",
      body: { organizationId: "org-1" },
    });
    const chosen = screen.getByRole("button", { name: "Select Cedar Ridge Hospice" });
    expect(chosen.getAttribute("aria-busy")).toBe("true");
    expect((chosen as HTMLButtonElement).disabled).toBe(true);
    const other = screen.getByRole("button", { name: "Select Maple Hollow Hospice" });
    expect((other as HTMLButtonElement).disabled).toBe(true);
    expect(assign).not.toHaveBeenCalled();

    accept(json({}));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    expect(selections).toHaveLength(1);
  });
});

describe("OrganizationSelect error states", () => {
  it("shows one announced error when the organizations cannot be loaded", async () => {
    mount([], { listStatus: 500 });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Unavailable");
    expect(alert.textContent).toContain("Could not load your organizations. Please sign in again.");
    // InlineAlert is the live region: a wrapper role would announce the same error twice.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByRole("list", { name: "Your organizations" })).toBeNull();
  });

  it("replaces the list with one announced error when the selection is refused", async () => {
    mount([membership("1", "Cedar Ridge Hospice", "active")], {
      onSelect: () =>
        json({ error: { code: "FORBIDDEN", message: "no", correlationId: "c" } }, 403),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Select Cedar Ridge Hospice" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Unavailable");
    expect(alert.textContent).toContain(
      "That organization could not be selected. Contact your administrator.",
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByRole("list", { name: "Your organizations" })).toBeNull();
    expect(assign).not.toHaveBeenCalled();
  });
});
