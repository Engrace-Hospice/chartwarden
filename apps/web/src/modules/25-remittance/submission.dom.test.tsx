// apps/web/src/modules/25-remittance — milestone 6a submission panel. Asserts on RECORDED FETCH CALLS (method, path,
// If-Match, body) like the other M25 write tests, so a control wired to a handler that never fires still fails. The
// server owns every rule and its refusal is shown verbatim; the receipt form survives a step-up; "proof missing" is
// a visible state; and "Approve and send" is disabled with its reason.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { SubmissionPanel } from "./submission-panel";

const APPEAL = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ATTEMPT = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const ME = "ffffffff-6666-4666-8666-ffffffffffff";

type Call = { method: string; path: string; ifMatch: string | null; body: Record<string, unknown> };
let calls: Call[] = [];
let refusal: { status: number; body: unknown } | null = null;
let attemptState: "needs_manual" | "acknowledged" | "none" = "needs_manual";
let loadFails = false;
let gets = 0;

const attempt = () => ({
  id: ATTEMPT,
  purpose: "appeal_request",
  attemptNo: 1,
  channel: attemptState === "acknowledged" ? "mac_portal" : null,
  adapter: "manual",
  status: attemptState,
  needsManualReason:
    attemptState === "needs_manual" ? "Filed outside WardenX. Record the receipt." : null,
  confirmationRef: attemptState === "acknowledged" ? "CONF-1" : null,
  receiptAt: attemptState === "acknowledged" ? "2026-09-10T12:00:00.000Z" : null,
  receiptDocumentId: null,
  receiptSource: attemptState === "acknowledged" ? "entered" : null,
  amendments: [],
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
    const send = screen.getByRole("button", { name: "Approve and send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(
      screen.getByText("Electronic channel not configured. Use guided manual submission."),
    ).toBeTruthy();
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

  it("cancels an attempt that has no receipt", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel attempt" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/appeals/${APPEAL}/submission-cancel`,
      ifMatch: "3",
      body: { attemptId: ATTEMPT },
    });
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
