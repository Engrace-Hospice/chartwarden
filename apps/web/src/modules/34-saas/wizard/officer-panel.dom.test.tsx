// @vitest-environment jsdom
// Step 12, Compliance officer: the administrator picks one of the organization's own staff (a fresh step-up), after giving them the
// compliance officer role when they lack it, or invites someone.
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
const ROLES = "/api/v1/roles";
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
const roster = () =>
  ok({
    members: [member("m-2", "Dana Ames"), member("m-3", "Gone Person", "revoked")],
    pendingInvitations: 0,
  });

function handlers(over: { held?: unknown[]; put?: () => unknown } = {}) {
  return stubClient({
    GET: {
      [MEMBERS]: roster,
      [MEMBER_ROLES]: () => ok({ roles: over.held ?? [] }),
      [ROLES]: () =>
        ok({ roles: [{ roleId: "r-co", key: "compliance_officer", name: "Compliance officer" }] }),
    },
    POST: {
      [MEMBER_ROLES]: () => ok({ granted: true }),
      [INVITE]: () => ok({ invitationId: "i-1", expiresAt: "2026-12-01" }),
    },
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

describe("OfficerPanel", () => {
  it("lists only active staff", async () => {
    mount(handlers());
    expect(await screen.findByRole("radio", { name: /dana ames/i })).toBeTruthy();
    expect(screen.queryByText(/gone person/i)).toBeNull();
  });

  it("gives the role first when the person lacks it, then assigns with an Idempotency-Key and reloads", async () => {
    const client = handlers();
    const { onChanged } = mount(client);
    await pick();
    assign();

    await waitFor(() => expect(client.PUT).toHaveBeenCalledTimes(1));
    const grant = client.POST.mock.calls.find((c) => c[0] === MEMBER_ROLES) as [
      string,
      { params: unknown; body: unknown },
    ];
    expect(grant[1].body).toEqual({ roleId: "r-co" });
    const [, init] = client.PUT.mock.calls[0] as [string, { body: unknown }];
    expect(init.body).toEqual({ membershipId: "m-2" });
    expect(keyOf(client.PUT.mock.calls[0] as unknown[])).toMatch(/\S+/);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("does not grant the role again when the person already holds it", async () => {
    const client = handlers({
      held: [{ grantId: "g-1", roleId: "r-co", roleKey: "compliance_officer" }],
    });
    mount(client);
    await pick();
    assign();
    await waitFor(() => expect(client.PUT).toHaveBeenCalledTimes(1));
    expect(client.POST.mock.calls.some((c) => c[0] === MEMBER_ROLES)).toBe(false);
  });

  it("tells the tenant what to do when ChartWarden staff are picked", async () => {
    mount(handlers({ put: () => refused(422, "COMPLIANCE_OFFICER_PLATFORM_STAFF") }));
    await pick();
    assign();
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /cannot be your compliance officer/i,
    );
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

  it("invites someone with the officer role proposed", async () => {
    const client = handlers();
    mount(client);
    fireEvent.change(await screen.findByLabelText(/invite someone as compliance officer/i), {
      target: { value: "robin@example.org" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Invite someone" }));

    await waitFor(() => expect(client.POST).toHaveBeenCalled());
    const invite = client.POST.mock.calls.find((c) => c[0] === INVITE) as [
      string,
      { params: unknown; body: unknown },
    ];
    expect(invite[1].params).toEqual({ path: { id: "org-1" } });
    expect(invite[1].body).toEqual({
      email: "robin@example.org",
      proposedRoleKeys: ["compliance_officer"],
    });
    expect(await screen.findByText("Invitation sent.")).toBeTruthy();
  });

  it("is read-only for the compliance officer and reads nobody's staff list", () => {
    const client = handlers();
    mount(client, COMPLIANCE_OFFICER);
    expect(screen.getByText(/your role cannot assign the compliance officer/i)).toBeTruthy();
    expect(client.GET).not.toHaveBeenCalled();
  });
});
