// apps/admin/src/modules/35-subscription-billing — a step-up-gated write refused with 403 STEP_UP_REQUIRED must give
// the operator a real way through: a Re-verify link to the console's /step-up page that returns here. Before, the
// screens printed "re-verify and retry" with nowhere to re-verify — and read `.code` off the envelope's top level,
// where the standard `{ error: { code } }` body never carries it, so even that message never showed.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { SubscriptionPause } from "../subscription-pause";

const SUB = "44444444-4444-4444-8444-444444444444";
const PAUSE_PATH = `/admin/subscriptions/${SUB}/pause`;
let replyCode = "STEP_UP_REQUIRED";

async function stubFetch(): Promise<Response> {
  return new Response(
    JSON.stringify({ error: { code: replyCode, message: "refused", correlationId: "c" } }),
    { status: 403, headers: { "content-type": "application/json" } },
  );
}

function mount(): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <MemoryRouter initialEntries={[PAUSE_PATH]}>
        <Routes>
          <Route path="/admin/subscriptions/:id/pause" element={<SubscriptionPause />} />
          <Route path="/step-up" element={<div data-testid="step-up-page" />} />
        </Routes>
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  replyCode = "STEP_UP_REQUIRED";
});

describe("step-up refusal on a subscription-billing write", () => {
  it("offers a Re-verify link to /step-up that returns to this screen", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Pause subscription" }));
    const link = await screen.findByRole("link", { name: "Re-verify" });
    expect(link.getAttribute("href")).toBe(`/step-up?returnTo=${encodeURIComponent(PAUSE_PATH)}`);
    expect(screen.getByText(/needs a fresh verification/)).toBeTruthy();
    fireEvent.click(link);
    expect(await screen.findByTestId("step-up-page")).toBeTruthy();
  });

  it("any other 403 keeps the plain failure and offers no Re-verify", async () => {
    replyCode = "FORBIDDEN";
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Pause subscription" }));
    expect(await screen.findByText("Could not pause the subscription.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Re-verify" })).toBeNull();
  });
});
