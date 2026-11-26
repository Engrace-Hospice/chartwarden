// Where opening a review task leads (field task or safeguard block), which row of the priorities list
// is marked, and which task is reopened after a reload.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Workspace } from "../doclens-api";
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
const STAGE_HEIGHT = 300;
const TASK_KEY = `wx.unified-review-task:${BATCH}`;
const REASON = "Identifiers match this synthetic patient";

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

/** Replaces a jsdom accessor on HTMLImageElement.prototype and returns a function that restores it. */
function overrideImageProperty(name: "complete" | "naturalWidth", value: unknown): () => void {
  const proto = HTMLImageElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, name);
  Object.defineProperty(proto, name, { value, configurable: true });
  return () => {
    if (original) Object.defineProperty(proto, name, original);
    else Reflect.deleteProperty(proto, name);
  };
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

  function addDocumentNeedingIdentity(page = IDENTITY_PAGE): void {
    addDocument(page, { status: "possible", disagreeing: ["lastName"], resolution: null });
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
      const height = this.classList.contains("wx-unified-source-stage") ? STAGE_HEIGHT : 0;
      return {
        top,
        bottom: top + height,
        left: 0,
        right: 0,
        width: 0,
        height,
        x: 0,
        y: top,
      } as DOMRect;
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

  function openCategory(panel: HTMLElement, name: RegExp): void {
    fireEvent.click(within(panel).getByRole("button", { name }));
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
    expect(column.scrollTop).toBe(BLOCK_TOP - COLUMN_TOP - STAGE_HEIGHT);
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
    expect(column.scrollTop).toBe(BLOCK_TOP - COLUMN_TOP - STAGE_HEIGHT);
    expect(sudBlock().getAttribute("aria-current")).toBeNull();
  });

  it("scrolls the page to the block when the task column does not scroll itself", async () => {
    addDocumentNeedingIdentity();
    mount();
    const panel = await prioritiesPanel();

    openIdentityTask(panel, IDENTITY_PAGE);

    // With no layout to measure, stage and block fit one viewport: the stage (and so the block) is scrolled to.
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(scrollIntoView.mock.contexts[0]).toBe(
      document.querySelector(".wx-unified-source-stage"),
    );
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

  it("marks the row of the task whose group holds the open observation, and leaves the category as it is", async () => {
    const shared = highRiskDiagnosis(DIAGNOSIS_TWO, 0, "Dependence on supplemental oxygen", 2);
    addDocument(2, { status: "match", disagreeing: [], resolution: null });
    workspace.candidates.push(
      highRiskDiagnosis(DIAGNOSIS_ONE, 0, "Dependence on supplemental oxygen"),
      shared,
    );
    mount();
    const panel = await prioritiesPanel();
    const category = within(panel).getByRole("button", { name: /High-risk clinical information/ });

    fireEvent.click(await screen.findByRole("button", { name: /Diagnoses & clinical history/ }));
    const group = screen.getByRole("heading", { name: "Diagnosis", level: 3 }).closest("article");
    if (!group) throw new Error("Expected the diagnosis group");
    fireEvent.click(within(group).getByRole("button", { name: /Show sources for/ }));
    const second = within(group).getAllByRole("button", { name: /Review decision/ })[1];
    if (!second) throw new Error("Expected a second observation");
    fireEvent.click(second);

    expect(
      screen.getByRole("heading", { name: "Diagnosis 1 · description", level: 2 }),
    ).toBeTruthy();
    expect(category.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(category);
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
    fireEvent.click(within(email).getByRole("button", { name: /Review decision/ }));
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
    fireEvent.click(within(email).getByRole("button", { name: /Review decision/ }));
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
    openCategory(panel, /Part 2 \/ SUD safeguards/);
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

  it("does not re-focus a stale safeguard block when the task closes after a candidate was auto-selected", async () => {
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
    expect(await screen.findByRole("heading", { name: "Mobile phone", level: 2 })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Close task/ }));

    // Closing a field task leaves nothing open; it must not bring back a safeguard block of its own.
    await screen.findByRole("heading", { name: "Select a review task" });
    expect(document.querySelector("[data-safeguard-block]")).toBeNull();
    expect(document.activeElement?.closest("[data-safeguard-block]")).toBeNull();
  });

  it("restores the jsdom image accessors it overrides", () => {
    const proto = HTMLImageElement.prototype;
    const before = {
      complete: Object.getOwnPropertyDescriptor(proto, "complete"),
      naturalWidth: Object.getOwnPropertyDescriptor(proto, "naturalWidth"),
    };

    overrideImageProperty("complete", true)();
    overrideImageProperty("naturalWidth", 612)();

    expect(Object.getOwnPropertyDescriptor(proto, "complete")).toEqual(before.complete);
    expect(Object.getOwnPropertyDescriptor(proto, "naturalWidth")).toEqual(before.naturalWidth);
  });

  it("keeps focus inside the block when its 'Review source page' button goes away", async () => {
    detectSud();
    addDocumentNeedingIdentity();
    mount();
    const panel = await prioritiesPanel();
    openIdentityTask(panel, IDENTITY_PAGE);

    fireEvent.click(
      within(sudBlock()).getByRole("button", { name: `Review source page ${SUD_PAGE}` }),
    );

    expect(
      within(sudBlock()).queryByRole("button", { name: `Review source page ${SUD_PAGE}` }),
    ).toBeNull();
    expect(document.activeElement).toBe(sudBlock());
  });

  it("marks exactly one block, even when a SUD indicator and an identity block share a page", async () => {
    detectSud();
    const [first] = workspace.documents;
    if (!first) throw new Error("Expected the synthetic document");
    first.identity = { status: "possible", disagreeing: [], resolution: null };
    mount();
    const panel = await prioritiesPanel();
    const marked = (): string[] =>
      [
        ...document.querySelectorAll<HTMLElement>('[data-safeguard-block][data-selected="true"]'),
      ].map((block) => block.dataset.safeguardBlock ?? "");

    openIdentityTask(panel, SUD_PAGE);
    expect(marked()).toEqual([`identity-${SUD_PAGE}`]);

    fireEvent.click(screen.getByRole("button", { name: /Documents & safeguards/ }));
    expect(marked()).toEqual([]);

    openSudTask(panel);
    expect(marked()).toEqual(["sud"]);
  });

  it("neither stores nor keeps a withheld candidate as the last opened task", async () => {
    addDocument(IDENTITY_PAGE, { status: "match", disagreeing: [], resolution: null });
    addEmailCandidate(IDENTITY_PAGE);
    phoneCandidate().redacted = true;
    phoneCandidate().sudDetected = true;
    mount();
    const panel = await prioritiesPanel();
    const email = screen.getByRole("heading", { name: "Email", level: 3 }).closest("article");
    if (!email) throw new Error("Expected the email group");
    fireEvent.click(within(email).getByRole("button", { name: /Review decision/ }));
    expect(window.sessionStorage.getItem(TASK_KEY)).toBe(`candidate:${EMAIL}`);

    openCategory(panel, /Part 2 \/ SUD safeguards/);
    fireEvent.click(within(panel).getByRole("button", { name: /Mobile phone is withheld/ }));

    expect(Object.keys(window.sessionStorage)).toEqual([]);
  });

  it("forgets the remembered task when its task is closed", async () => {
    addDocument(IDENTITY_PAGE, { status: "match", disagreeing: [], resolution: null });
    addEmailCandidate(IDENTITY_PAGE);
    mount();
    await prioritiesPanel();
    const email = screen.getByRole("heading", { name: "Email", level: 3 }).closest("article");
    if (!email) throw new Error("Expected the email group");
    fireEvent.click(within(email).getByRole("button", { name: /Review decision/ }));
    expect(window.sessionStorage.getItem(TASK_KEY)).toBe(`candidate:${EMAIL}`);

    fireEvent.click(screen.getByRole("button", { name: /Close task/ }));

    expect(Object.keys(window.sessionStorage)).toEqual([]);
    cleanup();
    mount();
    expect(await screen.findByRole("heading", { name: "Mobile phone", level: 2 })).toBeTruthy();
  });

  it("forgets the remembered task when the safeguards section replaces it", async () => {
    addDocumentNeedingIdentity();
    mount();
    const panel = await prioritiesPanel();
    openIdentityTask(panel, IDENTITY_PAGE);
    expect(window.sessionStorage.getItem(TASK_KEY)).toBe(`identity:${IDENTITY_PAGE}`);

    fireEvent.click(screen.getByRole("button", { name: /Documents & safeguards/ }));

    expect(Object.keys(window.sessionStorage)).toEqual([]);
  });
});
