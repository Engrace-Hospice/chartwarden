// @vitest-environment jsdom
// The first admin's invitation expires (and an email can be lost), and the API's list / issue / revoke routes had no
// screen, so an expired invitation meant a database edit. The card lists the tenant's invitations and resends or
// revokes one; a resend issues a fresh single-use link to the same address.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { describe, expect, it, vi } from "vitest";
import { InvitationCard } from "./invitation-card";

const invite = (over: Record<string, unknown>) => ({
  id: "inv-1",
  tenantAccountId: "t-1",
  firstAdminEmail: "ada@cedar.example",
  status: "pending",
  issuedAt: "2026-10-01T00:00:00.000Z",
  expiresAt: "2026-10-15T00:00:00.000Z",
  ...over,
});

const page = (...items: unknown[]) => ({ data: { items, nextCursor: null, hasMore: false } });

function mount(client: unknown): void {
  render(
    <ApiClientProvider client={client as ApiClient}>
      <InvitationCard orgSlug="cedar-ridge" tenantAccountId="t-1" />
    </ApiClientProvider>,
  );
}

describe("InvitationCard", () => {
  it("lists only this tenant's invitations, newest first", async () => {
    const GET = vi.fn(async () =>
      page(
        invite({ id: "other", tenantAccountId: "t-2", firstAdminEmail: "someone@else.example" }),
        invite({ id: "inv-2", status: "expired", issuedAt: "2026-09-01T00:00:00.000Z" }),
        invite({ id: "inv-1" }),
      ),
    );
    mount({ GET, POST: vi.fn(), DELETE: vi.fn() });

    expect(await screen.findAllByText("ada@cedar.example")).toHaveLength(2);
    expect(screen.queryByText("someone@else.example")).toBeNull();
  });

  it("resends to the same address and reloads", async () => {
    const GET = vi.fn(async () => page(invite({ status: "expired" })));
    const POST = vi.fn(async () => ({ data: invite({ id: "inv-9" }) }));
    mount({ GET, POST, DELETE: vi.fn() });

    fireEvent.click(await screen.findByRole("button", { name: /resend invitation/i }));

    await waitFor(() =>
      expect(POST).toHaveBeenCalledWith("/api/v1/platform/tenant-invitations", {
        body: { orgSlug: "cedar-ridge", firstAdminEmail: "ada@cedar.example" },
      }),
    );
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
  });

  it("revokes a pending invitation", async () => {
    const GET = vi.fn(async () => page(invite({})));
    const DELETE = vi.fn(async () => ({ data: { id: "inv-1", status: "revoked" } }));
    mount({ GET, POST: vi.fn(), DELETE });

    fireEvent.click(await screen.findByRole("button", { name: /revoke/i }));

    await waitFor(() =>
      expect(DELETE).toHaveBeenCalledWith("/api/v1/platform/tenant-invitations/{id}", {
        params: { path: { id: "inv-1" } },
      }),
    );
  });

  it("offers neither action once the invitation was accepted", async () => {
    mount({
      GET: vi.fn(async () => page(invite({ status: "accepted" }))),
      POST: vi.fn(),
      DELETE: vi.fn(),
    });

    await screen.findByText("ada@cedar.example");

    expect(screen.queryByRole("button", { name: /resend/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /revoke/i })).toBeNull();
  });

  it("shows why a resend was refused, e.g. a step-up requirement or an unbound mail gateway", async () => {
    const GET = vi.fn(async () => page(invite({ status: "expired" })));
    const POST = vi.fn(async () => ({
      error: { error: { message: "bind the provision gateway" } },
    }));
    mount({ GET, POST, DELETE: vi.fn() });

    fireEvent.click(await screen.findByRole("button", { name: /resend invitation/i }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/bind the provision gateway/);
  });

  it("a network failure on resend is reported, not swallowed", async () => {
    const GET = vi.fn(async () => page(invite({ status: "expired" })));
    const POST = vi.fn().mockRejectedValue(new Error("offline"));
    mount({ GET, POST, DELETE: vi.fn() });

    fireEvent.click(await screen.findByRole("button", { name: /resend invitation/i }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/try again/i);
  });

  it("finds this tenant's invitation on a later page of the global list", async () => {
    const GET = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          items: [invite({ id: "other", tenantAccountId: "t-2" })],
          nextCursor: "c2",
          hasMore: true,
        },
      })
      .mockResolvedValueOnce(page(invite({ id: "inv-1", status: "expired" })));
    mount({ GET, POST: vi.fn(), DELETE: vi.fn() });

    expect(await screen.findByRole("button", { name: /resend invitation/i })).toBeTruthy();
    expect(GET).toHaveBeenLastCalledWith("/api/v1/platform/tenant-invitations", {
      params: { query: { cursor: "c2" } },
    });
  });

  it("says when there is no invitation on record", async () => {
    mount({ GET: vi.fn(async () => page()), POST: vi.fn(), DELETE: vi.fn() });

    expect(await screen.findByText(/no invitation on record/i)).toBeTruthy();
  });
});
