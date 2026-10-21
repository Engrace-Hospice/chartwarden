// Live meeting — patient names, coordinator, Recert & F2F windows section, and live polling refresh.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { LiveMeeting } from "./live-meeting";

const MEETING = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const P1 = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const P2 = "cccccccc-3333-4333-8333-cccccccccccc";
const at = "2026-08-27T09:05:00.000Z";
const ref = { displayName: "Henry N.", mrnSuffix: "A7AC" };
const win = (over: Record<string, unknown>) => ({
  patientId: P1,
  patient: ref,
  admissionId: "adm-1",
  currentPeriodSequence: 2,
  benefitPeriodStart: "2026-07-01",
  benefitPeriodEnd: "2026-09-28",
  nextRecertDueDate: "2026-09-28",
  nextPeriodSequence: 3,
  daysUntilNextRecert: 14,
  f2fRequired: true,
  f2fWindowStart: "2026-08-01",
  f2fWindowEnd: "2026-09-28",
  f2fStatus: "window_open",
  f2fWindowState: "window_open",
  f2fScheduledDate: null,
  ...over,
});

let recertBody: (() => Response) | null = null;
let decisions: Record<string, unknown>[] = [];
let decisionGets = 0;

async function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const req = input instanceof Request ? input : null;
  const path = new URL(req ? req.url : String(input), "http://localhost").pathname;
  const json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  if (path.endsWith("/recert-windows")) {
    return recertBody ? recertBody() : json({ items: [] });
  }
  if (path.endsWith("/attendance")) return json([]);
  if (path.endsWith("/agenda"))
    return json([
      { id: "ag-1", meetingId: MEETING, kind: "patient_review", patientId: P1, patient: ref },
      { id: "ag-2", meetingId: MEETING, kind: "patient_review", patientId: P2, patient: null },
    ]);
  if (path.endsWith("/decisions")) {
    decisionGets += 1;
    return json(decisions);
  }
  if (path.endsWith("/packets"))
    return json([
      { packetId: "p-1", meetingId: MEETING, patientId: P1, patient: ref, frozenAt: null },
    ]);
  if (path.endsWith("/idg/action-items")) return json([]);
  if (path.includes("/care-team-staff"))
    return json({
      staff: [
        { membershipId: "coord-1", userId: "u-1", displayName: "Dana Coordinator", roleLabels: [] },
      ],
    });
  return json({
    id: MEETING,
    organizationId: "org-1",
    locationId: "loc-1",
    status: "live",
    scheduledStart: "2026-08-27T09:00:00.000Z",
    scheduledEnd: "2026-08-27T10:00:00.000Z",
    adjournedAt: null,
    coordinatorMembershipId: "coord-1",
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
const mount = () =>
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
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
  recertBody = null;
  decisions = [];
  decisionGets = 0;
});
afterEach(cleanup);

const recertSection = async () => screen.findByRole("region", { name: /Recert & F2F windows/ });

describe("Live meeting — names, coordinator, recert windows", () => {
  it("shows patient display names with MRN suffix, falling back to the short id", async () => {
    mount();
    const worklist = await screen.findByRole("region", { name: "Patient worklist" });
    await within(worklist).findByText("Henry N.");
    expect(within(worklist).getByText("MRN …A7AC")).toBeTruthy();
    expect(within(worklist).getByText("cccccccc")).toBeTruthy();
  });

  it("shows the coordinator name in the header", async () => {
    mount();
    expect(await screen.findByText(/Coordinator Dana Coordinator/)).toBeTruthy();
  });

  it("renders the F2F status variants and highlights the selected patient", async () => {
    const rows = [
      win({}),
      win({
        patientId: P2,
        patient: null,
        f2fStatus: "missed",
        f2fWindowState: "overdue",
        daysUntilNextRecert: -3,
      }),
      win({
        patientId: "d1",
        patient: { displayName: "Ann B.", mrnSuffix: null },
        f2fStatus: "attested",
        f2fWindowState: null,
      }),
      win({
        patientId: "d2",
        patient: { displayName: "Cy D.", mrnSuffix: null },
        f2fStatus: "unknown",
        f2fWindowState: null,
        nextRecertDueDate: null,
        daysUntilNextRecert: null,
      }),
      win({
        patientId: "d3",
        patient: { displayName: "Eve F.", mrnSuffix: null },
        f2fStatus: "not_required",
        f2fWindowState: null,
      }),
    ];
    recertBody = () =>
      new Response(JSON.stringify({ meetingId: MEETING, generatedAt: at, items: rows }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    mount();
    const sec = await recertSection();
    await within(sec).findByText("Window open");
    expect(within(sec).getByText("Missed")).toBeTruthy();
    expect(within(sec).getByText("Attested")).toBeTruthy();
    expect(within(sec).getByText("Not available")).toBeTruthy();
    expect(within(sec).getByText("Not required")).toBeTruthy();
    expect(within(sec).getByText(/3 days overdue/)).toBeTruthy();
    expect(within(sec).getAllByText(/in 14 days/).length).toBeGreaterThan(0);
    expect(within(sec).getByText("Recert date not available")).toBeTruthy();
    // The first agenda patient is selected by default → its row is highlighted.
    const current = sec.querySelectorAll('[aria-current="true"]');
    expect(current.length).toBe(1);
    expect(current[0]?.textContent).toMatch(/Henry N\./);
  });

  it("shows a quiet unavailable line when the route errors", async () => {
    recertBody = () =>
      new Response(JSON.stringify({ error: { code: "INTERNAL", message: "x" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    mount();
    const sec = await recertSection();
    await within(sec).findByText(/unavailable right now/);
    expect(screen.getByRole("region", { name: "Patient worklist" })).toBeTruthy();
  });
});

describe("Live meeting — live refresh", () => {
  it("shows the live indicator and re-reads the ledgers on focus", async () => {
    mount();
    expect(await screen.findByText(/^Live · /)).toBeTruthy();
    await screen.findByText("No decisions recorded.");
    const before = decisionGets;
    decisions = [
      {
        id: "dd-1",
        meetingId: MEETING,
        patientId: P1,
        patient: ref,
        agendaItemId: null,
        decisionKind: "referral",
        status: "open",
        wasQuorate: true,
        recordedByMembershipId: "m-1",
        recordedAt: at,
        supersededByDecisionId: null,
      },
    ];
    act(() => void window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(decisionGets).toBeGreaterThan(before));
    expect(await screen.findByText("Referral")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Record for this patient" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
});
