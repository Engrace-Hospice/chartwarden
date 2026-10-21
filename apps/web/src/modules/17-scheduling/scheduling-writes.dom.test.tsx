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
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
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
const OTHER_MEMBER = "88888888-7777-4777-8777-888888888888";

let admissions: Record<string, unknown>[] = [
  { id: ADMISSION, state: "active", admissionAt: "2026-08-01T00:00:00.000Z", dischargedAt: null },
];
let visitStatus = "published";
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
  serviceDate: "2026-08-28",
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
    if (path === "/api/v1/scheduling/eligible-clinicians")
      return [
        {
          membershipId: MEMBER,
          displayName: "R. Okonkwo",
          disciplines: ["rn"],
          eligible: true,
          reasonCodes: [],
        },
        {
          membershipId: OTHER_MEMBER,
          displayName: "S. Patel",
          disciplines: ["rn"],
          eligible: true,
          reasonCodes: [],
        },
        {
          // The server's D8 projection says no — the picker must not offer this clinician.
          membershipId: "ineligible-1",
          displayName: "Former Staff",
          disciplines: ["chha"],
          eligible: false,
          reasonCodes: ["CLINICIAN_DISCIPLINE_NOT_ALLOWED"],
        },
      ];
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
    if (path === "/api/v1/encounters") return { encounters: [] };
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

// The New Visit button and each per-visit ceremony render only for the permission that names them
// (`NewVisitButton` / `VisitActionPanel`) — navigation affordance, not authorization; the server decides.
const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["scheduler"],
  permissions: [
    "visit.read_team",
    "visit.create",
    "visit.reassign",
    "visit.reschedule",
    "visit.cancel",
    "visit.mark_no_show",
  ],
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
const mountVisit = () =>
  mount(`/scheduling/visits/${VISIT}`, <VisitDetail />, "/scheduling/visits/:visitId");
const mountProposals = () =>
  mount("/scheduling/proposals", <SchedulingProposals />, "/scheduling/proposals");
const mountTimeOff = () =>
  mount("/scheduling/time-off", <SchedulingTimeOff />, "/scheduling/time-off");

const writes = () => calls.filter((c) => !c.startsWith("GET "));

beforeEach(() => {
  calls = [];
  bodies = [];
  writeFailure = null;
  visitStatus = "published";
  proposalStatus = "pending";
  timeOffState = "requested";
  admissions = [
    { id: ADMISSION, state: "active", admissionAt: "2026-08-01T00:00:00.000Z", dischargedAt: null },
  ];
});
afterEach(() => {
  writeFailure = null;
});

// The create flow is main's `NewVisitModal` (scheduling-workflow.tsx), opened from its retained action.
// Patient and admission are typeahead comboboxes; the admission lookup is PATIENT-scoped (F-066 /
// #161) and filtered to active admissions client-side. The assignee is a <select> fed by the server's
// advisory D8 projection (GET /scheduling/eligible-clinicians), offered once a patient and a valid
// window are chosen; POST /visits still runs every gate.
async function openNewVisit(): Promise<HTMLElement> {
  mountDay();
  fireEvent.click(await screen.findByRole("button", { name: "New Visit" }));
  return screen.findByRole("dialog", { name: "New Visit" });
}

async function choose(dialog: HTMLElement, field: RegExp, option: string | RegExp): Promise<void> {
  fireEvent.focus(within(dialog).getByRole("combobox", { name: field }));
  fireEvent.click(await within(dialog).findByText(option));
}

// `^patient` alone would also match the "Patient address" <select> (implicit role combobox).
const PATIENT_FIELD = /^patient(?! address)/i;

async function chooseClinician(dialog: HTMLElement, label: RegExp, membershipId: string) {
  const select = within(dialog).getByLabelText(label) as HTMLSelectElement;
  await waitFor(() =>
    expect([...select.options].some((option) => option.value === membershipId)).toBe(true),
  );
  fireEvent.change(select, { target: { value: membershipId } });
}

async function choosePatient(dialog: HTMLElement): Promise<void> {
  await choose(dialog, PATIENT_FIELD, "Vance, Ada");
  await waitFor(() =>
    expect(
      (within(dialog).getByRole("combobox", { name: /active admission/i }) as HTMLInputElement)
        .disabled,
    ).toBe(false),
  );
}

async function fillValidVisit(dialog: HTMLElement): Promise<void> {
  await choosePatient(dialog);
  await choose(dialog, /active admission/i, "Admitted 2026-08-01");
  fireEvent.change(within(dialog).getByLabelText(/scheduled start/i), {
    target: { value: "2026-08-28T09:00" },
  });
  fireEvent.change(within(dialog).getByLabelText(/scheduled end/i), {
    target: { value: "2026-08-28T10:00" },
  });
  await chooseClinician(dialog, /assigned clinician/i, MEMBER);
}

describe("shared Scheduling navigation", () => {
  it("does not render the retired page-level Scheduling navigation", () => {
    mountDay();
    expect(screen.queryByRole("navigation", { name: "Scheduling sections" })).toBeNull();
  });
});

describe("#91 — a visit can be scheduled", () => {
  it("choosing a patient scopes the admission lookup to that patient's ACTIVE admissions", async () => {
    admissions = [
      {
        id: ADMISSION,
        state: "active",
        admissionAt: "2026-08-01T00:00:00.000Z",
        dischargedAt: null,
      },
      {
        id: "discharged-1",
        state: "discharged",
        admissionAt: "2025-01-01T00:00:00.000Z",
        dischargedAt: "2025-03-01T00:00:00.000Z",
      },
    ];
    const dialog = await openNewVisit();
    await choosePatient(dialog);
    fireEvent.focus(within(dialog).getByRole("combobox", { name: /active admission/i }));
    expect(await within(dialog).findByText("Admitted 2026-08-01")).toBeTruthy();
    // F-065 — until that read existed nothing could resolve a patient's admission (#161).
    expect(calls).toContain(`GET /api/v1/patients/${PATIENT}/admissions`);
    expect(within(dialog).queryByText("Admitted 2025-01-01")).toBeNull();
  });

  it("a patient with no open admission is told why, offered a path, and the create is refused", async () => {
    admissions = [];
    const dialog = await openNewVisit();
    await choosePatient(dialog);
    fireEvent.focus(within(dialog).getByRole("combobox", { name: /active admission/i }));
    expect(await within(dialog).findByText(/no active admissions found/i)).toBeTruthy();
    expect(
      within(dialog)
        .getByRole("link", { name: /direct admission/i })
        .getAttribute("href"),
    ).toBe(`/admissions/new?patientId=${PATIENT}`);
    // The admission is a required field, so the browser's own constraint validation refuses the
    // submit before `submit()` (and its "Select a patient, active admission, and clinician." guard)
    // is even reached.
    const admission = within(dialog).getByRole("combobox", {
      name: /active admission/i,
    }) as HTMLInputElement;
    expect(admission.validity.valueMissing).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: /create visit/i }));
    await new Promise((r) => setTimeout(r, 50));
    expect(writes()).toEqual([]);
  });

  it("the create carries the purpose, setting, assignee and the address", async () => {
    const dialog = await openNewVisit();
    await fillValidVisit(dialog);
    fireEvent.change(within(dialog).getByLabelText(/patient address/i), {
      target: { value: ADDRESS },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /create visit/i }));
    await waitFor(() => expect(writes()).toContain("POST /api/v1/visits"));
    expect(bodies[0]?.patientId).toBe(PATIENT);
    expect(bodies[0]?.admissionId).toBe(ADMISSION);
    expect(bodies[0]?.assignedMembershipId).toBe(MEMBER);
    expect(bodies[0]?.patientAddressId).toBe(ADDRESS);
    expect(bodies[0]?.visitPurpose).toBe("routine_visit");
    expect(bodies[0]?.visitSetting).toBe("patient_home");
    expect(typeof bodies[0]?.scheduledStartedAt).toBe("string");
  });

  it("the assignee picker offers the server's ELIGIBLE clinicians and nothing else", async () => {
    // The eligibility comes from the server's own D8 projection — the browser does not re-derive the
    // discipline/licence rule, it only hides what the server already said no to.
    const dialog = await openNewVisit();
    await choosePatient(dialog);
    fireEvent.change(within(dialog).getByLabelText(/scheduled start/i), {
      target: { value: "2026-08-28T09:00" },
    });
    fireEvent.change(within(dialog).getByLabelText(/scheduled end/i), {
      target: { value: "2026-08-28T10:00" },
    });
    expect(await within(dialog).findByText(/R\. Okonkwo/)).toBeTruthy();
    expect(calls).toContain("GET /api/v1/scheduling/eligible-clinicians");
    expect(within(dialog).queryByText(/Former Staff/)).toBeNull();
  });

  it("a D8 pre-schedule refusal names the discipline or licence, not a generic error", async () => {
    // The real create-path refusal: the visit machine's publish guard (packages/scheduling).
    writeFailure = {
      status: 422,
      body: {
        error: {
          code: "VISIT_PRE_SCHEDULE_GATE_UNMET",
          message: "the pre-schedule gate (D8) must pass before a proposed visit can be published",
        },
      },
    };
    const dialog = await openNewVisit();
    await fillValidVisit(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: /create visit/i }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(
      /discipline, active licence/i,
    );
  });
});

describe("#91 — the per-visit ceremonies", () => {
  // Main's `VisitActionPanel`: a button per ceremony the visit's state allows, each opening one
  // "Visit action" dialog whose commit is "Confirm".
  async function openAction(name: string): Promise<HTMLElement> {
    mountVisit();
    fireEvent.click(await screen.findByRole("button", { name }));
    return screen.findByRole("dialog", { name: "Visit action" });
  }

  it("Reschedule sends the new window AND a reason — the route requires one", async () => {
    const dialog = await openAction("Reschedule");
    fireEvent.change(within(dialog).getByLabelText("New start"), {
      target: { value: "2026-08-29T09:00" },
    });
    fireEvent.change(within(dialog).getByLabelText("New end"), {
      target: { value: "2026-08-29T10:00" },
    });
    fireEvent.change(within(dialog).getByLabelText(/reason for rescheduling/i), {
      target: { value: "Patient has a hospital appointment." },
    });
    // The current assignee is kept once the server's D8 projection says they are still eligible.
    await waitFor(() =>
      expect((within(dialog).getByLabelText(/^clinician/i) as HTMLSelectElement).value).toBe(
        MEMBER,
      ),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/visits/${VISIT}/reschedule`));
    expect(bodies[0]?.reason).toBe("Patient has a hospital appointment.");
    expect(typeof bodies[0]?.newScheduledStartedAt).toBe("string");
    expect(typeof bodies[0]?.newScheduledEndedAt).toBe("string");
  });

  it("Cancel sends a coded reason — the §5.1 metrics count the code, not the prose", async () => {
    const dialog = await openAction("Cancel");
    fireEvent.change(within(dialog).getByLabelText(/reason for cancellation/i), {
      target: { value: "Patient asked to skip this week." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/visits/${VISIT}/cancel`));
    expect(bodies[0]?.reasonCode).toBe("patient_request");
    expect(bodies[0]?.reason).toBe("Patient asked to skip this week.");
  });

  it("no-show is a DIFFERENT route from cancel — the metrics count them separately", async () => {
    const dialog = await openAction("No-show");
    fireEvent.change(within(dialog).getByLabelText("Reason"), {
      target: { value: "Nobody answered; waited fifteen minutes." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/visits/${VISIT}/no-show`));
    expect(writes().some((c) => c.endsWith("/cancel"))).toBe(false);
  });

  it("a D8 refusal on reassign is explained, not shown as the bare server constant", async () => {
    // Reassign/reschedule re-run the gate and refuse as a 403 whose message is a constant.
    writeFailure = {
      status: 403,
      body: { error: { code: "FORBIDDEN", message: "PRE_SCHEDULE_GATE_FAILED" } },
    };
    const dialog = await openAction("Reassign");
    // The visit's current assignee (R. Okonkwo) is not offered as its own reassignment target.
    await chooseClinician(dialog, /new clinician/i, OTHER_MEMBER);
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/visits/${VISIT}/reassign`));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toMatch(/discipline, active licence/i);
    expect(alert.textContent).not.toContain("PRE_SCHEDULE_GATE_FAILED");
  });

  it("a completed visit offers no ceremonies at all", async () => {
    visitStatus = "completed";
    mountVisit();
    await waitFor(() => expect(calls).toContain(`GET /api/v1/visits/${VISIT}`));
    await screen.findByText("Visit actions");
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
