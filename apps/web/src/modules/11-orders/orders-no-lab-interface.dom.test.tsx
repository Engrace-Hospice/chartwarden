import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// Finding 13 — a lab order that could not be sent only because no lab interface is configured is shown as
// information, not as a failed transmission; a genuine send failure keeps the failed pill.
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { OrderDetail } from "./order-detail";
import { notSentInfoLabel } from "./resend-transmission-api";

const ORDER = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

const labOrder = (transmissionFailureReason: string) => ({
  id: ORDER,
  patientId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
  admissionId: "dddddddd-4444-4444-8444-dddddddddddd",
  kind: "lab",
  status: "signed",
  priority: "routine",
  drafterDiscipline: "rn_case_manager",
  orderingPhysicianMdmId: "cccccccc-3333-4333-8333-cccccccccccc",
  cosignRequired: false,
  cosignStatus: null,
  transmissionStatus: "failed",
  transmissionFailureReason,
  resultsStatus: "not_applicable",
  verbalDeadlineAt: null,
  discontinuationReason: null,
  replacesOrderId: null,
  signedAt: "2026-08-26T09:00:00.000Z",
  signedBy: null,
  completedAt: null,
  createdAt: "2026-08-26T09:00:00.000Z",
  kindVersion: "1",
  data: {},
  requirements: [],
  allowedActions: {},
});

function mount(reason: string): void {
  const stubFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(req.url, "http://localhost").pathname;
    const body = path === `/api/v1/orders/${ORDER}` ? labOrder(reason) : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  render(
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
          <MemoryRouter initialEntries={[`/orders/${ORDER}`]}>
            <Routes>
              <Route path="/orders/:id" element={<OrderDetail />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

describe("lab transmission with no interface", () => {
  it("says no lab interface is configured instead of Failed", async () => {
    mount("orm_refused:no_active_feed");
    await waitFor(() =>
      expect(screen.getByText("Not sent — no lab interface configured")).toBeTruthy(),
    );
    expect(screen.queryByText("Failed")).toBeNull();
  });

  it("names the missing performing lab rather than blaming the interface", async () => {
    mount("orm_refused:no_routing_lab");
    await waitFor(() =>
      expect(screen.getByText("Not sent — no performing lab on the order")).toBeTruthy(),
    );
    expect(screen.queryByText("Not sent — no lab interface configured")).toBeNull();
  });

  it("keeps Failed for a genuine send failure", async () => {
    mount("application_reject");
    await waitFor(() => expect(screen.getByText("Failed")).toBeTruthy());
    expect(screen.queryByText("Not sent — no lab interface configured")).toBeNull();
  });

  it("classifies only refusals that lack setup", () => {
    expect(notSentInfoLabel("orm_refused:no_active_feed")).toBe(
      "Not sent — no lab interface configured",
    );
    expect(notSentInfoLabel("dispatch_refused:no_feed_for_destination")).toBe(
      "Not sent — no lab interface configured",
    );
    expect(notSentInfoLabel("orm_refused:patient_mrn_missing")).toBeNull();
    expect(notSentInfoLabel("dlq_exhausted")).toBeNull();
    expect(notSentInfoLabel(null)).toBeNull();
  });
});
