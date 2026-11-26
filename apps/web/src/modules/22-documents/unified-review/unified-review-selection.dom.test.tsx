// What a refresh, a second batch, a save in flight and a support session do to the task that is open
// in the unified review, and what is remembered for a reload.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LAST_REVIEW_TASK_KEY_PREFIX } from "../../../shell/last-review-task";
import { SessionProvider } from "../../../shell/session";
import type { Candidate, Workspace } from "../doclens-api";
import { candidateFixture, workspaceFixture } from "./review-workspace-fixtures";
import { UnifiedReviewWorkspace } from "./unified-review-workspace";

const BATCH_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const BATCH_B = "dddddddd-4444-4444-8444-dddddddddddd";
const PHONE_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const EMAIL_ID = "cccccccc-3333-4333-8333-cccccccccccc";
const SUPPORT_SESSION = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
const SUPPORT_ORGANIZATION = "ffffffff-6666-4666-8666-ffffffffffff";
const PHONE_REVIEW = "Review (503) 555-0177, page 1";
const EMAIL_REVIEW = "Review synthetic@example.test, page 2";
const SUPPORT_ENTRY = `/intake/${BATCH_A}/review?supportOrganizationId=${SUPPORT_ORGANIZATION}&supportSessionId=${SUPPORT_SESSION}`;

let workspaces: Record<string, Workspace> = {};
let workspaceStatus = 200;
let workspaceReads = 0;
let imageStatus = 200;
let startRejects = false;
let decisionRelease: (() => void) | null = null;
let holdDecision = false;

function phone(overrides: Partial<Candidate> = {}): Candidate {
  return candidateFixture("patient.phoneMobile", "(503) 555-0177", {
    id: PHONE_ID,
    page: 1,
    ...overrides,
  });
}

function email(overrides: Partial<Candidate> = {}): Candidate {
  return candidateFixture("patient.email", "synthetic@example.test", {
    id: EMAIL_ID,
    page: 2,
    ...overrides,
  });
}

function batchWorkspace(
  batchId: string,
  patientName: string,
  candidates: readonly Candidate[],
  overrides: Partial<Workspace> = {},
): Workspace {
  const base = workspaceFixture(candidates, overrides);
  return { ...base, batch: { ...base.batch, id: batchId, patientName } };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function answerDecision(request: Request, batchId: string): Promise<Response> {
  const body = (await request.clone().json()) as { candidateId: string };
  if (holdDecision)
    await new Promise<void>((resolve) => {
      decisionRelease = resolve;
    });
  const candidate = workspaces[batchId]?.candidates.find((item) => item.id === body.candidateId);
  if (candidate)
    candidate.decision = {
      id: `decision-${body.candidateId}`,
      decision: "approve",
      editedValue: null,
      reason: null,
      partOfBulkApprove: false,
      decidedAt: "2026-11-22T11:00:00.000Z",
    };
  return jsonResponse({});
}

const fetchStub = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  const request =
    input instanceof Request
      ? input
      : new Request(new URL(String(input), "http://localhost").toString());
  const path = new URL(request.url, "http://localhost").pathname;
  const batchId = /\/uploads\/([^/]+)\//.exec(path)?.[1] ?? "";
  if (path.endsWith("/workspace")) {
    workspaceReads += 1;
    const found = workspaces[batchId];
    return workspaceStatus === 200 && found
      ? jsonResponse(found)
      : new Response("unavailable", { status: workspaceStatus === 200 ? 404 : workspaceStatus });
  }
  if (request.method === "POST" && path.endsWith("/review")) {
    if (startRejects) throw new Error("synthetic transport failure");
    const found = workspaces[batchId];
    if (found)
      found.review = {
        id: "review-1",
        status: "in_progress",
        reviewerMembershipId: "membership-1",
        isMine: true,
      };
    return jsonResponse({});
  }
  if (request.method === "POST" && path.endsWith("/decisions"))
    return await answerDecision(request, batchId);
  return new Response(imageStatus === 200 ? new Uint8Array([1]) : "unavailable", {
    status: imageStatus,
    headers: { "content-type": imageStatus === 200 ? "image/png" : "text/plain" },
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

function mount(entry = `/intake/${BATCH_A}/review`): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: fetchStub })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter initialEntries={[entry]}>
            <Link to={`/intake/${BATCH_B}/review`}>Go to batch B</Link>
            <Routes>
              <Route path="/intake/:batchId/review" element={<UnifiedReviewWorkspace />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

const storedTasks = (): (string | null)[] =>
  Object.keys(window.sessionStorage).map((key) => window.sessionStorage.getItem(key));

const prioritiesPanel = async (): Promise<HTMLElement> =>
  await screen.findByRole("complementary", { name: "Review priorities" });

/** A task that is open already opened the category holding its row; only click a closed one. */
function openCategory(panel: HTMLElement, name: RegExp): void {
  const category = within(panel).getByRole("button", { name });
  if (category.getAttribute("aria-expanded") !== "true") fireEvent.click(category);
}

beforeEach(() => {
  workspaces = {
    [BATCH_A]: batchWorkspace(BATCH_A, "Synthetic Alpha", [phone(), email()]),
    [BATCH_B]: batchWorkspace(BATCH_B, "Synthetic Beta", [
      candidateFixture("patient.email", "beta@example.test", { page: 1 }),
    ]),
  };
  workspaceStatus = 200;
  workspaceReads = 0;
  imageStatus = 200;
  startRejects = false;
  holdDecision = false;
  decisionRelease = null;
  fetchStub.mockClear();
  window.sessionStorage.clear();
  vi.stubGlobal("fetch", fetchStub);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a second batch on the same route", () => {
  it("shows the new batch's task and drops the first batch's source state", async () => {
    imageStatus = 503;
    mount();
    fireEvent.error(await screen.findByRole("img", { name: /Page 1 of the source document/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Source page could not be loaded");
    openCategory(await prioritiesPanel(), /Other review requirements/);
    expect(await screen.findByText("Source page 1 is unavailable")).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "Go to batch B" }));

    expect(await screen.findByRole("heading", { name: "Email", level: 2 })).toBeTruthy();
    expect(document.body.textContent).toContain("Synthetic Beta");
    expect(document.body.textContent).not.toContain("Synthetic Alpha");
    expect(screen.queryByText("Source page 1 is unavailable")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Mobile phone", level: 2 })).toBeNull();
    const image = screen.getByRole("img", { name: /Page 1 of the source document/ });
    expect(image.getAttribute("src")).toContain(`/uploads/${BATCH_B}/pages/1/image`);
  });
});

describe("what a refresh keeps", () => {
  it("does not reopen a task the reviewer closed when a support session revalidates", async () => {
    mount(SUPPORT_ENTRY);
    expect(await screen.findByRole("heading", { name: "Mobile phone", level: 2 })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Close task/ }));
    expect(screen.getByText("Select a review task")).toBeTruthy();

    fireEvent.focus(window);
    await waitFor(() => expect(workspaceReads).toBe(2));

    expect(await screen.findByText("Select a review task")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Mobile phone", level: 2 })).toBeNull();
  });

  it("keeps the marked safeguard block, without scrolling again, after a support revalidation", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      value: scrollIntoView,
      configurable: true,
      writable: true,
    });
    try {
      workspaces[BATCH_A] = batchWorkspace(BATCH_A, "Synthetic Alpha", [phone()], {
        sud: {
          status: "detected",
          detectorRef: null,
          resolvedAt: null,
          resolvedByMembershipId: null,
          contentRedacted: false,
          indicators: [
            { page: 1, category: "sud", ruleId: "r1", term: "synthetic term", bbox: [1, 1, 2, 2] },
          ],
        },
      });
      mount(SUPPORT_ENTRY);
      const panel = await prioritiesPanel();
      openCategory(panel, /Part 2 \/ SUD safeguards/);
      fireEvent.click(
        within(panel).getByRole("button", { name: /Part 2 \/ SUD safeguard is unresolved/ }),
      );
      expect(scrollIntoView).toHaveBeenCalledTimes(1);

      fireEvent.focus(window);
      await waitFor(() => expect(workspaceReads).toBe(2));

      const block = await screen.findByRole("group", { name: "Part 2 / SUD safeguard" });
      expect(block.getAttribute("aria-current")).toBe("true");
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });

  it("restores the remembered task when the first load failed and Retry succeeds", async () => {
    window.sessionStorage.setItem(
      `${LAST_REVIEW_TASK_KEY_PREFIX}${BATCH_A}`,
      `candidate:${EMAIL_ID}`,
    );
    workspaceStatus = 503;
    mount();
    expect(await screen.findByText("Review unavailable")).toBeTruthy();

    workspaceStatus = 200;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("heading", { name: "Email", level: 2 })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Mobile phone", level: 2 })).toBeNull();
  });
});

describe("closing a task", () => {
  it("forgets the remembered task, returns focus to the control that opened it and shows the empty state", async () => {
    mount();
    const open = await screen.findByRole("button", { name: EMAIL_REVIEW });
    open.focus();
    fireEvent.click(open);
    expect(await screen.findByRole("heading", { name: "Email", level: 2 })).toBeTruthy();
    expect(storedTasks()).toEqual([`candidate:${EMAIL_ID}`]);

    fireEvent.click(screen.getByRole("button", { name: /Close task/ }));

    expect(screen.getByText("Select a review task")).toBeTruthy();
    expect(document.activeElement).toBe(open);
    expect(storedTasks()).toEqual([]);
  });

  it("returns focus to the Review button that opened the task, even where a click does not focus it", async () => {
    mount();
    const open = await screen.findByRole("button", { name: EMAIL_REVIEW });
    fireEvent.click(open);
    expect(await screen.findByRole("heading", { name: "Email", level: 2 })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Close task/ }));

    expect(document.activeElement).toBe(open);
  });

  it("returns focus to the priorities row that opened the task, even where a click does not focus it", async () => {
    mount();
    const panel = await prioritiesPanel();
    openCategory(panel, /Other review requirements/);
    const row = within(panel).getByRole("button", { name: /Email needs a decision/ });
    fireEvent.click(row);
    expect(await screen.findByRole("heading", { name: "Email", level: 2 })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Close task/ }));

    expect(document.activeElement).toBe(row);
  });

  it("falls back to the task column when the control that opened the task is gone", async () => {
    mount();
    const panel = await prioritiesPanel();
    openCategory(panel, /Other review requirements/);
    fireEvent.click(within(panel).getByRole("button", { name: /Email needs a decision/ }));
    expect(await screen.findByRole("heading", { name: "Email", level: 2 })).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: /Other review requirements/ }));
    expect(within(panel).queryByRole("button", { name: /Email needs a decision/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Close task/ }));

    expect(document.activeElement?.classList.contains("wx-unified-task-column")).toBe(true);
  });

  it("opens the default task, not the closed one, after a reload", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: EMAIL_REVIEW }));
    expect(await screen.findByRole("heading", { name: "Email", level: 2 })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Close task/ }));

    cleanup();
    mount();

    expect(await screen.findByRole("heading", { name: "Mobile phone", level: 2 })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Email", level: 2 })).toBeNull();
  });
});

describe("what is remembered", () => {
  it("never remembers a withheld Part 2 field and forgets the task it replaces", async () => {
    workspaces[BATCH_A] = batchWorkspace(BATCH_A, "Synthetic Alpha", [
      email(),
      phone({ redacted: true, sudDetected: true, value: null, page: 1 }),
    ]);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: EMAIL_REVIEW }));
    expect(storedTasks()).toEqual([`candidate:${EMAIL_ID}`]);

    const panel = await prioritiesPanel();
    openCategory(panel, /Part 2 \/ SUD safeguards/);
    fireEvent.click(within(panel).getByRole("button", { name: /Mobile phone is withheld/ }));

    expect(await screen.findByRole("heading", { name: "Mobile phone", level: 2 })).toBeTruthy();
    expect(storedTasks()).toEqual([]);
  });

  it("writes and recalls nothing in a platform support session", async () => {
    window.sessionStorage.setItem(
      `${LAST_REVIEW_TASK_KEY_PREFIX}${BATCH_A}`,
      `candidate:${EMAIL_ID}`,
    );
    mount(SUPPORT_ENTRY);

    expect(await screen.findByRole("heading", { name: "Mobile phone", level: 2 })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: EMAIL_REVIEW }));
    expect(await screen.findByRole("heading", { name: "Email", level: 2 })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Close task/ }));

    expect(storedTasks()).toEqual([`candidate:${EMAIL_ID}`]);
    window.sessionStorage.clear();
    fireEvent.click(await screen.findByRole("button", { name: PHONE_REVIEW }));
    expect(storedTasks()).toEqual([]);
  });
});

describe("the priorities list", () => {
  it("shows the row of a task chosen after the reviewer collapsed its category", async () => {
    workspaces[BATCH_A] = batchWorkspace(BATCH_A, "Synthetic Alpha", [
      candidateFixture("diagnoses[0].description", "Heart failure", {
        riskLevel: "high",
        page: 1,
      }),
      candidateFixture("diagnoses[1].description", "Atrial fibrillation", {
        riskLevel: "high",
        page: 2,
      }),
    ]);
    mount();
    const panel = await prioritiesPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Review Heart failure, page 1" }));
    const category = within(panel).getByRole("button", { name: /High-risk clinical information/ });
    expect(category.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(category);
    expect(category.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Review Atrial fibrillation, page 2" }));

    expect(category.getAttribute("aria-expanded")).toBe("true");
    expect(
      within(panel)
        .getByRole("button", { name: /Diagnosis 2 · description/ })
        .getAttribute("aria-current"),
    ).toBe("true");
  });

  it("says so when nothing needs a decision", async () => {
    workspaces[BATCH_A] = batchWorkspace(BATCH_A, "Synthetic Alpha", [
      phone({
        decision: {
          id: "decision-1",
          decision: "approve",
          editedValue: null,
          reason: null,
          partOfBulkApprove: false,
          decidedAt: "2026-11-22T11:00:00.000Z",
        },
      }),
    ]);
    mount();

    expect(await screen.findByText("No projected exceptions.")).toBeTruthy();
  });
});

describe("the page chrome", () => {
  it("names the progress bar and keeps the support banner out of the live regions", async () => {
    mount(SUPPORT_ENTRY);

    expect(await screen.findByRole("progressbar", { name: "Review progress" })).toBeTruthy();
    const banner = screen.getByText("Tenant-consented platform support access");
    expect(banner.closest("output")).toBeNull();
    expect(banner.closest('[role="note"]')).not.toBeNull();
  });

  it("shows an error, not a stuck button, when starting a review cannot reach the server", async () => {
    workspaces[BATCH_A] = batchWorkspace(BATCH_A, "Synthetic Alpha", [phone()], { review: null });
    startRejects = true;
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Start review" }));

    expect(
      await screen.findByText(
        "Could not reach the server. The review may not have started; retry.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start review" })).toBeEnabled();

    startRejects = false;
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(await screen.findByRole("button", { name: "Release review" })).toBeTruthy();
  });
});

describe("a decision in flight", () => {
  async function startAcceptingPhone(): Promise<void> {
    fireEvent.load(await screen.findByRole("img", { name: /Page 1 of the source document/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /I compared this with the source/ }));
    holdDecision = true;
    fireEvent.click(screen.getByRole("button", { name: "Accept extracted value" }));
    await waitFor(() => expect(decisionRelease).not.toBeNull());
  }

  it("keeps the open task until the save has ended", async () => {
    mount();
    await startAcceptingPhone();
    const panel = await prioritiesPanel();
    openCategory(panel, /Other review requirements/);

    expect(within(panel).getByRole("button", { name: /Email needs a decision/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: EMAIL_REVIEW })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Close task/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Release review" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: EMAIL_REVIEW }));
    fireEvent.click(screen.getByRole("button", { name: /Close task/ }));
    expect(screen.getByRole("heading", { name: "Mobile phone", level: 2 })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Email", level: 2 })).toBeNull();

    await act(async () => {
      decisionRelease?.();
    });
    await screen.findByRole("button", { name: /Next issue: Email/ });
    expect(within(panel).getByRole("button", { name: /Email needs a decision/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: EMAIL_REVIEW }));
    expect(await screen.findByRole("heading", { name: "Email", level: 2 })).toBeTruthy();
  });

  it("moves focus to the next task's heading when Next issue is chosen", async () => {
    mount();
    await startAcceptingPhone();
    await act(async () => {
      decisionRelease?.();
    });

    fireEvent.click(await screen.findByRole("button", { name: /Next issue: Email/ }));

    const heading = await screen.findByRole("heading", { name: "Email", level: 2 });
    expect(document.activeElement).toBe(heading);
  });
});
