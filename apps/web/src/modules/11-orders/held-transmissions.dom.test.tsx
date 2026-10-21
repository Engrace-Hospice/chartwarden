// GAP-125 — the Held Transmissions queue (F-201 / F-187 / F-188 / F-202) over RECORDED FETCH CALLS. Before this screen a
// lab order whose HL7 message dead-ended (retries exhausted, rejected by the lab interface, or a blocked recovery) could
// be recovered only through the API. The net asserts what is SENT: the attestation body, the co-sign / cancel paths, and
// that a step-up refusal round-trips through `/step-up` with the operator's typed evidence intact.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes, useNavigate, useSearchParams } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { HeldTransmissions } from "./held-transmissions";

const ORDER = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ORDER_2 = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const PATIENT = "cccccccc-3333-4333-8333-cccccccccccc";
const REQUEST = "dddddddd-4444-4444-8444-dddddddddddd";

const HELD = {
  orderId: ORDER,
  patientId: PATIENT,
  reason: "dlq_exhausted",
  failedAt: "2026-10-06T08:00:00.000000Z",
  ageSeconds: 26 * 3600,
  stage: "critical",
  feedId: null,
};
const HELD_2 = {
  ...HELD,
  orderId: ORDER_2,
  reason: "application_reject",
  ageSeconds: 5 * 3600,
  stage: "warn",
};

const PENDING = {
  id: REQUEST,
  orderId: ORDER,
  status: "pending_cosign",
  supersededReason: null,
  requestedByMembershipId: "m-other",
  requestedAt: "2026-10-07T08:00:00.000Z",
  expiresAt: "2026-10-08T08:00:00.000Z",
  cosignedByMembershipId: null,
  resolvedAt: null,
  labContactName: "Dana Lee",
  labReference: "LAB-4471",
};

type Call = { method: string; path: string; query: string; body: Record<string, unknown> };
let calls: Call[] = [];
let pendingRecovery: typeof PENDING | null = null;
let page2 = false;
let listStatus = 200;
let writeFailure: { status: number; body: unknown } | null = null;
let patientReadable = true;

const json = (code: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { "content-type": "application/json" },
  });

const detail = (id: string) => ({
  id,
  patientId: PATIENT,
  admissionId: "eeeeeeee-5555-4555-8555-eeeeeeeeeeee",
  kind: "lab",
  status: "active",
  priority: "routine",
  transmissionStatus: "failed",
  resultsStatus: "pending",
  transmissionAttestations: [],
  pendingRecovery,
});

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === "object" && "url" in input ? (input as Request) : null;
  const url = new URL(req ? req.url : String(input), "http://localhost");
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  const raw = method !== "GET" && req ? await req.clone().text() : "";
  calls.push({ method, path: url.pathname, query: url.search, body: raw ? JSON.parse(raw) : {} });
  if (method !== "GET" && writeFailure) return json(writeFailure.status, writeFailure.body);
  if (url.pathname === `/api/v1/patients/${PATIENT}`)
    return patientReadable
      ? json(200, { id: PATIENT, firstName: "Ada", lastName: "Lovelace", mrn: "MRN-0042" })
      : json(403, { error: { code: "FORBIDDEN", message: "out of scope" } });
  if (url.pathname === "/api/v1/orders/held-transmissions") {
    if (listStatus !== 200)
      return json(listStatus, { error: { code: "FORBIDDEN", message: "requires permission" } });
    if (url.searchParams.get("cursor") === "c-1")
      return json(200, { items: [HELD_2], nextCursor: null });
    return json(200, { items: [HELD], nextCursor: page2 ? "c-1" : null });
  }
  if (url.pathname.endsWith("/recover-transmission") && method === "POST")
    return json(200, {
      outcome: "pending_cosign",
      refusalReason: null,
      order: detail(ORDER),
      recovery: PENDING,
    });
  if (url.pathname.endsWith("/cosign") && method === "POST")
    return json(200, {
      outcome: "redispatched",
      refusalReason: null,
      order: detail(ORDER),
      recovery: PENDING,
    });
  if (url.pathname.endsWith("/cancel") && method === "POST")
    return json(200, { recovery: { ...PENDING, status: "cancelled" }, order: detail(ORDER) });
  if (url.pathname.startsWith("/api/v1/orders/") && method === "GET")
    return json(200, detail(url.pathname.split("/").pop() as string));
  return json(404, { error: { code: "NOT_FOUND", message: "no" } });
}

const RECOVERER = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "m-1",
  roles: ["clinical_supervisor"],
  permissions: ["orders.read", "orders.transmission.view_held", "orders.transmission.recover"],
  isAdmin: false,
};

/** Stands in for 02-identity/step-up.tsx: a verified factor navigates back to `?returnTo`. */
function StepUpStub(): JSX.Element {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  return (
    <div>
      step-up ceremony
      <button type="button" onClick={() => navigate(params.get("returnTo") ?? "/")}>
        Verify
      </button>
    </div>
  );
}

function mount(session = RECOVERER): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={session}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/orders/held-transmissions"]}>
            <Routes>
              <Route path="/orders/held-transmissions" element={<HeldTransmissions />} />
              <Route path="/step-up" element={<StepUpStub />} />
              <Route path="/patients/:id" element={<div>patient chart</div>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

const writes = () => calls.filter((c) => c.method !== "GET");

async function openFirstRow(): Promise<HTMLElement> {
  const table = await screen.findByRole("table", { name: "Held lab-order transmissions" });
  fireEvent.click(table.querySelector("tbody tr") as HTMLElement);
  return screen.findByRole("complementary", { name: /Held lab order/ });
}

function fillEvidence(drawer: HTMLElement, name: string, ref: string): void {
  fireEvent.change(within(drawer).getByLabelText(/Lab contact name/), { target: { value: name } });
  fireEvent.change(within(drawer).getByLabelText(/Lab reference/), { target: { value: ref } });
}

beforeEach(() => {
  calls = [];
  pendingRecovery = null;
  page2 = false;
  listStatus = 200;
  writeFailure = null;
  patientReadable = true;
  window.sessionStorage.clear();
});
afterEach(() => cleanup());

describe("Held Transmissions (M11 F-201, GAP-125)", () => {
  it("lists held lab orders with a readable reason, how long they have been held, and the aging stage", async () => {
    page2 = true;
    mount();
    const table = await screen.findByRole("table", { name: "Held lab-order transmissions" });
    const row = table.querySelector("tbody tr") as HTMLElement;
    expect(within(row).getByText(/Retries exhausted/)).toBeTruthy();
    expect(within(row).getByText("1 d 2 h")).toBeTruthy();
    expect(within(row).getByText("Critical")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(table.querySelectorAll("tbody tr").length).toBe(2));
    expect(calls.some((c) => c.query.includes("cursor=c-1"))).toBe(true);
    expect(within(table).getByText(/Rejected by the lab interface/)).toBeTruthy();
  });

  it("shows the patient's name linked to the chart in the row and the drawer, not a uuid", async () => {
    mount();
    const table = await screen.findByRole("table", { name: "Held lab-order transmissions" });
    const row = table.querySelector("tbody tr") as HTMLElement;
    const link = await within(row).findByRole("link", { name: "Lovelace, Ada" });
    expect(link.getAttribute("href")).toBe(`/patients/${PATIENT}`);
    expect(within(row).getByText("MRN-0042")).toBeTruthy();
    expect(within(row).queryByText(/cccccccc/)).toBeNull();

    fireEvent.click(row);
    const drawer = await screen.findByRole("complementary", { name: /Held lab order/ });
    expect(within(drawer).getByRole("link", { name: "Lovelace, Ada" })).toBeTruthy();

    fireEvent.click(link);
    expect(await screen.findByText("patient chart")).toBeTruthy();
  });

  it("falls back to the short patient id when the name cannot be read", async () => {
    patientReadable = false;
    mount();
    const table = await screen.findByRole("table", { name: "Held lab-order transmissions" });
    const row = table.querySelector("tbody tr") as HTMLElement;
    expect(await within(row).findByText("cccccccc…cccc")).toBeTruthy();
    expect(within(row).queryByRole("link")).toBeNull();
  });

  it("keeps the step-up lock glyph inline with its text", async () => {
    mount();
    const drawer = await openFirstRow();
    const text = await within(drawer).findByText(/Requires a fresh step-up/);
    expect(text.classList.contains("wx-source-text")).toBe(true);
    const line = text.parentElement as HTMLElement;
    expect(line.classList.contains("wx-source-line")).toBe(true);
    expect(line.querySelector(":scope > svg")).toBeTruthy();
  });

  it("files an attested recovery with the structured lab-contact evidence", async () => {
    mount();
    const drawer = await openFirstRow();
    await waitFor(() => expect(calls.some((c) => c.path === `/api/v1/orders/${ORDER}`)).toBe(true));
    fireEvent.click(within(drawer).getByRole("button", { name: /Lab did not receive it/ }));
    fillEvidence(drawer, "Dana Lee", "LAB-4471");
    fireEvent.click(within(drawer).getByRole("button", { name: "Record attestation" }));
    await waitFor(() => expect(writes().length).toBe(1));
    expect(writes()[0]?.path).toBe(`/api/v1/orders/${ORDER}/recover-transmission`);
    expect(writes()[0]?.body).toEqual({
      attestation: "not_received_by_lab",
      contactName: "Dana Lee",
      labReference: "LAB-4471",
    });
    expect(await within(drawer).findByText(/co-sign within 24 hours/)).toBeTruthy();
  });

  it("refuses evidence that could carry a patient identifier before sending it", async () => {
    mount();
    const drawer = await openFirstRow();
    fireEvent.click(within(drawer).getByRole("button", { name: /Lab already has it/ }));
    fillEvidence(drawer, "Dana 1955", "has space");
    fireEvent.click(within(drawer).getByRole("button", { name: "Record attestation" }));
    expect(await within(drawer).findByText(/letters, spaces/)).toBeTruthy();
    expect(within(drawer).getByText(/no spaces/)).toBeTruthy();
    expect(writes().length).toBe(0);
  });

  it("a step-up refusal goes through /step-up and the typed evidence survives the round trip", async () => {
    writeFailure = {
      status: 403,
      body: { error: { code: "STEP_UP_REQUIRED", message: "step-up required" } },
    };
    mount();
    const drawer = await openFirstRow();
    fireEvent.click(within(drawer).getByRole("button", { name: /Lab already has it/ }));
    fillEvidence(drawer, "Dana Lee", "LAB-4471");
    fireEvent.click(within(drawer).getByRole("button", { name: "Record attestation" }));
    expect(await screen.findByText("step-up ceremony")).toBeTruthy();
    cleanup();

    writeFailure = null;
    mount();
    const back = await screen.findByRole("complementary", { name: /Held lab order/ });
    expect((within(back).getByLabelText(/Lab contact name/) as HTMLInputElement).value).toBe(
      "Dana Lee",
    );
    expect((within(back).getByLabelText(/Lab reference/) as HTMLInputElement).value).toBe(
      "LAB-4471",
    );
    expect(
      within(back)
        .getByRole("button", { name: /Lab already has it/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("returning from /step-up in the same session reopens the order with the choice and evidence, then sends them", async () => {
    writeFailure = {
      status: 403,
      body: { error: { code: "STEP_UP_REQUIRED", message: "step-up required" } },
    };
    mount();
    const drawer = await openFirstRow();
    fireEvent.click(within(drawer).getByRole("button", { name: /Lab did not receive it/ }));
    fillEvidence(drawer, "Dana Lee", "LAB-4471");
    fireEvent.click(within(drawer).getByRole("button", { name: "Record attestation" }));
    expect(await screen.findByText("step-up ceremony")).toBeTruthy();

    writeFailure = null;
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    const back = await screen.findByRole("complementary", { name: /Held lab order/ });
    expect(
      within(back)
        .getByRole("button", { name: /Lab did not receive it/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect((within(back).getByLabelText(/Lab contact name/) as HTMLInputElement).value).toBe(
      "Dana Lee",
    );
    expect((within(back).getByLabelText(/Lab reference/) as HTMLInputElement).value).toBe(
      "LAB-4471",
    );

    fireEvent.click(within(back).getByRole("button", { name: "Record attestation" }));
    await waitFor(() => expect(writes().length).toBe(2));
    expect(writes()[1]?.body).toEqual({
      attestation: "not_received_by_lab",
      contactName: "Dana Lee",
      labReference: "LAB-4471",
    });
    expect(await within(back).findByText(/co-sign within 24 hours/)).toBeTruthy();
    // A successful submit consumes the draft: a later visit does not reopen the order.
    cleanup();
    mount();
    await screen.findByRole("table", { name: "Held lab-order transmissions" });
    expect(screen.queryByRole("complementary", { name: /Held lab order/ })).toBeNull();
  });

  it("closing the drawer drops the stashed evidence", async () => {
    writeFailure = {
      status: 403,
      body: { error: { code: "STEP_UP_REQUIRED", message: "step-up required" } },
    };
    mount();
    const drawer = await openFirstRow();
    fireEvent.click(within(drawer).getByRole("button", { name: /Lab already has it/ }));
    fillEvidence(drawer, "Dana Lee", "LAB-4471");
    fireEvent.click(within(drawer).getByRole("button", { name: "Record attestation" }));
    fireEvent.click(await screen.findByRole("button", { name: "Verify" }));
    const back = await screen.findByRole("complementary", { name: /Held lab order/ });
    fireEvent.click(within(back).getByRole("button", { name: "Close" }));
    cleanup();

    mount();
    await screen.findByRole("table", { name: "Held lab-order transmissions" });
    expect(screen.queryByRole("complementary", { name: /Held lab order/ })).toBeNull();
  });

  it("a pending two-person recovery offers co-sign and cancel, and renders a 409 from the envelope", async () => {
    pendingRecovery = PENDING;
    mount();
    const drawer = await openFirstRow();
    expect(await within(drawer).findByText(/Awaiting a second person/)).toBeTruthy();
    expect(within(drawer).getByText("LAB-4471")).toBeTruthy();
    expect(within(drawer).queryByRole("button", { name: "Record attestation" })).toBeNull();

    fireEvent.click(within(drawer).getByRole("button", { name: "Co-sign re-dispatch" }));
    await waitFor(() =>
      expect(writes()[0]?.path).toBe(
        `/api/v1/orders/${ORDER}/recover-transmission/${REQUEST}/cosign`,
      ),
    );
    expect(await within(drawer).findByText(/Re-sent to the lab/)).toBeTruthy();

    writeFailure = {
      status: 409,
      body: {
        error: {
          code: "CONFLICT",
          message:
            "a recovery must be co-signed by a different person than the one who requested it",
        },
      },
    };
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel request" }));
    await waitFor(() =>
      expect(writes()[1]?.path).toBe(
        `/api/v1/orders/${ORDER}/recover-transmission/${REQUEST}/cancel`,
      ),
    );
    expect((await within(drawer).findByRole("alert")).textContent).toMatch(/different person/);
  });

  it("does not offer co-sign to the person who filed the request", async () => {
    pendingRecovery = { ...PENDING, requestedByMembershipId: "m-1" };
    mount();
    const drawer = await openFirstRow();
    expect(await within(drawer).findByText(/You filed this request/)).toBeTruthy();
    expect(within(drawer).queryByRole("button", { name: "Co-sign re-dispatch" })).toBeNull();
    expect(within(drawer).getByRole("button", { name: "Cancel request" })).toBeTruthy();
  });

  it("a viewer without orders.transmission.recover sees the queue but no recovery controls", async () => {
    mount({ ...RECOVERER, permissions: ["orders.read", "orders.transmission.view_held"] });
    const drawer = await openFirstRow();
    expect(await within(drawer).findByText(/orders\.transmission\.recover/)).toBeTruthy();
    expect(within(drawer).queryByRole("button", { name: "Record attestation" })).toBeNull();
  });

  it("a forbidden list read explains the missing grant", async () => {
    listStatus = 403;
    mount();
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /orders\.transmission\.view_held/,
    );
  });
});
