// apps/web/src/modules/14-idg — #91: the IDG meeting must be conductable, not just readable.
//
// Before this change `apps/web/src/modules/14-idg` issued ZERO mutations — 2071 lines across seven
// screens, every one a read. The interdisciplinary group is where 42 CFR 418.56(b) says the plan of
// care is established and §418.56(d) says it is reviewed at least every 15 calendar days, and the Live
// Meeting Surface was a list of patient ids: nobody could check in, put anything on the agenda, record
// what the group decided, assign a follow-up, or adjourn. Adjournment is the only thing that resets the
// 15-day review floor the module's own sweep escalates against.
//
// The net asserts on RECORDED FETCH CALLS — method, path and body — rather than on a spy over the api
// client, because a mocked client still passes when a button is re-wired to a handler that never fires.
// Several assertions are about the SHAPE of the §2.6 payload, which is a discriminated union the server
// validates in the domain: getting `kind` or the nesting wrong comes back 422 in production and would
// pass a shallow "did we POST" check.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { LiveMeeting } from "./live-meeting";
import { MeetingDetail } from "./meeting-detail";
import { Minutes } from "./minutes";

const MEETING = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PATIENT = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const PACKET = "cccccccc-3333-4333-8333-cccccccccccc";
const ATT_ROW = "dddddddd-4444-4444-8444-dddddddddddd";
const DECISION = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
const MINUTES_ID = "ffffffff-6666-4666-8666-ffffffffffff";

let meetingStatus = "live";
let roster: Record<string, unknown>[] = [];
let decisions: Record<string, unknown>[] = [];
let minutesStatus = "in_progress";

const packet = { packetId: PACKET, meetingId: MEETING, patientId: PATIENT, frozenAt: null };
const agendaItem = {
  id: "agenda-1",
  meetingId: MEETING,
  kind: "patient_review",
  patientId: PATIENT,
};

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
    if (path.endsWith("/attendance")) return roster;
    if (path.endsWith("/agenda")) return [agendaItem];
    if (path.endsWith("/decisions")) return decisions;
    if (path.endsWith("/packets")) return [packet];
    if (path.endsWith("/minutes"))
      return {
        id: MINUTES_ID,
        meetingId: MEETING,
        status: minutesStatus,
        finalizedAt: minutesStatus === "final" ? "2026-08-27T11:00:00.000Z" : null,
        finalizedByMembershipId: minutesStatus === "final" ? "membership-1" : null,
        minutesDocumentId: null,
        attendanceCount: minutesStatus === "final" ? 4 : null,
        decisionCount: minutesStatus === "final" ? 2 : null,
        actionItemCount: minutesStatus === "final" ? 1 : null,
        disciplineNoteCount: minutesStatus === "final" ? 7 : null,
        disciplineAddendumCount: minutesStatus === "final" ? 3 : 0,
        addendumState:
          minutesStatus === "final"
            ? {
                open: true,
                closesAt: "2026-09-10T11:00:00.000Z",
                closedReason: null,
                supersededPatientIds: [],
              }
            : { open: false, closesAt: null, closedReason: null, supersededPatientIds: [] },
      };
    return {
      id: MEETING,
      organizationId: "org-1",
      locationId: "loc-1",
      status: meetingStatus,
      scheduledStart: "2026-08-27T09:00:00.000Z",
      scheduledEnd: "2026-08-27T10:00:00.000Z",
      adjournedAt: null,
    };
  }
  if (path.endsWith("/attendance"))
    return {
      id: ATT_ROW,
      meetingId: MEETING,
      membershipId: "m-1",
      discipline: "rn_case_manager",
      status: "present",
      checkedInAt: "2026-08-27T09:05:00.000Z",
    };
  if (path.includes("/agenda")) return agendaItem;
  if (path.includes("/decisions") || path.includes("/supersede"))
    return {
      id: DECISION,
      meetingId: MEETING,
      patientId: PATIENT,
      agendaItemId: null,
      decisionKind: "team_note",
      status: "open",
      wasQuorate: true,
      recordedByMembershipId: "membership-1",
      recordedAt: "2026-08-27T09:30:00.000Z",
      supersededByDecisionId: null,
    };
  if (path.includes("/action-items"))
    return {
      id: "action-1",
      meetingId: MEETING,
      decisionId: DECISION,
      patientId: PATIENT,
      assignedToMembershipId: "m-1",
      status: "open",
      dueDate: "2026-09-03T00:00:00.000Z",
      linkedArtifactKind: null,
    };
  if (path.includes("/amendments")) return { amendmentId: "amend-1", minutesId: MINUTES_ID };
  return {
    id: MEETING,
    organizationId: "org-1",
    locationId: "loc-1",
    status: "adjourned",
    scheduledStart: "2026-08-27T09:00:00.000Z",
    scheduledEnd: "2026-08-27T10:00:00.000Z",
    adjournedAt: "2026-08-27T10:05:00.000Z",
  };
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
        // Every M14 write sends JSON; recording nothing is the honest answer if one ever does not.
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
  roles: ["idg_coordinator"],
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
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  ) as unknown as ReturnType<typeof render>;
}

const mountLive = () =>
  mount(`/idg/meetings/${MEETING}/live`, <LiveMeeting />, "/idg/meetings/:id/live");
const mountDetail = () => mount(`/idg/meetings/${MEETING}`, <MeetingDetail />, "/idg/meetings/:id");
const mountMinutes = () =>
  mount(`/idg/meetings/${MEETING}/minutes`, <Minutes />, "/idg/meetings/:id/minutes");

const writes = () => calls.filter((c) => !c.startsWith("GET "));

beforeEach(() => {
  calls = [];
  bodies = [];
  writeFailure = null;
  meetingStatus = "live";
  minutesStatus = "in_progress";
  roster = [];
  decisions = [];
});
afterEach(() => {
  writeFailure = null;
});

describe("#91 — the meeting can be conducted", () => {
  it("Check in POSTs an attendance row with the discipline the quorum is counted from", async () => {
    mountLive();
    await waitFor(() => expect(screen.getByRole("button", { name: "Check in" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Check in" }));
    fireEvent.change(await waitFor(() => screen.getByLabelText(/Membership id/i)), {
      target: { value: "m-1" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Check in" })[1] as HTMLElement);
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/idg/meetings/${MEETING}/attendance`),
    );
    expect(bodies[0]?.membershipId).toBe("m-1");
    expect(bodies[0]?.discipline).toBe("rn_case_manager");
    expect(bodies[0]?.status).toBe("present");
  });

  it("Add agenda item POSTs the kind and the patient it is about", async () => {
    mountLive();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add agenda item" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add agenda item" }));
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Add to agenda" })));
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/idg/meetings/${MEETING}/agenda`));
    expect(bodies[0]?.kind).toBe("patient_review");
    // The single agenda patient is preselected, so the item is bound to a patient rather than floating.
    expect(bodies[0]?.patientId).toBe(PATIENT);
  });

  it("a team note records as a patient-LESS decision with the §2.6 team_note payload", async () => {
    mountLive();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Record decision" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Record decision" }));
    fireEvent.change(await waitFor(() => screen.getByLabelText(/^Note$/i)), {
      target: { value: "Team reviewed the caseload; no patient-scoped action." },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Record decision" })[1] as HTMLElement);
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/idg/meetings/${MEETING}/decisions`),
    );
    expect(bodies[0]?.patientId).toBeNull();
    const payload = bodies[0]?.payload as Record<string, unknown>;
    expect(payload.kind).toBe("team_note");
    expect(payload.noteText).toBe("Team reviewed the caseload; no patient-scoped action.");
  });

  it("a level-of-care decision nests the considered level and names the patient", async () => {
    mountLive();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Record decision" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Record decision" }));
    fireEvent.change(await waitFor(() => screen.getByLabelText(/^Decision$/i)), {
      target: { value: "level_of_care_consideration" },
    });
    fireEvent.change(screen.getByLabelText(/Considered level/i), {
      target: { value: "general_inpatient" },
    });
    fireEvent.change(screen.getByLabelText(/^Rationale$/i), {
      target: { value: "Uncontrolled pain not manageable at home." },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Record decision" })[1] as HTMLElement);
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/idg/meetings/${MEETING}/decisions`),
    );
    expect(bodies[0]?.patientId).toBe(PATIENT);
    const payload = bodies[0]?.payload as Record<string, unknown>;
    expect(payload.kind).toBe("level_of_care_consideration");
    expect(payload.consideredLevel).toBe("general_inpatient");
    expect(payload.rationaleText).toBe("Uncontrolled pain not manageable at home.");
  });

  it("a care-plan update sends ONE problem_add mutation — the only op that needs no element id", async () => {
    mountLive();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Record decision" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Record decision" }));
    fireEvent.change(await waitFor(() => screen.getByLabelText(/^Decision$/i)), {
      target: { value: "care_plan_update" },
    });
    fireEvent.change(screen.getByLabelText(/Problem description/i), {
      target: { value: "Increased dyspnea at rest" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Record decision" })[1] as HTMLElement);
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/idg/meetings/${MEETING}/decisions`),
    );
    const payload = bodies[0]?.payload as { kind: string; mutations: Record<string, unknown>[] };
    expect(payload.kind).toBe("care_plan_update");
    expect(payload.mutations).toHaveLength(1);
    expect(payload.mutations[0]?.op).toBe("problem_add");
    expect(payload.mutations[0]?.description).toBe("Increased dyspnea at rest");
    expect(payload.mutations[0]?.problemKind).toBe("terminal");
  });

  it("Assign follow-up carries the decision it came out of, so the item keeps its provenance", async () => {
    decisions = [
      {
        id: DECISION,
        meetingId: MEETING,
        patientId: PATIENT,
        agendaItemId: null,
        decisionKind: "referral",
        status: "open",
        wasQuorate: true,
        recordedByMembershipId: "membership-1",
        recordedAt: "2026-08-27T09:30:00.000Z",
        supersededByDecisionId: null,
      },
    ];
    mountLive();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Assign follow-up" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Assign follow-up" }));
    fireEvent.change(await waitFor(() => screen.getByLabelText(/Assign to/i)), {
      target: { value: "m-9" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Assign" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/idg/meetings/${MEETING}/action-items`),
    );
    expect(bodies[0]?.assignedToMembershipId).toBe("m-9");
    expect(bodies[0]?.decisionId).toBe(DECISION);
  });

  it("Supersede POSTs to the supersede route, never a PATCH — the prior decision survives", async () => {
    decisions = [
      {
        id: DECISION,
        meetingId: MEETING,
        patientId: PATIENT,
        agendaItemId: null,
        decisionKind: "referral",
        status: "open",
        wasQuorate: true,
        recordedByMembershipId: "membership-1",
        recordedAt: "2026-08-27T09:30:00.000Z",
        supersededByDecisionId: null,
      },
    ];
    mountLive();
    await waitFor(() => expect(screen.getByRole("button", { name: "Supersede" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Supersede" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/idg/decisions/${DECISION}/supersede`),
    );
    expect(writes().some((c) => c.startsWith("PATCH /api/v1/idg/decisions/"))).toBe(false);
  });

  it("Excuse soft-removes an attendance row rather than deleting the record of the mistake", async () => {
    roster = [
      {
        id: ATT_ROW,
        meetingId: MEETING,
        membershipId: "m-1",
        discipline: "rn_case_manager",
        status: "present",
        checkedInAt: "2026-08-27T09:05:00.000Z",
      },
    ];
    mountLive();
    await waitFor(() => expect(screen.getByRole("button", { name: "Excuse" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Excuse" }));
    await waitFor(() => expect(writes()).toContain(`DELETE /api/v1/idg/attendance/${ATT_ROW}`));
    expect(await screen.findByText(/out of the quorum present-set/i)).toBeTruthy();
  });
});

describe("#91 — adjournment is the commit point, and its refusal is legible", () => {
  it("Adjourn POSTs the commit point", async () => {
    mountLive();
    await waitFor(() => expect(screen.getByRole("button", { name: "Adjourn" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Adjourn" }));
    fireEvent.click(
      await waitFor(() => screen.getAllByRole("button", { name: "Adjourn" })[1] as HTMLElement),
    );
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/idg/meetings/${MEETING}/adjourn`));
  });

  it("a 412 STEP_UP_REQUIRED reads as a re-authentication prompt, not as a bug", async () => {
    // F-028 made this gate real: the route resolves the caller's actual session rather than trusting an
    // `x-step-up` header. A coordinator who sees only "something went wrong" cannot act on that.
    writeFailure = {
      status: 412,
      body: { error: { code: "STEP_UP_REQUIRED", message: "fresh step-up required" } },
    };
    mountLive();
    await waitFor(() => expect(screen.getByRole("button", { name: "Adjourn" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Adjourn" }));
    fireEvent.click(
      await waitFor(() => screen.getAllByRole("button", { name: "Adjourn" })[1] as HTMLElement),
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(/re-authentication/i);
  });

  it("a 422 from quorate_decision is shown where the coordinator is looking", async () => {
    writeFailure = {
      status: 422,
      body: { error: { code: "NOT_QUORATE", message: "the group is not quorate" } },
    };
    mountLive();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Record decision" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Record decision" }));
    fireEvent.change(await waitFor(() => screen.getByLabelText(/^Note$/i)), {
      target: { value: "A note." },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Record decision" })[1] as HTMLElement);
    expect((await screen.findByRole("alert")).textContent).toMatch(/not quorate/i);
  });

  it("Record decision stays ENABLED with an empty roster — the server owns quorum", async () => {
    // Disabling it here would be a second implementation of the CoP composition rule, free to disagree
    // with `quorate_decision`. The surface says who is missing; it does not decide.
    mountLive();
    const button = await waitFor(() => screen.getByRole("button", { name: "Record decision" }));
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(await screen.findByText(/Decisions stay available/i)).toBeTruthy();
  });
});

describe("#91 — the pre-meeting lifecycle", () => {
  it("Build packets and Start are offered on the status that permits each, and on no other", async () => {
    meetingStatus = "scheduled";
    const { unmount } = mountDetail();
    await waitFor(() => expect(screen.getByRole("button", { name: "Build packets" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Start meeting" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Build packets" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/idg/meetings/${MEETING}/packets/build`),
    );
    unmount();

    calls = [];
    meetingStatus = "packets_ready";
    mountDetail();
    await waitFor(() => expect(screen.getByRole("button", { name: "Start meeting" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Start meeting" }));
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/idg/meetings/${MEETING}/start`));
  });

  it("Cancel sends the reason and the proposedTransition the review-floor ABAC resolves on", async () => {
    meetingStatus = "scheduled";
    mountDetail();
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.change(await waitFor(() => screen.getByLabelText(/^Reason$/i)), {
      target: { value: "Location closed for the day" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel meeting" }));
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/idg/meetings/${MEETING}/cancel`));
    expect(bodies[0]?.reason).toBe("Location closed for the day");
    // The route's `per_patient_review_floor_clear` predicate reads this at authz time, before the handler.
    expect(bodies[0]?.proposedTransition).toBe("cancel");
  });

  it("the attendance rail renders the roster the read now returns", async () => {
    meetingStatus = "scheduled";
    roster = [
      {
        id: ATT_ROW,
        meetingId: MEETING,
        membershipId: "m-1",
        discipline: "rn_case_manager",
        status: "present",
        checkedInAt: "2026-08-27T09:05:00.000Z",
      },
    ];
    mountDetail();
    // It used to say "this pre-meeting view doesn't carry attendance yet" — true, because the three
    // attendance writes had no reader anywhere in the module.
    expect(await screen.findByText(/rn case manager/i)).toBeTruthy();
    expect(calls).toContain(`GET /api/v1/idg/meetings/${MEETING}/attendance`);
  });
});

describe("#91 — the minutes are the §418.56(d) evidence", () => {
  it("in-progress minutes distinguish 'nothing frozen yet' from 'nothing happened'", async () => {
    mountMinutes();
    // Four counts (attendance, decisions, action items, discipline notes), all "not frozen yet" — the assertion is that none of them reads as a zero.
    expect((await screen.findAllByText(/not frozen yet/i)).length).toBe(4);
    expect(screen.queryByRole("button", { name: "Request an amendment" })).toBeNull();
  });

  it("final minutes show what was frozen and who finalized them", async () => {
    minutesStatus = "final";
    mountMinutes();
    // The counts come from the three snapshot columns adjournment now writes; before this change the
    // read projected 3 of 13 columns and the adjourn transaction left all three NULL.
    expect(await screen.findByText("4")).toBeTruthy();
    expect(screen.getByText("membership-1")).toBeTruthy();
    // The discipline-note count is shown (text is not on this view — a link points back to the meeting page).
    expect(screen.getByText("Discipline notes")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Read the notes on the meeting page" }).getAttribute("href"),
    ).toBe(`/idg/meetings/${MEETING}/live#discipline-notes`);
    // The live late-addenda count sits beside the frozen note count and links back to the panel.
    expect(screen.getByText("Late addenda")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    // The window state from `addendumState` sits in the stat caption.
    expect(screen.getByText(/addenda open until Sep 10, 2026/)).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Read the addenda in the notes panel" })
        .getAttribute("href"),
    ).toBe(`/idg/meetings/${MEETING}/live#discipline-notes`);
  });

  it("an amendment REQUEST is filed against final minutes rather than editing them", async () => {
    minutesStatus = "final";
    mountMinutes();
    fireEvent.click(
      await waitFor(() => screen.getByRole("button", { name: "Request an amendment" })),
    );
    fireEvent.change(await waitFor(() => screen.getByLabelText(/should be corrected/i)), {
      target: { value: "The attendance record omits the chaplain." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/idg/minutes/${MINUTES_ID}/amendments`),
    );
    expect(bodies[0]?.amendmentReason).toBe("The attendance record omits the chaplain.");
    // No PATCH anywhere: final minutes are immutable and the M4 trigger refuses a content update.
    expect(writes().some((c) => c.startsWith("PATCH /api/v1/idg/minutes"))).toBe(false);
  });
});
