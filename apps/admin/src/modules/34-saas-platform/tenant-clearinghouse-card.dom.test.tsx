import { STEP_UP_RETURN_STATE, isStepUpReturn } from "@chartwarden/ui";
// @vitest-environment jsdom
// The tenant hub's clearinghouse card: which clearinghouse the tenant uses and how far it got, and the way into the notices the tenant
// recorded as filed outside ChartWarden. Read on request, like the contract: each read of a tenant's billing setup is audited.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { JSX } from "react";
import { useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ONBOARDING_OPERATOR,
  RETURNED_FROM_STEP_UP,
  ok,
  refused,
  renderAt,
  stubClient,
} from "./onboarding/test-support";
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
  hasContract: false,
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

function mount(choice: unknown, contractMode: string | null = null, tenantStatus = "active") {
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
    [
      {
        path: "/x",
        element: <TenantClearinghouseCard orgSlug="cedar-ridge" tenantStatus={tenantStatus} />,
      },
    ],
    client,
  );
  return client;
}
const reads = (client: ReturnType<typeof stubClient>, path: string) =>
  client.GET.mock.calls.filter((c) => c[0] === path).length;

/** Whether the current history entry still carries the step-up return marker. */
function MarkerProbe(): JSX.Element {
  return <output data-testid="marker">{String(isStepUpReturn(useLocation().state))}</output>;
}

// a Re-verify stashes the switch form: no test may resume another test's draft
beforeEach(() => window.sessionStorage.clear());

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

  it("for a live tenant with nothing chosen, offers no link to the wizard's read-only step", async () => {
    mount(NOTHING);
    fireEvent.click(screen.getByRole("button", { name: "Show clearinghouse" }));
    expect(await screen.findByText(/Onboarding is closed for this tenant/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Open the clearinghouse step/ })).toBeNull();
  });

  it("for a provisioning tenant, says the step opens when provisioning finishes (the wizard's steps are not open yet)", async () => {
    mount(NOTHING, null, "provisioning");
    fireEvent.click(screen.getByRole("button", { name: "Show clearinghouse" }));
    expect(await screen.findByText(/opens when provisioning finishes/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Open the clearinghouse step/ })).toBeNull();
  });

  it("says nothing is chosen yet, and points an onboarding tenant to the step where it is chosen", async () => {
    mount(NOTHING, null, "onboarding");
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

    it("is not offered to an operator without the BAA-verify key (fail closed)", async () => {
      const client = stubClient({
        GET: { [CH]: () => ok(withBaa()), [SUBSCRIPTION]: () => ok({ contract: null }) },
      });
      renderAt(
        "/x",
        [
          {
            path: "/x",
            element: <TenantClearinghouseCard orgSlug="cedar-ridge" tenantStatus="active" />,
          },
        ],
        client,
        { ...ONBOARDING_OPERATOR, permissions: [] },
      );
      fireEvent.click(screen.getByRole("button", { name: "Show clearinghouse" }));
      await screen.findByRole("button", { name: "Notices filed outside ChartWarden" });
      expect(screen.queryByRole("button", { name: "Verify the vendor BAA" })).toBeNull();
    });

    it("offers it only for a recorded BAA that is not verified yet, and pins the call to the record that was read", async () => {
      const client = stubClient({
        GET: { [CH]: () => ok(withBaa()), [SUBSCRIPTION]: () => ok({ contract: null }) },
        POST: { [BAA_VERIFY]: () => ok(withBaa({ verified: { at: "2026-11-06T09:00:00.000Z" } })) },
      });
      renderAt(
        "/x",
        [
          {
            path: "/x",
            element: <TenantClearinghouseCard orgSlug="cedar-ridge" tenantStatus="active" />,
          },
        ],
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
        [
          {
            path: "/x",
            element: <TenantClearinghouseCard orgSlug="cedar-ridge" tenantStatus="active" />,
          },
        ],
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

  describe("releasing earlier credentials (migration 1435)", () => {
    const RELEASE = "/api/v1/platform/tenants/{orgSlug}/clearinghouse/credentials/release";
    const mountWith = (
      choice: unknown,
      release: () => unknown,
      url: string | { pathname: string; state?: unknown } = "/x",
    ) => {
      const client = stubClient({
        GET: { [CH]: () => ok(choice), [SUBSCRIPTION]: () => ok({ contract: null }) },
        POST: { [RELEASE]: release as never },
      });
      renderAt(
        url,
        [
          {
            path: "/x",
            element: (
              <>
                <TenantClearinghouseCard orgSlug="cedar-ridge" tenantStatus="active" />
                <MarkerProbe />
              </>
            ),
          },
        ],
        client,
      );
      return client;
    };

    it("releases with a reason and an Idempotency-Key, and says how many were freed", async () => {
      const client = mountWith(OUTSIDE, () => ok({ released: 2, config: OUTSIDE }));
      fireEvent.click(screen.getByRole("button", { name: "Show clearinghouse" }));
      fireEvent.click(await screen.findByRole("button", { name: "Release earlier credentials" }));
      const dialog = within(screen.getByRole("dialog"));
      fireEvent.change(screen.getByLabelText(/^Reason/), {
        target: { value: "Account moved to the new organization, ticket OPS-77" },
      });
      fireEvent.click(dialog.getByRole("button", { name: "Release" }));
      await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
      const [path, init] = client.POST.mock.calls[0] as [
        string,
        { params: { header: Record<string, string> }; body: unknown },
      ];
      expect(path).toBe(RELEASE);
      expect(init.params.header["Idempotency-Key"]).toBeTruthy();
      expect(init.body).toEqual({ reason: "Account moved to the new organization, ticket OPS-77" });
      expect(await screen.findByText("Released 2 earlier credentials.")).toBeTruthy();
    });

    const openRelease = async (reason = "Retire the rotated key, ticket OPS-78") => {
      fireEvent.click(screen.getByRole("button", { name: "Show clearinghouse" }));
      fireEvent.click(await screen.findByRole("button", { name: "Release earlier credentials" }));
      fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: reason } });
    };
    const confirm = () =>
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Release" }));

    it("shows the server's refusal in an alert, keeps the dialog open and usable, and frees nothing", async () => {
      mountWith(CLAIMMD, () =>
        refused(
          409,
          "CLEARINGHOUSE_RESPONSES_PENDING",
          "server sentence not shown to the operator",
        ),
      );
      await openRelease();
      confirm();
      const alert = await within(screen.getByRole("dialog")).findByRole("alert");
      expect(alert.textContent).toMatch(/Try again once it has had no production claim in flight/);
      const button = within(screen.getByRole("dialog")).getByRole("button", { name: "Release" });
      await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
      expect(screen.queryByText(/^Released/)).toBeNull();
    });

    it("a step-up refusal offers Re-verify and keeps the dialog open; the return reopens the card and the dialog with the reason", async () => {
      mountWith(CLAIMMD, () => refused(403, "STEP_UP_REQUIRED", "step up"));
      await openRelease("Ticket OPS-79 retire the old key");
      confirm();
      // an edit typed after the refusal is what the return brings back, not the submitted text
      fireEvent.change(within(screen.getByRole("dialog")).getByLabelText(/^Reason/), {
        target: { value: "Ticket OPS-79 retire the old Claim.MD key" },
      });
      fireEvent.click(
        await within(screen.getByRole("dialog")).findByRole("link", { name: "Re-verify" }),
      );
      expect(await screen.findByText("step-up page")).toBeTruthy();
      cleanup();
      mountWith(CLAIMMD, () => ok({ released: 1, config: CLAIMMD }), {
        pathname: "/x",
        state: STEP_UP_RETURN_STATE,
      });
      const back = within(await screen.findByRole("dialog"));
      expect((back.getByLabelText(/^Reason/) as HTMLTextAreaElement).value).toBe(
        "Ticket OPS-79 retire the old Claim.MD key",
      );
      // the marker is consumed: Back/Forward or a reload of this entry does not re-assert it
      await waitFor(() => expect(screen.getByTestId("marker").textContent).toBe("false"));
    });

    it("a later visit (not the step-up return) opens nothing, so the audited read waits for a click", async () => {
      mountWith(CLAIMMD, () => refused(403, "STEP_UP_REQUIRED", "step up"));
      await openRelease("Ticket OPS-80 retire the old key");
      confirm();
      fireEvent.click(
        await within(screen.getByRole("dialog")).findByRole("link", { name: "Re-verify" }),
      );
      await screen.findByText("step-up page");
      cleanup();
      const client = mountWith(CLAIMMD, () => ok({ released: 1, config: CLAIMMD }));
      expect(screen.getByRole("button", { name: "Show clearinghouse" })).toBeTruthy();
      expect(reads(client, CH)).toBe(0);
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("a draft left behind (Back from /step-up) is dropped by the next visit, so an unrelated step-up return opens nothing", async () => {
      mountWith(CLAIMMD, () => refused(403, "STEP_UP_REQUIRED", "step up"));
      await openRelease("Ticket OPS-81 retire the old key");
      confirm();
      fireEvent.click(
        await within(screen.getByRole("dialog")).findByRole("link", { name: "Re-verify" }),
      );
      await screen.findByText("step-up page");
      cleanup();
      mountWith(CLAIMMD, () => ok({ released: 1, config: CLAIMMD })); // Back: the hub, no marker
      cleanup();
      // later, a step-up for something else (e.g. a key rotation) returns to the hub with the marker
      const client = mountWith(CLAIMMD, () => ok({ released: 1, config: CLAIMMD }), {
        pathname: "/x",
        state: STEP_UP_RETURN_STATE,
      });
      expect(screen.getByRole("button", { name: "Show clearinghouse" })).toBeTruthy();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(reads(client, CH)).toBe(0);
    });

    it("a step-up return with no release draft clears the marker and keeps the card closed", async () => {
      const client = mountWith(CLAIMMD, () => ok({ released: 1, config: CLAIMMD }), {
        pathname: "/x",
        state: STEP_UP_RETURN_STATE,
      });
      await waitFor(() => expect(screen.getByTestId("marker").textContent).toBe("false"));
      expect(screen.getByRole("button", { name: "Show clearinghouse" })).toBeTruthy();
      expect(reads(client, CH)).toBe(0);
    });

    it("a dropped connection says so and leaves the dialog usable", async () => {
      mountWith(CLAIMMD, () => {
        throw new TypeError("network down");
      });
      await openRelease();
      confirm();
      expect(await within(screen.getByRole("dialog")).findByText(/reach the server/i)).toBeTruthy();
      const button = within(screen.getByRole("dialog")).getByRole("button", { name: "Release" });
      await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    });

    it("a reason that is too short sends nothing; Cancel closes the dialog", async () => {
      const client = mountWith(CLAIMMD, () => ok({ released: 1, config: CLAIMMD }));
      await openRelease("short");
      confirm();
      expect(client.POST).not.toHaveBeenCalled();
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("a double submit sends one request, and one freed credential is reported in the singular outside the actions", async () => {
      let answer: (v: unknown) => void = () => undefined;
      const client = mountWith(
        CLAIMMD,
        () =>
          new Promise((r) => {
            answer = r;
          }),
      );
      await openRelease();
      const button = within(screen.getByRole("dialog")).getByRole("button", { name: "Release" });
      fireEvent.click(button);
      fireEvent.click(button);
      await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
      answer(ok({ released: 1, config: CLAIMMD }));
      const status = await screen.findByText("Released 1 earlier credential.");
      expect(status.tagName).toBe("OUTPUT"); // an <output> is a status live region
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      // the report is not inside the actions row, and the next action clears it
      expect(status.closest(".wx-drawer-actions")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Notices filed outside ChartWarden" }));
      expect(status.textContent).toBe("");
    });

    it("says when nothing was freed", async () => {
      mountWith(CLAIMMD, () => ok({ released: 0, config: CLAIMMD }));
      await openRelease();
      confirm();
      expect(await screen.findByText("This tenant held no earlier credentials.")).toBeTruthy();
    });

    it("is not offered to an operator without the release key, nor on the platform's own binding", async () => {
      const client = stubClient({
        GET: { [CH]: () => ok(CLAIMMD), [SUBSCRIPTION]: () => ok({ contract: null }) },
      });
      const element = <TenantClearinghouseCard orgSlug="cedar-ridge" tenantStatus="active" />;
      renderAt("/x", [{ path: "/x", element }], client, {
        ...ONBOARDING_OPERATOR,
        permissions:
          ONBOARDING_OPERATOR.permissions?.filter(
            (k) => k !== "tenant_clearinghouse.release_credential_platform",
          ) ?? [],
      });
      fireEvent.click(screen.getByRole("button", { name: "Show clearinghouse" }));
      await screen.findByRole("button", { name: "Notices filed outside ChartWarden" });
      expect(screen.queryByRole("button", { name: "Release earlier credentials" })).toBeNull();
      cleanup();
      renderAt("/x", [{ path: "/x", element }], client, null);
      fireEvent.click(screen.getByRole("button", { name: "Show clearinghouse" }));
      await screen.findByRole("button", { name: "Notices filed outside ChartWarden" });
      expect(screen.queryByRole("button", { name: "Release earlier credentials" })).toBeNull(); // fail closed
      cleanup();
      mountWith({ ...CLAIMMD, source: "platform_env" }, () => ok({ released: 0, config: CLAIMMD }));
      fireEvent.click(screen.getByRole("button", { name: "Show clearinghouse" }));
      await screen.findByRole("button", { name: "Notices filed outside ChartWarden" });
      expect(screen.queryByRole("button", { name: "Release earlier credentials" })).toBeNull();
    });

    it("the dialog warns what a release cannot undo and asks for a ticket reference", async () => {
      mountWith(CLAIMMD, () => ok({ released: 0, config: CLAIMMD }));
      await openRelease();
      const text = screen.getByRole("dialog").textContent ?? "";
      expect(text).toMatch(/stopped using at the vendor/);
      expect(text).toMatch(/cannot use it again/);
      expect(text).toMatch(/in flight or sent one in the last 90 days/);
      expect(text).toMatch(/ticket reference/);
    });

    it("offers nothing for a tenant that never chose a clearinghouse", async () => {
      mountWith(NOTHING, () => ok({ released: 0, config: NOTHING }));
      fireEvent.click(screen.getByRole("button", { name: "Show clearinghouse" }));
      expect(await screen.findByText(/No clearinghouse is chosen yet/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Release earlier credentials" })).toBeNull();
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
      [
        {
          path: "/x",
          element: <TenantClearinghouseCard orgSlug="cedar-ridge" tenantStatus="active" />,
        },
      ],
      client,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show clearinghouse" }));
    expect(await screen.findByText(/Could not load the clearinghouse/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/Billing outside ChartWarden/)).toBeTruthy();
  });
});

describe("TenantClearinghouseCard: switching a live outside tenant to a vendor", () => {
  const SWITCHABLE = { ...OUTSIDE, version: 4, hasContract: true };
  const reason = "The customer moves to Claim.MD, ticket CHG-9301";

  function mountSwitch(
    choice: unknown,
    status: string,
    put: () => ReturnType<typeof ok> | ReturnType<typeof refused> = () => ok({ ...CLAIMMD }),
    at: Parameters<typeof renderAt>[0] = "/x",
  ) {
    const client = stubClient({
      GET: { [CH]: () => ok(choice) },
      PUT: { [CH]: put },
    });
    renderAt(
      at,
      [
        {
          path: "/x",
          element: <TenantClearinghouseCard orgSlug="cedar-ridge" tenantStatus={status} />,
        },
      ],
      client,
    );
    return client;
  }
  const show = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Show clearinghouse" }));
    await screen.findByText(/Billing outside ChartWarden/);
  };
  const fillForm = () => {
    fireEvent.click(screen.getByRole("button", { name: "Switch to a vendor" }));
    fireEvent.change(screen.getByLabelText(/^Vendor credential/), {
      target: { value: "vendor-credential-for-test-only" },
    });
  };

  it("is offered for a live tenant that bills outside and holds a contract, and for no other", async () => {
    mountSwitch(SWITCHABLE, "active");
    await show();
    expect(screen.getByRole("button", { name: "Switch to a vendor" })).toBeTruthy();
    cleanup();

    for (const [label, choice, status] of [
      ["still onboarding (step 7 serves it)", SWITCHABLE, "onboarding"],
      ["no contract (its own lane may switch)", { ...SWITCHABLE, hasContract: false }, "active"],
      ["already on a vendor", { ...CLAIMMD, hasContract: true }, "active"],
    ] as const) {
      mountSwitch(choice, status);
      fireEvent.click(screen.getByRole("button", { name: "Show clearinghouse" }));
      await waitFor(() => expect(screen.queryByText(/Loading the clearinghouse/)).toBeNull());
      expect(screen.queryByRole("button", { name: "Switch to a vendor" }), label).toBeNull();
      cleanup();
    }
  });

  it("offers the two transmitting vendors only, requires the billing service mode (no default), and says when it takes effect", async () => {
    mountSwitch(SWITCHABLE, "active");
    await show();
    fillForm();
    const vendors = within(screen.getByRole("combobox", { name: "Clearinghouse" }))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(vendors).toEqual(["Claim.MD", "Stedi"]);
    expect((screen.getByLabelText(/^Billing service mode/) as HTMLSelectElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Choose the billing service mode.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.change(screen.getByLabelText(/^Billing service mode/), {
      target: { value: "managed_billing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(within(screen.getByRole("dialog")).getByText(/from the 1st of next month/)).toBeTruthy();
  });

  it("sends ONE pinned write with the mode, the vendor and the credential, then reads the choice again", async () => {
    const client = mountSwitch(SWITCHABLE, "active");
    await show();
    fillForm();
    fireEvent.change(screen.getByLabelText(/^Billing service mode/), {
      target: { value: "managed_billing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: reason } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Switch" }));

    await waitFor(() => expect(client.PUT).toHaveBeenCalledTimes(1));
    const [path, init] = client.PUT.mock.calls[0] as [
      string,
      { params: { header: Record<string, string> }; body: Record<string, unknown> },
    ];
    expect(path).toBe(CH);
    expect(init.params.header["If-Match"]).toBe("4");
    expect(init.params.header["Idempotency-Key"]).toMatch(/\S/);
    expect(init.body).toEqual({
      vendor: "claimmd",
      mode: "production",
      secret: "vendor-credential-for-test-only",
      billingServiceMode: "managed_billing",
      reason,
    });
    await waitFor(() => expect(reads(client, CH)).toBeGreaterThan(1));
  });

  it("says so, with a way to the contract, when the vendor committed but the billing mode could not be confirmed (never a silent success)", async () => {
    mountSwitch(SWITCHABLE, "active", () => ok({ ...CLAIMMD, billingModeConfirmed: false }));
    await show();
    fillForm();
    fireEvent.change(screen.getByLabelText(/^Billing service mode/), {
      target: { value: "managed_billing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: reason } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Switch" }));

    expect(await screen.findByText(/could not be confirmed/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Plan and contract step/ }).getAttribute("href")).toBe(
      "/tenants/cedar-ridge/onboarding/plan_contract",
    );
  });

  it("says nothing of the mode when it was confirmed", async () => {
    mountSwitch(SWITCHABLE, "active", () => ok({ ...CLAIMMD }));
    await show();
    fillForm();
    fireEvent.change(screen.getByLabelText(/^Billing service mode/), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: reason } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Switch" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText(/could not be confirmed/)).toBeNull();
  });

  it("closes the form and reads the choice again when the pin went stale (412), keeping no credential", async () => {
    const client = mountSwitch(SWITCHABLE, "active", () =>
      refused(
        412,
        "CLEARINGHOUSE_VERSION_CONFLICT",
        "the clearinghouse config changed since it was read",
      ),
    );
    await show();
    fillForm();
    fireEvent.change(screen.getByLabelText(/^Billing service mode/), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: reason } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Switch" }));

    await waitFor(() => expect(reads(client, CH)).toBeGreaterThan(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByLabelText(/^Vendor credential/)).toBeNull();
    expect(screen.getByRole("button", { name: "Switch to a vendor" })).toBeTruthy();
  });

  it("offers Re-verify on a stale step-up, and keeps the form (without the credential being stored anywhere)", async () => {
    mountSwitch(SWITCHABLE, "active", () => refused(403, "STEP_UP_REQUIRED"));
    await show();
    fillForm();
    fireEvent.change(screen.getByLabelText(/^Billing service mode/), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: reason } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Switch" }));

    fireEvent.click(await screen.findByRole("link", { name: /Re-verify/ }));
    const stashed = JSON.parse(
      window.sessionStorage.getItem(
        "wx.admin.step-up-draft:wizard:cedar-ridge:clearinghouse:switch",
      ) ?? "null",
    ) as { value: { form: Record<string, string>; pinnedVersion: number } } | null;
    // the form and the pin it was opened on are kept for the return; the credential is not
    expect(stashed?.value.form).toMatchObject({ vendor: "claimmd", billingServiceMode: "none" });
    expect(stashed?.value.pinnedVersion).toBe(4);
    expect(JSON.stringify(window.sessionStorage)).not.toContain("vendor-credential-for-test-only");
  });

  // Re-verify leaves the page and comes back through /step-up. Only that return restores the form; pressing Back from /step-up is an
  // abandoned Re-verify, whose draft must not reopen the form on a later visit.
  const reverifyFromSwitch = async () => {
    mountSwitch(SWITCHABLE, "active", () => refused(403, "STEP_UP_REQUIRED"));
    await show();
    fillForm();
    fireEvent.change(screen.getByLabelText(/^Billing service mode/), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: reason } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Switch" }));
    fireEvent.click(await screen.findByRole("link", { name: /Re-verify/ }));
    cleanup();
  };

  it("reopens the switch form, on the version it was opened on, when the operator comes back from Re-verify", async () => {
    await reverifyFromSwitch();
    mountSwitch(SWITCHABLE, "active", undefined, RETURNED_FROM_STEP_UP);
    await show();
    expect(await screen.findByRole("heading", { name: "Switch to a clearinghouse" })).toBeTruthy();
    expect((screen.getByLabelText(/^Billing service mode/) as HTMLSelectElement).value).toBe(
      "none",
    );
    expect((screen.getByLabelText(/^Vendor credential/) as HTMLInputElement).value).toBe("");
  });

  it("does not reopen the switch form from a draft an abandoned Re-verify left behind (Back from /step-up)", async () => {
    await reverifyFromSwitch();
    mountSwitch(SWITCHABLE, "active");
    await show();
    expect(screen.getByRole("button", { name: "Switch to a vendor" })).toBeTruthy();
    expect(screen.queryByLabelText(/^Vendor credential/)).toBeNull();
    cleanup();

    // that visit dropped the draft: a later, genuine return finds nothing to resurrect
    mountSwitch(SWITCHABLE, "active", undefined, RETURNED_FROM_STEP_UP);
    await show();
    expect(screen.getByRole("button", { name: "Switch to a vendor" })).toBeTruthy();
    expect(screen.queryByLabelText(/^Vendor credential/)).toBeNull();
  });

  // The vendor refuses on the merits (409): nothing is stale, so the form, the credential and the prompt's reason are kept.
  it("keeps the form and the typed credential when the server refuses the switch on its merits (409), and says why", async () => {
    const client = mountSwitch(SWITCHABLE, "active", () =>
      refused(
        409,
        "CLEARINGHOUSE_WORK_WAITING",
        "claims or submissions are still queued on the current clearinghouse",
      ),
    );
    await show();
    fillForm();
    fireEvent.change(screen.getByLabelText(/^Billing service mode/), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: reason } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Switch" }));

    const dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByText(/still queued on the current clearinghouse/)).toBeTruthy();
    expect(reads(client, CH)).toBe(1); // no reload: nothing was stale
    fireEvent.click(dialog.getByRole("button", { name: /Cancel/ }));
    expect((screen.getByLabelText(/^Vendor credential/) as HTMLInputElement).value).toBe(
      "vendor-credential-for-test-only",
    );
  });
});

// React review L4: each control hides on exactly its own key; its siblings stay, and the hidden one is explained.
describe("TenantClearinghouseCard: each control is gated on its own key", () => {
  const UNVERIFIED = {
    ...CLAIMMD,
    status: "active",
    baa: { ...CLAIMMD.baa, verified: null },
  };
  const SWITCHABLE = { ...OUTSIDE, version: 4, hasContract: true };
  const without = (key: string) => ({
    ...ONBOARDING_OPERATOR,
    permissions: ONBOARDING_OPERATOR.permissions?.filter((k) => k !== key) ?? [],
  });
  const CASES = [
    {
      key: "tenant_clearinghouse.verify_baa_platform",
      choice: UNVERIFIED,
      hidden: "Verify the vendor BAA",
      note: /Your role cannot verify the vendor BAA/,
      stays: "Release earlier credentials",
    },
    {
      key: "tenant_clearinghouse.release_credential_platform",
      choice: UNVERIFIED,
      hidden: "Release earlier credentials",
      note: /Your role cannot release earlier credentials/,
      stays: "Verify the vendor BAA",
    },
    {
      key: "tenant_clearinghouse.write_platform",
      choice: SWITCHABLE,
      hidden: "Switch to a vendor",
      note: /Your role cannot switch this tenant to a clearinghouse vendor/,
      stays: "Release earlier credentials",
    },
    {
      key: "subscription.onboard_platform",
      choice: SWITCHABLE,
      hidden: "Switch to a vendor",
      note: /Your role cannot switch this tenant to a clearinghouse vendor/,
      stays: "Release earlier credentials",
    },
  ] as const;

  for (const c of CASES) {
    it(`without ${c.key}: "${c.hidden}" is hidden and explained, "${c.stays}" stays`, async () => {
      const client = stubClient({
        GET: { [CH]: () => ok(c.choice), [SUBSCRIPTION]: () => ok({ contract: null }) },
      });
      const element = <TenantClearinghouseCard orgSlug="cedar-ridge" tenantStatus="active" />;
      renderAt("/x", [{ path: "/x", element }], client, without(c.key));
      fireEvent.click(screen.getByRole("button", { name: "Show clearinghouse" }));
      expect(await screen.findByRole("button", { name: c.stays })).toBeTruthy();
      expect(screen.queryByRole("button", { name: c.hidden })).toBeNull();
      expect(screen.getByText(c.note)).toBeTruthy();
      cleanup();
      renderAt("/x", [{ path: "/x", element }], client); // every key: both offered
      fireEvent.click(screen.getByRole("button", { name: "Show clearinghouse" }));
      expect(await screen.findByRole("button", { name: c.hidden })).toBeTruthy();
      expect(screen.getByRole("button", { name: c.stays })).toBeTruthy();
    });
  }
});
