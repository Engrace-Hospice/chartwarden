// @vitest-environment jsdom
// Step 12, People: compliance officer. The officer attests go-live readiness, so the operator picks a member of the tenant's own staff
// by name (ChartWarden staff are refused), says why, and the server binds the role where the member lacks it.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { OfficerPanel } from "./officer-panel";
import {
  ORG_SLUG,
  ok,
  panelCtx,
  refused,
  renderAt,
  stubClient,
  wizardStep,
  wizardView,
} from "./test-support";

const MEMBERS = "/api/v1/platform/tenants/{orgSlug}/members";
const OFFICER = "/api/v1/platform/tenants/{orgSlug}/compliance-officer";
const ADA = "f1000000-0000-4000-8000-0000000000f1";
const BEA = "f2000000-0000-4000-8000-0000000000f2";
const members = [
  { membershipId: BEA, displayName: "Bea Nurse", email: "bea@clinic.example", roleKeys: ["rn"] },
  {
    membershipId: ADA,
    displayName: "Ada Admin",
    email: "ada@clinic.example",
    roleKeys: ["compliance_officer", "org_admin"],
  },
];
const view = (over = {}) =>
  wizardView(
    [
      wizardStep("compliance_officer_assigned", 1, {
        title: "People: compliance officer",
        owner: "either",
        completionMode: "either",
      }),
    ],
    over,
  );
function mount(items: unknown[], extra: Parameters<typeof stubClient>[0] = {}, v = view()) {
  const client = stubClient({ GET: { [MEMBERS]: () => ok({ items }) }, ...extra });
  const ctx = panelCtx(v, "compliance_officer_assigned");
  renderAt("/x", [{ path: "/x", element: <OfficerPanel ctx={ctx} /> }], client);
  return { client, ctx };
}
beforeEach(() => window.sessionStorage.clear());

describe("OfficerPanel", () => {
  it("lists the tenant's active staff by name, those who already hold the role first", async () => {
    mount(members);
    const group = await screen.findByRole("group", { name: "Tenant staff" });
    const names = within(group)
      .getAllByRole("radio")
      .map((r) => r.getAttribute("aria-label") ?? "");
    expect(names[0]).toContain("Ada Admin");
    expect(names[1]).toContain("Bea Nurse");
    expect(within(group).getByText(/Compliance officer role/)).toBeTruthy();
  });

  it("says when the tenant has no staff yet", async () => {
    mount([]);
    expect(await screen.findByText(/no active staff yet/i)).toBeTruthy();
  });

  it("shows who the current officer is", async () => {
    mount(
      members,
      {},
      view({
        goLive: {
          state: "not_ready",
          attestation: null,
          failedGuards: [],
          complianceOfficerMembershipId: ADA,
        },
      }),
    );
    expect(await screen.findByText(/Current officer:/)).toBeTruthy();
    expect(screen.getByText(/A compliance officer is assigned/).closest("li")?.textContent).toMatch(
      /Met/,
    );
  });

  it("assigns the picked member behind a reason, and reloads the wizard", async () => {
    const { client, ctx } = mount(members, {
      PUT: { [OFFICER]: () => ok({ complianceOfficerMembershipId: ADA }) },
    });
    fireEvent.click(await screen.findByRole("radio", { name: /Ada Admin/ }));
    fireEvent.click(screen.getByRole("button", { name: "Assign compliance officer" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), {
      target: { value: "Customer named Ada on the kickoff call" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Assign" }));
    await waitFor(() => expect(client.PUT).toHaveBeenCalledTimes(1));
    const [path, init] = client.PUT.mock.calls[0] as [
      string,
      { params: { path: unknown }; body: Record<string, unknown> },
    ];
    expect(path).toBe(OFFICER);
    expect(init.params.path).toEqual({ orgSlug: ORG_SLUG });
    expect(init.body).toEqual({
      membershipId: ADA,
      reason: "Customer named Ada on the kickoff call",
    });
    await waitFor(() => expect(ctx.refresh).toHaveBeenCalled());
  });

  it("does not offer Assign until someone is picked", async () => {
    mount(members);
    await screen.findByRole("group", { name: "Tenant staff" });
    expect(
      (screen.getByRole("button", { name: "Assign compliance officer" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("tells the operator when the server refuses ChartWarden staff, in the dialog", async () => {
    mount(members, {
      PUT: { [OFFICER]: () => refused(422, "COMPLIANCE_OFFICER_PLATFORM_STAFF", "x") },
    });
    fireEvent.click(await screen.findByRole("radio", { name: /Bea Nurse/ }));
    fireEvent.click(screen.getByRole("button", { name: "Assign compliance officer" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), {
      target: { value: "Customer named Bea on the kickoff call" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Assign" }));
    expect(
      await screen.findByText(/ChartWarden staff cannot be a tenant's compliance officer/),
    ).toBeTruthy();
  });

  it("warns that a different officer voids a pending go-live attestation", async () => {
    mount(
      members,
      {},
      view({
        goLive: {
          state: "awaiting_approval",
          attestation: null,
          failedGuards: [],
          complianceOfficerMembershipId: BEA,
        },
      }),
    );
    expect(await screen.findByText(/voids that attestation/)).toBeTruthy();
  });

  it("offers no assignment when the step cannot be acted on", async () => {
    mount(members, {}, view({ tenantStatus: "provisioning" }));
    await screen.findByRole("group", { name: "Tenant staff" });
    expect(screen.queryByRole("button", { name: "Assign compliance officer" })).toBeNull();
  });
});
