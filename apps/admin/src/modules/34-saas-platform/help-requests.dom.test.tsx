import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { ok, stubClient } from "@chartwarden/ui/testing";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { HelpRequests } from "./help-requests";

const LIST = "/api/v1/platform/help-requests";
const REQUEST = {
  id: "help-1",
  tenantAccountId: "tenant-1",
  organizationId: "org-1",
  orgSlug: "cedar-ridge",
  legalBusinessName: "Cedar Ridge Hospice",
  status: "approved",
  phase: "ready_to_start",
  message: "Please help with the MAC setup.",
  stepKey: "mac_configured",
  requestedAt: "2026-11-10T00:00:00.000Z",
  approvedAt: "2026-11-10T01:00:00.000Z",
  closedAt: null,
  closeNote: null,
  supportConsentGrantId: "grant-real-1",
  session: null,
};

afterEach(cleanup);

function mount(client: ReturnType<typeof stubClient>): void {
  render(
    <ApiClientProvider client={client as unknown as ApiClient}>
      <MemoryRouter>
        <HelpRequests />
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

describe("HelpRequests", () => {
  it("loads every page so requests beyond the first 100 remain actionable", async () => {
    const second = { ...REQUEST, id: "help-101", legalBusinessName: "Willow Hospice" };
    const client = stubClient({
      GET: {
        [LIST]: (init) =>
          ok(
            (init.params as { query?: { cursor?: string } } | undefined)?.query?.cursor ===
              "next-help"
              ? { items: [second], nextCursor: null, hasMore: false }
              : { items: [REQUEST], nextCursor: "next-help", hasMore: true },
          ),
      },
    });
    mount(client);

    expect(await screen.findByText("Willow Hospice")).toBeTruthy();
    expect(client.GET).toHaveBeenCalledTimes(2);
  });

  it("starts the session with the request's real consent grant after the ceremony", async () => {
    const client = stubClient({
      GET: { [LIST]: () => ok({ items: [REQUEST], nextCursor: null, hasMore: false }) },
      POST: { "/api/v1/platform/support-sessions": () => ok({}, 201) },
    });
    mount(client);

    fireEvent.click(await screen.findByRole("button", { name: "Start session" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByLabelText(/I am starting this session/));
    fireEvent.click(within(dialog).getByRole("button", { name: "Start session" }));

    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    expect(client.POST.mock.calls[0]?.[1]?.body).toEqual({
      supportConsentGrantId: "grant-real-1",
    });
  });

  it("resolves a request with a tenant-visible note", async () => {
    const client = stubClient({
      GET: { [LIST]: () => ok({ items: [REQUEST], nextCursor: null, hasMore: false }) },
      POST: { "/api/v1/platform/help-requests/{id}/resolve": () => ok({}) },
    });
    mount(client);

    fireEvent.click(await screen.findByRole("button", { name: "Resolve" }));
    fireEvent.change(screen.getByLabelText("Tenant-visible note"), {
      target: { value: "The setup issue has been corrected." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Resolve request" }));

    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    expect(client.POST.mock.calls[0]?.[1]).toMatchObject({
      params: { path: { id: "help-1" } },
      body: { note: "The setup issue has been corrected." },
    });
  });
});
