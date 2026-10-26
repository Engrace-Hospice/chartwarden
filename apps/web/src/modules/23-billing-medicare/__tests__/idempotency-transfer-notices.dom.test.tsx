import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// #821: transfer-notice actions keep their Idempotency-Key only after a thrown fetch.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { TransferNotice } from "../transfer-notice-model";
import { TransferNotices } from "../transfer-notices";
import { expectNewKey, expectSameKey } from "./idempotency-test-utils";

const TN = "c3d4e5f6-0000-4000-8000-000000000001";

const ok = (data: unknown, status = 200) => ({
  data,
  error: undefined,
  response: new Response(null, { status }),
});
const refused = (status: number) => ({
  data: undefined,
  error: { error: { code: "X", message: "refused" } },
  response: new Response(null, { status }),
});

const NOTICE = {
  transferNoticeId: TN,
  patientId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  admissionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  action: "original",
  supersedesNoticeId: null,
  state: "ack_accepted",
  tob: "81C",
  statementFromDate: "2026-03-10",
  originalTransferDate: null,
  admissionDate: "2026-03-10",
  benefitPeriodSequence: 2,
  benefitPeriodStartDate: "2026-01-01",
  priorHospiceName: "Sunrise Hospice",
  priorHospiceCcn: "381777",
  priorHospiceNpi: null,
  providerCcn: "381501",
  priorBillingConfirmedAt: null,
  priorHospiceThroughDate: null,
  priorHospicePatientStatus: null,
  controlNumber: "381501-260310-abcde-00",
  payerControlNumber: "PAYER-1",
  latestSubmissionOutcome: null,
  cancelReason: null,
  blockers: [],
  warnings: [],
  conditionCodes: [],
  occurrenceCodes: [],
  allowedActions: ["submit", "correct_date"],
  followUp: null,
  version: 3,
  createdAt: "2026-03-11T00:00:00Z",
} as unknown as TransferNotice;

function mount(post: ReturnType<typeof vi.fn>): void {
  const GET = vi.fn(async (path: string) =>
    path === "/api/v1/billing/transfer-notices"
      ? ok({ items: [NOTICE], nextCursor: null, hasMore: false })
      : ok({ firstName: "Jane", lastName: "Doe" }),
  );
  render(
    <ApiClientProvider client={{ GET, POST: post } as unknown as ApiClient}>
      <MemoryRouter initialEntries={[`/billing/transfer-notices?notice=${TN}`]}>
        <TransferNotices />
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

const press = async (post: ReturnType<typeof vi.fn>, name: string, calls: number) => {
  fireEvent.click(await screen.findByRole("button", { name }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(calls));
  await waitFor(() =>
    expect(
      (screen.queryByRole("button", { name }) as HTMLButtonElement | null)?.disabled ?? false,
    ).toBe(false),
  );
};

describe("Transfer notice Idempotency-Key (#821)", () => {
  it("reuses the key when the first submit threw", async () => {
    const POST = vi.fn().mockRejectedValueOnce(new TypeError("net")).mockResolvedValue(ok(NOTICE));
    mount(POST);
    await press(POST, "Submit to Medicare", 1);
    await press(POST, "Submit to Medicare", 2);
    expectSameKey(POST, 0, 1);
  });

  it("mints a new key after an HTTP error answer", async () => {
    const POST = vi.fn().mockResolvedValueOnce(refused(422)).mockResolvedValue(ok(NOTICE));
    mount(POST);
    await press(POST, "Submit to Medicare", 1);
    await press(POST, "Submit to Medicare", 2);
    expectNewKey(POST, 0, 1);
  });

  it("mints a new key after a field edit following a thrown request", async () => {
    const POST = vi.fn().mockRejectedValueOnce(new TypeError("net")).mockResolvedValue(ok(NOTICE));
    mount(POST);
    fireEvent.click(await screen.findByRole("button", { name: "Correct date" }));
    fireEvent.change(screen.getByLabelText(/Correct transfer date/), {
      target: { value: "2026-03-11" },
    });
    await press(POST, "Draft correction", 1);
    fireEvent.change(screen.getByLabelText(/Correct transfer date/), {
      target: { value: "2026-03-12" },
    });
    await press(POST, "Draft correction", 2);
    expectNewKey(POST, 0, 1);
  });

  it("reuses the key when the same correction is retried after a thrown request", async () => {
    const POST = vi.fn().mockRejectedValueOnce(new TypeError("net")).mockResolvedValue(ok(NOTICE));
    mount(POST);
    fireEvent.click(await screen.findByRole("button", { name: "Correct date" }));
    fireEvent.change(screen.getByLabelText(/Correct transfer date/), {
      target: { value: "2026-03-11" },
    });
    await press(POST, "Draft correction", 1);
    await press(POST, "Draft correction", 2);
    expectSameKey(POST, 0, 1);
  });
});
