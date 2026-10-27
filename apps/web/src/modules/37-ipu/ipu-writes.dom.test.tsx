import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// apps/web/src/modules/37-ipu — #91: four M37 read screens, zero mutations, 48 write routes.
//
// An inpatient unit is the one place in a hospice where care is delivered around the clock by staff who
// change every shift, and nothing that happens there could be recorded from this platform:
//   • the ADMISSION never moved. `request-bed → assign-bed → confirm → discharge` and the transfer pair
//     ARE the §2.2 lifecycle; the worklist rendered a state column and no control could change it.
//   • the RESTRAINT was never reassessed or released. A behavioral restraint carries a 15-minute
//     reassessment floor (CoP 418.110) and the watchdog raises `reassessment_due` on a schedule that
//     nothing could answer.
//   • the GIP CRITERION was never attested — and `confirm` refuses a GIP admission without one, so no
//     GIP stay could legally reach `active` at all.
//   • the RESPITE CAP override could not be invoked; the VISITOR could not be checked in or out; the
//     visitor RESTRICTION could not be applied or lifted.
//
// Asserted on the recorded `fetch` calls — method, path, body — never on a spy over the api client, so a
// test cannot pass against a client that was never wired to a screen.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { IpuAdmissions } from "./ipu-admissions";
import { IpuBedside } from "./ipu-bedside";

const ADMISSION = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PATIENT = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const RESTRAINT = "cccccccc-3333-4333-8333-cccccccccccc";
const VISITOR = "dddddddd-4444-4444-8444-dddddddddddd";
const RESTRICTION = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
const UNIT = "ffffffff-6666-4666-8666-ffffffffffff";
const ROOM = "11111111-7777-4777-8777-111111111111";
const BED = "22222222-8888-4888-8888-222222222222";
const ORDER = "33333333-9999-4999-8999-333333333333";
const PHYSICIAN = "44444444-aaaa-4aaa-8aaa-444444444444";
const IRC_EPISODE = "55555555-bbbb-4bbb-8bbb-555555555555";

let admissionState = "active";
let admissionKind = "gip";
let restraintState = "active";
let visitorCheckedOut: string | null = null;
let restraintNextDueAt: string | null = null;

const admission = () => ({
  id: ADMISSION,
  patientId: PATIENT,
  kind: admissionKind,
  state: admissionState,
  unitId: UNIT,
  remoteFacilityId: null,
  openedAt: "2026-08-20T08:00:00.000Z",
  version: 3,
});
const restraint = () => ({
  id: RESTRAINT,
  ipuAdmissionId: ADMISSION,
  restraintKind: "soft_limb",
  category: "behavioral" as const,
  state: restraintState,
  // Deliberately NOT 15 (the behavioral floor): a tenant may tighten below it, and a cadence equal to
  // the default would let a hardcoded 15 pass the reassessment test below without reading the row.
  reassessmentIntervalMinutes: 10,
  appliedAt: "2026-08-27T09:00:00.000Z",
  appliedByMembershipId: "membership-1",
  orderingOrderId: ORDER,
  orderingPhysicianId: PHYSICIAN,
  releasedAt: null,
  nextDueAt: restraintNextDueAt,
  reassessmentCount: 2,
  version: 4,
});
const gipCriterion = () => ({
  id: "gip-1",
  ipuAdmissionId: ADMISSION,
  criterionKind: "acute_symptom_management",
  attestedAt: "2026-08-20T09:00:00.000Z",
  attestingPhysicianId: PHYSICIAN,
  reassessments: [
    { id: "re-1", reassessedAt: "2026-08-21T09:00:00.000Z", criterionStillMet: true },
  ],
  version: 2,
});
const ircEpisode = () => ({
  id: IRC_EPISODE,
  ipuAdmissionId: ADMISSION,
  state: "active",
  consecutiveDayCount: 4,
  capOverrideInvoked: false,
  version: 1,
});
const visitor = () => ({
  id: VISITOR,
  ipuAdmissionId: ADMISSION,
  relationship: "spouse",
  maskRequired: false,
  checkedInAt: "2026-08-27T10:00:00.000Z",
  checkedOutAt: visitorCheckedOut,
});
const restriction = () => ({
  id: RESTRICTION,
  scope: "patient",
  unitId: null,
  patientId: PATIENT,
  restrictionKind: "mask_required",
  rationale: "Respiratory outbreak on the unit.",
  sourceKind: "outbreak_surveillance",
  appliedAt: "2026-08-26T12:00:00.000Z",
  appliedBy: "membership-1",
  appliedUntil: null,
  liftedAt: null,
  version: 1,
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
    if (path === "/api/v1/ipu-admissions") return { items: [admission()] };
    if (path === `/api/v1/ipu-admissions/${ADMISSION}`) return admission();
    if (path.endsWith("/restraints")) return { items: [restraint()] };
    if (path.endsWith("/gip-criteria")) return { items: [gipCriterion()] };
    if (path.endsWith("/irc-episodes")) return { items: [ircEpisode()] };
    if (path === "/api/v1/ipu-visitors") return { items: [visitor()] };
    if (path === "/api/v1/ipu-visitor-restrictions") return { items: [restriction()] };
    if (path === "/api/v1/inpatient-units")
      return { items: [{ id: UNIT, displayName: "IPU One", isActive: true }] };
    if (path.endsWith("/rooms")) return { items: [{ id: ROOM }] };
    if (path.endsWith("/beds"))
      return { items: [{ id: BED, bedLabel: "101-A", roomId: ROOM, cleaningStatus: "ready" }] };
    if (path === "/api/v1/orders")
      return {
        orders: [
          { id: ORDER, kind: "dme", status: "active", signedAt: "2026-08-26T09:00:00.000Z" },
          // An UNSIGNED order the picker must not offer: #169 made the server resolve the order and
          // refuse an unsigned one, and this proves the form does not hand it to the server anyway.
          { id: "unsigned-order", kind: "lab", status: "draft", signedAt: null },
        ],
      };
    if (path === "/api/v1/mdm/physician/search")
      return {
        results: [
          {
            id: PHYSICIAN,
            canonical: { displayName: "Dr Amara Osei", identifierValue: "1234567890" },
          },
        ],
      };
  }
  if (path.includes("/ipu-admissions/")) return admission();
  if (path.includes("/ipu-restraint/")) return restraint();
  if (path.includes("/ipu-visitors")) return visitor();
  if (path.includes("/ipu-visitor-restrictions")) return restriction();
  return {};
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
        // Every M37 write sends JSON; recording nothing is honest if one ever does not.
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
  roles: ["clinical_supervisor"],
  permissions: [],
  isAdmin: false,
};

function mountWorklist(): ReturnType<typeof render> {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/ipu/admissions"]}>
            <Routes>
              <Route path="/ipu/admissions" element={<IpuAdmissions />} />
              <Route path="/ipu/admissions/:id" element={<div>bedside route</div>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  ) as unknown as ReturnType<typeof render>;
}

function mountBedside(): ReturnType<typeof render> {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter initialEntries={[`/ipu/admissions/${ADMISSION}`]}>
            <Routes>
              <Route path="/ipu/admissions/:id" element={<IpuBedside />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  ) as unknown as ReturnType<typeof render>;
}

const writes = () => calls.filter((c) => !c.startsWith("GET "));
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

beforeEach(() => {
  calls = [];
  bodies = [];
  writeFailure = null;
  admissionState = "active";
  admissionKind = "gip";
  restraintState = "active";
  visitorCheckedOut = null;
  restraintNextDueAt = null;
});

// ── the admissions worklist ────────────────────────────────────────────────────────────────────────────

describe("#91 — the admissions worklist can move an admission", () => {
  it("discharges WITHOUT asserting the M6 discharge event (#172 removed that field)", async () => {
    mountWorklist();
    fireEvent.click(await screen.findByRole("button", { name: "Discharge" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm discharge" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/ipu-admissions/${ADMISSION}/discharge`),
    );
    // The body carries ONLY the reason. `dischargeEventExists` was a required boolean until #172, and
    // this form has nothing true to say about another module's table.
    expect(bodies[0]).toEqual({ reason: "to_home" });
    expect(bodies[0]).not.toHaveProperty("dischargeEventExists");
  });

  it("offers request-bed on a pending admission and nothing else that moves it", async () => {
    admissionState = "pending";
    mountWorklist();
    expect(await screen.findByRole("button", { name: "Request bed" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Discharge" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  });

  it("a state this build has never heard of keeps ALL its actions rather than losing them", async () => {
    admissionState = "some_future_state";
    mountWorklist();
    // The affordance sets narrow the machine's graph; they do not copy it. Guessing "no" here would
    // hide a real transition behind a stale frontend.
    expect(await screen.findByRole("button", { name: "Request bed" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Discharge" })).toBeTruthy();
    // The system-internal confirm is never offered, even to a state this build cannot classify, and an
    // unknown state does not claim the M6-ack status either (that is a fact about a KNOWN state).
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(screen.queryByText("Awaiting M6 LCP acknowledgement")).toBeNull();
  });

  it("a bed-assigned admission shows a read-only M6-ack status and NO Confirm button (GAP-106)", async () => {
    admissionState = "bed_assigned";
    mountWorklist();
    expect(await screen.findByText("Awaiting M6 LCP acknowledgement")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm admission" })).toBeNull();
    // Nothing on the row can reach the system-internal route.
    expect(writes().some((c) => c.endsWith("/confirm"))).toBe(false);
  });

  it("the M6-ack status is shown only while the admission awaits it", async () => {
    admissionState = "active";
    mountWorklist();
    expect(await screen.findByRole("button", { name: "Discharge" })).toBeTruthy();
    expect(screen.queryByText("Awaiting M6 LCP acknowledgement")).toBeNull();
  });

  it("request-bed sends the unit the coordinator picked", async () => {
    admissionState = "pending";
    mountWorklist();
    fireEvent.click(await screen.findByRole("button", { name: "Request bed" }));
    const unitField = await screen.findByLabelText(/^unit/i);
    await waitFor(() => expect(calls).toContain("GET /api/v1/inpatient-units"));
    type(unitField, UNIT);
    fireEvent.click(screen.getByRole("button", { name: "Send bed request" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/ipu-admissions/${ADMISSION}/request-bed`),
    );
    expect(bodies[0]).toEqual({ unitId: UNIT });
  });

  it("assign-bed walks rooms then beds — there is no unit-wide bed list route", async () => {
    admissionState = "bed_pending";
    mountWorklist();
    fireEvent.click(await screen.findByRole("button", { name: "Assign bed" }));
    type(await screen.findByLabelText(/^unit/i), UNIT);
    await waitFor(() => expect(calls).toContain(`GET /api/v1/ipu-rooms/${ROOM}/beds`));
    type(screen.getByLabelText(/^bed/i), BED);
    fireEvent.click(screen.getByRole("button", { name: "Confirm bed assignment" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/ipu-admissions/${ADMISSION}/assign-bed`),
    );
    expect(bodies[0]).toEqual({ bedId: BED });
  });

  it("a refused discharge shows the server's own next step and does NOT close the dialog", async () => {
    writeFailure = {
      status: 422,
      body: { error: { code: "ADMISSION_DISCHARGE_EVENT_MISSING", message: "" } },
    };
    mountWorklist();
    fireEvent.click(await screen.findByRole("button", { name: "Discharge" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm discharge" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/M6 admission first/i);
    // Still open, so the reason the clinician picked is not lost.
    expect(screen.getByRole("button", { name: "Discharge" })).toBeTruthy();
  });
});

// ── the bedside pane ───────────────────────────────────────────────────────────────────────────────────

describe("#91 — the bedside pane works the restraint clock", () => {
  it("reads all five sub-resources for one admission (#169/#172 added four of them)", async () => {
    mountBedside();
    await waitFor(() =>
      expect(calls).toContain(`GET /api/v1/ipu-admissions/${ADMISSION}/restraints`),
    );
    expect(calls).toContain(`GET /api/v1/ipu-admissions/${ADMISSION}/gip-criteria`);
    expect(calls).toContain(`GET /api/v1/ipu-admissions/${ADMISSION}/irc-episodes`);
    expect(calls).toContain("GET /api/v1/ipu-visitors");
    expect(calls).toContain("GET /api/v1/ipu-visitor-restrictions");
  });

  it("reassesses a restraint at the cadence its own order set, not a platform default", async () => {
    mountBedside();
    fireEvent.click(await screen.findByRole("button", { name: "Reassess" }));
    fireEvent.click(await screen.findByRole("button", { name: "Record reassessment" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/ipu-restraint/${RESTRAINT}/reassess`),
    );
    const body = bodies[0] as { outcome: string; nextDueAt: string };
    expect(body.outcome).toBe("continue");
    // 10 minutes — this restraint's OWN tightened interval, not the 15-minute category default.
    const delta = new Date(body.nextDueAt).getTime() - Date.now();
    expect(Math.round(delta / 60_000)).toBe(10);
  });

  it("shows an overdue restraint as overdue and STILL offers the reassessment", async () => {
    restraintNextDueAt = new Date(Date.now() - 4 * 60_000).toISOString();
    mountBedside();
    expect(await screen.findByText(/Overdue by 4 min/)).toBeTruthy();
    // The frontend never disables the control on its own clock reading — least of all when it is late.
    expect(screen.getByRole("button", { name: "Reassess" })).toBeTruthy();
  });

  it("releases a restraint", async () => {
    mountBedside();
    fireEvent.click(await screen.findByRole("button", { name: "Release" }));
    fireEvent.click(await screen.findByRole("button", { name: "Release restraint" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/ipu-restraint/${RESTRAINT}/release`),
    );
  });

  it("a released restraint offers neither reassess nor release", async () => {
    restraintState = "released";
    mountBedside();
    await screen.findByText(/Soft Limb/);
    expect(screen.queryByRole("button", { name: "Reassess" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Release" })).toBeNull();
  });

  it("applies a restraint against a SIGNED order for this patient, never an unsigned one", async () => {
    mountBedside();
    fireEvent.click(await screen.findByRole("button", { name: "Apply restraint" }));
    await waitFor(() => expect(calls).toContain("GET /api/v1/orders"));
    const orderField = screen.getByLabelText(/^physician order/i) as HTMLSelectElement;
    // The unsigned order is not offered. The server re-resolves and refuses it anyway (#169) — this
    // just means the picker cannot hand it over in the first place.
    const offered = Array.from(orderField.options).map((o) => o.value);
    expect(offered).toContain(ORDER);
    expect(offered).not.toContain("unsigned-order");
    type(orderField, ORDER);
    type(screen.getByLabelText(/^clinical justification/i), "x".repeat(120));
    fireEvent.click(screen.getByRole("button", { name: "Confirm and apply" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/ipu-admissions/${ADMISSION}/restraint`),
    );
    const body = bodies[0] as Record<string, unknown>;
    expect(body.orderingOrderId).toBe(ORDER);
    expect(body.category).toBe("behavioral");
    // #169 removed `orderingPhysicianId` from this body — the server derives it from the order, so the
    // two can no longer name different people.
    expect(body).not.toHaveProperty("orderingPhysicianId");
  });

  it("the reassessment interval defaults to the category floor and follows the category", async () => {
    mountBedside();
    fireEvent.click(await screen.findByRole("button", { name: "Apply restraint" }));
    const interval = screen.getByLabelText(/^reassessment interval/i) as HTMLInputElement;
    expect(interval.value).toBe("15");
    type(screen.getByLabelText(/^category/i), "medical");
    await waitFor(() => expect(interval.value).toBe("120"));
    // A number ABOVE the floor is still sent: the server owns tighten-only and its refusal names the
    // direction. Silently clamping would teach a clinician nothing about the rule.
    type(interval, "240");
    type(screen.getByLabelText(/^physician order/i), ORDER);
    type(screen.getByLabelText(/^clinical justification/i), "x".repeat(120));
    fireEvent.click(screen.getByRole("button", { name: "Confirm and apply" }));
    await waitFor(() => expect(bodies.length).toBe(1));
    expect((bodies[0] as { reassessmentIntervalMinutes: number }).reassessmentIntervalMinutes).toBe(
      240,
    );
  });

  it("surfaces the CoP 418.110 order refusal verbatim rather than as a form error", async () => {
    writeFailure = {
      status: 422,
      body: {
        error: {
          code: "RESTRAINT_ORDER_REQUIRED",
          message: "That order belongs to a different patient.",
        },
      },
    };
    mountBedside();
    fireEvent.click(await screen.findByRole("button", { name: "Apply restraint" }));
    type(await screen.findByLabelText(/^physician order/i), ORDER);
    type(screen.getByLabelText(/^clinical justification/i), "x".repeat(120));
    fireEvent.click(screen.getByRole("button", { name: "Confirm and apply" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("That order belongs to a different patient.");
  });
});

describe("#91 — the bedside pane attests, overrides and admits", () => {
  it("attests the GIP criterion with a physician from the canonical register", async () => {
    mountBedside();
    fireEvent.click(await screen.findByRole("button", { name: "Attest criterion" }));
    type(await screen.findByLabelText(/^uncontrolled symptom/i), "Intractable dyspnoea");
    type(screen.getByLabelText(/^interventions attempted/i), "Opioid titration\nOxygen");
    type(screen.getByLabelText(/^planned inpatient/i), "Continuous infusion");
    type(screen.getByLabelText(/^clinical rationale/i), "y".repeat(120));
    fireEvent.click(screen.getByRole("button", { name: "Record attestation" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/ipu-admissions/${ADMISSION}/gip-criteria`),
    );
    const body = bodies[0] as { data: Record<string, unknown> };
    expect(body.data.criterion_kind).toBe("acute_symptom_management");
    // "One per line" becomes the array the CoP 418.108 payload takes.
    expect(body.data.planned_inpatient_interventions).toEqual(["Continuous infusion"]);
  });

  it("offers all three CoP 418.108 criteria, not only the convenient one", async () => {
    mountBedside();
    fireEvent.click(await screen.findByRole("button", { name: "Attest criterion" }));
    const criterion = (await screen.findByLabelText(/^criterion/i)) as HTMLSelectElement;
    expect(Array.from(criterion.options).map((o) => o.value)).toEqual([
      "acute_symptom_management",
      "imminent_death_terminal_care",
      "medications_treatments_inpatient_only",
    ]);
  });

  it("reassesses the GIP criterion", async () => {
    mountBedside();
    // "Reassess criterion", not "Reassess": the restraint row action and the GIP section action are
    // different acts on different records, and naming them the same made both ambiguous — to a test
    // and to a nurse reading the screen.
    fireEvent.click(await screen.findByRole("button", { name: "Reassess criterion" }));
    type(await screen.findByLabelText(/^rationale/i), "z".repeat(80));
    fireEvent.click(screen.getByRole("button", { name: "Record criterion reassessment" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/ipu-admissions/${ADMISSION}/gip-criteria/reassess`),
    );
    expect(bodies[0]).toEqual({ criterionStillMet: true, rationale: "z".repeat(80) });
  });

  it("invokes the respite cap override on an IRC admission", async () => {
    admissionKind = "irc";
    mountBedside();
    fireEvent.click(await screen.findByRole("button", { name: "Override cap" }));
    type(await screen.findByLabelText(/^reason/i), "w".repeat(140));
    fireEvent.click(screen.getByRole("button", { name: "Invoke override" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/ipu-admissions/${ADMISSION}/irc-cap-override`),
    );
    expect(bodies[0]).toEqual({ reason: "w".repeat(140), extensionDays: 1 });
  });

  it("shows the GIP section only for a GIP stay and the respite section only for a respite one", async () => {
    admissionKind = "irc";
    const { unmount } = mountBedside();
    expect(await screen.findByText("Respite episode")).toBeTruthy();
    expect(screen.queryByText("GIP criteria")).toBeNull();
    unmount();
    admissionKind = "gip";
    mountBedside();
    expect(await screen.findByText("GIP criteria")).toBeTruthy();
    expect(screen.queryByText("Respite episode")).toBeNull();
  });

  it("checks a visitor in, and checks out one a PREVIOUS shift checked in", async () => {
    mountBedside();
    fireEvent.click(await screen.findByRole("button", { name: "Check in visitor" }));
    type(await screen.findByLabelText(/^visitor name/i), "Jordan Lee");
    fireEvent.click(screen.getByRole("button", { name: "Record check-in" }));
    await waitFor(() => expect(writes()).toContain("POST /api/v1/ipu-visitors"));
    const body = bodies[0] as Record<string, unknown>;
    expect(body.ipuAdmissionId).toBe(ADMISSION);
    expect(body.screeningOutcome).toEqual({ feverFree: true, symptomFree: true });

    // The check-out is the whole point of #169's visitor list: the id came from a GET, not from the
    // POST response, so a later shift can reach it.
    fireEvent.click(screen.getByRole("button", { name: "Check out" }));
    fireEvent.click(await screen.findByRole("button", { name: "Check out visitor" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/ipu-visitors/${VISITOR}/check-out`),
    );
  });

  it("a departed visitor offers no check-out", async () => {
    visitorCheckedOut = "2026-08-27T11:00:00.000Z";
    mountBedside();
    await screen.findByText("Departed");
    expect(screen.queryByRole("button", { name: "Check out" })).toBeNull();
  });

  it("lists the restrictions in force and lifts one (#172 added the read)", async () => {
    mountBedside();
    expect(await screen.findByText("Mask Required")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Lift restriction" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm lift" }));
    await waitFor(() => expect(writes()).toContain("DELETE /api/v1/ipu-visitor-restrictions"));
    expect(bodies[0]).toEqual({ restrictionId: RESTRICTION });
  });

  it("applies a patient-scoped restriction from the bedside", async () => {
    mountBedside();
    fireEvent.click(await screen.findByRole("button", { name: "Apply restriction" }));
    type(await screen.findByLabelText(/^rationale/i), "Household norovirus contact.");
    fireEvent.click(screen.getByRole("button", { name: "Record restriction" }));
    await waitFor(() => expect(writes()).toContain("POST /api/v1/ipu-visitor-restrictions"));
    expect(bodies[0]).toEqual({
      scope: "patient",
      patientId: PATIENT,
      restrictionKind: "mask_required",
      rationale: "Household norovirus contact.",
      sourceKind: "per_patient_clinical",
    });
  });

  it("a closed admission is a record, not a workspace — no bedside writes are offered", async () => {
    admissionState = "discharged";
    restraintState = "released";
    mountBedside();
    await screen.findByText("Visitors");
    expect(screen.queryByRole("button", { name: "Apply restraint" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check in visitor" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Attest criterion" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply restriction" })).toBeNull();
  });
});
