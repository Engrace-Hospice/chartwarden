import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { render, screen, waitFor } from "@testing-library/react";
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

  it("asks HOPE but only the actor's own IDG locations for a caseload-scoped actor", async () => {
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
    expect(paths).toContain("/api/v1/hope/schedules");
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
  it("alerts a caseload-scoped clinician to overdue HOPE windows", async () => {
    const client = clientFor({
      "/api/v1/hope/schedules": {
        schedules: [
          {
            id: "s1",
            patientId: "p1",
            admissionId: "a1",
            rfaKind: "01_admission",
            windowClosesAt: "2020-01-01T00:00:00.000Z",
          },
        ],
      },
    });
    renderHome(
      { ...adminSession, permissions: ["hope.timepoint.read"], roles: ["rn"], isAdmin: false },
      client,
    );

    expect(await screen.findByText(/1 HOPE assessment past window/i)).toBeTruthy();
  });

  it("alerts a clinician to missed visits in the last week", async () => {
    const past = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const visit = (id: string, status: string) => ({
      id,
      patientId: "p1",
      visitPurpose: "routine_visit",
      scheduledStartedAt: past,
      scheduledEndedAt: past,
      status,
    });
    const client = clientFor({
      "/api/v1/visits": [
        visit("v1", "no_show"),
        visit("v2", "published"),
        visit("v3", "completed"),
      ],
    });
    renderHome(
      { ...adminSession, permissions: ["visit.read"], roles: ["rn"], isAdmin: false },
      client,
    );

    expect(await screen.findByText(/2 missed visits/i)).toBeTruthy();
  });
  it("alerts a clinician to overdue and closing-soon certification windows", async () => {
    const win = (id: string, windowKind: string, state: string) => ({
      id,
      state,
      version: 1,
      patientId: "p1",
      admissionId: "a1",
      windowKind,
      severity: "warning",
      dueAt: "2026-11-01T00:00:00.000Z",
    });
    const client = {
      GET: vi.fn(async (path: string, init?: { params?: { query?: { state?: string } } }) => {
        if (path !== "/api/v1/compliance-windows") return response({ items: [], nextCursor: null });
        const state = init?.params?.query?.state;
        const items =
          state === "overdue"
            ? [win("w1", "recert_due_7d", "overdue"), win("w2", "notice_of_rights", "overdue")]
            : [win("w3", "cti_signature_lookahead_14d", "closing_soon")];
        return response({ items, nextCursor: null });
      }),
    } as unknown as ApiClient;
    renderHome(
      { ...adminSession, permissions: ["compliance.read"], roles: ["rn"], isAdmin: false },
      client,
    );

    expect(await screen.findByText(/2 compliance windows overdue/i)).toBeTruthy();
    expect(await screen.findByText(/1 certification due soon/i)).toBeTruthy();
  });
});
