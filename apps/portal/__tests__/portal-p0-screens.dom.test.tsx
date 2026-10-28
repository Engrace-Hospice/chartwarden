// @chartwarden/portal — P0 convergence coverage for sign-in, patient selection, and the patient home.
// Fixtures are synthetic and contain only the fields returned by the portal-minimised DTOs.
import { createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PortalApp } from "../src/app";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fixtureClient(requests: string[] = []) {
  return createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(`${input instanceof Request ? input.method : "GET"} ${url.pathname}`);
      if (url.pathname === "/api/v1/portal/sessions/patients") {
        return json({
          items: [
            {
              patientId: PATIENT_ID,
              grantId: "22222222-2222-4222-8222-222222222222",
              grantKind: "family_caregiver",
              scopeSet: ["visits", "messages"],
              layPatientLabel: "Sample patient",
            },
          ],
        });
      }
      if (url.pathname === "/api/v1/portal/care-summary") {
        return json({
          patient: { layLabel: "Sample patient", preferredName: "Sam", pronouns: "they/them" },
          upcomingVisitsCount: 1,
          recentVisitsCount: 2,
          activeMedicationsCount: 3,
          unreadMessagesCount: 4,
          pendingDocumentSharesCount: 5,
        });
      }
      if (url.pathname === "/api/v1/portal/sessions/select-patient") return json({ ok: true });
      if (url.pathname === "/api/v1/portal/upcoming") {
        return json([
          {
            visitId: "33333333-3333-4333-8333-333333333333",
            scheduledStartedAt: "2099-10-14T14:00:00.000Z",
            visitPurposeLabel: "Nurse visit",
            visitSetting: "home",
          },
        ]);
      }
      return new Response(null, { status: 404 });
    },
  });
}

describe("portal P0 screens", () => {
  it("presents the focused, chromeless sign-in experience", () => {
    window.history.pushState({}, "", "/portal/");
    render(<PortalApp client={fixtureClient()} />);

    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByText("Private and secure")).toBeTruthy();
    expect(screen.getByText(/Never share your password/)).toBeTruthy();
  });

  it("renders an accessible patient choice from the minimised grant DTO", async () => {
    const requests: string[] = [];
    window.history.pushState({}, "", "/portal/patient-picker");
    render(<PortalApp client={fixtureClient(requests)} />);

    const option = await screen.findByRole("button", { name: /Sample patient/ });
    expect(option.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("Access as Family Caregiver")).toBeTruthy();
    fireEvent.click(option);
    await waitFor(() => expect(window.location.pathname).toBe(`/portal/p/${PATIENT_ID}`));
    expect(requests).toContain("POST /api/v1/portal/sessions/select-patient");
  });

  it("renders the patient dashboard hierarchy and authorised summary counts", async () => {
    window.history.pushState({}, "", `/portal/p/${PATIENT_ID}`);
    render(<PortalApp client={fixtureClient()} />);

    expect(await screen.findByRole("heading", { name: "Welcome back", level: 1 })).toBeTruthy();
    expect(await screen.findByText("Sam")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByText("unread messages")).toBeTruthy();
    expect(screen.getByText("Nurse visit")).toBeTruthy();
    expect(screen.getByText("3 active medications")).toBeTruthy();
    expect(screen.getByText("5 new document shares")).toBeTruthy();
  });
});
