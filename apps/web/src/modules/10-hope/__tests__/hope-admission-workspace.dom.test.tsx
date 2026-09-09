// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { ApiClientProvider } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { HopeAssessmentDetail } from "../hope-assessment-detail";

const assessment = {
  id: "hope-1",
  admissionId: "adm-1",
  patientId: "patient-1",
  rfaKind: "01_admission",
  status: "draft",
  targetDate: "2026-09-08T00:00:00.000Z",
  authorDiscipline: "RN",
  j2051MaxSeverity: null,
  j2051TriggerFired: false,
  wasLate: false,
  signedAt: null,
  signedBy: null,
  correctsAssessmentId: null,
  supersededByAssessmentId: null,
  snapshot: null,
  regulatory: { specVersionId: "spec-1", isc: "HA" },
  version: 4,
};

const patient = {
  mrn: "MRN-123456",
  firstName: "Ada",
  lastName: "Lovelace",
  dob: "1950-01-01",
  status: "active",
};

function item(overrides: Record<string, unknown>) {
  return {
    itemCode: "A0500A",
    label: "First name",
    section: "A",
    group: null,
    kind: "assessment",
    active: true,
    state: "unanswered",
    value: null,
    source: null,
    answeredAt: null,
    answeredByMembershipId: null,
    applicability: "applicable",
    skipReason: null,
    options: [],
    ...overrides,
  };
}

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    assessment: {
      id: "hope-1",
      status: "draft",
      rfaKind: "01_admission",
      targetDate: "2026-09-08T00:00:00.000Z",
      isc: "HA",
      specVersionId: "spec-1",
      specVersion: "1.00.1",
      version: 4,
    },
    sections: [
      {
        code: "A",
        label: "Administrative",
        items: [
          item({
            itemCode: "A0220",
            label: "Admission date",
            value: "2026-09-08",
            source: "admission_prefill",
          }),
          item({
            itemCode: "A0500A",
            label: "First name",
            value: "Ada",
            source: "patient_prefill",
            state: "answered",
          }),
          item({
            itemCode: "A0500B",
            label: "Patient middle initial",
            cmsItemTypeCode: "Text",
            maxLength: 1,
            options: [
              { valueCode: "Text", label: "Patient middle initial", sortOrder: 1 },
              { valueCode: "^", label: "Blank", sortOrder: 2 },
            ],
          }),
        ],
      },
      {
        code: "F",
        label: "Preferences",
        items: [
          item({
            itemCode: "F2000A",
            label: "Was CPR discussed?",
            section: "F",
            options: [
              { valueCode: "0", label: "No", sortOrder: 1 },
              {
                valueCode: "1",
                label: "Yes, discussion occurred",
                sortOrder: 2,
              },
            ],
          }),
          item({
            itemCode: "F2000B",
            label: "CPR discussion date",
            section: "F",
            applicability: "not_applicable",
          }),
        ],
      },
      {
        code: "J",
        label: "Health Conditions",
        items: [
          item({
            itemCode: "J2051A",
            label: "Pain impact",
            section: "J",
            group: "Symptom impact",
            applicability: "pending",
          }),
        ],
      },
    ],
    progress: {
      active: 4,
      applicable: 3,
      notApplicable: 1,
      pending: 1,
      answered: 1,
      skipped: 1,
      unanswered: 2,
    },
    ...overrides,
  };
}

function review(overrides: Record<string, unknown> = {}) {
  return {
    assessmentId: "hope-1",
    version: 4,
    specVersion: "1.00.1",
    isc: "HA",
    status: "draft",
    signedAt: null,
    signedByMembershipId: null,
    z0500b: null,
    sections: [
      {
        code: "A",
        active: 2,
        applicable: 2,
        answered: 2,
        skipped: 0,
        pending: 0,
        unanswered: 0,
        errors: 0,
        warnings: 0,
        state: "complete",
      },
      {
        code: "F",
        active: 2,
        applicable: 1,
        answered: 0,
        skipped: 1,
        pending: 0,
        unanswered: 1,
        errors: 1,
        warnings: 0,
        state: "blocked",
      },
      {
        code: "J",
        active: 1,
        applicable: 0,
        answered: 0,
        skipped: 0,
        pending: 1,
        unanswered: 0,
        errors: 0,
        warnings: 0,
        state: "blocked",
      },
    ],
    progress: {
      active: 5,
      applicable: 3,
      answered: 2,
      skipped: 1,
      pending: 1,
      unanswered: 2,
    },
    validation: {
      errorCount: 1,
      warningCount: 1,
      hasBlockingErrors: true,
      findings: [
        {
          ruleId: "-3060",
          severity: "error",
          section: "F",
          itemCode: "F2000A",
          message: "CPR discussion response is required.",
        },
      ],
    },
    sfv: { required: null },
    readiness: {
      readyToSign: false,
      blockers: [
        {
          code: "PENDING_APPLICABILITY",
          section: "J",
          itemCode: "J2051A",
          message: "J2051 branch is incomplete.",
        },
      ],
    },
    ...overrides,
  };
}

function ok(data: unknown) {
  return {
    data,
    error: undefined,
    response: new Response(null, { status: 200 }),
  };
}

function err(message: string) {
  return {
    data: undefined,
    error: { message },
    response: new Response(null, { status: 409 }),
  };
}

function clientFor(
  input: { workspace?: unknown; review?: unknown; patchError?: string } = {},
): ApiClient {
  return {
    GET: vi.fn(async (path: string) => {
      if (path.includes("/workspace"))
        return ok(input.workspace ?? workspace());
      if (path.includes("/review")) return ok(input.review ?? review());
      if (path.includes("/patients/{patientId}/hope/assessments"))
        return ok({ assessments: [assessment] });
      if (path.includes("/patients/{id}")) return ok(patient);
      return ok(assessment);
    }),
    PATCH: vi.fn(async () =>
      input.patchError
        ? err(input.patchError)
        : ok({ assessmentId: "hope-1", version: 5, answers: [] }),
    ),
    POST: vi.fn(async () =>
      ok({
        assessmentId: "hope-1",
        status: "signed",
        version: 5,
        signedAt: "2026-09-08T14:00:00.000Z",
        signedByMembershipId: "rn-1",
        z0500b: "2026-09-08",
        validation: {
          errorCount: 0,
          warningCount: 1,
          hasBlockingErrors: false,
        },
      }),
    ),
  } as unknown as ApiClient;
}

function renderWorkspace(client: ApiClient): void {
  render(
    <MemoryRouter initialEntries={["/hope/assessments/hope-1"]}>
      <ApiClientProvider client={client}>
        <Routes>
          <Route
            path="/hope/assessments/:id"
            element={<HopeAssessmentDetail />}
          />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("Admission HOPE workspace", () => {
  it("renders backend-driven section navigation, prefill badges, and applicability states", async () => {
    renderWorkspace(clientFor());
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Admission Workspace" }),
      ).toBeTruthy(),
    );

    expect(
      screen.getByRole("button", { name: /A Administrative/ }),
    ).toBeTruthy();
    expect(screen.getByText("From admission")).toBeTruthy();
    expect(screen.getByText("From patient chart")).toBeTruthy();
    const middleInitial = screen.queryByLabelText("Patient middle initial") as HTMLInputElement;
    expect(middleInitial).toBeTruthy();
    expect(middleInitial.maxLength).toBe(1);
    expect(middleInitial.type).toBe("text");

    fireEvent.click(screen.getByRole("button", { name: /F Preferences/ }));
    expect(screen.getByText("Skipped")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: /J Health Conditions/ }),
    );
    expect(
      screen.getByText(
        "This item is conditionally required and will open when the related answer is saved.",
      ),
    ).toBeTruthy();
  });

  it("autosaves editable answers with the backend workspace version", async () => {
    const client = clientFor();
    renderWorkspace(client);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Admission Workspace" }),
      ).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: /F Preferences/ }));
    fireEvent.click(screen.getByLabelText("Yes, discussion occurred"));

    await waitFor(() => expect(client.PATCH).toHaveBeenCalled());
    expect(client.PATCH).toHaveBeenCalledWith(
      "/api/v1/hope/assessments/{id}/answers",
      expect.objectContaining({
        body: {
          ifVersion: 4,
          changes: [{ itemCode: "F2000A", action: "set", value: "1" }],
        },
      }),
    );
  });

  it("serializes the CMS caret option as a clear patch instead of value '^'", async () => {
    const client = clientFor({
      workspace: workspace({
        sections: [
          {
            code: "A",
            label: "Administrative",
            items: [
              item({
                itemCode: "A0100A",
                label: "Provider name",
                options: [
                  {
                    valueCode: "^",
                    label: "Not assessed / skipped",
                    sortOrder: 1,
                  },
                  { valueCode: "1", label: "Hospice provider", sortOrder: 2 },
                ],
              }),
            ],
          },
        ],
      }),
    });
    renderWorkspace(client);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Admission Workspace" }),
      ).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText("Not assessed / skipped"));

    await waitFor(() => expect(client.PATCH).toHaveBeenCalled());
    expect(client.PATCH).toHaveBeenCalledWith(
      "/api/v1/hope/assessments/{id}/answers",
      expect.objectContaining({
        body: {
          ifVersion: 4,
          changes: [{ itemCode: "A0100A", action: "clear" }],
        },
      }),
    );
  });

  it("shows a reload path on optimistic concurrency conflict", async () => {
    renderWorkspace(clientFor({ patchError: "version is stale" }));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Admission Workspace" }),
      ).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: /F Preferences/ }));
    fireEvent.click(screen.getByLabelText("Yes, discussion occurred"));

    await waitFor(() =>
      expect(
        screen.getAllByText(
          "This assessment changed elsewhere. Reload the latest version before continuing.",
        ).length,
      ).toBeGreaterThan(0),
    );
    expect(
      screen.getByRole("button", { name: "Reload assessment" }),
    ).toBeTruthy();
  });

  it("uses backend readiness for Review and Sign", async () => {
    const client = clientFor({
      review: review({
        validation: {
          errorCount: 0,
          warningCount: 1,
          hasBlockingErrors: false,
          findings: [],
        },
        readiness: { readyToSign: true, blockers: [] },
      }),
    });
    renderWorkspace(client);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Admission Workspace" }),
      ).toBeTruthy(),
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: "Sign & complete" })[0]!,
    );
    const dialog = screen.getByRole("dialog", {
      name: "Complete Admission",
    });
    expect(dialog).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Sign & complete" }),
    );

    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith(
        "/api/v1/hope/assessments/{id}/sign",
        expect.objectContaining({ body: { ifVersion: 4 } }),
      ),
    );
  });
});
