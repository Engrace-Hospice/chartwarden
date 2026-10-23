// #596 F-040 / #612 F-027: a 409 TRIGGER_NO_COVERING_SHIFT carried the reason in `{ error: { message } }`, but the screen read RFC 7807
// `detail`/`title`, so the user saw only "The call could not be opened." on a banner above the fold.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TriageIntakeScreen } from "./triage-intake";

const REASON = "no on-call shift covers 2026-10-22T19:15:00.000Z for provider entity 22222222";
const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PE = "22222222-2222-4222-8222-222222222222";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// The provider entity is chosen from a lookup now (#612), so the stub serves that list and refuses only the POST.
async function conflict(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(String(input), init);
  if (req.method === "GET" && new URL(req.url).pathname === "/api/v1/patients") {
    return json(200, {
      items: [
        {
          id: PATIENT,
          firstName: "Eleanor",
          lastName: "Whitfield",
          mrn: "MRN1",
          dob: "1950-01-01",
          status: "active",
        },
      ],
      nextCursor: null,
    });
  }
  if (req.method === "GET") {
    return json(200, {
      items: [{ id: PE, legalName: "Cedar Hospice", ccn: "341234", npi: null, status: "active" }],
      nextCursor: null,
    });
  }
  return new Response(
    JSON.stringify({
      error: { code: "TRIGGER_NO_COVERING_SHIFT", message: REASON, correlationId: "c" },
    }),
    { status: 409, headers: { "content-type": "application/json" } },
  );
}

const originalScroll = Element.prototype.scrollIntoView;

describe("Take a call — refusal (#596)", () => {
  afterEach(() => {
    Element.prototype.scrollIntoView = originalScroll;
  });

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
    fireEvent.focus(screen.getByLabelText(/^Provider entity/));
    fireEvent.click(await screen.findByRole("option", { name: /Cedar Hospice/ }));
    fireEvent.click(screen.getByRole("button", { name: "Open the call" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(REASON);
    expect(scrollIntoView).toHaveBeenCalled();
  });
});

describe("Take a call — patient anchor (#612)", () => {
  it("the admission waits for a patient, then offers that patient's admissions", async () => {
    const client = createApiClient({ baseUrl: "http://localhost", fetch: conflict });
    render(
      <ApiClientProvider client={client}>
        <MemoryRouter>
          <TriageIntakeScreen />
        </MemoryRouter>
      </ApiClientProvider>,
    );
    expect((screen.getByLabelText(/^Admission/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("Choose a patient first.")).toBeTruthy();
    fireEvent.focus(screen.getByLabelText(/^Patient/));
    fireEvent.click(await screen.findByRole("option", { name: /Whitfield/ }));
    expect((screen.getByLabelText(/^Admission/) as HTMLInputElement).disabled).toBe(false);
  });
});
