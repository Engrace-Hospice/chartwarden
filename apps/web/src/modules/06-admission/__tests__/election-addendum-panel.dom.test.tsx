// @vitest-environment jsdom
// FY2027 — the 42 CFR 418.24(c)/(d) election statement addendum panel: render states, the drawer, furnish,
// and the refusal-reason guard. Fixtures are synthetic (no real patient names).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import type {
  AddendumOverview,
  AddendumVersion,
  ElectionAddendumApi,
} from "../election-addendum-api";
import { countdownLabel, daysUntil } from "../election-addendum-format";
import { ElectionAddendumPanel } from "../election-addendum-panel";

const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  displayName: "Test Clinician",
  roles: ["rn"],
  permissions: [
    "election_addendum.read",
    "election_addendum.write",
    "election_addendum.acknowledge",
  ],
};

function version(over: Partial<AddendumVersion> = {}): AddendumVersion {
  return {
    id: "add-1",
    admissionId: "adm-1",
    versionNumber: 1,
    trigger: "initial",
    triggerCause: "election",
    triggeredAt: "2026-10-02T00:00:00.000Z",
    status: "draft",
    hospiceName: "Example Hospice",
    patientName: "Test Patient",
    medicalRecordNumber: "MRN-0001",
    terminalDiagnosis: [{ icd10Code: "C34.90", description: "Lung cancer" }],
    relatedDiagnoses: [],
    items: [
      {
        category: "condition",
        description: "Hypothyroidism (E03.9)",
        reasonNotCovered: "Unrelated to the terminal illness.",
        source: "problem",
        sourceId: "p-1",
      },
    ],
    noNonCoveredItems: false,
    clinicalExplanation: "Long-standing and stable.",
    guidelineReferences: null,
    dueAt: "2026-10-07T23:59:59.999Z",
    furnishedAt: null,
    furnishMethod: null,
    signedAt: null,
    signerKind: null,
    representativeName: null,
    representativeRelationship: null,
    refusedAt: null,
    refusalReason: null,
    signatureNotRequiredReason: null,
    signatureNotRequiredNote: null,
    documentId: null,
    supersededById: null,
    version: 3,
    ...over,
  };
}

function overview(
  v: AddendumVersion | null,
  over: Partial<AddendumOverview> = {},
): AddendumOverview {
  return {
    admissionId: "adm-1",
    required: true,
    electionEffectiveDate: "2026-10-02",
    inCare: true,
    current: v,
    history: v ? [v] : [],
    openWindows:
      v?.status === "draft"
        ? [{ id: "cw-1", kind: "election_addendum_initial", status: "open", dueAt: v.dueAt ?? "" }]
        : [],
    ...over,
  };
}

function fakeApi(
  ov: AddendumOverview,
): ElectionAddendumApi & Record<string, ReturnType<typeof vi.fn>> {
  return {
    overview: vi.fn(async () => ov),
    draft: vi.fn(async () => ov),
    save: vi.fn(async (_a, v) => v),
    furnish: vi.fn(async (_a, v) => ({ ...v, status: "furnished" })),
    sign: vi.fn(async (_a, v) => ({ ...v, status: "signed" })),
    refuse: vi.fn(async (_a, v) => ({ ...v, status: "refused" })),
    notRequired: vi.fn(async (_a, v) => ({ ...v, status: "signature_not_required" })),
  } as unknown as ElectionAddendumApi & Record<string, ReturnType<typeof vi.fn>>;
}

function renderPanel(api: ElectionAddendumApi) {
  return render(
    <ApiClientProvider client={{} as ApiClient}>
      <SessionProvider session={session}>
        <ElectionAddendumPanel admissionId="adm-1" api={api} />
      </SessionProvider>
    </ApiClientProvider>,
  );
}

describe("ElectionAddendumPanel", () => {
  it("shows the not-mandatory note for an election before 2026-10-01", async () => {
    renderPanel(fakeApi(overview(null, { required: false, electionEffectiveDate: "2026-09-15" })));
    expect(await screen.findByText(/Not mandatory/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Draft addendum" })).toBeNull();
  });

  it("offers to draft when no addendum exists and drafts on click", async () => {
    const api = fakeApi(overview(null));
    renderPanel(api);
    fireEvent.click(await screen.findByRole("button", { name: "Draft addendum" }));
    await waitFor(() => expect(api.draft).toHaveBeenCalledWith("adm-1"));
  });

  it("renders the draft's status, items and due window", async () => {
    renderPanel(fakeApi(overview(version())));
    expect(await screen.findByText("Hypothyroidism (E03.9)")).toBeTruthy();
    expect(screen.getAllByText("Draft").length).toBeGreaterThan(0);
    expect(screen.getByText(/Election addendum \(5 days\)/)).toBeTruthy();
  });

  it("furnishes the selected draft with the chosen method", async () => {
    const api = fakeApi(overview(version()));
    renderPanel(api);
    fireEvent.click(await screen.findByRole("button", { name: "Open version 1" }));
    const drawer = await screen.findByRole("complementary", { name: "Addendum version 1" });
    fireEvent.change(within(drawer).getByLabelText("How it was given"), {
      target: { value: "electronic_with_paper_copy" },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Furnish addendum" }));
    await waitFor(() =>
      expect(api.furnish).toHaveBeenCalledWith(
        "adm-1",
        expect.objectContaining({ id: "add-1", version: 3 }),
        "electronic_with_paper_copy",
      ),
    );
  });

  it("refuses to record a refusal without a reason", async () => {
    const furnished = version({ status: "furnished", furnishedAt: "2026-10-03T15:00:00.000Z" });
    const api = fakeApi(overview(furnished));
    renderPanel(api);
    fireEvent.click(await screen.findByRole("button", { name: "Open version 1" }));
    const drawer = await screen.findByRole("complementary", { name: "Addendum version 1" });
    fireEvent.change(within(drawer).getByLabelText("Record"), { target: { value: "refusal" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Record" }));
    expect(
      await within(drawer).findByText(/Document why the addendum was not signed/),
    ).toBeTruthy();
    expect(api.refuse).not.toHaveBeenCalled();

    fireEvent.change(within(drawer).getByLabelText(/Why it was not signed/), {
      target: { value: "Declined to sign; copy left with family." },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Record" }));
    await waitFor(() =>
      expect(api.refuse).toHaveBeenCalledWith(
        "adm-1",
        expect.objectContaining({ id: "add-1" }),
        "Declined to sign; copy left with family.",
      ),
    );
  });

  it("records a representative signature", async () => {
    const furnished = version({ status: "furnished", furnishedAt: "2026-10-03T15:00:00.000Z" });
    const api = fakeApi(overview(furnished));
    renderPanel(api);
    fireEvent.click(await screen.findByRole("button", { name: "Open version 1" }));
    const drawer = await screen.findByRole("complementary", { name: "Addendum version 1" });
    fireEvent.change(within(drawer).getByLabelText("Signed by"), {
      target: { value: "representative" },
    });
    fireEvent.change(within(drawer).getByLabelText(/Representative name/), {
      target: { value: "Test Representative" },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Record" }));
    await waitFor(() =>
      expect(api.sign).toHaveBeenCalledWith(
        "adm-1",
        expect.objectContaining({ id: "add-1" }),
        expect.objectContaining({
          signerKind: "representative",
          representativeName: "Test Representative",
        }),
      ),
    );
  });
});

describe("addendum countdown", () => {
  it("counts calendar days and labels overdue", () => {
    const now = new Date(2026, 9, 5, 9, 0, 0);
    expect(daysUntil(new Date(2026, 9, 7, 23, 0, 0).toISOString(), now)).toBe(2);
    expect(countdownLabel(new Date(2026, 9, 5, 23, 0, 0).toISOString(), now)).toBe("Due today");
    expect(countdownLabel(new Date(2026, 9, 3, 23, 0, 0).toISOString(), now)).toBe(
      "Overdue by 2 days",
    );
  });
});
