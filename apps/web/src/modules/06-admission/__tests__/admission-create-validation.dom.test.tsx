import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { type Session, SessionProvider } from "../../../shell/session";
import { AdmissionCreate } from "../admission-create";

const PATIENT_ERROR = "Select a patient before continuing.";

function mountNewAdmission(): void {
  const empty = () =>
    Promise.resolve({ data: undefined, error: undefined, response: new Response(null) });
  const client = { GET: vi.fn(empty), POST: vi.fn(empty) };
  const session = { userId: "u-1", organizationId: "org-1", permissions: [] } as unknown as Session;
  render(
    <ApiClientProvider client={client as unknown as ApiClient}>
      <SessionProvider session={session}>
        <MemoryRouter initialEntries={["/admissions/new"]}>
          <Routes>
            <Route path="/admissions/new" element={<AdmissionCreate />} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

describe("New admission validation", () => {
  it("does not show a field error before the user tries to continue", () => {
    mountNewAdmission();
    expect(screen.queryByText(PATIENT_ERROR)).toBeNull();
  });

  it("shows the missing-patient error and stays on the step when Continue is pressed", () => {
    mountNewAdmission();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText(PATIENT_ERROR)).toBeTruthy();
    expect(screen.getByText("Identify the patient and how this intake arrived.")).toBeTruthy();
  });
});
