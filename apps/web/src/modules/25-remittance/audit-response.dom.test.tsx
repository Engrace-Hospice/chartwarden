// apps/web/src/modules/25-remittance — milestone 7a-2 audit response packet. Asserts on RECORDED FETCH CALLS (method,
// path, If-Match, body). Rules under test: the checklist is typed by the person (nothing is pre-filled), a response
// cannot be filed with neither a recorded due date nor the explicit "none stated" attestation, the preparer cannot
// sign off their own packet, the late acknowledgement is asked only against a typed deadline, and the filing posts the
// proof with a step-up redirect on STEP_UP_REQUIRED. The server owns the rules; its refusal is shown verbatim.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { AuditDetailPanel } from "./audit-detail-panel";

const AUDIT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const CLAIM_A = "dddddddd-4444-4444-8444-dddddddddddd";
const CLAIM_B = "eeeeeeee-4444-4444-8444-eeeeeeeeeeee";
const ME = "ffffffff-6666-4666-8666-ffffffffffff";
const OTHER = "11111111-7777-4777-8777-111111111111";
const DOC = "99999999-9999-4999-8999-999999999999";

type Call = { method: string; path: string; ifMatch: string | null; body: Record<string, unknown> };
let calls: Call[] = [];
let refusal: { status: number; body: unknown } | null = null;
let audit: Record<string, unknown> = {};

const base = (over: Record<string, unknown> = {}, response: Record<string, unknown> = {}) => ({
  id: AUDIT,
  authorityKind: "upic",
  authorityName: null,
  requestReference: "REQ-1",
  receivedOn: "2026-02-01",
  state: "in_assembly",
  claimCount: 2,
  dueState: "no_deadline_recorded",
  nextDueAt: null,
  version: 7,
  createdAt: "2026-02-01T00:00:00.000Z",
  requestDatedOn: null,
  scopeNote: null,
  patientId: null,
  providerEntityId: "eeeeeeee-5555-4555-8555-eeeeeeeeeeee",
  adrCaseId: null,
  denialCaseId: null,
  respondedAt: null,
  closedAt: null,
  claims: [
    { id: "l1", claimId: CLAIM_A, claimControlNumber: "CCN-A", dateOfServiceNote: null },
    { id: "l2", claimId: CLAIM_B, claimControlNumber: "CCN-B", dateOfServiceNote: null },
  ],
  deadlines: [],
  events: [],
  response: {
    items: [],
    documents: [],
    sentToReviewByMembershipId: null,
    reviewedByMembershipId: null,
    reviewedAt: null,
    deadlineNoneStatedAt: null,
    filing: null,
    ...response,
  },
  ...over,
});

const deadline = {
  id: "cccccccc-6666-4666-8666-cccccccccccc",
  subjectKind: "audit_request",
  subjectId: AUDIT,
  label: "Records due",
  dueOn: "2099-03-13",
  zone: "America/New_York",
  dueAt: "2099-03-13T12:00:00.000Z",
  sourceNote: "Letter p.2",
  noticeDocumentId: null,
  satisfiedOn: null,
  status: "open",
  version: 2,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === "object" && "url" in input ? (input as Request) : null;
  const url = new URL(req ? req.url : String(input), "http://localhost");
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    const raw = req ? await req.clone().text() : typeof init?.body === "string" ? init.body : "";
    calls.push({
      method,
      path: url.pathname,
      ifMatch: req?.headers.get("if-match") ?? null,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    });
    if (refusal) return json(refusal.status, refusal.body);
    return json(200, { id: AUDIT, version: 8 });
  }
  if (url.pathname === `/api/v1/audit-requests/${AUDIT}`) return json(200, audit);
  if (url.pathname.endsWith("/case-view")) {
    return json(200, {
      claimId: CLAIM_A,
      generatedAt: "2026-02-02T00:00:00.000Z",
      nextDeadline: null,
      items: [],
      truncated: false,
    });
  }
  return json(200, {});
}

function mount(membershipId = ME): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider
        session={{
          userId: "user-1",
          organizationId: "org-1",
          membershipId,
          roles: ["billing_specialist"],
          permissions: [],
          isAdmin: false,
        }}
      >
        <ToastProvider>
          <MemoryRouter>
            <AuditDetailPanel
              auditId={AUDIT}
              onClose={() => undefined}
              onChanged={() => undefined}
            />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

beforeEach(() => {
  calls = [];
  refusal = null;
  audit = base();
});
afterEach(() => cleanup());

describe("M25 audit response packet - assembly", () => {
  it("starts with no checklist items (nothing is pre-filled) and saves exactly what was typed", async () => {
    mount();
    expect(await screen.findByText("No checklist items typed yet.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("New checklist item"), {
      target: { value: "Orders for the period" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add item" }));
    fireEvent.click(screen.getByRole("button", { name: "Save checklist" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "PUT",
      path: `/api/v1/audit-requests/${AUDIT}/response-items`,
      ifMatch: "7",
      body: { items: [{ label: "Orders for the period", state: "pending" }] },
    });
  });

  it("attaches a document under the chosen claim", async () => {
    mount();
    fireEvent.change(await screen.findByLabelText("Attach under claim"), {
      target: { value: CLAIM_B },
    });
    fireEvent.change(screen.getByLabelText("Document ID to attach"), { target: { value: DOC } });
    fireEvent.click(screen.getByRole("button", { name: "Attach document" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/audit-requests/${AUDIT}/documents`,
      ifMatch: "7",
      body: { claimId: CLAIM_B, documentId: DOC },
    });
  });

  it("offers the none-stated attestation only while no deadline is recorded, and posts it", async () => {
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "The request letter states no due date" }),
    );
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/audit-requests/${AUDIT}/deadline-none-stated`,
      ifMatch: "7",
    });
  });

  it("does not offer the attestation when a deadline is recorded", async () => {
    audit = base({ deadlines: [deadline], dueState: "open" });
    mount();
    expect(await screen.findByText(/A due date is recorded above/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "The request letter states no due date" }),
    ).toBeNull();
  });

  it("shows the attestation instead of the missing-date alert once made", async () => {
    audit = base({ dueState: "none_stated" }, { deadlineNoneStatedAt: "2026-02-03T00:00:00.000Z" });
    mount();
    expect(await screen.findAllByText(/states no due date/)).not.toHaveLength(0);
    // The request's own deadlines section no longer shouts (the claim-wide timeline below is a different view).
    const deadlines = screen.getByRole("region", { name: "Recorded deadlines" });
    expect(
      within(deadlines).queryByText("No due date recorded - enter it from the notice"),
    ).toBeNull();
    expect(within(deadlines).getByText(/states no due date/)).toBeTruthy();
  });

  it("offers no bare move to Responded: a response is recorded by filing", async () => {
    audit = base({ state: "in_review" }, { sentToReviewByMembershipId: OTHER });
    mount();
    await screen.findByText("Response packet");
    expect(screen.queryByRole("button", { name: "Move to Responded" })).toBeNull();
  });
});

describe("M25 audit response packet - review and filing", () => {
  const inReview = (response: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    base({ state: "in_review", ...over }, response);

  it("blocks the preparer from signing off their own packet", async () => {
    audit = inReview({ sentToReviewByMembershipId: ME });
    mount();
    expect(
      await screen.findByText(/someone else with review access must sign it off/),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Sign off packet" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("lets a different person sign off, with the request's version as If-Match", async () => {
    audit = inReview({ sentToReviewByMembershipId: OTHER });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Sign off packet" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/audit-requests/${AUDIT}/sign-off`,
      ifMatch: "7",
    });
  });

  const signed = {
    sentToReviewByMembershipId: OTHER,
    reviewedByMembershipId: ME,
    reviewedAt: "2026-02-05T00:00:00.000Z",
  };

  it("will not file with neither a recorded deadline nor the attestation", async () => {
    audit = inReview(signed);
    mount();
    const file = await screen.findByRole("button", { name: "Record filing" });
    fireEvent.change(screen.getByLabelText("Confirmation or tracking reference"), {
      target: { value: "TRK-1" },
    });
    expect(
      screen.getByText("Record the due date, or attest the letter states none, before filing."),
    ).toBeTruthy();
    expect((file as HTMLButtonElement).disabled).toBe(true);
  });

  it("files with the attestation and posts the proof (no late box without a typed deadline)", async () => {
    audit = inReview({ ...signed, deadlineNoneStatedAt: "2026-02-03T00:00:00.000Z" });
    mount();
    fireEvent.change(await screen.findByLabelText("Confirmation or tracking reference"), {
      target: { value: "TRK-1" },
    });
    expect(screen.queryByLabelText(/sent after a recorded due date/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Record filing" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/audit-requests/${AUDIT}/submit`,
      ifMatch: "7",
      body: { channel: "mail", confirmationRef: "TRK-1" },
    });
    expect(calls[0]?.body).not.toHaveProperty("lateAcknowledged");
  });

  it("asks for the late acknowledgement only against a typed deadline that has passed", async () => {
    audit = inReview(signed, {
      deadlines: [{ ...deadline, status: "past" }],
      nextDueAt: "2020-01-01T00:00:00.000Z",
      dueState: "past",
    });
    mount();
    fireEvent.change(await screen.findByLabelText("Confirmation or tracking reference"), {
      target: { value: "TRK-1" },
    });
    const file = screen.getByRole("button", { name: "Record filing" }) as HTMLButtonElement;
    expect(file.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/sent after a recorded due date/));
    expect(file.disabled).toBe(false);
    fireEvent.click(file);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({ lateAcknowledged: true });
  });

  it("names the claim for a receipt document when the request covers several claims", async () => {
    audit = inReview({ ...signed, deadlineNoneStatedAt: "2026-02-03T00:00:00.000Z" });
    mount();
    fireEvent.change(await screen.findByLabelText("Confirmation or tracking reference"), {
      target: { value: "TRK-1" },
    });
    fireEvent.change(screen.getByLabelText("Receipt document ID (optional)"), {
      target: { value: DOC },
    });
    fireEvent.change(screen.getByLabelText("Claim whose patient owns the receipt document"), {
      target: { value: CLAIM_B },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record filing" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({ receiptDocumentId: DOC, receiptClaimId: CLAIM_B });
  });

  it("shows the server's refusal verbatim", async () => {
    audit = inReview({ ...signed, deadlineNoneStatedAt: "2026-02-03T00:00:00.000Z" });
    refusal = {
      status: 422,
      body: { error: { code: "AUDIT_PROOF_REQUIRED", message: "record the confirmation please" } },
    };
    mount();
    fireEvent.change(await screen.findByLabelText("Confirmation or tracking reference"), {
      target: { value: "TRK-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record filing" }));
    expect(await screen.findByText("record the confirmation please")).toBeTruthy();
  });

  it("shows the retained filing once responded", async () => {
    audit = base(
      { state: "responded" },
      {
        ...signed,
        filing: {
          channel: "mail",
          confirmationRef: "TRK-9",
          filedAt: "2026-02-06T00:00:00.000Z",
          filedLate: false,
        },
      },
    );
    mount();
    const section = await screen.findByRole("region", { name: "Response packet" });
    expect(within(section).getByText("TRK-9")).toBeTruthy();
    expect(within(section).getByText("On time")).toBeTruthy();
    expect(within(section).queryByRole("button", { name: "Record filing" })).toBeNull();
  });
});
