import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// apps/web/src/modules/05-patient — the patient chart's "Assign care team member" dialog (M5 §4.3).
//
// The dialog posted `{ clinicianMembershipId, role }` to POST /api/v1/patients/:id/assignments behind an
// `as never` cast, but the route's schema takes `clinicianUserId` (a user uuid) and rejects unknown
// fields — so EVERY assignment answered 400 "request validation failed" in production. These tests
// assert on the RECORDED REQUEST BODY, which is the contract the route validates.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import { CareTeamTab } from "./patient-chart";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ORG = "org-1";
const RN_USER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const RN_MEMBERSHIP = "cccccccc-3333-4333-8333-cccccccccccc";

const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: ORG,
  displayName: "Ada Administrator",
  permissions: ["patient.read", "patient.assign"],
};

let posts: { path: string; body: unknown }[] = [];
let gets: string[] = [];
// Per-test knobs: the assignments the care-team read returns and whether the staff lookup fails.
let careTeamAssignments: Record<string, unknown>[] = [];
let staffLookupStatus = 200;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const url = new URL(req.url, "http://localhost");
  if (req.method === "POST") {
    posts.push({
      path: url.pathname,
      body: req.headers.get("content-length") === "0" ? null : await req.json().catch(() => null),
    });
    if (url.pathname === `/api/v1/messaging/patients/${PATIENT}/care-team-channel`) {
      return json({
        channelId: "care-team-channel-1",
        kind: "care_team",
        patientId: PATIENT,
        archived: false,
      });
    }
    return json({ id: "asg-1" }, 201);
  }
  gets.push(url.pathname);
  if (url.pathname === `/api/v1/patients/${PATIENT}/care-team`) {
    return json({ assignments: careTeamAssignments, caregivers: [], emergencyContacts: [] });
  }
  if (url.pathname === `/api/v1/orgs/${ORG}/care-team-staff`) {
    if (staffLookupStatus !== 200) {
      return json({ error: { code: "FORBIDDEN", message: "no" } }, staffLookupStatus);
    }
    return json({
      staff: [
        {
          membershipId: RN_MEMBERSHIP,
          userId: RN_USER,
          displayName: "Nora Visit, RN",
          roleLabels: ["Registered Nurse"],
        },
      ],
    });
  }
  return json({ error: { code: "NOT_FOUND", message: "not found" } }, 404);
}

function mount(as: Session = session) {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={as}>
        <ToastProvider>
          <MemoryRouter>
            <Routes>
              <Route path="*" element={<CareTeamTab patientId={PATIENT} organizationId={ORG} />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

function MessagingDestination() {
  const location = useLocation();
  const state = location.state as { messagingChannelId?: string } | null;
  return <div>Messaging destination {state?.messagingChannelId}</div>;
}

function mountWithMessagingDestination() {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={session}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/patients/care-team"]}>
            <Routes>
              <Route
                path="/patients/care-team"
                element={<CareTeamTab patientId={PATIENT} organizationId={ORG} />}
              />
              <Route path="/messaging" element={<MessagingDestination />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

async function pickClinicianAndRole(roleName: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Assign care team member" }));
  fireEvent.focus(screen.getByRole("combobox"));
  fireEvent.click(await screen.findByRole("option", { name: /Nora Visit, RN/ }));
  fireEvent.click(screen.getByRole("button", { name: /Primary RN/ }));
  fireEvent.click(screen.getByRole("option", { name: roleName }));
  fireEvent.click(screen.getByRole("button", { name: "Assign clinician" }));
}

const assignment = (over: Record<string, unknown>) => ({
  id: "asg-1",
  patientId: PATIENT,
  clinicianUserId: RN_USER,
  role: "primary_rn",
  assignedAt: "2026-10-01",
  unassignedAt: null,
  reason: null,
  current: true,
  ...over,
});

beforeEach(() => {
  posts = [];
  gets = [];
  careTeamAssignments = [];
  staffLookupStatus = 200;
});

describe("Assign care team member", () => {
  it("posts the clinician's USER id under `clinicianUserId`, the field the route validates", async () => {
    mount();
    await pickClinicianAndRole("Primary RN");

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      path: `/api/v1/patients/${PATIENT}/assignments`,
      body: { clinicianUserId: RN_USER, role: "primary_rn" },
    });
  });

  it("offers an additional RN role beside Primary RN", async () => {
    mount();
    await pickClinicianAndRole("RN");

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.body).toEqual({ clinicianUserId: RN_USER, role: "rn" });
  });

  it("opens the patient care-team conversation and navigates with only the opaque channel id", async () => {
    mountWithMessagingDestination();
    fireEvent.click(await screen.findByRole("button", { name: "Open care team conversation" }));

    await screen.findByText("Messaging destination care-team-channel-1");
    expect(posts).toContainEqual({
      path: `/api/v1/messaging/patients/${PATIENT}/care-team-channel`,
      body: null,
    });
  });

  it("loads names from the care-team response and never calls the staff lookup on load", async () => {
    careTeamAssignments = [assignment({ displayName: "Nora Visit, RN" })];
    mount();
    expect((await screen.findAllByText("Nora Visit, RN")).length).toBeGreaterThan(0);
    expect(gets).not.toContain(`/api/v1/orgs/${ORG}/care-team-staff`);
    expect(gets).not.toContain(`/api/v1/orgs/${ORG}/members`);
  });

  it("a read-only viewer without patient.assign sees names and triggers no 403 lookup", async () => {
    careTeamAssignments = [assignment({ displayName: "Nora Visit, RN" })];
    staffLookupStatus = 403;
    mount({ ...session, permissions: ["patient.read"] });
    expect((await screen.findAllByText("Nora Visit, RN")).length).toBeGreaterThan(0);
    expect(gets).not.toContain(`/api/v1/orgs/${ORG}/care-team-staff`);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a neutral label, not a uuid prefix, when the response carries no name", async () => {
    careTeamAssignments = [
      assignment({ clinicianUserId: "dddddddd-4444-4444-8444-dddddddddddd", displayName: null }),
    ];
    mount();
    expect((await screen.findAllByText("Staff member")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/dddddddd/)).toBeNull();
  });

  it("tells the assigner when the staff lookup is forbidden, instead of a generic reload hint", async () => {
    staffLookupStatus = 403;
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Assign care team member" }));
    fireEvent.focus(screen.getByRole("combobox"));
    expect(await screen.findByText("You don't have permission to look up staff.")).toBeTruthy();
    expect(screen.queryByText(/Reload to try again/)).toBeNull();
  });

  it("explains the lookup is by name and capped, with role labels to tell duplicates apart", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Assign care team member" }));
    expect(screen.getByText(/Search by name\. Up to 25 shown\./)).toBeTruthy();
    fireEvent.focus(screen.getByRole("combobox"));
    expect(await screen.findByRole("option", { name: /Registered Nurse/ })).toBeTruthy();
  });

  it("does not list an admitting_staff access grant as a care-team member", async () => {
    careTeamAssignments = [
      assignment({ id: "asg-2", role: "admitting_staff", clinicianUserId: RN_USER }),
    ];
    mount();
    await screen.findByRole("button", { name: "Assign care team member" });
    expect(screen.queryByText("Admitting staff")).toBeNull();
    expect(screen.getByText("No care team members assigned yet")).toBeTruthy();
  });

  it("ignores a slow care-team response for a patient the tab has since left", async () => {
    const other = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const slowFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === `/api/v1/patients/${PATIENT}/care-team`) {
        await firstGate;
        return json({
          assignments: [assignment({ displayName: "Stale Person" })],
          caregivers: [],
          emergencyContacts: [],
        });
      }
      if (url.pathname === `/api/v1/patients/${other}/care-team`) {
        return json({
          assignments: [assignment({ id: "asg-9", displayName: "Fresh Person" })],
          caregivers: [],
          emergencyContacts: [],
        });
      }
      return stubFetch(input, init);
    };
    const client = createApiClient({ baseUrl: "http://localhost", fetch: slowFetch });
    const tree = (patientId: string) => (
      <ApiClientProvider client={client}>
        <SessionProvider session={session}>
          <ToastProvider>
            <MemoryRouter>
              <CareTeamTab patientId={patientId} organizationId={ORG} />
            </MemoryRouter>
          </ToastProvider>
        </SessionProvider>
      </ApiClientProvider>
    );
    const view = render(tree(PATIENT));
    view.rerender(tree(other));
    expect((await screen.findAllByText("Fresh Person")).length).toBeGreaterThan(0);
    releaseFirst();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("Stale Person")).toBeNull();
    expect(screen.getAllByText("Fresh Person").length).toBeGreaterThan(0);
  });
});
