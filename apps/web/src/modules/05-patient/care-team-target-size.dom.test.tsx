// #664 (WCAG 2.5.8): the icon-only email / message links on a Care Team row are at least 24 x 24 CSS px.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import { OverviewTab, type PatientSummary, usePatientChartData } from "./patient-overview";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ORG = "org-1";
const USER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const session: Session = {
  userId: "u1",
  organizationId: ORG,
  displayName: "Nora",
  permissions: ["patient.read", "member.manage"],
};
const patient = { id: PATIENT, organizationId: ORG } as unknown as PatientSummary;

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const { pathname } = new URL(req.url, "http://localhost");
  const body =
    pathname === `/api/v1/patients/${PATIENT}/care-team`
      ? {
          assignments: [
            {
              id: "a1",
              clinicianUserId: USER,
              role: "rn",
              assignedAt: "2026-10-01",
              current: true,
              displayName: "Nora Visit, RN",
            },
          ],
          emergencyContacts: [],
        }
      : pathname === `/api/v1/orgs/${ORG}/members`
        ? {
            members: [
              {
                membershipId: "cccccccc-3333-4333-8333-cccccccccccc",
                userId: USER,
                displayName: "Nora Visit, RN",
                email: "nora@example.test",
                status: "active",
              },
            ],
          }
        : {};
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function Harness(): JSX.Element {
  return <OverviewTab patient={patient} data={usePatientChartData(patient)} />;
}

describe("Care Team row actions are 24px targets (#664)", () => {
  it("the email and message links reserve a 24 x 24 box", async () => {
    render(
      <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
        <SessionProvider session={session}>
          <ToastProvider>
            <MemoryRouter>
              <Harness />
            </MemoryRouter>
          </ToastProvider>
        </SessionProvider>
      </ApiClientProvider>,
    );
    const email = await screen.findByRole("link", { name: "Email Nora Visit, RN" });
    const message = await screen.findByRole("link", { name: "Message Nora Visit, RN" });
    for (const el of [email, message]) {
      expect(el.style.minWidth).toBe("1.5rem");
      expect(el.style.minHeight).toBe("1.5rem");
    }
  });
});
