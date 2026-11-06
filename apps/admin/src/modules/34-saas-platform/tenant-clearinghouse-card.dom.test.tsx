// @vitest-environment jsdom
// The tenant hub's clearinghouse card: which clearinghouse the tenant uses and how far it got, and the way into the notices the tenant
// recorded as filed outside ChartWarden. Read on request, like the contract: each read of a tenant's billing setup is audited.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ok, refused, renderAt, stubClient } from "./onboarding/test-support";
import { TenantClearinghouseCard } from "./tenant-clearinghouse-card";

const CH = "/api/v1/platform/tenants/{orgSlug}/clearinghouse";
const SUBSCRIPTION = "/api/v1/platform/tenants/{orgSlug}/subscription";
const FILINGS = "/api/v1/platform/tenants/{orgSlug}/notice-filings";

const NOTHING = {
  vendor: null,
  mode: null,
  status: null,
  source: "none",
  hasSecret: false,
  verifiableBy: null,
  verification: null,
  lastTest: null,
  baaRequired: false,
  baa: null,
  activatedAt: null,
  version: null,
  updatedAt: null,
};
const OUTSIDE = { ...NOTHING, vendor: "outside", status: "active", source: "tenant", version: 1 };
const CLAIMMD = {
  ...NOTHING,
  vendor: "claimmd",
  mode: "production",
  status: "verified",
  source: "tenant",
  hasSecret: true,
  verifiableBy: "connection_test",
  baaRequired: true,
  baa: {
    heldBy: "tenant",
    effectiveDate: "2026-01-15",
    documentRef: "Claim.MD BAA, contract folder 7",
    recordedAt: "2026-11-02T10:00:00.123Z",
    verified: null,
  },
  version: 3,
};

function mount(choice: unknown, contractMode: string | null = null) {
  const client = stubClient({
    GET: {
      [CH]: () => ok(choice),
      [SUBSCRIPTION]: () =>
        ok({
          contract: contractMode
            ? { billingServiceMode: contractMode, pendingBillingServiceMode: null }
            : null,
        }),
      [FILINGS]: () => ok({ items: [], truncated: false }),
    },
  });
  renderAt(
    "/x",
    [{ path: "/x", element: <TenantClearinghouseCard orgSlug="cedar-ridge" /> }],
    client,
  );
  return client;
}
const reads = (client: ReturnType<typeof stubClient>, path: string) =>
  client.GET.mock.calls.filter((c) => c[0] === path).length;

describe("TenantClearinghouseCard", () => {
  it("reads nothing until the operator asks, and says the read is audited", () => {
    const client = mount(OUTSIDE);
    expect(screen.getByText(/recorded in the audit trail/i)).toBeTruthy();
    expect(reads(client, CH)).toBe(0);
    expect(reads(client, SUBSCRIPTION)).toBe(0);
  });

  it("shows a tenant billing outside ChartWarden, with no vendor, mode or credential to report", async () => {
    const client = mount(OUTSIDE, "none");
    fireEvent.click(screen.getByRole("button", { name: "Show clearinghouse" }));
    expect(await screen.findByText(/Billing outside ChartWarden/)).toBeTruthy();
    expect(screen.getByText(/transmits nothing for this tenant/i)).toBeTruthy();
    expect(screen.queryByText(/Secret on file/)).toBeNull();
    // no vendor, so the contract is not read for the mode banner
    expect(reads(client, SUBSCRIPTION)).toBe(0);
  });

  it("shows a vendor with its mode, status and BAA, never the credential", async () => {
    mount(CLAIMMD);
    fireEvent.click(screen.getByRole("button", { name: "Show clearinghouse" }));
    expect(await screen.findByText("Claim.MD")).toBeTruthy();
    expect(screen.getByText("Production")).toBeTruthy();
    expect(screen.getByText(/Verified/)).toBeTruthy();
    expect(screen.getByText(/Secret on file/)).toBeTruthy();
    expect(screen.getByText(/Claim\.MD BAA, contract folder 7/)).toBeTruthy();
  });

  it("warns when a vendor is chosen but the contract's billing mode is still None", async () => {
    mount(CLAIMMD, "none");
    fireEvent.click(screen.getByRole("button", { name: "Show clearinghouse" }));
    expect(await screen.findByText(/billing service mode is still None/)).toBeTruthy();
  });

  it("says nothing is chosen yet, and points to the step where it is chosen", async () => {
    mount(NOTHING);
    fireEvent.click(screen.getByRole("button", { name: "Show clearinghouse" }));
    expect(await screen.findByText(/No clearinghouse is chosen yet/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Open the clearinghouse step/ }).getAttribute("href"),
    ).toBe("/tenants/cedar-ridge/onboarding/clearinghouse_selected");
  });

  describe("verifying the vendor BAA (a live tenant that changed vendor needs it too)", () => {
    const BAA_VERIFY = "/api/v1/platform/tenants/{orgSlug}/clearinghouse/baa/verify";
    const RECORDED = "2026-11-02T10:00:00.123Z";
    const RECORDED_AGAIN = "2026-11-05T09:30:00.456Z";
    const withBaa = (over = {}) => ({
      ...CLAIMMD,
      status: "active",
      baa: { ...CLAIMMD.baa, recordedAt: RECORDED, verified: null, ...over },
    });
    const POST = [BAA_VERIFY];

    it("offers it only for a recorded BAA that is not verified yet, and pins the call to the record that was read", async () => {
      const client = stubClient({
        GET: { [CH]: () => ok(withBaa()), [SUBSCRIPTION]: () => ok({ contract: null }) },
        POST: { [BAA_VERIFY]: () => ok(withBaa({ verified: { at: "2026-11-06T09:00:00.000Z" } })) },
      });
      renderAt(
        "/x",
        [{ path: "/x", element: <TenantClearinghouseCard orgSlug="cedar-ridge" /> }],
        client,
      );
      fireEvent.click(screen.getByRole("button", { name: "Show clearinghouse" }));
      fireEvent.click(await screen.findByRole("button", { name: "Verify the vendor BAA" }));
      const dialog = within(screen.getByRole("dialog"));
      expect(dialog.getByText("Claim.MD BAA, contract folder 7")).toBeTruthy();
      fireEvent.change(screen.getByLabelText(/^Reason/), {
        target: { value: "Read the signed agreement, ticket CHG-8101" },
      });
      fireEvent.click(dialog.getByRole("button", { name: "Verify BAA" }));
      await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
      const [path, init] = client.POST.mock.calls[0] as [
        string,
        { params: { header: Record<string, string> }; body: unknown },
      ];
      expect(path).toBe(POST[0]);
      expect(init.params.header["If-Match"]).toBe(RECORDED);
      expect(init.body).toEqual({ reason: "Read the signed agreement, ticket CHG-8101" });
      // the card reads the record again
      await waitFor(() => expect(reads(client, CH)).toBeGreaterThan(1));
    });

    it("shows a BAA the tenant re-recorded meanwhile under a notice, and the second confirm pins the NEW record", async () => {
      let attempts = 0;
      const client = stubClient({
        GET: {
          [CH]: () => {
            attempts += 1;
            return ok(
              attempts === 1
                ? withBaa()
                : withBaa({ documentRef: "Claim.MD BAA v2", recordedAt: RECORDED_AGAIN }),
            );
          },
          [SUBSCRIPTION]: () => ok({ contract: null }),
        },
        POST: {
          [BAA_VERIFY]: (init) =>
            (init as { params?: { header?: Record<string, string> } }).params?.header?.[
              "If-Match"
            ] === RECORDED
              ? refused(409, "CLEARINGHOUSE_BAA_CHANGED", "changed")
              : ok(withBaa()),
        },
      });
      renderAt(
        "/x",
        [{ path: "/x", element: <TenantClearinghouseCard orgSlug="cedar-ridge" /> }],
        client,
      );
      fireEvent.click(screen.getByRole("button", { name: "Show clearinghouse" }));
      fireEvent.click(await screen.findByRole("button", { name: "Verify the vendor BAA" }));
      fireEvent.change(screen.getByLabelText(/^Reason/), {
        target: { value: "Read the signed agreement, ticket CHG-8101" },
      });
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", { name: "Verify BAA" }),
      );

      expect(await screen.findByText(/This record changed since you opened it/)).toBeTruthy();
      const dialog = within(screen.getByRole("dialog"));
      await waitFor(() => expect(dialog.getByText("Claim.MD BAA v2")).toBeTruthy());
      expect(client.POST).toHaveBeenCalledTimes(1);
      fireEvent.click(dialog.getByRole("button", { name: /Confirm the updated record/ }));
      await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(2));
      const second = client.POST.mock.calls[1] as [
        string,
        { params: { header: Record<string, string> } },
      ];
      expect(second[1].params.header["If-Match"]).toBe(RECORDED_AGAIN);
    });

    it("offers nothing when no BAA is recorded, when it is already verified, and for a tenant billing outside", async () => {
      for (const choice of [
        { ...CLAIMMD, status: "active", baa: null },
        withBaa({ verified: { at: "2026-11-06T09:00:00.000Z" } }),
        OUTSIDE,
      ]) {
        const client = mount(choice);
        fireEvent.click(screen.getByRole("button", { name: "Show clearinghouse" }));
        await screen.findByRole("button", { name: "Notices filed outside ChartWarden" });
        expect(screen.queryByRole("button", { name: "Verify the vendor BAA" })).toBeNull();
        expect(client.POST).not.toHaveBeenCalled();
        cleanup();
      }
    });
  });

  it("opens the drawer of notices filed outside ChartWarden, and closes it", async () => {
    const client = mount(OUTSIDE);
    fireEvent.click(screen.getByRole("button", { name: "Show clearinghouse" }));
    await screen.findByText(/Billing outside ChartWarden/);
    expect(reads(client, FILINGS)).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Notices filed outside ChartWarden" }));
    expect(await screen.findByLabelText("Notices filed outside ChartWarden")).toBeTruthy();
    await waitFor(() => expect(reads(client, FILINGS)).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("Notices filed outside ChartWarden")).toBeNull(),
    );
  });

  it("says when it could not load, and offers to try again", async () => {
    let attempts = 0;
    const client = stubClient({
      GET: {
        [CH]: () => {
          attempts += 1;
          return attempts === 1 ? (refused(500, "INTERNAL", "boom") as never) : ok(OUTSIDE);
        },
      },
    });
    renderAt(
      "/x",
      [{ path: "/x", element: <TenantClearinghouseCard orgSlug="cedar-ridge" /> }],
      client,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show clearinghouse" }));
    expect(await screen.findByText(/Could not load the clearinghouse/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/Billing outside ChartWarden/)).toBeTruthy();
  });
});
