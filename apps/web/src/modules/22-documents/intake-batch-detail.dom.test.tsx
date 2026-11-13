import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { IntakeBatchDetail } from "./intake-batch-detail";

const BATCH = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const REFERRAL = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

describe("IntakeBatchDetail", () => {
  it("preserves a validated guided-intake return through batch detail and review", async () => {
    const client = {
      GET: vi.fn(async (path: string) => ({
        data: path.endsWith("/jobs")
          ? { items: [] }
          : {
              id: BATCH,
              patientId: null,
              status: "parse_failed",
              uploadedAt: "2026-10-01T09:00:00.000Z",
              pages: 1,
            },
        error: undefined,
        response: new Response(null, { status: 200 }),
      })),
    } as unknown as ApiClient;
    const returnTo = `/referrals/${REFERRAL}/intake?step=receive`;

    render(
      <MemoryRouter initialEntries={[`/intake/${BATCH}?returnTo=${encodeURIComponent(returnTo)}`]}>
        <ApiClientProvider client={client}>
          <Routes>
            <Route path="/intake/:batchId" element={<IntakeBatchDetail />} />
          </Routes>
        </ApiClientProvider>
      </MemoryRouter>,
    );

    expect(
      (await screen.findByRole("link", { name: "Back to referral intake" })).getAttribute("href"),
    ).toBe(returnTo);
    expect(screen.getByRole("link", { name: "Review extracted fields" }).getAttribute("href")).toBe(
      `/intake/${BATCH}/review?returnTo=${encodeURIComponent(returnTo)}`,
    );
  });

  it("keeps the validated referral return available when the batch cannot load", async () => {
    const client = {
      GET: vi.fn(async () => ({
        data: undefined,
        error: { message: "Unavailable" },
        response: new Response(null, { status: 503 }),
      })),
    } as unknown as ApiClient;
    const returnTo = `/referrals/${REFERRAL}/intake?step=receive`;

    render(
      <MemoryRouter initialEntries={[`/intake/${BATCH}?returnTo=${encodeURIComponent(returnTo)}`]}>
        <ApiClientProvider client={client}>
          <Routes>
            <Route path="/intake/:batchId" element={<IntakeBatchDetail />} />
          </Routes>
        </ApiClientProvider>
      </MemoryRouter>,
    );

    expect(
      (await screen.findByRole("link", { name: "Back to referral intake" })).getAttribute("href"),
    ).toBe(returnTo);
  });
});
