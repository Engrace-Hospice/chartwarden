// apps/web/src/modules/14-idg — 2026-09 redesign of IDG Schedule + Meeting Detail: the spec gaps
// (location + live quorum in the header, agenda kinds, carry-forward compliance alert, packets-building
// progress, empty state) render from the data the routes actually return.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { IdgSchedule } from "./idg-schedule";
import { MeetingDetail } from "./meeting-detail";

const MEETING = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const LOC = "99999999-1111-4111-8111-999999999999";
const P1 = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const P2 = "cccccccc-2222-4222-8222-cccccccccccc";

let status = "packets_building";
let agenda: Record<string, unknown>[] = [];
let scheduleRows: Record<string, unknown>[] = [];
let attendance: Record<string, unknown>[] = [];

function respond(path: string): unknown {
  if (path.endsWith("/locations"))
    return { items: [{ id: LOC, name: "North Campus", status: "active" }] };
  if (path.endsWith("/idg/schedule")) return scheduleRows;
  if (path.endsWith("/packets"))
    return [
      { packetId: "p-1", meetingId: MEETING, patientId: P1, frozenAt: "2026-09-29T08:00:00.000Z" },
      { packetId: "p-2", meetingId: MEETING, patientId: P2, frozenAt: null },
    ];
  if (path.endsWith("/agenda")) return agenda;
  if (path.endsWith("/attendance")) return attendance;
  return {
    id: MEETING,
    organizationId: "org-1",
    locationId: LOC,
    status,
    scheduledStart: "2026-10-01T09:00:00.000Z",
    scheduledEnd: "2026-10-01T10:00:00.000Z",
    adjournedAt: null,
  };
}

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  void init;
  return new Response(JSON.stringify(respond(new URL(url, "http://localhost").pathname)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mount(path: string, element: JSX.Element, route: string): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider
        session={{
          userId: "u",
          organizationId: "org-1",
          membershipId: "m",
          roles: ["idg_coordinator"],
          permissions: [],
          isAdmin: false,
        }}
      >
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

afterEach(() => {
  cleanup();
  status = "packets_building";
  agenda = [];
  scheduleRows = [];
  attendance = [];
});

describe("Meeting Detail redesign", () => {
  it("shows location, per-patient build progress, and the not-quorate indicator", async () => {
    attendance = [
      {
        id: "a1",
        meetingId: MEETING,
        membershipId: "m1",
        discipline: "msw",
        status: "present",
        checkedInAt: null,
      },
    ];
    mount(`/idg/meetings/${MEETING}`, <MeetingDetail />, "/idg/meetings/:id");
    expect((await screen.findAllByText("North Campus")).length).toBeGreaterThan(0);
    expect(await screen.findByText("Packets building")).toBeTruthy();
    expect(screen.getByText("1 of 2 patient packets built")).toBeTruthy();
    expect(
      screen.getAllByText(/Not quorate — missing Physician, RN, Chaplain/).length,
    ).toBeGreaterThan(0);
  });

  it("raises the compliance alert at 3+ carry-forward agenda items", async () => {
    status = "packets_ready";
    agenda = [1, 2, 3].map((n) => ({
      id: `c${n}`,
      meetingId: MEETING,
      kind: "carry_forward",
      patientId: P1,
    }));
    mount(`/idg/meetings/${MEETING}`, <MeetingDetail />, "/idg/meetings/:id");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/3 carry-forward items/);
  });

  it("does not raise it below the threshold", async () => {
    status = "packets_ready";
    agenda = [{ id: "c1", meetingId: MEETING, kind: "carry_forward", patientId: P1 }];
    mount(`/idg/meetings/${MEETING}`, <MeetingDetail />, "/idg/meetings/:id");
    await screen.findByText("Agenda");
    await waitFor(() => expect(screen.getAllByText("Carry-forward").length).toBeGreaterThan(0));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("IDG Schedule redesign", () => {
  it("names the location and lists the meeting", async () => {
    scheduleRows = [
      {
        id: MEETING,
        locationId: LOC,
        status: "packets_ready",
        scheduledStart: "2026-10-01T09:00:00.000Z",
        scheduledEnd: "2026-10-01T10:00:00.000Z",
      },
    ];
    mount(`/idg/schedule?location=${LOC}`, <IdgSchedule />, "/idg/schedule");
    await waitFor(() => expect(screen.getAllByText("North Campus").length).toBeGreaterThan(0));
  });

  it("shows the spec empty state when the location has no meetings", async () => {
    mount(`/idg/schedule?location=${LOC}`, <IdgSchedule />, "/idg/schedule");
    expect(await screen.findByText("No IDG meeting scheduled for this location.")).toBeTruthy();
  });
});
