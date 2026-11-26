// Where opening a review task leads (field task or safeguard block), which row of the priorities list
// is marked, and which task is reopened after a reload.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LAST_REVIEW_TASK_KEY_PREFIX } from "../../../shell/last-review-task";
import { SessionProvider } from "../../../shell/session";
import type { Workspace } from "../doclens-api";
import { overrideImageProperty } from "./review-test-support";
import { UnifiedReviewWorkspace } from "./unified-review-workspace";

const BATCH = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PHONE = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const EMAIL = "cccccccc-3333-4333-8333-cccccccccccc";
const DIAGNOSIS_ONE = "11111111-1111-4111-8111-111111111111";
const DIAGNOSIS_TWO = "22222222-2222-4222-8222-222222222222";
const SUD_PAGE = 1;
const IDENTITY_PAGE = 2;
const SECOND_IDENTITY_PAGE = 3;
const COLUMN_TOP = 100;
const BLOCK_TOP = 1700;
const TASK_KEY = `${LAST_REVIEW_TASK_KEY_PREFIX}${BATCH}`;
const REASON = "Identifiers match this synthetic patient";
const EMAIL_REVIEW = (page: number): string => `Review synthetic@example.test, page ${page}`;

type WorkspaceCandidate = Workspace["candidates"][number];

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

const fetchStub = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  const request =
    input instanceof Request
      ? input
      : new Request(new URL(String(input), "http://localhost").toString());
  const path = new URL(request.url, "http://localhost").pathname;
  const json = { "content-type": "application/json" };
  if (path.endsWith("/workspace"))
    return new Response(JSON.stringify(workspace), { status: 200, headers: json });
  if (request.method === "POST" && path.endsWith("/identity-review")) {
    const body = (await request.clone().json()) as { pageFrom: number; resolution: "same_patient" };
    const document = workspace.documents.find((item) => item.pageFrom === body.pageFrom);
    if (document) document.identity = { ...document.identity, resolution: body.resolution };
    return new Response(JSON.stringify({ identityStatus: "match" }), {
      status: 200,
      headers: json,
    });
  }
  return new Response(new Uint8Array([1]), {
    status: 200,
    headers: { "content-type": "image/png" },
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

function mount(): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: fetchStub })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter initialEntries={[`/intake/${BATCH}/review`]}>
            <Routes>
              <Route path="/intake/:batchId/review" element={<UnifiedReviewWorkspace />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

describe("UnifiedReviewWorkspace review task routing", () => {
  const scrollIntoView = vi.fn();
  let pristine: Workspace;

  beforeEach(() => {
    pristine = structuredClone(workspace);
    window.sessionStorage.clear();
    scrollIntoView.mockClear();
    vi.stubGlobal("fetch", fetchStub);
    // jsdom has no Element.scrollIntoView.
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      value: scrollIntoView,
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    Object.assign(workspace, structuredClone(pristine));
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function phoneCandidate(): WorkspaceCandidate {
    const phone = workspace.candidates[0];
    if (!phone) throw new Error("Expected the synthetic phone candidate");
    return phone;
  }

  function detectSud(): void {
    phoneCandidate().sudDetected = true;
    workspace.sud = {
      ...workspace.sud,
      status: "detected",
      indicators: [
        {
          page: SUD_PAGE,
          category: "sud",
          ruleId: "synthetic-rule",
          term: "synthetic term",
          bbox: [1, 1, 2, 2],
        },
      ],
    };
  }

  function addDocument(page: number, identity: Workspace["documents"][number]["identity"]): void {
    workspace.pages.push({
      page,
      width: 612,
      height: 792,
      documentType: "discharge_summary",
      confidence: 0.98,
      needsHumanClassification: false,
    });
    workspace.documents.push({
      pageFrom: page,
      pageTo: page,
      documentType: "discharge_summary",
      title: `Discharge summary ${page}`,
      date: null,
      duplicateOfPage: null,
      boundary: null,
      identity,
    });
  }

  function unresolvedIdentity(): Workspace["documents"][number]["identity"] {
    return { status: "possible", disagreeing: ["lastName"], resolution: null };
  }

  function addDocumentNeedingIdentity(page = IDENTITY_PAGE): void {
    addDocument(page, unresolvedIdentity());
  }

  function addEmailCandidate(page: number): void {
    workspace.candidates.push({
      ...phoneCandidate(),
      id: EMAIL,
      fieldPath: "patient.email",
      description: "email",
      value: "synthetic@example.test",
      page,
      decision: null,
    });
  }

  function highRiskDiagnosis(
    id: string,
    index: number,
    value: string,
    page = 1,
  ): WorkspaceCandidate {
    return {
      ...phoneCandidate(),
      id,
      fieldPath: `diagnoses[${index}].description`,
      value,
      page,
      riskLevel: "high",
      decision: null,
    };
  }

  function addHighRiskDiagnoses(): void {
    workspace.candidates.push(
      highRiskDiagnosis(DIAGNOSIS_ONE, 0, "Dependence on supplemental oxygen"),
      highRiskDiagnosis(DIAGNOSIS_TWO, 1, "Chronic kidney disease stage 4"),
    );
  }

  function stubLayout(blockTops: Readonly<Record<string, number>>): void {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const top = this.classList.contains("wx-unified-task-column")
        ? COLUMN_TOP
        : (blockTops[this.dataset.safeguardBlock ?? ""] ?? 0);
      return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top } as DOMRect;
    });
  }

  /** The wide layout scrolls the task column itself; the narrow one scrolls the page. */
  function makeTaskColumnScrollable(): HTMLElement {
    const column = document.querySelector<HTMLElement>(".wx-unified-task-column");
    if (!column) throw new Error("Expected the task column");
    column.style.overflowY = "auto";
    return column;
  }

  async function prioritiesPanel(): Promise<HTMLElement> {
    return await screen.findByRole("complementary", { name: "Review priorities" });
  }

  /** A task that is open already opened the category holding its row; only click a closed one. */
  function openCategory(panel: HTMLElement, name: RegExp): void {
    const category = within(panel).getByRole("button", { name });
    if (category.getAttribute("aria-expanded") !== "true") fireEvent.click(category);
  }

  function openSudTask(panel: HTMLElement): void {
    openCategory(panel, /Part 2 \/ SUD safeguards/);
    fireEvent.click(
      within(panel).getByRole("button", { name: /Part 2 \/ SUD safeguard is unresolved/ }),
    );
  }

  function openIdentityTask(panel: HTMLElement, page: number): void {
    openCategory(panel, /^Patient identity \d+ task/);
    fireEvent.click(
      within(panel).getByRole("button", {
        name: new RegExp(`Patient identity needs review on page ${page}`),
      }),
    );
  }

  const sudBlock = (): HTMLElement => screen.getByRole("group", { name: "Part 2 / SUD safeguard" });
  const identityBlock = (page: number): HTMLElement =>
    screen.getByRole("group", { name: new RegExp(`Patient identity.*page ${page}`) });

  it("opens the Part 2 / SUD safeguard block, not a field task, for the SUD exception", async () => {
    detectSud();
    stubLayout({ sud: BLOCK_TOP });
    mount();
    const panel = await prioritiesPanel();
    const column = makeTaskColumnScrollable();

    openSudTask(panel);

    expect(screen.getByRole("heading", { name: "Documents & protected information" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Mobile phone", level: 2 })).toBeNull();
    expect(sudBlock().getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).toBe(sudBlock());
    expect(column.scrollTop).toBe(BLOCK_TOP - COLUMN_TOP);
  });

  it("marks and scrolls to the selected identity block inside the task column", async () => {
    detectSud();
    addDocumentNeedingIdentity();
    stubLayout({ [`identity-${IDENTITY_PAGE}`]: BLOCK_TOP });
    mount();
    const panel = await prioritiesPanel();
    const column = makeTaskColumnScrollable();

    openIdentityTask(panel, IDENTITY_PAGE);

    expect(identityBlock(IDENTITY_PAGE).getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).toBe(identityBlock(IDENTITY_PAGE));
    expect(column.scrollTop).toBe(BLOCK_TOP - COLUMN_TOP);
    expect(sudBlock().getAttribute("aria-current")).toBeNull();
  });

  it("scrolls the page to the block when the task column does not scroll itself", async () => {
    addDocumentNeedingIdentity();
    mount();
    const panel = await prioritiesPanel();

    openIdentityTask(panel, IDENTITY_PAGE);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(scrollIntoView.mock.contexts[0]).toBe(identityBlock(IDENTITY_PAGE));
    expect(document.activeElement).toBe(identityBlock(IDENTITY_PAGE));
    expect(document.querySelector<HTMLElement>(".wx-unified-task-column")?.scrollTop).toBe(0);
  });

  it("tells same-titled high-risk rows apart by field, value and page", async () => {
    addHighRiskDiagnoses();
    mount();
    const panel = await prioritiesPanel();

    openCategory(panel, /High-risk clinical information/);

    expect(within(panel).getAllByText("Diagnosis needs high-risk review")).toHaveLength(2);
    expect(
      within(panel).getByText("Diagnosis 1 · description: Dependence on supplemental oxygen · p.1"),
    ).toBeTruthy();
    expect(
      within(panel).getByText("Diagnosis 2 · description: Chronic kidney disease stage 4 · p.1"),
    ).toBeTruthy();
  });

  it("toggles a category from its title and marks the open task's row", async () => {
    addHighRiskDiagnoses();
    mount();
    const panel = await prioritiesPanel();
    const category = within(panel).getByRole("button", { name: /High-risk clinical information/ });

    fireEvent.click(within(panel).getByText("High-risk clinical information"));
    expect(category.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(within(panel).getByText("High-risk clinical information"));
    expect(category.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(category);

    const first = within(panel).getByRole("button", { name: /Diagnosis 1 · description/ });
    const second = within(panel).getByRole("button", { name: /Diagnosis 2 · description/ });
    expect(first.getAttribute("aria-current")).toBeNull();
    fireEvent.click(first);
    expect(first.getAttribute("aria-current")).toBe("true");
    expect(second.getAttribute("aria-current")).toBeNull();
    fireEvent.click(second);
    expect(second.getAttribute("aria-current")).toBe("true");
    expect(first.getAttribute("aria-current")).toBeNull();
  });

  it("opens and marks the category row of a task opened from a field group", async () => {
    const shared = highRiskDiagnosis(DIAGNOSIS_TWO, 0, "Dependence on supplemental oxygen", 2);
    addDocument(2, { status: "match", disagreeing: [], resolution: null });
    workspace.candidates.push(
      highRiskDiagnosis(DIAGNOSIS_ONE, 0, "Dependence on supplemental oxygen"),
      shared,
    );
    mount();
    const panel = await prioritiesPanel();
    const category = within(panel).getByRole("button", { name: /High-risk clinical information/ });
    expect(category.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(await screen.findByRole("button", { name: /Diagnoses & clinical history/ }));
    const group = screen.getByRole("heading", { name: "Diagnosis", level: 3 }).closest("article");
    if (!group) throw new Error("Expected the diagnosis group");
    fireEvent.click(within(group).getByRole("button", { name: /sources for/i }));
    fireEvent.click(
      within(group).getByRole("button", {
        name: "Review Dependence on supplemental oxygen, page 2",
      }),
    );

    expect(
      screen.getByRole("heading", { name: "Diagnosis 1 · description", level: 2 }),
    ).toBeTruthy();
    expect(category.getAttribute("aria-expanded")).toBe("true");
    expect(
      within(panel)
        .getByRole("button", { name: /Diagnosis 1 · description/ })
        .getAttribute("aria-current"),
    ).toBe("true");
  });

  it("reopens the task last opened for this batch after a reload, storing only its id", async () => {
    addDocument(IDENTITY_PAGE, { status: "match", disagreeing: [], resolution: null });
    addEmailCandidate(IDENTITY_PAGE);
    mount();
    expect(await screen.findByRole("heading", { name: "Mobile phone", level: 2 })).toBeTruthy();
    const email = screen.getByRole("heading", { name: "Email", level: 3 }).closest("article");
    if (!email) throw new Error("Expected the email group");
    fireEvent.click(within(email).getByRole("button", { name: EMAIL_REVIEW(IDENTITY_PAGE) }));
    expect(await screen.findByRole("heading", { name: "Email", level: 2 })).toBeTruthy();

    const stored = Object.keys(window.sessionStorage).map((key) =>
      window.sessionStorage.getItem(key),
    );
    expect(stored).toEqual([`candidate:${EMAIL}`]);

    cleanup();
    mount();
    expect(await screen.findByRole("heading", { name: "Email", level: 2 })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Mobile phone", level: 2 })).toBeNull();
  });

  it("reopens a remembered identity block marked, without moving focus or scrolling", async () => {
    addDocumentNeedingIdentity();
    window.sessionStorage.setItem(TASK_KEY, `identity:${IDENTITY_PAGE}`);
    mount();

    const block = await screen.findByRole("group", { name: /Patient identity.*page 2/ });
    expect(block.getAttribute("aria-current")).toBe("true");
    expect(document.activeElement?.closest("[data-safeguard-block]")).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLElement>(".wx-unified-task-column")?.scrollTop).toBe(0);
  });

  it("expands the category and marks the row of a remembered task", async () => {
    addHighRiskDiagnoses();
    window.sessionStorage.setItem(TASK_KEY, `candidate:${DIAGNOSIS_TWO}`);
    mount();
    const panel = await prioritiesPanel();

    const category = within(panel).getByRole("button", { name: /High-risk clinical information/ });
    expect(category.getAttribute("aria-expanded")).toBe("true");
    expect(
      within(panel)
        .getByRole("button", { name: /Diagnosis 2 · description/ })
        .getAttribute("aria-current"),
    ).toBe("true");
  });

  it.each([
    ["a candidate that no longer exists", "candidate:ffffffff-ffff-4fff-8fff-ffffffffffff"],
    ["an identity task that is resolved", "identity:9"],
    ["the Part 2 safeguard, which is never restored", "safeguard:sud"],
  ])("falls back to the default task when the remembered task is %s", async (_label, taskId) => {
    detectSud();
    window.sessionStorage.setItem(TASK_KEY, taskId);
    mount();

    expect(await screen.findByRole("heading", { name: "Mobile phone", level: 2 })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Part 2 / SUD safeguard" })).toBeNull();
  });

  it("does not persist the Part 2 safeguard and forgets the task it replaces", async () => {
    detectSud();
    addDocument(IDENTITY_PAGE, { status: "match", disagreeing: [], resolution: null });
    addEmailCandidate(IDENTITY_PAGE);
    mount();
    const panel = await prioritiesPanel();
    const email = screen.getByRole("heading", { name: "Email", level: 3 }).closest("article");
    if (!email) throw new Error("Expected the email group");
    fireEvent.click(within(email).getByRole("button", { name: EMAIL_REVIEW(IDENTITY_PAGE) }));
    expect(window.sessionStorage.getItem(TASK_KEY)).toBe(`candidate:${EMAIL}`);

    openSudTask(panel);

    expect(Object.keys(window.sessionStorage)).toEqual([]);
    cleanup();
    mount();
    expect(await screen.findByRole("heading", { name: "Mobile phone", level: 2 })).toBeTruthy();
  });

  it("marks nothing in the safeguard panel when a task without a block replaces the SUD block", async () => {
    detectSud();
    addDocument(SECOND_IDENTITY_PAGE, {
      status: "possible",
      disagreeing: [],
      resolution: "other_patient",
    });
    mount();
    const panel = await prioritiesPanel();
    openSudTask(panel);
    expect(sudBlock().getAttribute("aria-current")).toBe("true");

    openCategory(panel, /^Patient identity \d+ task/);
    const excluded = within(panel).getByRole("button", {
      name: /Another patient's document is excluded/,
    });
    fireEvent.click(excluded);

    expect(sudBlock().getAttribute("aria-current")).toBeNull();
    expect(excluded.getAttribute("aria-current")).toBe("true");
    expect(
      within(panel)
        .getByRole("button", { name: /Part 2 \/ SUD safeguard is unresolved/ })
        .getAttribute("aria-current"),
    ).toBeNull();
  });

  it("keeps the list, the panel and the remembered task on the block whose source was chosen", async () => {
    detectSud();
    addDocumentNeedingIdentity();
    mount();
    const panel = await prioritiesPanel();
    openIdentityTask(panel, IDENTITY_PAGE);
    expect(window.sessionStorage.getItem(TASK_KEY)).toBe(`identity:${IDENTITY_PAGE}`);

    fireEvent.click(
      within(sudBlock()).getByRole("button", { name: `Review source page ${SUD_PAGE}` }),
    );

    expect(sudBlock().getAttribute("aria-current")).toBe("true");
    expect(identityBlock(IDENTITY_PAGE).getAttribute("aria-current")).toBeNull();
    expect(
      within(panel)
        .getByRole("button", { name: /Part 2 \/ SUD safeguard is unresolved/ })
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(
      within(panel)
        .getByRole("button", { name: /Patient identity needs review on page 2/ })
        .getAttribute("aria-current"),
    ).toBeNull();
    expect(window.sessionStorage.getItem(TASK_KEY)).toBeNull();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("treats a page image that finished loading before the effects ran as loaded", async () => {
    // A cached image fires `load` before React's passive reset effect; the reset must not undo it.
    const restoreComplete = overrideImageProperty("complete", true);
    const restoreWidth = overrideImageProperty("naturalWidth", 612);
    try {
      addDocumentNeedingIdentity();
      window.sessionStorage.setItem(TASK_KEY, `identity:${IDENTITY_PAGE}`);
      mount();

      await screen.findByRole("img", { name: "Page 2 of the safeguard source document" });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Same patient" })).toBeEnabled(),
      );
      expect(screen.getByRole("button", { name: "Another patient" })).toBeEnabled();
    } finally {
      restoreWidth();
      restoreComplete();
    }
  });

  it("keeps the safeguard panel open when the workspace refreshes after an identity save", async () => {
    detectSud();
    addDocumentNeedingIdentity(IDENTITY_PAGE);
    addDocumentNeedingIdentity(SECOND_IDENTITY_PAGE);
    mount();
    const panel = await prioritiesPanel();
    openIdentityTask(panel, IDENTITY_PAGE);
    const second = identityBlock(SECOND_IDENTITY_PAGE);
    fireEvent.click(
      within(second).getByRole("button", { name: `Review source page ${SECOND_IDENTITY_PAGE}` }),
    );
    fireEvent.load(
      await screen.findByRole("img", {
        name: `Page ${SECOND_IDENTITY_PAGE} of the safeguard source document`,
      }),
    );
    await waitFor(() =>
      expect(within(second).getByRole("button", { name: "Same patient" })).toBeEnabled(),
    );
    fireEvent.click(within(second).getByRole("button", { name: "Same patient" }));
    fireEvent.change(within(second).getByLabelText("Reason"), { target: { value: REASON } });
    fireEvent.click(within(second).getByRole("button", { name: "Save identity resolution" }));

    await waitFor(() =>
      expect(screen.queryByRole("group", { name: /Patient identity.*page 3/ })).toBeNull(),
    );
    expect(screen.getByRole("heading", { name: "Documents & protected information" })).toBeTruthy();
    expect(screen.queryByText("Select a review task")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Mobile phone", level: 2 })).toBeNull();
    expect(document.activeElement?.hasAttribute("data-safeguard-block")).toBe(false);
  });

  it("opens no task for a row without a block and forgets the remembered task", async () => {
    window.sessionStorage.setItem(TASK_KEY, `candidate:${PHONE}`);
    workspace.review = {
      id: "review-1",
      status: "in_progress",
      reviewerMembershipId: "membership-2",
      isMine: false,
    };
    mount();
    const panel = await prioritiesPanel();
    expect(await screen.findByRole("heading", { name: "Mobile phone", level: 2 })).toBeTruthy();

    openCategory(panel, /Other review requirements/);
    fireEvent.click(
      within(panel).getByRole("button", { name: /Another reviewer owns this review/ }),
    );

    expect(screen.getByRole("heading", { name: "Documents & protected information" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Mobile phone", level: 2 })).toBeNull();
    expect(window.sessionStorage.getItem(TASK_KEY)).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement?.closest("[data-safeguard-block]")).toBeNull();
    expect(
      within(panel)
        .getByRole("button", { name: /Another reviewer owns this review/ })
        .getAttribute("aria-current"),
    ).toBe("true");
  });

  it("opens the safeguard panel for an extraction that is unavailable", async () => {
    workspace.jobs.push({
      id: "job-failed",
      documentType: "discharge_summary",
      status: "failed",
      pageFrom: 5,
      pageTo: 5,
      failureReason: null,
    });
    mount();
    const panel = await prioritiesPanel();
    openCategory(panel, /Other review requirements/);

    fireEvent.click(
      within(panel).getByRole("button", { name: /Extraction unavailable for page 5/ }),
    );

    expect(screen.getByRole("heading", { name: "Documents & protected information" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Mobile phone", level: 2 })).toBeNull();
  });
});
