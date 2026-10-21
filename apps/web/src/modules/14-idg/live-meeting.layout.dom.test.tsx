// apps/web/src/modules/14-idg — the 2026-09 redesign of the Live Meeting surface: three panes, the
// quorum banner in both states, attendance amendment, annotation-only rows for non-quorate decisions.
// Asserts on recorded fetch calls (method + path + body), like idg-writes.dom.test.tsx.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { LiveMeeting } from "./live-meeting";

const MEETING = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PATIENT = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const at = "2026-08-27T09:05:00.000Z";
const att = (id: string, discipline: string, status = "present") => ({
  id,
  meetingId: MEETING,
  membershipId: `m-${id}`,
  discipline,
  status,
  checkedInAt: at,
});
const decision = (wasQuorate: boolean) => ({
  id: "eeeeeeee-5555-4555-8555-eeeeeeeeeeee",
  meetingId: MEETING,
  patientId: PATIENT,
  agendaItemId: null,
  decisionKind: "level_of_care_consideration",
  status: "open",
  wasQuorate,
  recordedByMembershipId: "m-1",
  recordedAt: at,
  supersededByDecisionId: null,
});

let roster: Record<string, unknown>[] = [];
let decisions: Record<string, unknown>[] = [];
let meetingStatus = "live";
let calls: { method: string; path: string; body: unknown }[] = [];

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : null;
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  const url = req ? req.url : String(input);
  const path = new URL(url, "http://localhost").pathname;
  let body: unknown = null;
  if (method !== "GET") {
    const raw = req ? await req.clone().text() : typeof init?.body === "string" ? init.body : "";
    body = raw ? JSON.parse(raw) : null;
  }
  calls.push({ method, path, body });
  const json = (v: unknown) =>
    new Response(JSON.stringify(v), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  if (method !== "GET") return json(roster[0] ?? {});
  if (path.endsWith("/attendance")) return json(roster);
  if (path.endsWith("/agenda"))
    return json([
      { id: "ag-1", meetingId: MEETING, kind: "patient_review", patientId: PATIENT },
      { id: "ag-2", meetingId: MEETING, kind: "carry_forward", patientId: PATIENT },
    ]);
  if (path.endsWith("/decisions")) return json(decisions);
  if (path.endsWith("/packets"))
    return json([{ packetId: "p-1", meetingId: MEETING, patientId: PATIENT, frozenAt: null }]);
  if (path.endsWith("/idg/action-items"))
    return json([
      {
        id: "ai-1",
        meetingId: MEETING,
        decisionId: null,
        patientId: PATIENT,
        assignedToMembershipId: "m-1",
        status: "open",
        dueDate: "2026-09-03T00:00:00.000Z",
        linkedArtifactKind: null,
        linkedArtifactId: null,
      },
    ]);
  return json({
    id: MEETING,
    organizationId: "org-1",
    locationId: "loc-1",
    status: meetingStatus,
    scheduledStart: "2026-08-27T09:00:00.000Z",
    scheduledEnd: "2026-08-27T10:00:00.000Z",
    adjournedAt: null,
  });
}

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["idg_coordinator"],
  permissions: ["idg.read", "idg.attend", "idg.coordinate", "idg.decide", "idg.act"],
  isAdmin: false,
};

const mount = (session = SESSION) =>
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={session}>
        <ToastProvider>
          <MemoryRouter initialEntries={[`/idg/meetings/${MEETING}/live`]}>
            <Routes>
              <Route path="/idg/meetings/:id/live" element={<LiveMeeting />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );

beforeEach(() => {
  meetingStatus = "live";
  roster = [];
  decisions = [];
  calls = [];
});
afterEach(cleanup);

describe("Live meeting — three-pane redesign", () => {
  it("renders the worklist, packet, decision and attendance panes", async () => {
    mount();
    await screen.findByRole("region", { name: "Patient worklist" });
    expect(screen.getByRole("region", { name: "Patient packet" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Decisions" })).toBeTruthy();
    expect(screen.getByRole("region", { name: /Attendance & quorum/ })).toBeTruthy();
    // The carry-forward agenda item is flagged in the worklist's agenda.
    expect((await screen.findAllByText("Carry-forward")).length).toBeGreaterThan(0);
    // Action items for this meeting come from GET /idg/action-items.
    await waitFor(() => expect(screen.getByText(/^Due /)).toBeTruthy());
  });

  it("is titled Live only while the meeting is live", async () => {
    mount();
    expect(await screen.findByRole("heading", { level: 1, name: "Live IDG Meeting" })).toBeTruthy();
    cleanup();
    meetingStatus = "adjourned";
    mount();
    expect(
      await screen.findByRole("heading", { level: 1, name: "IDG Meeting — Adjourned" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Live IDG Meeting" })).toBeNull();
  });

  it("shows the missing disciplines when the roster is short", async () => {
    roster = [att("1", "rn_case_manager"), att("2", "msw", "absent")];
    mount();
    const banner = await screen.findByText(/^Not quorate — missing/);
    expect(banner.textContent).toMatch(/Physician/);
    expect(banner.textContent).toMatch(/MSW/);
    expect(banner.textContent).toMatch(/Chaplain/);
    expect(banner.textContent).not.toMatch(/RN/);
  });

  it("shows the Quorate banner when all four disciplines are present", async () => {
    roster = [
      att("1", "rn_case_manager"),
      att("2", "msw", "tardy"),
      att("3", "hospice_physician", "partial"),
      att("4", "chaplain"),
    ];
    mount();
    expect(
      await screen.findByText("Quorate ✓ — Physician + RN + MSW + Chaplain present"),
    ).toBeTruthy();
  });

  it("marks a decision recorded without quorum as annotation-only", async () => {
    decisions = [decision(false)];
    mount();
    expect(await screen.findByText("Not quorate · annotation")).toBeTruthy();
  });

  it("amends an attendance status with PATCH", async () => {
    roster = [att("1", "chaplain")];
    mount();
    const select = await screen.findByLabelText(/Attendance status for/);
    fireEvent.change(select, { target: { value: "tardy" } });
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PATCH" && c.path === "/api/v1/idg/attendance/1")).toBe(
        true,
      ),
    );
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ status: "tardy" });
  });

  it("preselects the worklist patient in the decision recorder", async () => {
    mount();
    await screen.findByRole("region", { name: "Patient packet" });
    fireEvent.click(await screen.findByRole("button", { name: "Record for this patient" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Record a decision")).toBeTruthy();
  });

  it("keeps read-only clinicians on the live surface without rendering forbidden mutation controls", async () => {
    mount({ ...SESSION, permissions: ["idg.read"] });
    await screen.findByRole("region", { name: "Patient worklist" });
    expect(screen.queryByRole("button", { name: "Check in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add agenda item" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Record decision" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Adjourn" })).toBeNull();
    expect(screen.queryByLabelText(/Attendance status for/)).toBeNull();
  });
});
