// #596 F-040: a 409 TRIGGER_NO_COVERING_SHIFT carried the reason in `{ error: { message } }`, but the screen read RFC 7807
// `detail`/`title`, so the user saw only "The call could not be opened." on a banner above the fold.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { TriageIntakeScreen } from "./triage-intake";

const REASON = "no on-call shift covers 2026-10-22T19:15:00.000Z for provider entity 22222222";
const PE = "22222222-2222-4222-8222-222222222222";

async function conflict(): Promise<Response> {
  return new Response(
    JSON.stringify({ error: { code: "TRIGGER_NO_COVERING_SHIFT", message: REASON, correlationId: "c" } }),
    { status: 409, headers: { "content-type": "application/json" } },
  );
}

describe("Take a call — refusal (#596)", () => {
  it("shows the server's reason and brings it into view", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const client = createApiClient({ baseUrl: "http://localhost", fetch: conflict });
    render(
      <ApiClientProvider client={client}>
        <MemoryRouter>
          <TriageIntakeScreen />
        </MemoryRouter>
      </ApiClientProvider>,
    );
    fireEvent.change(screen.getByLabelText(/Provider entity id/), { target: { value: PE } });
    fireEvent.click(screen.getByRole("button", { name: "Open the call" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(REASON);
    expect(scrollIntoView).toHaveBeenCalled();
  });
});
