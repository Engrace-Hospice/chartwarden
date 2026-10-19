// IDG Schedule — the "Schedule Meeting" write (POST /idg/meetings) and the name rendering that
// replaced short ids (coordinator via /orgs/{id}/members, patient via `patient.displayName`).
// Asserts on RECORDED FETCH CALLS (method, path, body), like idg-writes.dom.test.tsx.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { IdgSchedule } from "./idg-schedule";
import { MeetingDetail } from "./meeting-detail";

const LOC = "11111111-1111-4111-8111-111111111111";
const LOC_OUT = "99999999-9999-4999-8999-999999999999";
const ME = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const MEETING = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PATIENT = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const PATIENT2 = "cccccccc-2222-4222-8222-cccccccccccc";

let calls: string[] = [];
let bodies: Record<string, unknown>[] = [];
let scheduled: Record<string, unknown>[] = [];
let postFailure: { status: number; body: unknown } | null = null;
let scheduleFailure: { status: number; body: unknown } | null = null;
let locationsFailure = false;

const meetingBody = (coordinator: string) => ({
  id: MEETING,
  organizationId: "org-1",
  locationId: LOC,
  status: "scheduled",
  scheduledStart: "2099-08-27T09:00:00.000Z",
  scheduledEnd: "2099-08-27T10:00:00.000Z",
  adjournedAt: null,
  coordinatorMembershipId: coordinator,
});

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : null;
  const url = req ? req.url : String(input);
  const method = (req?.method ?? init?.method ?? "GET").toUpperCase();
  const path = new URL(url, "http://localhost").pathname;
  calls.push(`${method} ${path}`);
  const json = (b: unknown, status = 200): Response =>
    new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  if (method === "POST") {
    const raw = req ? await req.clone().text() : String(init?.body ?? "");
    bodies.push(JSON.parse(raw) as Record<string, unknown>);
    if (postFailure) return json(postFailure.body, postFailure.status);
    scheduled = [meetingBody(ME)];
    return json(meetingBody(ME), 201);
  }
  if (path === "/api/v1/locations") {
    if (locationsFailure) return json({ error: { code: "UNAVAILABLE" } }, 503);
    return json({ items: [
      { id: LOC, name: "Main Campus", status: "active" },
      { id: LOC_OUT, name: "Restricted Campus", status: "active" },
    ], nextCursor: null });
  }
  if (path === "/api/v1/orgs/org-1/members")
    return json({
      members: [
        { membershipId: ME, userId: "u1", displayName: "Dana Coordinator", email: null },
        { membershipId: OTHER, userId: "u2", displayName: "Omar Other", email: null },
      ],
    });
  if (path === "/api/v1/idg/schedule")
    return scheduleFailure ? json(scheduleFailure.body, scheduleFailure.status) : json(scheduled);
  if (path === `/api/v1/idg/meetings/${MEETING}`) return json(meetingBody(OTHER));
  if (path.endsWith("/packets"))
    return json([
      {
        packetId: "p1",
        meetingId: MEETING,
        patientId: PATIENT,
        patient: { displayName: "Ada L.", mrnSuffix: "4821" },
        frozenAt: null,
      },
      { packetId: "p2", meetingId: MEETING, patientId: PATIENT2, patient: null, frozenAt: null },
    ]);
  if (path.endsWith("/agenda"))
    return json([
      {
        id: "ag1",
        meetingId: MEETING,
        kind: "patient_review",
        patientId: PATIENT,
        patient: { displayName: "Ada L.", mrnSuffix: "4821" },
      },
    ]);
  return json([]);
}

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: ME,
  roles: ["idg_coordinator"],
  locationIds: [LOC],
  orgWidePatientScope: false,
  permissions: ["idg.read", "idg.schedule"],
  isAdmin: false,
};

function mount(path: string, element: JSX.Element, route: string, session = SESSION): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={session}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path={route} element={element} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

const mountSchedule = () =>
  mount(`/idg/schedule?location=${LOC}`, <IdgSchedule />, "/idg/schedule");

async function fillAndSubmit(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: /^Schedule Meeting$/ }));
  await screen.findByRole("dialog");
  fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2099-08-27" } });
  fireEvent.change(screen.getByLabelText("Start time"), { target: { value: "09:00" } });
  fireEvent.change(screen.getByLabelText("End time"), { target: { value: "10:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Schedule meeting" }));
}

beforeEach(() => {
  calls = [];
  bodies = [];
  scheduled = [];
  postFailure = null;
  scheduleFailure = null;
  locationsFailure = false;
});
afterEach(cleanup);

describe("IDG schedule — Schedule Meeting", () => {
  it("POSTs the location, ISO instants and the caller as coordinator, then refreshes the list", async () => {
    mountSchedule();
    await fillAndSubmit();
    await waitFor(() => expect(calls).toContain("POST /api/v1/idg/meetings"));
    expect(bodies[0]?.locationId).toBe(LOC);
    expect(bodies[0]?.coordinatorMembershipId).toBe(ME);
    expect(new Date(bodies[0]?.scheduledStart as string).toISOString()).toBe(
      new Date("2099-08-27T09:00").toISOString(),
    );
    expect(new Date(bodies[0]?.scheduledEnd as string).toISOString()).toBe(
      new Date("2099-08-27T10:00").toISOString(),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The list was re-read and the coordinator is a name, not an id prefix.
    await waitFor(() => expect(screen.getAllByText("Dana Coordinator").length).toBeGreaterThan(0));
  });

  it("shows the overlap message on 409 and keeps the dialog open", async () => {
    postFailure = { status: 409, body: { error: { code: "IDG_MEETING_OVERLAP", message: "x" } } };
    mountSchedule();
    await fillAndSubmit();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/overlaps another IDG meeting/i);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("shows the server's validation message on 422", async () => {
    postFailure = {
      status: 422,
      body: {
        error: { code: "VALIDATION_FAILED", message: "scheduledEnd must be after scheduledStart" },
      },
    };
    mountSchedule();
    await fillAndSubmit();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("scheduledEnd must be after scheduledStart");
  });

  it("surfaces a 403 without pre-empting it", async () => {
    postFailure = { status: 403, body: { error: { code: "FORBIDDEN", message: "nope" } } };
    mountSchedule();
    await fillAndSubmit();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/not permitted to schedule/i);
  });

  it("the empty state offers the same Schedule Meeting dialog", async () => {
    mountSchedule();
    await screen.findByText(/No IDG meetings fall in the next 8 weeks/);
    const buttons = screen.getAllByRole("button", { name: /^Schedule Meeting$/ });
    expect(buttons.length).toBe(2);
    fireEvent.click(buttons[1] as HTMLElement);
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("offers only server-session locations and hides scheduling controls without idg.schedule", async () => {
    mount(
      `/idg/schedule?location=${LOC}`,
      <IdgSchedule />,
      "/idg/schedule",
      { ...SESSION, permissions: ["idg.read"] },
    );
    const picker = await screen.findByLabelText("Location");
    expect(picker.textContent).toContain("Main Campus");
    expect(picker.textContent).not.toContain("Restricted Campus");
    expect(screen.queryByRole("button", { name: /^Schedule Meeting$/ })).toBeNull();
  });

  it("renders a non-disclosing forbidden state with retry and back navigation", async () => {
    scheduleFailure = { status: 404, body: { error: { code: "NOT_FOUND", message: "hidden" } } };
    mountSchedule();
    expect(await screen.findByText("Location unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to schedule" })).toBeTruthy();
    expect(screen.queryByText("hidden")).toBeNull();
  });

  it("distinguishes a location-directory failure from having no accessible locations", async () => {
    locationsFailure = true;
    mountSchedule();
    expect(await screen.findByText("Locations unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("Select a location")).toBeNull();
  });
});

describe("meeting detail — names", () => {
  it("renders the coordinator name and patient displayName, falling back to the id prefix", async () => {
    mount(`/idg/meetings/${MEETING}`, <MeetingDetail />, "/idg/meetings/:id");
    await waitFor(() => expect(screen.getAllByText(/Omar Other/).length).toBeGreaterThan(0));
    expect(screen.getAllByText("Ada L.").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/MRN ···4821/).length).toBeGreaterThan(0);
    // The patient the server sent no name for keeps the id prefix.
    expect(screen.getAllByText(PATIENT2.slice(0, 8)).length).toBeGreaterThan(0);
  });
});
