import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Workspace } from "../doclens-api";
import { UnifiedReviewWorkspace } from "./unified-review-workspace";

const BATCH = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PHONE = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

const workspace: Workspace = {
  batch: {
    id: BATCH,
    status: "in_review",
    sourceChannel: "fax",
    uploadedAt: "2026-11-22T10:00:00.000Z",
    documentId: "document-1",
    patientId: "patient-1",
    patientName: "Synthetic Patient",
    referralId: "referral-1",
    identityStatus: "match",
    recordsRequestConflict: null,
  },
  sud: {
    status: "not_detected",
    detectorRef: null,
    resolvedAt: null,
    resolvedByMembershipId: null,
    contentRedacted: false,
    indicators: [],
  },
  pages: [
    {
      page: 1,
      width: 612,
      height: 792,
      documentType: "discharge_summary",
      confidence: 0.98,
      needsHumanClassification: false,
    },
  ],
  documents: [
    {
      pageFrom: 1,
      pageTo: 1,
      documentType: "discharge_summary",
      title: "Discharge summary",
      date: null,
      duplicateOfPage: null,
      boundary: null,
      identity: { status: "match", disagreeing: [], resolution: null },
    },
  ],
  jobs: [],
  review: {
    id: "review-1",
    status: "in_progress",
    reviewerMembershipId: "membership-1",
    isMine: true,
  },
  candidates: [
    {
      id: PHONE,
      jobId: "job-1",
      documentType: "discharge_summary",
      fieldPath: "patient.phoneMobile",
      description: "mobile phone",
      riskLevel: "low",
      confidence: 0.95,
      value: "(503) 555-0177",
      page: 1,
      bbox: [10, 10, 20, 20],
      vision: { status: "not_required", observedValue: null },
      sudDetected: false,
      codingFlags: [],
      writebackTarget: true,
      redacted: false,
      decision: null,
    },
  ],
};

let pageStatus = 200;
let workspaceStatus = 200;
const fetchStub = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  const request = input instanceof Request ? input : new Request(String(input));
  const path = new URL(request.url, "http://localhost").pathname;
  if (path.endsWith("/workspace")) {
    return new Response(workspaceStatus === 200 ? JSON.stringify(workspace) : "unavailable", {
      status: workspaceStatus,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(pageStatus === 200 ? new Uint8Array([1]) : "unavailable", {
    status: pageStatus,
    headers: { "content-type": pageStatus === 200 ? "image/png" : "text/plain" },
  });
});

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["rn"],
  permissions: [],
  isAdmin: false,
};

function mount(entry = `/intake/${BATCH}/review`): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: fetchStub })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter initialEntries={[entry]}>
            <Routes>
              <Route path="/intake/:batchId/review" element={<UnifiedReviewWorkspace />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

beforeEach(() => {
  pageStatus = 200;
  workspaceStatus = 200;
  fetchStub.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("UnifiedReviewWorkspace", () => {
  it("renders six accessible sections and candidate-specific detailed navigation", async () => {
    mount();
    expect(await screen.findByRole("heading", { name: "Review patient information" })).toBeTruthy();

    const navigation = screen.getByRole("navigation", { name: "Clinical review sections" });
    const sectionButtons = within(navigation).getAllByRole("button");
    expect(sectionButtons).toHaveLength(6);
    expect(sectionButtons[0]?.getAttribute("aria-expanded")).toBe("true");

    const decisionLink = screen.getByRole("link", { name: /Review decision/ });
    expect(decisionLink.getAttribute("href")).toContain(`candidate=${PHONE}`);
    expect(document.querySelector(".wx-unified-layout")).toBeTruthy();
  });

  it("displays an approved correction without misrepresenting the extracted value", async () => {
    const candidate = workspace.candidates[0];
    if (!candidate) throw new Error("Expected the synthetic phone candidate");
    candidate.decision = {
      id: "decision-1",
      decision: "approve_with_edit",
      editedValue: "(503) 555-0199",
      reason: null,
      partOfBulkApprove: false,
      decidedAt: "2026-11-22T11:00:00.000Z",
    };

    try {
      mount();

      expect(await screen.findByText("(503) 555-0199")).toBeTruthy();
      expect(screen.getByText("Extracted: (503) 555-0177")).toBeTruthy();
      expect(screen.getByText("Approved correction")).toBeTruthy();
    } finally {
      candidate.decision = null;
    }
  });

  it("preserves a validated referral return target across unified and detailed review", async () => {
    const referralId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const returnTo = `/referrals/${referralId}/intake?step=receive`;
    mount(`/intake/${BATCH}/review?returnTo=${encodeURIComponent(returnTo)}`);

    expect(
      (await screen.findByRole("link", { name: "Back to referral intake" })).getAttribute("href"),
    ).toBe(returnTo);
    const decision = screen.getByRole("link", { name: /Review decision/ });
    const decisionUrl = new URL(decision.getAttribute("href") ?? "", "http://localhost");
    expect(decisionUrl.searchParams.get("returnTo")).toBe(returnTo);
    expect(decisionUrl.searchParams.get("from")).toBe("unified");

    const detailed = screen.getByRole("link", { name: /Detailed reviewer/ });
    const detailedUrl = new URL(detailed.getAttribute("href") ?? "", "http://localhost");
    expect(detailedUrl.searchParams.get("returnTo")).toBe(returnTo);

    fireEvent.click(screen.getByRole("button", { name: /Preview source/ }));
    const sourceReview = screen.getByRole("link", { name: /Open detailed review/ });
    const sourceReviewUrl = new URL(sourceReview.getAttribute("href") ?? "", "http://localhost");
    expect(sourceReviewUrl.searchParams.get("returnTo")).toBe(returnTo);
  });

  it("preserves referral return navigation when the workspace cannot load", async () => {
    workspaceStatus = 503;
    const referralId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const returnTo = `/referrals/${referralId}/intake?step=verify`;
    mount(`/intake/${BATCH}/review?returnTo=${encodeURIComponent(returnTo)}`);

    expect(await screen.findByText("Review unavailable")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to referral intake" }).getAttribute("href")).toBe(
      returnTo,
    );
  });

  it("supports keyboard activation of section disclosure controls", async () => {
    mount();
    const medications = await screen.findByRole("button", { name: /Medications & allergies/ });
    medications.focus();
    fireEvent.keyDown(medications, { key: "Enter" });
    fireEvent.click(medications);
    expect(medications.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("heading", { name: "Medications & allergies" })).toBeTruthy();
  });

  it("turns a source-image failure into an exception and offers a safe retry", async () => {
    pageStatus = 503;
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Preview source/ }));
    const image = screen.getByRole("img", { name: /Page 1 of the source document/ });
    fireEvent.error(image);

    expect(await screen.findByRole("alert")).toHaveTextContent("Source page could not be loaded");
    await waitFor(() => expect(screen.getByText("Source page 1 is unavailable")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Retry source/ }));
    expect(screen.getByText("Source page 1 is unavailable")).toBeTruthy();

    const retryImage = screen.getByRole("img", { name: /Page 1 of the source document/ });
    fireEvent.load(retryImage);
    await waitFor(() =>
      expect(screen.queryByText("Source page 1 is unavailable")).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/does not confirm the source/)).toBeTruthy();
  });
});
