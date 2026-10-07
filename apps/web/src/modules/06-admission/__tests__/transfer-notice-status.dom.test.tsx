// The transferred-in admission's view of its Medicare transfer notice (TOB 8xC), read from M23's worklist API.
import { render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { TransferNoticeStatus } from "../transfer-notice-status";

const TN = "c3d4e5f6-0000-4000-8000-000000000001";
const ADM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const ok = (data: unknown) => ({ data, error: undefined, response: new Response(null) });

function mount(client: object) {
  return render(
    <ApiClientProvider client={client as unknown as ApiClient}>
      <MemoryRouter>
        <TransferNoticeStatus admissionId={ADM} />
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

describe("TransferNoticeStatus", () => {
  it("shows the admission's notice state and hold, linking to the billing worklist", async () => {
    const GET = vi.fn(async () =>
      ok({
        items: [
          {
            transferNoticeId: TN,
            state: "draft",
            tob: "81C",
            statementFromDate: "2026-03-10",
            blockers: [
              { code: "PRIOR_BILLING_NOT_CONFIRMED", message: "Confirm the prior billing." },
            ],
          },
        ],
      }),
    );
    mount({ GET, POST: vi.fn() });
    expect(await screen.findByText("Medicare transfer notice (TOB 81C)")).toBeTruthy();
    expect(screen.getByText("Draft")).toBeTruthy();
    expect(screen.getByText(/Confirm the prior billing\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open in billing" }).getAttribute("href")).toBe(
      `/billing/transfer-notices?notice=${TN}`,
    );
    expect(GET).toHaveBeenCalledWith("/api/v1/billing/transfer-notices", {
      params: { query: { admissionId: ADM, limit: 1 } },
    });
  });

  it("renders nothing when the read is refused (no billing scope)", async () => {
    const GET = vi.fn(async () => ({
      data: undefined,
      error: { error: { code: "FORBIDDEN" } },
      response: new Response(null, { status: 403 }),
    }));
    const { container } = mount({ GET, POST: vi.fn() });
    await waitFor(() => expect(GET).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
