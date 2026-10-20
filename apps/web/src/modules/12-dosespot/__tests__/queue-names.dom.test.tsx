// Finding 9 — the DoseSpot queues name the patient (and the verbal queue the prescriber) instead of showing uuid
// prefixes; ids that do not resolve fall back to "Name unavailable".
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import type { JSX } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { RefillInbox } from "../refill-inbox";
import { MedicationSignInbox } from "../sign-inbox";
import { VerbalMedicationOrdersQueue } from "../verbal-orders-queue";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ORDER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const PHYSICIAN = "cccccccc-3333-4333-8333-cccccccccccc";

const medOrder = {
  id: ORDER,
  patientId: PATIENT,
  medClass: "opioid",
  status: "pending_signature",
  drugName: "Morphine",
  strength: "10 mg",
  isControlledSubstance: false,
  deaSchedule: null,
  prescribingPhysicianMdmId: PHYSICIAN,
  createdAt: "2026-08-26T09:00:00.000Z",
};
const refill = {
  id: "dddddddd-4444-4444-8444-dddddddddddd",
  patientId: PATIENT,
  sourceMedicationOrderId: ORDER,
  status: "pending",
  requestedAt: "2026-08-26T09:00:00.000Z",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mount(element: JSX.Element, resolvable: boolean) {
  const stubFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const p = new URL(req.url, "http://localhost").pathname;
    if (p === "/api/v1/medication-orders") return json({ orders: [medOrder] });
    if (p === "/api/v1/refills") return json({ refills: [refill], items: [refill] });
    if (p === `/api/v1/patients/${PATIENT}`) {
      return resolvable
        ? json({ id: PATIENT, firstName: "Ada", lastName: "Vance", mrn: "MRN-1" })
        : json({ error: { code: "NOT_FOUND", message: "no" } }, 404);
    }
    if (p === `/api/v1/mdm/physician/${PHYSICIAN}`) {
      return resolvable
        ? json({ canonical: { displayName: "Dr. Grace Hopper" } })
        : json({ error: { code: "NOT_FOUND", message: "no" } }, 404);
    }
    return json({});
  };
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider
        session={{
          userId: "user-1",
          organizationId: "org-1",
          membershipId: "membership-1",
          roles: ["medical_director"],
          permissions: [],
          isAdmin: false,
        }}
      >
        <ToastProvider>
          <MemoryRouter>{element}</MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

const bodyText = () => document.body.textContent ?? "";
const rowCells = () =>
  Array.from(document.querySelectorAll("tbody tr")[0]?.querySelectorAll("td") ?? []).map(
    (c) => c.textContent,
  );

describe.each([
  ["sign inbox", <MedicationSignInbox key="s" />],
  ["verbal queue", <VerbalMedicationOrdersQueue key="v" />],
  ["refill inbox", <RefillInbox key="r" />],
])("%s patient column", (_name, ui) => {
  it("shows the patient's name, never an id prefix", async () => {
    mount(ui, true);
    await waitFor(() => expect(screen.getByText("Vance, Ada")).toBeTruthy());
    expect(bodyText()).not.toContain(PATIENT.slice(0, 8));
  });

  it("shows 'Name unavailable' when the patient is not readable", async () => {
    mount(ui, false);
    await waitFor(() => expect(document.querySelectorAll("tbody tr").length).toBeGreaterThan(0));
    // Pending reads "Loading…"; only a settled, unreadable lookup reads "Name unavailable".
    await waitFor(() => expect(rowCells()).toContain("Name unavailable"));
    expect(bodyText()).not.toContain(PATIENT.slice(0, 8));
  });
});

describe("queue search", () => {
  it("finds 'Vance, Ada' by typing 'ada vance' (First Last)", async () => {
    mount(<MedicationSignInbox />, true);
    await waitFor(() => expect(screen.getByText("Vance, Ada")).toBeTruthy());
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ada vance" } });
    expect(screen.getByText("Vance, Ada")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ada nobody" } });
    expect(screen.queryByText("Vance, Ada")).toBeNull();
  });

  it("does not match the 'Physician' fallback label in the verbal queue", async () => {
    mount(<VerbalMedicationOrdersQueue />, false);
    await waitFor(() => expect(rowCells()).toContain("Name unavailable"));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "physician" } });
    expect(document.querySelectorAll("tbody tr").length).toBe(0);
  });
});

describe("verbal queue prescriber", () => {
  it("shows the prescriber's name in the row and the filter, never an id", async () => {
    mount(<VerbalMedicationOrdersQueue />, true);
    await waitFor(() => expect(screen.getAllByText("Dr. Grace Hopper").length).toBeGreaterThan(0));
    expect(bodyText()).not.toContain(PHYSICIAN.slice(0, 8));
  });

  it("shows 'Name unavailable' when the prescriber does not resolve", async () => {
    mount(<VerbalMedicationOrdersQueue />, false);
    await waitFor(() => expect(document.querySelectorAll("tbody tr").length).toBeGreaterThan(0));
    await waitFor(() => expect(rowCells().filter((c) => c === "Name unavailable").length).toBe(2));
    expect(bodyText()).not.toContain("Loading\u2026");
    expect(bodyText()).not.toContain(PHYSICIAN.slice(0, 8));
  });
});
