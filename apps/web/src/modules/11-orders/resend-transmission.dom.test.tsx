// The order detail's "Resend transmission" action (M11 F-182) over RECORDED FETCH CALLS. A lab order whose HL7 request
// was REFUSED before any message was built (`orm_refused:*` / `dispatch_refused:*`) is not on the Held Transmissions
// list, and before this the order view did not say why it failed — so the resend route had no place in the UI. The
// detail now shows the server's failure reason and offers the resend ONLY when the server's `allowedActions` says the
// route would act on it (resendable state + `orders.transmission.recover`). The net asserts what is SENT and that the
// order is re-read afterwards.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrderDetail } from "./order-detail";

const ORDER = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

const NO_ACTIONS = {
  edit: false,
  request_signature: false,
  record_verbal: false,
  sign: false,
  cosign: false,
  complete: false,
  discontinue: false,
  correct: false,
  resend_transmission: false,
};

function detail(over: {
  reason?: string | null;
  transmissionStatus?: string;
  resend?: boolean;
}): Record<string, unknown> {
  return {
    id: ORDER,
    patientId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
    admissionId: "dddddddd-4444-4444-8444-dddddddddddd",
    kind: "lab",
    status: "active",
    priority: "routine",
    version: 1,
    drafterMembershipId: "m-2",
    drafterDiscipline: "rn_case_manager",
    orderingPhysicianMdmId: "cccccccc-3333-4333-8333-cccccccccccc",
    cosignRequired: false,
    cosignStatus: null,
    transmissionStatus: over.transmissionStatus ?? "failed",
    transmissionFailureReason:
      over.reason === undefined ? "orm_refused:patient_sex_unrecorded" : over.reason,
    resultsStatus: "pending",
    verbalDeadlineAt: null,
    discontinuationReason: null,
    replacesOrderId: null,
    triggeringAssessmentId: null,
    triggeringHopeAssessmentId: null,
    signedAt: "2026-10-06T10:00:00.000Z",
    signedBy: "m-3",
    completedAt: null,
    createdAt: "2026-10-06T09:00:00.000Z",
    kindVersion: "1",
    data: {},
    verbalOrder: null,
    requirements: [],
    transmissionAttestations: [],
    pendingRecovery: null,
    allowedActions: { ...NO_ACTIONS, resend_transmission: over.resend ?? true },
  };
}

type Call = { method: string; path: string; body: string };
let calls: Call[] = [];
let current: Record<string, unknown> = detail({});
let resendReply: { status: number; body: unknown } = { status: 200, body: {} };

const json = (code: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { "content-type": "application/json" },
  });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const url = new URL(req.url, "http://localhost");
  const body = req.method === "GET" ? "" : await req.clone().text();
  calls.push({ method: req.method, path: url.pathname, body });
  if (url.pathname === `/api/v1/orders/${ORDER}/resend-transmission` && req.method === "POST")
    return json(resendReply.status, resendReply.body);
  if (url.pathname === `/api/v1/orders/${ORDER}` && req.method === "GET") return json(200, current);
  return json(404, { error: { code: "NOT_FOUND", message: "no", correlationId: "c" } });
}

function mount(): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <ToastProvider>
        <MemoryRouter initialEntries={[`/orders/${ORDER}`]}>
          <Routes>
            <Route path="/orders/:id" element={<OrderDetail />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </ApiClientProvider>,
  );
}

const writes = () => calls.filter((c) => c.method !== "GET");
const reads = () => calls.filter((c) => c.method === "GET").length;

beforeEach(() => {
  calls = [];
  current = detail({});
  resendReply = { status: 200, body: {} };
});
afterEach(() => cleanup());

describe("Order detail — Resend transmission (M11 F-182)", () => {
  it("shows why the transmission failed and resends after a kit-modal confirmation, then re-reads the order", async () => {
    resendReply = {
      status: 200,
      body: {
        outcome: "requested",
        refusalReason: null,
        order: detail({ transmissionStatus: "pending", reason: null, resend: false }),
      },
    };
    mount();
    expect((await screen.findAllByText(/patient's sex is not recorded/i)).length).toBeGreaterThan(
      0,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Resend transmission" }));
    const dialog = await screen.findByRole("dialog", { name: "Resend lab transmission" });
    expect(writes()).toEqual([]);
    const before = reads();
    current = detail({ transmissionStatus: "pending", reason: null, resend: false });
    fireEvent.click(within(dialog).getByRole("button", { name: "Resend now" }));

    await waitFor(() => expect(writes().length).toBe(1));
    expect(writes()[0]?.path).toBe(`/api/v1/orders/${ORDER}/resend-transmission`);
    expect(writes()[0]?.body).toBe("");
    expect(await screen.findByText(/Sent to the lab interface again/)).toBeTruthy();
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Resend transmission" })).toBeNull(),
    );
  });

  it("reports a still-refused resend with the producer's new reason", async () => {
    resendReply = {
      status: 200,
      body: {
        outcome: "still_refused",
        refusalReason: "no_active_feed",
        order: detail({ reason: "orm_refused:no_active_feed" }),
      },
    };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Resend transmission" }));
    const dialog = await screen.findByRole("dialog", { name: "Resend lab transmission" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Resend now" }));
    expect(await screen.findByText(/still could not be sent/i)).toBeTruthy();
    expect(screen.getAllByText(/no active lab interface/i).length).toBeGreaterThan(0);
  });

  it("does not offer a resend when the server's allowedActions does not (state or permission)", async () => {
    current = detail({ resend: false });
    mount();
    expect((await screen.findAllByText(/patient's sex is not recorded/i)).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByRole("button", { name: "Resend transmission" })).toBeNull();
  });

  it("shows nothing about a failure the reader may not see (reason redacted to null)", async () => {
    current = detail({ reason: null, resend: false });
    mount();
    await screen.findByText("Order information");
    expect(screen.queryByText(/Failure reason/)).toBeNull();
  });

  it("renders the server's 409 refusal from the error envelope inside the modal", async () => {
    resendReply = {
      status: 409,
      body: {
        error: {
          code: "CONFLICT",
          message: "ORM resend not allowed (not_failed): the transmission status is 'pending'",
          correlationId: "c-1",
        },
      },
    };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Resend transmission" }));
    const dialog = await screen.findByRole("dialog", { name: "Resend lab transmission" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Resend now" }));
    expect(await within(dialog).findByText(/ORM resend not allowed \(not_failed\)/)).toBeTruthy();
  });

  it("maps a 403 to a plain not-permitted message", async () => {
    resendReply = {
      status: 403,
      body: { error: { code: "FORBIDDEN", message: "forbidden", correlationId: "c-2" } },
    };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Resend transmission" }));
    const dialog = await screen.findByRole("dialog", { name: "Resend lab transmission" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Resend now" }));
    expect(await within(dialog).findByText(/orders\.transmission\.recover/)).toBeTruthy();
  });
});
