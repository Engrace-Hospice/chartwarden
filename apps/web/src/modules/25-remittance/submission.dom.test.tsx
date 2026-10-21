// apps/web/src/modules/25-remittance — milestone 6a submission panel. Asserts on RECORDED FETCH CALLS (method, path,
// If-Match, body) like the other M25 write tests, so a control wired to a handler that never fires still fails. The
// server owns every rule and its refusal is shown verbatim; the receipt form survives a step-up; "proof missing" is
// a visible state; and "Approve and send" is disabled with its reason.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { stashStepUpDraft, stepUpDraftKey } from "../../shell/step-up-redirect";
import { SubmissionPanel } from "./submission-panel";

const APPEAL = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ATTEMPT = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const ME = "ffffffff-6666-4666-8666-ffffffffffff";

type Call = { method: string; path: string; ifMatch: string | null; body: Record<string, unknown> };
let calls: Call[] = [];
let refusal: { status: number; body: unknown } | null = null;
let attemptState: "needs_manual" | "acknowledged" | "none" = "needs_manual";
let loadFails = false;
let failAfterFirst = false;
let amendedAttempt = false;
let purpose = "appeal_request";
let gets = 0;

const attempt = () => ({
  id: ATTEMPT,
  purpose,
  attemptNo: 1,
  channel: attemptState === "acknowledged" ? "mac_portal" : null,
  adapter: "manual",
  status: attemptState,
  needsManualReason:
    attemptState === "needs_manual" ? "Filed outside ChartWarden. Record the receipt." : null,
  confirmationRef: attemptState === "acknowledged" ? "CONF-1" : null,
  receiptAt: attemptState === "acknowledged" ? "2026-09-10T12:00:00.000Z" : null,
  receiptDocumentId: null,
  receiptSource: attemptState === "acknowledged" ? "entered" : null,
  amendments: amendedAttempt
    ? [
        {
          recordedAt: "2026-09-12T00:00:00.000Z",
          confirmationRef: "CONF-FIXED",
          receiptAt: "2026-09-10T12:00:00.000Z",
          receiptDocumentId: null,
        },
      ]
    : [],
  approvedAt: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  version: 3,
  proofMissing: attemptState === "needs_manual",
});
const viewBody = () => ({
  subjectKind: "appeal",
  subjectId: APPEAL,
  attempts: attemptState === "none" ? [] : [attempt()],
  proofMissing: attemptState === "needs_manual",
  noAttemptRecord: attemptState === "none",
  adapters: [
    { kind: "manual", mode: "guided_manual", bound: true, reason: "Always available." },
    { kind: "esmd", mode: "electronic", bound: false, reason: "esMD is not configured." },
    { kind: "fax", mode: "electronic", bound: false, reason: "Fax is not configured." },
  ],
  checklist: [
    { key: "download_packet", text: "Download the retained packet." },
    { key: "record_confirmation", text: "Copy the confirmation exactly." },
  ],
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
    return json(200, { id: ATTEMPT, version: 4, amended: false });
  }
  if (path === `/api/v1/appeals/${APPEAL}/submission`) {
    gets += 1;
    if (failAfterFirst && gets > 1) {
      return json(500, { error: { code: "INTERNAL", message: "refresh failed" } });
    }
    return loadFails
      ? json(500, { error: { code: "INTERNAL", message: "submission read failed" } })
      : json(200, viewBody());
  }
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
              <Route path="/work" element={<SubmissionPanel kind="appeal" subjectId={APPEAL} />} />
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
  attemptState = "needs_manual";
  loadFails = false;
  failAfterFirst = false;
  amendedAttempt = false;
  purpose = "appeal_request";
  gets = 0;
  window.sessionStorage.clear();
});
afterEach(() => cleanup());

describe("M25 submission panel", () => {
  it("shows proof missing, the guided steps, the honest adapter status and a disabled Approve and send", async () => {
    mount();
    expect(await screen.findByText(/Proof missing:/)).toBeTruthy();
    expect(screen.getByText("Needs Manual")).toBeTruthy();
    expect(screen.getByText(/Not configured\. esMD is not configured\./)).toBeTruthy();
    expect(screen.getByText("Download the retained packet.")).toBeTruthy();
    const send = screen.getByRole("button", { name: "Approve and send" });
    expect(send.getAttribute("aria-disabled")).toBe("true");
    const reason = screen.getByText(
      "Electronic channel not configured. Use guided manual submission.",
    );
    expect(send.getAttribute("aria-describedby")).toBe(reason.id);
    fireEvent.click(send);
    expect(calls).toEqual([]);
  });

  it("ticks guided steps locally without calling the server", async () => {
    mount();
    const box = (await screen.findByLabelText("Download the retained packet.")) as HTMLInputElement;
    fireEvent.click(box);
    expect(box.checked).toBe(true);
    expect(calls).toEqual([]);
  });

  it("records the receipt with the attempt's version and its fields, then reloads", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Record receipt" }));
    const save = screen.getAllByRole("button", { name: "Record receipt" }).at(-1) as HTMLElement;
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Confirmation or tracking reference/i), {
      target: { value: "CONF-7731" },
    });
    fireEvent.change(screen.getByLabelText(/Received on/i), {
      target: { value: "2026-09-10T12:00" },
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: "Record receipt" }).at(-1) as HTMLElement,
    );
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/appeals/${APPEAL}/submission-receipt`,
      ifMatch: "3",
      body: { attemptId: ATTEMPT, confirmationRef: "CONF-7731" },
    });
    expect(typeof calls[0]?.body.receiptAt).toBe("string");
    expect(calls[0]?.body.receiptDocumentId).toBeUndefined();
    await waitFor(() => expect(gets).toBeGreaterThan(1));
    expect(await screen.findByText("Receipt recorded.")).toBeTruthy();
  });

  it("sends the optional receipt document id when given", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Record receipt" }));
    fireEvent.change(screen.getByLabelText(/Confirmation or tracking reference/i), {
      target: { value: "CONF-1" },
    });
    fireEvent.change(screen.getByLabelText(/Receipt copy document ID/i), {
      target: { value: "cccccccc-3333-4333-8333-cccccccccccc" },
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: "Record receipt" }).at(-1) as HTMLElement,
    );
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body.receiptDocumentId).toBe("cccccccc-3333-4333-8333-cccccccccccc");
  });

  it("shows a server refusal verbatim and reloads", async () => {
    refusal = {
      status: 422,
      body: {
        error: {
          code: "APPEAL_DOCUMENT_NOT_ATTACHABLE",
          message: "document x cannot be enclosed in this submission receipt (other_patient)",
        },
      },
    };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Record receipt" }));
    fireEvent.change(screen.getByLabelText(/Confirmation or tracking reference/i), {
      target: { value: "CONF-1" },
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: "Record receipt" }).at(-1) as HTMLElement,
    );
    expect(await screen.findByText(/other_patient/)).toBeTruthy();
    await waitFor(() => expect(gets).toBeGreaterThan(1));
  });

  it("reloads on a stale-version 409 and shows the server's message", async () => {
    refusal = {
      status: 409,
      body: { error: { code: "VERSION_CONFLICT", message: "modified by another writer" } },
    };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Record receipt" }));
    fireEvent.change(screen.getByLabelText(/Confirmation or tracking reference/i), {
      target: { value: "CONF-1" },
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: "Record receipt" }).at(-1) as HTMLElement,
    );
    expect(await screen.findByText(/modified by another writer/)).toBeTruthy();
    await waitFor(() => expect(gets).toBeGreaterThan(1));
  });

  it("keeps the receipt form across a step-up and restores it", async () => {
    refusal = {
      status: 403,
      body: { error: { code: "STEP_UP_REQUIRED", message: "recent verification required" } },
    };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Record receipt" }));
    fireEvent.change(screen.getByLabelText(/Confirmation or tracking reference/i), {
      target: { value: "CONF-KEEP" },
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: "Record receipt" }).at(-1) as HTMLElement,
    );
    await waitFor(() => expect(screen.getByTestId("where").textContent).toMatch(/^\/step-up/));
    cleanup();
    refusal = null;
    mount();
    const field = (await screen.findByLabelText(
      /Confirmation or tracking reference/i,
    )) as HTMLInputElement;
    expect(field.value).toBe("CONF-KEEP");
  });

  it("offers no cancel for an attempt that is waiting for its receipt", async () => {
    mount();
    await screen.findByText(/Proof missing:/);
    expect(screen.queryByRole("button", { name: /cancel attempt/i })).toBeNull();
  });

  it("explains a disabled Record receipt, focuses the first field, and returns focus on close", async () => {
    mount();
    const opener = await screen.findByRole("button", { name: "Record receipt" });
    fireEvent.click(opener);
    const field = screen.getByLabelText(/Confirmation or tracking reference/i);
    expect(document.activeElement).toBe(field);
    expect(
      screen.getByText(/Enter the confirmation reference and a valid received time/i),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close form" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Record receipt" })),
    );
  });

  it("drops the stashed draft when the form is closed", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Record receipt" }));
    fireEvent.change(screen.getByLabelText(/Confirmation or tracking reference/i), {
      target: { value: "CONF-STALE" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close form" }));
    cleanup();
    mount();
    await screen.findByText(/Proof missing:/);
    expect(screen.queryByLabelText(/Confirmation or tracking reference/i)).toBeNull();
  });

  it("ignores a restored draft that points at an attempt that is not here", async () => {
    stashStepUpDraft(stepUpDraftKey(SESSION, "m25-submission", APPEAL), {
      attemptId: "99999999-9999-4999-8999-999999999999",
      confirmationRef: "X",
      receiptAt: "2026-09-10T12:00",
      receiptDocumentId: "",
    });
    mount();
    await screen.findByText(/Proof missing:/);
    expect(screen.queryByLabelText(/Confirmation or tracking reference/i)).toBeNull();
  });

  it("keeps the view and offers Retry when a refresh fails", async () => {
    failAfterFirst = true;
    refusal = {
      status: 409,
      body: { error: { code: "VERSION_CONFLICT", message: "modified by another writer" } },
    };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Record receipt" }));
    fireEvent.change(screen.getByLabelText(/Confirmation or tracking reference/i), {
      target: { value: "CONF-1" },
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: "Record receipt" }).at(-1) as HTMLElement,
    );
    expect(await screen.findByText(/Could not refresh: refresh failed/)).toBeTruthy();
    expect(screen.getByText(/Proof missing:/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("says which value is current: the case keeps the original, corrections sit beside it", async () => {
    attemptState = "acknowledged";
    amendedAttempt = true;
    purpose = "adr_response";
    mount();
    expect(await screen.findByText("Confirmation (on the case)")).toBeTruthy();
    expect(screen.getByText(/case record keeps its original confirmation/i)).toBeTruthy();
    expect(screen.getByText(/CONF-FIXED/)).toBeTruthy();
  });

  it("treats the latest correction as current for an appeal, which has no case column", async () => {
    attemptState = "acknowledged";
    amendedAttempt = true;
    mount();
    expect(await screen.findByText(/Current correction/)).toBeTruthy();
    expect(screen.getByText(/latest correction is the current value/i)).toBeTruthy();
  });

  it("shows an acknowledged receipt and offers only a correction, never an edit", async () => {
    attemptState = "acknowledged";
    mount();
    expect(await screen.findByText("CONF-1")).toBeTruthy();
    expect(screen.queryByText(/Proof missing/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel attempt" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add a correction" }));
    expect(screen.getByText(/cannot be edited; this adds a correction/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add correction" })).toBeTruthy();
  });

  it("says a case with no attempt was filed before submission tracking", async () => {
    attemptState = "none";
    mount();
    expect(await screen.findByText(/filed before submission tracking existed/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Record receipt" })).toBeNull();
  });

  it("shows the load error instead of a blank section", async () => {
    loadFails = true;
    mount();
    expect(await screen.findByText(/submission read failed/)).toBeTruthy();
  });
});
