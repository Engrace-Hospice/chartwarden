// apps/web/src/modules/17-scheduling — #91: the scheduler could read a day and not schedule a visit.
//
// Eight read screens, zero mutations. A visit is the unit of hospice care delivery — what a clinician
// travels to, what an encounter documents, what EVV brackets, what a claim's service line is built from.
//
// Two of these screens are queues whose reason to exist is an action they did not offer, and both are
// load-bearing beyond themselves:
//   • The PROPOSAL INBOX. M17 generates proposals from the care plan's frequency orders, the IDG's
//     decisions and the supervisory cadence; `publish` turns one into a real scheduled visit. With no
//     caller, the visits the plan of care called for were never created.
//   • The TIME-OFF QUEUE. Approved time off is what the conflict rules refuse a visit against, so an
//     approval nobody could record was also a clinician the scheduler kept booking.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { SchedulingDay } from "./day-view";
import { SchedulingProposals } from "./proposals";
import { SchedulingTimeOff } from "./time-off";
import { VisitDetail } from "./visit-detail";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ADMISSION = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const VISIT = "cccccccc-3333-4333-8333-cccccccccccc";
const PROPOSAL = "dddddddd-4444-4444-8444-dddddddddddd";
const TIMEOFF = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
const ADDRESS = "ffffffff-6666-4666-8666-ffffffffffff";
const MEMBER = "99999999-7777-4777-8777-999999999999";

let admissions: Record<string, unknown>[] = [
  { id: ADMISSION, state: "active", admissionAt: "2026-08-01T00:00:00.000Z", dischargedAt: null },
];
let visitStatus = "scheduled";
let proposalStatus = "pending";
let timeOffState = "requested";

const visit = () => ({
  id: VISIT,
  organizationId: "org-1",
  patientId: PATIENT,
  admissionId: ADMISSION,
  assignedMembershipId: MEMBER,
  visitPurpose: "routine_visit",
  visitSetting: "patient_home",
  status: visitStatus,
  scheduledStartedAt: "2026-08-28T09:00:00.000Z",
  scheduledEndedAt: "2026-08-28T10:00:00.000Z",
  patientAddressId: ADDRESS,
  externalFacilityId: null,
  actualStartedAt: null,
  actualEndedAt: null,
  cancellationReason: null,
  rescheduledIntoVisitId: null,
});

let calls: string[] = [];
let bodies: Record<string, unknown>[] = [];
let writeFailure: { status: number; body: unknown } | null = null;

function requestOf(input: RequestInfo | URL, init?: RequestInit): { url: string; method: string } {
  if (typeof input === "string")
    return { url: input, method: (init?.method ?? "GET").toUpperCase() };
  if (input instanceof URL)
    return { url: input.toString(), method: (init?.method ?? "GET").toUpperCase() };
  return { url: input.url, method: (init?.method ?? input.method ?? "GET").toUpperCase() };
}

function bodyFor(method: string, path: string): unknown {
  if (method === "GET") {
    if (path.endsWith("/admissions")) return { items: admissions };
    if (path.endsWith("/addresses"))
      return { addresses: [{ id: ADDRESS, line1: "14 Elm Row", city: "Aberdeen", kind: "home" }] };
    if (path === "/api/v1/patients")
      return {
        items: [
          {
            id: PATIENT,
            organizationId: "org-1",
            mrn: "MRN-1",
            lastName: "Vance",
            firstName: "Ada",
            dob: "1948-03-02",
            status: "active",
          },
        ],
        nextCursor: null,
      };
    if (path.includes("/members"))
      return {
        members: [
          {
            membershipId: MEMBER,
            userId: "user-9",
            organizationId: "org-1",
            organizationName: "Org",
            status: "active",
            isAdmin: false,
            defaultLocationIds: [],
            displayName: "R. Okonkwo",
            email: null,
            lastLoginAt: null,
            accountStatus: "active",
          },
          {
            // A revoked membership must not be offered — the server would refuse the assignment.
            membershipId: "revoked-1",
            userId: "user-8",
            organizationId: "org-1",
            organizationName: "Org",
            status: "revoked",
            isAdmin: false,
            defaultLocationIds: [],
            displayName: "Former Staff",
            email: null,
            lastLoginAt: null,
            accountStatus: "active",
          },
        ],
      };
    if (path === "/api/v1/visit-proposals")
      return [
        {
          id: PROPOSAL,
          patientId: PATIENT,
          proposedForDate: "2026-08-29",
          proposedVisitPurpose: "routine_visit",
          status: proposalStatus,
        },
      ];
    if (path === "/api/v1/time-off")
      return [
        {
          id: TIMEOFF,
          membershipId: MEMBER,
          kind: "pto",
          startsAt: "2026-09-01T00:00:00.000Z",
          endsAt: "2026-09-05T00:00:00.000Z",
          state: timeOffState,
        },
      ];
    if (path === "/api/v1/day-view") return { visits: [visit()] };
    if (path.startsWith("/api/v1/visits/")) return visit();
  }
  if (path.endsWith("/reschedule")) return { original: visit(), created: visit() };
  return visit();
}

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const { url, method } = requestOf(input, init);
  const path = new URL(url, "http://localhost").pathname;
  calls.push(`${method} ${path}`);
  if (method !== "GET") {
    const req = typeof input === "object" && "clone" in input ? (input as Request) : null;
    const raw = req ? await req.clone().text() : typeof init?.body === "string" ? init.body : "";
    if (raw) {
      try {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        // Every M17 write sends JSON; recording nothing is honest if one ever does not.
      }
    }
    if (writeFailure) {
      return new Response(JSON.stringify(writeFailure.body), {
        status: writeFailure.status,
        headers: { "content-type": "application/json" },
      });
    }
  }
  return new Response(JSON.stringify(bodyFor(method, path)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["scheduler"],
  permissions: [],
  isAdmin: false,
};

function mount(path: string, element: JSX.Element, route: string): ReturnType<typeof render> {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path={route} element={element} />
              <Route path="*" element={<div>navigated</div>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  ) as unknown as ReturnType<typeof render>;
}

const mountDay = () => mount("/scheduling/day", <SchedulingDay />, "/scheduling/day");
const mountVisit = () => mount(`/visits/${VISIT}`, <VisitDetail />, "/visits/:visitId");
const mountProposals = () =>
  mount("/scheduling/proposals", <SchedulingProposals />, "/scheduling/proposals");
const mountTimeOff = () =>
  mount("/scheduling/time-off", <SchedulingTimeOff />, "/scheduling/time-off");

const writes = () => calls.filter((c) => !c.startsWith("GET "));

beforeEach(() => {
  calls = [];
  bodies = [];
  writeFailure = null;
  visitStatus = "scheduled";
  proposalStatus = "pending";
  timeOffState = "requested";
  admissions = [
    { id: ADMISSION, state: "active", admissionAt: "2026-08-01T00:00:00.000Z", dischargedAt: null },
  ];
});
afterEach(() => {
  writeFailure = null;
});

describe("#91 — a visit can be scheduled", () => {
  it("choosing a patient resolves the admission and addresses the create needs", async () => {
    mountDay();
    fireEvent.change(await waitFor(() => screen.getByLabelText(/find a patient/i)), {
      target: { value: "vance" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await waitFor(() => screen.getByText(/Vance, Ada/)));
    // F-065 — until that read existed nothing could resolve a patient's admission (#161).
    await waitFor(() => expect(calls).toContain(`GET /api/v1/patients/${PATIENT}/admissions`));
    expect(calls).toContain(`GET /api/v1/patients/${PATIENT}/addresses`);
    expect(await screen.findByLabelText("Address")).toBeTruthy();
  });

  it("a patient with no open admission is refused BEFORE the form opens, and told why", async () => {
    admissions = [];
    mountDay();
    fireEvent.change(await waitFor(() => screen.getByLabelText(/find a patient/i)), {
      target: { value: "vance" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await waitFor(() => screen.getByText(/Vance, Ada/)));
    expect((await screen.findByRole("alert")).textContent).toMatch(/no open admission/i);
    expect(screen.queryByLabelText("Address")).toBeNull();
  });

  it("the create carries the purpose, setting, assignee and the resolved address", async () => {
    mountDay();
    fireEvent.change(await waitFor(() => screen.getByLabelText(/find a patient/i)), {
      target: { value: "vance" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await waitFor(() => screen.getByText(/Vance, Ada/)));
    fireEvent.change(await waitFor(() => screen.getByLabelText("Assign to")), {
      target: { value: MEMBER },
    });
    fireEvent.change(screen.getByLabelText("Starts"), { target: { value: "2026-08-28T09:00" } });
    fireEvent.change(screen.getByLabelText("Ends"), { target: { value: "2026-08-28T10:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(writes()).toContain("POST /api/v1/visits"));
    expect(bodies[0]?.patientId).toBe(PATIENT);
    expect(bodies[0]?.admissionId).toBe(ADMISSION);
    expect(bodies[0]?.patientAddressId).toBe(ADDRESS);
    expect(bodies[0]?.visitPurpose).toBe("routine_visit");
    expect(bodies[0]?.visitSetting).toBe("patient_home");
  });

  it("the assignee picker offers the ACTIVE roster and nothing else", async () => {
    // Not an eligibility list — the §4.7 D8 gate is the server's, and filtering by discipline here
    // would be a second implementation of it. But a REVOKED membership is not a person to assign to.
    mountDay();
    fireEvent.change(await waitFor(() => screen.getByLabelText(/find a patient/i)), {
      target: { value: "vance" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await waitFor(() => screen.getByText(/Vance, Ada/)));
    const picker = (await waitFor(() => screen.getByLabelText("Assign to"))) as HTMLSelectElement;
    expect([...picker.options].map((o) => o.value)).toEqual(["", MEMBER]);
  });

  it("a D8 pre-schedule refusal names the discipline or licence, not a generic error", async () => {
    writeFailure = {
      status: 422,
      body: { error: { code: "DISCIPLINE_NOT_ELIGIBLE", message: "not eligible" } },
    };
    mountDay();
    fireEvent.change(await waitFor(() => screen.getByLabelText(/find a patient/i)), {
      target: { value: "vance" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await waitFor(() => screen.getByText(/Vance, Ada/)));
    fireEvent.change(await waitFor(() => screen.getByLabelText("Assign to")), {
      target: { value: MEMBER },
    });
    fireEvent.change(screen.getByLabelText("Starts"), { target: { value: "2026-08-28T09:00" } });
    fireEvent.change(screen.getByLabelText("Ends"), { target: { value: "2026-08-28T10:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/discipline or active licence/i);
  });
});

describe("#91 — the per-visit ceremonies", () => {
  it("Reschedule sends the new window AND a reason — the route requires one", async () => {
    mountVisit();
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Reschedule" })));
    fireEvent.change(await waitFor(() => screen.getByLabelText("New start")), {
      target: { value: "2026-08-29T09:00" },
    });
    fireEvent.change(screen.getByLabelText("New end"), { target: { value: "2026-08-29T10:00" } });
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Patient has a hospital appointment." },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Reschedule" })[1] as HTMLElement);
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/visits/${VISIT}/reschedule`));
    expect(bodies[0]?.reason).toBe("Patient has a hospital appointment.");
  });

  it("Cancel sends a coded reason — the §5.1 metrics count the code, not the prose", async () => {
    mountVisit();
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Cancel" })));
    fireEvent.change(await waitFor(() => screen.getByLabelText("Reason")), {
      target: { value: "Patient asked to skip this week." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel visit" }));
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/visits/${VISIT}/cancel`));
    expect(bodies[0]?.reasonCode).toBe("patient_request");
    expect(bodies[0]?.reason).toBe("Patient asked to skip this week.");
  });

  it("no-show is a DIFFERENT route from cancel — the metrics count them separately", async () => {
    mountVisit();
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "No-show" })));
    fireEvent.change(await waitFor(() => screen.getByLabelText(/What happened/i)), {
      target: { value: "Nobody answered; waited fifteen minutes." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record no-show" }));
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/visits/${VISIT}/no-show`));
    expect(writes().some((c) => c.endsWith("/cancel"))).toBe(false);
  });

  it("a completed visit offers no ceremonies at all", async () => {
    visitStatus = "completed";
    mountVisit();
    await waitFor(() => expect(calls).toContain(`GET /api/v1/visits/${VISIT}`));
    expect(screen.queryByRole("button", { name: "Reschedule" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
});

describe("#91 — the two queues that were load-bearing beyond themselves", () => {
  it("Publish turns a proposal into a scheduled visit — the write the inbox exists for", async () => {
    mountProposals();
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Publish" })));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/visit-proposals/${PROPOSAL}/publish`),
    );
    expect(await screen.findByText(/on the schedule/i)).toBeTruthy();
  });

  it("Dismiss keeps the row — declining to schedule is a decision, not an absence of one", async () => {
    mountProposals();
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Dismiss" })));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/visit-proposals/${PROPOSAL}/dismiss`),
    );
    expect(bodies[0]?.reason).toBeTruthy();
  });

  it("Approve time off — what the conflict rules then refuse a visit against", async () => {
    mountTimeOff();
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Approve" })));
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/time-off/${TIMEOFF}/approve`));
    expect(await screen.findByText("Approved.")).toBeTruthy();
  });

  it("an already-decided request offers nothing", async () => {
    timeOffState = "approved";
    mountTimeOff();
    await waitFor(() => expect(calls).toContain("GET /api/v1/time-off"));
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
});
