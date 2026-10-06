// The NOE / NOTR detail shows the MAC's answer: a rejection (when, at which stage, the reason codes, and that the
// notice was NOT filed) and an acceptance date. Before, a rejected notice showed only its state pill.
import { render, screen } from "@testing-library/react";
import { ApiClientProvider } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import { describe, expect, it, vi } from "vitest";
import { NOE_CONFIG, NOTR_CONFIG, NoticeWindowDetail } from "../notice-window";

const NOE_ID = "d1d2d3d4-0000-4000-8000-000000000001";

function record(over: Record<string, unknown>) {
  return {
    noeId: NOE_ID,
    providerEntityId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    patientId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    admissionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    state: "ack_rejected",
    windowTargetAt: "2026-10-08",
    windowBreachedAt: null,
    payerNoeControlNumber: null,
    acceptedAt: null,
    rejectedAt: null,
    rejectionStage: null,
    rejectionCodes: [],
    version: 4,
    ...over,
  };
}

function renderDetail(config: typeof NOE_CONFIG, data: unknown) {
  const GET = vi.fn(async () => ({ data, error: undefined, response: new Response(null) }));
  const client = { GET, POST: vi.fn() } as unknown as ApiClient;
  render(
    <ApiClientProvider client={client}>
      <NoticeWindowDetail config={config} id={NOE_ID} />
    </ApiClientProvider>,
  );
  return GET;
}

describe("NOE / NOTR acknowledgment outcome", () => {
  it("a rejected NOE says it was not filed, with the stage and the reason codes", async () => {
    renderDetail(
      NOE_CONFIG,
      record({
        rejectedAt: "2026-10-06T15:30:00.000Z",
        rejectionStage: "999",
        rejectionCodes: ["IK5:R", "IK3:8"],
      }),
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Medicare rejected this NOE: it was not filed. Correct it and file a new NOE.",
    );
    expect(screen.getByText(/999 \(file syntax\)/)).toBeTruthy();
    expect(screen.getByText("IK5:R, IK3:8")).toBeTruthy();
    // The id is read from the API's `noeId` key (the title was blank before).
    expect(screen.getByRole("heading", { name: `NOE ${NOE_ID}` })).toBeTruthy();
  });

  it("a rejection with no codes says so", async () => {
    renderDetail(
      NOTR_CONFIG,
      record({
        noeId: undefined,
        notrId: NOE_ID,
        rejectedAt: "2026-10-06T15:30:00.000Z",
        rejectionStage: "277ca",
      }),
    );

    expect((await screen.findByRole("alert")).textContent).toContain("Medicare rejected this NOTR");
    expect(screen.getByText(/277CA \(claim content\)/)).toBeTruthy();
    expect(screen.getByText("None reported")).toBeTruthy();
  });

  it("an accepted NOE shows its acceptance date and payer control number, and no alert", async () => {
    renderDetail(
      NOE_CONFIG,
      record({
        state: "ack_accepted",
        acceptedAt: "2026-10-06T15:30:00.000Z",
        payerNoeControlNumber: "PAYER-778",
      }),
    );

    expect(await screen.findByText("Accepted by Medicare")).toBeTruthy();
    expect(screen.getByText("PAYER-778")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
