import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// apps/web/src/modules/24-billing-medicaid — the claim page links to the read-only surveyor view.
// Navigation only: the target route enforces medicaid.claim.read server-side.
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { MedicaidClaimEditor } from "./claim-editor";

const CLAIM_ID = "cccccccc-1111-4111-8111-cccccccccccc";

async function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url, "http://localhost").pathname;
  const body = path.endsWith("/lines")
    ? []
    : path.includes("/patients/")
      ? { firstName: "Ada", lastName: "Vance" }
      : {
          id: CLAIM_ID,
          providerEntityId: "p",
          patientId: "pat",
          admissionId: "adm",
          serviceState: "OR",
          kind: "original",
          tob: "811",
          serviceFrom: "2025-11-01",
          serviceTo: "2025-11-30",
          mcoId: null,
          medicareClaimId: null,
          rbArrangementId: null,
          medicaidClaimControlNumber: "MCN-1",
          state: "READY",
          version: 1,
          validationRunIdLatest: null,
          eligibilityOutcomeSnapshot: null,
          electronicSubmissionRefusal: null,
          createdAt: "2025-11-01T00:00:00.000Z",
          updatedAt: "2025-11-01T00:00:00.000Z",
        };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Medicaid claim page — surveyor view link", () => {
  it("links to the read-only surveyor view for this claim", async () => {
    render(
      <ApiClientProvider
        client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}
      >
        <SessionProvider
          session={{
            userId: "u",
            organizationId: "o",
            membershipId: "m",
            roles: ["biller"],
            permissions: [],
            isAdmin: false,
          }}
        >
          <ToastProvider>
            <MemoryRouter initialEntries={[`/medicaid/billing/claims/${CLAIM_ID}`]}>
              <Routes>
                <Route path="/medicaid/billing/claims/:claimId" element={<MedicaidClaimEditor />} />
              </Routes>
            </MemoryRouter>
          </ToastProvider>
        </SessionProvider>
      </ApiClientProvider>,
    );
    const link = await screen.findByRole("link", { name: "Surveyor view" });
    expect(link.getAttribute("href")).toBe(`/admin/medicaid-billing-audit/${CLAIM_ID}`);
  });
});
