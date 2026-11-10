// @vitest-environment jsdom
// Step 12, Compliance officer: the administrator picks one of the organization's own staff who ALREADY holds the compliance officer role
// (a fresh step-up). ChartWarden alone assigns that role: the tenant never grants it, and a person without it is not offered.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OfficerPanel } from "./officer-panel";
import {
  COMPLIANCE_OFFICER,
  ORG_ADMIN,
  RETURNED_FROM_STEP_UP,
  keyOf,
  ok,
  panelProps,
  refused,
  renderAt,
  stubClient,
  wizardStep,
  wizardView,
} from "./test-support";

const MEMBERS = "/api/v1/orgs/{id}/members";
const MEMBER_ROLES = "/api/v1/memberships/{id}/roles";
const OFFICER = "/api/v1/tenant/compliance-officer";
const INVITE = "/api/v1/orgs/{id}/invitations";
const view = wizardView([wizardStep("compliance_officer_assigned", 1, { owner: "either" })]);
const member = (id: string, name: string, status = "active") => ({
  membershipId: id,
  userId: `u-${id}`,
  organizationId: "org-1",
  organizationName: "Cedar Ridge",
  status,
  isAdmin: false,
  defaultLocationIds: [],
  displayName: name,
  email: `${name.toLowerCase().replace(/\W+/g, ".")}@example.org`,
  username: null,
  credentialState: "active",
  lastLoginAt: null,
  accountStatus: "active",
});
const OFFICER_ROLE = { grantId: "g-1", roleId: "r-co", roleKey: "compliance_officer" };
/** Dana holds the officer role, Lee does not, and one member is no longer active. */
const ROLES_BY_MEMBER: Record<string, unknown[]> = { "m-2": [OFFICER_ROLE], "m-3": [] };
const roster =
  (...members: ReturnType<typeof member>[]) =>
  () =>
    ok({ members, pendingInvitations: 0 });
const DANA = member("m-2", "Dana Ames");
const LEE = member("m-3", "Lee Park");
const GONE = member("m-4", "Gone Person", "revoked");

function handlers(over: { put?: () => unknown; members?: ReturnType<typeof roster> } = {}) {
  return stubClient({
    GET: {
      [MEMBERS]: over.members ?? roster(DANA, LEE, GONE),
      [MEMBER_ROLES]: (init) =>
        ok({ roles: ROLES_BY_MEMBER[(init.params?.path as { id: string }).id] ?? [OFFICER_ROLE] }),
    },
    POST: { [INVITE]: () => ok({ invitationId: "i-1", expiresAt: "2026-12-01" }) },
    PUT: { [OFFICER]: (over.put ?? (() => ok({ complianceOfficerMembershipId: "m-2" }))) as never },
  });
}
function mount(
  client: ReturnType<typeof stubClient>,
  session = ORG_ADMIN,
  at: Parameters<typeof renderAt>[0] = "/x",
  onChanged = vi.fn(async () => undefined),
) {
  const rendered = renderAt(
    at,
    [
      {
        path: "/x",
        element: (
          <OfficerPanel {...panelProps(view, "compliance_officer_assigned", session, onChanged)} />
        ),
      },
    ],
    client,
    session,
  );
  return { onChanged, ...rendered };
}
const pick = async (): Promise<void> => {
  fireEvent.click(await screen.findByRole("radio", { name: /dana ames/i }));
};
const assign = (): void => {
  fireEvent.click(screen.getByRole("button", { name: /assign compliance officer|assigning/i }));
};

describe("OfficerPanel: who is offered", () => {
  it("offers only active staff who already hold the compliance officer role", async () => {
    mount(handlers());
    expect(await screen.findByRole("radio", { name: /dana ames/i })).toBeTruthy();
    expect(screen.queryByText(/lee park/i)).toBeNull(); // active, but without the role
    expect(screen.queryByText(/gone person/i)).toBeNull(); // holds the role, but is not active
  });

  it("says ChartWarden assigns the role when no one holds it, and offers no assign button", async () => {
    mount(handlers({ members: roster(LEE, GONE) }));
    expect(
      await screen.findByText(
        /ChartWarden assigns the compliance officer role\. Ask ChartWarden to give it to the person you want, then choose them here\./,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button", { name: /assign compliance officer/i })).toBeNull();
  });

  it("reports a failed staff or role read with a retry", async () => {
    const client = stubClient({
      GET: { [MEMBERS]: roster(DANA), [MEMBER_ROLES]: () => refused(500, "BOOM") },
    });
    mount(client);
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not load your staff/i);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("never grants the role: nothing in the panel posts to a membership's roles", async () => {
    const client = handlers();
    mount(client);
    await pick();
    assign();
    await waitFor(() => expect(client.PUT).toHaveBeenCalledTimes(1));
    expect(client.POST.mock.calls.some((c) => String(c[0]).includes("/memberships/"))).toBe(false);
  });
});

describe("OfficerPanel: assigning", () => {
  it("assigns with an Idempotency-Key and reloads the wizard", async () => {
    const client = handlers();
    const { onChanged } = mount(client);
    await pick();
    assign();

    await waitFor(() => expect(client.PUT).toHaveBeenCalledTimes(1));
    const [, init] = client.PUT.mock.calls[0] as [string, { body: unknown }];
    expect(init.body).toEqual({ membershipId: "m-2" });
    expect(keyOf(client.PUT.mock.calls[0] as unknown[])).toMatch(/\S+/);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("tells the tenant to ask ChartWarden when the server says the person lacks the role", async () => {
    mount(handlers({ put: () => refused(422, "COMPLIANCE_OFFICER_LACKS_ROLE") }));
    await pick();
    assign();
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /ChartWarden assigns that role: ask ChartWarden to give it to them, then choose them here/i,
    );
  });

  it("tells the tenant what to do when ChartWarden staff are picked", async () => {
    mount(handlers({ put: () => refused(422, "COMPLIANCE_OFFICER_PLATFORM_STAFF") }));
    await pick();
    assign();
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /cannot be your compliance officer/i,
    );
  });

  it("reloads the wizard when the refusal says it moved (the server's copy says it was reloaded)", async () => {
    const { onChanged } = mount(handlers({ put: () => refused(409, "TENANT_NOT_ONBOARDING") }));
    await pick();
    assign();
    expect((await screen.findByRole("alert")).textContent).toMatch(/not in onboarding/i);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("offers Re-verify on a stale step-up and keeps the pick on return", async () => {
    const client = handlers({ put: () => refused(403, "STEP_UP_REQUIRED") });
    const first = mount(client);
    await pick();
    assign();
    fireEvent.click(await screen.findByRole("link", { name: "Re-verify" }));
    await screen.findByText("step-up page");
    first.unmount();

    mount(client, ORG_ADMIN, RETURNED_FROM_STEP_UP);
    const radio = (await screen.findByRole("radio", { name: /dana ames/i })) as HTMLInputElement;
    expect(radio.checked).toBe(true);
  });

  it("drops a second click while the first is in flight", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = handlers({
      put: async () => {
        await gate;
        return ok({ complianceOfficerMembershipId: "m-2" });
      },
    });
    mount(client);
    await pick();
    assign();
    assign();
    release();
    await waitFor(() => expect(client.PUT).toHaveBeenCalledTimes(1));
  });

  it("reuses the same Idempotency-Key when the first attempt got no answer", async () => {
    let calls = 0;
    const client = handlers({
      put: () => {
        calls += 1;
        if (calls === 1) throw new Error("offline");
        return ok({ complianceOfficerMembershipId: "m-2" });
      },
    });
    mount(client);
    await pick();
    assign();
    await screen.findByText(/could not reach the server/i);
    assign();
    await waitFor(() => expect(client.PUT).toHaveBeenCalledTimes(2));
    expect(keyOf(client.PUT.mock.calls[1] as unknown[])).toBe(
      keyOf(client.PUT.mock.calls[0] as unknown[]),
    );
  });

  it("renews the key after an answer, a refusal included", async () => {
    let calls = 0;
    const client = handlers({
      put: () => {
        calls += 1;
        return calls === 1
          ? refused(422, "COMPLIANCE_OFFICER_PLATFORM_STAFF")
          : ok({ complianceOfficerMembershipId: "m-2" });
      },
    });
    mount(client);
    await pick();
    assign();
    await screen.findByRole("alert");
    assign();
    await waitFor(() => expect(client.PUT).toHaveBeenCalledTimes(2));
    expect(keyOf(client.PUT.mock.calls[1] as unknown[])).not.toBe(
      keyOf(client.PUT.mock.calls[0] as unknown[]),
    );
  });
});

describe("OfficerPanel: inviting and read-only", () => {
  it("invites a colleague with no role proposed", async () => {
    const client = handlers();
    mount(client);
    fireEvent.change(await screen.findByLabelText(/invite a colleague/i), {
      target: { value: "robin@example.org" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Invite someone" }));

    await waitFor(() => expect(client.POST).toHaveBeenCalled());
    const invite = client.POST.mock.calls.find((c) => c[0] === INVITE) as [
      string,
      { params: unknown; body: unknown },
    ];
    expect(invite[1].params).toEqual({ path: { id: "org-1" } });
    expect(invite[1].body).toEqual({ email: "robin@example.org" });
    expect(await screen.findByText("Invitation sent.")).toBeTruthy();
  });

  it("is read-only for the compliance officer and reads nobody's staff list", () => {
    const client = handlers();
    mount(client, COMPLIANCE_OFFICER);
    expect(screen.getByText(/your role cannot assign the compliance officer/i)).toBeTruthy();
    expect(client.GET).not.toHaveBeenCalled();
  });
});
