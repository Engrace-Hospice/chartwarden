// Finding 9 — order screens name people instead of showing uuid prefixes: the sign inbox shows the patient's
// name; order detail shows the ordering physician's name (M40 resolve seam) and a humanized drafter discipline.
// Unresolvable ids fall back to "Name unavailable", never an id.
import { render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { OrderDetail } from "./order-detail";
import { OrdersSignInbox } from "./orders-sign-inbox";

const ORDER = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PATIENT = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const PHYSICIAN = "cccccccc-3333-4333-8333-cccccccccccc";

const order = {
  id: ORDER,
  patientId: PATIENT,
  admissionId: "dddddddd-4444-4444-8444-dddddddddddd",
  kind: "medication",
  status: "pending_signature",
  priority: "routine",
  drafterDiscipline: "rn_case_manager",
  orderingPhysicianMdmId: PHYSICIAN,
  cosignRequired: false,
  cosignStatus: null,
  transmissionStatus: "not_applicable",
  resultsStatus: "not_applicable",
  verbalDeadlineAt: null,
  discontinuationReason: null,
  replacesOrderId: null,
  signedAt: null,
  signedBy: null,
  completedAt: null,
  createdAt: "2026-08-26T09:00:00.000Z",
  kindVersion: "1",
  data: {},
  requirements: [],
  allowedActions: {},
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mount(element: JSX.Element, path: string, pattern: string, resolvable: boolean) {
  const stubFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const p = new URL(req.url, "http://localhost").pathname;
    if (p === "/api/v1/orders/pending-signature") return json({ orders: [order] });
    if (p === `/api/v1/orders/${ORDER}`) return json(order);
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
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path={pattern} element={element} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

const bodyText = () => document.body.textContent ?? "";

describe("signature inbox patient column", () => {
  it("shows the patient's name, not an id", async () => {
    mount(<OrdersSignInbox />, "/orders", "/orders", true);
    await waitFor(() => expect(screen.getByText("Vance, Ada")).toBeTruthy());
    expect(bodyText()).not.toContain(PATIENT.slice(0, 8));
  });

  it("falls back to a neutral label for an unreadable patient", async () => {
    mount(<OrdersSignInbox />, "/orders", "/orders", false);
    await waitFor(() => expect(screen.getAllByRole("row").length).toBeGreaterThan(1));
    await waitFor(() => expect(screen.getByText("Name unavailable")).toBeTruthy());
    expect(bodyText()).not.toContain("Loading\u2026");
    expect(bodyText()).not.toContain(PATIENT.slice(0, 8));
  });
});

describe("order detail people", () => {
  it("shows the ordering physician by name and the drafter discipline humanized", async () => {
    mount(<OrderDetail />, `/orders/${ORDER}`, "/orders/:id", true);
    await waitFor(() => expect(screen.getByText("Dr. Grace Hopper")).toBeTruthy());
    expect(screen.getByText("Drafter discipline").nextSibling?.textContent).not.toContain("_");
    expect(bodyText()).not.toContain(PHYSICIAN.slice(0, 8));
  });

  it("shows 'Name unavailable' when the physician does not resolve", async () => {
    mount(<OrderDetail />, `/orders/${ORDER}`, "/orders/:id", false);
    await waitFor(() => expect(screen.getByText("Ordering physician")).toBeTruthy());
    await waitFor(() =>
      expect(screen.getByText("Ordering physician").nextSibling?.textContent).toBe(
        "Name unavailable",
      ),
    );
    expect(bodyText()).not.toContain(PHYSICIAN.slice(0, 8));
  });
});
