// @vitest-environment jsdom
// A supply request's routine recordings (assign a vendor, record the order, record the shipment) open as a drawer in the
// detail rail beside the request (the redesign's pattern), so the routing trace and the timeline stay in view. The
// attestation of delivery, the receipt, the cancellation and the kit return are ceremonies (DESIGN.md §7.4): focus-trapped
// modals over the page that the scrim never dismisses. Cancel closes either and writes nothing; each write stays disabled
// until its own rule is met; one step is open at a time, and a reason typed for one step never follows the responder into
// another. While a write is in flight the drawer cannot be dismissed and the page beside it is inert, and the modal cannot
// be dismissed (Cancel, Escape); a refused or rejected write is announced in the drawer or modal, which stays dismissible.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupplyRequestDetail } from "./supplies-api";
import { SupplyRequestDetailScreen } from "./supply-request-detail";
import { NO_ANSWER_MESSAGE } from "./use-write";

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
  onPost: () => Promise<unknown> = async () => ok({}),
  onGet: (requestId: string | undefined) => Promise<unknown> = async () =>
    ok(requestIn(status, kind)),
): { post: ReturnType<typeof vi.fn> } {
  const post = vi.fn(onPost);
  const client = {
    GET: vi.fn(async (_path: string, init?: { params?: { path?: { supplyRequestId?: string } } }) =>
      onGet(init?.params?.path?.supplyRequestId),
    ),
    POST: post,
  } as unknown as ApiClient;
  render(
    <MemoryRouter initialEntries={["/supplies/requests/r-1"]}>
      <Link to="/supplies/requests/r-2">Next request</Link>
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
const openModal = async (button: string, name: string): Promise<HTMLElement> => {
  fireEvent.click(await screen.findByRole("button", { name: button }));
  return screen.findByRole("dialog", { name });
};
const modalGone = (name: string) =>
  waitFor(() => expect(screen.queryByRole("dialog", { name })).toBeNull());
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
    const drawer = await open("Mark ordered…", "Record the vendor's acceptance");
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
    const drawer = await open("Mark in transit…", "Record the shipment");
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
    const dialog = await openModal("Record delivery", "Attest delivery");
    fireEvent.click(within(dialog).getByRole("button", { name: "Attest delivery" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(posted(post)[0]).toBe(
      "/api/v1/supplies/supply-requests/{supplyRequestId}/mark-delivered",
    );
    await modalGone("Attest delivery");
  });

  it("confirms receipt and closes", async () => {
    const { post } = mount("delivered");
    const dialog = await openModal("Confirm receipt…", "Confirm receipt");
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm receipt" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(posted(post)[0]).toBe(
      "/api/v1/supplies/supply-requests/{supplyRequestId}/confirm-received",
    );
    await modalGone("Confirm receipt");
  });

  it("keeps Cancel request disabled until a reason is given", async () => {
    const { post } = mount("requested");
    const dialog = await openModal("Cancel this request…", "Cancel this request");
    const cancel = within(dialog).getByRole("button", {
      name: "Cancel request",
    }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Reason"), {
      target: { value: "The family declined the equipment." },
    });
    expect(cancel.disabled).toBe(false);
    fireEvent.click(cancel);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(posted(post)[0]).toBe("/api/v1/supplies/supply-requests/{supplyRequestId}/cancel");
    await modalGone("Cancel this request");
  });

  it("opens the kit return from a delivered kit, with a reason", async () => {
    const { post } = mount("delivered", "comfort_kit_deploy");
    const dialog = await openModal("Initiate kit return", "Initiate the kit return");
    const start = within(dialog).getByRole("button", {
      name: "Initiate return",
    }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Reason"), {
      target: { value: "Patient discharged to another agency." },
    });
    fireEvent.click(start);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(posted(post)[0]).toBe("/api/v1/supplies/supply-requests/{supplyRequestId}/return");
    await modalGone("Initiate the kit return");
  });

  it("keeps one step open at a time and never carries a typed reason into the next", async () => {
    mount("requested");
    const first = await open("Assign / override vendor", "Assign or override the vendor");
    fireEvent.change(within(first).getByLabelText("Override reason"), {
      target: { value: "Vendor of record is closed this week." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel this request…" }));
    const second = await screen.findByRole("dialog", { name: "Cancel this request" });
    // The modal ceremony replaces the drawer step: the frame closes with it.
    expect(screen.queryByRole("complementary")).toBeNull();
    expect((within(second).getByLabelText("Reason") as HTMLTextAreaElement).value).toBe("");
  });

  it("never carries a reason typed in a modal ceremony into a drawer step", async () => {
    mount("requested");
    const cancel = await openModal("Cancel this request…", "Cancel this request");
    fireEvent.change(within(cancel).getByLabelText("Reason"), {
      target: { value: "The family declined the equipment." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Assign / override vendor" }));
    const drawer = await screen.findByRole("complementary", {
      name: "Assign or override the vendor",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((within(drawer).getByLabelText("Override reason") as HTMLTextAreaElement).value).toBe(
      "",
    );
  });

  it("names the page's openers apart from the open drawer's own buttons", async () => {
    mount("vendor_assigned");
    const drawer = await open("Mark ordered…", "Record the vendor's acceptance");
    // One Mark ordered… opener on the page, one Mark ordered save button and one Cancel in the drawer.
    expect(screen.getAllByRole("button", { name: "Mark ordered" })).toEqual([
      within(drawer).getByRole("button", { name: "Mark ordered" }),
    ]);
    expect(screen.getAllByRole("button", { name: "Cancel" })).toEqual([
      within(drawer).getByRole("button", { name: "Cancel" }),
    ]);
  });

  it("starts the delivery time at the moment the modal is opened, every time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2026, 10, 18, 9, 0));
      mount("in_transit");
      const first = await openModal("Record delivery", "Attest delivery");
      const field = () => within(first).getByLabelText("Delivered at") as HTMLInputElement;
      expect(field().value).toBe("2026-11-18T09:00");
      fireEvent.change(field(), { target: { value: "2026-11-01T01:00" } });
      fireEvent.click(within(first).getByRole("button", { name: "Cancel" }));
      await modalGone("Attest delivery");
      vi.setSystemTime(new Date(2026, 10, 18, 11, 30));
      const second = await openModal("Record delivery", "Attest delivery");
      expect((within(second).getByLabelText("Delivered at") as HTMLInputElement).value).toBe(
        "2026-11-18T11:30",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the receipt time at the moment the modal is opened, not at page load", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2026, 10, 18, 9, 0));
      mount("delivered");
      await screen.findByRole("button", { name: "Confirm receipt…" });
      vi.setSystemTime(new Date(2026, 10, 18, 14, 15));
      const dialog = await openModal("Confirm receipt…", "Confirm receipt");
      expect((within(dialog).getByLabelText("Confirmed at") as HTMLInputElement).value).toBe(
        "2026-11-18T14:15",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the drawer and everything beside it while a write is in flight", async () => {
    let release: () => void = () => {};
    const { post } = mount(
      "requested",
      "supply",
      () =>
        new Promise((resolve) => {
          release = () => resolve(ok({}));
        }),
    );
    const drawer = await open("Assign / override vendor", "Assign or override the vendor");
    fireEvent.click(within(drawer).getByRole("button", { name: "Assign vendor" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    // Cancel, the close button and Escape are all refused while the write has not landed.
    expect(
      (within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (within(drawer).getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(drawer, { key: "Escape" });
    expect(screen.getByRole("complementary", { name: "Assign or override the vendor" })).toBe(
      drawer,
    );
    // The page's openers cannot swap the drawer under the write.
    const opener = screen.getByRole("button", { name: "Cancel this request…", hidden: true });
    expect(opener.closest("[inert]")).not.toBeNull();
    release();
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Assign or override the vendor" }),
      ).toBeNull(),
    );
  });

  it("announces a rejected request in the drawer, which stays dismissible", async () => {
    const { post } = mount("requested", "supply", async () => {
      throw new TypeError("Failed to fetch");
    });
    const drawer = await open("Assign / override vendor", "Assign or override the vendor");
    fireEvent.click(within(drawer).getByRole("button", { name: "Assign vendor" }));
    const alert = await within(drawer).findByRole("alert");
    expect(alert.textContent).toBe(NO_ANSWER_MESSAGE);
    expect(post).toHaveBeenCalledTimes(1);
    expect(
      (within(drawer).getByRole("button", { name: "Assign vendor" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Assign or override the vendor" }),
      ).toBeNull(),
    );
    // Nothing is left behind on the page.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("announces a server refusal in the drawer, not above the page", async () => {
    mount("requested", "supply", async () => ({
      data: undefined,
      error: { error: { code: "CONFLICT", message: "The vendor is not active." } },
      response: new Response(null, { status: 409 }),
    }));
    const drawer = await open("Assign / override vendor", "Assign or override the vendor");
    fireEvent.click(within(drawer).getByRole("button", { name: "Assign vendor" }));
    const alert = await within(drawer).findByRole("alert");
    expect(alert.textContent).toBe("The vendor is not active.");
  });

  it("shows an error, not a page stuck loading, when the reload after a write is rejected", async () => {
    let reads = 0;
    mount(
      "requested",
      "supply",
      async () => ok({}),
      () =>
        ++reads === 1
          ? Promise.resolve(ok(requestIn("requested")))
          : Promise.reject(new TypeError("offline")),
    );
    const drawer = await open("Assign / override vendor", "Assign or override the vendor");
    fireEvent.click(within(drawer).getByRole("button", { name: "Assign vendor" }));
    expect(await screen.findByText("Unavailable")).toBeTruthy();
    expect(screen.getByText("This supply request could not be loaded.")).toBeTruthy();
  });

  it("shows the newest request when the first one's reply lands last", async () => {
    let answerFirst: (reply: unknown) => void = () => {};
    const row = (id: string) => ok({ ...requestIn("requested"), supplyRequestId: id });
    mount("requested", "supply", undefined, (requestId) =>
      requestId === "r-1"
        ? new Promise((resolve) => {
            answerFirst = resolve;
          })
        : Promise.resolve(row("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")),
    );
    fireEvent.click(await screen.findByRole("link", { name: "Next request" }));
    expect(await screen.findByText(/Supply request bbbbbbbb/)).toBeTruthy();
    await act(async () => {
      answerFirst(row("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByText(/Supply request aaaaaaaa/)).toBeNull();
    expect(screen.getByText(/Supply request bbbbbbbb/)).toBeTruthy();
  });

  const MODALS: Array<{
    status: SupplyRequestDetail["status"];
    kind: SupplyRequestDetail["kind"];
    opener: string;
    name: string;
    save: string;
    reason?: string;
  }> = [
    {
      status: "in_transit",
      kind: "supply",
      opener: "Record delivery",
      name: "Attest delivery",
      save: "Attest delivery",
    },
    {
      status: "delivered",
      kind: "supply",
      opener: "Confirm receipt…",
      name: "Confirm receipt",
      save: "Confirm receipt",
    },
    {
      status: "requested",
      kind: "supply",
      opener: "Cancel this request…",
      name: "Cancel this request",
      save: "Cancel request",
      reason: "The family declined the equipment.",
    },
    {
      status: "delivered",
      kind: "comfort_kit_deploy",
      opener: "Initiate kit return",
      name: "Initiate the kit return",
      save: "Initiate return",
      reason: "Patient discharged to another agency.",
    },
  ];
  const cases = MODALS.map((m) => [m.name, m] as const);
  const fillReason = (dialog: HTMLElement, reason: string | undefined) => {
    if (reason)
      fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: reason } });
  };

  it.each(cases)(
    "opens %s as a modal over the request, not a drawer beside it",
    async (_name, m) => {
      mount(m.status, m.kind);
      const dialog = await openModal(m.opener, m.name);
      expect(dialog).toBeTruthy();
      expect(screen.queryByRole("complementary")).toBeNull();
      // The request stays on the page behind the modal.
      expect(screen.getByRole("heading", { name: "Lifecycle" })).toBeTruthy();
    },
  );

  it.each(cases)(
    "closes %s from Cancel without writing, and not from the scrim",
    async (_name, m) => {
      const { post } = mount(m.status, m.kind);
      const dialog = await openModal(m.opener, m.name);
      fireEvent.click(document.querySelector(".wx-modal-scrim") as Element);
      expect(screen.getByRole("dialog", { name: m.name })).toBe(dialog);
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await modalGone(m.name);
      expect(post).not.toHaveBeenCalled();
    },
  );

  it.each(cases)(
    "refuses Cancel, Escape and the scrim while the %s write is in flight",
    async (_name, m) => {
      let release: () => void = () => {};
      const { post } = mount(
        m.status,
        m.kind,
        () =>
          new Promise((resolve) => {
            release = () => resolve(ok({}));
          }),
      );
      const dialog = await openModal(m.opener, m.name);
      fillReason(dialog, m.reason);
      fireEvent.click(within(dialog).getByRole("button", { name: m.save }));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      expect(
        (within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      fireEvent.keyDown(dialog, { key: "Escape" });
      fireEvent.click(document.querySelector(".wx-modal-scrim") as Element);
      expect(screen.getByRole("dialog", { name: m.name })).toBe(dialog);
      release();
      await modalGone(m.name);
    },
  );

  it.each(cases)(
    "announces a rejected request in the %s modal, which stays dismissible",
    async (_name, m) => {
      mount(m.status, m.kind, async () => {
        throw new TypeError("Failed to fetch");
      });
      const dialog = await openModal(m.opener, m.name);
      fillReason(dialog, m.reason);
      fireEvent.click(within(dialog).getByRole("button", { name: m.save }));
      const alert = await within(dialog).findByRole("alert");
      expect(alert.textContent).toBe(NO_ANSWER_MESSAGE);
      const cancel = within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
      expect(cancel.disabled).toBe(false);
      fireEvent.click(cancel);
      await modalGone(m.name);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("complementary")).toBeNull();
    },
  );
});
