// apps/web/src/modules/25-remittance — milestone 2b ADR response packet. Asserts on RECORDED FETCH CALLS (method,
// path, If-Match, body) like the other M25 write tests, so a control wired to a handler that never fires still
// fails. The server owns every rule and its refusal is shown verbatim; the filing form survives the step-up trip.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { AdrWorklist } from "./adr-worklist";

const ADR = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const CLAIM = "dddddddd-4444-4444-8444-dddddddddddd";
const DOC = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
const ME = "ffffffff-6666-4666-8666-ffffffffffff";
const OTHER = "99999999-7777-4777-8777-999999999999";
const KEYS = [
  "certification_of_terminal_illness",
  "election_statement",
  "plan_of_care",
  "physician_orders",
  "visit_notes",
  "medical_records_cover",
];

type Call = { method: string; path: string; ifMatch: string | null; body: Record<string, unknown> };
let calls: Call[] = [];
let refusal: { status: number; body: unknown } | null = null;
let state = "in_assembly";
let packet = emptyPacket();

function emptyPacket() {
  return {
    documents: [] as {
      id: string;
      documentId: string;
      checklistKey: string | null;
      attachedAt: string;
    }[],
    checklist: KEYS.map((key) => ({ key, state: "pending" })),
    sentToReviewByMembershipId: null as string | null,
    reviewedByMembershipId: null as string | null,
    reviewedAt: null as string | null,
    filing: null as null | Record<string, unknown>,
  };
}

const summary = () => ({
  id: ADR,
  claimId: CLAIM,
  denialCaseId: null,
  macName: "CGS",
  reviewType: "adr",
  state,
  adrReference: null,
  requestedOn: "2026-01-28",
  windowDays: 45,
  windowSource: "platform_default",
  windowVerified: false,
  responseDueAt: "2099-03-13T04:59:59.999Z",
  dueDay: "2099-03-13",
  version: 4,
});
const detail = () => ({
  ...summary(),
  packet,
  calendarDueDay: "2099-03-13",
  events: [{ id: "e1", eventKind: "received", occurredAt: "2026-02-01T00:00:00.000Z" }],
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
    return json(200, { id: ADR, version: 5 });
  }
  if (path === "/api/v1/adrs") return json(200, { items: [summary()] });
  if (path === `/api/v1/adrs/${ADR}`) return json(200, detail());
  return json(200, {});
}

const base = { roles: ["billing_specialist"], permissions: [], isAdmin: false };
const SESSION = { ...base, userId: "user-1", organizationId: "org-1", membershipId: ME };

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
              <Route path="/work" element={<AdrWorklist />} />
              <Route path="*" element={<Where />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}
const open = async () =>
  fireEvent.click(await screen.findByRole("button", { name: "Open ADR from CGS" }));

beforeEach(() => {
  calls = [];
  refusal = null;
  state = "in_assembly";
  packet = emptyPacket();
  window.sessionStorage.clear();
});
afterEach(() => cleanup());

describe("M25 ADR packet: assembly", () => {
  it("attaches a document with the checklist item it answers, under If-Match", async () => {
    mount();
    await open();
    const attach = await screen.findByRole("button", { name: "Attach document" });
    expect((attach as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Document ID to attach"), { target: { value: DOC } });
    fireEvent.change(screen.getByLabelText("Answers checklist item (optional)"), {
      target: { value: "plan_of_care" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Attach document" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/adrs/${ADR}/documents`,
      ifMatch: "4",
      body: { documentId: DOC, checklistKey: "plan_of_care" },
    });
  });

  it("removes an attached document and ticks a checklist item", async () => {
    packet = {
      ...emptyPacket(),
      documents: [
        {
          id: "d1",
          documentId: DOC,
          checklistKey: "plan_of_care",
          attachedAt: "2026-02-02T00:00:00.000Z",
        },
      ],
    };
    mount();
    await open();
    fireEvent.click(await screen.findByRole("button", { name: `Remove document ${DOC}` }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "DELETE",
      path: `/api/v1/adrs/${ADR}/documents/${DOC}`,
      ifMatch: "4",
    });
    fireEvent.change(screen.getByLabelText("Plan Of Care"), { target: { value: "ready" } });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toMatchObject({
      method: "PUT",
      path: `/api/v1/adrs/${ADR}/checklist/plan_of_care`,
      body: { state: "ready" },
    });
  });

  it("shows the server's refusal of a document verbatim", async () => {
    refusal = {
      status: 422,
      body: {
        error: {
          code: "APPEAL_DOCUMENT_NOT_ATTACHABLE",
          message: `document ${DOC} cannot be enclosed in this ADR response (part2_restricted)`,
        },
      },
    };
    mount();
    await open();
    await screen.findByRole("button", { name: "Attach document" });
    fireEvent.change(screen.getByLabelText("Document ID to attach"), { target: { value: DOC } });
    fireEvent.click(screen.getByRole("button", { name: "Attach document" }));
    expect(await screen.findByText(/part2_restricted/)).toBeTruthy();
  });
});

describe("M25 ADR packet: review", () => {
  beforeEach(() => {
    state = "in_review";
  });

  it("will not let the person who sent the packet to review sign it off", async () => {
    packet = { ...emptyPacket(), sentToReviewByMembershipId: ME };
    mount();
    await open();
    const signOff = await screen.findByRole("button", { name: "Sign off packet" });
    expect((signOff as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/someone else with review access must sign it off/)).toBeTruthy();
  });

  it("lets a different reviewer sign off, under If-Match", async () => {
    packet = { ...emptyPacket(), sentToReviewByMembershipId: OTHER };
    mount();
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Sign off packet" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/adrs/${ADR}/sign-off`,
      ifMatch: "4",
    });
  });

  it("offers no way to record a filing before sign-off", async () => {
    packet = { ...emptyPacket(), sentToReviewByMembershipId: OTHER };
    mount();
    await open();
    await screen.findByRole("button", { name: "Sign off packet" });
    expect(screen.queryByRole("button", { name: "Record filing" })).toBeNull();
  });
});

describe("M25 ADR packet: record the filing", () => {
  beforeEach(() => {
    state = "in_review";
    packet = {
      ...emptyPacket(),
      sentToReviewByMembershipId: OTHER,
      reviewedByMembershipId: ME,
      reviewedAt: "2026-03-01T00:00:00.000Z",
    };
  });

  it("needs a confirmation reference, then posts the proof", async () => {
    mount();
    await open();
    const record = await screen.findByRole("button", { name: "Record filing" });
    expect((record as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Sent by"), { target: { value: "fax" } });
    fireEvent.change(screen.getByLabelText("Confirmation or tracking reference"), {
      target: { value: "FAX-123" },
    });
    expect(
      (screen.getByRole("button", { name: "Record filing" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Record filing" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/adrs/${ADR}/submit`,
      ifMatch: "4",
      body: { channel: "fax", confirmationRef: "FAX-123" },
    });
    expect(typeof calls[0]?.body.filedAt).toBe("string");
    expect(calls[0]?.body.lateAcknowledged).toBeUndefined();
  });

  it("asks for an acknowledgement when the response was sent after the due date", async () => {
    mount();
    await open();
    await screen.findByRole("button", { name: "Record filing" });
    fireEvent.change(screen.getByLabelText("Confirmation or tracking reference"), {
      target: { value: "MAIL-9" },
    });
    expect(screen.queryByText(/sent after the due date/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Sent on"), { target: { value: "2100-01-01T10:00" } });
    const ack = await screen.findByRole("checkbox");
    expect(
      (screen.getByRole("button", { name: "Record filing" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(ack);
    fireEvent.click(screen.getByRole("button", { name: "Record filing" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({ channel: "mac_portal", lateAcknowledged: true });
  });

  it("sends the person through step-up and restores what they typed", async () => {
    refusal = { status: 403, body: { error: { code: "STEP_UP_REQUIRED", message: "step up" } } };
    mount();
    await open();
    await screen.findByRole("button", { name: "Record filing" });
    fireEvent.change(screen.getByLabelText("Confirmation or tracking reference"), {
      target: { value: "CONF-777" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record filing" }));
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toContain("/step-up?returnTo="),
    );
    cleanup();

    refusal = null;
    mount(); // back from /step-up: the case reopens by itself with the form restored
    const ref = (await screen.findByLabelText(
      "Confirmation or tracking reference",
    )) as HTMLInputElement;
    expect(ref.value).toBe("CONF-777");
    fireEvent.click(screen.getByRole("button", { name: "Record filing" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.body).toMatchObject({ confirmationRef: "CONF-777" });
  });
});

describe("M25 ADR packet: after filing", () => {
  it("shows the proof and offers no more packet changes", async () => {
    state = "submitted";
    packet = {
      ...emptyPacket(),
      sentToReviewByMembershipId: OTHER,
      reviewedByMembershipId: ME,
      reviewedAt: "2026-03-01T00:00:00.000Z",
      filing: {
        channel: "mac_portal",
        confirmationRef: "CONF-90210",
        filedAt: "2026-03-10T15:00:00.000Z",
        filedLate: true,
        receiptDocumentId: null,
      },
    };
    mount();
    await open();
    expect(await screen.findByText("CONF-90210")).toBeTruthy();
    expect(screen.getByText("Filed after the due date")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Attach document" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Record filing" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign off packet" })).toBeNull();
  });
});
