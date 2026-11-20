import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// @vitest-environment jsdom
// apps/web/src/modules/15-discipline-care-plans — the Aide POC editor's goal `source` select. It must default to
// `clinical`, offer exactly the three `discipline_goal_source` values the form may send (`agent_stated` needs an
// acting consent the form does not collect), send the chosen value on "Add goal", and label a goal's source in the
// goals table with the same wording the select uses. The backend parity test pins the route union against the DB
// enum; this pins what the screen does with it.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { AidePocEditor } from "../aide-poc-editor";
import { goalSourceLabel } from "../discipline-status";

const PATIENT = "patient-1";
const PLAN = "plan-1";
const VERSION = "v-aide-draft";
const PROBLEM_ID = "33333333-3333-4333-8333-333333333333";
const GOAL_TEXT = "Resident will bathe with standby assist three times weekly.";

const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  membershipId: "membership-1",
  displayName: "Sarah Miller",
  permissions: ["discipline_plan.read", "discipline_plan.author"],
};

const goal = (over: Record<string, unknown>) => ({
  goalId: "22222222-2222-4222-8222-222222222222",
  parentProblemId: PROBLEM_ID,
  parentGoalId: null,
  source: "clinical",
  status: "active",
  originalText: "Keep skin intact.",
  revisedText: null,
  measurableOutcome: null,
  targetAt: null,
  frequencyText: null,
  frequencyValue: null,
  modalityText: null,
  sudRelated: false,
  addedByDiscipline: "aide",
  addedAt: "2026-01-02T00:00:00.000Z",
  version: 1,
  ...over,
});

const aideDraft = {
  versionId: VERSION,
  planId: PLAN,
  sequence: 1,
  status: "draft",
  kind: "initial",
  idgMeetingId: null,
  finalizedAt: null,
  signedAt: null,
  supersededAt: null,
  version: 1,
};

const planDetail = (goals: unknown[]) => ({
  planId: PLAN,
  patientId: PATIENT,
  admissionId: "adm-1",
  providerEntityId: "pe-1",
  locationId: "loc-1",
  kind: "aide_poc",
  status: "draft_revising",
  nextSupervisoryDueAt: null,
  initialAssessmentClockStartedAt: "2026-01-01T00:00:00.000Z",
  initialAssessmentSignedAt: null,
  spiritualCareDeclinedAt: null,
  updatedAt: "2026-01-02T00:00:00.000Z",
  version: 4,
  aideMembershipId: null,
  supervisingRnMembershipId: null,
  supervisoryCadenceDaysOverride: null,
  spiritualCareDeclined: null,
  goals,
  interventions: [],
  assessments: [],
  supervisoryVisits: [],
  volunteerAssignments: [],
  versions: [aideDraft],
  supervisoryCadence: null,
  redacted_categories: [],
});

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

type PostCall = [path: string, init: { params: unknown; body: Record<string, unknown> }];

function renderEditor(goals: unknown[] = []) {
  const detail = planDetail(goals);
  const post = vi.fn(async (_path: string, _init: unknown) => ok({}));
  const client = {
    GET: vi.fn(async (path: string) => {
      if (path === "/api/v1/discipline-plans") return ok({ data: [detail], nextCursor: null });
      if (path === "/api/v1/discipline-plans/{planId}") return ok(detail);
      // The editor wears the shared chart shell, whose banner reads the patient.
      if (path === "/api/v1/patients/{id}")
        return ok({
          id: PATIENT,
          organizationId: "org-1",
          mrn: "MRN-0007",
          firstName: "June",
          lastName: "Rivera",
          dob: "1950-02-14",
          status: "active",
        });
      return ok({});
    }),
    POST: post,
  } as unknown as ApiClient;
  render(
    <MemoryRouter
      initialEntries={[`/patients/${PATIENT}/discipline-plans/aide-poc/${VERSION}/edit`]}
    >
      <ApiClientProvider client={client}>
        <ToastProvider>
          <SessionProvider session={session}>
            <Routes>
              <Route
                path="/patients/:patientId/discipline-plans/aide-poc/:versionId/edit"
                element={<AidePocEditor />}
              />
            </Routes>
          </SessionProvider>
        </ToastProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { post };
}

const sourceSelect = async () =>
  (await screen.findByRole("combobox", { name: "Source" })) as HTMLSelectElement;

/** Fill the goal form (the select is left as it is) and press "Add goal"; resolve once the form has reloaded. */
async function submitGoal(): Promise<void> {
  fireEvent.change(await screen.findByRole("textbox", { name: "IPOC problem id" }), {
    target: { value: PROBLEM_ID },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Goal text" }), {
    target: { value: GOAL_TEXT },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add goal" }));
}

/** The editor clears the goal text after a successful POST and then reloads the plan. */
const settled = () =>
  waitFor(() =>
    expect((screen.getByRole("textbox", { name: "Goal text" }) as HTMLTextAreaElement).value).toBe(
      "",
    ),
  );

describe("Aide POC editor — goal source", () => {
  it("defaults the Source select to clinical and offers only the three form-collectable sources", async () => {
    renderEditor();
    const select = await sourceSelect();
    expect(select.value).toBe("clinical");
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      "clinical",
      "patient_stated",
      "family_stated",
    ]);
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "Clinician authored",
      "Patient stated",
      "Family stated",
    ]);
  });

  it("posts the default source (clinical) when a goal is added", async () => {
    const { post } = renderEditor();
    await submitGoal();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0] as unknown as PostCall;
    expect(path).toBe("/api/v1/discipline-plans/{planId}/goals");
    expect(init.params).toMatchObject({ path: { planId: PLAN } });
    expect(init.body).toMatchObject({
      source: "clinical",
      parentProblemId: PROBLEM_ID,
      originalText: GOAL_TEXT,
      addedByDiscipline: "aide",
    });
    await settled();
  });

  it("posts the chosen source after the select is changed to patient_stated", async () => {
    const { post } = renderEditor();
    fireEvent.change(await sourceSelect(), { target: { value: "patient_stated" } });
    await submitGoal();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [, init] = post.mock.calls[0] as unknown as PostCall;
    expect(init.body).toMatchObject({
      source: "patient_stated",
      parentProblemId: PROBLEM_ID,
      originalText: GOAL_TEXT,
    });
    await settled();
  });

  it("labels a clinical goal 'Clinician authored' in the goals table, the same wording as the select", async () => {
    renderEditor([goal({ source: "clinical" })]);
    expect(await screen.findByRole("cell", { name: "Clinician authored" })).toBeTruthy();
    expect(screen.queryByRole("cell", { name: "Clinical" })).toBeNull();
  });

  it("warns before a reload only while authored changes are unsaved", async () => {
    renderEditor();
    const input = await screen.findByRole("textbox", { name: "Goal text" });

    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    fireEvent.change(input, { target: { value: GOAL_TEXT } });
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });
});

describe("goalSourceLabel", () => {
  it("labels every discipline_goal_source value, and still renders an unknown one", () => {
    expect(goalSourceLabel("clinical")).toBe("Clinician authored");
    expect(goalSourceLabel("patient_stated")).toBe("Patient stated");
    expect(goalSourceLabel("family_stated")).toBe("Family stated");
    expect(goalSourceLabel("agent_stated")).toBe("Agent stated");
    expect(goalSourceLabel("some_future_source")).toBe("Some future source");
  });
});
