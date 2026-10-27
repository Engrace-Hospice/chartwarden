import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// apps/web/src/modules/14-idg — attendance trust (M14 0286) in the Check-in modal.
//
// The roster is what quorum and the per-discipline note authorization trust, so the modal no longer lets anyone type a
// discipline: it asks the server what the SUBJECT's real roles confer and offers only that. A non-coordinator checks
// THEMSELF in; a coordinator picks the member and must tick an explicit attestation to record a discipline the member
// does not hold. Assertions are on the RECORDED POST BODY (the server re-validates; a re-wired control would still render).
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttendanceModal } from "./idg-meeting-modals";

const MEETING = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ME = "11111111-1111-4111-8111-111111111111";
const MIRA = "22222222-2222-4222-8222-222222222222";

let eligibilityFor: Record<string, Record<string, unknown>> = {};
let postBodies: Record<string, unknown>[] = [];
let postFailure: { status: number; body: unknown } | null = null;

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : null;
  const url = req ? req.url : String(input);
  const method = (req?.method ?? init?.method ?? "GET").toUpperCase();
  const u = new URL(url, "http://localhost");
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  if (u.pathname.endsWith("/attendance-eligibility")) {
    return json(200, eligibilityFor[u.searchParams.get("membershipId") ?? ME]);
  }
  if (method === "POST") {
    const raw = req ? await req.clone().text() : typeof init?.body === "string" ? init.body : "";
    postBodies.push(JSON.parse(raw) as Record<string, unknown>);
    if (postFailure) return json(postFailure.status, postFailure.body);
    return json(201, {
      id: "dddddddd-4444-4444-8444-dddddddddddd",
      meetingId: MEETING,
      membershipId: ME,
      discipline: "rn_case_manager",
      status: "present",
      checkedInAt: "2026-08-27T09:05:00.000Z",
      disciplineAttested: false,
      recordedByMembershipId: ME,
    });
  }
  return json(200, {});
}

function mount(props: Partial<Parameters<typeof AttendanceModal>[0]> = {}) {
  const recorded: unknown[] = [];
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <ToastProvider>
        <AttendanceModal
          open
          meetingId={MEETING}
          onClose={() => undefined}
          onRecorded={(r) => recorded.push(r)}
          callerMembershipId={ME}
          {...props}
        />
      </ToastProvider>
    </ApiClientProvider>,
  );
  return { recorded };
}

const disciplineOptions = (): string[] =>
  Array.from((screen.getByLabelText("Discipline") as HTMLSelectElement).options).map(
    (o) => o.value,
  );
const submit = (): HTMLButtonElement =>
  screen.getByRole("button", { name: /^Check in$|Checking in/ }) as HTMLButtonElement;

beforeEach(() => {
  postBodies = [];
  postFailure = null;
  eligibilityFor = {
    [ME]: {
      membershipId: ME,
      isCoordinator: false,
      heldDisciplines: ["rn_case_manager", "medical_director"],
      attestableDisciplines: [],
    },
  };
});
afterEach(() => undefined);

describe("Check-in modal — non-coordinator", () => {
  it("offers ONLY the caller's held disciplines, no attendee picker, and POSTs their own membership", async () => {
    mount();
    await waitFor(() =>
      expect(disciplineOptions()).toEqual(["rn_case_manager", "medical_director"]),
    );
    expect(screen.queryByLabelText(/Membership id/i)).toBeNull();
    expect(screen.queryByLabelText("Attendee")).toBeNull();
    expect(screen.queryByLabelText(/Attest a discipline/i)).toBeNull();
    expect(screen.getByText("Check yourself in")).toBeTruthy();
    fireEvent.click(submit());
    await waitFor(() => expect(postBodies).toHaveLength(1));
    expect(postBodies[0]).toMatchObject({
      membershipId: ME,
      discipline: "rn_case_manager",
      status: "present",
    });
    expect(postBodies[0]?.coordinatorAttested).toBeUndefined();
  });

  it("a caller whose roles carry no IDG discipline cannot check in and is told why", async () => {
    eligibilityFor[ME] = { ...eligibilityFor[ME], heldDisciplines: [] };
    mount();
    await waitFor(() =>
      expect(screen.getByText(/None of your roles carries an IDG discipline/)).toBeTruthy(),
    );
    expect(submit().disabled).toBe(true);
  });

  it("maps a server refusal to actionable copy, keyed by error CODE (a 403 here is not 'role not permitted')", async () => {
    postFailure = {
      status: 403,
      body: { error: { code: "ATTENDANCE_SELF_ONLY", message: "raw server text" } },
    };
    mount();
    await waitFor(() => expect(disciplineOptions().length).toBeGreaterThan(0));
    fireEvent.click(submit());
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/only check yourself in/i),
    );
    expect(screen.getByRole("alert").textContent).not.toMatch(/raw server text/);
  });

  it("maps DISCIPLINE_NOT_HELD", async () => {
    postFailure = {
      status: 422,
      body: { error: { code: "DISCIPLINE_NOT_HELD", message: "raw" } },
    };
    mount();
    await waitFor(() => expect(disciplineOptions().length).toBeGreaterThan(0));
    fireEvent.click(submit());
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/not one of the member's roles/i),
    );
  });
});

describe("Check-in modal — coordinator", () => {
  beforeEach(() => {
    eligibilityFor[ME] = {
      membershipId: ME,
      isCoordinator: true,
      heldDisciplines: ["administrator"],
      attestableDisciplines: [],
    };
    eligibilityFor[MIRA] = {
      membershipId: MIRA,
      isCoordinator: true,
      heldDisciplines: ["msw"],
      attestableDisciplines: ["rn_case_manager", "msw", "chaplain", "administrator"],
    };
  });
  const members = [
    { id: ME, label: "Ada Administrator" },
    { id: MIRA, label: "Mira Chen, MSW" },
  ];

  it("defaults to themself; another member's discipline choices come from THAT member's roles", async () => {
    mount({ members });
    await waitFor(() => expect(disciplineOptions()).toEqual(["administrator"]));
    // No attestation box for themself: a coordinator cannot attest for themself.
    expect(screen.queryByLabelText(/Attest a discipline/i)).toBeNull();
    fireEvent.change(screen.getByLabelText("Attendee"), { target: { value: MIRA } });
    await waitFor(() => expect(disciplineOptions()).toEqual(["msw"]));
    fireEvent.click(submit());
    await waitFor(() => expect(postBodies).toHaveLength(1));
    expect(postBodies[0]).toMatchObject({ membershipId: MIRA, discipline: "msw" });
    expect(postBodies[0]?.coordinatorAttested).toBeUndefined();
  });

  it("an explicit attestation widens the choices and is sent as coordinatorAttested", async () => {
    mount({ members });
    await waitFor(() => expect(screen.getByLabelText("Attendee")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Attendee"), { target: { value: MIRA } });
    await waitFor(() => expect(disciplineOptions()).toEqual(["msw"]));
    fireEvent.click(screen.getByLabelText(/Attest a discipline this member does not hold/i));
    await waitFor(() => expect(disciplineOptions()).toContain("chaplain"));
    fireEvent.change(screen.getByLabelText("Discipline"), { target: { value: "chaplain" } });
    fireEvent.click(submit());
    await waitFor(() => expect(postBodies).toHaveLength(1));
    expect(postBodies[0]).toMatchObject({
      membershipId: MIRA,
      discipline: "chaplain",
      coordinatorAttested: true,
    });
  });

  it("ticking attestation but choosing a discipline the member DOES hold sends no attestation flag", async () => {
    mount({ members });
    await waitFor(() => expect(screen.getByLabelText("Attendee")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Attendee"), { target: { value: MIRA } });
    await waitFor(() => expect(disciplineOptions()).toEqual(["msw"]));
    fireEvent.click(screen.getByLabelText(/Attest a discipline this member does not hold/i));
    await waitFor(() => expect(disciplineOptions()).toContain("msw"));
    fireEvent.change(screen.getByLabelText("Discipline"), { target: { value: "msw" } });
    fireEvent.click(submit());
    await waitFor(() => expect(postBodies).toHaveLength(1));
    expect(postBodies[0]?.coordinatorAttested).toBeUndefined();
  });
});
