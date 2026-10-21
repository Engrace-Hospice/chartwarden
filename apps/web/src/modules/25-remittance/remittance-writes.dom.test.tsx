// apps/web/src/modules/25-remittance — GAP-074: the four M25 screens were GET-only although the backend carries
// the denial ladder, the appeal lifecycle and the ERA manual match. The net asserts on RECORDED FETCH CALLS
// (method, path, If-Match header, body) rather than on a spy over the client, so a control re-wired to a handler
// that never fires still fails. The server decides everything: refusals are asserted verbatim, and the manual
// match sends ONLY what the GAP-073 contract accepts (claim id + rationale).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { AppealTracker } from "./appeal-tracker";
import { DenialWorklist } from "./denial-worklist";
import { RemittanceWorklist } from "./remittance-worklist";

const DENIAL = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const APPEAL = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const LINE = "cccccccc-3333-4333-8333-cccccccccccc";
const CLAIM = "dddddddd-4444-4444-8444-dddddddddddd";
const DOC = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
const ME = "ffffffff-6666-4666-8666-ffffffffffff";
const LONG = "x".repeat(45);

let denialState = "open";
let appealState = "draft";
let refusal: { status: number; body: unknown } | null = null;
type Call = { method: string; path: string; ifMatch: string | null; body: Record<string, unknown> };
let calls: Call[] = [];

const denialBody = () => ({
  id: DENIAL,
  providerEntityId: "11111111-1111-4111-8111-111111111111",
  claimId: CLAIM,
  carcCode: "CO-16",
  rarcCode: null,
  category: "denial",
  source: "835",
  state: denialState,
  assigneeMembershipId: null,
  openedAt: "2026-09-01T00:00:00.000Z",
  agingBucketDays: 3,
  agingBucketLabel: "0-7",
  dollarValue: "300.00",
  taxonomyStatus: "mapped",
  version: 7,
});
const appealBody = () => ({
  id: APPEAL,
  denialCaseId: DENIAL,
  claimId: CLAIM,
  tier: "redetermination",
  state: appealState,
  decisionOutcome: null,
  tierDeadlineAt: "2099-01-01T00:00:00.000Z",
  version: 3,
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
    if (path.endsWith("/manual-match"))
      return json(200, { id: LINE, matchState: "manual_matched" });
    return json(200, { id: DENIAL, version: 8 });
  }
  if (path === "/api/v1/denials") return json(200, { items: [denialBody()], nextCursor: null });
  if (path === `/api/v1/denials/${DENIAL}`) return json(200, denialBody());
  if (path === "/api/v1/appeals")
    return json(200, { items: [{ ...appealBody(), events: undefined }], nextCursor: null });
  if (path === `/api/v1/appeals/${APPEAL}`) return json(200, appealBody());
  if (path === "/api/v1/remittance/advices") return json(200, { items: [], nextCursor: null });
  if (path === "/api/v1/remittance/unmatched")
    return json(200, {
      items: [
        {
          id: LINE,
          remittanceAdviceId: "99999999-9999-4999-8999-999999999999",
          claimId: null,
          clp02StatusCode: 1,
          clp03TotalChargeAmount: "500.00",
          clp04TotalPaymentAmount: "450.00",
          clp05PatientResponsibilityAmount: "50.00",
          matchState: "unmatched",
          receivedAt: "2026-09-02T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
  return json(200, { items: [], nextCursor: null });
}

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: ME,
  roles: ["billing_specialist"],
  permissions: [],
  isAdmin: false,
};

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{`${loc.pathname}${loc.search}`}</div>;
}

function mount(element: JSX.Element): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/work"]}>
            <Routes>
              <Route path="/work" element={element} />
              <Route path="*" element={<Where />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

beforeEach(() => {
  denialState = "open";
  appealState = "draft";
  refusal = null;
  calls = [];
  window.sessionStorage.clear();
});
afterEach(() => cleanup());

async function openDenial(): Promise<void> {
  mount(<DenialWorklist />);
  fireEvent.click(await screen.findByRole("button", { name: "Work denial CO-16" }));
  await screen.findByText("Start work");
}

describe("M25 denial work", () => {
  it("starts work with the row version the server returned as If-Match", async () => {
    await openDenial();
    fireEvent.click(screen.getByRole("button", { name: "Start work" }));
    fireEvent.click(
      await screen
        .findAllByRole("button", { name: "Start work" })
        .then((b) => b[b.length - 1] as HTMLElement),
    );
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      path: `/api/v1/denials/${DENIAL}/start`,
      ifMatch: "7",
    });
  });

  it("offers only the arcs the state ladder has, and keeps resolve disabled under the 40-character floor", async () => {
    denialState = "in_progress";
    mount(<DenialWorklist />);
    fireEvent.click(await screen.findByRole("button", { name: "Work denial CO-16" }));
    await screen.findByText("Escalate");
    expect(screen.queryByText("Start work")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mark resolved" }));
    const submit = screen.getAllByRole("button", { name: "Mark resolved" }).pop() as HTMLElement;
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: LONG } });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      path: `/api/v1/denials/${DENIAL}/resolve`,
      ifMatch: "7",
      body: { reason: LONG },
    });
  });

  it("assigns to a membership UUID, offering 'Assign to me' from the session", async () => {
    await openDenial();
    fireEvent.click(screen.getByRole("button", { name: "Assign" }));
    const submit = screen.getAllByRole("button", { name: "Assign" }).pop() as HTMLElement;
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Assign to me" }));
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      path: `/api/v1/denials/${DENIAL}/assign`,
      body: { assigneeMembershipId: ME },
    });
  });

  it("shows a 409 version conflict verbatim in an alert", async () => {
    await openDenial();
    refusal = {
      status: 409,
      body: {
        error: {
          code: "VERSION_CONFLICT",
          message: "modified by another writer (current version 9)",
        },
      },
    };
    fireEvent.click(screen.getByRole("button", { name: "Escalate" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "y".repeat(25) } });
    fireEvent.click(screen.getAllByRole("button", { name: "Escalate" }).pop() as HTMLElement);
    expect((await screen.findByRole("alert")).textContent).toContain("current version 9");
  });

  it("opens an appeal at the chosen tier from an escalated denial", async () => {
    denialState = "escalated";
    mount(<DenialWorklist />);
    fireEvent.click(await screen.findByRole("button", { name: "Work denial CO-16" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open appeal" }));
    fireEvent.change(screen.getByLabelText("Appeal tier"), {
      target: { value: "reconsideration" },
    });
    // A later tier cannot be submitted until the printed notice date is supplied.
    const submitBtn = () =>
      screen.getAllByRole("button", { name: "Open appeal" }).pop() as HTMLButtonElement;
    expect(submitBtn().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Date on the prior decision notice"), {
      target: { value: "2026-03-01" },
    });
    fireEvent.click(submitBtn());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/denials/${DENIAL}/appeals`,
      body: { tier: "reconsideration", noticeDate: "2026-03-01" },
    });
  });

  it("sends the user to /step-up on a close-with-write-off STEP_UP_REQUIRED refusal", async () => {
    denialState = "resolved";
    mount(<DenialWorklist />);
    fireEvent.click(await screen.findByRole("button", { name: "Work denial CO-16" }));
    refusal = { status: 403, body: { error: { code: "STEP_UP_REQUIRED", message: "step up" } } };
    fireEvent.click(await screen.findByRole("button", { name: "Close with write-off" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: LONG } });
    fireEvent.click(
      screen.getAllByRole("button", { name: "Close with write-off" }).pop() as HTMLElement,
    );
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe("/step-up?returnTo=%2Fwork"),
    );
  });

  it("shows a plain 403 verbatim and does NOT redirect", async () => {
    denialState = "closed";
    mount(<DenialWorklist />);
    fireEvent.click(await screen.findByRole("button", { name: "Work denial CO-16" }));
    refusal = {
      status: 403,
      body: { error: { code: "FORBIDDEN", message: "denial.reopen is not granted" } },
    };
    fireEvent.click(await screen.findByRole("button", { name: "Reopen" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: LONG } });
    fireEvent.click(screen.getAllByRole("button", { name: "Reopen" }).pop() as HTMLElement);
    expect((await screen.findByRole("alert")).textContent).toBe("denial.reopen is not granted");
    expect(screen.queryByTestId("where")).toBeNull();
  });
});

async function openAppeal(): Promise<void> {
  mount(<AppealTracker />);
  fireEvent.click(await screen.findByRole("button", { name: /Open appeal Redetermination/ }));
  await screen.findByText("Packet document");
}

describe("M25 appeal lifecycle", () => {
  it("submits a draft with narrative and attached documents, gated on the server floors", async () => {
    await openAppeal();
    fireEvent.click(await screen.findByRole("button", { name: "Submit appeal" }));
    const submit = screen.getAllByRole("button", { name: "Submit appeal" }).pop() as HTMLElement;
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Appeal narrative"), {
      target: { value: "n".repeat(100) },
    });
    fireEvent.change(screen.getByLabelText("Attached document IDs"), { target: { value: DOC } });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/appeals/${APPEAL}/submit`,
      ifMatch: "3",
      body: { appealNarrative: "n".repeat(100), attachedDocumentIds: [DOC] },
    });
  });

  it("surfaces the past-deadline refusal verbatim", async () => {
    await openAppeal();
    refusal = {
      status: 403,
      body: {
        error: { code: "APPEAL_DEADLINE_PASSED", message: "the tier filing deadline has passed" },
      },
    };
    fireEvent.click(await screen.findByRole("button", { name: "Submit appeal" }));
    fireEvent.change(screen.getByLabelText("Appeal narrative"), {
      target: { value: "n".repeat(100) },
    });
    fireEvent.change(screen.getByLabelText("Attached document IDs"), { target: { value: DOC } });
    fireEvent.click(screen.getAllByRole("button", { name: "Submit appeal" }).pop() as HTMLElement);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "the tier filing deadline has passed",
    );
  });

  it("records the MAC acknowledgement on a submitted appeal", async () => {
    appealState = "submitted";
    await openAppeal();
    fireEvent.click(await screen.findByRole("button", { name: "Record MAC acknowledgement" }));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Record MAC acknowledgement" }).pop() as HTMLElement,
    );
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      path: `/api/v1/appeals/${APPEAL}/ack`,
      ifMatch: "3",
    });
  });

  it("records a decision with outcome, decidedAt and a 40-character reason", async () => {
    appealState = "under_review";
    await openAppeal();
    fireEvent.click(await screen.findByRole("button", { name: "Record decision" }));
    const submit = screen.getAllByRole("button", { name: "Record decision" }).pop() as HTMLElement;
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Outcome"), { target: { value: "partial" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: LONG } });
    fireEvent.change(screen.getByLabelText(/Date printed on the decision letter/), {
      target: { value: "2026-03-01" },
    });
    fireEvent.change(screen.getByLabelText("MAC reference numbers (optional)"), {
      target: { value: "QIC: 12345" },
    });
    fireEvent.click(submit);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/appeals/${APPEAL}/decide`,
      body: {
        outcome: "partial",
        reason: LONG,
        decisionNoticeDate: "2026-03-01",
        macReferenceNumbers: { QIC: "12345" },
      },
    });
    expect(typeof calls[0]?.body.decidedAt).toBe("string");
  });

  it("will not record an unfavorable decision without the date printed on the letter", async () => {
    appealState = "under_review";
    await openAppeal();
    fireEvent.click(await screen.findByRole("button", { name: "Record decision" }));
    fireEvent.change(screen.getByLabelText("Outcome"), { target: { value: "unfavorable" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: LONG } });
    const submit = () =>
      screen.getAllByRole("button", { name: "Record decision" }).pop() as HTMLButtonElement;
    expect(submit().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Date printed on the decision letter/), {
      target: { value: "2026-03-01" },
    });
    expect(submit().disabled).toBe(false);
  });

  it("closes a decided appeal", async () => {
    appealState = "decided";
    await openAppeal();
    // The modal scrim is also a button labelled "Close"; the action buttons are matched on their text.
    const byText = () =>
      screen.getAllByRole("button").filter((b) => b.textContent === "Close") as HTMLElement[];
    await screen.findByText("Packet document");
    fireEvent.click(byText()[0] as HTMLElement);
    fireEvent.click(byText().pop() as HTMLElement);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/appeals/${APPEAL}/close`,
      ifMatch: "3",
    });
  });

  it("withdraws an open appeal only with a 40-character reason", async () => {
    await openAppeal();
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    const submit = screen.getAllByRole("button", { name: "Withdraw" }).pop() as HTMLElement;
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: LONG } });
    fireEvent.click(submit);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      path: `/api/v1/appeals/${APPEAL}/withdraw`,
      body: { reason: LONG },
    });
  });

  it("redirects an appeal submit to /step-up when the server asks for fresh verification", async () => {
    await openAppeal();
    refusal = { status: 403, body: { error: { code: "STEP_UP_REQUIRED", message: "step up" } } };
    fireEvent.click(await screen.findByRole("button", { name: "Submit appeal" }));
    fireEvent.change(screen.getByLabelText("Appeal narrative"), {
      target: { value: "n".repeat(100) },
    });
    fireEvent.change(screen.getByLabelText("Attached document IDs"), { target: { value: DOC } });
    fireEvent.click(screen.getAllByRole("button", { name: "Submit appeal" }).pop() as HTMLElement);
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toContain("/step-up?returnTo="),
    );
  });
});

describe("M25 ERA manual match", () => {
  async function openMatch(): Promise<void> {
    mount(<RemittanceWorklist />);
    fireEvent.click(await screen.findByRole("button", { name: /Match line/ }));
    await screen.findByLabelText("Claim ID");
  }

  it("sends only the claim id and the rationale, and only once both meet the contract", async () => {
    await openMatch();
    const submit = screen.getByRole("button", { name: "Match claim" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Claim ID"), { target: { value: CLAIM } });
    fireEvent.change(screen.getByLabelText("Match rationale"), { target: { value: "too short" } });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Match rationale"), {
      target: { value: "Patient, DOS and billed amount agree with the claim." },
    });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/remittance/lines/${LINE}/manual-match`,
      body: {
        proposedClaimId: CLAIM,
        reason: "Patient, DOS and billed amount agree with the claim.",
      },
    });
    expect(Object.keys(calls[0]?.body ?? {}).sort()).toEqual(["proposedClaimId", "reason"]);
  });

  it("shows the server's 404 for a claim outside the line's provider entity verbatim", async () => {
    await openMatch();
    refusal = { status: 404, body: { error: { code: "NOT_FOUND", message: "claim not found" } } };
    fireEvent.change(screen.getByLabelText("Claim ID"), { target: { value: CLAIM } });
    fireEvent.change(screen.getByLabelText("Match rationale"), {
      target: { value: "r".repeat(25) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Match claim" }));
    expect((await screen.findByRole("alert")).textContent).toBe("claim not found");
  });

  it("shows a 409 (line already matched) verbatim", async () => {
    await openMatch();
    refusal = {
      status: 409,
      body: { error: { code: "INVALID_STATE", message: "the line was matched concurrently" } },
    };
    fireEvent.change(screen.getByLabelText("Claim ID"), { target: { value: CLAIM } });
    fireEvent.change(screen.getByLabelText("Match rationale"), {
      target: { value: "r".repeat(25) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Match claim" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "the line was matched concurrently",
    );
  });
});
