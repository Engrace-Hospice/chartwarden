// @vitest-environment jsdom
// A supply request's lifecycle steps (assign a vendor, record the order, the shipment, the delivery, the receipt, cancel,
// start a kit return) open as a drawer in the detail rail beside the request (the redesign's pattern), so the routing
// trace and the timeline stay in view while the step is recorded. Cancel closes the drawer and writes nothing; each write
// stays disabled until its own rule is met; one step is open at a time, and a reason typed for one step never follows
// the responder into another.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupplyRequestDetail } from "./supplies-api";
import { SupplyRequestDetailScreen } from "./supply-request-detail";

afterEach(cleanup);

const requestIn = (
  status: SupplyRequestDetail["status"],
  kind: SupplyRequestDetail["kind"] = "supply",
): SupplyRequestDetail => ({
  supplyRequestId: "11111111-1111-4111-8111-111111111111",
  patientId: "22222222-2222-4222-8222-222222222222",
  locationId: "loc-1",
  kind,
  status,
  assignedVendorId: null,
  vendorOrderReference: null,
  trackingNumber: null,
  carrier: null,
  orderedAt: null,
  deliveredAt: null,
  createdAt: "2026-11-17T12:00:00.000Z",
  updatedAt: "2026-11-17T12:00:00.000Z",
  hospiceCoverage: "covered_related",
  admissionId: "adm-1",
  providerEntityId: "pe-1",
  sourceOrderId: null,
  sourceReplenishmentEventId: null,
  requestedByMembershipId: "m-lopez",
  data: null,
  routingRuleResolved: null,
  pharmacyPartnerId: null,
  documentId: null,
  deliveryInstructions: null,
  deliveryMethod: null,
  deliveredByMembershipId: null,
  deliveryEvidenceDocumentId: null,
  receivedConfirmedAt: null,
  receivedConfirmedActor: null,
  completedAt: null,
  cancelledAt: null,
  cancellationPendingAt: null,
  cancellationReason: null,
  shippedAt: null,
  invoiceTotalCents: null,
  invoiceAccruedAt: null,
  invoiceReconciledAt: null,
  invoiceVarianceCents: null,
  dispatchId: null,
  caregiverSignatureCaptureMethod: null,
  caregiverSignatureCapturedAt: null,
  caregiverSignatureCapturedByMembershipId: null,
  caregiverSignatureEvidenceDocumentId: null,
  caregiverSignatureEvidence: null,
  coverageReason: null,
  coverageDeterminedAt: null,
  coverageDeterminedBy: null,
});

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

function mount(
  status: SupplyRequestDetail["status"],
  kind: SupplyRequestDetail["kind"] = "supply",
): { post: ReturnType<typeof vi.fn> } {
  const post = vi.fn(async () => ok({}));
  const client = {
    GET: vi.fn(async () => ok(requestIn(status, kind))),
    POST: post,
  } as unknown as ApiClient;
  render(
    <MemoryRouter initialEntries={["/supplies/requests/r-1"]}>
      <ApiClientProvider client={client}>
        <Routes>
          <Route
            path="/supplies/requests/:supplyRequestId"
            element={<SupplyRequestDetailScreen />}
          />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { post };
}

const open = async (button: string, drawerName: string): Promise<HTMLElement> => {
  fireEvent.click(await screen.findByRole("button", { name: button }));
  return screen.findByRole("complementary", { name: drawerName });
};
const posted = (post: ReturnType<typeof vi.fn>, call = 0) =>
  post.mock.calls[call] as unknown as [
    string,
    { body: Record<string, unknown>; headers: Record<string, string> },
  ];

describe("supply request — lifecycle steps", () => {
  it("opens a step as a drawer beside the request, not a dialog over it", async () => {
    mount("requested");
    const drawer = await open("Assign / override vendor", "Assign or override the vendor");
    expect(within(drawer).getByLabelText("Override reason")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The request's timeline stays on the page while the step is recorded.
    expect(screen.getByRole("heading", { name: "Lifecycle" })).toBeTruthy();
  });

  it("closes from Cancel without writing anything", async () => {
    const { post } = mount("requested");
    const drawer = await open("Assign / override vendor", "Assign or override the vendor");
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Assign or override the vendor" }),
      ).toBeNull(),
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("assigns the vendor against the request's version and closes", async () => {
    const { post } = mount("requested");
    const drawer = await open("Assign / override vendor", "Assign or override the vendor");
    fireEvent.click(within(drawer).getByRole("button", { name: "Assign vendor" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(posted(post)[0]).toBe(
      "/api/v1/supplies/supply-requests/{supplyRequestId}/assign-vendor",
    );
    expect(posted(post)[1].headers["If-Match"]).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Assign or override the vendor" }),
      ).toBeNull(),
    );
  });

  it("keeps Mark ordered disabled until the vendor's order reference is given", async () => {
    const { post } = mount("vendor_assigned");
    const drawer = await open("Mark ordered", "Record the vendor's acceptance");
    const mark = within(drawer).getByRole("button", { name: "Mark ordered" }) as HTMLButtonElement;
    expect(mark.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("Vendor order reference"), {
      target: { value: "PO-2291" },
    });
    expect(mark.disabled).toBe(false);
    fireEvent.click(mark);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(posted(post)[1].body).toMatchObject({ vendorOrderReference: "PO-2291" });
  });

  it("keeps Mark in transit disabled until a carrier and a tracking number are given", async () => {
    const { post } = mount("ordered");
    const drawer = await open("Mark in transit", "Record the shipment");
    const mark = within(drawer).getByRole("button", {
      name: "Mark in transit",
    }) as HTMLButtonElement;
    fireEvent.change(within(drawer).getByLabelText("Carrier"), { target: { value: "Northwind" } });
    expect(mark.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("Tracking number"), {
      target: { value: "TRK-0042" },
    });
    expect(mark.disabled).toBe(false);
    fireEvent.click(mark);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(posted(post)[1].body).toMatchObject({
      carrier: "Northwind",
      trackingNumber: "TRK-0042",
    });
  });

  it("attests a delivery as the signed-in responder and closes", async () => {
    const { post } = mount("in_transit");
    const drawer = await open("Record delivery", "Attest delivery");
    fireEvent.click(within(drawer).getByRole("button", { name: "Attest delivery" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(posted(post)[0]).toBe(
      "/api/v1/supplies/supply-requests/{supplyRequestId}/mark-delivered",
    );
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Attest delivery" })).toBeNull(),
    );
  });

  it("confirms receipt and closes", async () => {
    const { post } = mount("delivered");
    const drawer = await open("Confirm receipt", "Confirm receipt");
    fireEvent.click(within(drawer).getByRole("button", { name: "Confirm receipt" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(posted(post)[0]).toBe(
      "/api/v1/supplies/supply-requests/{supplyRequestId}/confirm-received",
    );
  });

  it("keeps Cancel request disabled until a reason is given", async () => {
    const { post } = mount("requested");
    const drawer = await open("Cancel", "Cancel this request");
    const cancel = within(drawer).getByRole("button", {
      name: "Cancel request",
    }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("Reason"), {
      target: { value: "The family declined the equipment." },
    });
    expect(cancel.disabled).toBe(false);
    fireEvent.click(cancel);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(posted(post)[0]).toBe("/api/v1/supplies/supply-requests/{supplyRequestId}/cancel");
  });

  it("opens the kit return from a delivered kit, with a reason", async () => {
    const { post } = mount("delivered", "comfort_kit_deploy");
    const drawer = await open("Initiate kit return", "Initiate the kit return");
    const start = within(drawer).getByRole("button", {
      name: "Initiate return",
    }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("Reason"), {
      target: { value: "Patient discharged to another agency." },
    });
    fireEvent.click(start);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(posted(post)[0]).toBe("/api/v1/supplies/supply-requests/{supplyRequestId}/return");
  });

  it("keeps one step open at a time and never carries a typed reason into the next", async () => {
    mount("requested");
    const first = await open("Assign / override vendor", "Assign or override the vendor");
    fireEvent.change(within(first).getByLabelText("Override reason"), {
      target: { value: "Vendor of record is closed this week." },
    });
    // The page's own Cancel action comes first in the document, before the drawer's Cancel button.
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0] as HTMLElement);
    const second = await screen.findByRole("complementary", { name: "Cancel this request" });
    expect(
      screen.queryByRole("complementary", { name: "Assign or override the vendor" }),
    ).toBeNull();
    expect((within(second).getByLabelText("Reason") as HTMLTextAreaElement).value).toBe("");
  });
});
