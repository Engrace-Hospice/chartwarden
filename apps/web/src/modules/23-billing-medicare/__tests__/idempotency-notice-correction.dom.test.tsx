import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// #821: filing a corrected notice keeps its Idempotency-Key only after a thrown fetch.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { NOE_CONFIG, NoticeWindowDetail } from "../notice-window";
import { expectNewKey, expectSameKey } from "./idempotency-test-utils";

const ID = "d1d2d3d4-0000-4000-8000-000000000001";
const REASON = "Beneficiary MBI changed; refiled with the HETS-verified MBI.";
const NOTICE = {
  noeId: ID,
  state: "ack_rejected",
  electionEffectiveDate: "2026-10-01",
  windowTargetAt: "2026-10-06",
  windowBreachedAt: null,
  rejectedAt: "2026-10-04T15:30:00.000Z",
  rejectionStage: "277ca",
  rejectionCodes: ["A7:21"],
  correctsNoticeId: null,
  correctionReason: null,
  correctedBy: null,
  version: 4,
};
const ok = {
  data: { created: true, notice: { noeId: "c1" } },
  error: undefined,
  response: new Response(null, { status: 201 }),
};
const http422 = {
  data: undefined,
  error: { error: { message: "refused" } },
  response: new Response(null, { status: 422 }),
};

async function open(post: ReturnType<typeof vi.fn>): Promise<void> {
  const GET = vi.fn(async () => ({ data: NOTICE, error: undefined, response: new Response(null) }));
  const client = { GET, POST: post } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <NoticeWindowDetail config={NOE_CONFIG} id={ID} />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "File corrected NOE" }));
  fireEvent.change(screen.getByLabelText(/What was wrong/), { target: { value: REASON } });
}

const draft = async (post: ReturnType<typeof vi.fn>, calls: number) => {
  fireEvent.click(screen.getByRole("button", { name: "Draft corrected NOE" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(calls));
  await waitFor(() =>
    expect(
      (screen.queryByRole("button", { name: "Draft corrected NOE" }) as HTMLButtonElement | null)
        ?.disabled ?? false,
    ).toBe(false),
  );
};

describe("Corrected notice Idempotency-Key (#821)", () => {
  it("reuses the key when the first request threw", async () => {
    const POST = vi.fn().mockRejectedValueOnce(new TypeError("net")).mockResolvedValue(ok);
    await open(POST);
    await draft(POST, 1);
    await draft(POST, 2);
    expectSameKey(POST, 0, 1);
  });

  it("mints a new key after an HTTP error answer", async () => {
    const POST = vi.fn().mockResolvedValueOnce(http422).mockResolvedValue(ok);
    await open(POST);
    await draft(POST, 1);
    await draft(POST, 2);
    expectNewKey(POST, 0, 1);
  });

  it("mints a new key after a field edit following a thrown request", async () => {
    const POST = vi.fn().mockRejectedValueOnce(new TypeError("net")).mockResolvedValue(ok);
    await open(POST);
    await draft(POST, 1);
    fireEvent.change(screen.getByLabelText(/What was wrong/), {
      target: { value: `${REASON} Corrected again.` },
    });
    await draft(POST, 2);
    expectNewKey(POST, 0, 1);
  });
});
