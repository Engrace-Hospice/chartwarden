import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// @vitest-environment jsdom
// apps/web/src/modules/15-discipline-care-plans — the Aide POC editor's task and goal forms.
//   • Adding a task or goal as the RN must author as the `rn` discipline: the server's discipline matrix for an
//     Aide POC is ["rn"], so the old `addedByDiscipline: "aide"` was refused for every caller.
//   • "Frequency (words)" and "Frequency (coded)" are two selects over one preset list; picking either sets
//     both, and the coded value is the machine form the DB CHECK accepts.
//   • "IPOC problem" is a select over the patient's ACTIVE M7 problems, never a pasted uuid.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { AidePocEditor } from "../aide-poc-editor";

const PATIENT = "patient-1";
const PLAN = "plan-1";
const VERSION = "v-aide-draft";
const ACTIVE_PROBLEM = "33333333-3333-4333-8333-333333333333";
const RESOLVED_PROBLEM = "44444444-4444-4444-8444-444444444444";

const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  membershipId: "membership-1",
  displayName: "Rita Alvarez",
  permissions: ["discipline_plan.read", "discipline_plan.author", "care_plan.read"],
};

const planDetail = {
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
  goals: [],
  interventions: [],
  assessments: [],
  supervisoryVisits: [],
  volunteerAssignments: [],
  versions: [
    {
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
    },
  ],
  supervisoryCadence: null,
  redacted_categories: [],
};

const carePlan = (problems: unknown[]) => ({
  id: "care-plan-1",
  patientId: PATIENT,
  admissionId: "adm-1",
  status: "active",
  activeVersionId: null,
  version: 1,
  versions: [],
  problems,
  goals: [],
  interventions: [],
  redacted: false,
});

const problem = (
  id: string,
  description: string,
  status: string,
  over: { kind?: string; icd10Code?: string | null } = {},
) => ({
  id,
  planId: "care-plan-1",
  icd10Code: over.icd10Code ?? null,
  snomedCode: null,
  description,
  kind: over.kind ?? "clinical",
  source: "clinical",
  sudRelated: false,
  status,
  onsetAt: null,
  resolvedAt: null,
  resolutionNote: null,
  version: 1,
});

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

type PostCall = [path: string, init: { params: unknown; body: Record<string, unknown> }];

function renderEditor(problems: unknown[] = [], carePlanFails = false) {
  const post = vi.fn(async (_path: string, _init: unknown) => ok({}));
  const client = {
    GET: vi.fn(async (path: string) => {
      if (path === "/api/v1/patients/{patientId}/care-plan" && carePlanFails)
        return {
          data: undefined,
          error: { status: 500, title: "care plan down" },
          response: new Response(null, { status: 500 }),
        };
      if (path === "/api/v1/discipline-plans") return ok({ data: [planDetail], nextCursor: null });
      if (path === "/api/v1/discipline-plans/{planId}") return ok(planDetail);
      if (path === "/api/v1/patients/{patientId}/care-plan") return ok(carePlan(problems));
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

const select = async (name: string) =>
  (await screen.findByRole("combobox", { name })) as HTMLSelectElement;

describe("Aide POC editor — task form", () => {
  it("links the two frequency selects: picking the words sets the code, and picking the code sets the words", async () => {
    renderEditor();
    const words = await select("Frequency (words)");
    const coded = await select("Frequency (coded)");
    expect(words.value).toBe("");
    expect(coded.value).toBe("");

    fireEvent.change(words, { target: { value: "2:visit:week" } });
    expect(coded.value).toBe("2:visit:week");
    expect(words.selectedOptions[0]?.textContent).toBe("twice weekly");

    fireEvent.change(coded, { target: { value: "3:visit:day" } });
    expect(words.value).toBe("3:visit:day");
    expect(words.selectedOptions[0]?.textContent).toBe("three times daily");
  });

  it("posts the task as the RN discipline with the preset's words and machine-form code", async () => {
    const { post } = renderEditor();
    fireEvent.change(await screen.findByRole("textbox", { name: "New task" }), {
      target: { value: "Corporal hygiene" },
    });
    fireEvent.change(await select("Frequency (words)"), { target: { value: "2:visit:week" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0] as unknown as PostCall;
    expect(path).toBe("/api/v1/discipline-plans/{planId}/interventions");
    expect(init.body).toMatchObject({
      scopeText: "Corporal hygiene",
      frequencyText: "twice weekly",
      frequencyValue: "2:visit:week",
      discipline: "aide",
      addedByDiscipline: "rn",
    });
    await waitFor(() =>
      expect((screen.getByRole("textbox", { name: "New task" }) as HTMLInputElement).value).toBe(
        "",
      ),
    );
    expect((await select("Frequency (words)")).value).toBe("");
  });

  it("keeps Add task disabled until a task and a frequency are both chosen", async () => {
    renderEditor();
    const add = (await screen.findByRole("button", { name: "Add task" })) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "New task" }), {
      target: { value: "Corporal hygiene" },
    });
    expect(add.disabled).toBe(true);
    fireEvent.change(await select("Frequency (coded)"), { target: { value: "1:visit:day" } });
    expect(add.disabled).toBe(false);
  });
});

describe("Aide POC editor — goal form", () => {
  it("lists only the patient's active IPOC problems, by description", async () => {
    renderEditor([
      problem(ACTIVE_PROBLEM, "Impaired skin integrity", "active"),
      problem(RESOLVED_PROBLEM, "Resolved cough", "resolved"),
    ]);
    const picker = await select("IPOC problem");
    await waitFor(() => expect(within(picker).queryByText("Impaired skin integrity")).toBeTruthy());
    expect(within(picker).queryByText("Resolved cough")).toBeNull();
  });

  it("posts the chosen problem id and authors the goal as the RN discipline", async () => {
    const { post } = renderEditor([problem(ACTIVE_PROBLEM, "Impaired skin integrity", "active")]);
    const picker = await select("IPOC problem");
    await waitFor(() => expect(within(picker).queryByText("Impaired skin integrity")).toBeTruthy());
    fireEvent.change(picker, { target: { value: ACTIVE_PROBLEM } });
    fireEvent.change(screen.getByRole("textbox", { name: "Goal text" }), {
      target: { value: "Skin stays intact." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add goal" }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0] as unknown as PostCall;
    expect(path).toBe("/api/v1/discipline-plans/{planId}/goals");
    expect(init.body).toMatchObject({
      parentProblemId: ACTIVE_PROBLEM,
      originalText: "Skin stays intact.",
      addedByDiscipline: "rn",
    });
  });

  it("says there is nothing to pick when the care plan has no active problem", async () => {
    renderEditor([problem(RESOLVED_PROBLEM, "Resolved cough", "resolved")]);
    expect(await screen.findByText(/no active ipoc problems/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Add goal" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe("Aide POC editor — goal form accessibility", () => {
  it("links the explanation to the IPOC problem select, so a screen reader hears why it is empty", async () => {
    renderEditor([problem(RESOLVED_PROBLEM, "Resolved cough", "resolved")]);
    const picker = await select("IPOC problem");
    const hint = await screen.findByText(/no active ipoc problems/i);
    await waitFor(() => {
      const ids = (picker.getAttribute("aria-describedby") ?? "").split(" ");
      expect(ids).toContain(hint.id);
    });
  });

  it("shows why the problems could not be loaded, on the select itself", async () => {
    renderEditor([], true);
    const picker = await select("IPOC problem");
    expect(await screen.findByText("The IPOC problems could not be loaded.")).toBeTruthy();
    expect(picker.disabled).toBe(true);
  });

  it("tells two problems with the same description apart", async () => {
    renderEditor([
      problem(ACTIVE_PROBLEM, "Pain", "active", { kind: "terminal" }),
      problem("55555555-5555-4555-8555-555555555555", "Pain", "active", { kind: "related" }),
    ]);
    const picker = await select("IPOC problem");
    await waitFor(() =>
      expect(Array.from(picker.options).map((o) => o.textContent)).toEqual([
        "Select a problem…",
        "Pain (terminal)",
        "Pain (related)",
      ]),
    );
  });
});

describe("Aide POC editor — unsaved changes and links", () => {
  afterEach(() => vi.restoreAllMocks());

  it("asks before any in-app link, the chart rail and banner included, abandons a draft", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderEditor();
    fireEvent.change(await screen.findByRole("textbox", { name: "New task" }), {
      target: { value: "Corporal hygiene" },
    });
    fireEvent.click(screen.getByRole("link", { name: "June Rivera" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    // Declined: still on the editor.
    expect(screen.getByRole("textbox", { name: "New task" })).toBeTruthy();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("link", { name: "June Rivera" }));
    expect(confirm).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "New task" })).toBeNull());
  });

  it("does not ask when nothing has been typed", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderEditor();
    await screen.findByRole("textbox", { name: "New task" });
    fireEvent.click(screen.getByRole("link", { name: "June Rivera" }));
    expect(confirm).not.toHaveBeenCalled();
  });
});
