// apps/web/src/modules/25-remittance — milestone 8a-1 ADR documentation readiness (advisory). Asserts on RECORDED FETCH
// CALLS like the other M25 write tests. The properties that matter: the deterministic gaps always show; with the AI
// check unavailable the panel says so in one sentence and nothing is blocked or errored; an AI review is always
// labelled advisory; a disposition is one POST; a user without the read key sees no section at all.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdrReadinessPanel } from "./adr-readiness-panel";

const ADR = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const DOC = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
const FINDING = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const KEYS = [
  "certification_of_terminal_illness",
  "election_statement",
  "plan_of_care",
  "physician_orders",
  "visit_notes",
  "medical_records_cover",
];

type Call = { method: string; path: string; body: Record<string, unknown> };
let calls: Call[] = [];
let readStatus = 200;
let caseState = "in_assembly";
let review: Record<string, unknown> | null = null;
/** When set, every POST answers with this refusal. */
let postFailure: { status: number; message: string } | null = null;
/** When set, POSTs wait on it before answering (to hold an action in flight). */
let postGate: Promise<void> | null = null;
/** Per-ADR hold on the GET, to deliver responses out of order. */
const getGates = new Map<string, Promise<void>>();
const stateByAdr = new Map<string, string>();

const keyGaps = () =>
  KEYS.map((checklistKey) =>
    checklistKey === "plan_of_care"
      ? { checklistKey, status: "documents_attached", documentIds: [DOC], isGap: false }
      : { checklistKey, status: "no_document_attached", documentIds: [], isGap: true },
  );
const view = () => ({
  adrCaseId: ADR,
  caseState,
  caseVersion: 4,
  generatedAt: "2026-02-01T00:00:00.000Z",
  gaps: { keys: keyGaps(), unmappedDocumentIds: [] },
  review,
});
const aiReview = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  status: "ready",
  source: "ai",
  requestedAt: "2026-02-01T00:00:00.000Z",
  requestedByMembershipId: "m1",
  stale: false,
  unavailableReason: null,
  droppedFindingCount: 0,
  modelVersionPin: "pin",
  promptTemplateVersion: "v1",
  allDisposed: false,
  findings: [
    {
      id: FINDING,
      checklistKey: "plan_of_care",
      status: "looks_present",
      citedDocumentIds: [DOC],
      note: "Appears on page 2.",
      disposition: null,
      disposedAt: null,
      disposedByMembershipId: null,
    },
  ],
  ...over,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === "object" && "url" in input ? (input as Request) : null;
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  const path = new URL(req ? req.url : String(input), "http://localhost").pathname;
  if (method !== "GET") {
    if (postGate) await postGate;
    if (postFailure) {
      calls.push({ method, path, body: {} });
      return json(postFailure.status, { error: { code: "X", message: postFailure.message } });
    }
    const raw = req ? await req.clone().text() : typeof init?.body === "string" ? init.body : "";
    calls.push({ method, path, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
    if (path.endsWith("/reviews")) {
      review = {
        ...aiReview({ status: "unavailable", source: "deterministic", findings: [] }),
        unavailableReason: "capability_unavailable",
      };
      return json(201, {
        reviewId: "r1",
        status: "unavailable",
        source: "deterministic",
        findingCount: 0,
      });
    }
    return json(200, { id: FINDING, disposition: "disputed" });
  }
  const adrInPath = /\/adrs\/([^/]+)\/readiness/.exec(path)?.[1] ?? ADR;
  const gate = getGates.get(adrInPath);
  if (gate) await gate;
  if (readStatus !== 200) {
    return json(readStatus, { error: { code: "X", message: "not for you" } });
  }
  return json(200, {
    ...view(),
    adrCaseId: adrInPath,
    caseState: stateByAdr.get(adrInPath) ?? caseState,
  });
}

function mount(): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <MemoryRouter>
        <AdrReadinessPanel adrId={ADR} packetVersion={4} />
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

beforeEach(() => {
  calls = [];
  readStatus = 200;
  caseState = "in_assembly";
  review = null;
  postFailure = null;
  postGate = null;
  getGates.clear();
  stateByAdr.clear();
});
afterEach(() => cleanup());

describe("M25 ADR documentation readiness panel", () => {
  it("always shows the deterministic gaps, and states the section is advisory", async () => {
    mount();
    expect(
      await screen.findByRole("list", { name: "Checklist items and attached documents" }),
    ).toBeTruthy();
    expect(screen.getAllByText("No document attached")).toHaveLength(5);
    expect(screen.getAllByText("Document attached")).toHaveLength(1);
    expect(
      screen.getByText(/never changes the checklist and never blocks sign-off or filing/i),
    ).toBeTruthy();
    expect(screen.queryByText(/AI-generated/i)).toBeNull();
  });

  it("with the AI check unavailable says so in one sentence, with no error alert and no blocked control", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Run the AI check" }));
    expect(
      await screen.findByText(/AI check unavailable; the manual checklist is unchanged/),
    ).toBeTruthy();
    expect(calls).toEqual([
      { method: "POST", path: `/api/v1/adrs/${ADR}/readiness/reviews`, body: {} },
    ]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Run the AI check again" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(screen.getAllByText("No document attached")).toHaveLength(5);
  });

  it("labels an AI review as advisory, links the cited document, and records a disposition with one POST", async () => {
    review = aiReview();
    mount();
    expect(await screen.findByText(/AI-generated, advisory, and may be wrong/)).toBeTruthy();
    expect(screen.getByText(/Appears on page 2\./)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Document 1" });
    expect(link.getAttribute("href")).toBe(`/documents/${DOC}/versions`);
    fireEvent.click(screen.getByRole("button", { name: "Report as wrong: Plan Of Care" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      method: "POST",
      path: `/api/v1/adrs/${ADR}/readiness/findings/${FINDING}/disposition`,
      body: { disposition: "disputed" },
    });
  });

  it("tells the user when the packet changed after the AI check", async () => {
    review = aiReview({ stale: true });
    mount();
    expect(await screen.findByText(/The packet changed after this AI check ran/)).toBeTruthy();
  });

  it("offers no request button once the case is out of assembly and review", async () => {
    caseState = "submitted";
    mount();
    await screen.findByRole("list", { name: "Checklist items and attached documents" });
    expect(screen.queryByRole("button", { name: /Run the AI check/ })).toBeNull();
  });

  it("renders nothing for a user who may not read it", async () => {
    readStatus = 403;
    mount();
    await waitFor(() => expect(screen.queryByText(/Loading documentation readiness/)).toBeNull());
    expect(screen.queryByRole("region", { name: "Documentation readiness" })).toBeNull();
  });

  it("keeps an action's error on screen after the reload, and clears it on the next action", async () => {
    postFailure = { status: 409, message: "the packet changed" };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Run the AI check" }));
    expect(await screen.findByText("the packet changed")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Working…")).toBeNull());
    expect(screen.getByText("the packet changed")).toBeTruthy();
    postFailure = null;
    fireEvent.click(screen.getByRole("button", { name: "Run the AI check" }));
    await waitFor(() => expect(screen.queryByText("the packet changed")).toBeNull());
  });

  it("ignores a second click while an action is in flight", async () => {
    let release: () => void = () => {};
    postGate = new Promise<void>((r) => {
      release = r;
    });
    mount();
    const button = await screen.findByRole("button", { name: "Run the AI check" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(await screen.findByText("Working…")).toBeTruthy();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    release();
    await waitFor(() => expect(screen.queryByText("Working…")).toBeNull());
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("does not let a slow response for one ADR leak into another, and a 403 on one does not hide the next", async () => {
    const ADR_B = "cccccccc-3333-4333-8333-cccccccccccc";
    let releaseA: () => void = () => {};
    getGates.set(
      ADR,
      new Promise<void>((r) => {
        releaseA = r;
      }),
    );
    stateByAdr.set(ADR_B, "submitted");
    const client = createApiClient({ baseUrl: "http://localhost", fetch: stubFetch });
    const panel = (id: string) => (
      <ApiClientProvider client={client}>
        <MemoryRouter>
          <AdrReadinessPanel key={id} adrId={id} packetVersion={4} />
        </MemoryRouter>
      </ApiClientProvider>
    );
    const { rerender } = render(panel(ADR));
    rerender(panel(ADR_B));
    await screen.findByRole("list", { name: "Checklist items and attached documents" });
    releaseA(); // ADR A's older response arrives last
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: /Run the AI check/ })).toBeNull();

    readStatus = 403;
    rerender(panel(ADR));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Documentation readiness" })).toBeNull(),
    );
    readStatus = 200;
    rerender(panel(ADR_B));
    expect(await screen.findByRole("region", { name: "Documentation readiness" })).toBeTruthy();
  });

  it("treats a transient 404 as a retryable error, not a hidden section", async () => {
    readStatus = 404;
    mount();
    expect(await screen.findByText("not for you")).toBeTruthy();
    readStatus = 200;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("list", { name: "Checklist items and attached documents" }),
    ).toBeTruthy();
    expect(screen.queryByText("not for you")).toBeNull();
  });

  it.each([
    ["requested", /AI check in progress/],
    ["failed", /AI check failed/],
    ["mystery", /AI check not completed/],
  ])("maps review status %s to its own line and shows no findings", async (status, text) => {
    review = aiReview({ status });
    mount();
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "AI findings" })).toBeNull();
    expect(screen.queryByText(/reported nothing/)).toBeNull();
  });

  it("shows the advisory warning whenever findings are shown, whatever the source", async () => {
    review = aiReview({ source: "deterministic" });
    mount();
    expect(await screen.findByText(/AI-generated, advisory, and may be wrong/)).toBeTruthy();
  });

  it("never says the documentation is complete or sufficient", async () => {
    review = aiReview({ findings: [] });
    mount();
    expect(
      await screen.findByText(/This is not confirmation that the documentation is complete/),
    ).toBeTruthy();
    cleanup();
    review = null;
    mount();
    await screen.findByRole("list", { name: "Checklist items and attached documents" });
    expect(screen.queryByText(/complete\.$/)).toBeNull();
  });

  it("offers no response on a stale review or an already-answered finding", async () => {
    review = aiReview({ stale: true });
    mount();
    expect(await screen.findByText(/Run the AI check again to record a response/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Report as wrong/ })).toBeNull();
  });
});
