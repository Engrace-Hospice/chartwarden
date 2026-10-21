import { fireEvent, render, screen } from "@testing-library/react";
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { PatientIntakeDetails } from "../patient-intake-details";

function ok(data: unknown) {
  return { data, error: undefined, response: new Response(null, { status: 200 }) };
}

function renderDetails(): void {
  const client = {
    GET: vi.fn(async (path: string) =>
      path.endsWith("/addresses") ? ok({ addresses: [] }) : ok({ payers: [] }),
    ),
    POST: vi.fn(),
  } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <PatientIntakeDetails
          patientId="patient-1"
          referralNumbers={{ medicare: "1EG4TE5MK73", medicaid: "OR123456" }}
        />
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("Coverage / Payers pre-fill from the referral", () => {
  it("fills the subscriber ID with the referral's number for the coverage kind picked", async () => {
    renderDetails();
    fireEvent.click(await screen.findByRole("button", { name: "Add coverage" }));
    const kind = screen.getByRole("combobox", { name: "Coverage kind" });
    const subscriber = screen.getByRole("textbox", {
      name: /^Member \/ subscriber ID/,
    }) as HTMLInputElement;

    fireEvent.change(kind, { target: { value: "medicare_ffs" } });
    expect(subscriber.value).toBe("1EG4TE5MK73");
    expect(screen.getByText(/From the referral/)).toBeTruthy();

    // Switching kind swaps a value we filled ourselves…
    fireEvent.change(kind, { target: { value: "medicaid" } });
    expect(subscriber.value).toBe("OR123456");

    // …but never one staff typed.
    fireEvent.change(subscriber, { target: { value: "TYPED-1" } });
    fireEvent.change(kind, { target: { value: "medicare_advantage" } });
    expect(subscriber.value).toBe("TYPED-1");
  });
});
