// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  input: {
    workspace?: unknown;
    review?: unknown;
    assessment?: unknown;
    patchError?: string;
    identifiers?: unknown[];
    payers?: unknown[];
    timeline?: unknown[];
  } = {},
): ApiClient {
  return {
    GET: vi.fn(async (path: string) => {
      if (path.includes("/workspace")) return ok(input.workspace ?? workspace());
      if (path.endsWith("/identifiers")) return ok({ identifiers: input.identifiers ?? [] });
      if (path.endsWith("/payers")) return ok({ payers: input.payers ?? [] });
      if (path.includes("/review")) return ok(input.review ?? review());
      if (path.includes("/patients/{patientId}/hope/assessments"))
        return ok({ assessments: input.timeline ?? [assessment] });
      if (path.includes("/patients/{id}")) return ok(patient);
      return ok(input.assessment ?? assessment);
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
          <Route path="/hope/assessments/:id" element={<HopeAssessmentDetail />} />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("Admission HOPE workspace", () => {
  beforeEach(() => {
    // In-memory storage: the nav-mode choice and visited groups persist through localStorage.
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    });
  });

  it("renders backend-driven section navigation, prefill badges, and applicability states", async () => {
    renderWorkspace(clientFor());
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Workspace" })).toBeTruthy(),
    );

    expect(screen.getByRole("button", { name: /A Administrative/ })).toBeTruthy();
    expect(screen.getByText("From admission")).toBeTruthy();
    // Guided mode shows one group at a time; the rail's sub-steps open the next one.
    fireEvent.click(screen.getByRole("button", { name: /^Patient Identity/ }));
    expect(screen.getByText("From patient chart")).toBeTruthy();
    const middleInitial = screen.queryByLabelText(/^Patient middle initial/) as HTMLInputElement;
    expect(middleInitial).toBeTruthy();
    expect(middleInitial.maxLength).toBe(1);
    expect(middleInitial.type).toBe("text");

    fireEvent.click(screen.getByRole("button", { name: /F Preferences/ }));
    expect(screen.getByText("Skipped")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /J Health Conditions/ }));
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
      expect(screen.getByRole("heading", { name: "Admission Workspace" })).toBeTruthy(),
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

  it("serializes the CMS caret option as its own explicit answer value '^', not a clear", async () => {
    const client = clientFor({
      workspace: workspace({
        sections: [
          {
            code: "A",
            label: "Administrative",
            items: [
              item({
                itemCode: "A1005",
                label: "Ethnicity",
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
      expect(screen.getByRole("heading", { name: "Admission Workspace" })).toBeTruthy(),
    );

    fireEvent.change(screen.getByLabelText(/^Ethnicity/), { target: { value: "^" } });

    await waitFor(() => expect(client.PATCH).toHaveBeenCalled());
    // The caret ("^", CMS "Dash — item not assessed") is a real, explicit HOPE answer code, distinct
    // from clearing the item entirely — the serializer only sends `action: "clear"` for `null`/`""`
    // (`hope-assessment-detail.tsx`'s `onCommit`), so selecting it PATCHes `action: "set", value: "^"`
    // like any other option, rather than clearing the answer.
    expect(client.PATCH).toHaveBeenCalledWith(
      "/api/v1/hope/assessments/{id}/answers",
      expect.objectContaining({
        body: {
          ifVersion: 4,
          changes: [{ itemCode: "A1005", action: "set", value: "^" }],
        },
      }),
    );
  });

  it("shows a reload path on optimistic concurrency conflict", async () => {
    renderWorkspace(clientFor({ patchError: "version is stale" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Workspace" })).toBeTruthy(),
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
    expect(screen.getByRole("button", { name: "Reload assessment" })).toBeTruthy();
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
      expect(screen.getByRole("heading", { name: "Admission Workspace" })).toBeTruthy(),
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Sign & complete" })[0]!);
    const dialog = screen.getByRole("dialog", {
      name: "Complete Admission",
    });
    expect(dialog).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign & complete" }));

    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith(
        "/api/v1/hope/assessments/{id}/sign",
        expect.objectContaining({ body: { ifVersion: 4 } }),
      ),
    );
  });

  it("marks Review complete for a completed HOPE assessment", async () => {
    const client = clientFor({
      assessment: {
        ...assessment,
        status: "signed",
        signedAt: "2026-09-08T14:00:00.000Z",
      },
    });
    renderWorkspace(client);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Review — Completed" })).toBeTruthy(),
    );
  });
  it("guides one group at a time with Back / Next naming the destination", async () => {
    renderWorkspace(clientFor());
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Workspace" })).toBeTruthy(),
    );
    expect(screen.getByText("Step 1 of 2")).toBeTruthy();
    expect(screen.queryByLabelText(/^Patient middle initial/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Next: Patient Identity/ }));
    expect(screen.getByLabelText(/^Patient middle initial/)).toBeTruthy();
    expect(screen.getByText("Step 2 of 2")).toBeTruthy();

    // The last group of A continues into the next section.
    fireEvent.click(screen.getByRole("button", { name: /Next: F\. Preferences/ }));
    expect(screen.getByRole("heading", { name: "F. Preferences & Goals" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Back: A\. Administrative/ }));
    expect(screen.getByLabelText(/^Patient middle initial/)).toBeTruthy();
  });

  it("Show all renders every section on one page and remembers the choice", async () => {
    renderWorkspace(clientFor());
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Workspace" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("switch", { name: /Show all/ }));

    expect(screen.getByRole("heading", { name: "All sections" })).toBeTruthy();
    expect(screen.getByText("From admission")).toBeTruthy();
    expect(screen.getByText("From patient chart")).toBeTruthy();
    expect(screen.getByLabelText("Yes, discussion occurred")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Jump to section" })).toBeTruthy();
    expect(window.localStorage.getItem("wx.hope.navMode")).toBe("all");
  });

  it("holds back 'required' errors until the user has moved past the group", async () => {
    const base = review();
    const client = clientFor({
      workspace: workspace({
        sections: [
          {
            code: "A",
            label: "Administrative",
            items: [
              item({ itemCode: "A0500A", label: "First name", value: "Ada", state: "answered" }),
              item({
                itemCode: "A1805",
                label: "Admitted from",
                options: [{ valueCode: "01", label: "Home", sortOrder: 1 }],
              }),
            ],
          },
        ],
      }),
      review: {
        ...base,
        validation: {
          ...base.validation,
          findings: [
            {
              ruleId: "CMS-HOPE-REQUIRED",
              severity: "error",
              section: "A",
              itemCode: "A1805",
              message: "A1805 is required for final HOPE validation.",
            },
          ],
        },
      },
    });
    renderWorkspace(client);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Workspace" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Living Situation/ }));
    expect(screen.queryByText("A1805 is required for final HOPE validation.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Back: Patient Identity/ }));
    fireEvent.click(screen.getByRole("button", { name: /Next: Living Situation/ }));
    expect(screen.getByText("A1805 is required for final HOPE validation.")).toBeTruthy();
  });

  it("greys out choices a selected exclusive option rules out", async () => {
    const tile = (itemCode: string, label: string, value: string | null) =>
      item({
        itemCode,
        label,
        value,
        state: value ? "answered" : "unanswered",
        options: [
          { valueCode: "0", label: "Not checked", sortOrder: 1 },
          { valueCode: "1", label: "Checked", sortOrder: 2 },
        ],
      });
    const client = clientFor({
      workspace: workspace({
        sections: [
          {
            code: "A",
            label: "Administrative",
            items: [
              tile("A1010A", "White", "0"),
              tile("A1010B", "Black or African American", "0"),
              tile("A1010Z", "None of the above", "1"),
              item({
                itemCode: "A0700",
                label: "Patient Medicaid number",
                cmsItemTypeCode: "Text",
                value: "N",
                state: "answered",
                options: [
                  { valueCode: "Text", label: "Medicaid number", sortOrder: 1 },
                  { valueCode: "+", label: "Pending", sortOrder: 2 },
                  { valueCode: "N", label: "Not a Medicaid recipient", sortOrder: 3 },
                ],
              }),
            ],
          },
        ],
      }),
    });
    renderWorkspace(client);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Workspace" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("switch", { name: /Show all/ }));

    expect((screen.getByRole("checkbox", { name: /White/ }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole("checkbox", { name: /None of the above/ }) as HTMLInputElement).disabled,
    ).toBe(false);
    // A special value ("N") greys out the typed-value box; the others stay selectable.
    expect((screen.getByLabelText(/^Patient Medicaid number/) as HTMLInputElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByLabelText("Not a Medicaid recipient"));
    await waitFor(() => expect(client.PATCH).toHaveBeenCalled());
    expect(client.PATCH).toHaveBeenCalledWith(
      "/api/v1/hope/assessments/{id}/answers",
      expect.objectContaining({
        body: { ifVersion: 4, changes: [{ itemCode: "A0700", action: "clear" }] },
      }),
    );
  });
  it("steps through the SFV reassessment one question at a time", async () => {
    const sfvItem = (itemCode: string, label: string) =>
      item({ itemCode, label, section: "J", group: "Symptom Follow-Up Visit" });
    const client = clientFor({
      workspace: workspace({
        sections: [
          {
            code: "J",
            label: "Health Conditions",
            items: [
              item({
                itemCode: "J2052A",
                label: "SFV completed",
                section: "J",
                group: "Symptom Follow-Up Visit",
              }),
              sfvItem("J2053A", "Impact of pain"),
              sfvItem("J2053B", "Impact of shortness of breath"),
            ],
          },
        ],
      }),
    });
    renderWorkspace(client);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Workspace" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Complete SFV" }));
    const dialog = screen.getByRole("dialog", { name: "Complete SFV" });
    expect(within(dialog).getByText("Question 1 of 2")).toBeTruthy();
    expect(within(dialog).queryByText("Impact of shortness of breath")).toBeNull();

    fireEvent.click(within(dialog).getByRole("radio", { name: "Mild" }));
    await waitFor(() => expect(within(dialog).getByText("Question 2 of 2")).toBeTruthy());
    expect(within(dialog).getByText("Impact of shortness of breath")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("switch", { name: /Show all/ }));
    expect(within(dialog).getByText("Impact of pain")).toBeTruthy();
    expect(within(dialog).getByText("Impact of shortness of breath")).toBeTruthy();
  });
  it("renders CMS check-all items with a skip-pattern value as checkboxes, labels without the shared prefix", async () => {
    const painItem = (itemCode: string, label: string) =>
      item({
        itemCode,
        label,
        section: "J",
        group: "Pain",
        options: [
          { valueCode: "0", label: "Not checked (No)", sortOrder: 1 },
          { valueCode: "1", label: "Checked (Yes)", sortOrder: 2 },
          { valueCode: "^", label: "Blank (skip pattern)", sortOrder: 3 },
        ],
      });
    const client = clientFor({
      workspace: workspace({
        sections: [
          {
            code: "J",
            label: "Health Conditions",
            items: [
              painItem("J0910C1", "Pain asmt included: location"),
              painItem("J0910C2", "Pain asmt included: severity"),
              painItem("J0910C9", "Pain asmt included: none of the above"),
            ],
          },
        ],
      }),
    });
    renderWorkspace(client);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Workspace" })).toBeTruthy(),
    );
    const group = screen.getByRole("group", { name: /^Pain assessment included/ });
    expect(within(group).getAllByRole("checkbox")).toHaveLength(3);
    expect(within(group).getByRole("checkbox", { name: /^Location/ })).toBeTruthy();
    expect(screen.queryByText("Not checked (No)")).toBeNull();
    expect(screen.queryByText(/Pain asmt included/)).toBeNull();
  });
  describe("A0600B Medicare number vs the patient's chart", () => {
    const medicareWorkspace = (value: string, source = "user") =>
      workspace({
        sections: [
          {
            code: "A",
            label: "Administrative",
            items: [
              item({
                itemCode: "A0600B",
                label: "Patient Medicare number",
                cmsItemTypeCode: "Text",
                value,
                source,
                state: "answered",
                options: [{ valueCode: "Text", label: "Medicare number", sortOrder: 1 }],
              }),
            ],
          },
        ],
      });
    const medicarePayer = (subscriberId: string) => ({
      coverageKind: "medicare_ffs",
      subscriberId,
      rank: 1,
      current: true,
    });

    it("shows the Medicare coverage number in Patient Summary when the chart has no MBI identifier", async () => {
      renderWorkspace(
        clientFor({
          workspace: medicareWorkspace("1EG4TE5MK73"),
          payers: [medicarePayer("1EG4-TE5-MK73")],
        }),
      );
      await waitFor(() => expect(screen.getByText("...MK73")).toBeTruthy());
      // Same number (separators ignored): no chart note.
      expect(screen.queryByText(/Not on the patient's chart/)).toBeNull();
      expect(screen.queryByText(/Differs from the chart/)).toBeNull();
    });

    it("flags a typed number the chart does not have and offers to add it as coverage", async () => {
      renderWorkspace(clientFor({ workspace: medicareWorkspace("1EG4TE5MK73") }));
      await waitFor(() => expect(screen.getByText(/Not on the patient's chart/)).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Reconcile…" }));
      const dialog = screen.getByRole("dialog", { name: "Reconcile Medicare number" });
      expect(within(dialog).getByText("Add it to the patient's chart")).toBeTruthy();
      // A payer must be chosen before the coverage can be filed.
      expect(
        (within(dialog).getByRole("button", { name: "Add to chart" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    });

    it("warns when the typed number differs from the chart's", async () => {
      renderWorkspace(
        clientFor({
          workspace: medicareWorkspace("1EG4TE5MK73"),
          identifiers: [{ kind: "mbi", value: "9AA9AA9AA99", last4: "AA99", effectiveTo: null }],
        }),
      );
      await waitFor(() => expect(screen.getByText(/Differs from the chart/)).toBeTruthy());
      expect(screen.getByText(/Differs from the chart \(…AA99\)/)).toBeTruthy();
    });

    it("adds no note when the value came from the chart itself", async () => {
      renderWorkspace(
        clientFor({ workspace: medicareWorkspace("1EG4TE5MK73", "patient_prefill") }),
      );
      await waitFor(() =>
        expect(screen.getByRole("heading", { name: "Admission Workspace" })).toBeTruthy(),
      );
      expect(screen.queryByText(/Not on the patient's chart/)).toBeNull();
    });
  });
  describe("A0600A SSN (CMS format edits)", () => {
    const ssnWorkspace = () =>
      workspace({
        sections: [
          {
            code: "A",
            label: "Administrative",
            items: [
              item({
                itemCode: "A0600A",
                label: "Social Security Number",
                cmsItemTypeCode: "Text",
                maxLength: 9,
                options: [
                  { valueCode: "Text", label: "Patient social security number", sortOrder: 1 },
                  { valueCode: "^", label: "Blank (not available or unknown)", sortOrder: 2 },
                ],
              }),
            ],
          },
        ],
      });

    it("saves a dashed SSN as the 9 bare digits CMS expects", async () => {
      const client = clientFor({ workspace: ssnWorkspace() });
      renderWorkspace(client);
      const box = (await screen.findByLabelText(/^Social Security Number/)) as HTMLInputElement;
      fireEvent.change(box, { target: { value: "909-67-3453" } });
      fireEvent.blur(box);
      await waitFor(() =>
        expect(client.PATCH).toHaveBeenCalledWith(
          "/api/v1/hope/assessments/{id}/answers",
          expect.objectContaining({
            body: {
              ifVersion: 4,
              changes: [{ itemCode: "A0600A", action: "set", value: "909673453" }],
            },
          }),
        ),
      );
    });

    it("flags an SSN CMS would reject while it is typed", async () => {
      renderWorkspace(clientFor({ workspace: ssnWorkspace() }));
      const box = await screen.findByLabelText(/^Social Security Number/);
      fireEvent.change(box, { target: { value: "000123456" } });
      expect(screen.getByText(/SSN cannot start with 000\. \(CMS edit -3002\)/)).toBeTruthy();
      fireEvent.change(box, { target: { value: "123456789" } });
      expect(screen.getByText(/placeholder CMS rejects/)).toBeTruthy();
    });
  });
  describe("Reconciling A0600B with the chart", () => {
    const workspaceWith = (value: string, source = "user") =>
      workspace({
        sections: [
          {
            code: "A",
            label: "Administrative",
            items: [
              item({
                itemCode: "A0600B",
                label: "Patient Medicare number",
                cmsItemTypeCode: "Text",
                value,
                source,
                state: "answered",
                options: [{ valueCode: "Text", label: "Medicare number", sortOrder: 1 }],
              }),
            ],
          },
        ],
      });
    const coverage = {
      id: "pp-1",
      payerId: "payer-cms",
      rank: 1,
      coverageKind: "medicare_ffs",
      subscriberId: "9AA9AA9AA99",
      groupNumber: null,
      binPcn: null,
      current: true,
      effectiveFrom: "2026-10-04",
      effectiveTo: null,
    };

    it("uses the chart's number in HOPE", async () => {
      const client = clientFor({ workspace: workspaceWith("1EG4TE5MK73"), payers: [coverage] });
      renderWorkspace(client);
      fireEvent.click(await screen.findByRole("button", { name: "Reconcile…" }));
      fireEvent.click(screen.getByRole("button", { name: "Use the chart's number in HOPE" }));
      await waitFor(() =>
        expect(client.PATCH).toHaveBeenCalledWith(
          "/api/v1/hope/assessments/{id}/answers",
          expect.objectContaining({
            body: {
              ifVersion: 4,
              changes: [{ itemCode: "A0600B", action: "set", value: "9AA9AA9AA99" }],
            },
          }),
        ),
      );
    });

    it("re-files the chart's coverage with the HOPE number, keeping its payer, rank and dates", async () => {
      const client = clientFor({ workspace: workspaceWith("1EG4TE5MK73"), payers: [coverage] });
      renderWorkspace(client);
      fireEvent.click(await screen.findByRole("button", { name: "Reconcile…" }));
      fireEvent.click(screen.getByRole("button", { name: "Update the chart" }));
      await waitFor(() =>
        expect(client.POST).toHaveBeenCalledWith(
          "/api/v1/patients/{id}/payers",
          expect.objectContaining({
            body: {
              payerId: "payer-cms",
              rank: 1,
              coverageKind: "medicare_ffs",
              subscriberId: "1EG4TE5MK73",
              groupNumber: null,
              binPcn: null,
              effectiveFrom: "2026-10-04",
            },
          }),
        ),
      );
    });

    it("will not put an invalid MBI on the chart", async () => {
      renderWorkspace(clientFor({ workspace: workspaceWith("A12B4590N1ZW"), payers: [coverage] }));
      fireEvent.click(await screen.findByRole("button", { name: "Reconcile…" }));
      expect(screen.queryByRole("button", { name: "Update the chart" })).toBeNull();
      expect(screen.getByText(/cannot go on the\s+chart/)).toBeTruthy();
    });

    it("points to the patient chart when the chart's MBI is a patient identifier", async () => {
      renderWorkspace(
        clientFor({
          workspace: workspaceWith("1EG4TE5MK73"),
          identifiers: [{ kind: "mbi", value: "9AA9AA9AA99", last4: "AA99", effectiveTo: null }],
        }),
      );
      fireEvent.click(await screen.findByRole("button", { name: "Reconcile…" }));
      expect(screen.queryByRole("button", { name: "Update the chart" })).toBeNull();
      expect(screen.getByRole("link", { name: "patient chart" })).toBeTruthy();
    });

    it("saves the member-card number in HOPE and on the chart when neither is right", async () => {
      const client = clientFor({
        workspace: workspaceWith("A12B4590N1ZW"),
        payers: [{ ...coverage, subscriberId: "JU4877GDHJ" }],
      });
      renderWorkspace(client);
      fireEvent.click(await screen.findByRole("button", { name: "Reconcile…" }));
      const save = screen.getByRole("button", { name: "Save the correct number" });
      const input = screen.getByRole("textbox", { name: "Correct Medicare number" });
      fireEvent.change(input, { target: { value: "1EG4-TE5-MK73x" } });
      expect(screen.getByText("Not a valid MBI.")).toBeTruthy();
      expect((save as HTMLButtonElement).disabled).toBe(true);

      fireEvent.change(input, { target: { value: "1eg4-te5-mk73" } });
      fireEvent.click(save);
      await waitFor(() =>
        expect(client.POST).toHaveBeenCalledWith(
          "/api/v1/patients/{id}/payers",
          expect.objectContaining({
            body: expect.objectContaining({ payerId: "payer-cms", subscriberId: "1EG4TE5MK73" }),
          }),
        ),
      );
      expect(client.PATCH).toHaveBeenCalledWith(
        "/api/v1/hope/assessments/{id}/answers",
        expect.objectContaining({
          body: {
            ifVersion: 4,
            changes: [{ itemCode: "A0600B", action: "set", value: "1EG4TE5MK73" }],
          },
        }),
      );
      expect(
        await screen.findByText("The Medicare number is saved in HOPE and on the chart."),
      ).toBeTruthy();
    });

    it("flags a number copied into a correction draft", async () => {
      renderWorkspace(
        clientFor({
          workspace: workspaceWith("A12B4590N1ZW", "correction_copy"),
          payers: [coverage],
        }),
      );
      expect(await screen.findByRole("button", { name: "Reconcile…" })).toBeTruthy();
    });

    it("sends a signed record to its open correction draft", async () => {
      const signed = { ...assessment, status: "signed", signedAt: "2026-09-08T14:00:00.000Z" };
      renderWorkspace(
        clientFor({
          assessment: signed,
          workspace: workspaceWith("A12B4590N1ZW"),
          payers: [coverage],
          timeline: [
            signed,
            { ...assessment, id: "hope-2", status: "draft", correctsAssessmentId: "hope-1" },
          ],
        }),
      );
      fireEvent.click(await screen.findByRole("button", { name: "Reconcile…" }));
      const dialog = screen.getByRole("dialog", { name: "Reconcile Medicare number" });
      expect(within(dialog).getByRole("button", { name: "Open correction draft" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Create correction" })).toBeNull();
    });
  });
});
