// apps/web/src/modules/25-remittance — milestone 4 QIC reconsideration. Asserts on RECORDED FETCH CALLS (method, path,
// If-Match, body) like the other M25 write tests, so a control wired to a handler that never fires still fails. The
// server owns every rule and its refusal is shown verbatim; the escalation form survives step-up; a missing QIC
// receipt date is a visible state, never a blank, and offers no escalation.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { AppealDetailPanel } from "./appeal-detail-panel";

const APPEAL = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const DENIAL = "dddddddd-4444-4444-8444-dddddddddddd";
const CLAIM = "cccccccc-3333-4333-8333-cccccccccccc";
const NOTICE_DOC = "11111111-1111-4111-8111-111111111111";
const NOTE_DOC = "22222222-2222-4222-8222-222222222222";
const ME = "ffffffff-6666-4666-8666-ffffffffffff";

type Call = { method: string; path: string; ifMatch: string | null; body: Record<string, unknown> };
let calls: Call[] = [];
let refusal: { status: number; body: unknown } | null = null;
let gets: string[] = [];
let tier = "reconsideration";
let state = "draft";
let filedByEscalation = false;
let qic: Record<string, unknown> = {};

const baseQic = (over: Record<string, unknown> = {}) => ({
  id: APPEAL,
  kind: "reconsideration",
  tier: "reconsideration",
  state,
  version: 4,
  redeterminationNoticeDate: "2026-02-01",
  citedEvidence: [],
  citedEvidenceNone: false,
  evidenceEditable: state === "draft",
  clock: null,
  escalation: null,
  escalationEligible: false,
  escalationBlockedReason: null,
  nextAppealCaseId: null,
  escalatedFromAppealCaseId: null,
  ...over,
});
const clockBody = (over: Record<string, unknown> = {}) => ({
  receivedOn: "2026-01-05",
  baseDays: 60,
  extensionDays: 0,
  extensions: [],
  decisionDueOn: "2026-03-06",
  decisionDueAt: "2026-03-07T04:59:59.999Z",
  zone: "America/New_York",
  overdue: false,
  daysOverdue: 0,
  ...over,
});

const appealBody = () => ({
  id: APPEAL,
  denialCaseId: DENIAL,
  claimId: CLAIM,
  tier,
  state,
  decisionOutcome: null,
  tierDeadlineAt: "2026-08-01T00:00:00.000Z",
  noticeDatedOn: "2026-02-01",
  presumedReceiptOn: "2026-02-06",
  windowDays: 180,
  lastFilingDay: "2026-08-05",
  filedByEscalation,
  version: 4,
  appealPacketDocumentId: null,
  submittedAt: null,
  decidedAt: null,
  events: [],
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === "object" && "url" in input ? (input as Request) : null;
  const url = req ? req.url : String(input);
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  const path = new URL(url, "http://localhost").pathname;
  if (method !== "GET") {
    const raw = req ? await req.clone().text() : typeof init?.body === "string" ? init.body : "";
    calls.push({
      method,
      path,
      ifMatch: req?.headers.get("if-match") ?? null,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    });
    if (refusal) return json(refusal.status, refusal.body);
    return json(200, {
      id: APPEAL,
      version: 5,
      nextAppealCaseId: "eeeeeeee-5555-4555-8555-eeeeeeeeeeee",
    });
  }
  gets.push(path);
  if (path === `/api/v1/appeals/${APPEAL}`) return json(200, appealBody());
  if (path === `/api/v1/appeals/${APPEAL}/qic`) return json(200, qic);
  return json(200, {});
}

const SESSION = {
  roles: ["billing_specialist"],
  permissions: [],
  isAdmin: false,
  userId: "user-1",
  organizationId: "org-1",
  membershipId: ME,
};

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{`${loc.pathname}${loc.search}`}</div>;
}

function mount(): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/work"]}>
            <Routes>
              <Route
                path="/work"
                element={
                  <AppealDetailPanel
                    appealId={APPEAL}
                    onClose={() => undefined}
                    onChanged={() => undefined}
                  />
                }
              />
              <Route path="*" element={<Where />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

beforeEach(() => {
  calls = [];
  refusal = null;
  gets = [];
  tier = "reconsideration";
  state = "draft";
  filedByEscalation = false;
  qic = baseQic();
  window.sessionStorage.clear();
});
afterEach(() => cleanup());

const change = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("M25 QIC reconsideration - draft", () => {
  it("always shows the preclusion warning and the evidence editor on a draft", async () => {
    mount();
    expect(await screen.findByText("QIC reconsideration")).toBeTruthy();
    expect(
      screen.getAllByText(/may be excluded at later levels of appeal/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Documentation the redetermination notice named")).toBeTruthy();
  });

  it("saves the cited items with the version, and refuses a short reason before sending", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Add item" }));
    change("Item 1", "Face-to-face note");
    change(/Attached document ID \(leave blank/, NOTE_DOC);
    fireEvent.click(screen.getByRole("button", { name: "Add item" }));
    change("Item 2", "Visit notes");
    change("Why it is not available", "lost");
    expect(
      (screen.getByRole("button", { name: "Save evidence list" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    change("Why it is not available", "The facility has not released the notes yet.");
    fireEvent.click(screen.getByRole("button", { name: "Save evidence list" }));
    await waitFor(() =>
      expect(calls).toEqual([
        {
          method: "PATCH",
          path: `/api/v1/appeals/${APPEAL}/cited-evidence`,
          ifMatch: "4",
          body: {
            none: false,
            items: [
              { label: "Face-to-face note", documentId: NOTE_DOC, notAvailableReason: null },
              {
                label: "Visit notes",
                documentId: null,
                notAvailableReason: "The facility has not released the notes yet.",
              },
            ],
          },
        },
      ]),
    );
  });

  it("lets the notice-named-none attestation stand in for a list, and not alongside items", async () => {
    mount();
    const save = async () => screen.findByRole("button", { name: "Save evidence list" });
    expect(((await save()) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/named no missing documentation/));
    expect(((await save()) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(await save());
    await waitFor(() => expect(calls[0]?.body).toEqual({ items: [], none: true }));
  });

  it("sends the MAC, the notice copy and the acknowledgement with the submit, and shows a refusal verbatim", async () => {
    refusal = {
      status: 422,
      body: {
        error: {
          code: "EVIDENCE_LIST_REQUIRED",
          message:
            "list the documentation the redetermination notice named as missing, or state that it named none",
        },
      },
    };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Submit appeal" }));
    change("Appeal narrative", "N".repeat(120));
    change("Attached document IDs", `${NOTICE_DOC}, ${NOTE_DOC}`);
    const send = screen.getByRole("button", { name: "Submit appeal", hidden: false });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    change("MAC that issued the redetermination notice", "Example MAC");
    change(/Document ID of the copy of the redetermination notice/, NOTICE_DOC);
    fireEvent.click(screen.getByLabelText(/I understand that evidence left out/));
    const buttons = screen.getAllByRole("button", { name: "Submit appeal" });
    fireEvent.click(buttons.at(-1) as HTMLElement);
    await waitFor(() =>
      expect(calls).toEqual([
        {
          method: "POST",
          path: `/api/v1/appeals/${APPEAL}/submit`,
          ifMatch: "4",
          body: {
            appealNarrative: "N".repeat(120),
            attachedDocumentIds: [NOTICE_DOC, NOTE_DOC],
            redeterminationMacName: "Example MAC",
            redeterminationNoticeDocumentId: NOTICE_DOC,
            evidencePreclusionAcknowledged: true,
          },
        },
      ]),
    );
    expect(
      await screen.findByText(/list the documentation the redetermination notice named/),
    ).toBeTruthy();
  });

  it("does not add the reconsideration fields to a redetermination submit", async () => {
    tier = "redetermination";
    qic = baseQic({ kind: "none", tier: "redetermination" });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Submit appeal" }));
    expect(screen.queryByLabelText("MAC that issued the redetermination notice")).toBeNull();
    expect(screen.queryByText("QIC reconsideration")).toBeNull();
  });
});

describe("M25 QIC reconsideration - the clock", () => {
  it("says the receipt date is not recorded, offers no escalation, and records it with the version", async () => {
    state = "under_review";
    qic = baseQic({
      escalationBlockedReason:
        "record the date the QIC received the request first; without it the QIC's decision date is not known",
    });
    mount();
    expect(await screen.findByText(/QIC receipt date not recorded/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Record escalation request" })).toBeNull();
    expect(screen.getByText(/without it the QIC's decision date is not known/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Date the QIC received the request/), {
      target: { value: "2026-01-05" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record receipt date" }));
    await waitFor(() =>
      expect(calls).toEqual([
        {
          method: "PATCH",
          path: `/api/v1/appeals/${APPEAL}/qic-clock`,
          ifMatch: "4",
          body: { receivedOn: "2026-01-05" },
        },
      ]),
    );
  });

  it("shows how the decision date was worked out, marks the unconfirmed counting, and adds an extension", async () => {
    state = "under_review";
    qic = baseQic({
      clock: clockBody({
        extensionDays: 14,
        decisionDueOn: "2026-03-20",
        extensions: [{ days: 14, recordedAt: "x" }],
      }),
    });
    mount();
    expect(
      await screen.findByText(
        /Received 2026-01-05 \+ 60 days \+ 14 days of late-evidence extensions = 2026-03-20/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Not yet confirmed with your billing SME/)).toBeTruthy();
    const add = screen.getByRole("button", { name: "Add extension" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    change(/Late-evidence extension/, "15");
    expect(add.disabled).toBe(true);
    change(/Late-evidence extension/, "7");
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    await waitFor(() =>
      expect(calls).toEqual([
        {
          method: "PATCH",
          path: `/api/v1/appeals/${APPEAL}/qic-clock`,
          ifMatch: "4",
          body: { extensionDays: 7 },
        },
      ]),
    );
  });
});

describe("M25 QIC reconsideration - escalation", () => {
  const eligible = () =>
    baseQic({
      clock: clockBody({ overdue: true, daysOverdue: 3 }),
      escalationEligible: true,
    });

  it("offers escalation only when eligible, with the SME caveat, and records the request", async () => {
    state = "under_review";
    qic = eligible();
    mount();
    expect(await screen.findByText(/overdue by 3 days/)).toBeTruthy();
    expect(screen.getByText(/amount-in-controversy requirement/)).toBeTruthy();
    change("Confirmation or tracking reference", "FAX-CONF-77");
    fireEvent.click(screen.getByRole("button", { name: "Record escalation request" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/appeals/${APPEAL}/request-escalation`,
      ifMatch: "4",
      body: { channel: "qic_portal", confirmationRef: "FAX-CONF-77" },
    });
  });

  it("sends the person through step-up and keeps what they typed", async () => {
    state = "under_review";
    qic = eligible();
    refusal = {
      status: 403,
      body: { error: { code: "STEP_UP_REQUIRED", message: "recent verification required" } },
    };
    mount();
    await screen.findByLabelText("Confirmation or tracking reference");
    change("Confirmation or tracking reference", "FAX-CONF-77");
    fireEvent.click(screen.getByRole("button", { name: "Record escalation request" }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toContain("/step-up"));
    const stashed = Object.keys(window.sessionStorage).filter((k) => k.includes("m25-qic"));
    expect(stashed.length).toBe(1);
    expect(window.sessionStorage.getItem(stashed[0] as string)).toContain("FAX-CONF-77");
  });

  it("restores the escalation form after step-up", async () => {
    state = "under_review";
    qic = eligible();
    refusal = {
      status: 403,
      body: { error: { code: "STEP_UP_REQUIRED", message: "recent verification required" } },
    };
    mount();
    await screen.findByLabelText("Confirmation or tracking reference");
    change("Confirmation or tracking reference", "FAX-CONF-77");
    fireEvent.click(screen.getByRole("button", { name: "Record escalation request" }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toContain("/step-up"));
    cleanup();
    refusal = null;
    mount();
    const ref = (await screen.findByLabelText(
      "Confirmation or tracking reference",
    )) as HTMLInputElement;
    expect(ref.value).toBe("FAX-CONF-77");
  });

  it("shows a refusal verbatim and reloads (409)", async () => {
    state = "under_review";
    qic = eligible();
    refusal = {
      status: 409,
      body: {
        error: {
          code: "ALREADY_REQUESTED",
          message: "an escalation request is already recorded for this reconsideration",
        },
      },
    };
    mount();
    await screen.findByLabelText("Confirmation or tracking reference");
    change("Confirmation or tracking reference", "FAX-CONF-77");
    const before = gets.filter((g) => g.endsWith("/qic")).length;
    fireEvent.click(screen.getByRole("button", { name: "Record escalation request" }));
    expect(await screen.findByText(/an escalation request is already recorded/)).toBeTruthy();
    await waitFor(() =>
      expect(gets.filter((g) => g.endsWith("/qic")).length).toBeGreaterThan(before),
    );
  });

  it("confirms the QIC forwarded the case once a request is recorded", async () => {
    state = "under_review";
    qic = baseQic({
      clock: clockBody({ overdue: true, daysOverdue: 3 }),
      escalation: {
        requestedAt: "2026-03-09T12:00:00.000Z",
        channel: "fax",
        confirmationRef: "FAX-CONF-77",
        confirmedOn: null,
      },
    });
    mount();
    expect(await screen.findByText(/Not confirmed yet\. The QIC may still decide\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Record escalation request" })).toBeNull();
    fireEvent.change(screen.getByLabelText(/Date the QIC forwarded the case/), {
      target: { value: "2026-03-10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm the case was forwarded" }));
    await waitFor(() =>
      expect(calls).toEqual([
        {
          method: "POST",
          path: `/api/v1/appeals/${APPEAL}/confirm-escalation`,
          ifMatch: "4",
          body: { forwardedOn: "2026-03-10" },
        },
      ]),
    );
  });

  it("labels the ALJ case an escalation opened as filed by escalation, with no filing deadline", async () => {
    tier = "alj";
    state = "submitted";
    filedByEscalation = true;
    qic = baseQic({
      kind: "escalated_alj",
      tier: "alj",
      escalatedFromAppealCaseId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
    });
    mount();
    expect(await screen.findByText("Filed by escalation")).toBeTruthy();
    expect(
      screen.getByText(/None: filed by escalation from the QIC reconsideration\./),
    ).toBeTruthy();
    expect(screen.queryByText("Deadline basis")).toBeNull();
  });
});
