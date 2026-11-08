import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// Review of slice 4, MEDIUM-1 — the held-transmission notice and the administrator's Resolve action on the medication-order detail (the existing
// transmission view). `POST /api/v1/medication-orders/:id/resolve-held-transmission` (`prescribing.clinic.admin` + a fresh step-up). The notice
// shows for a queued order whose transmission read says `unconfirmed_outcome`; only an administrator is offered the action; the request carries the
// outcome, the reason and (for "sent") the DoseSpot prescription id; a stale step-up goes to the step-up page; a refusal is shown as a sentence.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { MedicationDetail } from "../medication-detail";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ORDER = "cccccccc-3333-4333-8333-cccccccccccc";

let status = "queued_for_transmission";
let transmissionStatus = "unconfirmed_outcome";
let writeFailure: { status: number; body: unknown } | null = null;
let calls: string[] = [];
let postedBodies: unknown[] = [];

const order = () => ({
  id: ORDER,
  patientId: PATIENT,
  admissionId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
  medClass: "standard",
  status,
  drugName: "Morphine Sulfate 20 MG/ML Oral Solution",
  strength: "20 mg/mL",
  doseForm: "Oral Solution",
  route: "Oral",
  rxnormRxcui: "1730193",
  ndc: "00054023549",
  prescriberDiscipline: "hospice_physician",
  prescribingPhysicianMdmId: "mdm-1",
  dispensingPharmacyMdmId: null,
  isControlledSubstance: false,
  deaSchedule: null,
  cosignRequired: false,
  cosignStatus: null,
  refillsRemaining: 0,
  derivedFromRefillId: null,
  replacesMedicationOrderId: null,
  signedAt: "2026-10-06T09:00:00.000Z",
  signedBy: "m-1",
  transmittedAt: null,
  discontinuedAt: null,
  discontinuationReason: null,
  createdAt: "2026-10-06T08:00:00.000Z",
  hospiceCoverage: "covered_related",
  coverageReason: null,
  coverageDeterminedAt: null,
  coverageDeterminedBy: null,
});

const json = (code: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { "content-type": "application/json" },
  });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === "object" && "url" in input ? (input as Request) : null;
  const url = new URL(req ? req.url : String(input), "http://localhost");
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  calls.push(`${method} ${url.pathname}`);
  if (method === "POST" && url.pathname.endsWith("/resolve-held-transmission")) {
    postedBodies.push(JSON.parse(await (req ? req.clone().text() : String(init?.body ?? "{}"))));
    return writeFailure
      ? json(writeFailure.status, writeFailure.body)
      : json(200, { orderId: ORDER, outcome: "not_sent", status: "transmission_failed" });
  }
  if (url.pathname === `/api/v1/medication-orders/${ORDER}/transmission`)
    return json(200, { orderId: ORDER, status: transmissionStatus, retryHistory: [] });
  if (url.pathname === `/api/v1/medication-orders/${ORDER}`) return json(200, order());
  return json(404, { error: { code: "NOT_FOUND", message: "no" } });
}

const ADMIN = {
  userId: "user-9",
  organizationId: "org-1",
  membershipId: "m-9",
  roles: ["org_admin"],
  permissions: ["prescribing.read", "prescribing.clinic.admin"],
  isAdmin: true,
};

function Where(): null {
  const location = useLocation();
  calls.push(`AT ${location.pathname}${location.search}`);
  return null;
}

function mount(session = ADMIN): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={session}>
        <ToastProvider>
          <MemoryRouter initialEntries={[`/medication-orders/${ORDER}`]}>
            <Where />
            <Routes>
              <Route path="/medication-orders/:id" element={<MedicationDetail />} />
              <Route path="/step-up" element={<p>step-up page</p>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

const writes = () => calls.filter((c) => c.startsWith("POST "));
const REASON = "Checked the prescriber's DoseSpot account with the clinic lead.";

beforeEach(() => {
  status = "queued_for_transmission";
  transmissionStatus = "unconfirmed_outcome";
  writeFailure = null;
  calls = [];
  postedBodies = [];
});
afterEach(() => cleanup());

describe("a held transmission on the medication-order detail", () => {
  it("shows the held notice, and offers an administrator Resolve", async () => {
    mount();
    expect(await screen.findByText("Held: outcome unconfirmed")).toBeTruthy();
    expect(screen.getByText(/will not send it again/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resolve held transmission" })).toBeTruthy();
  });

  it("tells anyone else to ask an administrator, and offers no action", async () => {
    mount({ ...ADMIN, permissions: ["prescribing.read", "prescribing.sign"], isAdmin: false });
    expect(await screen.findByText("Held: outcome unconfirmed")).toBeTruthy();
    expect(screen.getByText("Ask an administrator to resolve it.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resolve held transmission" })).toBeNull();
  });

  it("shows nothing for an ordinary queued order or one that is not queued", async () => {
    transmissionStatus = "queued";
    mount();
    await screen.findAllByText(/Morphine/);
    expect(screen.queryByText("Held: outcome unconfirmed")).toBeNull();
    cleanup();
    status = "active";
    transmissionStatus = "unconfirmed_outcome"; // never read for an active order
    calls = [];
    mount();
    await screen.findAllByText(/Morphine/);
    expect(screen.queryByText("Held: outcome unconfirmed")).toBeNull();
    expect(calls).not.toContain(`GET /api/v1/medication-orders/${ORDER}/transmission`);
  });

  it("resolves as NOT sent: the request carries the outcome and the reason and no prescription id, then the detail reloads", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Resolve held transmission" }));
    const dialog = await screen.findByRole("dialog", { name: "Resolve held transmission" });
    const resolve = within(dialog).getByRole("button", { name: "Resolve" }) as HTMLButtonElement;
    expect(resolve.disabled).toBe(true); // no reason yet
    expect(within(dialog).queryByLabelText("DoseSpot prescription id")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(/What you checked/), {
      target: { value: REASON },
    });
    fireEvent.click(resolve);
    await waitFor(() =>
      expect(writes()).toEqual([
        `POST /api/v1/medication-orders/${ORDER}/resolve-held-transmission`,
      ]),
    );
    expect(postedBodies).toEqual([{ outcome: "not_sent", reason: REASON }]);
    await waitFor(() =>
      expect(calls.filter((c) => c === `GET /api/v1/medication-orders/${ORDER}`).length).toBe(2),
    );
  });

  it("resolves as SENT: the prescription id is required and is sent with the request", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Resolve held transmission" }));
    const dialog = await screen.findByRole("dialog", { name: "Resolve held transmission" });
    fireEvent.change(within(dialog).getByLabelText("What you found"), {
      target: { value: "sent" },
    });
    fireEvent.change(within(dialog).getByLabelText(/What you checked/), {
      target: { value: REASON },
    });
    const resolve = within(dialog).getByRole("button", { name: "Resolve" }) as HTMLButtonElement;
    expect(resolve.disabled).toBe(true); // sent without an id
    fireEvent.change(within(dialog).getByLabelText("DoseSpot prescription id"), {
      target: { value: "9001" },
    });
    expect(resolve.disabled).toBe(false);
    fireEvent.click(resolve);
    await waitFor(() => expect(postedBodies).toHaveLength(1));
    expect(postedBodies[0]).toEqual({
      outcome: "sent",
      reason: REASON,
      dosespotPrescriptionId: "9001",
    });
  });

  it("maps a refusal to a sentence, and a stale step-up goes to the step-up page", async () => {
    writeFailure = {
      status: 409,
      body: { error: { code: "DOSESPOT_TRANSMISSION_NOT_HELD", message: "raw server text" } },
    };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Resolve held transmission" }));
    const dialog = await screen.findByRole("dialog", { name: "Resolve held transmission" });
    fireEvent.change(within(dialog).getByLabelText(/What you checked/), {
      target: { value: REASON },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Resolve" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/no longer held/);
    expect(within(dialog).getByRole("alert").textContent).not.toMatch(/raw server text/);
    writeFailure = {
      status: 403,
      body: { error: { code: "STEP_UP_REQUIRED", message: "step up" } },
    };
    fireEvent.click(within(dialog).getByRole("button", { name: "Resolve" }));
    await screen.findByText("step-up page");
    expect(calls.some((c) => c.startsWith("AT /step-up?returnTo="))).toBe(true);
  });
});
