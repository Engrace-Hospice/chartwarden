// @vitest-environment jsdom
// The steps that are mostly a read: Provisioning (the platform builds the tenant), First admin (an invitation the admin accepts) and the
// e-prescribing slot (settled by an active DoseSpot configuration, which arrives with that module).
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DosespotPanel, FirstAdminPanel, ProvisioningPanel } from "./simple-panels";
import { ok, panelCtx, renderAt, stubClient, wizardStep, wizardView } from "./test-support";

const INVITES = "/api/v1/platform/tenant-invitations";
const invite = (status: string) => ({
  id: "inv-1",
  tenantAccountId: "ta-1",
  firstAdminEmail: "ada@cedar.example",
  status,
  issuedAt: "2026-11-01T00:00:00.000Z",
  expiresAt: "2026-11-15T00:00:00.000Z",
});

describe("ProvisioningPanel", () => {
  it("says the platform settles it, and shows the fact once provisioning is done", () => {
    const view = wizardView([
      wizardStep("provisioning_complete", 1, {
        title: "Provisioning",
        completionMode: "auto",
        status: "done",
      }),
    ]);
    renderAt(
      "/x",
      [
        {
          path: "/x",
          element: <ProvisioningPanel ctx={panelCtx(view, "provisioning_complete")} />,
        },
      ],
      stubClient({}),
    );
    const facts = screen.getByRole("list", { name: "What settles this step" });
    expect(
      within(facts)
        .getByText(/Tenant organisation, key ring and first-admin invitation are provisioned/)
        .closest("li")?.textContent,
    ).toMatch(/Met/);
  });

  it("is not met while the tenant is still provisioning", () => {
    const view = wizardView(
      [wizardStep("provisioning_complete", 1, { title: "Provisioning", completionMode: "auto" })],
      { tenantStatus: "provisioning" },
    );
    renderAt(
      "/x",
      [
        {
          path: "/x",
          element: <ProvisioningPanel ctx={panelCtx(view, "provisioning_complete")} />,
        },
      ],
      stubClient({}),
    );
    expect(screen.getByText(/Tenant organisation, key ring/).closest("li")?.textContent).toMatch(
      /Not yet/,
    );
  });
});

describe("FirstAdminPanel", () => {
  const view = (status = "pending") =>
    wizardView([
      wizardStep("first_admin_invited", 1, {
        title: "People: first admin",
        completionMode: "auto",
        status: status as "pending",
      }),
    ]);

  it("shows this tenant's invitation, read in one call for this tenant", async () => {
    const client = stubClient({
      GET: {
        [INVITES]: () => ok({ items: [invite("pending")], nextCursor: null, hasMore: false }),
      },
    });
    renderAt(
      "/x",
      [{ path: "/x", element: <FirstAdminPanel ctx={panelCtx(view(), "first_admin_invited")} /> }],
      client,
    );
    expect(await screen.findByText("ada@cedar.example")).toBeTruthy();
    expect(client.GET).toHaveBeenCalledWith(INVITES, {
      params: { query: { tenantAccountId: "ta-1" } },
    });
    expect(screen.getByText(/first admin has accepted/i).closest("li")?.textContent).toMatch(
      /Not yet/,
    );
  });

  it("is met once the step is done", async () => {
    const client = stubClient({
      GET: {
        [INVITES]: () => ok({ items: [invite("accepted")], nextCursor: null, hasMore: false }),
      },
    });
    renderAt(
      "/x",
      [
        {
          path: "/x",
          element: <FirstAdminPanel ctx={panelCtx(view("done"), "first_admin_invited")} />,
        },
      ],
      client,
    );
    await screen.findByText("ada@cedar.example");
    expect(screen.getByText(/first admin has accepted/i).closest("li")?.textContent).toMatch(/Met/);
  });
});

describe("DosespotPanel", () => {
  it("is an honest slot: set up with the e-prescribing module, settled by an active configuration", () => {
    const view = wizardView([
      wizardStep("dosespot_kickoff_initiated", 1, {
        title: "e-Prescribing (DoseSpot)",
        completionMode: "either",
        owner: "either",
      }),
    ]);
    renderAt(
      "/x",
      [
        {
          path: "/x",
          element: <DosespotPanel ctx={panelCtx(view, "dosespot_kickoff_initiated")} />,
        },
      ],
      stubClient({}),
    );
    expect(screen.getByText(/set up with the e-prescribing module/i)).toBeTruthy();
    expect(screen.getAllByText(/DoseSpot configuration is active/i).length).toBeGreaterThanOrEqual(
      1,
    );
    expect(
      screen.getByText(/DoseSpot configuration is active/i, { selector: ".wx-fact-label" }),
    ).toBeTruthy();
    // evidence and skip remain available on the slot, like any step where the fact cannot be read yet
    expect(screen.getByRole("button", { name: /Mark done with evidence/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Skip this step/ })).toBeTruthy();
  });
});
