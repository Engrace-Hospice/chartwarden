// F-238 — the referral's records-requests panel: list, request records, print the cover sheet, cancel.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { describe, expect, it, vi } from "vitest";
import { ReferralRecordsRequests } from "../referral-records-requests";

const REFERRAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const base = {
  referralId: REFERRAL,
  patientId: null,
  recipientOrganization: "Riverbend Family Medicine",
  recipientFax: "(503) 555-0100",
  recipientEmail: null,
  recordsRequestedNote: null,
  dateRangeStart: null,
  dateRangeEnd: null,
  requestedByMembershipId: "m1",
  requestedAt: "2026-10-01T12:00:00.000Z",
  receivedAt: null,
  cancelledAt: null,
  expiresOn: "2026-11-02",
  expiredAt: null,
  receivedAfterExpiry: false,
};
const open = {
  ...base,
  id: "r1",
  requestCode: "RR-7KHM3XA",
  recipientName: "Dr. Pell",
  recordsRequested: ["history_and_physical", "labs"],
  status: "requested",
  dueDate: "2026-10-03",
  overdue: true,
  batches: 0,
};
const received = {
  ...base,
  id: "r2",
  requestCode: "RR-PWNC4ED",
  recipientName: "St. Vincent HIM",
  recordsRequested: ["discharge_summary"],
  status: "received",
  dueDate: null,
  overdue: false,
  batches: 2,
};

const ok = (data: unknown, status = 200) => ({
  data,
  error: undefined,
  response: new Response(null, { status }),
});

function clientFor() {
  const created = {
    ...base,
    id: "r3",
    requestCode: "RR-AC3DE4F",
    recipientName: "Dr. New",
    recordsRequested: ["progress_notes"],
    status: "requested",
    dueDate: "2026-10-11",
    overdue: false,
    batches: 0,
  };
  const GET = vi.fn(async () => ok({ items: [open, received] }));
  const POST = vi.fn(async (path: string) => {
    if (path.endsWith("/cancel")) return ok({ ...open, status: "cancelled", overdue: false });
    return ok(created, 201);
  });
  return { client: { GET, POST } as unknown as ApiClient, GET, POST };
}

const renderPanel = (client: ApiClient) =>
  render(
    <ApiClientProvider client={client}>
      <ReferralRecordsRequests referralId={REFERRAL} />
    </ApiClientProvider>,
  );

describe("ReferralRecordsRequests", () => {
  it("lists the referral's requests with code, status, recipient, due date and filed count", async () => {
    const { client, GET } = clientFor();
    renderPanel(client);
    expect(await screen.findByText("RR-7KHM3XA")).toBeTruthy();
    expect(GET).toHaveBeenCalledWith("/api/v1/referrals/{id}/records-requests", {
      params: { path: { id: REFERRAL } },
    });
    const row = screen.getByText("RR-7KHM3XA").closest("tr") as HTMLElement;
    expect(within(row).getByText("Requested")).toBeTruthy();
    expect(within(row).getByText(/Overdue/)).toBeTruthy();
    expect(within(row).getByText("Dr. Pell")).toBeTruthy();
    expect(within(row).getByText("10/03/2026")).toBeTruthy();
    const done = screen.getByText("RR-PWNC4ED").closest("tr") as HTMLElement;
    expect(within(done).getByText("Received")).toBeTruthy();
    expect(within(done).getByText("2")).toBeTruthy();
    // A received request cannot be cancelled.
    expect(within(done).queryByRole("button", { name: "Cancel request" })).toBeNull();
  });

  it("creates a request from the form and shows it first", async () => {
    const { client, POST } = clientFor();
    renderPanel(client);
    await screen.findByText("RR-7KHM3XA");
    fireEvent.click(screen.getByRole("button", { name: "Request records" }));
    fireEvent.change(screen.getByLabelText("Recipient name"), { target: { value: "Dr. New" } });
    fireEvent.change(screen.getByLabelText("Fax number"), { target: { value: "503 555 0199" } });
    fireEvent.click(screen.getByRole("button", { name: "Create request" }));
    await waitFor(() => expect(screen.getByText("RR-AC3DE4F")).toBeTruthy());
    const [path, init] = POST.mock.calls[0] as unknown as [
      string,
      { body: Record<string, unknown> },
    ];
    expect(path).toBe("/api/v1/referrals/{id}/records-requests");
    expect(init.body).toMatchObject({
      recipientName: "Dr. New",
      recipientFax: "503 555 0199",
      recordsRequested: [
        "history_and_physical",
        "discharge_summary",
        "progress_notes",
        "medication_list",
      ],
    });
    expect(init.body.recipientEmail).toBeUndefined();
    const rows = screen.getAllByRole("row");
    expect(within(rows[1] as HTMLElement).getByText("RR-AC3DE4F")).toBeTruthy();
  });

  it("refuses to submit without a fax or an email", async () => {
    const { client, POST } = clientFor();
    renderPanel(client);
    await screen.findByText("RR-7KHM3XA");
    fireEvent.click(screen.getByRole("button", { name: "Request records" }));
    fireEvent.change(screen.getByLabelText("Recipient name"), { target: { value: "Dr. New" } });
    fireEvent.click(screen.getByRole("button", { name: "Create request" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/fax number or the email/);
    expect(POST).not.toHaveBeenCalled();
  });

  it("opens the cover sheet route in a new tab", async () => {
    const { client } = clientFor();
    const spy = vi.spyOn(window, "open").mockImplementation(() => null);
    renderPanel(client);
    const row = (await screen.findByText("RR-7KHM3XA")).closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Print cover sheet" }));
    expect(spy).toHaveBeenCalledWith(
      `/api/v1/referrals/${REFERRAL}/records-requests/r1/cover-sheet`,
      "_blank",
      "noopener",
    );
    spy.mockRestore();
  });

  it("cancels only after a confirmation", async () => {
    const { client, POST } = clientFor();
    renderPanel(client);
    const row = (await screen.findByText("RR-7KHM3XA")).closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Cancel request" }));
    expect(POST).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByRole("button", { name: "Confirm cancel" }));
    await waitFor(() => expect(within(row).getByText("Cancelled")).toBeTruthy());
    expect(POST).toHaveBeenCalledWith(
      "/api/v1/referrals/{id}/records-requests/{requestId}/cancel",
      {
        params: { path: { id: REFERRAL, requestId: "r1" } },
        body: {},
      },
    );
  });

  it("shows an expired request's expiry and re-opens it with a new expiry date", async () => {
    const expired = {
      ...open,
      id: "r5",
      requestCode: "RR-EXP2R4C",
      status: "expired",
      expiresOn: "2026-09-01",
      expiredAt: "2026-09-02T00:17:00.000Z",
    };
    const late = {
      ...received,
      id: "r6",
      requestCode: "RR-LATE7MN",
      receivedAt: "2026-09-20T10:00:00.000Z",
      expiredAt: "2026-09-02T00:17:00.000Z",
      receivedAfterExpiry: true,
    };
    const GET = vi.fn(async () => ok({ items: [expired, late] }));
    const POST = vi.fn(async () =>
      ok({ ...expired, status: "requested", expiresOn: "2026-12-01", expiredAt: null }),
    );
    renderPanel({ GET, POST } as unknown as ApiClient);
    const row = (await screen.findByText("RR-EXP2R4C")).closest("tr") as HTMLElement;
    expect(within(row).getByText("Expired")).toBeTruthy();
    expect(within(row).getByText("Expired 09/02/2026")).toBeTruthy();
    const lateRow = screen.getByText("RR-LATE7MN").closest("tr") as HTMLElement;
    expect(within(lateRow).getByText(/Arrived after expiry/)).toBeTruthy();
    // A received request is neither extendable nor cancellable.
    expect(within(lateRow).queryByRole("button", { name: /Extend|Re-open/ })).toBeNull();

    fireEvent.click(within(row).getByRole("button", { name: "Re-open request" }));
    fireEvent.change(within(row).getByLabelText("New expiry"), {
      target: { value: "2026-12-01" },
    });
    fireEvent.click(within(row).getByRole("button", { name: "Re-open" }));
    await waitFor(() => expect(within(row).getByText("Requested")).toBeTruthy());
    expect(POST).toHaveBeenCalledWith(
      "/api/v1/referrals/{id}/records-requests/{requestId}/extend",
      {
        params: { path: { id: REFERRAL, requestId: "r5" } },
        body: { expiresOn: "2026-12-01" },
      },
    );
    expect(within(row).getByText("12/01/2026")).toBeTruthy();
  });

  it("offers Extend (not Re-open) on an open request", async () => {
    const { client } = clientFor();
    renderPanel(client);
    const row = (await screen.findByText("RR-7KHM3XA")).closest("tr") as HTMLElement;
    expect(within(row).getByText("11/02/2026")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Extend" })).toBeTruthy();
  });
});
