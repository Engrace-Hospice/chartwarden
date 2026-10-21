import { render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { RoleHome } from "./role-home";
import type { WebScreenDescriptor } from "./screen-registry";
import { SessionProvider } from "./session";
import type { Session } from "./session";

const screens: WebScreenDescriptor[] = [
  {
    id: "admission.create",
    path: "/admissions/new",
    title: "New admission",
    requiredPermission: "admission.create",
    screen: () => null,
  },
  {
    id: "admission.referrals",
    path: "/referrals",
    title: "Referral Inbox",
    requiredPermission: "referral.read",
    screen: () => null,
  },
  {
    id: "admission.census",
    path: "/admissions",
    title: "Admissions",
    requiredPermission: "admission.read",
    screen: () => null,
  },
  {
    id: "safety.dashboard",
    path: "/safety",
    title: "Safety board",
    requiredPermission: "safety.dashboard.read",
    screen: () => null,
  },
  {
    id: "quality.qapi-incidents",
    path: "/quality/qapi",
    title: "QAPI & Incidents",
    requiredPermission: "incident.read",
    screen: () => null,
  },
  {
    id: "identity.staff-management",
    path: "/admin/staff",
    title: "Staff Management",
    requiredPermission: "member.manage",
    screen: () => null,
  },
];

const adminSession: Session = {
  userId: "ada",
  organizationId: "org-1",
  membershipId: "mem-1",
  displayName: "Ada Lovelace",
  organizationName: "ChartWarden",
  roles: ["administrator"],
  isAdmin: true,
  permissions: [
    "admission.create",
    "referral.read",
    "admission.read",
    "safety.dashboard.read",
    "incident.read",
    "member.manage",
  ],
};

function response(data: unknown) {
  return { data, error: undefined, response: new Response(null, { status: 200 }) };
}

function errorResponse(message = "nope") {
  return {
    data: undefined,
    error: { error: { code: "TEST", message } },
    response: new Response(null, { status: 500 }),
  };
}

function clientFor(map: Record<string, unknown>, failures: readonly string[] = []): ApiClient {
  return {
    GET: vi.fn(async (path: string) =>
      failures.includes(path)
        ? errorResponse()
        : response(map[path] ?? { items: [], nextCursor: null }),
    ),
  } as unknown as ApiClient;
}

function renderHome(session: Session, client: ApiClient): void {
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <SessionProvider session={session}>
          <RoleHome screens={screens} />
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("RoleHome operational dashboard", () => {
  it("renders an admin dashboard from real endpoint-shaped data", async () => {
    renderHome(
      adminSession,
      clientFor({
        "/api/v1/referrals": {
          items: [
            { id: "r1", state: "received" },
            { id: "r2", state: "triaged" },
          ],
          nextCursor: null,
        },
        "/api/v1/admissions": {
          items: [
            { id: "a1", state: "pending" },
            { id: "a2", state: "active" },
          ],
          nextCursor: null,
        },
        "/api/v1/safety/dashboard": {
          clinicians: [
            {
              membershipId: "m1",
              displayName: "Nurse One",
              overdueState: "ok",
              activeSosAlert: null,
            },
            {
              membershipId: "m2",
              displayName: "Nurse Two",
              overdueState: "overdue",
              activeSosAlert: { id: "sos1" },
            },
          ],
        },
        "/api/v1/quality/incidents": {
          items: [{ id: "q1", state: "submitted", severity: "critical" }],
          nextCursor: null,
        },
      }),
    );

    await waitFor(() => expect(screen.getByText(/active SOS alert/i)).toBeTruthy());
    expect(screen.getByRole("heading", { name: /Ada/i })).toBeTruthy();
    expect(screen.getByText(/referral awaiting triage/i)).toBeTruthy();
    expect(screen.getByText(/admission pending/i)).toBeTruthy();
    expect(screen.getByText(/severe quality incident/i)).toBeTruthy();
    expect(
      screen
        .getAllByRole("link", { name: /new admission/i })
        .some((link) => link.getAttribute("href") === "/admissions/new"),
    ).toBe(true);
    expect(screen.queryByText("Staff Management")).not.toBeNull();
  });

  it("does not call or show widgets outside the user's permissions", async () => {
    const client = clientFor({
      "/api/v1/referrals": { items: [{ id: "r1", state: "received" }], nextCursor: null },
    });
    renderHome({ ...adminSession, permissions: ["referral.read"], roles: ["intake"] }, client);

    await waitFor(() => expect(screen.getByText(/referral awaiting triage/i)).toBeTruthy());
    expect(client.GET).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Safety board")).toBeNull();
    expect(screen.queryByText("Staff Management")).toBeNull();
  });

  it("shows a healthy attention state when accessible queues are empty", async () => {
    renderHome(
      { ...adminSession, permissions: ["referral.read", "admission.read"] },
      clientFor({
        "/api/v1/referrals": { items: [], nextCursor: null },
        "/api/v1/admissions": { items: [], nextCursor: null },
      }),
    );

    await waitFor(() => expect(screen.getByText("You're all caught up")).toBeTruthy());
  });

  it("keeps the page usable on partial dashboard errors", async () => {
    renderHome(
      { ...adminSession, permissions: ["referral.read", "safety.dashboard.read"] },
      clientFor(
        { "/api/v1/referrals": { items: [{ id: "r1", state: "received" }], nextCursor: null } },
        ["/api/v1/safety/dashboard"],
      ),
    );

    await waitFor(() => expect(screen.getByText(/referral awaiting triage/i)).toBeTruthy());
    expect(screen.getByText(/Some dashboard sections could not be loaded: safety/i)).toBeTruthy();
  });

  it("does not call HOPE or out-of-scope IDG schedules for a caseload-scoped actor", async () => {
    const client = clientFor({
      "/api/v1/locations": {
        items: [
          { id: "loc-a", name: "A", status: "active" },
          { id: "loc-b", name: "B", status: "active" },
        ],
      },
    });
    renderHome(
      {
        ...adminSession,
        permissions: ["hope.timepoint.read", "idg.read"],
        roles: ["rn"],
        isAdmin: false,
        orgWidePatientScope: false,
        locationIds: ["loc-a"],
      },
      client,
    );

    await waitFor(() =>
      expect(client.GET).toHaveBeenCalledWith(
        "/api/v1/idg/schedule",
        expect.objectContaining({
          params: { query: expect.objectContaining({ location: "loc-a" }) },
        }),
      ),
    );
    const paths = (client.GET as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(paths).not.toContain("/api/v1/hope/schedules");
    const locs = (client.GET as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => c[0] === "/api/v1/idg/schedule")
      .map((c) => c[1].params.query.location);
    expect(locs).toEqual(["loc-a"]);
  });

  it("calls HOPE and asks IDG for every location for an org-wide-scope actor", async () => {
    const client = clientFor({
      "/api/v1/locations": {
        items: [
          { id: "loc-a", name: "A", status: "active" },
          { id: "loc-b", name: "B", status: "active" },
        ],
      },
    });
    renderHome(
      {
        ...adminSession,
        permissions: ["hope.timepoint.read", "idg.read"],
        roles: ["director_of_nursing"],
        isAdmin: false,
        orgWidePatientScope: true,
        locationIds: ["loc-a"],
      },
      client,
    );

    await waitFor(() => {
      const calls = (client.GET as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.filter((c) => c[0] === "/api/v1/idg/schedule")).toHaveLength(2);
    });
    const calls = (client.GET as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.map((c) => c[0])).toContain("/api/v1/hope/schedules");
    expect(
      calls
        .filter((c) => c[0] === "/api/v1/idg/schedule")
        .map((c) => c[1].params.query.location)
        .sort(),
    ).toEqual(["loc-a", "loc-b"]);
  });
});
