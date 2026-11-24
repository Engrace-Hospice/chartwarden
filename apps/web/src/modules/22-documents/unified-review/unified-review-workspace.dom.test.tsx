import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Workspace } from "../doclens-api";
import { UnifiedReviewWorkspace } from "./unified-review-workspace";

const BATCH = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PHONE = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const NEXT = "cccccccc-3333-4333-8333-cccccccccccc";

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
let decisionStatus = 200;
let releaseRejects = false;
let completionRejects = false;
let failWorkspaceRefresh = false;
let workspaceReadCount = 0;
const decisionRequests: unknown[] = [];
const fetchStub = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  const request =
    input instanceof Request
      ? input
      : new Request(new URL(String(input), "http://localhost").toString());
  const path = new URL(request.url, "http://localhost").pathname;
  if (path.endsWith("/workspace")) {
    workspaceReadCount += 1;
    const status = failWorkspaceRefresh && workspaceReadCount > 1 ? 503 : workspaceStatus;
    return new Response(status === 200 ? JSON.stringify(workspace) : "unavailable", {
      status,
      headers: { "content-type": "application/json" },
    });
  }
  if (path.endsWith("/decisions") && request.method === "POST") {
    const body = (await request.clone().json()) as {
      candidateId: string;
      decision: "approve" | "approve_with_edit" | "reject";
      editedValue?: string;
      reason?: string;
    };
    decisionRequests.push(body);
    if (decisionStatus !== 200)
      return new Response(
        JSON.stringify({ error: { code: "FORBIDDEN", message: "Decision refused" } }),
        { status: decisionStatus, headers: { "content-type": "application/json" } },
      );
    const candidate = workspace.candidates.find((item) => item.id === body.candidateId);
    if (candidate)
      candidate.decision = {
        id: `decision-${body.candidateId}`,
        decision: body.decision,
        editedValue: body.editedValue ?? null,
        reason: body.reason ?? null,
        partOfBulkApprove: false,
        decidedAt: "2026-11-22T11:00:00.000Z",
      };
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (request.method === "POST" && path.endsWith("/abandon") && releaseRejects)
    throw new Error("synthetic release transport failure");
  if (request.method === "POST" && path.endsWith("/complete") && completionRejects)
    throw new Error("synthetic completion transport failure");
  if (request.method === "POST" && (path.endsWith("/abandon") || path.endsWith("/complete"))) {
    return new Response(JSON.stringify({}), {
      status: 200,
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
  decisionStatus = 200;
  releaseRejects = false;
  completionRejects = false;
  failWorkspaceRefresh = false;
  workspaceReadCount = 0;
  decisionRequests.length = 0;
  fetchStub.mockClear();
  vi.stubGlobal("fetch", fetchStub);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("UnifiedReviewWorkspace", () => {
  it("renders six accessible sections and opens candidate review inline", async () => {
    mount();
    expect(await screen.findByRole("heading", { name: "Review patient information" })).toBeTruthy();

    const navigation = screen.getByRole("navigation", { name: "Clinical review sections" });
    const sectionButtons = within(navigation).getAllByRole("button");
    expect(sectionButtons).toHaveLength(6);
    expect(sectionButtons[0]?.getAttribute("aria-expanded")).toBe("true");

    const task = document.querySelector<HTMLElement>(".wx-unified-task-column");
    if (!task) throw new Error("Expected the unified task column");
    task.scrollTop = 180;
    fireEvent.click(screen.getByRole("button", { name: /Review decision/ }));
    expect(screen.getByRole("region", { name: /Review task/ })).toBeTruthy();
    expect(task.scrollTop).toBe(0);
    expect(screen.getByRole("heading", { name: "Mobile phone", level: 2 })).toBeTruthy();
    expect(document.querySelector(".wx-unified-layout")).toBeTruthy();
  });

  it("uses the tenant-consented platform read path without exposing tenant review actions", async () => {
    const supportSessionId = "dddddddd-4444-4444-8444-dddddddddddd";
    const supportOrganizationId = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
    mount(
      `/intake/${BATCH}/review?supportOrganizationId=${supportOrganizationId}&supportSessionId=${supportSessionId}`,
    );

    expect(await screen.findByText("Tenant-consented platform support access")).toBeTruthy();
    expect(screen.getAllByText("Read-only support session").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Release review" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Complete review" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start review" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Legacy detailed reviewer/ })).toBeNull();

    const workspaceRequest = fetchStub.mock.calls.find(([input]) =>
      String(input instanceof Request ? input.url : input).includes(
        "/api/v1/platform/organizations/",
      ),
    );
    expect(workspaceRequest).toBeTruthy();
    const workspaceUrl = new URL(
      String(
        workspaceRequest?.[0] instanceof Request ? workspaceRequest[0].url : workspaceRequest?.[0],
      ),
      "http://localhost",
    );
    expect(workspaceUrl.pathname).toBe(
      `/api/v1/platform/organizations/${supportOrganizationId}/intake/uploads/${BATCH}/workspace`,
    );
    expect(workspaceUrl.searchParams.get("supportSessionId")).toBe(supportSessionId);

    const image = screen.getByRole("img", { name: /Page 1 of the source document/ });
    const imageUrl = new URL(image.getAttribute("src") ?? "", "http://localhost");
    expect(imageUrl.pathname).toBe(
      `/api/v1/platform/organizations/${supportOrganizationId}/intake/uploads/${BATCH}/pages/1/image`,
    );
    expect(imageUrl.searchParams.get("supportSessionId")).toBe(supportSessionId);
    expect(screen.getByText(/Support-session access is read-only/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept extracted value" })).toBeNull();
  });

  it("offers server-backed release and completion from the unified workspace", async () => {
    const candidate = workspace.candidates[0];
    if (!candidate) throw new Error("Expected the synthetic phone candidate");
    candidate.decision = {
      id: "decision-complete",
      decision: "approve",
      editedValue: null,
      reason: null,
      partOfBulkApprove: false,
      decidedAt: "2026-11-22T11:00:00.000Z",
    };
    try {
      mount();
      const release = await screen.findByRole("button", { name: "Release review" });
      const complete = screen.getByRole("button", { name: "Complete review" });
      expect(release).toBeEnabled();
      expect(complete).toBeEnabled();

      fireEvent.click(complete);
      const dialog = screen.getByRole("dialog", { name: "Complete review" });
      fireEvent.click(
        within(dialog).getByRole("checkbox", { name: /I reviewed each accepted field/ }),
      );
      fireEvent.click(within(dialog).getByRole("button", { name: "Complete review" }));
      expect(await screen.findByRole("heading", { name: "Review complete" })).toBeTruthy();
      expect(
        fetchStub.mock.calls.some(([input]) =>
          String(input instanceof Request ? input.url : input).endsWith("/complete"),
        ),
      ).toBe(true);
    } finally {
      candidate.decision = null;
    }
  });

  it("releases the current review without opening the detailed reviewer", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Release review" }));
    await waitFor(() =>
      expect(
        fetchStub.mock.calls.some(([input]) =>
          String(input instanceof Request ? input.url : input).endsWith("/abandon"),
        ),
      ).toBe(true),
    );
    expect(screen.queryByText("Legacy detailed reviewer")).toBeTruthy();
  });

  it("fails closed after release succeeds when the authoritative refresh fails", async () => {
    failWorkspaceRefresh = true;
    try {
      mount();
      fireEvent.click(await screen.findByRole("button", { name: "Release review" }));
      expect(
        await screen.findByText("Review released. Refresh the workspace before continuing."),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Release review" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Complete review" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Accept extracted value" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Start review" })).toBeNull();
      expect(screen.getByRole("button", { name: "Retry workspace refresh" })).toBeTruthy();
    } finally {
      failWorkspaceRefresh = false;
    }
  });

  it("recovers release controls after a transport rejection", async () => {
    releaseRejects = true;
    try {
      mount();
      fireEvent.click(await screen.findByRole("button", { name: "Release review" }));
      expect(await screen.findByText("The review could not be released. Try again.")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Release review" })).toBeEnabled();
    } finally {
      releaseRejects = false;
    }
  });

  it("keeps completion retryable after a transport rejection", async () => {
    const candidate = workspace.candidates[0];
    if (!candidate) throw new Error("Expected the synthetic phone candidate");
    candidate.decision = {
      id: "decision-completion-retry",
      decision: "approve",
      editedValue: null,
      reason: null,
      partOfBulkApprove: false,
      decidedAt: "2026-11-22T11:00:00.000Z",
    };
    completionRejects = true;
    try {
      mount();
      fireEvent.click(await screen.findByRole("button", { name: "Complete review" }));
      const dialog = screen.getByRole("dialog", { name: "Complete review" });
      fireEvent.click(
        within(dialog).getByRole("checkbox", { name: /I reviewed each accepted field/ }),
      );
      fireEvent.click(within(dialog).getByRole("button", { name: "Complete review" }));
      expect(
        await within(dialog).findByText("The review could not be completed. Try again."),
      ).toBeTruthy();
      expect(within(dialog).getByRole("button", { name: "Complete review" })).toBeEnabled();
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
    } finally {
      completionRejects = false;
      candidate.decision = null;
    }
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
    fireEvent.click(screen.getByRole("button", { name: /Review decision/ }));
    expect(screen.getByRole("region", { name: /Review task/ })).toBeTruthy();

    const detailed = screen.getByRole("link", { name: /Legacy detailed reviewer/ });
    const detailedUrl = new URL(detailed.getAttribute("href") ?? "", "http://localhost");
    expect(detailedUrl.searchParams.get("returnTo")).toBe(returnTo);

    fireEvent.click(screen.getByRole("button", { name: /Preview source/ }));
    fireEvent.click(screen.getByText("Advanced tools"));
    const sourceReview = screen.getByRole("link", {
      name: /Leave unified workspace for legacy reviewer/,
    });
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
    fireEvent.click(screen.getByRole("button", { name: /Other review requirements/ }));
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

  it("requires a visible source and explicit comparison before an inline decision", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Review decision/ }));

    const accept = screen.getByRole("button", { name: "Accept extracted value" });
    const confirmation = screen.getByRole("checkbox", { name: /I compared this with the source/ });
    expect(confirmation).toBeDisabled();
    expect(accept).toBeDisabled();

    fireEvent.load(screen.getByRole("img", { name: /Page 1 of the source document/ }));
    expect(confirmation).not.toBeDisabled();
    fireEvent.click(confirmation);
    expect(accept).not.toBeDisabled();
  });

  it("consolidates repeated exception reasons into expandable task categories", async () => {
    const candidate = workspace.candidates[0];
    if (!candidate) throw new Error("Expected the synthetic phone candidate");
    const original = {
      confidence: candidate.confidence,
      riskLevel: candidate.riskLevel,
      vision: candidate.vision,
    };
    candidate.confidence = 0.61;
    candidate.riskLevel = "high";
    candidate.vision = { status: "disagreed", observedValue: "503-555-0188" };
    try {
      mount();
      const panel = await screen.findByRole("complementary", { name: "Review priorities" });
      expect(within(panel).getByText(/3 underlying requirements/)).toBeTruthy();
      const category = within(panel).getByRole("button", {
        name: /High-risk clinical information/,
      });
      if (category.getAttribute("aria-expanded") !== "true") fireEvent.click(category);
      expect(
        within(panel).getByRole("button", { name: /Mobile phone needs high-risk review/ }),
      ).toBeTruthy();
      expect(within(panel).getByText(/3 reasons/)).toBeTruthy();
      fireEvent.click(
        within(panel).getByRole("button", { name: /Mobile phone needs high-risk review/ }),
      );
      expect(document.activeElement).toBe(
        screen.getByRole("region", { name: "Active review task" }),
      );
    } finally {
      candidate.confidence = original.confidence;
      candidate.riskLevel = original.riskLevel;
      candidate.vision = original.vision;
    }
  });

  it("requires a successful server refresh before offering the next issue", async () => {
    const phone = workspace.candidates[0];
    if (!phone) throw new Error("Expected the synthetic phone candidate");
    workspace.candidates.push({
      ...phone,
      id: NEXT,
      fieldPath: "patient.email",
      value: "synthetic@example.test",
      decision: null,
    });
    try {
      mount();
      fireEvent.load(await screen.findByRole("img", { name: /Page 1 of the source document/ }));
      fireEvent.click(screen.getByRole("checkbox", { name: /I compared this with the source/ }));
      workspaceStatus = 503;
      fireEvent.click(screen.getByRole("button", { name: "Accept extracted value" }));

      expect(
        await screen.findByText(/Decision saved, but the workspace could not be refreshed/),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Next issue/ })).toBeNull();

      workspaceStatus = 200;
      fireEvent.click(screen.getByRole("button", { name: /Retry workspace refresh/ }));
      expect(await screen.findByRole("button", { name: /Next issue: Email/ })).toBeTruthy();
    } finally {
      phone.decision = null;
      workspace.candidates.pop();
      workspaceStatus = 200;
    }
  });

  it("saves an inline correction, refreshes server state, and offers the next issue", async () => {
    const phone = workspace.candidates[0];
    if (!phone) throw new Error("Expected the synthetic phone candidate");
    const next = {
      ...phone,
      id: NEXT,
      fieldPath: "patient.email",
      description: "email",
      value: "synthetic@example.test",
      decision: null,
    };
    workspace.candidates.push(next);
    try {
      mount();
      const image = await screen.findByRole("img", { name: /Page 1 of the source document/ });
      fireEvent.load(image);
      fireEvent.click(screen.getByRole("checkbox", { name: /I compared this with the source/ }));
      fireEvent.click(screen.getByRole("button", { name: "Edit value" }));
      fireEvent.change(screen.getByLabelText("Corrected value"), {
        target: { value: "(503) 555-0199" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save corrected value" }));

      expect(await screen.findByText("Decision saved: corrected to (503) 555-0199")).toBeTruthy();
      expect(decisionRequests).toContainEqual(
        expect.objectContaining({
          candidateId: PHONE,
          decision: "approve_with_edit",
          editedValue: "(503) 555-0199",
          sourceViewConfirmed: true,
        }),
      );
      expect(screen.getByRole("button", { name: /Next issue: Email/ })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /Next issue: Email/ }));
      expect(screen.getByRole("heading", { name: "Email", level: 2 })).toBeTruthy();
    } finally {
      phone.decision = null;
      workspace.candidates.pop();
    }
  });

  it("keeps decisions unavailable when another reviewer owns the workspace", async () => {
    const review = workspace.review;
    if (!review) throw new Error("Expected an active review");
    workspace.review = { ...review, isMine: false };
    try {
      mount();
      expect(await screen.findByText("Another reviewer owns this review.")).toBeTruthy();
      expect(
        screen.queryByRole("checkbox", { name: /I compared this with the source/ }),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: "Accept extracted value" })).toBeNull();
    } finally {
      workspace.review = review;
    }
  });

  it("never offers source confirmation for withheld Part 2 evidence", async () => {
    const candidate = workspace.candidates[0];
    if (!candidate) throw new Error("Expected the synthetic phone candidate");
    candidate.redacted = true;
    candidate.sudDetected = true;
    try {
      mount();
      fireEvent.click(await screen.findByRole("button", { name: /Part 2 \/ SUD safeguards/ }));
      fireEvent.click(screen.getByRole("button", { name: /Mobile phone/ }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Source access is restricted");
      expect(screen.queryByRole("img")).toBeNull();
      expect(
        screen.queryByRole("checkbox", { name: /I compared this with the source/ }),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: "Accept extracted value" })).toBeNull();
    } finally {
      candidate.redacted = false;
      candidate.sudDetected = false;
    }
  });

  it("keeps identity safeguards locked until their authorized source page is visible", async () => {
    const document = workspace.documents[0];
    if (!document) throw new Error("Expected a synthetic source document");
    document.identity = { status: "possible", disagreeing: ["lastName"], resolution: null };
    try {
      mount();
      fireEvent.click(await screen.findByRole("button", { name: /Documents & safeguards/ }));
      const source = await screen.findByRole("img", {
        name: "Page 1 of the safeguard source document",
      });
      expect(screen.getByRole("button", { name: "Same patient" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Another patient" })).toBeDisabled();

      fireEvent.load(source);

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Same patient" })).toBeEnabled(),
      );
      expect(screen.getByRole("button", { name: "Another patient" })).toBeEnabled();
    } finally {
      document.identity = { status: "match", disagreeing: [], resolution: null };
    }
  });

  it("fails closed when identity evidence becomes unavailable after opening the form", async () => {
    const document = workspace.documents[0];
    if (!document) throw new Error("Expected a synthetic source document");
    document.identity = { status: "possible", disagreeing: ["lastName"], resolution: null };
    try {
      mount();
      fireEvent.click(await screen.findByRole("button", { name: /Documents & safeguards/ }));
      const source = await screen.findByRole("img", {
        name: "Page 1 of the safeguard source document",
      });
      fireEvent.load(source);
      fireEvent.click(screen.getByRole("button", { name: "Another patient" }));
      fireEvent.change(screen.getByLabelText("Reason"), {
        target: { value: "Identifiers belong to another synthetic patient" },
      });

      pageStatus = 503;
      fireEvent.error(source);
      expect(await screen.findByRole("alert")).toHaveTextContent("Source page could not be loaded");
      const form = screen.getByLabelText("Reason").closest("form");
      if (!form) throw new Error("Expected the identity resolution form");
      fireEvent.submit(form);

      const identityWrites = fetchStub.mock.calls.filter(([input]) =>
        String(input instanceof Request ? input.url : input).includes("/identity-review"),
      );
      expect(identityWrites).toHaveLength(0);
    } finally {
      document.identity = { status: "match", disagreeing: [], resolution: null };
      pageStatus = 200;
    }
  });

  it("does not offer wrong-patient candidates as patient facts or review tasks", async () => {
    const document = workspace.documents[0];
    if (!document) throw new Error("Expected a synthetic source document");
    document.identity = {
      status: "possible",
      disagreeing: ["lastName"],
      resolution: "other_patient",
    };
    try {
      mount();
      expect(
        await screen.findByRole("heading", { name: "Review patient information" }),
      ).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Mobile phone", level: 2 })).toBeNull();
      expect(screen.queryByRole("button", { name: /Review decision/ })).toBeNull();
      expect(screen.getByRole("region", { name: "Review progress" })).toHaveTextContent(
        "0 of 0 observations decided",
      );
    } finally {
      document.identity = { status: "match", disagreeing: [], resolution: null };
    }
  });
});
