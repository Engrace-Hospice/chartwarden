// GAP-125 — the Retransmit action on the medication-order detail. `POST /api/v1/medication-orders/:id/retransmit`
// (`prescribing.sign` + caseload scope + the signer ABAC; NO step-up) mints a REPLACEMENT draft of a
// `transmission_failed` order (`replacesMedicationOrderId` set) — never an in-place resend — which the prescriber then
// sends for signature and signs, and the GAP-037 DoseSpot worker transmits. The net asserts on recorded fetch calls.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { MedicationDetail } from "../medication-detail";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ORDER = "cccccccc-3333-4333-8333-cccccccccccc";
const NEW_ORDER = "ffffffff-6666-4666-8666-ffffffffffff";

let status = "transmission_failed";
let viewerMayRetransmit: boolean | undefined = true;
let writeFailure: { status: number; body: unknown } | null = null;
let calls: string[] = [];

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
  viewerMayRetransmit,
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
  if (method === "POST" && url.pathname.endsWith("/retransmit"))
    return writeFailure
      ? json(writeFailure.status, writeFailure.body)
      : json(201, { newOrderId: NEW_ORDER });
  if (url.pathname === `/api/v1/medication-orders/${ORDER}`) return json(200, order());
  return json(404, { error: { code: "NOT_FOUND", message: "no" } });
}

const PRESCRIBER = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "m-1",
  roles: ["hospice_physician"],
  permissions: ["prescribing.read", "prescribing.sign"],
  isAdmin: false,
};

function mount(session = PRESCRIBER): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={session}>
        <ToastProvider>
          <MemoryRouter initialEntries={[`/medication-orders/${ORDER}`]}>
            <Routes>
              <Route path="/medication-orders/:id" element={<MedicationDetail />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

const writes = () => calls.filter((c) => !c.startsWith("GET "));

beforeEach(() => {
  status = "transmission_failed";
  viewerMayRetransmit = true;
  writeFailure = null;
  calls = [];
});
afterEach(() => cleanup());

describe("GAP-125 — retransmit a transmission_failed medication order", () => {
  it("offers Retransmit, confirms, mints the replacement and opens it", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Retransmit" }));
    const dialog = await screen.findByRole("dialog", { name: "Retransmit medication order" });
    expect(within(dialog).getByText(/replacement order/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create replacement" }));
    await waitFor(() =>
      expect(writes()).toEqual([`POST /api/v1/medication-orders/${ORDER}/retransmit`]),
    );
    // The detail now shows the replacement draft (it re-reads by the new id).
    await waitFor(() => expect(calls).toContain(`GET /api/v1/medication-orders/${NEW_ORDER}`));
  });

  it("is not offered for an order that did not fail transmission", async () => {
    status = "active";
    mount();
    await screen.findAllByText(/Morphine/);
    expect(screen.queryByRole("button", { name: "Retransmit" })).toBeNull();
  });

  it("is not offered without prescribing.sign (the route's permission)", async () => {
    mount({ ...PRESCRIBER, permissions: ["prescribing.read"] });
    await screen.findAllByText(/Morphine/);
    expect(screen.queryByRole("button", { name: "Retransmit" })).toBeNull();
  });

  it("is not offered when the server says this viewer lacks retransmit standing", async () => {
    // A tenant admin holds prescribing.sign but is neither the order's prescriber nor its named physician.
    viewerMayRetransmit = false;
    mount();
    await screen.findAllByText(/Morphine/);
    expect(screen.queryByRole("button", { name: "Retransmit" })).toBeNull();
  });

  it("is not offered when the read omits viewerMayRetransmit", async () => {
    viewerMayRetransmit = undefined;
    mount();
    await screen.findAllByText(/Morphine/);
    expect(screen.queryByRole("button", { name: "Retransmit" })).toBeNull();
  });

  it("maps the SIGNER_NOT_ORDERING_PHYSICIAN refusal (403) to user-facing copy", async () => {
    writeFailure = {
      status: 403,
      body: {
        error: {
          code: "SIGNER_NOT_ORDERING_PHYSICIAN",
          message: "only the order's prescriber or the named ordering physician may retransmit it",
        },
      },
    };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Retransmit" }));
    const dialog = await screen.findByRole("dialog", { name: "Retransmit medication order" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create replacement" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Only this order's prescriber or its named ordering physician can retransmit it. Ask them to retransmit, or sign in as them.",
    );
  });

  it("maps the SIGNER_NOT_ELIGIBLE refusal (403) to user-facing copy", async () => {
    writeFailure = {
      status: 403,
      body: {
        error: {
          code: "SIGNER_NOT_ELIGIBLE",
          message: "the retransmitting discipline is not eligible to sign medication orders",
        },
      },
    };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Retransmit" }));
    const dialog = await screen.findByRole("dialog", { name: "Retransmit medication order" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create replacement" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Your discipline can't sign medication orders, so you can't retransmit this one.",
    );
  });

  it("renders any other refusal as a sentence-cased server message", async () => {
    writeFailure = {
      status: 422,
      body: { error: { code: "VALIDATION_ERROR", message: "pharmacy no longer active" } },
    };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Retransmit" }));
    const dialog = await screen.findByRole("dialog", { name: "Retransmit medication order" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create replacement" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Pharmacy no longer active.",
    );
  });
});
