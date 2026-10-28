import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// F-238 — "Send by fax" on a referral's records requests: prefilled number, the send call, the recorded
// status (sent / failed + retry), the server's refusal shown in place, and no action on a closed request.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReferralRecordsRequests } from "../referral-records-requests";

const REFERRAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const base = {
  referralId: REFERRAL,
  patientId: null,
  recipientOrganization: "Riverbend Family Medicine",
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
  recordsRequested: ["history_and_physical"],
  dueDate: "2026-10-11",
  overdue: false,
  batches: 0,
};
const unsent = {
  ...base,
  id: "r1",
  requestCode: "RR-7KHM3XA",
  recipientName: "Dr. Pell",
  recipientFax: "(503) 555-0100",
  status: "requested",
  fax: null,
};
const faxRow = (over: Record<string, unknown>) => ({
  id: "f1",
  recordsRequestId: "r2",
  faxNumber: "+15035550111",
  status: "sent",
  provider: "stub",
  providerMessageId: "stub-1",
  pageCount: 2,
  failureReason: null,
  attemptedAt: "2026-10-02T09:00:00.000Z",
  sentAt: "2026-10-02T09:00:01.000Z",
  failedAt: null,
  ...over,
});
const sent = {
  ...base,
  id: "r2",
  requestCode: "RR-PWNC4ED",
  recipientName: "St. Vincent HIM",
  recipientFax: "(503) 555-0111",
  status: "requested",
  fax: faxRow({}),
};
const failed = {
  ...base,
  id: "r3",
  requestCode: "RR-AC3DE4F",
  recipientName: "Dr. Busy",
  recipientFax: "(503) 555-0122",
  status: "requested",
  fax: faxRow({
    id: "f2",
    recordsRequestId: "r3",
    faxNumber: "+15035550122",
    status: "failed",
    providerMessageId: null,
    sentAt: null,
    failedAt: "2026-10-02T09:00:01.000Z",
    failureReason: "busy signal",
  }),
};
const cancelled = {
  ...base,
  id: "r4",
  requestCode: "RR-DEF3479",
  recipientName: "Dr. Gone",
  recipientFax: "(503) 555-0133",
  status: "cancelled",
  cancelledAt: "2026-10-02T09:00:00.000Z",
  fax: null,
};

const reply = (data: unknown, status = 200) => ({
  data,
  error: undefined,
  response: new Response(null, { status }),
});
const refuse = (status: number, code: string, message: string) => ({
  data: undefined,
  error: { error: { code, message } },
  response: new Response(null, { status }),
});

function clientFor(post?: (path: string, init: unknown) => unknown) {
  const GET = vi.fn(async () => reply({ items: [unsent, sent, failed, cancelled] }));
  const POST = vi.fn(async (path: string, init: unknown) => post?.(path, init));
  return { client: { GET, POST } as unknown as ApiClient, POST };
}
const renderPanel = (client: ApiClient) =>
  render(
    <ApiClientProvider client={client}>
      <ReferralRecordsRequests referralId={REFERRAL} />
    </ApiClientProvider>,
  );
const rowOf = async (code: string) => (await screen.findByText(code)).closest("tr") as HTMLElement;

describe("Records request — send by fax", () => {
  it("prefills the request's fax number, sends it, and shows the recorded send", async () => {
    const { client, POST } = clientFor(() =>
      reply({
        replayed: false,
        fax: faxRow({ id: "f9", recordsRequestId: "r1", faxNumber: "+15035550100" }),
      }),
    );
    renderPanel(client);
    const row = await rowOf("RR-7KHM3XA");
    fireEvent.click(within(row).getByRole("button", { name: "Send by fax" }));
    const input = within(row).getByLabelText("Fax to") as HTMLInputElement;
    expect(input.value).toBe("(503) 555-0100");
    fireEvent.click(within(row).getByRole("button", { name: "Send fax" }));
    expect(await within(row).findByText("Faxed 10/02/2026 to (503) 555-0100")).toBeTruthy();
    expect(POST).toHaveBeenCalledWith(
      "/api/v1/referrals/{id}/records-requests/{requestId}/send-fax",
      {
        params: { path: { id: REFERRAL, requestId: "r1" } },
        body: { faxNumber: "(503) 555-0100" },
      },
    );
    // Sent once: the action is replaced by the status (the send is idempotent per request).
    expect(within(row).queryByRole("button", { name: "Send by fax" })).toBeNull();
  });

  it("shows an earlier send, a failure with a retry, and no fax action on a cancelled request", async () => {
    const { client } = clientFor();
    renderPanel(client);
    const sentRow = await rowOf("RR-PWNC4ED");
    expect(within(sentRow).getByText("Faxed 10/02/2026 to (503) 555-0111")).toBeTruthy();
    expect(within(sentRow).queryByRole("button", { name: /fax/i })).toBeNull();
    const failedRow = await rowOf("RR-AC3DE4F");
    expect(within(failedRow).getByText("Fax failed: busy signal")).toBeTruthy();
    expect(within(failedRow).getByRole("button", { name: "Retry fax" })).toBeTruthy();
    const cancelledRow = await rowOf("RR-DEF3479");
    expect(within(cancelledRow).queryByRole("button", { name: /fax/i })).toBeNull();
  });

  it("renders the server's refusal in place (an undialable number, faxing not set up)", async () => {
    let next = refuse(422, "VALIDATION_FAILED", "enter a dialable fax number");
    const { client } = clientFor(() => next);
    renderPanel(client);
    const row = await rowOf("RR-7KHM3XA");
    fireEvent.click(within(row).getByRole("button", { name: "Send by fax" }));
    fireEvent.change(within(row).getByLabelText("Fax to"), { target: { value: "555-0100" } });
    fireEvent.click(within(row).getByRole("button", { name: "Send fax" }));
    expect((await within(row).findByRole("alert")).textContent).toMatch(/dialable fax number/);
    next = refuse(503, "DEGRADED", "outbound-fax: no outbound fax provider is configured");
    fireEvent.click(within(row).getByRole("button", { name: "Send fax" }));
    expect(await screen.findByText(/Faxing is not set up/)).toBeTruthy();
  });
});
