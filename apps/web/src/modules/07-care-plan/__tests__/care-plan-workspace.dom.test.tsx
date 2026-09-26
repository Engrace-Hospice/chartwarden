// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import type { CarePlan, Problem, Version } from "../care-plan-api";
import { CarePlanView } from "../care-plan-view";
import { CarePlanVersionHistory } from "../version-history";

const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  membershipId: "membership-1",
  displayName: "Sarah Miller",
  permissions: [
    "care_plan.read",
    "care_plan.read_summary",
    "care_plan.author",
    "care_plan.finalize",
    "care_plan.sign",
  ],
};

const patient = {
  mrn: "MRN-7",
  firstName: "June",
  lastName: "Rivera",
  dob: "1950-02-14",
  status: "active",
};

const signedInitial: Version = {
  id: "version-initial",
  planId: "plan-1",
  sequence: 1,
  kind: "initial",
  status: "signed",
  idgMeetingId: null,
  requiredSignerSet: [
    { role: "rn_case_manager", count: 1 },
    { role: "hospice_physician", count: 1 },
  ],
  signatures: [
    { signerRole: "rn_case_manager", signedAt: "2026-08-01T12:00:00.000Z" },
    { signerRole: "hospice_physician", signedAt: "2026-08-01T12:05:00.000Z" },
  ],
  draftedAt: "2026-08-01T10:00:00.000Z",
  signedAt: "2026-08-01T12:05:00.000Z",
  supersededAt: null,
  stateSnapshot: {
    problems: [
      { id: "problem-1", description: "Terminal cancer", kind: "terminal", status: "active" },
    ],
    goals: [
      {
        id: "goal-1",
        originalText: "Comfort maintained",
        revisedText: null,
        status: "in_progress",
      },
    ],
    interventions: [
      {
        id: "intervention-1",
        scopeText: "RN pain assessment",
        discipline: "rn",
        frequencyText: "Twice weekly",
        status: "active",
      },
    ],
  },
  version: 3,
};

const draftRevision: Version = {
  id: "version-draft",
  planId: "plan-1",
  sequence: 2,
  kind: "interim_revision",
  status: "draft",
  idgMeetingId: null,
  requiredSignerSet: [
    { role: "rn_case_manager", count: 1 },
    { role: "nurse_practitioner", count: 1 },
  ],
  signatures: [],
  draftedAt: "2026-08-10T10:00:00.000Z",
  signedAt: null,
  supersededAt: null,
  stateSnapshot: null,
  version: 1,
};

const idgReview: Version = {
  ...draftRevision,
  id: "version-idg",
  sequence: 3,
  kind: "idg_review",
  status: "in_review",
  idgMeetingId: "meeting-1",
  requiredSignerSet: [
    { role: "rn_case_manager", count: 1 },
    { role: "msw", count: 1 },
    { role: "chaplain", count: 1 },
    { role: "medical_director", count: 1 },
  ],
  signatures: [{ signerRole: "rn_case_manager", signedAt: "2026-08-14T12:00:00.000Z" }],
  stateSnapshot: {
    problems: [
      {
        id: "problem-1",
        description: "IDG-updated terminal cancer",
        kind: "terminal",
        status: "active",
      },
    ],
    goals: [],
    interventions: [],
  },
  version: 2,
};

function planWith(
  versions: Version[] = [signedInitial],
  problems: Problem[] = baseProblems(),
): CarePlan {
  return {
    id: "plan-1",
    patientId: "patient-1",
    admissionId: "admission-1",
    status: "active",
    activeVersionId: "version-initial",
    version: 8,
    versions,
    problems,
    goals: [
      {
        id: "goal-1",
        planId: "plan-1",
        problemId: "problem-1",
        originalText: "Comfort maintained",
        revisedText: null,
        source: "clinical",
        actingConsentId: null,
        measurableOutcome: "Pain at acceptable level",
        targetAt: "2026-08-30T00:00:00.000Z",
        status: "in_progress",
        statusNote: null,
        version: 1,
      },
    ],
    interventions: [
      {
        id: "intervention-1",
        planId: "plan-1",
        problemId: "problem-1",
        goalRefs: ["goal-1"],
        scopeText: "RN pain assessment",
        frequencyText: "Twice weekly",
        frequencyValue: "2/wk",
        discipline: "rn",
        responsibleRole: "RN",
        linkedOrderId: null,
        status: "active",
        discontinueReason: null,
        version: 1,
      },
    ],
    redacted: false,
  };
}

function baseProblems(): Problem[] {
  return [
    {
      id: "problem-1",
      planId: "plan-1",
      icd10Code: "C80.1",
      snomedCode: null,
      description: "Terminal cancer",
      kind: "terminal",
      source: "clinical",
      sudRelated: false,
      status: "active",
      onsetAt: "2026-08-01T00:00:00.000Z",
      resolvedAt: null,
      resolutionNote: null,
      version: 1,
    },
  ];
}

function ok(data: unknown) {
  return { data, error: undefined, response: new Response(null, { status: 200 }) };
}

function clientFor(
  input: {
    plan?: unknown;
    readiness?: unknown;
    review?: unknown;
    proposed?: unknown;
    versions?: unknown[];
    version?: unknown;
  } = {},
): ApiClient {
  return {
    GET: vi.fn(async (path: string) => {
      if (path === "/api/v1/patients/{patientId}/care-plan") return ok(input.plan ?? planWith());
      if (path === "/api/v1/patients/{id}") return ok(patient);
      if (path === "/api/v1/care-plans/{planId}/readiness")
        return ok(
          input.readiness ?? {
            planId: "plan-1",
            openVersionId: null,
            canFinalize: false,
            canSign: false,
            blockers: [],
            signatures: { required: [], collected: [], missing: [] },
          },
        );
      if (path === "/api/v1/care-plans/{planId}/review-status")
        return ok(
          input.review ?? {
            planId: "plan-1",
            nextReviewDueAt: "2026-08-20T00:00:00.000Z",
            status: "due",
            overdueByDays: 0,
            openReviewVersionId: null,
            openReviewVersionStatus: null,
            canStartReview: true,
          },
        );
      if (path === "/api/v1/care-plans/{planId}/versions/{versionId}/proposed-changes")
        return ok(
          input.proposed ?? {
            versionId: "version-idg",
            kind: "idg_review",
            meetingId: "meeting-1",
            status: "in_review",
            proposals: [],
            changes: [],
          },
        );
      if (path === "/api/v1/care-plans/{planId}/versions")
        return ok({ items: input.versions ?? [signedInitial], nextCursor: null });
      if (path === "/api/v1/care-plans/{planId}/versions/{versionId}")
        return ok(input.version ?? signedInitial);
      return ok({});
    }),
    POST: vi.fn(async () => ok({ id: "created", version: 2 })),
    PATCH: vi.fn(async () => ok({ id: "patched", version: 2 })),
  } as unknown as ApiClient;
}

function renderWorkspace(client: ApiClient): void {
  render(
    <MemoryRouter initialEntries={["/patients/patient-1/care-plan"]}>
      <ApiClientProvider client={client}>
        <SessionProvider session={session}>
          <Routes>
            <Route path="/patients/:patientId/care-plan" element={<CarePlanView />} />
          </Routes>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("M7 Care Plan workspace", () => {
  it("renders patient context, backend readiness, review attention, and current content", async () => {
    const [firstProblem] = baseProblems();
    const client = clientFor({
      plan: planWith([signedInitial], [{ ...firstProblem!, kind: "related" }]),
      readiness: {
        planId: "plan-1",
        openVersionId: "version-draft",
        canFinalize: false,
        canSign: false,
        blockers: [
          { code: "TERMINAL_PROBLEM_REQUIRED", message: "Active terminal problem required" },
        ],
        signatures: { required: [], collected: [], missing: [] },
      },
    });
    renderWorkspace(client);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Plan of Care" })).toBeTruthy(),
    );
    expect(screen.getAllByText("June Rivera").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Active terminal problem required/).length).toBeGreaterThan(0);
    expect(screen.getByText("Care Plan review is due.")).toBeTruthy();
    expect(screen.getByText("Comfort maintained")).toBeTruthy();
  });

  it("posts problem authoring through the M7 write API", async () => {
    const client = clientFor({ plan: planWith([signedInitial, draftRevision]) });
    renderWorkspace(client);

    await screen.findByRole("heading", { name: "Plan of Care" });
    fireEvent.click(screen.getByRole("button", { name: "Add problem" }));
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Dyspnea at rest" },
    });
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "related" } });
    fireEvent.click(screen.getByRole("button", { name: "Save problem" }));

    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith(
        "/api/v1/care-plans/{planId}/problems",
        expect.objectContaining({
          params: { path: { planId: "plan-1" } },
          body: expect.objectContaining({ description: "Dyspnea at rest", kind: "related" }),
        }),
      ),
    );
  });

  it("posts goal and intervention authoring without creating downstream orders or visits", async () => {
    const client = clientFor({ plan: planWith([signedInitial, draftRevision]) });
    renderWorkspace(client);

    await screen.findByRole("heading", { name: "Plan of Care" });
    fireEvent.click(screen.getByRole("tab", { name: "Revision / Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Add goal" }));
    fireEvent.change(screen.getByLabelText("Goal text"), {
      target: { value: "Patient remains comfortable at rest" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save goal" }));
    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith(
        "/api/v1/care-plans/{planId}/goals",
        expect.objectContaining({
          body: expect.objectContaining({ originalText: "Patient remains comfortable at rest" }),
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add intervention" }));
    fireEvent.change(screen.getByLabelText("Intervention / scope"), {
      target: { value: "Teach family comfort positioning" },
    });
    fireEvent.change(screen.getByLabelText("Frequency text"), { target: { value: "Every visit" } });
    fireEvent.change(screen.getByLabelText("Frequency value"), { target: { value: "1/visit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save intervention" }));

    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith(
        "/api/v1/care-plans/{planId}/interventions",
        expect.objectContaining({
          body: expect.objectContaining({
            scopeText: "Teach family comfort positioning",
            frequencyText: "Every visit",
          }),
        }),
      ),
    );
    expect(client.POST).not.toHaveBeenCalledWith(
      expect.stringContaining("/orders"),
      expect.anything(),
    );
    expect(client.POST).not.toHaveBeenCalledWith(
      expect.stringContaining("/visits"),
      expect.anything(),
    );
  });

  it("finalizes a backend-ready draft and surfaces missing signatures", async () => {
    const client = clientFor({
      plan: planWith([signedInitial, draftRevision]),
      readiness: {
        planId: "plan-1",
        openVersionId: "version-draft",
        openVersionStatus: "draft",
        canFinalize: true,
        canSign: false,
        blockers: [],
        signatures: {
          required: draftRevision.requiredSignerSet,
          collected: [],
          missing: draftRevision.requiredSignerSet,
        },
      },
    });
    renderWorkspace(client);

    await screen.findByRole("heading", { name: "Plan of Care" });
    fireEvent.click(screen.getByRole("tab", { name: "Revision / Review" }));
    expect(screen.getAllByText(/Nurse Practitioner/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Review & send for signatures" }));

    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith(
        "/api/v1/care-plans/{planId}/versions/{versionId}/finalize",
        expect.objectContaining({ body: { ifVersion: 1 } }),
      ),
    );
  });

  it("shows governed IDG changes as proposed and signs through authenticated backend path", async () => {
    const client = clientFor({
      plan: planWith([signedInitial, idgReview]),
      readiness: {
        planId: "plan-1",
        openVersionId: "version-idg",
        openVersionStatus: "in_review",
        canFinalize: false,
        canSign: true,
        blockers: [],
        signatures: {
          required: idgReview.requiredSignerSet,
          collected: idgReview.signatures,
          missing: [{ role: "msw", count: 1 }],
        },
      },
      proposed: {
        versionId: "version-idg",
        kind: "idg_review",
        meetingId: "meeting-1",
        status: "in_review",
        proposals: [],
        changes: [
          {
            id: "change-1",
            proposalId: "proposal-1",
            decisionId: "decision-1",
            entityType: "problem",
            operation: "problem_update",
            targetId: "problem-1",
            before: { description: "Terminal cancer" },
            proposed: { description: "IDG-updated terminal cancer" },
            status: "proposed",
          },
        ],
      },
    });
    renderWorkspace(client);

    await screen.findByRole("heading", { name: "Plan of Care" });
    fireEvent.click(screen.getByRole("tab", { name: "Revision / Review" }));
    expect(screen.getByText("IDG proposed changes")).toBeTruthy();
    expect(screen.getByText("Terminal cancer")).toBeTruthy();
    expect(screen.getAllByText("IDG-updated terminal cancer").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Sign" }));
    fireEvent.change(screen.getByLabelText("Signing role"), { target: { value: "msw" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign version" }));

    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith(
        "/api/v1/care-plans/{planId}/versions/{versionId}/signatures",
        expect.objectContaining({ body: expect.objectContaining({ signerRole: "msw" }) }),
      ),
    );
  });
});

describe("M7 Care Plan version history", () => {
  it("opens a historical immutable snapshot and handles legacy absence honestly", async () => {
    const legacy = { ...signedInitial, id: "legacy-version", sequence: 0, stateSnapshot: null };
    const client = clientFor({ versions: [signedInitial, legacy], version: legacy });
    render(
      <MemoryRouter initialEntries={["/care-plans/plan-1/versions/legacy-version"]}>
        <ApiClientProvider client={client}>
          <SessionProvider session={session}>
            <Routes>
              <Route
                path="/care-plans/:planId/versions/:versionId"
                element={<CarePlanVersionHistory />}
              />
            </Routes>
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { name: "Care Plan Version History" });
    fireEvent.click(screen.getByRole("button", { name: /v0/ }));
    await waitFor(() =>
      expect(
        screen.getByText("Detailed historical snapshot unavailable for this legacy version."),
      ).toBeTruthy(),
    );
  });
});
