// apps/web/src/modules/25-remittance — milestone 7a-2 audit response packet. Asserts on RECORDED FETCH CALLS (method,
// path, If-Match, body). Rules under test: the checklist is typed by the person (nothing is pre-filled), a response
// cannot be filed with neither a recorded due date nor the explicit "none stated" attestation, the preparer cannot
// sign off their own packet, the late acknowledgement is asked only against a typed deadline, and the filing posts the
// proof with a step-up redirect on STEP_UP_REQUIRED. The server owns the rules; its refusal is shown verbatim.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import {
  markStepUpReturn,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpDraftKey,
} from "../../shell/step-up-redirect";
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
/** Reads of the request fail (a reload that cannot reach the server). */
let getFails = false;
/** Writes answer after this many ms (a slow server: lets a double click race). */
let postDelayMs = 0;
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
    if (postDelayMs > 0) await new Promise((r) => setTimeout(r, postDelayMs));
    if (refusal) return json(refusal.status, refusal.body);
    return json(200, { id: AUDIT, version: 8 });
  }
  if (url.pathname === `/api/v1/audit-requests/${AUDIT}`) {
    return getFails ? json(500, { error: { message: "server down" } }) : json(200, audit);
  }
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
            <Routes>
              <Route
                path="/"
                element={
                  <AuditDetailPanel
                    auditId={AUDIT}
                    onClose={() => undefined}
                    onChanged={() => undefined}
                  />
                }
              />
              <Route path="/step-up" element={<p>STEP-UP PAGE</p>} />
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
  getFails = false;
  postDelayMs = 0;
  window.sessionStorage.clear();
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
    audit = inReview(
      { sentToReviewByMembershipId: OTHER, deadlineNoneStatedAt: "2026-02-03T00:00:00.000Z" },
      { dueState: "none_stated" },
    );
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

describe("M25 audit response packet - resilience", () => {
  const owner = { userId: "user-1", organizationId: "org-1" };
  const draftKey = () => stepUpDraftKey(owner, "m25-audit-response", AUDIT);
  const attested = { deadlineNoneStatedAt: "2026-02-03T00:00:00.000Z" };
  const signedIn = (extra: Record<string, unknown> = {}) =>
    base(
      { state: "in_review", dueState: "none_stated", ...extra },
      {
        sentToReviewByMembershipId: OTHER,
        reviewedByMembershipId: ME,
        reviewedAt: "2026-02-05T00:00:00.000Z",
        ...attested,
      },
    );
  const fillAndFile = async (): Promise<void> => {
    fireEvent.change(await screen.findByLabelText("Confirmation or tracking reference"), {
      target: { value: "TRK-9" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record filing" }));
  };

  it("sends the person to the step-up page on STEP_UP_REQUIRED and stashes the draft WITHOUT the late acknowledgement", async () => {
    audit = signedIn({
      deadlines: [{ ...deadline, status: "past" }],
      nextDueAt: "2020-01-01T00:00:00.000Z",
      dueState: "past",
    });
    refusal = { status: 403, body: { error: { code: "STEP_UP_REQUIRED", message: "step up" } } };
    mount();
    fireEvent.change(await screen.findByLabelText("Confirmation or tracking reference"), {
      target: { value: "TRK-9" },
    });
    fireEvent.click(screen.getByLabelText(/sent after a recorded due date/));
    fireEvent.click(screen.getByRole("button", { name: "Record filing" }));
    expect(await screen.findByText("STEP-UP PAGE")).toBeTruthy();
    const stashed = peekStepUpDraft<Record<string, unknown>>(draftKey());
    expect(stashed).toMatchObject({ confirmationRef: "TRK-9", channel: "mail" });
    expect(stashed).not.toHaveProperty("lateAcknowledged");
  });

  it("restores the draft only on a genuine return from the step-up page, and never restores the late box", async () => {
    stashStepUpDraft(draftKey(), {
      channel: "fax",
      confirmationRef: "RESTORED-1",
      filedAt: "2026-02-06T10:00",
      receiptDocumentId: "",
      receiptClaimId: CLAIM_A,
      lateAcknowledged: true,
    });
    markStepUpReturn("/");
    audit = signedIn({
      deadlines: [{ ...deadline, status: "past" }],
      nextDueAt: "2020-01-01T00:00:00.000Z",
      dueState: "past",
    });
    mount();
    const ref = (await screen.findByLabelText(
      "Confirmation or tracking reference",
    )) as HTMLInputElement;
    expect(ref.value).toBe("RESTORED-1");
    expect((screen.getByLabelText("Sent by") as HTMLSelectElement).value).toBe("fax");
    expect(
      (screen.getByLabelText(/sent after a recorded due date/) as HTMLInputElement).checked,
    ).toBe(false);
  });

  it("discards an abandoned draft on an ordinary visit instead of restoring it", async () => {
    stashStepUpDraft(draftKey(), {
      channel: "fax",
      confirmationRef: "ABANDONED",
      filedAt: "2026-02-06T10:00",
      receiptDocumentId: "",
      receiptClaimId: CLAIM_A,
    });
    audit = signedIn();
    mount();
    const ref = (await screen.findByLabelText(
      "Confirmation or tracking reference",
    )) as HTMLInputElement;
    expect(ref.value).toBe("");
    await waitFor(() => expect(peekStepUpDraft(draftKey())).toBeNull());
  });

  it("clears the draft on a refusal that is not a step-up", async () => {
    stashStepUpDraft(draftKey(), {
      channel: "mail",
      confirmationRef: "TRK-9",
      filedAt: "2026-02-06T10:00",
      receiptDocumentId: "",
      receiptClaimId: CLAIM_A,
    });
    markStepUpReturn("/");
    audit = signedIn();
    refusal = {
      status: 422,
      body: { error: { code: "AUDIT_PROOF_REQUIRED", message: "record the confirmation" } },
    };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Record filing" }));
    expect(await screen.findByText("record the confirmation")).toBeTruthy();
    expect(peekStepUpDraft(draftKey())).toBeNull();
  });

  it("on a 409 says the edit was not saved, reloads, and keeps the unsaved checklist edits", async () => {
    mount();
    fireEvent.change(await screen.findByLabelText("New checklist item"), {
      target: { value: "Orders for the period" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add item" }));
    refusal = {
      status: 409,
      body: { error: { code: "VERSION_CONFLICT", message: "modified by another writer" } },
    };
    fireEvent.click(screen.getByRole("button", { name: "Save checklist" }));
    expect(await screen.findByText(/It was reloaded and your edit was not saved/)).toBeTruthy();
    // The typed item is still on screen, not silently replaced by the server's empty list.
    expect(screen.getByLabelText("Orders for the period")).toBeTruthy();
  });

  it("warns when the checklist moved on the server while there are unsaved edits, and lets the person discard theirs", async () => {
    mount();
    fireEvent.change(await screen.findByLabelText("New checklist item"), {
      target: { value: "Mine" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add item" }));
    // Another person saves a different checklist; this person's next reload sees it.
    audit = base({ version: 9 }, { items: [{ label: "Theirs", state: "ready" }] });
    refusal = { status: 409, body: { error: { code: "VERSION_CONFLICT", message: "moved" } } };
    fireEvent.click(screen.getByRole("button", { name: "Save checklist" }));
    expect(await screen.findByText(/checklist changed on the server/)).toBeTruthy();
    expect(screen.getByLabelText("Mine")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard my edits" }));
    expect(await screen.findByLabelText("Theirs")).toBeTruthy();
    expect(screen.queryByLabelText("Mine")).toBeNull();
  });

  it("never says 'done' when the reload after a command fails: it shows Retry reload and disables every command", async () => {
    mount();
    fireEvent.change(await screen.findByLabelText("Attach under claim"), {
      target: { value: CLAIM_A },
    });
    fireEvent.change(screen.getByLabelText("Document ID to attach"), { target: { value: DOC } });
    getFails = true;
    fireEvent.click(screen.getByRole("button", { name: "Attach document" }));
    expect(
      await screen.findByText(/was saved, but the request could not be reloaded/),
    ).toBeTruthy();
    expect(screen.queryByText(/Attach document: done/)).toBeNull();
    const retry = screen.getByRole("button", { name: "Retry reload" });
    fireEvent.change(screen.getByLabelText("Document ID to attach"), { target: { value: DOC } });
    const attach = screen.getByRole("button", { name: "Attach document" }) as HTMLButtonElement;
    expect(attach.disabled).toBe(true);
    expect(screen.getAllByText(/Retry reload first/).length).toBeGreaterThan(0);
    getFails = false;
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry reload" })).toBeNull());
    expect(
      (screen.getByRole("button", { name: "Attach document" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("sends a double-clicked filing once", async () => {
    audit = signedIn();
    postDelayMs = 80;
    mount();
    fireEvent.change(await screen.findByLabelText("Confirmation or tracking reference"), {
      target: { value: "TRK-9" },
    });
    const file = screen.getByRole("button", { name: "Record filing" });
    fireEvent.click(file);
    fireEvent.click(file);
    await waitFor(() => expect(screen.getByText("Record filing: done.")).toBeTruthy());
    expect(calls.filter((c) => c.path.endsWith("/submit"))).toHaveLength(1);
  });

  it("sends a double-clicked sign-off once", async () => {
    audit = inReviewForSignOff();
    postDelayMs = 80;
    mount();
    const sign = await screen.findByRole("button", { name: "Sign off packet" });
    fireEvent.click(sign);
    fireEvent.click(sign);
    await waitFor(() => expect(screen.getByText("Sign off: done.")).toBeTruthy());
    expect(calls.filter((c) => c.path.endsWith("/sign-off"))).toHaveLength(1);
  });

  it("sends the person to the step-up page when the sign-off needs one", async () => {
    audit = inReviewForSignOff();
    refusal = { status: 403, body: { error: { code: "STEP_UP_REQUIRED", message: "step up" } } };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Sign off packet" }));
    expect(await screen.findByText("STEP-UP PAGE")).toBeTruthy();
  });

  it("explains every disabled button under it", async () => {
    mount();
    expect(await screen.findByText("There are no unsaved checklist changes.")).toBeTruthy();
    expect(screen.getByText("Type the item as the request letter words it.")).toBeTruthy();
    expect(screen.getByText("Enter the document's UUID.", { selector: "p" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("New checklist item"), { target: { value: "Orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Add item" }));
    fireEvent.change(screen.getByLabelText("New checklist item"), { target: { value: "orders " } });
    expect(screen.getByText("That item is already on the list.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Add item" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("tells the person what to do in review before sign-off", async () => {
    audit = inReviewForSignOff();
    mount();
    expect(
      await screen.findByText(/Next step: someone who did not prepare this packet/),
    ).toBeTruthy();
  });

  function inReviewForSignOff(): Record<string, unknown> {
    return base(
      { state: "in_review", dueState: "none_stated" },
      { sentToReviewByMembershipId: OTHER, ...attested },
    );
  }
});
